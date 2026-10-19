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
const MINIHOST_STATE_DIR = join(HERE, '..', '..', '..', '.minihost');
const MINIHOST_STATE_FILE = join(MINIHOST_STATE_DIR, 'instances.json');
/** 自动端口段：31101–31199（按插件名哈希落点，避免固定端口冲突）。 */
const AUTO_PORT_BASE = 31101;
const AUTO_PORT_SPAN = 99;
/** 启动后等 listen 就绪的上限毫秒（就绪即返回，超时回收子进程）。 */
const READY_TIMEOUT_MS = 5000;
/** 就绪探活轮询间隔毫秒。 */
const READY_POLL_INTERVAL_MS = 400;

function readState() {
  try { return JSON.parse(readFileSync(MINIHOST_STATE_FILE, 'utf8')); } catch { return []; }
}
function writeState(list) {
  mkdirSync(MINIHOST_STATE_DIR, { recursive: true });
  writeFileSync(MINIHOST_STATE_FILE, JSON.stringify(list, null, 2), 'utf8');
}
/** 探活：进程是否还在。 */
function alive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}
/** 清理台账里已死掉的实例（返回清理条数）。 */
function pruneState() {
  const all = readState();
  const aliveList = all.filter((it) => alive(it.pid));
  if (aliveList.length !== all.length) writeState(aliveList);
  return all.length - aliveList.length;
}

/** 默认端口：按插件名哈希到 31101–31199，避免固定端口冲突。 */
export function defaultPortFor(pluginPath) {
  const name = String(pluginPath || '').split('/').filter(Boolean).pop() || 'plugin';
  let hashValue = 0;
  for (const char of name) hashValue = (hashValue * 31 + char.charCodeAt(0)) >>> 0;
  return AUTO_PORT_BASE + (hashValue % AUTO_PORT_SPAN);
}

/** 启动 mini 宿主（守护化：detached + 后台日志落 .minihost/）。 */
export async function minihostStart(args = {}) {
  pruneState();
  const plugin = resolve(String(args.plugin || ''));
  if (!plugin || !existsSync(join(plugin, 'package.json'))) {
    return { ok: false, error: 'plugin 参数必须是含 package.json 的插件项目根' };
  }
  const port = Number(args.port) || defaultPortFor(plugin);
  const wantedServices = args.services ? resolve(String(args.services)) : '';
  let state = readState();
  const existing = state.find((it) => it.plugin === plugin && alive(it.pid));
  if (existing) {
    // 参数变化必须说清楚：旧实现直接 already:true 返回旧实例，调用方会以为用的是新参数
    //   （实测踩坑：第二次带 services 启动被复用了无 services 的旧实例，白测一轮）。
    const changes = [];
    if (args.port && Number(args.port) !== existing.port) changes.push(`端口：请求 ${args.port}，现有 ${existing.port}`);
    if (wantedServices && wantedServices !== (existing.services || '')) {
      changes.push(`services：请求 ${wantedServices}，现有 ${existing.services || '（无）'}`);
    }
    if (args.force === true) {
      // force：先停旧实例，再按新参数重新启动
      await minihostStop({ port: existing.port });
      state = readState();
    } else if (changes.length) {
      return {
        ok: true,
        already: true,
        ...existing,
        hint: `已存在实例（port=${existing.port}${existing.services ? `，services=${existing.services}` : '，无 services'}）：${changes.join('；')}。要按新参数启动请先 stop，或传 force:true 自动重启`,
      };
    } else {
      return { ok: true, already: true, ...existing };
    }
  }
  const portBusy = state.find((it) => it.port === port && alive(it.pid));
  if (portBusy) return { ok: false, error: `端口 ${port} 已被 ${portBusy.plugin} 占用（换 --port 或先 stop）` };
  const logFile = join(MINIHOST_STATE_DIR, `minihost-${port}.log`);
  mkdirSync(MINIHOST_STATE_DIR, { recursive: true });
  const logFd = openSync(logFile, 'a');
  // 可选宿主服务注入模块：插件依赖真实服务（storageDomain / sessions 等）时，子进程会动态 import 它
  const spawnArgs = [MINIHOST_SCRIPT, '--plugin', plugin, '--port', String(port)];
  if (args.services) spawnArgs.push('--services', resolve(String(args.services)));
  const child = spawn(process.execPath, spawnArgs, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    cwd: plugin,
  });
  child.unref();
  closeSync(logFd);
  const rec = { pid: child.pid, plugin, port, services: wantedServices, startedAt: new Date().toISOString(), log: logFile };
  // 等 listen 就绪（最多 5s；就绪即返回，失败则回收）。
  // 探活 = 发 GET /：无 preview 页时 404 也算就绪（reachable=true 即服务在）。
  const up = await new Promise((res) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearInterval(iv); clearTimeout(t); res(v); } };
    const t = setTimeout(() => finish(false), READY_TIMEOUT_MS);
    const iv = setInterval(() => {
      minihostCall({ port, path: '/' }).then((r) => { if (r.reachable) finish(true); }).catch(() => { /* 未就绪继续探 */ });
    }, READY_POLL_INTERVAL_MS);
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
      let responseBody = '';
      rsp.on('data', (chunk) => { responseBody += chunk; });
      rsp.on('end', () => {
        const out = { reachable: true, status: rsp.statusCode, contentType: rsp.headers['content-type'] || '', body: responseBody.slice(0, Number(args.maxBody) || 4000) };
        // 404 是「路由没注册」的典型症状，给出最常见原因，避免只看到一个状态码
        if (rsp.statusCode === 404) {
          out.hint = '404：插件没有注册该路径。常见原因：插件用 ctx.get("webServer") 守卫降级（minihost 内置了 webServer 桩，但若插件在 apply 早期就 return 就不会注册）；或路径/方法不对';
        }
        res(out);
      });
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

