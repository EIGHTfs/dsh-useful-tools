/**
 * 从 GitHub 上游增量更新「已安装插件目录」（API 通道）
 *
 * 需求：装机版插件（如 node_modules 里的 github: 依赖产物）落后上游时，
 * 用 GitHub API 算出**变动文件**，只覆盖这些文件到安装路径——不 clone、
 * 不落 .git、不动其它文件。
 *
 * 为什么可行（2026-11-05 实测）：
 * - `api.github.com` 本机可直连，`git/trees?recursive=1` 一次带回全仓 blob sha；
 * - 本地文件自算 git blob sha（`sha1("blob <len>\0" + content)`）与远端 sha 逐一对齐，
 *   **零下载就能精确 diff 出「哪些文件变了、哪些是新增、哪些本地多余」**；
 * - 内容走 `raw.githubusercontent.com`（本机直连可达；不可达时按候选清单轮换镜像前缀，
 *   复用 github_mirror 的 candidates.json），下载后仍用 blob sha 校验，防镜像给脏内容。
 *
 * 覆盖前的两条安全线：
 * - 缺省 dryRun 只报差异；`write:true` 才落盘（与 sync_plugin 现有语义一致）。
 * - 真写前把被覆盖的旧文件备份进数据根，可随时还原。
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';

import { usableCandidates, readCandidates } from '../github-mirror/store.js';
import { buildMirrorUrl } from '../github-download/channels.js';

/** api.github.com 请求超时（它本机可直连，8 秒不通就是网络问题，不必干等）。 */
const API_TIMEOUT_MS = 8000;

/** raw 直连探测超时；被拦域名（release-assets）的表现是挂起，4 秒足够判别。 */
const RAW_DIRECT_TIMEOUT_MS = 6000;

/** 单文件下载超时。插件代码文件多为 KB 级，30 秒已宽。 */
const FILE_DOWNLOAD_TIMEOUT_MS = 30000;

/** 单次更新允许下载的最大文件数——防「整个 docs/ 图片目录都算新增」式失控。 */
const MAX_FILES_PER_SYNC = 50;

/** npm 始终会打进包里的顶层文件（白名单之外也包含，语义与 npm pack 对齐）。 */
const NPM_ALWAYS_INCLUDED_TOP = [/^package\.json$/, /^(readme|license|licence|changelog)(\..+)?$/i];

/** git blob sha：`sha1("blob " + 字节数 + "\0" + 内容)`，与远端 API 的 sha 同口径。 */
export function blobSha(buffer) {
  return createHash('sha1').update(`blob ${buffer.length}\u0000`).update(buffer).digest('hex');
}

/**
 * 解析 fromGithub 入参为 `owner/repo`。
 * 接受简写、https 地址（含 ghfast 这类镜像前缀）、ssh 形态；只认 github.com——
 * API 增量模式是 GitHub 专属，其它 git 主机没有对应 API，如实拒绝而不是假装支持。
 *
 * 用户习惯直接粘贴浏览器的仓库页地址（`https://github.com/a/b`、`https://github.com/a/b/tree/main`、
 * `.../releases`、`.../actions`），所以只取路径前两段当 owner/repo，后面的都忽略——
 * 这比严格匹配整条正则更贴近真实输入，也不会因为地址多个尾斜杠就解析失败。
 */
export function parseGithubRepo(input) {
  const text = String(input ?? '').trim();
  if (!text) return { ok: false, reason: 'fromGithub 不能为空' };
  // git@github.com:owner/repo(.git)
  const ssh = text.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (ssh) return { ok: true, repo: `${ssh[1]}/${ssh[2]}` };
  let urlText = text;
  // 剥掉可能已有的镜像前缀（https://ghfast.top/https://github.com/...）
  for (let guard = 0; guard < 3; guard += 1) {
    const peeled = urlText.match(/^https?:\/\/[^/]+\/(https?:\/\/.+)$/);
    if (!peeled || peeled[1] === urlText) break;
    urlText = peeled[1];
  }
  let parsed;
  try {
    parsed = new URL(urlText);
  } catch {
    parsed = null;
  }
  if (parsed) {
    if (parsed.hostname.toLowerCase() !== 'github.com' && parsed.hostname.toLowerCase() !== 'www.github.com') {
      return { ok: false, reason: `不是 github.com 地址（${parsed.hostname}）；API 增量模式只支持 GitHub` };
    }
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 2) return { ok: false, reason: `地址里没有 owner/repo 两段（${parsed.pathname}）` };
    const owner = segments[0];
    const repo = segments[1].replace(/\.git$/, '');
    return { ok: true, repo: `${owner}/${repo}` };
  }
  const short = text.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (short) return { ok: true, repo: `${short[1]}/${short[2]}` };
  return { ok: false, reason: `无法从 "${text.slice(0, 120)}" 解析 owner/repo（支持简写、https/ssh 地址）` };
}

