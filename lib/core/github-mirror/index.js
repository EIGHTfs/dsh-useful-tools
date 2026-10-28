/**
 * github_mirror 的实现：让 DSH 装 GitHub 插件时走代理
 *
 * ## 背景（已核实）
 * - DSH 从 GitHub 装插件 = `pnpm add <git spec>` → git clone，**不经过 npm 源**；
 *   界面上的「安装源」只管 npm 包，对 GitHub 插件无效。
 * - pnpm 的父环境是清洗过的（`scrubbedParentEnv`，剔除敏感键与 `DSH_*`），环境变量注入不可靠；
 *   HOME 会保留 ⇒ `~/.gitconfig` 是稳定落点。
 * - 因此本工具只做一件事：写/清 `url.<代理><host>/.insteadOf <host>/` 重写规则。
 *
 * ## 行为约定
 * - `mirror` **必须显式传**（不写死任何代理地址）；传了的地址会自动并入候选清单，下次可复用。
 * - 候选清单外置在 `candidates.json`（随仓库入库），记录失败次数；连续失败达阈值自动停用。
 * - `apply` 先探测再写；探测失败自动按清单顺序轮换下一个候选；全都不通则不写入并报错。
 * - `dryRun` 缺省 **true**：只报计划，要真改必须显式传 false。
 */
import {
  mergeCandidate,
  normalizeHosts,
  normalizeMirror,
  readCandidates,
  recordProbe,
  usableCandidates,
  writeCandidates,
  MAX_FAILURES,
} from './store.js';
import {
  applyInsteadOf,
  hostUrl,
  probeDirect,
  probeMirror,
  readInsteadOfRules,
  removeInsteadOf,
  ruleCovers,
} from './git.js';

/** 本工具管理的源站集合（清理时只删这些，不动用户其它 insteadOf）。 */
export const MANAGED_HOSTS = ['github.com'];

/** 解析布尔入参（工具参数可能是字符串）。 */
function asBool(v, fallback) {
  if (v === true || v === 'true' || v === 1 || v === '1') return true;
  if (v === false || v === 'false' || v === 0 || v === '0') return false;
  return fallback;
}

/** 当前生效规则里、属于本工具管理范围的条目。 */
function managedRules(rules) {
  // 按后缀匹配 insteadOf 值：既认正确的 https://<host>/，也认早期误写的裸主机 <host>/，
  // 否则 clear 清不掉历史残留规则。
  return (Array.isArray(rules) ? rules : []).filter((r) => MANAGED_HOSTS.some((h) => {
    const value = String(r.insteadOf || '').replace(/\/$/, '');
    return value === h || value === `https://${h}` || value === `http://${h}`;
  }));
}

/** 把候选清单里「显式传入」的项排到最前（它就是本次首选）。 */
function preferMirror(list, mirror) {
  const wanted = normalizeMirror(mirror);
  const preferred = list.filter((it) => normalizeMirror(it.mirror) === wanted);
  const rest = list.filter((it) => normalizeMirror(it.mirror) !== wanted);
  return [...preferred, ...rest];
}

