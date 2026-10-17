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
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { findDshRoot, loadUmd } from './locate.js';

const BYTES_PER_MB = 1024 * 1024;

/** 读插件描述文件（.mjs/.js；也允许 .json 纯数据）。 */
export async function loadSpec(specPath) {
  if (!specPath || !existsSync(specPath)) throw new Error(`找不到预览描述文件：${specPath}`);
  if (/\.json$/i.test(specPath)) return JSON.parse(readFileSync(specPath, 'utf8'));
  const mod = await import(pathToFileURL(specPath).href);
  return mod.default || mod;
}

/**
 * 生成单文件预览页。
 * @param {{plugin:string, spec?:string, out?:string, dshRoot?:string, dshHome?:string, profile?:string}} opts
 * @returns {{ok:boolean, out?:string, sizeMB?:number, error?:string}}
 */
export async function generatePreview(opts = {}) {
  try {
    const plugin = resolve(String(opts.plugin || ''));
    if (!plugin || !existsSync(join(plugin, 'package.json'))) return { ok: false, error: 'plugin 必须是含 package.json 的插件根' };
    const specPath = opts.spec ? (isAbsolute(opts.spec) ? opts.spec : join(plugin, opts.spec)) : join(plugin, 'assets', 'preview.spec.mjs');
    const spec = await loadSpec(specPath);
    const clientRel = String(spec.client || 'lib/client.js');
    const clientPath = join(plugin, clientRel);
    if (!existsSync(clientPath)) return { ok: false, error: `找不到 client 入口：${clientRel}` };
    const clientSrc = readFileSync(clientPath, 'utf8');
    const harness = typeof spec.harness === 'function' ? spec.harness() : String(spec.harness || '');
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
    return { ok: true, out: outPath, sizeMB: Number((html.length / BYTES_PER_MB).toFixed(2)), umdFrom: umd.from };
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
${css}
</style></head><body>
${body}
<script>${reactUmd}</script>
<script>${domUmd}</script>
<script>${harness}</script>
<script>${clientSrc}</script>
<script>${post}</script>
</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
