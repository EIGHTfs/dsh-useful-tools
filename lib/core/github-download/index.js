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
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
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
import { buildMirrorUrl, classifyGithubUrl, directHint } from './channels.js';

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
async function downloadOnce(targetUrl, { savePath, timeoutMs, expectedSha256 }) {
  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(targetUrl, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
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
 * 工具入口。
 *
 * 返回结构化结果、不抛异常：通道全挂是可预期的运行状态（镜像会下线），
 * 让调用方拿到 attempts 明细比抛一个笼统的错误更有用。
 */
export async function runGithubDownload(args = {}, _toolCtx = {}) {
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

  const attempts = [];

  // 1) 直连。auto 模式先探测（raw / archive 能直连就省一次镜像中转）；
  //    direct 模式不探测，直接下——用户已明确指定，多一次往返没有意义。
  //    探测超时不超过下载超时：调用方把 timeoutMs 压小（例如测试）时，
  //    探测不该还按 4 秒硬等，否则总耗时与调用方设定的预算对不上。
  if (mode !== 'mirror') {
    const probeTimeoutMs = Math.min(DIRECT_PROBE_TIMEOUT_MS, timeoutMs);
    const directProbe = mode === 'auto' ? await probeDirect(classified.url, probeTimeoutMs) : null;
    if (directProbe) attempts.push({ channel: 'direct', phase: 'probe', ...directProbe });

    if (!directProbe || directProbe.ok) {
      const directResult = await downloadOnce(classified.url, { savePath, timeoutMs, expectedSha256 });
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
      const mirrorResult = await downloadOnce(buildMirrorUrl(mirror, classified.url), {
        savePath,
        timeoutMs,
        expectedSha256,
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