/** status：当前重写 + 候选清单状态。 */
async function actionStatus(args) {
  const hosts = normalizeHosts(args.hosts);
  const rules = await readInsteadOfRules();
  if (!rules.ok) return { ok: false, action: 'status', error: rules.error };
  const managed = managedRules(rules.rules);
  const list = readCandidates();
  const direct = args.probeDirect === true ? await probeDirect() : undefined;
  return {
    ok: true,
    action: 'status',
    // 生效中的代理（没写就是空 = 直连 GitHub）
    active: managed.length
      ? managed.map((r) => ({ mirror: r.base.replace(/^https?:\/\//, '').replace(/\/$/, ''), insteadOf: r.insteadOf, key: r.key }))
      : [],
    direct: managed.length ? 'off' : 'on',
    hosts,
    managedHosts: MANAGED_HOSTS,
    candidates: list.map((it) => ({
      mirror: it.mirror,
      hosts: it.hosts,
      disabled: it.disabled,
      failures: it.failures,
      lastOkAt: it.lastOkAt,
      lastError: it.lastError,
    })),
    ...(direct ? { directProbe: direct } : {}),
    note: managed.length
      ? 'GitHub 安装当前走代理；pnpm/git 的 clone 会被 insteadOf 重写'
      : '当前没有代理重写：GitHub 安装走直连（若直连不通，请 apply 一个代理）',
    usage: 'apply 需要显式传 mirror，例如 { action: "apply", mirror: "https://ghfast.top/", dryRun: false }',
  };
}

/** apply：探测（失败自动轮换）→ 写入 insteadOf。 */
async function actionApply(args, log) {
  const explicit = normalizeMirror(args.mirror);
  const hosts = normalizeHosts(args.hosts);
  const dryRun = asBool(args.dryRun, true);
  const rotate = asBool(args.rotate, true);

  if (!explicit) {
    return {
      ok: false,
      action: 'apply',
      error: 'mirror 必填：请显式传代理地址（如 { mirror: "https://ghfast.top/" }）。不内置默认值，避免代理站失效后静默写坏配置。',
      candidates: readCandidates().map((it) => it.mirror),
    };
  }

  // ① 候选清单：显式项并入并置顶（学习结果落盘）
  let list = readCandidates();
  const merged = mergeCandidate(list, explicit, hosts);
  list = merged.list;
  if (!dryRun && merged.added) {
    const w = writeCandidates(list);
    if (!w.ok) log?.warn?.(`github_mirror: 候选清单写入失败（已忽略）: ${w.error}`);
  }
  const order = rotate ? preferMirror(usableCandidates(list), explicit) : preferMirror(list.filter((it) => normalizeMirror(it.mirror) === explicit), explicit);

  // ② 逐个探测，取第一个可用的
  const attempts = [];
  let chosen = null;
  for (const candidate of order) {
    const probe = await probeMirror(candidate.mirror, { host: hosts[0] });
    attempts.push({ mirror: candidate.mirror, ok: probe.ok, ms: probe.ms, ...(probe.ok ? {} : { error: probe.error }) });
    list = recordProbe(list, candidate.mirror, { ok: probe.ok, error: probe.error });
    if (probe.ok) { chosen = candidate; break; }
    if (!rotate) break;
  }

  // ③ 学习结果落盘（成功清零 / 失败累加并在达阈值时停用）
  if (!dryRun) {
    const w = writeCandidates(list);
    if (!w.ok) log?.warn?.(`github_mirror: 候选清单写入失败（已忽略）: ${w.error}`);
  }

  if (!chosen) {
    const direct = await probeDirect();
    return {
      ok: false,
      action: 'apply',
      dryRun,
      attempts,
      directProbe: direct,
      error: direct.ok
        ? '候选代理都不可用，但直连 GitHub 是通的 —— 不需要代理，或换一个 mirror 再试'
        : '候选代理都不可用，直连也不通 —— 请换一个能用的 mirror 显式传入',
      candidates: list.map((it) => ({ mirror: it.mirror, disabled: it.disabled, failures: it.failures })),
    };
  }

  // ④ 写入重写规则（幂等）
  const rules = await readInsteadOfRules();
  const already = rules.ok ? ruleCovers(rules.rules, chosen.mirror, hosts[0]) : false;
  const writes = [];
  if (!dryRun) {
    for (const host of hosts) {
      const r = await applyInsteadOf(chosen.mirror, host);
      writes.push({ host, ...r });
      if (!r.ok) return { ok: false, action: 'apply', dryRun, chosen: chosen.mirror, attempts, writes, error: r.error };
    }
  }

  return {
    ok: true,
    action: 'apply',
    dryRun,
    chosen: chosen.mirror,
    hosts,
    alreadyApplied: already,
    ...(dryRun
      ? { plan: hosts.map((h) => `git config --global url.${chosen.mirror}${hostUrl(h)}.insteadOf ${hostUrl(h)}`) }
      : { writes }),
    attempts,
    candidates: list.map((it) => ({ mirror: it.mirror, disabled: it.disabled, failures: it.failures })),
    note: dryRun
      ? 'dryRun：未写入。确认无误后传 dryRun: false 真正生效。'
      : `已生效：DSH 通过 pnpm/git 安装 GitHub 插件时会走 ${chosen.mirror}（无需重启，git 每次现读配置）`,
  };
}

/** clear：删掉本工具管理的重写规则，恢复直连。 */
async function actionClear(args) {
  const dryRun = asBool(args.dryRun, true);
  const rules = await readInsteadOfRules();
  if (!rules.ok) return { ok: false, action: 'clear', error: rules.error };
  const managed = managedRules(rules.rules);
  if (!managed.length) {
    return { ok: true, action: 'clear', dryRun, removed: [], note: '没有需要清理的重写规则（当前就是直连）' };
  }
  if (dryRun) {
    return { ok: true, action: 'clear', dryRun, plan: managed.map((r) => `git config --global --unset-all ${r.key}`), note: 'dryRun：未删除。确认后传 dryRun: false。' };
  }
  const removed = [];
  for (const rule of managed) {
    const r = await removeInsteadOf(rule.key);
    removed.push({ key: rule.key, ...r });
  }
  const failed = removed.filter((r) => !r.ok);
  return {
    ok: failed.length === 0,
    action: 'clear',
    dryRun,
    removed,
    ...(failed.length ? { error: failed[0].error } : {}),
    note: failed.length ? '部分规则删除失败，见 removed' : '已恢复直连：GitHub 安装不再走代理',
  };
}

/** probe：只探测（不写配置），用于验证候选可用性/恢复被停用的候选。 */
async function actionProbe(args, log) {
  const hosts = normalizeHosts(args.hosts);
  const explicit = normalizeMirror(args.mirror);
  let list = readCandidates();
  if (explicit) list = mergeCandidate(list, explicit, hosts).list;
  const targets = explicit ? [explicit] : usableCandidates(list).map((it) => it.mirror);
  if (!targets.length) {
    return { ok: false, action: 'probe', error: '没有可探测的候选：请传 mirror，或先 apply 一个代理把清单建立起来' };
  }
  const results = [];
  for (const mirror of targets) {
    const probe = await probeMirror(mirror, { host: hosts[0] });
    results.push({ mirror, ...probe });
    list = recordProbe(list, mirror, { ok: probe.ok, error: probe.error });
  }
  const w = writeCandidates(list);
  if (!w.ok) log?.warn?.(`github_mirror: 候选清单写入失败（已忽略）: ${w.error}`);
  const direct = await probeDirect();
  return {
    ok: results.some((r) => r.ok),
    action: 'probe',
    results,
    directProbe: direct,
    candidates: list.map((it) => ({ mirror: it.mirror, disabled: it.disabled, failures: it.failures, lastError: it.lastError })),
    note: `失败满 ${MAX_FAILURES} 次自动停用；探测成功会清零并恢复`,
  };
}

/**
 * 工具入口。
 * @param {{action?: string, mirror?: string, hosts?: unknown, dryRun?: boolean|string, rotate?: boolean|string, probeDirect?: boolean|string}} args
 * @param {{log?: object}} toolCtx
 * @returns {Promise<object>}
 */
export async function runGithubMirror(args = {}, toolCtx = {}) {
  const { log } = toolCtx;
  const action = String(args.action || 'status').trim().toLowerCase();
  try {
    if (action === 'status') return await actionStatus(args);
    if (action === 'apply') return await actionApply(args, log);
    if (action === 'clear') return await actionClear(args);
    if (action === 'probe') return await actionProbe(args, log);
    return { ok: false, error: `未知 action：${action}（可用 status / apply / clear / probe）` };
  } catch (e) {
    return { ok: false, action, error: String((e && e.message) || e) };
  }
}