/** 调 api.github.com；非 2xx 与网络错误都返回 {ok:false, status, error}，不抛。 */
async function githubApi(apiPath, { apiBase = 'https://api.github.com', fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(`${apiBase}${apiPath}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-useful-tools-sync' },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!response.ok) {
      const isRateLimit = response.status === 403 || response.status === 429;
      return {
        ok: false,
        status: response.status,
        error: isRateLimit
          ? `api.github.com 限流（HTTP ${response.status}，未认证 60 次/小时）——稍后重试，或给请求带上凭据`
          : `api.github.com HTTP ${response.status}`,
      };
    }
    return { ok: true, json: await response.json() };
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? '超时' : String(error?.message || error);
    return { ok: false, status: 0, error: `api.github.com 不可达：${reason}` };
  }
}

/** 取仓库默认分支（ref 省略时用）。 */
export async function fetchDefaultBranch(repo, deps = {}) {
  const result = await githubApi(`/repos/${repo}`, deps);
  if (!result.ok) return result;
  const branch = result.json?.default_branch;
  return branch ? { ok: true, branch } : { ok: false, error: '仓库信息里没有 default_branch' };
}

/**
 * 取远端文件树（递归），返回 path → {sha,size}。
 * truncated=true 时如实失败——半截清单算出的 diff 会把「没列出来的」误判成删除。
 */
export async function fetchRemoteTrees(repo, ref, deps = {}) {
  const result = await githubApi(`/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, deps);
  if (!result.ok) return result;
  const tree = Array.isArray(result.json?.tree) ? result.json.tree : [];
  if (result.json?.truncated === true) {
    return { ok: false, error: '远端文件树被截断（仓库过大），API 增量模式无法安全 diff' };
  }
  const blobs = new Map();
  for (const node of tree) {
    if (node?.type === 'blob' && typeof node.path === 'string') blobs.set(node.path, { sha: node.sha, size: Number(node.size) || 0 });
  }
  return { ok: true, headSha: result.json?.sha, blobs };
}

/** 取远端指定路径的文本内容（同 trees 的 sha 口径校验后再交给调用方）。 */
async function fetchRemoteText(repo, ref, filePath, { rawBase = 'https://raw.githubusercontent.com', fetchImpl = fetch } = {}) {
  const url = `${rawBase}/${repo}/${ref}/${filePath}`;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(RAW_DIRECT_TIMEOUT_MS) });
    if (!response.ok) return { ok: false, error: `raw HTTP ${response.status}` };
    return { ok: true, buffer: Buffer.from(await response.arrayBuffer()), url };
  } catch (error) {
    return { ok: false, error: error?.name === 'TimeoutError' ? 'raw 直连超时' : String(error?.message || error) };
  }
}

/**
 * 按候选镜像取文件内容（raw 直连不可达时的后备通道）。
 * 与 github_download 同一套候选；每次结果回写做失败学习。
 */
