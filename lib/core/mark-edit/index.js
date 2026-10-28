/**
 * mark_edit 的实现（**全局生效**，与 mark_read 同口径）
 *
 * mark_read：配一次命令集合 ⇒ 集合里的命令读过的**所有文件**自动补发观测。
 * mark_edit：打开开关（缺省就开）⇒ **所有经 write / edit 改过的文件**写完后自动按稳定版本补发观测。
 *   —— 不指定文件、不维护清单，改完直接接着改，不用重读。
 *
 * ## 为什么需要
 * 官方 write/edit 成功后自己会补发观测，但它用的是「rename 后立刻 probe」的版本，
 * 而版本串是 `dev:ino:size:mtimeNs:ctimeNs`；CIFS/SMB 上时间戳会**晚到**再变一次（实测 3ms）。
 * 记下的是稳定前的值 ⇒ 下一次写改 CAS 对不上 ⇒ `file changed since it was read`。
 * 所以连续编辑每次都被要求重读——这就是本工具要根治的现象。
 *
 * ## 本工具负责的三件事
 *   ① 配置：`enabled`（总开关）/ `settleMs`（延迟毫秒）——落盘，配置一次长期有效；
 *   ② 补标：`paths` 用于**没走 write/edit** 的改动（bash 的 sed -i / heredoc / tee、别的会话写入）；
 *   ③ 撤销：`undo` 对给定 paths 补发「必然对不上」的版本，恢复「先读再改」门禁。
 *
 * 不传任何参数时返回当前设置（相当于状态查询），不报错——与「配置一次」的用法一致。
 *
 * ## 安全边界
 * 补标不读文件内容，它声明的是「我已经知道这份文件现在是什么」：
 * 只在自己确实经手写入时用；内容不是自己写的文件仍应 read。
 */
import { existsSync, readFileSync } from 'node:fs';

import { observeFileForHost } from '../mark-read/observe.js';
import { MAX_SETTLE_MS, readEditSettings, writeEditSettings } from './store.js';
import { refreshStats } from './hook.js';

/** 单次最多补标多少个路径。 */
export const MAX_PATHS = 50;

/**
 * undo 用的哨兵观测：version 是不可能与真实版本相等的字符串，
 * 宿主 CAS 必然判 stale ⇒ 重新要求先读。
 */
export const STALE_SENTINEL = { kind: 'present', version: '__mark_edit_undo__' };

/** 解析路径入参：逗号/分号/换行分隔；`@清单文件` 从文件读。 */
export function parsePaths(raw) {
  if (Array.isArray(raw)) return raw.map((v) => String(v ?? '').trim()).filter(Boolean);
  const text = String(raw ?? '').trim();
  if (!text) return [];
  if (text.startsWith('@')) {
    const listFile = text.slice(1).trim();
    try {
      if (listFile && existsSync(listFile)) {
        return readFileSync(listFile, 'utf8')
          .split(/[\n,;]/)
          .map((s) => s.trim())
          .filter(Boolean);
      }
    } catch { /* 读不到就按普通路径处理 */ }
    return [text];
  }
  return text.split(/[\n,;]/).map((s) => s.trim()).filter(Boolean);
}

/** 解析布尔入参（工具参数可能是字符串）。 */
function asBool(v) {
  if (v === true || v === 'true' || v === 1 || v === '1') return true;
  if (v === false || v === 'false' || v === 0 || v === '0') return false;
  return undefined;
}

/**
 * 工具入口。
 * @param {{paths?: unknown, undo?: boolean, enabled?: boolean|string, settleMs?: number|string}} args
 * @param {{ctx?: object, exec?: object, config?: object}} toolCtx 装配层传入的宿主上下文
 * @returns {Promise<object>}
 */
export async function runMarkEdit(args = {}, toolCtx = {}) {
  const { ctx, exec, config } = toolCtx;
  const undo = asBool(args.undo) === true;
  const enabled = asBool(args.enabled);
  const settleGiven = args.settleMs !== undefined && args.settleMs !== '';
  const paths = parsePaths(args.paths);

  // ① 配置变更（落盘、长期有效）：给了 enabled / settleMs 就写
  let settings = readEditSettings(config);
  let writeResult = null;
  if (enabled !== undefined || settleGiven) {
    writeResult = writeEditSettings({
      ...(enabled === undefined ? {} : { editHook: enabled }),
      ...(settleGiven ? { editSettleMs: args.settleMs } : {}),
    });
    if (writeResult.ok) {
      settings = { editHook: writeResult.editHook, editSettleMs: writeResult.editSettleMs, source: 'config.json' };
    }
  }

  // ② 没给路径：纯配置查询/变更（不报错——对齐「配置一次」的用法）
  if (!paths.length) {
    return {
      ok: writeResult ? writeResult.ok : true,
      action: writeResult ? 'configure' : 'status',
      // 便于确认宿主当前加载的是哪版实现（热重载失效时肉眼可辨）
      impl: 'global+bash-write',
      refreshEmits: refreshStats.emits,
      lastRefresh: refreshStats.last,
      editHook: settings.editHook,
      editSettleMs: settings.editSettleMs,
      settingsSource: settings.source,
      maxSettleMs: MAX_SETTLE_MS,
      ...(writeResult?.path ? { storePath: writeResult.path } : {}),
      ...(writeResult && !writeResult.ok ? { error: writeResult.error } : {}),
      note: settings.editHook
        ? `全局续期已开启：所有经 write / edit 改过的文件写完后自动按稳定版本补发（延迟 ${settings.editSettleMs}ms），连续编辑不必重读`
        : '全局续期已关闭：写改后仍按官方行为（CIFS 上连续编辑可能需要重读）',
      usage: '补标非 write/edit 的改动：传 paths（如 bash 的 sed -i 改过的文件）；撤销：undo:true',
    };
  }

  // ③ 给了路径：补标 / 撤销
  if (!ctx || typeof ctx.emit !== 'function') {
    return { ok: false, error: '缺少宿主上下文（emit 不可用）' };
  }
  const fs = ctx.get?.('fs') || ctx.fs;
  if (!fs?.resolve || !fs?.stat) {
    return { ok: false, error: 'fs 服务不可用（插件未注入 fs）' };
  }

  const limited = paths.slice(0, MAX_PATHS);
  const marked = [];
  const failed = [];
  for (const target of limited) {
    const r = await observeFileForHost(ctx, exec, target, undo ? STALE_SENTINEL : undefined);
    if (r.ok) marked.push({ path: r.target, version: r.version });
    else failed.push({ path: target, error: r.error });
  }

  return {
    ok: marked.length > 0,
    action: undo ? 'undo' : 'mark',
    marked,
    failed,
    ...(paths.length > limited.length ? { truncated: paths.length - limited.length } : {}),
    editHook: settings.editHook,
    editSettleMs: settings.editSettleMs,
    note: undo
      ? '已补发对不上的版本：这些文件下一次写改会重新要求先读（门禁已恢复）'
      : '已按当前磁盘版本补发观测：这些文件现在可以直接 edit / write',
  };
}
