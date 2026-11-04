/**
 * DSH 插件专属规则（静态检查）。
 *
 * ⚠ 与 dsh-git-push 的 `lib/audit-rules/audit-rules-dsh.yml` **语义一致、实现独立**：
 *   两个插件不互相 import，各自维护一份判定逻辑，避免耦合；规则增删时两边同步。
 *   这里逐文件扫描（审计那边是逐行扫描新增行），判定口径相同：命中即违规。
 *
 * 收录原则：只收「与 DSH 插件强关联」且**静态可判定**的规则；
 * 需要运行期才能确认的（服务是否真的注入成功、路由是否真的注册）交给激活诊断与日志归类。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// 参与扫描的扩展名
const JS_EXTS = ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'];
const YAML_EXTS = ['yml', 'yaml'];
// 扫描上限：插件仓库一般几十个文件，给足余量但不无限
const MAX_FILES = 500;
const MAX_FILE_BYTES = 512 * 1024;
// 扫描根（相对插件根）：代码与配置都在这些目录下
const SCAN_DIRS = ['lib', 'src', 'client', 'public', 'crx', 'server'];

/** 客户端半部文件判定：这些位置属于浏览器侧（native-host 例外，它是 Node 宿主）。 */
export function isClientFile(rel) {
  const p = String(rel).replace(/\\/g, '/');
  if (p.startsWith('crx/native-host/')) return false;
  return p === 'lib/client.js'
    || p.startsWith('lib/client-parts/')
    || p.startsWith('client/')
    || p.startsWith('public/')
    || p.startsWith('crx/');
}

/**
 * 真实存在、通过 ctx 暴露的 cordis 服务（保守清单）。
 * 为什么需要：`ctx` 是极常见的参数名——HTTP 请求、工具执行上下文、遍历累加器都可能叫 ctx，
 *   只靠 `ctx.xxx` 的写法无法区分语义（实测：真实插件被误报 20 条 / 仓库）。
 *   只报清单里的服务名，宁少勿多。
 */
const KNOWN_CORDIS_SERVICES = new Set([
  'tools', 'fs', 'sessions', 'llm', 'credentials', 'webServer', 'slots', 'locale',
  'storageDomain', 'workspaceRegistry', 'commands', 'sandbox', 'models', 'settings',
  'jobs', 'subagents', 'skills', 'schedule', 'terminals', 'systemPrompt', 'spillStore',
  'pluginManager', 'pluginInventory', 'approval', 'sessionQuery', 'agentLoop',
]);

/** 该文件是不是插件入口：只有入口手里那个 ctx 才确定是 cordis Context。 */
function isPluginEntry(text) {
  return /export\s+(async\s+)?function\s+apply\b/.test(text)
    || /export\s+const\s+inject\b/.test(text);
}

// 扫描时跳过的文件名：本文件是**规则定义本身**，
//   里面的 message 文案与正则源码天然包含违规写法（例如「用 addRoute || route 兜底」这种说明），
//   再怎么剥离也难免自指，直接不扫自己。
const SKIP_FILES = new Set(['dsh-rules.mjs']);

/** 递归收集要扫描的文件（跳过 node_modules / .git / 测试夹具 / 规则定义文件）。 */
function collectFiles(root, limit) {
  const out = [];
  const push = (abs, rel) => {
    if (out.length >= limit) return;
    if (SKIP_FILES.has(rel.split('/').pop())) return;
    const ext = (rel.split('.').pop() || '').toLowerCase();
    if (![...JS_EXTS, ...YAML_EXTS].includes(ext)) return;
    try { if (statSync(abs).size > MAX_FILE_BYTES) return; } catch { return; }
    out.push({ abs, rel: rel.replace(/\\/g, '/'), ext });
  };
  const walk = (dir, prefix) => {
    if (out.length >= limit) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (['node_modules', '.git', '.trash', 'test', 'tests', 'dist', 'build'].includes(entry.name)) continue;
      const abs = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else push(abs, rel);
    }
  };
  // 根目录只收 patch 与入口脚本，避免把无关根文件全卷进来
  for (const name of ['cordis.patch.yml', 'cordis.patch.yaml']) {
    const abs = join(root, name);
    if (existsSync(abs)) push(abs, name);
  }
  for (const dir of SCAN_DIRS) {
    const abs = join(root, dir);
    if (existsSync(abs)) walk(abs, dir);
  }
  return out;
}

