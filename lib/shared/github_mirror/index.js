/**
 * 工具：github_mirror —— 让 DSH 装 GitHub 插件时走代理
 *
 * 目录即工具名（见 lib/index.js 动态扫描）。实现下沉在 lib/core/github-mirror/。
 *
 * 为什么要这个工具：DSH 从 GitHub 安装插件走 `pnpm add <git spec>` → git clone，
 * **不经过 npm 源**（界面上的「安装源」只对 npm 包有效），而 GitHub 直连常见不通。
 * 本工具在 git 层写 `url.<代理>https://<host>/.insteadOf https://<host>/` 重写，
 * pnpm 里的 git clone 就会无感走代理，原始地址不用改。
 */
import { runGithubMirror } from '../../core/github-mirror/index.js';

export const description = '让 DSH 安装 GitHub 插件时走代理：在 git 层写 insteadOf 重写'
  + '（url.<代理>https://<host>/.insteadOf https://<host>/，两端都必须带协议，否则 git 前缀匹配不上、重写静默失效），'
  + 'pnpm/git 的 clone 会无感走代理、原始仓库地址不用改。'
  + '参数：action=status（缺省，看当前是否走代理）/ apply（探测后写重写规则）/ clear（移除重写、恢复直连）/ probe（只探测不写配置）；'
  + 'mirror 可省——省掉时按候选清单顺序取第一个可用的（清单自带三个可用代理），仅当清单为空或全部停用才必须传；'
  + '探测不通的地址不会写入候选清单，只返回 rejected 告知；hosts 缺省 github.com；rotate 缺省 true；dryRun 缺省 **true**（要真改传 false）。'
  + '注意：只改 ~/.gitconfig 的这一类键，不动 npm 源、不动 DSH 源码；生效无需重启。';

export const parameters = {
  type: 'object',
  properties: {
    action: { type: 'string', description: 'status（缺省）/ apply / clear / probe' },
    mirror: { type: 'string', description: '代理前缀，如 https://ghfast.top/。可空：省略则按候选清单顺序自动取第一个可用的；只有清单为空/全停用才必填。必须以 / 结尾（工具会自动补齐）' },
    hosts: { type: 'string', description: '要重写的站点，逗号分隔；缺省 github.com' },
    rotate: { type: 'boolean', description: 'apply 时探测失败是否自动换候选（缺省 true）' },
    dryRun: { type: 'boolean', description: 'apply / clear 缺省 true（只报计划）；要真改传 false' },
    probeDirect: { type: 'boolean', description: 'status 时顺带探测直连是否可用' },
  },
};

/** 工具入口（契约 C-103 规定导出名为 run；内部用表意名后起别名）。 */
async function runGithubMirrorTool(args = {}, toolCtx = {}) {
  return runGithubMirror(args, toolCtx);
}

export { runGithubMirrorTool as run };
