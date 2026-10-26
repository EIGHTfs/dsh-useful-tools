/**
 * mark_edit 的实现：把「这些文件我刚改过、内容就是当前磁盘这份」补发给宿主。
 *
 * ## 为什么需要
 * 官方 `write` / `edit` 成功后**自己会**补发观测（`tool-fs` 的 `mutationResult()`），
 * 所以「自己写完自己再改」本来不用重读。会逼人重读的只有一种：
 * 文件被 **fs 工具之外**的途径改动过（bash 里的 `sed -i` / heredoc 重定向 / `tee`、
 * 别的工具或别的会话写入、git 检出…）——磁盘 version 变了，旧观测作废，
 * 下一次 `edit` 就报 `file changed since it was read`。
 *
 * ## 做法（与 mark_read 同一条官方通道）
 * `ctx.emit('fs/observed', target, { kind: 'present', version }, exec)`，
 * 其中 version 由 `fs.stat()` 现取——这正是宿主自己补发时用的同一个 recipe，
 * 不修改宿主、不走私有接口。补完之后 `edit` / `write` 的 CAS 就以当前版本为基准。
 *
 * ## undo 的语义
 * 补发一条「必然对不上」的版本（哨兵法），于是下一次写改又会被要求先读——
 * 即把门禁**恢复**回来（对应 mark_read 的 undo：把命令从集合里移除）。
 *
 * ## 安全边界
 * 本工具不读文件内容，它声明的是「我已经知道这份文件现在是什么」。
 * 因此只在**确实由自己经手写入**时使用；内容不是自己写的文件，仍应老实 read。
 */
import { existsSync, readFileSync } from 'node:fs';

import { observeFileForHost } from '../mark-read/observe.js';

/** 单次最多处理多少个路径（防止一次调用把台账刷爆）。 */
export const MAX_PATHS = 50;

/**
 * undo 用的哨兵观测：version 是一个不可能与真实版本相等的字符串，
 * 宿主 CAS（`existing.version !== expected.version`）必然判 stale ⇒ 重新要求先读。
 */
export const STALE_SENTINEL = { kind: 'present', version: '__mark_edit_undo__' };

/**
 * 解析路径入参。
 * 支持：① 逗号 / 分号 / 换行分隔的多路径 ② `@清单文件`（文件内每行或逗号一个路径）。
 * 不支持「裸路径即清单」——本工具的参数语义就是路径本身，把存在的文件当清单会造成歧义。
 * @param {unknown} raw
 * @returns {string[]}
 */
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

/**
 * 工具入口：把给定路径按当前磁盘版本补发观测（undo = 撤回标记）。
 * @param {{paths?: unknown, undo?: boolean}} args
 * @param {{ctx?: object, exec?: object}} toolCtx 装配层传入的宿主上下文
 * @returns {Promise<object>}
 */
export async function runMarkEdit(args = {}, toolCtx = {}) {
  const { ctx, exec } = toolCtx;
  const undo = args.undo === true || args.undo === 'true';
  const paths = parsePaths(args.paths);
  if (!paths.length) {
    return { ok: false, error: 'paths 为空：传文件路径（逗号 / 分号 / 换行分隔，或 @清单文件）' };
  }
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
    // 每个路径独立成败：一个坏路径不影响其余（批量场景常见）
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
    note: undo
      ? '已撤销标记：这些文件下一次写改会重新要求先读（门禁已恢复）'
      : '已按当前磁盘版本补发观测：这些文件现在可以直接 edit / write，不必重读全文',
  };
}
