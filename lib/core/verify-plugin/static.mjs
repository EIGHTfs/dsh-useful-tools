/**
 * 插件静态分析：只读文件，判断「宿主会不会装载它、工具注册有没有写」。
 *
 * 全部零依赖、不 import 被分析插件（执行插件代码会触发它的顶层副作用）。
 * 判断分两档，避免把启发式误判当成硬伤：
 *   problems（硬伤）—— 入口缺失、没有 apply、apply 顶层 return 对象字面量、声明的 patch 缺 insert
 *   warnings（提示）—— 没找到 tools 注册调用、patch id 与包名不一致、入口靠 export * 转出
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';

// 源码只读这么大的片段做结构判断（入口文件通常远小于此）
const MAX_SOURCE_BYTES = 512 * 1024;
// export * 转出的最大跟随层数（实测 dsh-git-push 是 index → app/index → apply，两层）
const MAX_REEXPORT_DEPTH = 3;
// 回报给调用方的 risky return 样本最大字符数（够定位写法即可，不整段回传）
const MAX_RETURN_SAMPLE_SIZE = 80;

/** 从 package.json 的 main / exports 里取入口相对路径（取不到返回空串）。 */
function entryFromPackage(pkg) {
  if (pkg.main) return String(pkg.main);
  if (!pkg.exports) return '';
  const dot = typeof pkg.exports === 'string' ? pkg.exports : pkg.exports['.'];
  if (typeof dot === 'string') return dot;
  return String((dot && (dot.import || dot.default)) || '');
}

/** 读插件 package.json，解析真实入口（main 优先，其次 exports["."]）。 */
export function resolveEntry(pluginRoot) {
  const pkgPath = join(pluginRoot, 'package.json');
  if (!existsSync(pkgPath)) return { ok: false, error: `缺少 package.json: ${pkgPath}` };
  let pkg;
  try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')); } catch (e) {
    return { ok: false, error: `package.json 解析失败: ${e?.message || e}` };
  }
  const entry = entryFromPackage(pkg) || './lib/index.js';
  const abs = isAbsolute(entry) ? entry : join(pluginRoot, entry);
  if (!existsSync(abs)) return { ok: false, error: `入口文件不存在: ${abs}` };
  return { ok: true, entry: abs, name: String(pkg.name || ''), version: String(pkg.version || ''), pkg };
}

/**
 * 从 src 的 openIndex（指向 `{`）开始，跳到配对的 `}`，返回结束下标。
 * 会跳过字符串（含模板串）、行注释、块注释——不引 AST 解析器（零依赖约束）。
 */
function matchBrace(src, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < src.length; i++) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) return -1; continue; }
    if (ch === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i); if (i < 0) return -1; i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      for (; i < src.length; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (src[i] === quote) break;
      }
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * 静态判断 apply 的返回值形态（启发式）。
 * 只认函数体**顶层**的 return：`return {` / `return [` 会被判为「返回普通对象/数组」，
 * 这是 cordis 眼中的非法 effect；`return ctx.xxx()`、`return fn` 这类不判风险。
 */
export function inspectApplyReturns(src) {
  const applyMatch = /export\s+(?:async\s+)?function\s+apply\b|export\s+const\s+apply\s*=|function\s+apply\s*\(/.exec(src);
  if (!applyMatch) return { found: false, risky: false, samples: [] };
  const open = src.indexOf('{', applyMatch.index);
  if (open < 0) return { found: true, risky: false, samples: [] };
  const close = matchBrace(src, open);
  if (close < 0) return { found: true, risky: false, samples: [], note: '函数体括号未配对，静态扫描未完成' };
  const body = src.slice(open + 1, close);
  // 扫描函数体顶层（depth 0）的 return
  const samples = [];
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '/' && body[i + 1] === '/') { i = body.indexOf('\n', i); if (i < 0) break; continue; }
    if (ch === '/' && body[i + 1] === '*') { i = body.indexOf('*/', i); if (i < 0) break; i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      for (; i < body.length; i++) {
        if (body[i] === '\\') { i++; continue; }
        if (body[i] === quote) break;
      }
      continue;
    }
    if (ch === '{' || ch === '(' || ch === '[') { depth++; continue; }
    if (ch === '}' || ch === ')' || ch === ']') { depth--; continue; }
    if (depth === 0 && /^return\b/.test(body.slice(i, i + 6))) {
      const rest = body.slice(i + 6).trimStart();
      if (rest.startsWith('{') || rest.startsWith('[')) {
        samples.push(body.slice(i, i + MAX_RETURN_SAMPLE_SIZE).split('\n')[0].trim());
      }
      i += 5;
    }
  }
  return { found: true, risky: samples.length > 0, samples };
}

/** 读 cordis.patch.yml 的关键结构（顶层是否 insert、id 是否与包名一致）。 */
export function readBundlePatch(pluginRoot, pluginName) {
  const f = join(pluginRoot, 'cordis.patch.yml');
  if (!existsSync(f)) return { found: false };
  let text = '';
  try { text = readFileSync(f, 'utf8'); } catch { return { found: true, error: '读取失败' }; }
  const hasInsert = /^-\s*insert:/m.test(text);
  const idMatch = /^-\s*insert:\s*\n\s*-\s*id:\s*(\S+)/m.exec(text) || /^\s*-\s*id:\s*(\S+)/m.exec(text);
  const id = idMatch ? idMatch[1] : '';
  return { found: true, hasInsert, id, idMatchesName: !pluginName || !id || id === pluginName };
}

