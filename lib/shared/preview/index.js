/**
 * 工具：preview —— 预览页生成 / 起服务 / 停止 / 列表（全部走 action 参数）
 *
 * 目录即工具名（见 lib/index.js 动态扫描）。一个文件夹只对应一个工具：
 * 原 preview_gen/serve/stop/list 四个工具收敛为 preview + action 参数。
 * 实现下沉在 lib/core/preview/（通用件），插件自持 assets/preview.spec.mjs 垫片；主题插件允许自持。
 */
import { runPreviewGen } from '../../core/preview/tools.js';
import { servePreview, stopPreview, listPreview } from '../../core/preview/server.js';

export const description = '插件预览页：生成单文件 HTML（跑真实 client.js + 插件自持 preview.spec.mjs 垫片）、'
  + '起本地服务（可反代真实后端）、停止、列出。action=gen(plugin,spec,out) | serve(file,port,backend) | stop(port|file) | list。';

export const parameters = {
  type: 'object',
  properties: {
    action: { type: 'string', description: 'gen | serve | stop | list（缺省 list）', enum: ['gen', 'serve', 'stop', 'list'] },
    plugin: { type: 'string', description: 'gen 用：插件项目根' },
    spec: { type: 'string', description: 'gen 用：描述文件路径（缺省 <plugin>/assets/preview.spec.mjs）' },
    out: { type: 'string', description: 'gen 用：产物路径（缺省 spec.output 或 assets/preview.html）' },
    file: { type: 'string', description: 'serve/stop 用：preview.html 路径' },
    port: { type: 'number', description: 'serve/stop 用：端口（缺省 31188）' },
    backend: { type: 'string', description: 'serve 用：真实后端地址（如 http://127.0.0.1:30800），给了则 /api/* 反代' },
  },
};

export async function run(args = {}) {
  const action = String(args.action || 'list').toLowerCase();
  if (action === 'gen') return runPreviewGen({ plugin: args.plugin, spec: args.spec, out: args.out });
  if (action === 'serve') return servePreview({ file: args.file, port: args.port, backend: args.backend });
  if (action === 'stop') return stopPreview({ port: args.port, file: args.file });
  return { ok: true, instances: listPreview() };
}
