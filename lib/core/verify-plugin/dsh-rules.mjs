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
    || p.startsWith('client/')
    || p.startsWith('public/')
    || p.startsWith('crx/');
}

/** 递归收集要扫描的文件（跳过 node_modules / .git / 测试夹具）。 */
function collectFiles(root, limit) {
  const out = [];
  const push = (abs, rel) => {
    if (out.length >= limit) return;
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
    check: (text) => lineHits(text, /import\s+.*?\s+from\s+['"]cordis['"]|require\s*\(\s*['"]cordis['"]\s*\)/),
  },
  {
    id: 'dsh/import-bare-schemastery',
    name: '禁止裸名导入 schemastery',
    severity: 'error',
    exts: JS_EXTS,
    message: '裸名 schemastery 解析失败，应 import z from "@deepseek-ai/schemastery"',
    check: (text) => lineHits(text, /import\s+.*?\s+from\s+['"]schemastery['"]|require\s*\(\s*['"]schemastery['"]\s*\)/),
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
    check: (text) => lineHits(text, /require\s*\(\s*['"](?:node:)?(?:fs|path|os|child_process|net|dgram|tls|http|https|worker_threads|cluster)['"]\s*\)/),
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
    id: 'dsh/host-api-guessed-fallback-chain',
    name: '猜宿主 API 的兜底链',
    severity: 'error',
    exts: JS_EXTS,
    message: '用 addRoute || route || use 这类猜测 API 兜底，真实 API 不匹配时静默 return ⇒ 功能失效却无报错；应直接用 webServer.register({ kind, path, handler })',
    check: (text) => lineHits(text, /\b(addRoute|addHandler|registerRoute|useRoute)\s*\|\|/),
  },
];

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
    for (const rule of DSH_RULES) {
      if (rule.exts && !rule.exts.includes(file.ext)) continue;
      if (rule.onlyClient && !isClientFile(file.rel)) continue;
      let found = [];
      try { found = rule.check(text) || []; } catch { found = []; }
      for (const hit of found) {
        hits.push({
          rule: rule.id,
          name: rule.name,
          severity: rule.severity,
          message: rule.message,
          file: file.rel,
          line: hit.line,
          text: hit.text,
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
