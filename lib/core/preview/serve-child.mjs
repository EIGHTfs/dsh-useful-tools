/**
 * 预览静态服务子进程（由 server.js 派生，不直接对外）。
 * 参数：--file <preview.html> --port <n> [--backend http://host:port] [--host 监听地址]
 * 行为：/ 返回预览页；/api/* 若给了 backend 则反代过去；其余路径按相对 preview.html 的目录取静态文件。
 */
import { createServer, request as httpRequest } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';

function argOf(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const FILE = resolve(argOf('--file', ''));
const PORT = Number(argOf('--port', '31188'));
const BACKEND = argOf('--backend', '');
// 监听地址：默认仅本机；传 0.0.0.0 供局域网访问
const HOST = argOf('--host', '127.0.0.1');
const ROOT = dirname(FILE);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
};

if (!FILE || !existsSync(FILE)) {
  console.error(`preview 文件不存在：${FILE}`);
  process.exit(2);
}

/** 反代到真实后端（保留方法/头/体）。 */
function proxy(req, res) {
  const u = new URL(BACKEND);
  const out = httpRequest({ host: u.hostname, port: u.port || 80, path: req.url, method: req.method, headers: { ...req.headers, host: u.host } }, (rsp) => {
    res.writeHead(rsp.statusCode || 502, rsp.headers);
    rsp.pipe(res);
  });
  out.on('error', (e) => { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: String(e.message || e) })); });
  req.pipe(out);
}

const previewServer = createServer((req, res) => {
  const url = req.url || '/';
  if (BACKEND && url.startsWith('/api/')) return proxy(req, res);
  const clean = normalize(decodeURIComponent(url.split('?')[0])).replace(/^([/\\])+/, '');
  let target = clean === '' ? FILE : join(ROOT, clean);
  if (!existsSync(target) || statSync(target).isDirectory()) target = FILE;
  const ext = extname(target).toLowerCase();
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(target).pipe(res);
});

previewServer.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? '0.0.0.0（局域网可访问）' : HOST;
  console.log(`[preview] ${FILE} → http://${HOST}:${PORT}/（监听 ${shown}） ${BACKEND ? `(proxy /api → ${BACKEND})` : '(mock 模式：不带 backend)'}`);
});
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => previewServer.close(() => process.exit(0)));
