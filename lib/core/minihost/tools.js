/**
 * minihost 工具封装：把 ../minihost/host.mjs 的能力暴露成 toolcall 与斜杠命令。
 *
 * 进程模型（与 minihost 脚本一致）：
 *   minihost_start  守护化启动 mini 宿主（--plugin 指向插件根；pid 台账记录 pid/port/plugin）
 *   minihost_call   向已启动的 mini 宿主发本地 HTTP 请求（每请求子进程 ⇒ 改码即生效）
 *   minihost_stop   按插件名/端口停止（SIGTERM，台账清账）
 *   /minihost       指令形态（start|call|stop 子命令；结果只给 UI，不进模型历史）
 *
 * 脚本自定位：以本文件位置推导 assets/ 目录（package.json 同级）⇒ 零环境变量、零探测链；
 *   唯一权威 = dsh-useful-tools/assets/（其他插件删除自持壳后统一走本工具）。
 *
 * 台账：<插件数据目录>/minihost-instances.json（插件根/.minihost/）；宕机残留的 pid 在
 *   start/call 时自动探测清理（kill(pid,0) 探活）。
 */
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** minihost 主脚本绝对路径（唯一权威：本插件 assets/）。 */
export const MINIHOST_SCRIPT = join(HERE, '..', 'minihost', 'host.mjs');
/** 台账位置（插件根/.minihost/instances.json）。 */
const STATE_DIR = join(HERE, '..', '..', '..', '.minihost');
const STATE_FILE = join(STATE_DIR, 'instances.json');

function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return []; }
}
function writeState(list) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(list, null, 2), 'utf8');
}
/** 探活：进程是否还在。 */
function alive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}
/** 清理台账里已死掉的实例（返回清理条数）。 */
function pruneState() {
  const list = readState().filter((it) => alive(it.pid));
  const before = readState().length;
  if (list.length !== before) writeState(list);
  return before - list.length;
}

/** 默认端口：按插件名哈希到 31101–31199，避免固定端口冲突。 */
export function defaultPortFor(pluginPath) {
  const name = String(pluginPath || '').split('/').filter(Boolean).pop() || 'plugin';
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 31101 + (h % 99);
}

/** 启动 mini 宿主（守护化：detached + 后台日志落 .minihost/）。 */
export async function minihostStart(args = {}) {
  pruneState();
  const plugin = resolve(String(args.plugin || ''));
  if (!plugin || !existsSync(join(plugin, 'package.json'))) {
    return { ok: false, error: 'plugin 参数必须是含 package.json 的插件项目根' };
  }
  const port = Number(args.port) || defaultPortFor(plugin);
  const state = readState();
  const existing = state.find((it) => it.plugin === plugin && alive(it.pid));
  if (existing) return { ok: true, already: true, ...existing };
  const portBusy = state.find((it) => it.port === port && alive(it.pid));
  if (portBusy) return { ok: false, error: `端口 ${port} 已被 ${portBusy.plugin} 占用（换 --port 或先 stop）` };
  const logFile = join(STATE_DIR, `minihost-${port}.log`);
  mkdirSync(STATE_DIR, { recursive: true });
  const logFd = openSync(logFile, 'a');
  const child = spawn(process.execPath, [MINIHOST_SCRIPT, '--plugin', plugin, '--port', String(port)], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    cwd: plugin,
  });
  child.unref();
  closeSync(logFd);
  const rec = { pid: child.pid, plugin, port, startedAt: new Date().toISOString(), log: logFile };
  // 等 listen 就绪（最多 5s；就绪即返回，失败则回收）。
  // 探活 = 发 GET /：无 preview 页时 404 也算就绪（reachable=true 即服务在）。
  const up = await new Promise((res) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearInterval(iv); clearTimeout(t); res(v); } };
    const t = setTimeout(() => finish(false), 5000);
    const iv = setInterval(() => {
      minihostCall({ port, path: '/' }).then((r) => { if (r.reachable) finish(true); }).catch(() => { /* 未就绪继续探 */ });
    }, 400);
  });
  if (!up) {
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* 已退出 */ }
    return { ok: false, error: `mini 宿主 5s 内未就绪（port=${port}，日志 ${logFile}）` };
  }
  state.push(rec);
  writeState(state);
  return { ok: true, ...rec };
}

/** 向 mini 宿主发本地请求。 */
export function minihostCall(args = {}) {
  const port = Number(args.port) || 0;
  const path = String(args.path || '/');
  const method = String(args.method || 'GET').toUpperCase();
  const body = args.body == null ? null : (typeof args.body === 'string' ? args.body : JSON.stringify(args.body));
  return new Promise((res) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}, timeout: Number(args.timeoutMs) || 15000 }, (rsp) => {
      let data = '';
      rsp.on('data', (d) => { data += d; });
      rsp.on('end', () => res({ reachable: true, status: rsp.statusCode, contentType: rsp.headers['content-type'] || '', body: data.slice(0, Number(args.maxBody) || 4000) }));
    });
    req.on('timeout', () => { req.destroy(); res({ reachable: false, error: '请求超时' }); });
    req.on('error', (e) => res({ reachable: false, error: String((e && e.message) || e) }));
    if (body) req.write(body);
    req.end();
  });
}

