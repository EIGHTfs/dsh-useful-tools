/**
 * 工具：sync_plugin —— 插件工作区代码同步到 profile 的 local-plugins（缺省 dryRun）
 *
 * 目录即工具名（见 lib/index.js 动态扫描）。实现下沉在 lib/core/sync-plugin/。
 */
import { runSync } from '../../core/sync-plugin/tools.js';

export const description = '把插件工作区代码同步到 DSH profile 的 local-plugins（软链布局免重启热重载）。'
  + '默认 dryRun 只报差异；write:true 才真写。目标自动按 DSH_HOME 的 profile 定位。'
  + 'files 返回的是变动文件清单（差异项），全量口径看 totalCount / unchangedCount。'
  + 'stale 列出「目标里有、源码没有」的残留（改名或删文件后的历史遗留），只报告不删除。'
  + 'target 可显式指定任意已存在的目录（如 node_modules/<插件名> 装机版位置），缺省沿用旧行为。'
  + 'fromGithub 传 owner/repo 走上游更新模式：GitHub API 算变动文件、只覆盖变的那些（不 clone、不落 .git），'
  + '内容以远端 blob sha 校验，覆盖前旧文件自动备份。';

export const parameters = {
  type: 'object',
  properties: {
    write: { type: 'boolean', description: 'true = 真同步写盘（缺省只预演）' },
    profile: { type: 'string', description: '目标 profile 名（缺省取第一个能定位到的）' },
    source: { type: 'string', description: '插件源码根目录（缺省本插件根）' },
    target: { type: 'string', description: '显式目标目录（可空）：任意已存在目录，如 <profile>/node_modules/<插件名>；给了就不再按 DSH_HOME 推算 local-plugins' },
    allowMismatch: { type: 'boolean', description: 'true = 允许把源码同步进「装的是别的插件」的目录（可空，缺省 false）。带 target 时比对源与目标的 package.json name，不一致就拒绝——防止拿 A 插件源码覆盖 B 插件的运行时代码' },
    fromGithub: { type: 'string', description: '上游仓库（可空）：owner/repo、https 或 ssh 地址；给了就切换为「API 增量覆盖目标目录」模式，本地源码不参与' },
    ref: { type: 'string', description: '上游分支/标签/sha（可空，缺省远端默认分支）；仅与 fromGithub 搭配生效' },
    dshHome: { type: 'string', description: '目标 DSH_HOME（缺省当前进程的 DSH_HOME）——指向测试环境即可把插件装进去' },
    pluginName: { type: 'string', description: '插件包名（缺省 dsh-useful-tools）' },
    register: { type: 'boolean', description: 'true = 同步后把插件注册进 profile（dependencies + dsh.profile.bundles），需 write:true' },
    hmr: { type: 'boolean', description: 'true = 启用该 profile 的模块热重载：幂等补齐 `- id: hmr`（base=profileContext.dir、root 含 local-plugins）并回报该插件是否已可免重启。可空；缺省完全不碰 hmr 配置。未传 write 时只报计划' },
  },
};

/** 工具入口：转调同步实现（契约 C-103 规定导出名为 run）。 */
async function runPluginSync(args = {}) {
  return runSync(args);
}

export { runPluginSync as run };
