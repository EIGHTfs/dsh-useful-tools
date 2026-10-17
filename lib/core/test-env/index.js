/**
 * 测试环境（隔离实例）管理：创建 / 启动 / 停止 / 状态，全部走一个工具的动作参数。
 *
 * 逻辑来源：dsh-git-rescue 的 rescue-env（@Save-clean / @Save-test 那套）——
 *   只取「测试环境」这一条主线，不搬救援插件自身的复制与锁定逻辑。
 *
 * 目录形态（与救援环境一致，便于两者共用同一套路径约定）：
 *   <root>/<dsh版本>@Save-test/          ← 环境根（DSH_HOME 指这里）
 *     ├─ profiles/web/{cordis.yml,package.json,cordis.patch.yml,node_modules_local}
 *     ├─ sessions/ storages/ skills/
 *     └─ .dsh-env-port                   ← 启动后写端口，供 stop/status 探活
 *
 * 设计约束：
 *   · 零依赖：只用 node 内置模块；
 *   · 不写死路径：root / 版本 / 端口全部探测或参数传入；
 *   · 幂等：create 已存在且未 force 时直接返回 existed，start 已在跑时返回 already。
 */
import { promises as fs } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';

const READY_WAIT_MS = 40_000;
const POLL_INTERVAL_MS = 1000;
const PORT_MIN = 3083;
const PORT_MAX = 3182;
// 插件自己的数据文件（与工具配置同处）：<DSH_HOME>/useful-tools/config.json
const CONFIG_REL = 'useful-tools/config.json';

/** 读插件配置（容错：文件不存在/坏 JSON 都返回空对象）。 */
export function readPluginConfig() {
  const home = String(process.env.DSH_HOME || '').trim();
  if (!home) return {};
  try {
    const p = join(home, CONFIG_REL);
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, 'utf8')) || {};
  } catch {
    return {};
  }
}

/** 环境目录名：<版本>@Save-<kind>。 */
export function envName(version = 'unknown', kind = 'test') {
  return `${version || 'unknown'}@Save-${kind === 'clean' ? 'clean' : 'test'}`;
}

/**
 * 环境根：显式 root > DSH_TEST_ENV_ROOT > 插件配置 testEnvRoot > 推算（DSH_WORKSPACE / DSH_HOME 上一级「工作区」/ ~/工作区）。
 * 为什么配置优先于推算：部署方可以把测试环境固定在指定位置（如挂载盘），不必改代码、也不依赖启动环境变量。
 */
export function envRoot(explicit = '') {
  if (explicit) return resolve(explicit);
  const env = String(process.env.DSH_TEST_ENV_ROOT || '').trim();
  if (env) return resolve(env);
  const cfg = readPluginConfig();
  if (cfg.testEnvRoot) return resolve(String(cfg.testEnvRoot));
  return process.env.DSH_WORKSPACE
    || (process.env.DSH_HOME ? join(process.env.DSH_HOME, '..', '工作区') : '')
    || join(process.env.HOME || '', '工作区');
}

/**
 * 探测 DSH 版本：DSH_VERSION 环境变量优先；否则取 DSH_HOME 上一级目录名
 * （本机布局形如 …/0.2.1-alpha.2/.dsh，父目录名就是版本）。
 */
export function detectDshVersion() {
  const v = String(process.env.DSH_VERSION || '').trim();
  if (v) return v;
  const home = String(process.env.DSH_HOME || '').trim();
  if (home) {
    const parent = String(dirname(home).split(/[\\/]/).pop() || '');
    if (/^\d+\.\d+/.test(parent)) return parent;
  }
  return 'unknown';
}

