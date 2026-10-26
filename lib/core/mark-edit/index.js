/**
 * mark_edit 的实现：把「这些文件我刚改过、内容就是当前磁盘这份」补发给宿主，并**落盘记着**。
 *
 * ## 为什么需要
 * 官方 `write` / `edit` 成功后**自己会**补发观测（`tool-fs` 的 `mutationResult()`），
 * 但它的 version 是「刚写完立刻 probe」拿到的值，而版本串是
 * `dev:ino:size:mtimeNs:ctimeNs` —— CIFS/SMB 上 mtime/ctime 会**晚到**地再更新一次（实测 3ms 内），
 * 于是记下的是稳定前的值，下一次写改 CAS 对不上，报 `file changed since it was read`。
 * 这就是「写完再改」「连续编辑」都要重读的真实原因（与 mark_read 无关、与 CIFS 补丁无关）。
 *
 * ## 做法（与 mark_read 同一条官方通道）
 * `ctx.emit('fs/observed', target, { kind: 'present', version }, exec)`，version 由 `fs.stat()` 现取。
 * 相比官方，多两件事：
 *   ① **落盘清单**：标记过的路径写进配置（`editPaths`），跨会话/重启有效，可 `undo` 撤销；
 *      不传 `paths` 时用清单**续期**（重新按当前版本补发一次）——对应 mark_read「不传 commands 用预置清单」。
 *   ② **`settleMs`**：延迟若干毫秒再 stat，等文件系统把时间戳写稳，专治「刚写完马上标记」。
 *
 * ## undo 的语义
 * 从清单移除 + 补发一条「必然对不上」的版本（哨兵），使这些文件重新要求先读——把门禁恢复。
 *
 * ## 安全边界
 * 本工具不读文件内容，它声明的是「我已经知道这份文件现在是什么」。
 * 因此只在自己确实经手写入时用；内容不是自己写的文件，仍应老实 read。
 */
import { existsSync, readFileSync } from 'node:fs';

import { observeFileForHost } from '../mark-read/observe.js';
import { normalizePaths, readEditPaths, writeEditPaths } from './store.js';

/** 单次最多处理多少个路径（防止一次调用把台账刷爆）。 */
export const MAX_PATHS = 50;

/** `settleMs` 上限：再久就该先确认文件系统是不是卡了。 */
export const MAX_SETTLE_MS = 2000;

/**
 * undo 用的哨兵观测：version 是不可能与真实版本相等的字符串，
 * 宿主 CAS（`existing.version !== expected.version`）必然判 stale ⇒ 重新要求先读。
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

/** 归一化 settleMs：非数字/负数 → 0；超过上限则截断。 */
export function normalizeSettleMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.round(n), MAX_SETTLE_MS);
}

/**
 * 工具入口：标记（或撤销）「这些文件我经手过」，并把清单落盘。
 * @param {{paths?: unknown, undo?: boolean, settleMs?: number|string}} args
 * @param {{ctx?: object, exec?: object}} toolCtx 装配层传入的宿主上下文
 * @returns {Promise<object>}
 */
export async function runMarkEdit(args = {}, toolCtx = {}) {
  const { ctx, exec } = toolCtx;
  const undo = args.undo === true || args.undo === 'true';
  const settleMs = normalizeSettleMs(args.settleMs);
  const given = parsePaths(args.paths);
  const stored = readEditPaths();
  // 不传 paths = 用持久清单续期（对应 mark_read「不传 commands 用预置清单」）
  const targets = given.length ? given : stored;
  const fromStore = given.length === 0;

  if (!targets.length) {
    return { ok: false, error: '没有可处理的路径：传 paths，或先标记过若干文件（持久清单为空）' };
  }
  if (!ctx || typeof ctx.emit !== 'function') {
    return { ok: false, error: '缺少宿主上下文（emit 不可用）' };
  }
  const fs = ctx.get?.('fs') || ctx.fs;
  if (!fs?.resolve || !fs?.stat) {
    return { ok: false, error: 'fs 服务不可用（插件未注入 fs）' };
  }

  const limited = targets.slice(0, MAX_PATHS);
  // 延迟复核：等文件系统把 mtime/ctime 写稳，再取版本（否则记下的是稳定前的值）
  if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));

  const marked = [];
  const failed = [];
  for (const target of limited) {
    // 每个路径独立成败：一个坏路径不影响其余
    const r = await observeFileForHost(ctx, exec, target, undo ? STALE_SENTINEL : undefined);
    if (r.ok) marked.push({ path: r.target, version: r.version });
    else failed.push({ path: target, error: r.error });
  }

  // 持久清单：标记要并进去（用解析后的绝对路径，跨调用才去重得掉）；撤销要摘出来
  const markedPaths = marked.map((m) => m.path);
  let store = { ok: true, editPaths: stored };
  if (undo) {
    const gone = new Set([...markedPaths, ...limited.map((p) => String(p).trim())]);
    store = writeEditPaths(stored.filter((p) => !gone.has(p)));
  } else if (markedPaths.length) {
    store = writeEditPaths([...stored, ...markedPaths]);
  }

  return {
    ok: marked.length > 0,
    action: undo ? 'undo' : 'mark',
    ...(fromStore ? { renewed: true } : {}),
    ...(settleMs ? { settleMs } : {}),
    marked,
    failed,
    ...(targets.length > limited.length ? { truncated: targets.length - limited.length } : {}),
    editPaths: store.ok ? store.editPaths : stored,
    ...(store.ok ? {} : { storeError: store.error }),
    ...(store.ok ? { storePath: store.path } : {}),
    note: undo
      ? '已撤销标记并从持久清单移除：这些文件下一次写改会重新要求先读（门禁已恢复）'
      : '已按当前磁盘版本补发观测并写入持久清单：这些文件现在可以直接 edit / write，不必重读全文',
  };
}
