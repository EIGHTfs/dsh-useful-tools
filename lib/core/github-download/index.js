/**
 * 工具实现：github_download —— GitHub 资源下载的通道自动选择
 *
 * 解决什么问题：本机直连 `release-assets.githubusercontent.com`（GitHub Releases
 * 资产的 302 落地域）会被 TLS SNI 阻断，表现为连接挂住直到超时；而公共镜像的
 * **前缀模式**（`https://ghfast.top/<原始 URL>`）能正常取回文件。手工拼前缀容易忘、
 * 也记不住哪家还活着，所以把「选通道」做成工具。
 *
 * 接管边界（写清楚，避免误期待）：
 * - 接管的是「调用本工具下载」这条路径；用 bash 手敲 curl 不会被改写。
 * - 系统级全局接管做不到：阻断在 TLS 层，镜像不是标准 HTTP 代理，只有 MITM 能改写。
 *
 * 通道策略：auto 模式下先探测直连（raw / archive 本机可直连，能省一次镜像中转），
 * 不通再按候选清单轮换镜像；每次结果回写候选清单做失败学习（连续失败自动停用）。
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  normalizeMirror,
  readCandidates,
  recordProbe,
  usableCandidates,
  writeCandidates,
} from '../github-mirror/store.js';
import { buildMirrorUrl, classifyGithubUrl, directHint, parseContentRange, supportsResume } from './channels.js';
import { buildDownloadJobSpec, startHostJob } from './job.js';
import {
  acquireResumeLock, clearResumeState, readResumeMeta, resumeBytes, resumePaths, writeResumeMeta,
} from './resume-state.js';

// 直连探测超时。阻断的表现是「连接挂住不返回」，4 秒足够区分「慢」与「不通」，
// 又不会让每次下载都先干等太久。
const DIRECT_PROBE_TIMEOUT_MS = 4000;

// 镜像探测超时。只取响应头就断开，正常镜像应在数秒内响应。
const MIRROR_PROBE_TIMEOUT_MS = 8000;

// 单次下载超时。5 分钟可容纳几十 MB 的资产；更大体量应改用别的通道
//（例如在 CI 里下载后转存），而不是把超时继续放大。
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 300000;

// 通道模式：auto 先探直连再轮换镜像；direct / mirror 只走单一路径。
const CHANNEL_MODES = ['auto', 'direct', 'mirror'];

/** 统一把异常压成一行可读文本（工具返回里不放堆栈）。 */
function toErrorText(error) {
  if (!error) return '未知错误';
  if (error.name === 'TimeoutError') return '超时';
  if (error.name === 'AbortError') return '被中止';
  const cause = error.cause && (error.cause.code || error.cause.message);
  return String(cause || error.message || error).slice(0, 300);
}

/** 把用户传的 channel 归一化，非法值回落到 auto（工具不因参数写错就整体失败）。 */
function normalizeMode(rawMode) {
  const text = String(rawMode ?? '').trim().toLowerCase();
  return CHANNEL_MODES.includes(text) ? text : 'auto';
}

/** 超时归一化：非正数 / 非数字都回落到默认值。 */
function normalizeTimeout(rawTimeoutMs) {
  const parsed = Number(rawTimeoutMs);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DOWNLOAD_TIMEOUT_MS;
  return Math.trunc(parsed);
}

/** 人类可读的体积文本，省得调用方自己换算。 */
function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * 决定落盘路径。
 *
 * 缺省用「当前工作目录 + URL 文件名」——AI 在项目里干活时路径可预测，
 * 比落到系统下载目录更容易被后续步骤引用。显式 savePath 相对路径也按 cwd 解析。
 */
function resolveSavePath(rawSavePath, fileName, rawCwd) {
  const baseDir = String(rawCwd ?? '').trim() || process.cwd();
  const explicit = String(rawSavePath ?? '').trim();
  if (explicit) return resolve(baseDir, explicit);
  if (!fileName) return '';
  return resolve(baseDir, fileName);
}

/**
 * 探测直连是否可用。
 *
 * 用 HEAD + follow 重定向：release 资产会 302 到被拦的域，重定向后连接挂住直到超时，
 * 正好得到「不可直连」的结论；而 raw / archive 直接返回 200。
 * 405 也算可达（服务器在，只是不支持 HEAD），真正的可用性交给下载阶段判定。
 */
