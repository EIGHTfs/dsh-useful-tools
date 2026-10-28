/**
 * git 层：把「GitHub 地址」重写到代理
 *
 * ## 为什么是 git 层
 * DSH 从 GitHub 装插件走的是 `pnpm add <git spec>`（`plugin-manager` 把 `github:owner/repo`
 * 与仓库 URL 判为 `kind: 'git'`，由 pnpm 调用 git clone）。**这条链路不经过 npm 源**，
 * 所以界面上的「安装源」下拉（默认源/官方源/镜像源/自定义）只管 npm 包，对 GitHub 插件无效。
 * pnpm 的父环境还是清洗过的（`scrubbedParentEnv`，剔除敏感键与 `DSH_*`），环境变量注入也不可靠；
 * 但 HOME 会保留，因此 `~/.gitconfig` 是唯一稳定的落点。
 *
 * ## 做法
 * 写全局 git 配置：
 *     git config --global url."<代理><源站>/".insteadOf "<源站>/"
 * 之后任何 `git clone https://github.com/...` 都会无感改走代理，原始地址不用改。
 * 只碰这一种键：清理由本工具写入的、指向 github.com 等的 insteadOf 规则，
 * 不动用户其它 git 配置（user/token/proxy 等）。
 */
import { execFile } from 'node:child_process';

/** 探测超时（秒级；git 自身没有 -t，用 process 超时兜住）。 */
export const PROBE_TIMEOUT_MS = 12000;
/** 探测用的公开仓库（只取 HEAD，不下载内容）。 */
export const PROBE_REPO = 'https://github.com/git/git.git';

/** 跑一条命令，返回 {code, stdout, stderr, timedOut}（永不抛）。 */
function run(cmd, args, { timeoutMs = PROBE_TIMEOUT_MS, env } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    let child;
    try {
      child = execFile(cmd, args, { timeout: timeoutMs, env: env ?? process.env, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        const code = error?.code;
        finish({
          code: typeof code === 'number' ? code : (error ? 1 : 0),
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          timedOut: error?.killed === true || error?.signal === 'SIGTERM',
          spawnError: error?.code === 'ENOENT' ? 'git 不可用（PATH 里找不到 git）' : null,
        });
      });
    } catch (e) {
      finish({ code: 1, stdout: '', stderr: String((e && e.message) || e), timedOut: false, spawnError: String((e && e.message) || e) });
      return;
    }
    child.on?.('error', (e) => finish({ code: 1, stdout: '', stderr: String((e && e.message) || e), timedOut: false, spawnError: String((e && e.message) || e) }));
  });
}

/**
 * 读当前全局 insteadOf 规则。
 * @returns {Promise<{ok:boolean, rules: Array<{key:string, base:string, insteadOf:string}>, error?:string}>}
 */
export async function readInsteadOfRules() {
  const r = await run('git', ['config', '--global', '--get-regexp', '^url\\..*\\.insteadof$']);
  // 没有匹配时 git 返回 1：视为「没有任何规则」，不是错误
  if (r.spawnError) return { ok: false, rules: [], error: r.spawnError };
  if (r.code !== 0 && !r.stdout.trim()) return { ok: true, rules: [] };
  const rules = [];
  for (const line of r.stdout.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    const match = /^(url\..*\.insteadof)\s+(.*)$/i.exec(text);
    if (!match) continue;
    const key = match[1];
    const insteadOf = match[2].trim();
    const base = key.replace(/^url\./i, '').replace(/\.insteadof$/i, '');
    rules.push({ key, base, insteadOf });
  }
  return { ok: true, rules };
}

/**
 * 源站的完整 URL（带协议）。
 *
 * insteadOf 的值必须是带协议的完整前缀：git 按**字符串前缀**匹配目标 URL，
 * 写成 `github.com/` 匹配不到 `https://github.com/...`，重写不会生效（表现为直连超时）。
 */
export function hostUrl(host) {
  return `https://${String(host).replace(/^https?:\/\//i, '').replace(/\/$/, '')}/`;
}

