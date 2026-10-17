#!/usr/bin/env node
/**
 * 通用 DSH 插件 mini-host · **主进程**
 *
 * 一句话：给任意 DSH 插件起一个「本地 mini 宿主」——把它服务端代码跑起来（含 HTTP 路由），
 *   且**改完代码刷新页面即生效**（每个请求 fork 一次性子进程，模块天然新鲜），
 *   既不用重启真宿主，也不用重启本服务。
 *
 * 用法：
 *   node host.mjs --plugin <插件根> [--port 31099] [--preview <html>] \
 *        [--static <目录> ...] [--workspace <workspaceRoot>] [--config <json|@文件>] [--timeout 120000]
 *
 * 参数：
 *   --plugin     DSH 插件项目根（含 package.json；入口取 exports["."]/main 导出的 apply）
 *   --port       HTTP 端口（默认 31099）
 *   --preview    根路径 `/` 返回的预览页（如 <插件>/assets/preview.html）
 *   --static     额外静态目录（可重复；请求路径以目录名开头时从该目录取文件）
 *   --workspace  传给插件的 workspaceRoot（默认插件根的上一级）
 *   --config     插件 config（JSON 字符串，或 @文件路径）
 *   --timeout    单请求子进程超时毫秒（默认 120000）
 *   --quiet      不打印每请求日志
 *
 * 与「真宿主」的差别（如实说明）：本工具只做**开发自检**——只加载插件的服务端接线（webServer
 *   路由 / tools / systemPrompt / commands 注册被收集但仅 HTTP 可用），不提供会话、模型、
 *   工具执行等宿主能力。正式生效仍需重启 DSH 宿主。
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD = join(HERE, 'host-child.mjs');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
};

/* ───────── 参数 ───────── */
const argv = process.argv.slice(2);
const argOf = (name, dflt = null) => {
  const i = argv.indexOf(name);
  if (i === -1) return dflt;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : dflt;
};
const argAll = (name) => {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name && argv[i + 1] && !argv[i + 1].startsWith('--')) out.push(argv[i + 1]);
  }
  return out;
};
const PLUGIN = resolve(argOf('--plugin', '') || '');
const PORT = parseInt(argOf('--port', '31099'), 10);
const PREVIEW = argOf('--preview', '') ? resolve(argOf('--preview')) : '';
const STATIC_DIRS = argAll('--static').map((d) => resolve(d));
const WORKSPACE = resolve(argOf('--workspace', '') || join(PLUGIN, '..'));
const TIMEOUT_MS = parseInt(argOf('--timeout', '120000'), 10);
const QUIET = argv.includes('--quiet');

/**
 * DSH 依赖搜索目录：插件入口常静态 import `@deepseek-ai/...`，而这些包只装在宿主/profile 的
 *   node_modules 里。缺省探测顺序：$DSH_HOME/profiles/&lt;profile&gt;/node_modules → DSH 套件安装位的
 *   node_modules；可用 `--deps <目录>`（可重复）显式追加。
 */
function resolveDepsDirs() {
  const out = [];
  const add = (d) => { if (d && existsSync(d) && !out.includes(d)) out.push(d); };
  const addProfilesUnder = (base) => {
    const profiles = join(base, '.dsh', 'profiles');
    try {
      for (const name of readdirSync(profiles)) add(join(profiles, name, 'node_modules'));
    } catch { /* 该层没有 .dsh/profiles */ }
  };
  // ① 环境变量给的 DSH_HOME
  if (process.env.DSH_HOME) addProfilesUnder(process.env.DSH_HOME);
  // ② 从插件根**上溯**找 .dsh/profiles（不依赖环境变量——脚本/手动跑时通常没有 DSH_HOME）
  let cur = resolve(PLUGIN);
  for (let i = 0; i < 5; i += 1) {
    const up = resolve(cur, '..');
    if (up === cur) break;
    cur = up;
    addProfilesUnder(cur);
  }
  // ③ DSH 套件安装位的 node_modules（第三方依赖兜底）
  for (const c of [
    '/volume1/@appstore/DeepSeekHarness-NAS/node_modules',
    '/var/packages/DeepSeekHarness-NAS/target/node_modules',
  ]) add(c);
  // ④ 显式 --deps（可重复）
  for (const d of argAll('--deps')) add(resolve(d));
  return out;
}
const DEPS_DIRS = resolveDepsDirs();
let CONFIG = {};
const cfgArg = argOf('--config', '');
if (cfgArg) {
  try { CONFIG = JSON.parse(cfgArg.startsWith('@') ? readFileSync(cfgArg.slice(1), 'utf8') : cfgArg); }
  catch (e) { console.error(`[minihost] --config 解析失败：${e?.message || e}`); process.exit(2); }
}

