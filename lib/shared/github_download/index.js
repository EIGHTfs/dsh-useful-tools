/**
 * 工具：github_download —— 下载 GitHub 资源时自动选可用通道
 *
 * 目录即工具名（见 lib/index.js 动态扫描）。实现下沉在 lib/core/github-download/。
 *
 * 为什么需要：本机直连 release-assets.githubusercontent.com（Release 资产的 302
 * 落地域）会被 TLS SNI 阻断，连接挂到超时；公共镜像的前缀模式可用但手工拼容易错、
 * 也记不住哪家还活着。本工具把「直连优先、不通轮换镜像」做成一次调用。
 */
import { runGithubDownload } from '../../core/github-download/index.js';

export const description = '下载 GitHub 资源（release 资产 / raw 文件 / archive 源码包），自动选择可用通道。'
  + '策略：channel=auto（缺省）先探测直连，不通再按候选清单轮换镜像前缀（复用 github_mirror 的候选清单与失败学习，连续失败自动停用）；'
  + 'channel=direct 只走直连、channel=mirror 只走镜像；mirror 可显式指定单个镜像（只本次生效、不写回清单）。'
  + '落盘：不给 savePath 时落到「cwd + URL 文件名」；流式写入不占内存；失败会删掉半截文件；给了 sha256 就校验，不匹配即失败。'
  + 'dryRun=true 只探通道不下载，返回直连与各镜像的探测结果 + 推荐通道。'
  + '接管边界：只管「通过本工具下载」这条路径——用 bash 手敲 curl/wget 不会被改写；'
  + '系统级全局接管做不到（阻断在 TLS 层，镜像不是标准 HTTP 代理，只有 MITM 能改写，代价与风险都不可控）。'
  + '典型用法：下载 GitHub Release 里的二进制包时直接传 URL，不要自己拼镜像前缀。';

export const parameters = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'GitHub 下载地址：release 资产（github.com/<owner>/<repo>/releases/download/...）、raw.githubusercontent.com/...、或 archive/codeload 源码包' },
    savePath: { type: 'string', description: '落盘路径，可空：缺省 = cwd + URL 文件名；相对路径按 cwd 解析' },
    cwd: { type: 'string', description: '基准目录，可空：缺省当前进程工作目录；savePath 缺省时用来拼文件名' },
    sha256: { type: 'string', description: '期望的 sha256，可空：给了就校验，不匹配视为失败并删除文件' },
    channel: { type: 'string', description: 'auto（缺省，先探直连再轮换镜像）/ direct（只直连）/ mirror（只镜像）' },
    mirror: { type: 'string', description: '指定单个镜像前缀（如 https://ghfast.top/），可空：缺省用候选清单；显式指定只本次生效、不写回清单' },
    dryRun: { type: 'boolean', description: 'true = 只探测各通道可用性、不下载（缺省 false）' },
    timeoutMs: { type: 'number', description: '单次下载超时毫秒，可空：缺省 300000' },
  },
  required: ['url'],
};

/** 工具入口（契约 C-103 规定导出名为 run；内部用表意名后起别名）。 */
async function runGithubDownloadTool(args = {}, toolCtx = {}) {
  return runGithubDownload(args, toolCtx);
}

export { runGithubDownloadTool as run };
