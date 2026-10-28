/**
 * 宿主观测台账补发（供 mark 工具与 post-execute 钩子共用）
 *
 * 【背景】宿主原生 write/edit 有「改动前必须先读过」的门禁：
 *   packages/fs/fs-observation-policy 以 WeakMap<owner, Map<targetKey, observation>> 记账，
 *   只认宿主自己的 fs 读路径发出的 ctx.emit('fs/observed', target, {kind, version}, exec)。
 *   内容来自别处（grep/cat/脚本/其它调用方）时，原生写报 cannot modify … has not been read。
 *
 * 【本模块】按官方同一 recipe 补发一条「present + 当前 version」观测：
 *   1) target = ctx.fs.resolve(path, { cwd?, signal })
 *   2) info   = ctx.fs.stat(target, signal)          ← 权威 version；非普通文件不发
 *   3) ctx.emit('fs/observed', target, { kind:'present', version: info.version }, exec)
 *   actor 必须是本次调用自己的 exec：台账按 owner 隔离，拿错 actor 等于替别人记账。
 *   观测的有效性语义（实测）：版本不变则一直放行；文件被任何一方改动后，
 *   原生写会改为报 file changed since it was read，需要重新标记。
 *
 * 【失败不阻断】任何一步异常都返回 {ok:false, error}，绝不向调用方抛错。
 * @param {object} fsCtx 已注入('fs') 的上下文（提供 fs 服务与 emit）
 * @param {object} exec  宿主工具执行上下文（含 agent/signal，即 emit 的 actor）
 * @param {string} hostPath 目标文件路径
 * @param {object} [observation] 覆盖观测内容（unmark 撤回时传过期版本）
 * @returns {{ok:boolean, target?:string, version?:*, error?:string}}
 */
/** 已标记路径台账：mark_read 与自动钩子补发的都记账；unmark_read --all 据此一次性还原。 */
const markedPaths = new Set();
export function markedPathsSnapshot() { return [...markedPaths]; }
export function clearMarkedPaths() { markedPaths.clear(); }

/** 解析本次调用自己的工作目录；拿不到就不带 cwd（让 fs 服务用默认值）。 */
async function resolveCallCwd(fsCtx, exec) {
  const workingDirectory = fsCtx.get?.('workingDirectory');
  if (!exec?.agent || !workingDirectory?.ensure) return undefined;
  try {
    return await workingDirectory.ensure(exec.agent, exec.signal);
  } catch {
    return undefined;
  }
}

/** 目标不可发观测时返回原因（空串 = 可发）。 */
function unobservableReason(info) {
  if (!info) return '目标不存在，未发观测';
  if (info.type !== undefined && info.type !== 'file') return `非普通文件（${info.type}），不发观测`;
  return '';
}

/** 取宿主 fs 服务（未注入返回 undefined）。 */
function fsServiceOf(fsCtx) {
  return fsCtx.get?.('fs') || fsCtx.fs;
}

/** 入参自检：不可补发时返回原因（空串 = 可继续）。 */
function contextErrorOf(fsCtx, hostPath) {
  if (!fsCtx?.emit || typeof hostPath !== 'string' || !hostPath) return '缺少上下文或路径';
  const fs = fsServiceOf(fsCtx);
  if (!fs?.resolve || !fs?.stat) return 'fs 服务不可用（未注入）';
  return '';
}

/**
 * 补发观测（可带延迟复核）。
 *
 * settleMs > 0 时：先 stat 一次，等 `settleMs` 毫秒后再 stat 一次，**只发一条**（用后一次的版本）。
 * 为什么需要：`version` 串含 mtimeNs/ctimeNs，CIFS/SMB 上写完还会晚到再变（实测 3ms）；
 *   官方「rename 后立刻 probe」记下的是稳定前的值，导致下一次写改 CAS 对不上。
 * 为什么不用 detached timer：延后期间 `exec` 的 agent/signal 可能已失效，届时再 resolve 会落到
 *   宿主进程默认目录（不是工作区）——所以整个等待过程留在本次工具调用内（代价：该工具结果晚 settleMs 返回）。
 *
 * @param {object} fsCtx 已注入 fs 的上下文
 * @param {object} exec 工具执行上下文（emit 的 actor）
 * @param {{targetKey:string, displayPath:string}} target 已解析的目标
 * @param {object} [observation] 覆盖观测内容（undo 时传哨兵版本）
 * @param {{settleMs?: number}} [opts]
 */
export async function observeResolvedTarget(fsCtx, exec, target, observation, { settleMs = 0, ignoreSignal = false } = {}) {
  // ignoreSignal：延迟复核时工具调用可能已结束，exec.signal 会 abort ⇒ 用 undefined 照常 stat
  const statSignal = ignoreSignal ? undefined : exec?.signal;
  if (!fsCtx?.emit || !target) return { ok: false, error: '缺少上下文或目标' };
  const fs = fsServiceOf(fsCtx);
  if (!fs?.stat) return { ok: false, error: 'fs 服务不可用（未注入）' };
  try {
    let info = await fs.stat(target, statSignal);
    const reason = unobservableReason(info);
    if (reason) return { ok: false, error: reason };
    if (settleMs > 0) {
      await new Promise((r) => setTimeout(r, settleMs));
      // 复核失败就用第一次的值（不因为复核出错而放弃补发）
      try {
        const again = await fs.stat(target, statSignal);
        if (again && again.version !== undefined) info = again;
      } catch { /* 保持第一次的结果 */ }
    }
    const payload = observation || { kind: 'present', version: info.version };
    fsCtx.emit('fs/observed', target, payload, exec);
    if (!observation) markedPaths.add(target.displayPath);
    return { ok: true, target: target.displayPath, version: info.version };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

export async function observeFileForHost(fsCtx, exec, hostPath, observation, opts = {}) {
  const contextError = contextErrorOf(fsCtx, hostPath);
  if (contextError) return { ok: false, error: contextError };
  const fs = fsServiceOf(fsCtx);
  try {
    // 立刻解析：此刻 exec 的 agent / signal 仍有效（延迟复核期间可能失效）
    const cwd = await resolveCallCwd(fsCtx, exec);
    const target = await fs.resolve(hostPath, { ...(cwd ? { cwd } : {}), signal: exec?.signal });
    return await observeResolvedTarget(fsCtx, exec, target, observation, opts);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
