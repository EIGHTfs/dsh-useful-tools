/**
 * 工具：minihost —— mini 宿主管理（启动 / 请求 / 停止 / 列表，全部走 action 参数）
 *
 * 目录即工具名（见 lib/index.js 动态扫描）。一个文件夹只对应一个工具：
 * 原 minihost_start/call/stop/list 四个工具收敛为 minihost + action 参数。
 * 实现下沉在 lib/core/minihost/。
 */
import { minihostStart, minihostCall, minihostStop, minihostList } from '../../core/minihost/tools.js';

export const description = '后端模拟：本地 mini 宿主，把任意 DSH 插件的服务端代码跑起来（改码刷新即生效，无需重启宿主）。'
  + '与 preview（前端模拟）配对：preview serve 的 backend 指向本工具起的端口即可联调。'
  + 'action=start(启动: plugin,port) | call(请求) | stop(停止: port|plugin) | status(状态，等价 list)。';

export const parameters = {
  type: 'object',
  properties: {
    action: { type: 'string', description: 'start | call | stop | list | status（status 等价 list）', enum: ['start', 'call', 'stop', 'list', 'status'] },
    plugin: { type: 'string', description: 'start/stop 用：插件项目根（含 package.json）' },
    port: { type: 'number', description: 'call/stop 用：mini 宿主端口；start 可显式指定' },
    path: { type: 'string', description: 'call 用：请求路径（缺省 /）' },
    method: { type: 'string', description: 'call 用：GET（缺省）/POST/…' },
    body: { type: 'string', description: 'call 用：请求体（JSON 字符串）' },
    services: { type: 'string', description: 'start 用：宿主服务注入模块路径（默认导出服务对象或返回它的函数）；插件依赖 storageDomain/sessions 等真实服务时用' },
  },
};

/** 工具入口：按 action 分派到 mini 宿主生命周期动作（契约 C-103 规定导出名为 run）。 */
async function runMinihost(args = {}) {
  const action = String(args.action || 'list').toLowerCase();
  if (action === 'start') return minihostStart({ plugin: args.plugin, port: args.port, services: args.services });
  if (action === 'call') return minihostCall({ port: args.port, path: args.path, method: args.method, body: args.body });
  if (action === 'stop') return minihostStop({ port: args.port, plugin: args.plugin });
  // status 与 list 同义：都返回台账里的实例（端口/pid/插件），status 只是更直白的叫法
  return { ok: true, instances: minihostList() };
}

export { runMinihost as run };
