#!/usr/bin/env node
/**
 * 通用 DSH 插件 mini-host · **子进程执行器**
 *
 * 作用：在**独立子进程**里加载任意 DSH 插件的服务端入口（package.json 的 exports["."]/main
 *   导出的 `apply`），用宽容 ctx 垫片让插件完成接线，然后用 mock 的 node `req`/`res`
 *   执行它通过 `webServer.register({kind,path,handler})` 注册的 HTTP 处理器，最后把
 *   响应以 JSON 写到 stdout。
 *
 * 为什么是子进程：宿主不重启时，插件模块在 ESM 缓存里是旧的；子进程冷启动会让**整个模块图**
 *   （入口 + 全部子模块）都从磁盘重新加载——于是「改代码 → 再发一次请求」即生效，
 *   不需要重启 DSH 宿主，也不需要重启 mini-host 主进程。
 *
 * 输入（stdin JSON）：{ pluginRoot, method, url, headers, bodyBase64?, workspaceRoot?, config? }
 * 输出（stdout JSON）：{ ok, status, headers, bodyBase64?, error?, routes? }
 */
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { Readable, Writable } from 'node:stream';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 读到沙箱/父进程传来的请求描述。 */
function readPayload() {
  try { return JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}
const p = readPayload();
const pluginRoot = String(p.pluginRoot || '');
const method = String(p.method || 'GET').toUpperCase();
const url = String(p.url || '/');
const headers = p.headers && typeof p.headers === 'object' ? p.headers : {};
const workspaceRoot = String(p.workspaceRoot || resolve(pluginRoot, '..'));
const config = p.config && typeof p.config === 'object' ? p.config : {};

/** 一次性把结果写 stdout 后退出（父进程据此回写 HTTP 响应）。 */
function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

// 插件 apply() 普遍会往 stdout 打接线日志（如 "[xxx] API 路由已注册"）——那会与本进程的
//   结果 JSON 共用 stdout 造成污染（父进程解析失败）。这里把 console.log/info/debug/warn
//   全部改道 stderr：stdout 只保留最终结果，日志仍可在父进程 stderr 里看到。
const toStderr = (...args) => {
  try {
    const line = args.map((a) => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
    process.stderr.write(line + '\n');
  } catch { /* 忽略日志失败 */ }
};
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;
console.warn = toStderr;

/* ───────── 依赖解析：把 DSH 包指到宿主的 node_modules ─────────
 * 很多插件入口会**静态 import** DSH 包（@deepseek-ai/schemastery、@deepseek-ai/dsh-tools 等），
 * 而这些包只装在宿主/各个 profile 的 node_modules 里，工作区源码目录解析不到 → 入口加载即失败。
 * 这里用 ESM resolve hook：对 @deepseek-ai 与 @dsh- 作用域下的 import，改为以**依赖目录**
 * 为 parentURL 再解析，从而沿用 Node 标准的向上查找语义命中宿主的包。
 * （注：本段注释里刻意不写带星号的 scoped 通配写法——那种写法含 `*` + `/`，会提前闭合块注释。） */
const depsDirs = (Array.isArray(p.depsDirs) ? p.depsDirs : []).filter((d) => d && existsSync(d));
if (depsDirs.length) {
  const DSH_SPEC = /^@(?:deepseek-ai|dsh-[a-z0-9-]+)\//;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (DSH_SPEC.test(specifier)) {
        for (const dir of depsDirs) {
          try {
            return nextResolve(specifier, { ...context, parentURL: pathToFileURL(join(dir, '__minihost_probe__.js')).href });
          } catch { /* 该目录没有此包 → 试下一个 */ }
        }
      }
      return nextResolve(specifier, context);
    },
  });
}

if (!pluginRoot) emit({ ok: false, status: 500, error: 'mini-host: 缺少 pluginRoot' });

/* ───────── 宽容 ctx 垫片 ─────────
 * 插件 apply() 里会用 cordis 的 ctx API：inject/get/on/effect…，以及各服务上的方法。
 * 这里的目标不是「模拟 cordis」，而是**让插件把接线跑完**：inject 立刻回调、未知 API 一律
 * no-op（返回函数不返回 undefined，避免插件 `x.y is not a function` 直接崩），
 * 缺失的可选服务（jobs/log 等）返回 undefined，插件自身有降级路径。 */
const routes = [];       // webServer.register 收到的 {kind,path,handler}
const collected = { tools: [], sections: [], commands: [], settings: [] };
const warnings = [];
const services = {
  webServer: { register: (r) => { if (r && typeof r.handler === 'function') routes.push(r); } },
  tools: { register: (d) => collected.tools.push(d), list: () => collected.tools.slice() },
  systemPrompt: { section: (o) => collected.sections.push(o) },
  commands: { register: (d) => collected.commands.push(d) },
  settings: { register: (ns) => collected.settings.push(ns) },
  workspaceRoot,
  // 刻意留空 → 插件走「宿主服务缺失」的降级分支（如 git_commit_push 同步执行）
  jobs: undefined,
  log: undefined,
};

// 可选：从 DSH_MINIHOST_SERVICES 注入宿主服务（插件依赖真实服务时用，如 storageDomain / sessions）。
//   约定：模块默认导出「服务对象」或「返回服务对象的函数」；注入项覆盖默认同名服务。
const servicesModule = String(process.env.DSH_MINIHOST_SERVICES || '').trim();
if (servicesModule) {
  try {
    const mod = await import(pathToFileURL(servicesModule).href);
    const extra = typeof mod.default === 'function' ? await mod.default() : (mod.default || mod);
    if (extra && typeof extra === 'object') Object.assign(services, extra);
  } catch (e) {
    warnings.push(`services 注入失败（${servicesModule}）: ${e?.message || e}`);
  }
}
const noop = () => {};

