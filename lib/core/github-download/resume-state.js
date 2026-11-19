/**
 * 断点续传的状态与互斥
 *
 * 三件东西放在一起，因为它们必须一起成立，缺一个就会出坏文件：
 *   · `<savePath>.part`             —— 已收到的字节（数据本体）
 *   · `<savePath>.part.meta.json`   —— 这份分片属于**哪个版本**的文件（指纹）
 *   · `<savePath>.part.lock`        —— 同一路径同时只允许一个下载任务写
 *
 * 为什么必须有指纹：远端文件可能已经变了（同名 release 资产被新版本覆盖、raw 文件被改写），
 *   此时续传会把两个版本拼在一起 —— **这是续传最容易出坏文件的地方**，而且拼出来的文件
 *   大小看着对、内容全错。指纹不一致就清分片重下，宁可多下一次也不给出坏文件。
 *
 * 为什么以 `.part` 的**实际大小**为准而不是 meta 里记的 savedBytes：
 *   meta 与数据文件是两个写操作，崩溃可能只落其中一个。真实大小永远是数据文件的 stat，
 *   拿 meta 的记账值去发 Range 会要求一个并不存在的位置。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 分片 / 指纹 / 锁 三个伴生路径。 */
export function resumePaths(savePath) {
  const base = String(savePath || '');
  return {
    partPath: `${base}.part`,
    metaPath: `${base}.part.meta.json`,
    lockPath: `${base}.part.lock`,
  };
}

/**
 * 把「可能缺失的长度值」归一成数字或 null。
 *
 * 必须显式排除 null/undefined/空串再 Number()：`Number(null)` 是 **0**（不是 NaN），
 * 于是 `totalBytes: null` 会被当成「0 字节」——单测当场抓到过这个错。
 * 后果不只是显示错：指纹比对会拿 0 去和真实长度比，永远「不一致」，续传被永久禁用。
 */
function toFiniteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/** 已收到的字节数：以分片文件的真实大小为准（文件不存在即 0）。 */
export function resumeBytes(savePath) {
  const { partPath } = resumePaths(savePath);
  try {
    if (!existsSync(partPath)) return 0;
    const stat = statSync(partPath);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

/** 读指纹（缺失或损坏 → null，调用方按「不可续传」处理）。 */
export function readResumeMeta(savePath) {
  const { metaPath } = resumePaths(savePath);
  try {
    if (!existsSync(metaPath)) return null;
    const parsed = JSON.parse(readFileSync(metaPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      etag: typeof parsed.etag === 'string' ? parsed.etag : '',
      totalBytes: toFiniteOrNull(parsed.totalBytes),
      savedBytes: Number(parsed.savedBytes) || 0,
      url: typeof parsed.url === 'string' ? parsed.url : '',
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    };
  } catch {
    return null;
  }
}

/** 写指纹（失败静默：指纹写不进去的最坏后果是下次不续传，不该影响本次下载）。 */
export function writeResumeMeta(savePath, { etag = '', totalBytes = null, savedBytes = 0, url = '' } = {}) {
  const { metaPath } = resumePaths(savePath);
  try {
    mkdirSync(dirname(metaPath), { recursive: true });
    const payload = {
      version: 1,
      etag: String(etag || ''),
      totalBytes: toFiniteOrNull(totalBytes),
      savedBytes: Number(savedBytes) || 0,
      url: String(url || ''),
      updatedAt: new Date().toISOString(),
    };
    const tmp = `${metaPath}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    renameSync(tmp, metaPath);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

/** 清掉分片、指纹与锁（重下 / 完成后的收尾都走这里，避免留下孤儿文件）。 */
export function clearResumeState(savePath) {
  const { partPath, metaPath, lockPath } = resumePaths(savePath);
  for (const path of [partPath, metaPath, lockPath]) {
    try { rmSync(path, { force: true }); } catch { /* 删不掉不影响结论：下次会被指纹判为不可信 */ }
  }
}

/**
 * 远端这份文件是否还是分片对应的那一份。
 *
 * 判定口径（宽严取舍）：**只要有可比项就必须一致**；
 *   两个都拿不到（服务端既无 ETag 也无 Content-Length）⇒ 判为不可信、不续传。
 *   之所以不「拿不到指纹就照样续传」，是因为那等于把「远端变了」这个唯一能识别的情形放过去。
 */
export function isSameRemoteFile(meta, { etag = '', totalBytes = null } = {}) {
  if (!meta) return false;
  const metaEtag = String(meta.etag || '');
  const remoteEtag = String(etag || '');
  const metaTotal = toFiniteOrNull(meta.totalBytes);
  const remoteTotal = toFiniteOrNull(totalBytes);
  if (metaEtag && remoteEtag) return metaEtag === remoteEtag;
  if (metaTotal !== null && remoteTotal !== null) return metaTotal === remoteTotal;
  // 两个可选项都没有可比对象：无法证明是同一个文件，按不可信处理
  return false;
}

/* ───────── 同路径互斥 ───────── */

/**
 * 进程内占位表。为什么要进程内 + 文件双保险：
 *   · 进程内 Map 挡住同进程并发（快、无 IO）；
 *   · 锁文件挡跨进程（另一个 DSH 实例 / CLI 同时下同一个文件），否则两边交替 append 会交叉损坏。
 */
const inFlight = new Map();

/**
 * 尝试拿到这个 savePath 的下载权。
 * @returns {{ok: true, release: Function} | {ok: false, error: string}}
 */
export function acquireResumeLock(savePath) {
  const base = String(savePath || '');
  if (!base) return { ok: false, error: 'savePath 为空，无法加锁' };
  if (inFlight.has(base)) return { ok: false, error: '该文件已有下载任务在进行（本进程）' };
  const { lockPath } = resumePaths(base);
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
    if (existsSync(lockPath)) {
      const holder = safeReadLock(lockPath);
      // 持锁进程还活着 → 拒绝；已死（崩溃残留）→ 接管
      if (holder && isProcessAlive(holder.pid)) {
        return { ok: false, error: `该文件已有下载任务在进行（pid ${holder.pid}）` };
      }
    }
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), 'utf8');
  } catch (error) {
    return { ok: false, error: `无法创建下载锁：${String(error?.message || error)}` };
  }
  inFlight.set(base, true);
  let released = false;
  return {
    ok: true,
    release() {
      if (released) return;
      released = true;
      inFlight.delete(base);
      try { rmSync(lockPath, { force: true }); } catch { /* 残留锁会被 pid 判活逻辑接管 */ }
    },
  };
}

function safeReadLock(lockPath) {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8'));
    return { pid: Number(parsed?.pid) || 0, at: parsed?.at || '' };
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 进程存在但无权限（同样是活着）
    return error?.code === 'EPERM';
  }
}