/** 读环境端口文件。 */
async function readPort(dir) {
  try {
    const raw = await fs.readFile(join(dir, '.dsh-env-port'), 'utf8');
    const port = Number(String(raw).trim());
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/** 环境是否在跑：端口文件 + HTTP 探活。
 *  ⚠️ 不能要求 2xx：DSH 根路径要 token，未认证时返回 401/302——那同样是「服务已在跑」。
 *  只有连接层失败（拒绝/超时）才算没起来。 */
export async function isEnvRunning(dir = '') {
  const port = await readPort(dir);
  if (!port) return false;
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000), redirect: 'manual' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 写环境骨架（profile 最小集）。pluginSrc 给了就把该插件复制进 profiles/web/node_modules
 * 并注册到 bundle 列表——DSH 解析 bundle 找的就是 profile 的 node_modules，复制到别处会解析不到。
 * 不复制 .git / node_modules —— 环境要轻，且这两个目录与运行无关。
 */
async function writeBaseline(dir, { lock = false, pluginSrc = '', pluginName = '' } = {}) {
  for (const sub of ['profiles/web/node_modules', 'sessions', 'storages', 'skills']) {
    await fs.mkdir(join(dir, sub), { recursive: true });
  }
  await fs.writeFile(join(dir, 'profiles/web/cordis.yml'),
    '# dsh profile root — an empty entry list. The tree is composed as patches:\n', 'utf8');
  const dep = pluginSrc && pluginName ? { [pluginName]: `file:./node_modules/${pluginName}` } : {};
  const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...(pluginSrc && pluginName ? [pluginName] : [])];
  await fs.writeFile(join(dir, 'profiles/web/package.json'),
    JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: dep, dsh: { profile: { bundles } } }, null, 2) + '\n', 'utf8');
  if (lock) {
    await fs.writeFile(join(dir, '.dsh-env-lock'), `clean-env-lock v1\ncreated: ${new Date().toISOString()}\n`, 'utf8');
  }
  if (pluginSrc && pluginName) {
    const target = join(dir, 'profiles/web/node_modules', pluginName);
    await fs.mkdir(target, { recursive: true });
    await fs.cp(pluginSrc, target, {
      recursive: true,
      filter: (src) => !src.includes('/.git') && !src.includes('/node_modules'),
    });
    await fs.writeFile(join(dir, 'profiles/web/cordis.patch.yml'),
      `- insert:\n    - id: ${pluginName.replace(/^@[^/]+\//, '')}\n      name: '${pluginName}'\n`, 'utf8');
  } else {
    await fs.writeFile(join(dir, 'profiles/web/cordis.patch.yml'), '[]\n', 'utf8');
  }
}

/**
 * 创建环境（幂等）。
 * @param {{kind?:'test'|'clean', version?:string, root?:string, force?:boolean, pluginSrc?:string, pluginName?:string}} o
 */
export async function createEnv({ kind = 'test', version = '', root = '', force = false, pluginSrc = '', pluginName = '' } = {}) {
  const ver = version || detectDshVersion();
  const base = envRoot(root);
  const name = envName(ver, kind);
  const dir = join(base, name);
  try {
    const exists = await fs.access(dir).then(() => true).catch(() => false);
    if (exists) {
      if (!force) return { ok: true, dir, name, version: ver, existed: true };
      await fs.rm(dir, { recursive: true, force: true });
    }
    await writeBaseline(dir, { lock: kind === 'clean', pluginSrc, pluginName });
    return { ok: true, dir, name, version: ver, existed: false };
  } catch (e) {
    return { ok: false, dir, name, error: String((e && e.message) || e) };
  }
}

/** 找首个空闲端口（3083-3182）。 */
async function findFreePort() {
  const ssOut = await new Promise((res) => {
    execFile('ss', ['-tln'], (err, stdout) => res(err ? '' : String(stdout)));
  });
  for (let p = PORT_MIN; p <= PORT_MAX; p++) {
    if (!ssOut.includes(`:${p} `)) return p;
  }
  return 0;
}

/**
 * 启动环境：没有就先创建；setsid 脱离会话拉起 dsh web，等就绪。
 * @param {{kind?:'test'|'clean', version?:string, root?:string, force?:boolean, pluginSrc?:string, pluginName?:string}} o
 */