async function probeDirect(url, timeoutMs) {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const reachable = response.ok || response.status === 405;
    return {
      ok: reachable,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      error: reachable ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return { ok: false, status: 0, elapsedMs: Date.now() - startedAt, error: toErrorText(error) };
  }
}

/**
 * 探测镜像是否可用：拿到响应头立刻掐断 body。
 *
 * 不能用 Range 探测——实测 ghfast.top 不透传 Range，带 Range 请求会返回整个文件，
 * 探测就变成了一次真下载。拿头即断既准确又不会浪费流量。
 */
async function probeMirror(targetUrl, timeoutMs) {
  const startedAt = Date.now();
  try {
    const response = await fetch(targetUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    try {
      await response.body?.cancel();
    } catch {
      // 取消失败不影响「服务器有响应」这个结论，忽略。
    }
    return {
      ok: response.ok,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return { ok: false, status: 0, elapsedMs: Date.now() - startedAt, error: toErrorText(error) };
  }
}

/**
 * 从某个地址下载到 savePath（流式，不整份进内存）。
 *
 * 失败时删掉半截文件：文件存在且非零会被后续步骤误判成「下载成功」，
 * 这个坑比「没有文件」更难排查。
 */
/**
 * 合成「超时 + 外部中止」两个信号。
 *
 * 为什么不能只用 AbortSignal.timeout：注册成后台 job 后，job_kill 必须能真的掐断
 * 正在进行的传输，否则「取消」只是改了标记、进程还会跑到超时才退出。
 * Node 20 早于 20.3 没有 AbortSignal.any，故保留手动转发的兜底分支。
 */
function combineSignals(timeoutMs, externalSignal) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!externalSignal) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([timeoutSignal, externalSignal]);
  const controller = new AbortController();
  const forward = () => controller.abort();
  timeoutSignal.addEventListener('abort', forward, { once: true });
  externalSignal.addEventListener('abort', forward, { once: true });
  return controller.signal;
}

async function downloadOnce(targetUrl, { savePath, timeoutMs, expectedSha256, signal, onProgress }) {
  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(targetUrl, { redirect: 'follow', signal: combineSignals(timeoutMs, signal) });
  } catch (error) {
    return { ok: false, status: 0, elapsedMs: Date.now() - startedAt, error: toErrorText(error) };
  }

  if (!response.ok || !response.body) {
    try {
      await response.body?.cancel();
    } catch {
      // 同上，忽略。
    }
    return {
      ok: false,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      error: response.body ? `HTTP ${response.status}` : `HTTP ${response.status}（响应体为空）`,
    };
  }

  mkdirSync(dirname(savePath), { recursive: true });

  const hasher = createHash('sha256');
  let bytesWritten = 0;
  const measuring = new Transform({
    transform(chunk, _encoding, callback) {
      bytesWritten += chunk.length;
      hasher.update(chunk);
      // 进度回调只用于后台 job 的 updateProgress；抛错不能影响传输本身
      if (typeof onProgress === 'function') {
        try { onProgress(bytesWritten); } catch { /* 忽略进度回调异常 */ }
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(response.body), measuring, createWriteStream(savePath));
  } catch (error) {
    try {
      rmSync(savePath, { force: true });
    } catch {
      // 删不掉就如实保留错误信息，让调用方看到。
    }
    return { ok: false, status: response.status, elapsedMs: Date.now() - startedAt, error: toErrorText(error) };
  }

  if (bytesWritten === 0) {
    try {
      rmSync(savePath, { force: true });
    } catch {
      // 同上。
    }
    return { ok: false, status: response.status, elapsedMs: Date.now() - startedAt, error: '响应体为 0 字节' };
  }

  const sha256 = hasher.digest('hex');
  const expected = String(expectedSha256 ?? '').trim().toLowerCase();
  if (expected && sha256 !== expected) {
    try {
      rmSync(savePath, { force: true });
    } catch {
      // 同上。
    }
    return {
      ok: false,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      error: `sha256 不匹配：期望 ${expected}，实得 ${sha256}`,
      sha256,
    };
  }

  return { ok: true, status: response.status, bytes: bytesWritten, sha256, elapsedMs: Date.now() - startedAt };
}

/** 流式计算文件 sha256（续传后必须重算：Hash 对象无法从中间状态续算）。 */
function hashFile(filePath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hasher = createHash('sha256');
    createReadStream(filePath)
      .on('data', (chunk) => hasher.update(chunk))
      .on('error', rejectPromise)
      .on('end', () => resolvePromise(hasher.digest('hex')));
  });
}