/** 代理前缀是否已经覆盖某个源站（用于幂等判断）。 */
export function ruleCovers(rules, mirror, host) {
  const wantBase = `${String(mirror)}${hostUrl(host)}`;
  return (Array.isArray(rules) ? rules : []).some((r) => r.base === wantBase && r.insteadOf === hostUrl(host));
}

/**
 * 写入一条重写规则（已存在则先删再加，保证幂等）。
 * @returns {Promise<{ok:boolean, changed:boolean, error?:string}>}
 */
export async function applyInsteadOf(mirror, host) {
  const insteadOf = hostUrl(host);
  const base = `${mirror}${insteadOf}`;
  // --replace-all：同键多次赋值时直接替换，避免越积越多
  const r = await run('git', ['config', '--global', '--replace-all', `url.${base}.insteadOf`, insteadOf]);
  if (r.spawnError) return { ok: false, changed: false, error: r.spawnError };
  if (r.code !== 0) return { ok: false, changed: false, error: r.stderr.trim() || `git config 退出码 ${r.code}` };
  return { ok: true, changed: true };
}

/**
 * 删除一条重写规则（先尝试精确键，再按 base 前缀兜底删除残留）。
 * @returns {Promise<{ok:boolean, removed:number, error?:string}>}
 */
export async function removeInsteadOf(baseRuleKey) {
  const r = await run('git', ['config', '--global', '--unset-all', baseRuleKey]);
  if (r.spawnError) return { ok: false, removed: 0, error: r.spawnError };
  // 该键不存在时 git 返回 5（多值键不存在）或 1：都视为「已没有这条规则」
  if (r.code === 0) return { ok: true, removed: 1 };
  if (r.code === 5 || r.code === 1) return { ok: true, removed: 0 };
  return { ok: false, removed: 0, error: r.stderr.trim() || `git config 退出码 ${r.code}` };
}

/**
 * 探测一个代理是否真的能用于 git。
 * 判据：`git ls-remote <代理><github/…> HEAD` 能拿到一行哈希。
 * @param {string} mirror 归一化后的代理前缀（以 / 结尾）
 * @returns {Promise<{ok:boolean, ms:number, head?:string, error?:string}>}
 */
export async function probeMirror(mirror, { host = 'github.com', timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const url = `${mirror}https://${host}/git/git.git`;
  const startedAt = Date.now();
  const r = await run('git', ['ls-remote', url, 'HEAD'], { timeoutMs });
  const ms = Date.now() - startedAt;
  if (r.spawnError) return { ok: false, ms, error: r.spawnError };
  const head = r.stdout.split('\n').map((l) => l.trim()).find((l) => /^[0-9a-f]{7,}\s+HEAD$/i.test(l));
  if (r.timedOut) return { ok: false, ms, error: `探测超时（>${Math.round(timeoutMs / 1000)}s）` };
  if (!head) {
    const detail = (r.stderr.trim() || r.stdout.trim() || '').split('\n').slice(0, 2).join(' ').slice(0, 200);
    return { ok: false, ms, error: detail || `无 HEAD 输出（退出码 ${r.code}）` };
  }
  return { ok: true, ms, head };
}

/** 探测直连是否可用（用于给「其实能直连，不用代理」的建议）。 */
export async function probeDirect(timeoutMs = PROBE_TIMEOUT_MS) {
  const startedAt = Date.now();
  const r = await run('git', ['ls-remote', PROBE_REPO, 'HEAD'], { timeoutMs });
  const ms = Date.now() - startedAt;
  const head = r.stdout.split('\n').map((l) => l.trim()).find((l) => /^[0-9a-f]{7,}\s+HEAD$/i.test(l));
  if (r.spawnError) return { ok: false, ms, error: r.spawnError };
  if (r.timedOut) return { ok: false, ms, error: `直连探测超时（>${Math.round(timeoutMs / 1000)}s）` };
  if (!head) return { ok: false, ms, error: (r.stderr.trim().split('\n')[0] || `退出码 ${r.code}`).slice(0, 200) };
  return { ok: true, ms, head };
}