/** 造一个宽容子 ctx（inject 回调拿到的东西）。 */
function makeCtx(depth = 0) {
  const base = {
    get: (name) => services[name],
    inject: (names, cb) => {
      // 立刻回调：让插件以为依赖已就绪（真实 cordis 是依赖满足后再调）
      if (typeof cb === 'function') {
        try { cb(makeCtx(depth + 1)); } catch (e) { warnings.push(`inject(${[].concat(names).join(',')}) 回调异常: ${e?.message || e}`); }
      }
      return noop;
    },
    on: noop,
    off: noop,
    once: noop,
    emit: noop,
    effect: noop,
    plugin: noop,
    set: noop,
    provide: noop,
    consume: noop,
    logger: () => ({ info: noop, warn: noop, error: noop, debug: noop }),
  };
  return new Proxy(base, {
    get: (t, k) => (k in t ? t[k] : noop),   // 未知 API → no-op，插件不会因缺 API 崩
    has: () => true,
  });
}

/* ───────── 加载插件入口 ───────── */
let entryUrl = '';
try {
  const pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));
  // 入口解析要吃三种 package.json 写法：字符串（"./lib/index.js"）/ 条件导出对象
  //   （{"import": "./lib/index.js"} 等——dsh-session-conductor 就是对象形态）/ 仅 main。
  const exp = pkg.exports;
  let relRaw = null;
  if (typeof exp === 'string') relRaw = exp;
  else if (exp && typeof exp === 'object') {
    const dot = exp['.'];
    if (typeof dot === 'string') relRaw = dot;
    else if (dot && typeof dot === 'object') relRaw = dot.import || dot.default || dot.require || dot.node || Object.values(dot).find((v) => typeof v === 'string') || null;
  }
  const rel = relRaw || pkg.main || 'index.js';
  entryUrl = pathToFileURL(resolve(pluginRoot, String(rel))).href;
} catch (e) {
  emit({ ok: false, status: 500, error: `mini-host: 读插件 package.json 失败: ${e?.message || e}` });
}

let applyFn = null;
try {
  const mod = await import(entryUrl);
  applyFn = mod.apply || (mod.default && mod.default.apply) || (typeof mod.default === 'function' ? mod.default : null);
} catch (e) {
  emit({ ok: false, status: 500, error: `mini-host: 加载插件入口失败（${entryUrl}）: ${e?.message || e}` });
}
if (typeof applyFn !== 'function') {
  emit({ ok: false, status: 500, error: `mini-host: 插件入口未导出 apply（${entryUrl}）`, });
}

/* ───────── 跑插件接线（apply） ───────── */
try {
  await applyFn(makeCtx(), config);
} catch (e) {
  // apply 抛错不直接判死：插件可能已注册了部分路由（例如某个可选服务接线失败）
  warnings.push(`apply 抛错: ${e?.message || e}`);
}

/* ───────── 匹配路由并执行（mock req/res） ───────── */
// 路由匹配只看 pathname：query 是 handler 的参数（如 ?fromIndex=true），不参与匹配。
//   旧实现拿含 query 的完整 url 去比，任何带参数的接口都会 404（实测 /i18n?x=1 即复现）。
const pathname = url.split('?')[0];
const route = routes.find((r) => (r.kind === 'prefix' ? pathname.startsWith(r.path) : pathname === r.path));
if (!route) {
  emit({ ok: false, status: 404, error: `mini-host: 插件未注册匹配 ${pathname} 的路由`, routes: routes.map((r) => `${r.kind}:${r.path}`), warnings });
}

const reqBody = Buffer.from(String(p.bodyBase64 || ''), 'base64');
const mockReq = new Readable({ read() { this.push(reqBody.length ? reqBody : null); this.push(null); } });
mockReq.method = method;
mockReq.url = url;
mockReq.headers = headers;
mockReq.socket = { remoteAddress: '127.0.0.1' };
mockReq.connection = mockReq.socket;

const chunks = [];
const mockRes = new Writable({ write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
mockRes.statusCode = 200;
mockRes.headers = {};
mockRes.writeHead = (status, hdrs) => { mockRes.statusCode = status; if (hdrs) Object.assign(mockRes.headers, hdrs); return mockRes; };
mockRes.setHeader = (k, v) => { mockRes.headers[k] = v; return mockRes; };
mockRes.getHeader = (k) => mockRes.headers[k];
mockRes.removeHeader = (k) => { delete mockRes.headers[k]; };
mockRes.flushHeaders = noop;
const origEnd = mockRes.end.bind(mockRes);
mockRes.end = (chunk, enc, cb) => { if (chunk) chunks.push(Buffer.from(chunk)); return origEnd(undefined, undefined, typeof enc === 'function' ? enc : cb); };

try {
  await route.handler(mockReq, mockRes);
} catch (e) {
  emit({ ok: false, status: 500, error: `mini-host: 处理器抛错: ${e?.message || e}`, warnings });
}
await new Promise((r) => { if (mockRes.writableEnded || mockRes.finished) r(); else mockRes.on('finish', r); });
emit({
  ok: true,
  status: mockRes.statusCode,
  headers: mockRes.headers,
  bodyBase64: Buffer.concat(chunks).toString('base64'),
  routes: routes.map((r) => `${r.kind}:${r.path}`),
  warnings,
});