// 导出供单测直接驱动：续传要覆盖 206/200/416/指纹变化四种响应，只能在本地 server 上模拟；
//   若走 executeDownload 则必须先构造 GitHub 域名（classifyGithubUrl 会拒绝本地地址），
//   于是「测不到真实分支」。把它俩当内部 API 暴露是有意的，不要当成稳定对外接口。
export { downloadToPart, downloadWithResume };

/**
 * 带续传的下载：在已有 `.part` 的基础上接着下。
 *
 * 为什么单独成函数而不塞进 downloadOnce：downloadOnce 的模型是「一次流式覆盖写」，
 *   续传需要 append + 响应码分支 + 完成后重算与 rename，混进去会把两条语义拧在一起。
 *   分开之后 downloadOnce 保持原样（零回归），本函数只负责「能续就续」。
 *
 * 安全设计两条，缺一不可：
 *   ① 请求带 `If-Range: <etag>` —— 让**服务端**判断远端是否已变：变了它回 200 整包，
 *      而不是给一段属于新版本、却接在旧分片后面的 206；
 *   ② 即使回 206，也要校验 `Content-Range` 的 start 与本地分片大小**完全相等**，
 *      否则拼接位置就是错的。
 *   任一不成立都宁可清分片重下——多下一次远好于交付一个坏文件。
 *
 * @returns {Promise<null | {fallbackToFull: true, reason: string} | object>}
 *   `null` = 没有可续分片，调用方直接走整下。
 */
async function downloadWithResume(targetUrl, { savePath, timeoutMs, expectedSha256, signal, onProgress }) {  const haveBytes = resumeBytes(savePath);
  const meta = readResumeMeta(savePath);
  if (!haveBytes || !meta) return null;

  const { partPath } = resumePaths(savePath);
  const startedAt = Date.now();
  const headers = { Range: `bytes=${haveBytes}-` };
  if (meta.etag) headers['If-Range'] = meta.etag;

  let response;
  try {
    response = await fetch(targetUrl, { redirect: 'follow', headers, signal: combineSignals(timeoutMs, signal) });
  } catch (error) {
    return { ok: false, status: 0, elapsedMs: Date.now() - startedAt, error: toErrorText(error), resumedFrom: haveBytes };
  }

  const discard = async () => { try { await response.body?.cancel(); } catch { /* 忽略 */ } };

  // 200：服务端忽略 Range，或 If-Range 判定远端已变 → 分片作废，改整包重下
  if (response.status === 200) {
    await discard();
    clearResumeState(savePath);
    return { fallbackToFull: true, reason: '服务端返回 200（忽略 Range 或远端文件已变），改为整包重下' };
  }
  // 416：Range 越界（分片比远端还大，或已完整但没通过校验）→ 同样作废
  if (response.status === 416) {
    await discard();
    clearResumeState(savePath);
    return { fallbackToFull: true, reason: '服务端返回 416（分片越界），改为整包重下' };
  }
  if (response.status !== 206 || !response.body) {
    await discard();
    return {
      ok: false,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      error: `续传请求异常：HTTP ${response.status}`,
      resumedFrom: haveBytes,
    };
  }

  const range = parseContentRange(response.headers.get('content-range'));
  if (!range || range.start !== haveBytes) {
    await discard();
    clearResumeState(savePath);
    return {
      fallbackToFull: true,
      reason: `Content-Range 不可信（${response.headers.get('content-range') || '缺失'}，期望起点 ${haveBytes}），改为整包重下`,
    };
  }

  mkdirSync(dirname(partPath), { recursive: true });
  let writtenThisRound = 0;
  const measuring = new Transform({
    transform(chunk, _encoding, callback) {
      writtenThisRound += chunk.length;
      if (typeof onProgress === 'function') {
        try { onProgress(haveBytes + writtenThisRound); } catch { /* 进度回调异常不影响传输 */ }
      }
      callback(null, chunk);
    },
  });

  try {
    // append：分片里已有 haveBytes，新字节接在后面
    await pipeline(Readable.fromWeb(response.body), measuring, createWriteStream(partPath, { flags: 'a' }));
  } catch (error) {
    // 又断了：**保留分片**（这正是续传的意义），下次还能接着来
    return {
      ok: false,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      error: toErrorText(error),
      resumedFrom: haveBytes,
      keptPartial: true,
    };
  }

  // 完成校验①：总长必须与 Content-Range 声明一致（半截文件绝不能当成功）
  const finalBytes = (() => { try { return statSync(partPath).size; } catch { return 0; } })();
  if (range.total !== null && finalBytes !== range.total) {
    clearResumeState(savePath);
    return {
      ok: false,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      error: `续传后大小不符：期望 ${range.total}，实得 ${finalBytes}`,
    };
  }

  // 完成校验②：sha256 无法增量续算，只能重读整个文件（多一次读盘，仍远便宜于重下）
  let sha256 = '';
  if (String(expectedSha256 || '').trim()) {
    try {
      sha256 = await hashFile(partPath);
    } catch (error) {
      clearResumeState(savePath);
      return { ok: false, status: response.status, elapsedMs: Date.now() - startedAt, error: `续传后校验失败：${toErrorText(error)}` };
    }
    if (sha256 !== String(expectedSha256).trim().toLowerCase()) {
      clearResumeState(savePath);
      return {
        ok: false,
        status: response.status,
        elapsedMs: Date.now() - startedAt,
        error: `sha256 不匹配：期望 ${expectedSha256}，实得 ${sha256}`,
        sha256,
      };
    }
  }

  try {
    renameSync(partPath, savePath);
    clearResumeState(savePath);
  } catch (error) {
    return { ok: false, status: response.status, elapsedMs: Date.now() - startedAt, error: `续传完成但落盘失败：${toErrorText(error)}` };
  }

  return { ok: true, status: response.status, bytes: finalBytes, sha256, elapsedMs: Date.now() - startedAt, resumedFrom: haveBytes };
}

