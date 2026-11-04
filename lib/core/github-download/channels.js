/**
 * GitHub 下载地址的识别与镜像前缀拼接
 *
 * 为什么单独拆一层：镜像前缀模式（`https://ghfast.top/https://github.com/...`）
 * 对 release 资产、raw 文件、archive 源码包三类资源都适用，但三者的直连可达性
 * 完全不同——实测本机 raw 与 codeload 可直连，唯独 release 资产的 302 落地域
 * 被 TLS SNI 阻断。分类之后才能决定「要不要先试直连」，也才能给出准确的错误提示
 * （用户看到「raw 也下不了」会误判成镜像坏了，实际是别的原因）。
 */

/** 认识的 GitHub 下载域。不在此列的地址一律拒绝，避免本工具被当成通用下载器。 */
export const GITHUB_DOWNLOAD_HOSTS = [
  'github.com',
  'raw.githubusercontent.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
];

/**
 * 资源类型枚举。
 * - release：`github.com/<owner>/<repo>/releases/download/<tag>/<file>`，会 302 到 release-assets 域
 * - raw：`raw.githubusercontent.com/...`，直连通常可用
 * - archive：`github.com/<owner>/<repo>/archive/...` 与 `codeload.github.com/...`，直连通常可用
 * - other：其它 GitHub 域地址（仍允许下载，只是不给「直连可能可用」的乐观提示）
 */
export const RESOURCE_KINDS = ['release', 'raw', 'archive', 'other'];

/**
 * 判断某 host 是否属于 GitHub 下载域。
 * 用「等于或以其为后缀」而不是 includes，避免 `github.com.evil.example` 混进来。
 */
function isGithubHost(hostname) {
  const lowered = String(hostname || '').toLowerCase();
  return GITHUB_DOWNLOAD_HOSTS.some((known) => lowered === known || lowered.endsWith(`.${known}`));
}

/**
 * 按路径特征判定资源类型。
 * 顺序有意义：github.com 上 `/releases/download/` 与 `/archive/` 都可能出现在
 * 同一仓库的路径里，必须先判 release 再判 archive。
 */
function detectKind(hostname, pathname) {
  const loweredHost = String(hostname || '').toLowerCase();
  if (loweredHost === 'raw.githubusercontent.com') return 'raw';
  if (loweredHost === 'codeload.github.com') return 'archive';
  if (pathname.includes('/releases/download/')) return 'release';
  if (pathname.includes('/releases/latest/download/')) return 'release';
  if (pathname.includes('/archive/')) return 'archive';
  return 'other';
}

/** 从路径末段取文件名（解码百分号转义，去掉查询串干扰）。 */
export function fileNameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const last = segments.length ? segments[segments.length - 1] : '';
    return last ? decodeURIComponent(last) : '';
  } catch {
    return '';
  }
}

/**
 * 识别并归一化一个下载地址。
 *
 * @returns {{ok: true, url: string, kind: string, host: string, pathname: string, fileName: string}
 *          | {ok: false, reason: string}}
 */
export function classifyGithubUrl(rawUrl) {
  const text = String(rawUrl ?? '').trim();
  if (!text) return { ok: false, reason: 'url 不能为空' };

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, reason: `不是合法的绝对 URL：${text.slice(0, 120)}` };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: `只支持 http(s) 地址，收到 ${parsed.protocol}` };
  }
  if (!isGithubHost(parsed.hostname)) {
    return {
      ok: false,
      reason: `不是 GitHub 下载域（${parsed.hostname}）；本工具只处理 ${GITHUB_DOWNLOAD_HOSTS.join(' / ')}`,
    };
  }

  const kind = detectKind(parsed.hostname, parsed.pathname);
  return {
    ok: true,
    url: parsed.toString(),
    kind,
    host: parsed.hostname.toLowerCase(),
    pathname: parsed.pathname,
    fileName: fileNameFromUrl(parsed.toString()),
  };
}

/**
 * 拼镜像前缀地址。
 *
 * 镜像必须已经带结尾斜杠（store.js 的 normalizeMirror 保证），
 * 这里只做拼接，不再猜格式——前缀模式是 `镜像 + 完整原始 URL`。
 */
export function buildMirrorUrl(mirror, originalUrl) {
  const prefix = String(mirror ?? '').trim();
  if (!prefix) return '';
  const withSlash = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return `${withSlash}${String(originalUrl ?? '').trim()}`;
}

/**
 * 给「直连是否值得一试」一个先验判断，用于在 dryRun 报告里解释原因。
 *
 * 这只是提示，不参与通道选择——真正的判断永远以实测结果为准，
 * 否则一旦网络策略变化，先验就会变成错误的硬编码假设。
 */
export function directHint(kind) {
  if (kind === 'release') return 'release 资产会 302 到 release-assets 域，国内常见被拦，直连大概率不通';
  if (kind === 'raw' || kind === 'archive') return 'raw / archive 通常可直连，先试直连能省一次镜像中转';
  return '未知资源类型，按实测结果决定';
}