/**
 * 把注释与（可选的）字符串内容替换成等长空格，保留换行 ⇒ 行号不变，但**文案不参与匹配**。
 *
 * 为什么需要：规则的 message/说明里会写出违规写法本身（否则说不清规则是什么），
 * 若直接对全文匹配，规则会被自己的说明触发。判据只有一条：**字符串里的文字不是代码**。
 *
 * maskStrings=false 的用法：模块名/参数名本身就写在字符串里（`from 'cordis'`、
 * `require('fs')`），这类规则必须保留字符串内容，只剥注释。
 */
function maskCode(text, { maskStrings = true } = {}) {
  const src = String(text || '');
  const out = src.split('');
  // 把 [from, to) 替换成空格（换行保留，否则行号会错位）
  const blank = (from, to) => {
    for (let i = from; i < to; i += 1) if (out[i] !== '\n') out[i] = ' ';
  };
  // 上一个「有意义的字符」：判断 `/` 是正则字面量还是除号
  let prevMeaningful = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    // 正则字面量：只在「期待值」的位置才当正则（否则 `a / b` 会被误吞）
    if (ch === '/' && /^$|[=(,:[!&|?{};+\-*%<>~^]$/.test(prevMeaningful)) {
      let j = i + 1;
      let inClass = false;
      let closed = -1;
      while (j < src.length) {
        const c = src[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '\n') break;
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) { closed = j; break; }
        j += 1;
      }
      if (closed > 0) {
        // 正则体里常含引号，整段抹掉；没有规则需要匹配正则字面量的内容
        blank(i + 1, closed);
        i = closed + 1;
        prevMeaningful = '/';
        continue;
      }
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      let j = i + 1;
      let end = -1;
      while (j < src.length) {
        const c = src[j];
        if (c === '\\') { j += 2; continue; }
        if (c === quote) { end = j; break; }
        j += 1;
      }
      const stop = end < 0 ? src.length : end;
      if (maskStrings) blank(i + 1, stop);
      i = stop + 1;
      prevMeaningful = quote;
      continue;
    }
    if (!/\s/.test(ch)) prevMeaningful = ch;
    i += 1;
  }
  return out.join('');
}

/** 逐行匹配（skipComment：注释行整行豁免，避免文档里写规则名被自己误报）。 */
function lineHits(text, re, { skipComment = false } = {}) {
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (skipComment && /^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    if (re.test(line)) hits.push({ line: i + 1, text: line.trim().slice(0, 200) });
  }
  return hits;
}

/**
 * 需要「字符串内容」的规则（模块名类）专用：
 *   ① 用**遮蔽视图**（字符串内容已抹成空格）确认这一行确实是 import / require 语句；
 *   ② 再回**原文**同一行确认模块名。
 * 这样既不会漏真代码（`from 'cordis'` 仍命中），也不会被「文档里提到 import 'cordis'」的
 * 字符串字面量触发（那种行的结构在遮蔽视图里已经不存在了）。
 * @param {string} masked 遮蔽后的文本（字符串内容为空格，行号与原文一致）
 * @param {string} raw 原文
 */
function stringArgHits(masked, raw, { stmtRe, valueRe }) {
  const hits = [];
  const maskedLines = String(masked || '').split('\n');
  const rawLines = String(raw || '').split('\n');
  for (let i = 0; i < maskedLines.length; i += 1) {
    if (!stmtRe.test(maskedLines[i])) continue;
    const line = rawLines[i] || '';
    if (!valueRe.test(line)) continue;
    hits.push({ line: i + 1, text: line.trim().slice(0, 200) });
  }
  return hits;
}

/**
 * 规则表：id / 严重度 / 说明 / 适用文件 / 判定。
 * 与 audit-rules-dsh.yml 一一对应（顺序也保持），便于两边对照维护。
 */