/** mini 宿主的四个动作定义（name/description/parameters/run）。 */
function minihostToolSpecs() {
  return [
    {
      name: 'tool_minihost_start',
      description: '启动某 DSH 插件的 mini 宿主（本地跑服务端代码，改码即生效，无需重启宿主）。参数：plugin=插件项目根；port 可省（按插件名自动分配）。注意：工具参数定义在实例加载期注册——更新本插件后需重载实例才认新参数。',
      parameters: { type: 'object', properties: { plugin: { type: 'string', description: '插件项目根（含 package.json）' }, port: { type: 'number', description: '端口（缺省按插件名哈希分配 31101-31199）' }, services: { type: 'string', description: '宿主服务注入模块路径（默认导出服务对象或返回它的函数）' }, force: { type: 'boolean', description: 'true = 已有实例时按新参数重启（先 stop 再 start）；缺省复用旧实例并提示参数差异' } } },
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
}

/** 把单个动作定义注册进宿主 tools 服务（注册失败只记日志，不影响其余动作）。 */
function registerOneSpec(registry, defineTool, toolDef, log) {
  const spec = {
    name: toolDef.name, description: toolDef.description, parameters: toolDef.parameters,
    output: { schema: { type: 'string' }, render: (v) => [{ type: 'text', text: String(v) }] },
    async execute(args) { return JSON.stringify(await toolDef.run(args)); },
  };
  try { registry.register(defineTool ? defineTool(spec) : spec); } catch (e) { log?.warn?.(`dsh-useful-tools: ${toolDef.name} 注册失败: ${(e && e.message) || e}`); }
}

/** 注册全部 mini 宿主工具。 */
function mountMinihostTools(ctx, log) {
  try {
    ctx.inject(['tools'], (tc) => {
      const registry = tc?.get?.('tools');
      if (!registry?.register) { log?.warn?.('dsh-useful-tools: tools 服务不可用，minihost 工具未注册'); return; }
      for (const toolDef of minihostToolSpecs()) registerOneSpec(registry, registry.defineTool, toolDef, log);
    });
  } catch (e) { log?.warn?.(`dsh-useful-tools: minihost 工具注册失败: ${(e && e.message) || e}`); }
}

/** /minihost 指令处理（start / call / stop / list）。 */
async function dispatchMinihostCommand(input) {
  const tokens = String(input ?? '').trim().split(/\s+/).filter(Boolean);
  const sub = (tokens.shift() || 'list').toLowerCase();
  let actionResult;
  if (sub === 'start') actionResult = await minihostStart({ plugin: tokens[0], port: Number(tokens[1]) || undefined });
  else if (sub === 'call') actionResult = await minihostCall({ port: Number(tokens[0]), path: tokens[1] || '/' });
  else if (sub === 'stop') actionResult = await minihostStop(/^\d+$/.test(tokens[0] || '') ? { port: Number(tokens[0]) } : { plugin: tokens[0] });
  else actionResult = { ok: true, instances: minihostList() };
  return { kind: actionResult.ok ? 'success' : 'error', text: JSON.stringify(actionResult) };
}

/** 注册到宿主：四个工具 + /minihost 指令。 */
export function registerMinihostTools(ctx, { log } = {}) {
  mountMinihostTools(ctx, log);

  try {
    ctx.inject(['commands'], (cc) => {
      const registry = cc?.commands || cc?.get?.('commands');
      if (!registry?.register) return;
      registry.register({
        name: 'minihost',
        description: 'mini 宿主管理：start <插件根> [端口] · call <端口> <路径> · stop <插件根|端口> · list',
        input: { type: 'string' },
        handler: dispatchMinihostCommand,
      });
    });
  } catch (e) { log?.warn?.(`dsh-useful-tools: /minihost 注册失败: ${(e && e.message) || e}`); }
}
