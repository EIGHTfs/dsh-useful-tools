/**
 * 预览页基础设施 · 单文件 HTML 壳 + 生成器
 *
 * 契约：插件只写 `assets/preview.spec.mjs`，默认导出：
 *   {
 *     title?:   string,                 // 页面标题
 *     css?:     string,                 // 追加样式
 *     harness?: string | () => string,  // 垫片脚本（插件专属：ctx/window/require 等宿主面）
 *     body?:    string,                 // body 额外 HTML（默认只有 #root）
 *     post?:    string,                 // client.js 之后执行的脚本（如首屏数据注入）
 *     client?:  string,                 // client 入口相对插件根路径（默认 lib/client.js）
 *     output?:  string,                 // 产物相对插件根路径（默认 assets/preview.html）
 *   }
 * 通用件负责：定位 DSH 根、取 UMD、拼单文件 HTML、写盘。插件不再各抄一份。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { findDshRoot, loadUmd } from './locate.js';
import { AUTO_HARNESS } from './auto-harness.js';

const BYTES_PER_MB = 1024 * 1024;

/**
 * 页面内错误面板：把运行期错误渲染到顶部红色块。
 * 为什么必须有：错误平时只进 console 与 window.__PREVIEW_ERRORS__，无头截图看不见，
 *   AI/人只能靠猜；页面内可见＝自证（这条来自 dsh-session-migrate 的实战反馈）。
 * 放在 harness 之后执行：harness 会定义 window.__previewError，这里再包一层保证不丢原有行为。
 */
const ERROR_PANEL_SCRIPT = `
(function () {
  var box = document.getElementById('preview-errors');
  if (!box) return;
  var count = 0;
  function render(title, detail) {
    count += 1;
    var item = document.createElement('div');
    item.className = 'pe-item';
    var head = document.createElement('span');
    head.className = 'pe-title';
    head.textContent = '[' + title + ']';
    item.appendChild(head);
    item.appendChild(document.createTextNode(String(detail == null ? '' : detail)));
    box.appendChild(item);
    // 只保留最近 20 条：错误刷屏时不能让页面本身被淹没
    while (box.childElementCount > 20) box.removeChild(box.firstChild);
  }
  window.addEventListener('error', function (e) {
    render('运行时错误', ((e && e.message) || '') + '\\n' + ((e && e.error && e.error.stack) || ''));
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    render('未捕获的 Promise 拒绝', (r && (r.stack || r.message)) || String(r));
  });
  var original = window.__previewError;
  window.__previewError = function (err) {
    render('预览错误', (err && (err.stack || err.message || err)) || String(err));
    if (typeof original === 'function') { try { original(err); } catch (_) {} }
  };
})();
`;

/**
 * 读插件描述文件（.mjs/.js；也允许 .json 纯数据），或直接吃 inline 描述。
 *
 * inline 的意义：一次性验证界面时不必往插件仓库里塞一个 spec 文件——
 *   文件塞进去要决定删不删、要不要入库，反而比预览本身更麻烦。
 * 判定顺序：对象 → 以 `{` 开头的文本（当 JSON）→ 其余按文件路径。
 */
export async function loadSpec(specInput) {
  if (specInput && typeof specInput === 'object') return specInput;
  const text = String(specInput || '').trim();
  if (text.startsWith('{')) {
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`spec 看起来是 inline JSON，但解析失败：${(e && e.message) || e}`);
    }
  }
  // 本函数是异步路径：存在性用 fs.promises.access 探测，避免同步 I/O 阻塞事件循环
  try { await access(text); } catch { throw new Error(`找不到预览描述文件：${text}`); }
  if (/\.json$/i.test(text)) return JSON.parse(await readFile(text, 'utf8'));
  const mod = await import(pathToFileURL(text).href);
  return mod.default || mod;
}

/**
 * 生成单文件预览页。
 * @param {{plugin:string, spec?:string, out?:string, dshRoot?:string, dshHome?:string, profile?:string}} opts
 * @returns {{ok:boolean, out?:string, sizeMB?:number, note?:string, error?:string}}
 */