export const DSH_RULES = [
  {
    id: 'dsh/import-bare-cordis',
    name: '禁止裸名导入 cordis',
    severity: 'error',
    exts: JS_EXTS,
    message: '裸名 cordis 在 loader 装载闭包里解析失败，应 import from "@deepseek-ai/cordis"',
    // 模块名在字符串里：先确认这行真的是 import/require 语句（用遮蔽视图），再回原文取模块名
    check: (text, ctx) => stringArgHits(text, ctx.raw, {
      stmtRe: /(?:from\s*['"]\s*['"]|require\s*\(\s*['"]\s*['"]\s*\))/,
      valueRe: /(?:from\s*['"]cordis['"]|require\s*\(\s*['"]cordis['"]\s*\))/,
    }),
  },
  {
    id: 'dsh/import-bare-schemastery',
    name: '禁止裸名导入 schemastery',
    severity: 'error',
    exts: JS_EXTS,
    message: '裸名 schemastery 解析失败，应 import z from "@deepseek-ai/schemastery"',
    check: (text, ctx) => stringArgHits(text, ctx.raw, {
      stmtRe: /(?:from\s*['"]\s*['"]|require\s*\(\s*['"]\s*['"]\s*\))/,
      valueRe: /(?:from\s*['"]schemastery['"]|require\s*\(\s*['"]schemastery['"]\s*\))/,
    }),
  },
  {
    id: 'dsh/tool-render-empty-body',
    name: '工具 render 空实现',
    severity: 'error',
    exts: JS_EXTS,
    message: 'render 必须返回内容块数组；空实现/返回 null 会让工具结果无法回显',
    check: (text) => lineHits(text, /render\s*\([^)]*\)\s*\{\s*\}|render\s*\([^)]*\)\s*\{\s*return\s+(null|undefined)\s*;?\s*\}/),
  },
  {
    id: 'dsh/client-node-builtin-require',
    name: 'Client 半部 require Node 内置模块',
    severity: 'error',
    exts: JS_EXTS,
    onlyClient: true,
    message: '浏览器侧没有 Node 运行时，require 内置模块必然运行失败',
    // 同模块名类规则：先确认是 require('') 结构，再回原文核对模块名
    check: (text, ctx) => stringArgHits(text, ctx.raw, {
      stmtRe: /require\s*\(\s*['"]\s*['"]\s*\)/,
      valueRe: /require\s*\(\s*['"](?:node:)?(?:fs|path|os|child_process|net|dgram|tls|http|https|worker_threads|cluster)['"]\s*\)/,
    }),
  },
  {
    id: 'dsh/schema-secret-field-role',
    name: '配置凭据字段未标注 role("secret")',
    severity: 'warning',
    exts: JS_EXTS,
    message: 'token/secret/apiKey/password 字段应 z.string().role("secret")，否则凭据可能进 settings 明文与日志',
    check: (text) => lineHits(text, /(?:token|secret|apiKey|password|credential)[A-Za-z0-9_]*\s*:\s*z\.string\(\)(?!\s*\.\s*role)/),
  },
  {
    id: 'dsh/patch-insert-unique-id',
    name: 'patch insert 行 id 与按 id 覆盖行重复',
    severity: 'warning',
    exts: YAML_EXTS,
    message: 'insert 新建的行与后续按 id 覆盖行同 id 会 duplicate-id 双挂；insert 行 id 应唯一',
    // 需要整文件结构：insert 行 id 集合 vs 顶层按 id 覆盖行集合
    check: (text) => {
      const insertIds = new Set();
      const overrideIds = new Set();
      let inInsert = false;
      let insertIndent = 0;
      for (const raw of text.split('\n')) {
        const indent = raw.length - raw.trimStart().length;
        const trimmed = raw.trim();
        if (!trimmed) continue;
        if (/^-\s*insert:\s*$/.test(trimmed)) { inInsert = true; insertIndent = indent; continue; }
        if (inInsert) {
          if (indent <= insertIndent && /^-/.test(trimmed)) { inInsert = false; }
          else {
            const m = /^-\s*id:\s*(\S+)/.exec(trimmed);
            if (m) insertIds.add(m[1]);
            continue;
          }
        }
        const ov = /^-\s*id:\s*(\S+)/.exec(trimmed);
        if (ov) overrideIds.add(ov[1]);
      }
      const dup = [...insertIds].filter((id) => overrideIds.has(id));
      return dup.length
        ? [{ line: 0, text: `insert 与覆盖行同 id：${dup.join(', ')}` }]
        : [];
    },
  },
  {
    id: 'dsh/client-module-loader-id',
    name: 'Client 半部入口未走 __ModuleLoader__',
    severity: 'warning',
    exts: JS_EXTS,
    onlyClient: true,
    message: 'client 半部应通过 window.__ModuleLoader__.load({ id, factory }) 注册懒加载入口',
    // 只在 client 文件里检查：没有 __ModuleLoader__ 就提示（与 verify_plugin 的 client 段互补，那边判 problems）
    check: (text) => (text.includes('__ModuleLoader__') ? [] : [{ line: 1, text: '未找到 __ModuleLoader__.load' }]),
  },
  {
    id: 'dsh/ctx-undeclared-property-read',
    name: '读 ctx 上未注入的属性',
    severity: 'blocker',
    exts: JS_EXTS,
    message: 'cordis 的 Context 是严格代理：访问未注入属性会抛错；在 tools/pre-execute 这类高频事件里会打挂宿主全部工具',
    // 注释整行豁免：项目文档/注释里会提到这些字段名
    check: (text) => lineHits(text, /ctx\.(sessionId|sessionID|conversationId|agentId|workspaceRoot|dshHome|DSH_HOME)\b/, { skipComment: true }),
  },
  {
    id: 'dsh/ctx-service-not-injected',
    name: '读 ctx 上未注入的服务',
    severity: 'blocker',
    exts: JS_EXTS,
    message: 'cordis 会直接拒绝访问未注入的服务（cannot get property "x" without inject）⇒ 插件整条不激活，而单测用假 ctx 永远测不出来；需模块级 export const inject = [\'x\']，或改用 ctx.get(\'x\')',
    // 与 ctx-undeclared-property-read 的分工：那条管「已知的错误字段名」，这条管「服务名漏声明 inject」。
    // ⚠ 必须读原文（ctx.raw）：规则默认视图把字符串内容遮蔽成空格，而 inject 里的服务名正是字符串字面量。
    check: (maskedText, ctx) => ctxServiceNotInjectedHits(String(ctx?.raw ?? maskedText)),
  },
  {
    id: 'dsh/plugin-default-export-hides-inject',
    name: '入口同时有 default 与命名导出 inject/apply',
    severity: 'blocker',
    exts: JS_EXTS,
    message: 'DSH 装载时走 `data = module.default || module`（app-boot 解析处）：一旦有 default 导出，命名导出 inject/name 全部失效 ⇒ 访问 ctx 上的服务直接抛 cannot get property … without inject，插件整条不激活；入口只保留命名导出',
    // 只在「既有 default、又有命名 inject/apply」时命中：单独 default 或单独命名导出都合法。
    check: (text) => {
      const hasDefault = /(^|\n)\s*export\s+default\b/.test(text);
      const hasNamedInject = /(^|\n)\s*export\s+(const|let|var)\s+inject\b/.test(text);
      const hasNamedApply = /(^|\n)\s*export\s+(async\s+)?function\s+apply\b/.test(text);
      if (!hasDefault || !(hasNamedInject || hasNamedApply)) return [];
      const hit = lineHits(text, /(^|\n)\s*export\s+default\b/, { skipComment: true });
      return hit.length ? hit : [{ line: 1, text: '入口同时存在 default 与命名导出' }];
    },
  },
  {
    id: 'dsh/host-api-guessed-fallback-chain',
    name: '猜宿主 API 的兜底链',
    severity: 'error',
    exts: JS_EXTS,
    message: '用 addRoute || route || use 这类猜测 API 兜底，真实 API 不匹配时静默 return ⇒ 功能失效却无报错；应直接用 webServer.register({ kind, path, handler })',
    check: (text) => lineHits(text, /\b(addRoute|addHandler|registerRoute|useRoute)\s*\|\|/),
  },
];

/**
 * cordis Context 自身的内建成员（不是"服务"）：访问它们不需要 inject 声明。
 * 只收确定不会误伤的：事件 API、effect、logger、依赖注入原语、fiber/scope 等。
 */
const CORDIS_BUILTIN_MEMBERS = new Set([
  'on', 'once', 'off', 'emit', 'effect', 'logger', 'inject', 'plugin', 'get', 'set', 'provide',
  'accessor', 'root', 'scope', 'fiber', 'reflect', 'registry', 'runtime', 'dispose', 'extend',
  'isolate', 'waterfall', 'bail', 'parallel', 'serial', 'ctx', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'name', 'config', 'options', 'state',
]);

/**
 * 从源码里取 `export const inject = [...]` 声明的服务名。
 * 用括号配对而非单行正则，兼容多行数组与 `[{ required: [...], optional: [...] }]` 形态。
 */
function declaredInjectNames(text) {
  const names = new Set();
  const anchor = /export\s+const\s+inject\s*=\s*/.exec(text);
  if (!anchor) return names;
  const start = anchor.index + anchor[0].length;
  let depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    } else if (ch === ';' && depth === 0) { end = i; break; }
  }
  const block = text.slice(start, end === -1 ? Math.min(start + 600, text.length) : end + 1);
  for (const quoted of block.matchAll(/['"`]([^'"`]+)['"`]/g)) names.add(quoted[1]);
  return names;
}

/**
 * 已知的「错误字段名」：它们不是 cordis 服务，由 dsh/ctx-undeclared-property-read 负责。
 * 本规则跳过这些名字，避免同一次读取被两条规则重复报（实测：ctx.sessionId 会同时命中两条）。
 */
const KNOWN_BAD_CTX_FIELDS = new Set([
  'sessionId', 'sessionID', 'conversationId', 'agentId', 'workspaceRoot', 'dshHome', 'DSH_HOME',
]);

/**
 * 去掉行内注释，保留字符串内容。
 * 为什么需要：代码后面跟一段行内块注释（注释里写了 ctx.xxx）时，那个 ctx 不是代码，
 *   只看「整行是否以 // 开头」会把它们误报（实测测试就是这么红的）。
 *   字符串里的 `//`（如 URL）要保留，故按引号状态逐字符扫描，不做正则替换。
 */
function stripTrailingComment(line) {
  let out = '';
  let quote = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += line[i + 1] || ''; i += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; continue; }
    if (ch === '/' && line[i + 1] === '/') break;
    if (ch === '/' && line[i + 1] === '*') {
      const close = line.indexOf('*/', i + 2);
      if (close < 0) break;
      i = close + 1;
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * 命中「读 ctx 上未注入的服务」的行。
 * 判定：`ctx.x` / `ctx?.x` 里的 x 既不在 inject 声明里、也不是 Context 内建成员、也不是已知错误字段名。
 * 只报服务名漏声明这一种可静态判定的形态；`ctx.get('x')` 这种显式取服务不受影响。
 */
function ctxServiceNotInjectedHits(text) {
  // 只在插件入口检查：非入口文件里的 ctx 多半是别的语义（HTTP 请求 / 工具上下文 / 累加器），
  //   逐一判断不了，宁可漏报也不误报。
  if (!isPluginEntry(text)) return [];
  const declared = declaredInjectNames(text);
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    const code = stripTrailingComment(line);
    if (!code.includes('ctx')) continue;
    for (const match of code.matchAll(/\bctx\s*\??\.\s*([A-Za-z_$][\w$]*)/g)) {
      const member = match[1];
      if (CORDIS_BUILTIN_MEMBERS.has(member)) continue;
      if (KNOWN_BAD_CTX_FIELDS.has(member)) continue;
      if (!KNOWN_CORDIS_SERVICES.has(member)) continue;
      if (declared.has(member)) continue;
      hits.push({ line: i + 1, text: line.trim().slice(0, 200) });
      break;
    }
  }
  return hits;
}

/**
 * 跑全部 DSH 规则。
 * @param {{root: string}} params
 * @returns {{rules: Array<{id:string,severity:string,name:string}>, hits: Array<object>, scannedFiles: number}}
 */
export function checkDshRules({ root } = {}) {
  const files = collectFiles(String(root || ''), MAX_FILES);
  const hits = [];
  for (const file of files) {
    let text = '';
    try { text = readFileSync(file.abs, 'utf8'); } catch { continue; }
    // 只对 JS 类文件做遮蔽：YAML 里的 `https://` 会被当成行注释，误吞整行内容。
    const isJs = JS_EXTS.includes(file.ext);
    // 两种视图按需计算一次：剥字符串（默认）与只剥注释（maskStrings:false 的规则用）
    // 统一用「字符串内容也遮蔽」的视图：这样任何规则都不会被字符串里的文案触发；
    //   需要字符串内容的规则（模块名类）从 ctx.raw 回原文取值，并用结构断言限定位置。
    const viewCache = new Map();
    const viewOf = () => {
      if (!isJs) return text;
      if (!viewCache.has('masked')) viewCache.set('masked', maskCode(text, { maskStrings: true }));
      return viewCache.get('masked');
    };
    for (const rule of DSH_RULES) {
      if (rule.exts && !rule.exts.includes(file.ext)) continue;
      if (rule.onlyClient && !isClientFile(file.rel)) continue;
      let found = [];
      try { found = rule.check(viewOf(), { raw: text }) || []; } catch { found = []; }
      for (const hit of found) {
        hits.push({
          rule: rule.id,
          name: rule.name,
          severity: rule.severity,
          message: rule.message,
          file: file.rel,
          line: hit.line,
          // 命中位置回显原文（遮蔽后的文本是空格，给人看没意义）；
          // 整文件级命中（line:0，例如 patch id 冲突）没有具体行，保留规则自己给的描述
          text: hit.line > 0
            ? (String(text).split('\n')[hit.line - 1] || hit.text || '').trim().slice(0, 200)
            : hit.text,
        });
      }
    }
  }
  return {
    rules: DSH_RULES.map((r) => ({ id: r.id, severity: r.severity, name: r.name })),
    hits,
    scannedFiles: files.length,
  };
}