async function fetchViaMirror(repo, ref, filePath, expectedSha, deps = {}) {
  const { fetchImpl = fetch } = deps;
  const list = readCandidates();
  const attempts = [];
  for (const item of usableCandidates(list)) {
    const target = buildMirrorUrl(item.mirror, `https://raw.githubusercontent.com/${repo}/${ref}/${filePath}`);
    try {
      const response = await fetchImpl(target, { signal: AbortSignal.timeout(FILE_DOWNLOAD_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (blobSha(buffer) !== expectedSha) throw new Error('镜像内容与远端 blob sha 不符（不采用）');
      return { ok: true, buffer, channel: item.mirror, attempts };
    } catch (error) {
      attempts.push({ mirror: item.mirror, error: String(error?.message || error).slice(0, 200) });
    }
  }
  return { ok: false, error: `直连与 ${attempts.length} 个镜像都取不到该文件`, attempts };
}

/**
 * 「这个远端路径该不该装进插件目录」——npm files 白名单的最小语义实现。
 * 支持：精确文件、目录（含其下全部）、结尾斜杠目录、`!` 否定；glob 不支持（如实报 unmatched）。
 * 顶层 package.json / README / LICENSE / CHANGELOG 始终包含（npm pack 规则）。
 *
 * 否定条目不能「先命中先返回」：清单常写成 `['lib', '!lib/dev.js']`，
 * 若正向 `lib` 一命中就 return true，`!lib/dev.js` 永远轮不到——排除形同虚设。
 * 所以按 npm 的「后写覆盖」语义遍历完全部条目，取最后一次命中的结论。
 */
export function isIncludedByFiles(filesWhitelist, relPath) {
  const pathPosix = relPath.split('\\').join('/');
  const patterns = Array.isArray(filesWhitelist) ? filesWhitelist : [];
  if (patterns.length === 0) return true; // 未声明 files：npm 语义 = 除默认忽略外全收

  let decided = null;
  for (const pattern of patterns) {
    const text = String(pattern ?? '');
    if (text.startsWith('!')) {
      const negated = text.slice(1).replace(/^\.\//, '').replace(/\/$/, '');
      if (negated && (pathPosix === negated || pathPosix.startsWith(`${negated}/`))) decided = false;
      continue;
    }
    const clean = text.replace(/^\.\//, '').replace(/\/$/, '');
    if (!clean) continue;
    if (pathPosix === clean || pathPosix.startsWith(`${clean}/`)) decided = true;
  }
  if (decided !== null) return decided;
  return NPM_ALWAYS_INCLUDED_TOP.some((re) => re.test(pathPosix));
}

/** 递归列本地目录（相对路径 → 文件绝对路径），跳过非发布杂物。 */
export function listLocalFiles(dir) {
  const out = new Map();
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (['.git', 'node_modules', '.trash', '.DS_Store'].includes(entry.name)) continue;
      const full = join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) out.set(rel, full);
    }
  };
  if (existsSync(dir)) walk(dir, '');
  return out;
}

/**
 * 计算「远端 vs 本地安装目录」的差异（零下载）。
 * @returns {{ok:boolean, error?:string, headSha, added, changed, removed, unchangedCount, ref}}
 *   added   = [{path, sha, size}] 远端要装、本地没有
 *   changed = [{path, sha, size, localSha}] 两边都有、内容不同
 *   removed = [path...] 本地有、远端（按白名单）不该有——只报告，默认不删
 */
export async function diffUpstream({ repo, ref, installDir, filesWhitelist = null, ...deps } = {}) {
  const trees = await fetchRemoteTrees(repo, ref, deps);
  if (!trees.ok) return trees;

  let whitelist = filesWhitelist;
  if (whitelist === null) {
    const pkgRemote = await fetchRemoteText(repo, ref, 'package.json', deps);
    if (pkgRemote.ok) {
      try { whitelist = JSON.parse(pkgRemote.buffer.toString('utf8')).files ?? []; } catch { whitelist = []; }
    } else {
      // 拿不到远端 package.json 就退化为「全部 blob 都是候选」，由调用方的 size/count 上限兜底
      whitelist = null;
    }
  }

  const wanted = new Map([...trees.blobs].filter(([path]) => whitelist === null || isIncludedByFiles(whitelist, path)));
  const local = listLocalFiles(installDir);
  const added = [];
  const changed = [];
  const removed = [];
  let unchangedCount = 0;

  for (const [path, meta] of wanted) {
    const localFull = local.get(path);
    if (!localFull) { added.push({ path, ...meta }); continue; }
    let localHash = '';
    try { localHash = blobSha(readFileSync(localFull)); } catch { localHash = ''; }
    if (localHash === meta.sha) unchangedCount += 1;
    else changed.push({ path, localSha: localHash, ...meta });
  }
  for (const path of local.keys()) {
    if (!wanted.has(path)) removed.push(path);
  }
  return { ok: true, headSha: trees.headSha, ref, added, changed, removed, unchangedCount, wantedCount: wanted.size };
}

/**
 * 执行更新：dryRun 只 diff；write=true 才备份旧文件并覆盖变动文件。
 * 备份目录 = `<backupRoot>/<插件名>-<时间戳>/`，只存被覆盖的旧文件，可整份还原。
 * 记录文件 = `<backupRoot>/../upstream-records/<插件名>.json`，供「更新到底生效没」核验。
 */
export async function applyUpstream({ repo, ref, installDir, pluginName = '', write = false, backupRoot = '', recordDir = '', dryRun = false, ...deps } = {}) {
  const parsed = parseGithubRepo(repo);
  if (!parsed.ok) return { ok: false, error: parsed.reason };
  const repoName = parsed.repo;

  let refName = String(ref ?? '').trim();
  if (!refName) {
    const branch = await fetchDefaultBranch(repoName, deps);
    if (!branch.ok) return branch;
    refName = branch.branch;
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const backupDir = join(backupRoot, `${pluginName || posix.basename(repoName)}-${stamp}`);

  const diff = await diffUpstream({ repo: repoName, ref: refName, installDir, ...deps });
  if (!diff.ok) return diff;

  const targets = [...diff.added, ...diff.changed];
  if (write !== true || dryRun === true) {
    return { ok: true, dryRun: true, repo: repoName, ref: refName, headSha: diff.headSha, installDir, added: diff.added.map((f) => f.path), changed: diff.changed.map((f) => f.path), removed: diff.removed, unchangedCount: diff.unchangedCount, totalBytesPlanned: targets.reduce((sum, f) => sum + f.size, 0), backupDir };
  }
  if (targets.length > MAX_FILES_PER_SYNC) {
    return { ok: false, error: `本次要写 ${targets.length} 个文件（上限 ${MAX_FILES_PER_SYNC}），多半是装错目录——请人工核对 installDir`, added: diff.added.map((f) => f.path), changed: diff.changed.map((f) => f.path) };
  }

  // 1) 先把全部内容取齐并校验 sha —— 任何一个失败都不动盘，避免半新半旧
  const fetched = [];
  const failures = [];
  for (const file of targets) {
    let content = await fetchRemoteText(repoName, refName, file.path, deps);
    if (content.ok && blobSha(content.buffer) !== file.sha) content = { ok: false, error: 'raw 内容与远端 blob sha 不符' };
    if (!content.ok) {
      const viaMirror = await fetchViaMirror(repoName, refName, file.path, file.sha, deps);
      if (!viaMirror.ok) { failures.push({ path: file.path, error: viaMirror.error }); continue; }
      fetched.push({ ...file, buffer: viaMirror.buffer, channel: viaMirror.channel });
      continue;
    }
    fetched.push({ ...file, buffer: content.buffer, channel: 'raw-direct' });
  }
  if (failures.length) {
    return { ok: false, error: `有 ${failures.length} 个文件取不到（未写盘）`, failures, repo: repoName, headSha: diff.headSha };
  }

  // 2) 备份被覆盖的旧文件（added 的本地不存在，跳备份）
  mkdirSync(backupDir, { recursive: true });
  const backedUp = [];
  for (const file of diff.changed) {
    const from = join(installDir, file.path);
    const to = join(backupDir, file.path);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    backedUp.push(file.path);
  }

  // 3) 落盘
  const written = [];
  for (const file of fetched) {
    const to = join(installDir, file.path);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, file.buffer);
    written.push({ path: file.path, channel: file.channel, size: file.buffer.length });
  }

  // 4) 记录（核验「更新生效没」用：headSha ↔ 各文件 sha）。
  //    目录必须建 recordDir 本身——原先只建了它的父目录，写记录直接 ENOENT，
  //    还被 catch 吞掉，症状是「更新成功了但没有记录可查」。
  let updateRecordError = '';
  try {
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(join(recordDir, `${pluginName || posix.basename(repoName)}.json`), JSON.stringify({
      at: new Date().toISOString(), repo: repoName, ref: refName, headSha: diff.headSha, installDir,
      written: written.map((f) => ({ path: f.path, sha: targets.find((t) => t.path === f.path)?.sha })),
      backupDir, removed: diff.removed,
    }, null, 2) + '\n', 'utf8');
  } catch (recordError) {
    // 记录失败不推翻已成功的更新，但必须如实标注，否则「没记录」看起来像「本来就不记」。
    updateRecordError = String(recordError?.message || recordError);
  }

  return {
    ok: true, repo: repoName, ref: refName, headSha: diff.headSha, installDir,
    written, backedUp, backupDir,
    removed: diff.removed, unchangedCount: diff.unchangedCount,
    ...(updateRecordError ? { updateRecordError } : {}),
    restartNote: 'node_modules 装载源不受 hmr 监视，覆盖后需重启宿主才生效；local-plugins 布局则热重载即可',
  };
}