export async function generatePreview(opts = {}) {
  try {
    const plugin = resolve(String(opts.plugin || ''));
    if (!plugin || !existsSync(join(plugin, 'package.json'))) return { ok: false, error: 'plugin 必须是含 package.json 的插件根' };
    // inline spec：直接给对象或 JSON 文本，不落文件（一次性验证界面时不必污染仓库）。
    //   判定要在算路径之前——否则 JSON 文本会被当成文件名拼进插件路径。
    const inlineSpec = Boolean(opts.spec) && (typeof opts.spec === 'object' || String(opts.spec).trim().startsWith('{'));
    const specPath = inlineSpec
      ? ''
      : (opts.spec ? (isAbsolute(opts.spec) ? opts.spec : join(plugin, opts.spec)) : join(plugin, 'assets', 'preview.spec.mjs'));
    // 无 spec 兜底：插件没有自定义垫片时用**通用自动挂载**生成，让「只想看一眼界面」不必先写 spec。
    //   显式传了 spec 路径却不存在时仍然报错——那是调用方指错了文件，不能静默降级。
    //   自动挂载是尽力而为：mock 宿主 slots/locale 后渲染捕获到的插槽组件；
    //   组件若依赖宿主 hooks 会渲染失败，页面会显示错误与已捕获插槽清单，而不是白屏。
    let spec;
    let note = '';
    let autoMount = false;
    if (inlineSpec) {
      spec = await loadSpec(opts.spec);
    } else if (!existsSync(specPath)) {
      if (opts.spec) return { ok: false, error: `找不到预览描述文件：${specPath}` };
      spec = {};
      autoMount = true;
      note = `未找到 ${specPath.split('/').pop()}，已按默认垫片生成（自动挂载：mock 宿主 slots/locale 并渲染捕获到的插槽组件；依赖宿主 hooks 的组件可能渲染失败）`;
    } else {
      spec = await loadSpec(specPath);
    }
    const clientRel = String(spec.client || 'lib/client.js');
    const clientPath = join(plugin, clientRel);
    if (!existsSync(clientPath)) return { ok: false, error: `找不到 client 入口：${clientRel}${note ? `（${note}）` : ''}` };
    const clientSrc = readFileSync(clientPath, 'utf8');
    // spec 只写 title/css/body 而不写 harness 时，同样用自动挂载——spec 退化为可选增强
    const harness = spec.harness
      ? (typeof spec.harness === 'function' ? spec.harness() : String(spec.harness))
      : AUTO_HARNESS;
    const dshRoot = opts.dshRoot || findDshRoot(plugin);
    const umd = loadUmd({ dshRoot, dshHome: opts.dshHome || process.env.DSH_HOME || '', profile: opts.profile || 'web' });
    const html = buildHtml({
      title: spec.title || `${plugin.split('/').pop()} 预览`,
      css: String(spec.css || ''),
      body: String(spec.body || '<div id="root"></div>'),
      harness,
      clientSrc,
      post: String(spec.post || ''),
      reactUmd: umd.react,
      domUmd: umd.reactDom,
    });
    const outRel = String(opts.out || spec.output || 'assets/preview.html');
    const outPath = isAbsolute(outRel) ? outRel : join(plugin, outRel);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, html);
    // 产物入库提示：assets/preview.html 很容易被顺手 commit（实测有仓库把 157KB 产物推上去）。
    //   只在产物落在插件目录内时提示（写到 /tmp 之类的临时路径不需要关心 .gitignore）。
    const warnings = [];
    const inPluginDir = outPath === plugin || outPath.startsWith(plugin + sep);
    const gitignorePath = join(plugin, '.gitignore');
    let ignored = false;
    try {
      if (inPluginDir && existsSync(gitignorePath)) {
        const lines = readFileSync(gitignorePath, 'utf8').split('\n').map((line) => line.trim());
        ignored = lines.some((line) => line && (line === outRel || line === `/${outRel}` || line === 'assets/preview.html' || /(^|\/)preview\.html$/.test(line)));
      }
    } catch { /* 读不到 .gitignore 就当没忽略 */ }
    // 未被忽略 = 这个文件现在会被 git 当源码，随手 commit 就把生成物推进仓库。
    //   给出结构化的 artifactRisk 供调用方判断，而不只是一条容易滑过去的提示文案。
    const artifactRisk = inPluginDir && !ignored;
    if (artifactRisk) {
      warnings.push(
        `产物落在插件目录内且未被 .gitignore 忽略（${outRel}）—— 它现在会被 git 当成源码，随手提交就把几百 KB 生成物推进仓库。`
        + `二选一：在 ${join(plugin, '.gitignore')} 加一行 "${outRel}"，或传 out 指到插件目录外（例如 /tmp/preview.html）。`,
      );
    }
    return {
      ok: true,
      out: outPath,
      sizeMB: Number((html.length / BYTES_PER_MB).toFixed(2)),
      umdFrom: umd.from,
      ...(note ? { note } : {}),
      ...(autoMount ? { autoMount: true } : {}),
      ...(artifactRisk ? { artifactRisk: true } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 拼装单文件 HTML（UMD 内联 ⇒ 双击可开、离线可用）。 */
export function buildHtml({ title, css, body, harness, clientSrc, post, reactUmd, domUmd }) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
*{box-sizing:border-box}
body{margin:0;padding:20px;background:#0f1117;color:#e8eaf0;
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
#preview-errors{position:relative;z-index:9999}
#preview-errors .pe-item{background:#3a1518;border:1px solid #b3261e;border-left:4px solid #ff5449;
  color:#ffd7d3;border-radius:6px;padding:10px 14px;margin:0 0 10px;white-space:pre-wrap;
  font:12.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;max-height:220px;overflow:auto}
#preview-errors .pe-title{color:#ff8a80;font-weight:600;display:block;margin-bottom:4px}
${css}
</style></head><body>
<div id="preview-errors"></div>
${body}
<script>${reactUmd}</script>
<script>${domUmd}</script>
<script>${harness}</script>
<script>${ERROR_PANEL_SCRIPT}</script>
<script>${clientSrc}</script>
<script>${post}</script>
</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