if (!PLUGIN || !existsSync(join(PLUGIN, 'package.json'))) {
  console.error('[minihost] 必须用 --plugin 指定 DSH 插件项目根（含 package.json）');
  process.exit(2);
}

/* ───────── 工具 ───────── */
function send(res, status, body, type) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': type || 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
  res.end(body);
}
function serveFile(res, file) {
  if (!existsSync(file) || !statSync(file).isFile()) { send(res, 404, 'not found'); return; }
  if (res.writableEnded) return;
  res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' });
  createReadStream(file).pipe(res);
}
/** 读完整请求体 → base64（子进程用 Buffer 还原，二进制安全）。 */
function readBody(req) {
  return new Promise((r) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => r(Buffer.concat(chunks).toString('base64')));
    req.on('error', () => r(''));
  });
}
/** fork 子进程执行一次请求（模块新鲜 → 改代码即生效）。 */
function runChild(payload) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [CHILD], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } rej(new Error(`子进程超时（${TIMEOUT_MS}ms）`)); } }, TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); rej(e); } });
    child.on('close', (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (code !== 0) return rej(new Error(`子进程退出码 ${code}${err ? '：' + err.slice(0, 500) : ''}`));
      try { res(JSON.parse(out)); } catch { rej(new Error('子进程输出非 JSON：' + out.slice(0, 300))); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

/* ───────── 服务器 ───────── */
const server = createServer(async (req, res) => {
  const t0 = Date.now();
  const pathname = String(req.url || '/').split('?')[0];

  if (pathname === '/minihost-ping') { send(res, 200, 'pong'); return; }
  if ((pathname === '/' || pathname === '/index.html') && PREVIEW) { serveFile(res, PREVIEW); return; }

  for (const dir of STATIC_DIRS) {
    const name = dir.split('/').filter(Boolean).pop();
    if (pathname === `/${name}` || pathname.startsWith(`/${name}/`)) {
      const file = normalize(join(dir, '..', pathname));
      if (file.startsWith(dir)) { serveFile(res, file); return; }
      send(res, 403, 'forbidden'); return;
    }
  }

  // 其余一律交给子进程（插件自己按 webServer 前缀路由；未注册路径由子进程回 404）
  const bodyBase64 = await readBody(req);
  try {
    const r = await runChild({
      pluginRoot: PLUGIN, method: req.method, url: req.url, headers: req.headers,
      bodyBase64, workspaceRoot: WORKSPACE, config: CONFIG, depsDirs: DEPS_DIRS,
    });
    const body = Buffer.from(String(r.bodyBase64 || ''), 'base64');
    const headers = { ...(r.headers || {}), 'cache-control': 'no-cache' };
    if (res.writableEnded) return;
    res.writeHead(r.status || 200, headers);
    res.end(body);
    if (!QUIET) {
      const tag = r.ok === false ? ' ⚠ ' + String(r.error || '').slice(0, 120) : '';
      console.log(`[minihost] ${req.method} ${req.url} → ${r.status} ${Date.now() - t0}ms${tag}`);
      if (r.warnings && r.warnings.length && !QUIET) console.log(`[minihost]   warnings: ${r.warnings.slice(0, 3).join(' | ')}`);
    }
  } catch (e) {
    send(res, 500, JSON.stringify({ ok: false, error: 'minihost 执行失败: ' + String(e?.message || e) }), 'application/json; charset=utf-8');
    if (!QUIET) console.log(`[minihost] ${req.method} ${req.url} → 500 ${Date.now() - t0}ms ${String(e?.message || e).slice(0, 160)}`);
  }
});

server.listen(PORT, () => {
  const line = '═'.repeat(52);
  console.log(`\n╔${line}╗`);
  console.log('║  DSH 插件 mini-host（本地跑插件服务端代码 · 改完刷新即生效）');
  console.log(`╚${line}╝`);
  console.log(`  插件:     ${PLUGIN}`);
  console.log(`  预览页:   http://127.0.0.1:${PORT}/`);
  console.log(`  工作区:   ${WORKSPACE}`);
  console.log(`  模式:     每请求 fork 子进程（无需重启宿主/本服务）`);
  console.log(`  停止:     Ctrl+C\n`);
});