export async function startEnv({ kind = 'test', version = '', root = '', force = false, pluginSrc = '', pluginName = '', dshBin: explicitBin = '' } = {}) {
  const created = await createEnv({ kind, version, root, force, pluginSrc, pluginName });
  if (!created.ok) return created;
  const { dir } = created;
  if (await isEnvRunning(dir)) {
    return { ok: true, dir, port: await readPort(dir), already: true, version: created.version };
  }
  const port = await findFreePort();
  if (!port) return { ok: false, dir, error: `无空闲端口（${PORT_MIN}-${PORT_MAX} 全占用）` };
  // 宿主内运行时 process.argv[1] 就是 DSH 入口；脚本/测试环境取不到，可用 dshBin 显式指定
  const dshBin = String(explicitBin || process.argv[1] || '');
  if (!dshBin) return { ok: false, dir, error: '无法解析 DSH 入口（process.argv[1] 为空，可传 dshBin）' };
  // --no-open：无头/服务端环境不该尝试打开浏览器
  const cmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(dshBin)} web --host 127.0.0.1 --port ${port} --no-open`;
  const logFile = join(dir, 'dsh-env.log');
  try {
    const child = spawn('setsid', ['nohup', 'sh', '-c', cmd], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DSH_HOME: dir, DSH_WORKSPACE: envRoot(root) },
    });
    child.stdout?.on('data', (d) => { fs.appendFile(logFile, d).catch(() => {}); });
    child.stderr?.on('data', (d) => { fs.appendFile(logFile, d).catch(() => {}); });
    child.unref();
    await fs.writeFile(join(dir, '.dsh-env-port'), String(port), 'utf8');
    const deadline = Date.now() + READY_WAIT_MS;
    while (Date.now() < deadline) {
      if (await isEnvRunning(dir)) return { ok: true, dir, port, ready: true, version: created.version };
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    return { ok: false, dir, port, ready: false, error: `启动超时（${READY_WAIT_MS}ms 内未就绪，看 ${logFile}）` };
  } catch (e) {
    return { ok: false, dir, port, error: String((e && e.message) || e) };
  }
}

/** 停止环境：按端口记录找进程 SIGTERM（找不到视为已停）。 */
export async function stopEnv({ dir = '' } = {}) {
  if (!dir) return { ok: false, error: '需要 dir（环境目录）' };
  const port = await readPort(dir);
  if (!port) return { ok: true, stopped: false, detail: '无端口记录' };
  try {
    const psOut = await new Promise((res) => {
      execFile('ps', ['aux'], (err, stdout) => res(err ? '' : String(stdout)));
    });
    for (const line of psOut.split('\n')) {
      if (line.includes('bin.js') && line.includes('web') && line.includes(`--port ${port}`)) {
        const pid = Number(line.trim().split(/\s+/)[1]);
        if (pid) process.kill(pid, 'SIGTERM');
        return { ok: true, stopped: true, pid, port };
      }
    }
    return { ok: true, stopped: false, port, detail: '进程未找到（可能已停止）' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 状态汇总：clean / test 两个环境各自的目录、是否运行、端口、是否锁定。 */
export async function envStatus({ root = '', version = '' } = {}) {
  const ver = version || detectDshVersion();
  const base = envRoot(root);
  const out = { version: ver, root: base, test: null, clean: null };
  for (const kind of ['test', 'clean']) {
    const name = envName(ver, kind);
    const dir = join(base, name);
    const exists = await fs.access(dir).then(() => true).catch(() => false);
    out[kind] = {
      name,
      dir,
      exists,
      running: exists ? await isEnvRunning(dir) : false,
      port: exists ? await readPort(dir) : null,
      locked: exists ? await fs.access(join(dir, '.dsh-env-lock')).then(() => true).catch(() => false) : false,
    };
  }
  return out;
}
