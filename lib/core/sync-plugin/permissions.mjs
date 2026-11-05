/**
 * 同步后的权限 / 属主对齐 + 读权限自检。
 *
 * 为什么需要：DSH 以服务用户运行，而同步出来的文件若是 600 或 root 所有，
 * 宿主根本读不到 —— 表现是「装了但不激活」，日志里没有任何线索（本工具曾经只能报「无报错」）。
 * 这类问题排查成本极高，所以同步完就顺手对齐并自检。
 *
 * 全部 best-effort：CIFS/SMB 挂载上 chmod/chown 必然 EPERM，
 * 失败只记录、不中断同步，也不假装成功。
 */
import { accessSync, chmodSync, chownSync, constants, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIR_MODE = 0o755;
const FILE_MODE = 0o644;
const EXEC_MODE = 0o755;

/** 递归列目录下的所有条目（目录先于内容，便于先改目录权限）。 */
function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push({ path: full, dir: true });
      walk(full, out);
    } else {
      out.push({ path: full, dir: false });
    }
  }
  return out;
}

/**
 * 对齐权限与属主。
 * @param {{target: string, profileDir?: string}} params
 * @returns {{ok: boolean, chmoded: number, chowned: number, chmodFailed: number, chownFailed: number, notes: string[]}}
 */
export function alignPermissions({ target, profileDir = '' } = {}) {
  const notes = [];
  let chmoded = 0;
  let chowned = 0;
  let chmodFailed = 0;
  let chownFailed = 0;
  if (!target) return { ok: false, chmoded, chowned, chmodFailed, chownFailed, notes: ['没有目标目录'] };

  // 目标 profile 的属主：插件文件应与它一致（DSH 以该用户运行）
  let uid = -1;
  let gid = -1;
  if (profileDir) {
    try {
      const st = statSync(profileDir);
      uid = st.uid;
      gid = st.gid;
    } catch {
      notes.push('读不到 profile 目录属主，跳过属主对齐');
    }
  }

  const entries = [{ path: target, dir: true }, ...walk(target)];
  for (const entry of entries) {
    // 权限：目录 755；文件保留已有可执行位（755），否则 644
    let mode = entry.dir ? DIR_MODE : FILE_MODE;
    if (!entry.dir) {
      try {
        const st = statSync(entry.path);
        if (st.mode & 0o111) mode = EXEC_MODE;
      } catch { /* 读不到就按普通文件处理 */ }
    }
    try {
      chmodSync(entry.path, mode);
      chmoded += 1;
    } catch {
      chmodFailed += 1;
    }
    // 属主：只在拿到有效 uid/gid 时尝试
    if (uid >= 0 && gid >= 0) {
      try {
        chownSync(entry.path, uid, gid);
        chowned += 1;
      } catch {
        chownFailed += 1;
      }
    }
  }

  if (chmodFailed) notes.push(`${chmodFailed} 个条目 chmod 失败（CIFS 等挂载上属正常，权限由挂载参数决定）`);
  if (chownFailed) notes.push(`${chownFailed} 个条目 chown 失败（非 root 或挂载不支持元数据）`);
  return { ok: chmodFailed === 0, chmoded, chowned, chmodFailed, chownFailed, notes };
}

/**
 * 读权限自检：确认宿主用户能读到同步出来的每个文件。
 * @returns {{ok: boolean, unreadable: string[], checked: number}}
 */
export function verifyReadable(target) {
  const unreadable = [];
  if (!target) return { ok: false, unreadable: [target], checked: 0 };
  const entries = [{ path: target, dir: true }, ...walk(target)];
  for (const entry of entries) {
    try {
      accessSync(entry.path, constants.R_OK);
    } catch {
      unreadable.push(entry.path);
    }
  }
  return { ok: unreadable.length === 0, unreadable: unreadable.slice(0, 20), checked: entries.length };
}
