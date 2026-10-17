/**
 * 工具：verify_plugin —— 验证 DSH 插件的装载与工具注册（通用，面向使用者）
 *
 * 目录即工具名（见 lib/index.js 动态扫描）。实现下沉在 lib/core/verify-plugin/。
 * 用途：装完插件发现「工具没出现」时，一次拿到三项证据——
 *   入口与注册调用是否正常、宿主跑的是不是最新代码、启动日志到底报了什么。
 * 传 plugin（根目录或插件名）验单个；不传则巡检 profile 里所有已装插件。
 * 只做静态分析：只读文件，不 import、不执行被验证插件的代码。
 */
import { runVerify } from '../../core/verify-plugin/check.mjs';

export const description = '验证 DSH 插件是否装载成功、工具是否注册（只静态分析，不执行插件代码）：'
  + '入口与注册调用检查（apply 是否导出、是否有 tools 注册、apply 是否返回对象字面量导致 Invalid effect）'
  + ' + 部署一致性（源码 vs profile 副本逐文件比内容） + 宿主日志扫描（did not activate / TypeError 等）。'
  + '参数：plugin 传插件根目录或插件名，缺省则巡检所有已装插件。';

export const parameters = {
  type: 'object',
  properties: {
    plugin: { type: 'string', description: '目标插件：根目录绝对路径，或插件名（如 dsh-git-push）。缺省 = 巡检所有已装插件' },
    source: { type: 'string', description: '源码根目录（缺省 = plugin 本身，用于部署一致性比较）' },
    profile: { type: 'string', description: 'profile 名（缺省取第一个探测到的）' },
    log: { type: 'boolean', description: '是否扫宿主日志（缺省 true）' },
  },
};

export async function run(args = {}) {
  return runVerify(args);
}
