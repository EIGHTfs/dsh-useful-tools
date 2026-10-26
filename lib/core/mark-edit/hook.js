/**
 * mark_edit 的自动续期钩子
 *
 * ## 为什么需要
 * 「标记一次」只够用一次：`edit` 成功后官方会按**刚写完立刻 probe** 的版本再补发一条观测，
 * 而 CIFS 上 mtime/ctime 会晚到地再变一次 ⇒ 这条观测本身还是不稳定值。
 * 于是「标记 → edit ✓ → edit ✗」，标记形同一次性。
 *
 * ## 做法
 * 用户标记过的路径（持久清单 `editPaths`）在被 `write` / `edit` 改动后，
 * 延迟 `settleMs`（缺省 150ms，等时间戳写稳）再 `stat` 并补发观测 —— 把「一次性标记」续成**永久有效**。
 *
 * 作用域严格受限：**只对持久清单里的路径生效**，没标记过的文件完全不受影响。
 * 因此这不是「放开宿主门禁」，而是「把用户显式声明的免重读保持有效」。
 */
import { observeFileForHost } from '../mark-read/observe.js';
import { readEditPaths } from './store.js';

/** 会改动文件的工具名（这两个才需要续期）。 */
export const MUTATION_TOOLS = ['write', 'edit'];

/** 延迟窗口：实测 CIFS 时间戳在 3ms 内就稳了，留足余量但别让人等。 */
export const DEFAULT_SETTLE_MS = 150;

/** 从工具调用里取目标路径（宿主各版本字段名不同）。非写改工具返回空串。 */
export function extractTargetPath(toolName, args) {
  if (!MUTATION_TOOLS.includes(String(toolName || ''))) return '';
  const v = args?.path ?? args?.file_path ?? args?.filePath;
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * 目标是否可能被标记过（廉价预判，避免给每个 write/edit 都排一次延迟任务）。
 * 相对路径按「路径片段后缀」比对：工具常给相对 cwd 的路径，清单里存的是解析后的绝对路径。
 */
export function mightBeMarked(target, marked) {
  const t = String(target || '').replace(/\\/g, '/').trim();
  if (!t) return false;
  const absolute = t.startsWith('/');
  for (const raw of Array.isArray(marked) ? marked : []) {
    const m = String(raw || '').replace(/\\/g, '/');
    if (!m) continue;
    if (m === t) return true;
    if (!absolute && m.endsWith(`/${t}`)) return true;
  }
  return false;
}

/**
 * 注册续期钩子。
 * @param {object} ctx 插件上下文
 * @param {{fsCtx?: object, cfg?: object, log?: object}} opts
 * @returns {boolean} 是否注册成功
 */
export function registerEditRefreshHook(ctx, { fsCtx, cfg, log } = {}) {
  if (typeof ctx?.on !== 'function' || !fsCtx) return false;
  const configured = Number(cfg?.editSettleMs);
  const settleMs = Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_SETTLE_MS;
  try {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next(); // 先放行：工具结果与后续流程不受本钩子影响
      try {
        const args = exec?.arguments ?? exec?.args ?? exec?.input ?? exec?.parameters ?? {};
        const target = extractTargetPath(exec?.name, args);
        if (!target) return decision;
        const marked = readEditPaths();
        // 没标记过的文件完全不碰（省延迟、也不会顺手放宽别人的门禁）
        if (!mightBeMarked(target, marked)) return decision;
        const timer = setTimeout(async () => {
          try {
            const r = await observeFileForHost(fsCtx, exec, target);
            if (!r.ok && typeof log?.warn === 'function') {
              log.warn(`dsh-useful-tools: mark_edit 续期失败（已忽略）: ${r.error}`);
            }
          } catch { /* 续期失败不影响任何主流程 */ }
        }, settleMs);
        timer.unref?.();
      } catch { /* 钩子自身绝不抛错 */ }
      return decision;
    });
    return true;
  } catch (e) {
    if (typeof log?.warn === 'function') log.warn(`dsh-useful-tools: 续期钩子注册失败: ${(e && e.message) || e}`);
    return false;
  }
}
