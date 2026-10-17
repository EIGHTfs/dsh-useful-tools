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

export async function observeFileForHost(fsCtx, exec, hostPath, observation) {
  if (!fsCtx?.emit || typeof hostPath !== 'string' || !hostPath) return { ok: false, error: '缺少上下文或路径' };
  const fs = fsCtx.get?.('fs') || fsCtx.fs;
  if (!fs?.resolve || !fs?.stat) return { ok: false, error: 'fs 服务不可用（未注入）' };
  try {
    let cwd;
    const wd = fsCtx.get?.('workingDirectory');
    if (exec?.agent && wd?.ensure) {
      try { cwd = await wd.ensure(exec.agent, exec.signal); } catch { cwd = undefined; }
    }
    const target = await fs.resolve(hostPath, { ...(cwd ? { cwd } : {}), signal: exec?.signal });
    const info = await fs.stat(target, exec?.signal);
    if (!info) return { ok: false, error: '目标不存在，未发观测' };
    if (info.type !== undefined && info.type !== 'file') return { ok: false, error: `非普通文件（${info.type}），不发观测` };
    // observation 缺省 = 正常「已读」标记（present + 当前版本）；unmark 传入过期版本即可撤回
    const payload = observation || { kind: 'present', version: info.version };
    fsCtx.emit('fs/observed', target, payload, exec);
    // 只有「正常已读标记」才入台账（unmark 发的过期版本不记，避免自我抵消）
    if (!observation) markedPaths.add(target.displayPath);
    return { ok: true, target: target.displayPath, version: info.version };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
