/**
 * 工具：minihost —— mini 宿主管理（启动 / 请求 / 停止 / 列表，全部走 action 参数）
 *
 * 目录即工具名（见 lib/index.js 动态扫描）。一个文件夹只对应一个工具：
 * 原 minihost_start/call/stop/list 四个工具收敛为 minihost + action 参数。
 * 实现下沉在 lib/core/minihost/。
 */
import { minihostStart, minihostCall, minihostStop, minihostList } from '../../core/minihost/tools.js';

export const description = '本地 mini 宿主：把任意 DSH 插件的服务端代码跑起来（改码刷新即生效，无需重启宿主）。'
  + 'action=start(plugin,port) | call(port,path,method,body) | stop(port|plugin) | list。';

export const parameters = {
  type: 'object',
  properties: {
    action: { type: 'string', description: 'start | call | stop | list（缺省 list）', enum: ['start', 'call', 'stop', 'list'] },
    plugin: { type: 'string', description: 'start/stop 用：插件项目根（含 package.json）' },
    port: { type: 'number', description: 'call/stop 用：mini 宿主端口；start 可显式指定' },
    path: { type: 'string', description: 'call 用：请求路径（缺省 /）' },
    method: { type: 'string', description: 'call 用：GET（缺省）/POST/…' },
    body: { type: 'string', description: 'call 用：请求体（JSON 字符串）' },
  },
};

export async function run(args = {}) {
  const action = String(args.action || 'list').toLowerCase();
  if (action === 'start') return minihostStart({ plugin: args.plugin, port: args.port });
  if (action === 'call') return minihostCall({ port: args.port, path: args.path, method: args.method, body: args.body });
  if (action === 'stop') return minihostStop({ port: args.port, plugin: args.plugin });
  return { ok: true, instances: minihostList() };
}
