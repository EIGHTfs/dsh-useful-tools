/**
 * 工具：sync_plugin —— 插件工作区代码同步到 profile 的 local-plugins（缺省 dryRun）
 *
 * 目录即工具名（见 lib/index.js 动态扫描）。实现下沉在 lib/core/plugin-sync/。
 */
import { runSync } from '../../core/plugin-sync/tools.js';

export const description = '把插件工作区代码同步到 DSH profile 的 local-plugins（软链布局免重启热重载）。'
  + '默认 dryRun 只报差异；write:true 才真写。目标自动按 DSH_HOME 的 profile 定位。';

export const parameters = {
  type: 'object',
  properties: {
    write: { type: 'boolean', description: 'true = 真同步写盘（缺省只预演）' },
    profile: { type: 'string', description: '目标 profile 名（缺省取第一个能定位到的）' },
    source: { type: 'string', description: '插件源码根目录（缺省本插件根）' },
    dshHome: { type: 'string', description: '目标 DSH_HOME（缺省当前进程的 DSH_HOME）——指向测试环境即可把插件装进去' },
    pluginName: { type: 'string', description: '插件包名（缺省 dsh-useful-tools）' },
    register: { type: 'boolean', description: 'true = 同步后把插件注册进 profile（dependencies + dsh.profile.bundles），需 write:true' },
  },
};

/** 工具入口：转调同步实现（契约 C-103 规定导出名为 run）。 */
async function runPluginSync(args = {}) {
  return runSync(args);
}

export { runPluginSync as run };
