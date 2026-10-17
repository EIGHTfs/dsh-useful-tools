/**
 * 预览页基础设施 · 静态服务 + 后端代理
 *
 * 用途：把生成的单文件 preview.html 起成本地服务（默认 `?mock=1` 走页面内假数据；
 * 带 `--backend` 时把 /api/* 反代到真实 DSH 后端，让预览页用真实数据自检）。
 * 台账：<插件根>/.preview/instances.json（pid/port/file），支持 stop/list 与死进程清理。
 */
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(HERE, '..', '..', '..', '.preview');
const STATE_FILE = join(STATE_DIR, 'instances.json');

function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return []; }
}
function writeState(list) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(list, null, 2), 'utf8');
}
function alive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}
function prune() {
  const all = readState();
  const live = all.filter((it) => alive(it.pid));
  if (live.length !== all.length) writeState(live);
  return live;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

/** 启动静态预览服务（守护化，日志落 .preview/）。 */
export async function servePreview(args = {}) {
  prune();
  const file = resolve(String(args.file || ''));
  if (!file || !existsSync(file)) return { ok: false, error: 'file 参数必须指向已生成的 preview.html' };
  const port = Number(args.port) || 31188;
  const state = readState();
  const busy = state.find((it) => it.port === port && alive(it.pid));
  if (busy) return { ok: false, error: `端口 ${port} 已被 pid ${busy.pid} 占用（先 stop 或换端口）` };
  const backend = String(args.backend || '');
  const script = join(HERE, 'serve-child.mjs');
  mkdirSync(STATE_DIR, { recursive: true });
  const logFile = join(STATE_DIR, `preview-${port}.log`);
  const fd = openSync(logFile, 'a');
  const child = spawn(process.execPath, [script, '--file', file, '--port', String(port), ...(backend ? ['--backend', backend] : [])], {
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  closeSync(fd);
  const up = await waitPort(port, 5000);
  if (!up) {
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* 已退出 */ }
    return { ok: false, error: `5s 内未就绪（port=${port}，日志 ${logFile}）` };
  }
  const rec = { pid: child.pid, port, file, backend: backend || '', startedAt: new Date().toISOString(), log: logFile };
  state.push(rec);
  writeState(state);
  return { ok: true, ...rec, url: `http://127.0.0.1:${port}/` };
}

/** 停止：按 port 或 file 匹配。 */
export function stopPreview(args = {}) {
  prune();
  const state = readState();
  const port = Number(args.port) || 0;
  const file = args.file ? resolve(String(args.file)) : '';
  const hits = state.filter((it) => (port ? it.port === port : true) && (file ? it.file === file : true));
  if (!hits.length) return { ok: false, error: '台账中没有匹配的预览服务' };
  for (const it of hits) {
    try { process.kill(it.pid, 'SIGTERM'); } catch { /* 已退出 */ }
  }
  writeState(state.filter((it) => !hits.includes(it)));
  return { ok: true, stopped: hits.map((it) => ({ port: it.port, pid: it.pid, file: it.file })) };
}

/** 台账快照。 */
export function listPreview() {
  return prune();
}

/** 端口探活（TCP 短连接）。 */
function waitPort(port, timeoutMs) {
  return new Promise((res) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/', method: 'GET', timeout: 800 }, (rsp) => { rsp.resume(); res(true); });
      req.on('error', () => {
        if (Date.now() > deadline) res(false);
        else setTimeout(tick, 250);
      });
      req.on('timeout', () => { req.destroy(); });
      req.end();
    };
    tick();
  });
}

export { MIME, STATE_FILE };
