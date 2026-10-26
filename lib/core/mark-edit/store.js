/**
 * mark_edit 的持久清单（与 mark_read 的命令集合共用同一个配置文件）
 *
 * 配置文件：<DSH_HOME>/useful-tools/config.json
 *   { "observeHook": true, "observeTools": ["grep","cat"], "editPaths": ["/abs/a.js"] }
 *
 * 为什么落盘：mark_edit 的语义是「这些文件我经手过，之后免重读」——必须**跨会话/跨重启有效**，
 *   否则每次重启都要重新标记一遍。可撤销靠 undo（从清单移除 + 补发哨兵版本）。
 *
 * 只碰自己的 `editPaths` 键，其余键原样保留（同一文件还有 mark_read / test_env 的配置）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 配置键：已标记为「编辑已知」的绝对路径清单。 */
export const EDIT_PATHS_KEY = 'editPaths';

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

/** 归一化路径清单：去空、去重、保序。 */
export function normalizePaths(list) {
  const arr = Array.isArray(list) ? list : [];
  return [...new Set(arr.map((v) => String(v ?? '').trim()).filter(Boolean))];
}

/**
 * 读持久清单（每次现读，不缓存）。
 * @returns {string[]}
 */
export function readEditPaths() {
  const raw = readRaw();
  return normalizePaths(raw[EDIT_PATHS_KEY]);
}

/**
 * 写回持久清单（保留文件里其它键）。
 * @param {string[]} list
 * @returns {{ok:boolean, path?:string, editPaths?:string[], error?:string}}
 */
export function writeEditPaths(list) {
  const p = configPath();
  if (!p) return { ok: false, error: 'DSH_HOME 未设置，无法定位配置文件' };
  try {
    const raw = readRaw();
    const next = { ...raw, [EDIT_PATHS_KEY]: normalizePaths(list) };
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(next, null, 2) + '\n', 'utf8');
    return { ok: true, path: p, editPaths: next[EDIT_PATHS_KEY] };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
