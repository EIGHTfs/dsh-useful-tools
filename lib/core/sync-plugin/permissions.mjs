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
import { join, relative, sep } from 'node:path';

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
 *
 * `sourceRoot` 决定「以谁为准」——这是可执行位能不能保住的关键：
 *   有源根时按**源文件**的 mode 决定（源可执行 → 755，否则 644）；
 *   源里没有该文件（部署侧独有，例如被 git 忽略、由部署方提供的二进制）→ **不动它的 mode**，
 *   只对齐属主。理由：同步不接管这类文件的内容，也就没有资格替它决定权限。
 *   没给源根时退化为旧行为（按目标当前 mode 推断），仅为向后兼容保留。
 *
 * @param {{target: string, profileDir?: string, sourceRoot?: string}} params
 * @returns {{ok: boolean, chmoded: number, chowned: number, chmodFailed: number, chownFailed: number, preservedExternal: number, notes: string[]}}
 */
export function alignPermissions({ target, profileDir = '', sourceRoot = '' } = {}) {
  const notes = [];
  let chmoded = 0;
  let chowned = 0;
  let chmodFailed = 0;
  let chownFailed = 0;
  let preservedExternal = 0;
  if (!target) return { ok: false, chmoded, chowned, chmodFailed, chownFailed, preservedExternal, notes: ['没有目标目录'] };

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
    if (entry.dir) {
      // 目录统一 755（宿主需要能进入与列举）
      try {
        chmodSync(entry.path, DIR_MODE);
        chmoded += 1;
      } catch {
        chmodFailed += 1;
      }
    } else {
      const mode = decideFileMode(entry.path, { target, sourceRoot, counters: { onPreserved: () => { preservedExternal += 1; } } });
      if (mode !== null) {
        try {
          chmodSync(entry.path, mode);
          chmoded += 1;
        } catch {
          chmodFailed += 1;
        }
      }
    }
    // 属主：只在拿到有效 uid/gid 时尝试（跳过 chmod 的文件照样对齐属主）
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
  if (preservedExternal) {
    notes.push(`${preservedExternal} 个部署侧独有文件（源里没有）保持原权限未动 —— 这类文件由部署方提供，同步不替它决定 mode`);
  }
  return { ok: chmodFailed === 0, chmoded, chowned, chmodFailed, chownFailed, preservedExternal, notes };
}

/**
 * 决定单个文件应设成什么 mode。
 * @returns {number|null} 755 / 644；null 表示「不动它」
 */
function decideFileMode(filePath, { target, sourceRoot, counters }) {
  if (sourceRoot) {
    // 有源根：以源为准；源里没有 → 交还给部署侧，不动 mode
    const rel = relative(target, filePath).split(sep).join('/');
    const sourcePath = join(sourceRoot, rel);
    try {
      const sourceStat = statSync(sourcePath);
      return (sourceStat.mode & 0o111) ? EXEC_MODE : FILE_MODE;
    } catch {
      counters?.onPreserved?.();
      return null;
    }
  }
  // 无源根（旧调用）：按目标当前 mode 推断——这条路径无法区分「本来没有 x」与「复制时丢了 x」，
  //   所以新调用方都应传 sourceRoot。
  try {
    const st = statSync(filePath);
    return (st.mode & 0o111) ? EXEC_MODE : FILE_MODE;
  } catch {
    return FILE_MODE;
  }
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