/**
 * 整包下载但落到 `.part`：为「中断后可续」铺路。
 *
 * 为什么不直接用 downloadOnce 写 savePath：那条路径失败会删文件，等于每次中断都从头再来。
 *   续传的收益必须从**第一次**下载就开始积累，否则「首下断了」这个最常见的场景仍然没救。
 * 写完仍 rename 到 savePath：调用方看到的产物位置与行为不变。
 */
async function downloadToPart(targetUrl, { savePath, timeoutMs, expectedSha256, signal, onProgress }) {
  const { partPath } = resumePaths(savePath);
  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(targetUrl, { redirect: 'follow', signal: combineSignals(timeoutMs, signal) });
  } catch (error) {
    return { ok: false, status: 0, elapsedMs: Date.now() - startedAt, error: toErrorText(error) };
  }
  if (!response.ok || !response.body) {
    try { await response.body?.cancel(); } catch { /* 忽略 */ }
    return { ok: false, status: response.status, elapsedMs: Date.now() - startedAt, error: `HTTP ${response.status}` };
  }

  // 先落指纹再收流：ETag 与总长是「下次能不能续」的唯一依据，拿到就写盘
  const etag = String(response.headers.get('etag') || '');
  const totalRaw = Number(response.headers.get('content-length'));
  const totalBytes = Number.isFinite(totalRaw) ? totalRaw : null;
  writeResumeMeta(savePath, { etag, totalBytes, savedBytes: 0, url: targetUrl });

  mkdirSync(dirname(partPath), { recursive: true });
  const hasher = createHash('sha256');
  let bytesWritten = 0;
  const measuring = new Transform({
    transform(chunk, _encoding, callback) {
      bytesWritten += chunk.length;
      hasher.update(chunk);
      if (typeof onProgress === 'function') {
        try { onProgress(bytesWritten); } catch { /* 进度回调异常不影响传输 */ }
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(response.body), measuring, createWriteStream(partPath));
  } catch (error) {
    // 中断：**保留** .part 与 meta（下次续传的起点），不再删文件
    writeResumeMeta(savePath, { etag, totalBytes, savedBytes: bytesWritten, url: targetUrl });
    return { ok: false, status: response.status, elapsedMs: Date.now() - startedAt, error: toErrorText(error), keptPartial: true };
  }

  if (bytesWritten === 0) {
    clearResumeState(savePath);
    return { ok: false, status: response.status, elapsedMs: Date.now() - startedAt, error: '响应体为 0 字节' };
  }

  const sha256 = hasher.digest('hex');
  const expected = String(expectedSha256 ?? '').trim().toLowerCase();
  if (expected && sha256 !== expected) {
    clearResumeState(savePath);
    return {
      ok: false,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      error: `sha256 不匹配：期望 ${expected}，实得 ${sha256}`,
      sha256,
    };
  }

  try {
    renameSync(partPath, savePath);
    clearResumeState(savePath);
  } catch (error) {
    return { ok: false, status: response.status, elapsedMs: Date.now() - startedAt, error: `落盘失败：${toErrorText(error)}` };
  }

  return { ok: true, status: response.status, bytes: bytesWritten, sha256, elapsedMs: Date.now() - startedAt };
}

/** 组装成功结果。 */
function buildSuccess(classified, { channel, mirror, savePath, result, attempts, startedAt }) {
  return {
    ok: true,
    url: classified.url,
    kind: classified.kind,
    channel,
    mirror: mirror || null,
    savePath,
    bytes: result.bytes,
    sizeText: formatBytes(result.bytes),
    sha256: result.sha256,
    elapsedMs: Date.now() - startedAt,
    attempts,
  };
}

/** dryRun：只探通道不落盘，给出推荐路径。 */
async function buildProbeReport(classified, { mode, explicitMirror }) {
  const startedAt = Date.now();
  const directProbe = mode === 'mirror' ? null : await probeDirect(classified.url, DIRECT_PROBE_TIMEOUT_MS);

  const candidates = explicitMirror
    ? [explicitMirror]
    : usableCandidates(readCandidates()).map((item) => item.mirror);

  const mirrorProbes = [];
  if (mode !== 'direct') {
    for (const mirror of candidates) {
      const probe = await probeMirror(buildMirrorUrl(mirror, classified.url), MIRROR_PROBE_TIMEOUT_MS);
      mirrorProbes.push({ mirror, ...probe });
    }
  }

  let recommended = null;
  if (directProbe?.ok) recommended = 'direct';
  else if (mirrorProbes.some((item) => item.ok)) {
    recommended = mirrorProbes.find((item) => item.ok).mirror;
  }

  return {
    ok: true,
    dryRun: true,
    url: classified.url,
    kind: classified.kind,
    fileName: classified.fileName,
    directHint: directHint(classified.kind),
    direct: directProbe,
    mirrors: mirrorProbes,
    recommended,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * 执行下载（同步语义）：直连优先 → 镜像轮换。
 *
 * 抽成独立函数是为了让「前台同步调用」与「后台 job 内执行」共用同一段逻辑——
 * 两处各写一份必然漂移，而且取消与进度支持只会落在其中一边。
 * @param {AbortSignal} [opts.signal] 外部中止信号（job_kill 用）
 * @param {(bytes: number) => void} [opts.onProgress] 已写字节数回调（job 进度用）
 */
async function executeDownload(args = {}, { signal = null, onProgress = null } = {}) {
  const startedAt = Date.now();
  const classified = classifyGithubUrl(args.url);
  if (!classified.ok) {
    return { ok: false, error: classified.reason, hint: 'url 必须是 GitHub 的下载地址（release 资产 / raw / archive）' };
  }

  const mode = normalizeMode(args.channel);
  const explicitMirror = normalizeMirror(args.mirror);
  const timeoutMs = normalizeTimeout(args.timeoutMs);
  const expectedSha256 = String(args.sha256 ?? '').trim();
  const savePath = resolveSavePath(args.savePath, classified.fileName, args.cwd);

  if (!savePath) {
    return { ok: false, error: '无法从 URL 推断文件名，请显式传 savePath', url: classified.url };
  }

  if (args.dryRun === true) {
    return buildProbeReport(classified, { mode, explicitMirror });
  }

  // 取消后不再继续尝试剩余通道：实测 job_kill 一次大文件下载时，取消只中断了当前那一条，
  //   后面还挨个轮换，最后报「所有通道都失败（尝试 5 次）」——既浪费时间与流量，
  //   又把「用户主动取消」掩盖成「网络全挂」。所以每次尝试前先看信号。
  const isCancelled = () => signal?.aborted === true;
  const cancelledResult = (attempts, startedAtValue) => ({
    ok: false,
    cancelled: true,
    url: classified.url,
    kind: classified.kind,
    error: '已取消（用户中止下载）',
    attempts,
    elapsedMs: Date.now() - startedAtValue,
  });

  const attempts = [];

  // 1) 直连。auto 模式先探测（raw / archive 能直连就省一次镜像中转）；
  //    direct 模式不探测，直接下——用户已明确指定，多一次往返没有意义。
  //    探测超时不超过下载超时：调用方把 timeoutMs 压小（例如测试）时，
  //    探测不该还按 4 秒硬等，否则总耗时与调用方设定的预算对不上。
  if (mode !== 'mirror') {
    if (isCancelled()) return cancelledResult(attempts, startedAt);
    const probeTimeoutMs = Math.min(DIRECT_PROBE_TIMEOUT_MS, timeoutMs);
    const directProbe = mode === 'auto' ? await probeDirect(classified.url, probeTimeoutMs) : null;
    if (directProbe) attempts.push({ channel: 'direct', phase: 'probe', ...directProbe });

    if (!directProbe || directProbe.ok) {
      // 续传只在「确认支持 Range 的通道」上启用（raw 直连）；镜像通道维持既有行为，
      //   这样改动面最小，也不会因为镜像忽略 Range 而把整包 append 到半截文件后面。
      // args.resume === false 可强制整下：排错时先关掉续传做对比，能立刻区分
      //   「续传拼错了」与「远端文件本身有问题」。
      const canResume = args.resume !== false && supportsResume({ channel: 'direct', kind: classified.kind });
      const lock = canResume ? acquireResumeLock(savePath) : null;
      if (lock && lock.ok === false) {
        return { ok: false, error: lock.error, url: classified.url, kind: classified.kind, savePath };
      }
      try {
        let directResult = null;
        if (canResume) {
          const resumed = await downloadWithResume(classified.url, { savePath, timeoutMs, expectedSha256, signal, onProgress });
          if (resumed && !resumed.fallbackToFull) {
            directResult = resumed;
            attempts.push({
              channel: 'direct',
              phase: 'resume',
              ok: resumed.ok,
              status: resumed.status,
              resumedFrom: resumed.resumedFrom ?? 0,
              elapsedMs: resumed.elapsedMs,
              error: resumed.error ?? null,
            });
          } else {
            // 首次下载，或服务端判定不可续（200/416/Content-Range 不可信）→ 走整下到 .part，
            //   这样「这一次」断了，下一次仍然有分片可续。
            if (resumed?.fallbackToFull) {
              attempts.push({ channel: 'direct', phase: 'resume-skipped', ok: false, error: resumed.reason });
            }
            directResult = await downloadToPart(classified.url, { savePath, timeoutMs, expectedSha256, signal, onProgress });
          }
        } else {
          directResult = await downloadOnce(classified.url, { savePath, timeoutMs, expectedSha256, signal, onProgress });
        }
        attempts.push({
          channel: 'direct',
          phase: 'download',
          ok: directResult.ok,
          status: directResult.status,
          elapsedMs: directResult.elapsedMs,
          error: directResult.error ?? null,
        });
        if (directResult.ok) {
          return buildSuccess(classified, { channel: 'direct', mirror: null, savePath, result: directResult, attempts, startedAt });
        }
      } finally {
        lock?.release?.();
      }
    }
  }

  // 2) 镜像轮换。显式指定的只本次使用、不写回清单；清单里的每次结果都做失败学习。
  if (mode !== 'direct') {
    let workingList = readCandidates();
    const candidates = explicitMirror
      ? [explicitMirror]
      : usableCandidates(workingList).map((item) => item.mirror);

    if (!candidates.length) {
      attempts.push({
        channel: 'mirror',
        ok: false,
        error: explicitMirror ? '显式指定的镜像为空' : '候选清单为空或已全部停用',
      });
    }

    for (const mirror of candidates) {
      if (isCancelled()) return cancelledResult(attempts, startedAt);
      const mirrorResult = await downloadOnce(buildMirrorUrl(mirror, classified.url), {
        savePath,
        timeoutMs,
        expectedSha256,
        signal,
        onProgress,
      });
      attempts.push({
        channel: 'mirror',
        mirror,
        ok: mirrorResult.ok,
        status: mirrorResult.status,
        elapsedMs: mirrorResult.elapsedMs,
        error: mirrorResult.error ?? null,
      });

      if (!explicitMirror) {
        workingList = recordProbe(workingList, mirror, { ok: mirrorResult.ok, error: mirrorResult.error ?? null });
        writeCandidates(workingList);
      }

      if (mirrorResult.ok) {
        return buildSuccess(classified, { channel: 'mirror', mirror, savePath, result: mirrorResult, attempts, startedAt });
      }
    }
  }

  return {
    ok: false,
    url: classified.url,
    kind: classified.kind,
    error: `所有通道都失败（尝试 ${attempts.length} 次）`,
    attempts,
    elapsedMs: Date.now() - startedAt,
    hint: '可先用 dryRun=true 看各通道探测结果；镜像全挂时考虑在 CI 里下载后转存',
  };
}

/**
 * 工具入口：默认把下载注册为宿主后台 job，`background:false` 才同步执行。
 *
 * 为什么默认后台：Release 资产动辄几十上百 MB，同步等待会把工具调用整个卡住。
 * 注册成 job 后立即拿到 jobId，调用方用宿主原生的 job_output / job_list / job_kill
 * 跟进与中止（与 git_clone、npm_publish 一致）。
 *
 * 降级策略：宿主没有 jobs 服务、或注册两步都失败时，**不报错**，退回同步执行，
 * 并把 `jobFallback: true` 与 `jobFallbackReason` 带回——静默降级会让「为什么没有 jobId」
 * 变成只能靠猜的问题。dryRun 永远走同步：它只探通道、不下载，没有后台化的意义。
 */
export async function runGithubDownload(args = {}, toolCtx = {}) {
  const wantsBackground = args.background !== false;
  const jobs = toolCtx?.jobs;
  const canUseJobs = wantsBackground && jobs && typeof jobs.start === 'function' && args.dryRun !== true;

  if (!canUseJobs) {
    const result = await executeDownload(args);
    // dryRun 只探通道、没有「执行与否」之分，不加 async 标记；
    //   真正同步下载时明确回 async:false，让调用方一眼看出「没走后台」而不是去等一个不存在的 jobId。
    return args.dryRun === true ? result : { ...result, async: false };
  }

  // 先做一遍轻量校验：URL 不合法或推不出文件名时直接返回，不必为它注册一个注定失败的 job
  const classified = classifyGithubUrl(args.url);
  if (!classified.ok) {
    return { ok: false, error: classified.reason, hint: 'url 必须是 GitHub 的下载地址（release 资产 / raw / archive）' };
  }
  const savePath = resolveSavePath(args.savePath, classified.fileName, args.cwd);
  if (!savePath) {
    return { ok: false, error: '无法从 URL 推断文件名，请显式传 savePath', url: classified.url };
  }

  const spec = buildDownloadJobSpec(
    { url: classified.url, fileName: classified.fileName, savePath },
    (signal, onProgress) => executeDownload(args, { signal, onProgress }),
  );
  const started = startHostJob(jobs, spec, toolCtx?.owner);

  if (started.jobId) {
    return {
      ok: true,
      async: true,
      jobId: started.jobId,
      url: classified.url,
      kind: classified.kind,
      savePath,
      hint: `已注册宿主后台 job（下载中，完成会自动返回）；查进度：job_output ${started.jobId}；中止：job_kill ${started.jobId}`,
    };
  }

  // 两条注册路径都失败 → 同步执行，但把原因带回去
  const result = await executeDownload(args);
  return { ...result, async: false, jobFallback: true, jobFallbackReason: started.error };
}
