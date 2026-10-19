/**
 * 预览页工具面：preview_gen / preview_serve / preview_stop / preview_list + 指令 /preview
 *
 * 统一管理的边界（重要）：
 *   通用件（本插件）＝ DSH 根定位、React UMD 缓存、单文件 HTML 壳、静态服务 + 后端代理、进程台账。
 *   插件自持     ＝ assets/preview.spec.mjs（自己的垫片 harness / 假数据 / 首屏注入 post / 输出路径）。
 *   主题插件     ＝ 允许完全自持（主题预览与真实皮肤注入强耦合，不走本工具）。
 */
import { generatePreview } from './gen.js';
import { servePreview, stopPreview, listPreview } from './server.js';

export async function runPreviewGen(args = {}) {
  return generatePreview({
    plugin: args.plugin ? String(args.plugin) : process.cwd(),
    spec: args.spec ? String(args.spec) : undefined,
    out: args.out ? String(args.out) : undefined,
    profile: args.profile ? String(args.profile) : undefined,
  });
}

/** 预览工具的四个动作定义（name/description/parameters/run）。 */
function previewToolSpecs() {
  return [
    {
      name: 'tool_preview_gen',
      description: '生成插件的单文件预览页（跑真实 client.js；**preview.spec.mjs 可选**——不写就走通用自动挂载，标题默认取插件目录名）。参数：plugin=插件根（缺省当前目录）、spec/out 可覆盖。',
      parameters: { type: 'object', properties: { plugin: { type: 'string', description: '插件项目根' }, spec: { type: 'string', description: '描述文件路径（可选；缺省 <plugin>/assets/preview.spec.mjs，不存在则自动挂载）' }, out: { type: 'string', description: '产物路径（缺省 spec.output 或 assets/preview.html）' } } },
      run: (a) => runPreviewGen(a),
    },
    {
      name: 'tool_preview_serve',
      description: '把生成的预览页起成本地服务。**backend 可省略**：省略时自动沿用最近一次 minihost start 的实例端口（返回 backendSource 标明来源）；也可显式给 backend（如 http://127.0.0.1:30800 直连真实后端）。注意：工具参数定义在实例加载期注册——更新本插件后需重载实例才认新参数。',
      parameters: { type: 'object', properties: { file: { type: 'string', description: 'preview.html 路径' }, port: { type: 'number', description: '端口（缺省 31188）' }, backend: { type: 'string', description: '反代目标（缺省自动沿用最近一次 minihost 实例；也可填真实 DSH 后端如 http://127.0.0.1:30800）' }, host: { type: 'string', description: '监听地址（缺省 127.0.0.1；传 0.0.0.0 供局域网访问）' }, lan: { type: 'boolean', description: 'true = 监听 0.0.0.0 并返回局域网 URL（等价 host=0.0.0.0）' } } },
      run: (a) => servePreview(a),
    },
    {
      name: 'tool_preview_stop',
      description: '停止预览服务。参数：port 或 file（二选一）。',
      parameters: { type: 'object', properties: { port: { type: 'number', description: '端口' }, file: { type: 'string', description: 'preview.html 路径' } } },
      run: async (a) => stopPreview(a),
    },
    {
      name: 'tool_preview_list',
      description: '列出当前存活的预览服务（端口/pid/文件）。',
      parameters: { type: 'object', properties: {} },
      run: async () => ({ ok: true, instances: listPreview() }),
    },
  ];
}

/** 把单个动作定义注册进宿主 tools 服务（注册失败只记日志，不影响其余动作）。 */
function registerOneSpec(registry, defineTool, toolDef, log) {
  const spec = {
    name: toolDef.name, description: toolDef.description, parameters: toolDef.parameters,
    output: { schema: { type: 'string' }, render: (v) => [{ type: 'text', text: String(v) }] },
    async execute(args) { return JSON.stringify(await toolDef.run(args)); },
  };
  try { registry.register(defineTool ? defineTool(spec) : spec); } catch (e) { log?.warn?.(`dsh-useful-tools: ${toolDef.name} 注册失败: ${(e && e.message) || e}`); }
}

/** 注册全部预览工具。 */
function mountPreviewTools(ctx, log) {
  try {
    ctx.inject(['tools'], (tc) => {
      const registry = tc?.get?.('tools');
      if (!registry?.register) { log?.warn?.('dsh-useful-tools: tools 服务不可用，preview 工具未注册'); return; }
      for (const toolDef of previewToolSpecs()) registerOneSpec(registry, registry.defineTool, toolDef, log);
    });
  } catch (e) { log?.warn?.(`dsh-useful-tools: preview 工具注册失败: ${(e && e.message) || e}`); }
}

/** /preview 指令处理（gen / serve / stop / list）。 */
async function dispatchPreviewCommand(input) {
  const tokens = String(input ?? '').trim().split(/\s+/).filter(Boolean);
  const sub = (tokens.shift() || 'list').toLowerCase();
  let actionResult;
  if (sub === 'gen') actionResult = await runPreviewGen({ plugin: tokens[0] });
  else if (sub === 'serve') actionResult = await servePreview({ file: tokens[0], port: Number(tokens[1]) || undefined, backend: tokens[2] });
  else if (sub === 'stop') actionResult = stopPreview({ port: Number(tokens[0]) || undefined });
  else actionResult = { ok: true, instances: listPreview() };
  return { kind: actionResult.ok ? 'success' : 'error', text: JSON.stringify(actionResult) };
}

/** 注册工具与指令。 */
export function registerPreviewTools(ctx, { log } = {}) {
  mountPreviewTools(ctx, log);

  try {
    ctx.inject(['commands'], (cc) => {
      const registry = cc?.commands || cc?.get?.('commands');
      if (!registry?.register) return;
      registry.register({
        name: 'preview',
        description: '预览页：gen <插件根> · serve <html> [端口] [backend] · stop <端口> · list',
        input: { type: 'string' },
        handler: dispatchPreviewCommand,
      });
    });
  } catch (e) { log?.warn?.(`dsh-useful-tools: /preview 注册失败: ${(e && e.message) || e}`); }
}
