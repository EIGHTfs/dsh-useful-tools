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
 * - `mirror` **可省**：省掉时按候选清单顺序探测，取第一个可用的。
 *   只有清单为空或全部停用时才必须显式传。
 * - 候选清单自带三条（外置在 `candidates.json`，随仓库入库），记录失败次数；连续失败达阈值自动停用。
 * - **探测不通的地址不入库**：显式传入但不可访问时只在返回值里告知 `rejected`，不污染候选表；
 *   清单内地址失败则累加 failures（用于标记与停用）。
 * - `apply` 先探测再写；失败按清单顺序轮换（`rotate: false` 则只测显式那一个）；全不通则不写并报错。
 * - `dryRun` 缺省 **true**：只报计划，且探测结果也不落盘。
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
    usage: 'mirror 可省：{ action: "apply" } 按候选顺序取第一个可用的；清单空了才必须传 mirror',
  };
}

/**
 * 构造 apply 的探测顺序（纯函数，便于单测）。
 *
 * 规则：
 *   · 显式 mirror 排最前；`rotate: false` 时只测它一个；
 *   · 其后按文件顺序取清单里未停用的候选（同地址去重）；
 *   · 清单为空/全停用且没给 mirror ⇒ 空数组，调用方据此要求必填。
 */
export function planProbeOrder(list, explicit, rotate = true) {
  const queue = [];
  const seen = new Set();
  if (explicit) { queue.push({ mirror: explicit, explicit: true }); seen.add(explicit); }
  if (explicit && rotate === false) return queue;
  for (const it of usableCandidates(list)) {
    const mirror = normalizeMirror(it.mirror);
    if (!mirror || seen.has(mirror)) continue;
    seen.add(mirror);
    queue.push({ mirror, explicit: false, hosts: it.hosts });
  }
  return queue;
}

/** apply：按「显式 → 清单顺序」探测，取第一个可用的写入 insteadOf。 */
async function actionApply(args, log) {
  const explicit = normalizeMirror(args.mirror);
  const hosts = normalizeHosts(args.hosts);
  const dryRun = asBool(args.dryRun, true);
  const rotate = asBool(args.rotate, true);

  let list = readCandidates();
  const queue = planProbeOrder(list, explicit, rotate);

  // 没有任何可探测对象（清单空/全停用，且未显式传）⇒ 这时 mirror 才是必填
  if (!queue.length) {
    return {
      ok: false,
      action: 'apply',
      error: '候选清单为空或全部停用：这次必须显式传 mirror（如 { mirror: "https://ghfast.top/" }）',
      candidates: list.map((it) => ({ mirror: it.mirror, disabled: it.disabled, failures: it.failures })),
      note: '清单里还有可用候选时可不传 mirror，按顺序自动取第一个可用的',
    };
  }

  // 逐个探测取第一个可用的。
  // 关键区别：清单内地址失败要累加失败计数（用于标记/停用）；
  // 显式传入但探测不通的地址**不并入清单**——它没被证明可用，写进去只会污染候选表。
  const attempts = [];
  let chosen = null;
  for (const cand of queue) {
    const probe = await probeMirror(cand.mirror, { host: hosts[0] });
    attempts.push({
      mirror: cand.mirror,
      ok: probe.ok,
      ms: probe.ms,
      source: cand.explicit ? 'explicit' : 'candidates',
      ...(probe.ok ? {} : { error: probe.error }),
    });
    if (probe.ok) {
      // 可用的显式地址并入清单（下次可省参数）；已有条目则重置失败计数
      list = mergeCandidate(list, cand.mirror, hosts).list;
      list = recordProbe(list, cand.mirror, { ok: true });
      chosen = cand;
      break;
    }
    if (!cand.explicit) list = recordProbe(list, cand.mirror, { ok: false, error: probe.error });
    if (!rotate) break;
  }

  // 学习结果落盘（只在真写时；dryRun 不动文件）
  if (!dryRun) {
    const w = writeCandidates(list);
    if (!w.ok) log?.warn?.(`github_mirror: 候选清单写入失败（已忽略）: ${w.error}`);
  }

  if (!chosen) {
    const direct = await probeDirect();
    const rejected = attempts.filter((a) => a.source === 'explicit' && !a.ok);
    return {
      ok: false,
      action: 'apply',
      dryRun,
      attempts,
      directProbe: direct,
      error: direct.ok
        ? '候选都不可用，但直连 GitHub 是通的 —— 不需要代理；或换一个 mirror'
        : '候选都不可用且直连不通 —— 换一个能访问的 mirror',
      ...(rejected.length ? { rejected: rejected.map((a) => ({ mirror: a.mirror, error: a.error, persisted: false })) } : {}),
      candidates: list.map((it) => ({ mirror: it.mirror, disabled: it.disabled, failures: it.failures })),
    };
  }

  // 写入重写规则（幂等）
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
    chosenSource: chosen.explicit ? 'explicit' : 'candidates',
    hosts,
    alreadyApplied: already,
    ...(dryRun
      ? { plan: hosts.map((h) => `git config --global url.${chosen.mirror}${hostUrl(h)}.insteadOf ${hostUrl(h)}`) }
      : { writes }),
    attempts,
    ...(dryRun ? {} : { candidates: list.map((it) => ({ mirror: it.mirror, disabled: it.disabled, failures: it.failures })) }),
    note: dryRun
      ? 'dryRun：未写入，探测结果也没落盘。确认后传 dryRun: false 生效。'
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
  // 显式地址先只探测，不预先并入清单；清单里失败过但想重测的，用 --mirror 点名
  const targets = explicit ? [explicit] : usableCandidates(list).map((it) => it.mirror);
  if (!targets.length) {
    return { ok: false, action: 'probe', error: '没有可探测的候选：请传 mirror，或先 apply 一个代理把清单建立起来' };
  }
  const results = [];
  for (const mirror of targets) {
    const probe = await probeMirror(mirror, { host: hosts[0] });
    const known = list.some((it) => normalizeMirror(it.mirror) === mirror);
    results.push({ mirror, ...probe, ...(known ? {} : { source: 'explicit' }) });
    if (probe.ok) {
      // 可用的才入库：新地址并入，已有条目清零失败计数
      list = recordProbe(mergeCandidate(list, mirror, hosts).list, mirror, { ok: true });
    } else if (known) {
      // 清单内地址失败要计数（用于停用）；清单外的不入库，只在返回值里告知
      list = recordProbe(list, mirror, { ok: false, error: probe.error });
    }
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
    rejected: results.filter((r) => !r.ok && r.source === 'explicit').map((r) => ({ mirror: r.mirror, error: r.error, persisted: false })),
    note: `失败满 ${MAX_FAILURES} 次自动停用；探测成功会清零并恢复；探测不通的新地址不入库`,
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
