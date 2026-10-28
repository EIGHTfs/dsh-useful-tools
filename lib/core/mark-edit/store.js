/**
 * mark_edit 的配置读写（钩子与工具共用，和 mark_read 共用同一个配置文件）
 *
 * 配置文件：<DSH_HOME>/useful-tools/config.json
 *   { "observeHook": true, "observeTools": ["grep","cat"],
 *     "editHook": true, "editSettleMs": 150 }
 *
 * 语义与 mark_read 对齐：**配置一次、全局生效**——
 *   `editHook` 打开后，**所有**经 write/edit 改动过的文件写完后自动按稳定版本补发观测，
 *   不需要指定任何文件，也不维护路径清单。
 *
 * 只碰自己的两个键（editHook / editSettleMs），其余键原样保留。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 缺省：开启（改完不用重读，是大多数人想要的默认）。
 * 延迟缺省 1100ms：实测 CIFS/SMB 上「写完约 1000ms」时属性缓存回写会让
 * dev:ino:size:mtimeNs:ctimeNs 变一次（5 次试验均 ~1000ms，与文件大小无关），
 * 早于这个点的复核拿到的仍是稳定前的值。
 */
export const DEFAULT_EDIT_HOOK = true;
export const DEFAULT_SETTLE_MS = 1100;
/** 首次复核之后，再补几次（相对首次的偏移，ms）：漂移时间可能有波动，多补几次无害，最后一次生效。 */
export const DEFAULT_REFRESH_OFFSETS = [500, 1300];
/** 延迟上限：再久就该怀疑文件系统卡了。 */
export const MAX_SETTLE_MS = 2000;

/** 配置文件路径（DSH_HOME 缺失时返回空串）。 */
export function configPath() {
  const home = String(process.env.DSH_HOME || '').trim();
  if (!home) return '';
  return join(home, 'useful-tools', 'config.json');
}

/** 读整份配置（坏 JSON / 缺失 → 空对象，不崩）。 */
function readRaw() {
  const p = configPath();
  if (!p || !existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')) || {};
  } catch {
    return {};
  }
}

/** 归一化复核偏移：数组/逗号串 → 去重升序的正整数，非法回缺省。 */
export function normalizeOffsets(value, fallback = DEFAULT_REFRESH_OFFSETS) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  const nums = list
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => Math.min(Math.round(n), MAX_SETTLE_MS));
  if (!nums.length) return [...fallback];
  return [...new Set(nums)].sort((a, b) => a - b);
}

/** 归一化延迟：非数字/负数 → 缺省；超上限截断。 */
export function normalizeSettleMs(value, fallback = DEFAULT_SETTLE_MS) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.round(n), MAX_SETTLE_MS);
}

/**
 * 读生效设置：落盘配置优先，其次 loader config，最后缺省。
 * 钩子每次调用都走这里 ⇒ 改配置即时生效。
 * @param {object} [cfg] loader 传入的插件配置
 * @returns {{editHook:boolean, editSettleMs:number, source:string}}
 */
export function readEditSettings(cfg = {}) {
  const raw = readRaw();
  const hasHook = typeof raw.editHook === 'boolean';
  const hasSettle = raw.editSettleMs !== undefined;
  const hook = hasHook
    ? raw.editHook
    : (typeof cfg?.editHook === 'boolean' ? cfg.editHook : DEFAULT_EDIT_HOOK);
  const fallbackSettle = cfg?.editSettleMs !== undefined
    ? normalizeSettleMs(cfg.editSettleMs)
    : DEFAULT_SETTLE_MS;
  const settle = hasSettle ? normalizeSettleMs(raw.editSettleMs, fallbackSettle) : fallbackSettle;
  const offsets = normalizeOffsets(
    raw.editRefreshOffsets !== undefined ? raw.editRefreshOffsets : cfg?.editRefreshOffsets,
  );
  return {
    editHook: hook,
    editSettleMs: settle,
    editRefreshOffsets: offsets,
    source: hasHook || hasSettle ? 'config.json' : 'default',
  };
}

/**
 * 写配置（只改自己的两个键，其余键保留）。
 * @param {{editHook?: boolean, editSettleMs?: number}} patch 传 undefined 的键不动
 * @returns {{ok:boolean, path?:string, editHook?:boolean, editSettleMs?:number, error?:string}}
 */
export function writeEditSettings(patch = {}) {
  const p = configPath();
  if (!p) return { ok: false, error: 'DSH_HOME 未设置，无法定位配置文件' };
  try {
    const raw = readRaw();
    const cur = readEditSettings();
    const next = { ...raw };
    if (patch.editHook !== undefined) next.editHook = patch.editHook !== false;
    if (patch.editSettleMs !== undefined) next.editSettleMs = normalizeSettleMs(patch.editSettleMs);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(next, null, 2) + '\n', 'utf8');
    return {
      ok: true,
      path: p,
      editHook: next.editHook === undefined ? cur.editHook : next.editHook,
      editSettleMs: next.editSettleMs === undefined ? cur.editSettleMs : next.editSettleMs,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