/** 本插件约定：lib/shared/<名字>/index.js 一个文件夹 = 一个工具。其他插件没有该结构就返回空。 */
function listSharedTools(pluginRoot) {
  const dir = join(pluginRoot, 'lib', 'shared');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'index.js')))
      .map((d) => d.name);
  } catch { return []; }
}

/**
 * 收集入口源码：入口本身 + 沿 `export * from './x'` 跟进的文件。
 * 必须跟进，否则「入口只做再导出」的插件（dsh-git-push 就是）会被误判成没有 apply。
 */
export function collectSourceFiles(entry, depth = 0, seen = new Set()) {
  const out = [];
  if (depth > MAX_REEXPORT_DEPTH || seen.has(entry)) return out;
  seen.add(entry);
  let text = '';
  try {
    const size = statSync(entry).size;
    if (size > MAX_SOURCE_BYTES) return out;
    text = readFileSync(entry, 'utf8');
  } catch { return out; }
  out.push({ file: entry, text });
  const re = /export\s+\*\s+from\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const spec = match[1];
    if (!spec.startsWith('.')) continue;
    const next = join(dirname(entry), spec);
    for (const cand of [next, `${next}.js`, `${next}.mjs`, join(next, 'index.js')]) {
      if (existsSync(cand)) { out.push(...collectSourceFiles(cand, depth + 1, seen)); break; }
    }
  }
  return out;
}

/** 汇总入口源码里的装配特征（apply 导出 / tools 注册 / effect 风险）。 */
function scanAssembly(allText) {
  return {
    hasApply: /export\s+(?:async\s+)?function\s+apply\b/.test(allText)
      || /export\s+const\s+apply\s*=/.test(allText)
      || /export\s*\{[^}]*\bapply\b[^}]*\}/.test(allText),
    registersTools: /inject\(\s*\[\s*['"]tools['"]/.test(allText) || /get\(\s*['"]tools['"]\s*\)/.test(allText),
    registersCommands: /inject\(\s*\[\s*['"]commands['"]/.test(allText) || /get\(\s*['"]commands['"]\s*\)/.test(allText),
    applyReturn: inspectApplyReturns(allText),
  };
}

/** 把装配特征转成硬伤（problems）与启发式提示（warnings）。 */
function judgeAssembly({ hasApply, registersTools, applyReturn, patch, pluginName, files }) {
  const problems = [];
  const warnings = [];
  if (!hasApply) problems.push('没有找到 apply 导出（宿主不会把它当插件装载）');
  if (applyReturn.risky) problems.push(`apply 顶层有对象字面量返回：${applyReturn.samples.join(' ; ')} —— cordis 会判 Invalid effect 并卸载整条 fiber，工具全部失效`);
  if (patch.found && !patch.hasInsert) problems.push('cordis.patch.yml 没有顶层 - insert:（装载入口缺失，市场会报 patch target not found）');
  // 下面几条是启发式：不同插件可以合法地不注册工具、也可以自定义 loader id
  if (!registersTools) warnings.push('没有找到 tools 注册调用（inject(["tools"]) / get("tools")）——若该插件本就不注册工具可忽略');
  if (patch.found && !patch.idMatchesName) warnings.push(`cordis.patch.yml 的 id（${patch.id}）与包名（${pluginName}）不同——自定义 id 合法，确认是有意为之即可`);
  if (files.length > 1) warnings.push(`入口通过 export * 转出，已跟进 ${files.length - 1} 个文件（${files.slice(1).map((f) => f.file.split('/').slice(-2).join('/')).join(', ')}）`);
  return { problems, warnings };
}

/**
 * 静态分析单个插件：入口、apply、注册调用、effect 风险、bundle patch、工具名线索。
 * 全程只读文件，不执行任何插件代码。
 */
export function analyzePlugin(pluginRoot) {
  const meta = resolveEntry(pluginRoot);
  if (!meta.ok) return { ok: false, error: meta.error, pluginRoot, problems: [meta.error], warnings: [] };

  const files = collectSourceFiles(meta.entry);
  const assembly = scanAssembly(files.map((f) => f.text).join('\n'));
  const patch = readBundlePatch(pluginRoot, meta.name);
  const sharedTools = listSharedTools(pluginRoot);
  const { problems, warnings } = judgeAssembly({ ...assembly, patch, pluginName: meta.name, files });

  return {
    ok: problems.length === 0,
    pluginRoot,
    entry: meta.entry,
    packageName: meta.name,
    packageVersion: meta.version,
    filesAnalyzed: files.map((f) => f.file),
    hasApply: assembly.hasApply,
    registersTools: assembly.registersTools,
    registersCommands: assembly.registersCommands,
    applyReturn: assembly.applyReturn,
    bundlePatch: patch,
    sharedTools,
    problems,
    warnings,
  };
}
