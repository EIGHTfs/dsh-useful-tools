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

/** 注册工具与指令。 */
export function registerPreviewTools(ctx, { log } = {}) {
  const specs = [
    {
      name: 'ut_preview_gen',
      description: '生成插件的单文件预览页（跑真实 client.js + 插件自持的 preview.spec.mjs 垫片；通用件由本插件提供）。参数：plugin=插件根（缺省当前目录）、spec/out 可覆盖。',
      parameters: { type: 'object', properties: { plugin: { type: 'string', description: '插件项目根' }, spec: { type: 'string', description: '描述文件路径（缺省 <plugin>/assets/preview.spec.mjs）' }, out: { type: 'string', description: '产物路径（缺省 spec.output 或 assets/preview.html）' } } },
      run: (a) => runPreviewGen(a),
    },
    {
      name: 'ut_preview_serve',
      description: '把生成的预览页起成本地服务；给 backend 时 /api/* 反代真实后端（真实数据自检）。参数：file、port、backend。',
      parameters: { type: 'object', properties: { file: { type: 'string', description: 'preview.html 路径' }, port: { type: 'number', description: '端口（缺省 31188）' }, backend: { type: 'string', description: '真实后端地址（如 http://127.0.0.1:30800）' } } },
      run: (a) => servePreview(a),
    },
    {
      name: 'ut_preview_stop',
      description: '停止预览服务。参数：port 或 file（二选一）。',
      parameters: { type: 'object', properties: { port: { type: 'number', description: '端口' }, file: { type: 'string', description: 'preview.html 路径' } } },
      run: async (a) => stopPreview(a),
    },
    {
      name: 'ut_preview_list',
      description: '列出当前存活的预览服务（端口/pid/文件）。',
      parameters: { type: 'object', properties: {} },
      run: async () => ({ ok: true, instances: listPreview() }),
    },
  ];

  try {
    ctx.inject(['tools'], (tc) => {
      const registry = tc?.get?.('tools');
      if (!registry?.register) { log?.warn?.('dsh-useful-tools: tools 服务不可用，preview 工具未注册'); return; }
      const defineTool = registry.defineTool;
      for (const t of specs) {
        const spec = {
          name: t.name, description: t.description, parameters: t.parameters,
          output: { schema: { type: 'string' }, render: (v) => [{ type: 'text', text: String(v) }] },
          async execute(args) { return JSON.stringify(await t.run(args)); },
        };
        try { registry.register(defineTool ? defineTool(spec) : spec); } catch (e) { log?.warn?.(`dsh-useful-tools: ${t.name} 注册失败: ${(e && e.message) || e}`); }
      }
    });
  } catch (e) { log?.warn?.(`dsh-useful-tools: preview 工具注册失败: ${(e && e.message) || e}`); }

  try {
    ctx.inject(['commands'], (cc) => {
      const registry = cc?.commands || cc?.get?.('commands');
      if (!registry?.register) return;
      registry.register({
        name: 'preview',
        description: '预览页：gen <插件根> · serve <html> [端口] [backend] · stop <端口> · list',
        input: { type: 'string' },
        handler: async (input) => {
          const tokens = String(input ?? '').trim().split(/\s+/).filter(Boolean);
          const sub = (tokens.shift() || 'list').toLowerCase();
          let r;
          if (sub === 'gen') r = await runPreviewGen({ plugin: tokens[0] });
          else if (sub === 'serve') r = await servePreview({ file: tokens[0], port: Number(tokens[1]) || undefined, backend: tokens[2] });
          else if (sub === 'stop') r = stopPreview({ port: Number(tokens[0]) || undefined });
          else r = { ok: true, instances: listPreview() };
          return { kind: r.ok ? 'success' : 'error', text: JSON.stringify(r) };
        },
      });
    });
  } catch (e) { log?.warn?.(`dsh-useful-tools: /preview 注册失败: ${(e && e.message) || e}`); }
}