/** 停止：按 plugin 或 port 匹配台账实例，SIGTERM。 */
export async function minihostStop(args = {}) {
  pruneState();
  const state = readState();
  const plugin = args.plugin ? resolve(String(args.plugin)) : '';
  const port = Number(args.port) || 0;
  const hits = state.filter((it) => (plugin ? it.plugin === plugin : true) && (port ? it.port === port : true));
  if (!hits.length) return { ok: false, error: '台账中没有匹配的实例（可能已停止）' };
  for (const it of hits) {
    try { process.kill(it.pid, 'SIGTERM'); } catch { /* 已退出 */ }
  }
  writeState(state.filter((it) => !hits.includes(it)));
  return { ok: true, stopped: hits.map((it) => ({ plugin: it.plugin, port: it.port, pid: it.pid })) };
}

/** 台账快照（供工具 list）。 */
export function minihostList() {
  pruneState();
  return readState();
}

/** 注册到宿主：三个工具 + /minihost 指令。 */
export function registerMinihostTools(ctx, { log } = {}) {
  const tools = [
    {
      name: 'tool_minihost_start',
      description: '启动某 DSH 插件的 mini 宿主（本地跑服务端代码，改码即生效，无需重启宿主）。参数：plugin=插件项目根；port 可省（按插件名自动分配）。',
      parameters: { type: 'object', properties: { plugin: { type: 'string', description: '插件项目根（含 package.json）' }, port: { type: 'number', description: '端口（缺省按插件名哈希分配 31101-31199）' } } },
      run: (a) => minihostStart(a),
    },
    {
      name: 'tool_minihost_call',
      description: '向已启动的 mini 宿主发本地 HTTP 请求（等价 curl 127.0.0.1，但零凭据暴露）。参数：port、path、method、body。',
      parameters: { type: 'object', properties: { port: { type: 'number', description: 'mini 宿主端口' }, path: { type: 'string', description: '请求路径（如 /api/xxx）' }, method: { type: 'string', description: 'GET（默认）/POST/…' }, body: { type: 'string', description: '请求体（JSON 字符串）' } } },
      run: (a) => minihostCall(a),
    },
    {
      name: 'tool_minihost_stop',
      description: '停止 mini 宿主。参数：plugin（插件根）或 port（二选一）。',
      parameters: { type: 'object', properties: { plugin: { type: 'string', description: '插件项目根' }, port: { type: 'number', description: '端口' } } },
      run: (a) => minihostStop(a),
    },
    {
      name: 'tool_minihost_list',
      description: '列出当前存活的 mini 宿主实例（pid/port/plugin/启动时间）。',
      parameters: { type: 'object', properties: {} },
      run: async () => ({ ok: true, instances: minihostList() }),
    },
  ];
  try {
    ctx.inject(['tools'], (tc) => {
      const registry = tc?.get?.('tools');
      if (!registry?.register) { log?.warn?.('dsh-useful-tools: tools 服务不可用，minihost 工具未注册'); return; }
      const defineTool = registry.defineTool;
      for (const t of tools) {
        const spec = {
          name: t.name, description: t.description, parameters: t.parameters,
          output: { schema: { type: 'string' }, render: (v) => [{ type: 'text', text: String(v) }] },
          async execute(args) { return JSON.stringify(await t.run(args)); },
        };
        try { registry.register(defineTool ? defineTool(spec) : spec); } catch (e) { log?.warn?.(`dsh-useful-tools: ${t.name} 注册失败: ${(e && e.message) || e}`); }
      }
    });
  } catch (e) { log?.warn?.(`dsh-useful-tools: minihost 工具注册失败: ${(e && e.message) || e}`); }

  try {
    ctx.inject(['commands'], (cc) => {
      const registry = cc?.commands || cc?.get?.('commands');
      if (!registry?.register) return;
      registry.register({
        name: 'minihost',
        description: 'mini 宿主管理：start <插件根> [端口] · call <端口> <路径> · stop <插件根|端口> · list',
        input: { type: 'string' },
        handler: async (input) => {
          const tokens = String(input ?? '').trim().split(/\s+/).filter(Boolean);
          const sub = (tokens.shift() || 'list').toLowerCase();
          let r;
          if (sub === 'start') r = await minihostStart({ plugin: tokens[0], port: Number(tokens[1]) || undefined });
          else if (sub === 'call') r = await minihostCall({ port: Number(tokens[0]), path: tokens[1] || '/' });
          else if (sub === 'stop') r = await minihostStop(/^\d+$/.test(tokens[0] || '') ? { port: Number(tokens[0]) } : { plugin: tokens[0] });
          else r = { ok: true, instances: minihostList() };
          return { kind: r.ok ? 'success' : 'error', text: JSON.stringify(r) };
        },
      });
    });
  } catch (e) { log?.warn?.(`dsh-useful-tools: /minihost 注册失败: ${(e && e.message) || e}`); }
}
