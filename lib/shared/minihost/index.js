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
  + 'action=start(启动: plugin,port) | call(请求) | stop(停止: port|plugin) | status(状态，等价 list)。'
  + 'start 可带 env（注入子进程环境变量，默认 DSH_HOME 已隔离）、force（已有实例时按新参数重启）、preview（让根路径直接返回该 HTML）；'
  + 'stop 可带 all（停本进程启动的全部实例）；list 默认只列本进程起的，all:true 才列全部。';

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
    env: { type: 'string', description: 'start 用：注入子进程环境变量，JSON 对象（{"KEY":"VALUE"}）或 KEY=VALUE 逗号串。默认 DSH_HOME 已隔离到 .minihost/home-<port>，传 {DSH_HOME:"<真实 .dsh>"} 可复原' },
    force: { type: 'boolean', description: 'start 用：已有同名实例时按新参数重启（先 stop 再 start）；缺省复用旧实例并提示参数差异' },
    preview: { type: 'string', description: 'start 用：HTML 文件路径，让 mini 宿主的根路径 / 直接返回该页面（等价 CLI 的 --preview）；可空' },
    all: { type: 'boolean', description: 'list 用：true = 列出全部实例（含其它进程启动的）；stop 用：true = 停掉本进程启动的全部实例。缺省只看本进程' },
  },
};

/** 工具入口：按 action 分派到 mini 宿主生命周期动作（契约 C-103 规定导出名为 run）。 */
async function runMinihost(args = {}) {
  const action = String(args.action || 'list').toLowerCase();
  if (action === 'start') {
    return minihostStart({
      plugin: args.plugin,
      port: args.port,
      services: args.services,
      env: args.env,
      force: args.force,
      preview: args.preview,
    });
  }
  if (action === 'call') return minihostCall({ port: args.port, path: args.path, method: args.method, body: args.body });
  if (action === 'stop') return minihostStop({ port: args.port, plugin: args.plugin, all: args.all });
  // status 与 list 同义：都返回台账里的实例（端口/pid/插件），status 只是更直白的叫法
  return { ok: true, instances: minihostList({ all: args.all }) };
}

export { runMinihost as run };
