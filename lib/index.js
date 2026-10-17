/**
 * dsh-useful-tools · 装配入口（按目录动态注册）
 *
 * 设计约定（一条规则贯穿）：
 *   **lib/shared/<名字>/index.js 一个文件夹 = 一个工具**，工具名与斜杠指令名都取自**文件夹名**，
 *   装配层只做扫描 + 注册，不含任何业务逻辑；功能差异全部通过**参数**表达（如 minihost/preview 的 action）。
 *
 * 目录职责：
 *   lib/shared/   工具适配层（每个文件夹一个工具：mark_read / sync_plugin / minihost / preview）
 *   lib/core/     共享实现（mark-read 观测、plugin-sync 同步、minihost 宿主、preview 预览）
 *
 * 新增工具的做法：新建 lib/shared/<工具名>/index.js，导出 { description, parameters, run } —— 无需改本文件。
 */
import { readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { registerObserveHook } from './core/mark-read/hook.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHARED_DIR = join(HERE, 'shared');

/** 扫描 lib/shared/ 下每个工具目录（只认含 index.js 的目录）。 */
export function listToolDirs() {
  if (!existsSync(SHARED_DIR)) return [];
  return readdirSync(SHARED_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(SHARED_DIR, d.name, 'index.js')))
    .map((d) => ({ name: d.name, entry: join(SHARED_DIR, d.name, 'index.js') }));
}

/** 工具结果渲染器：宿主硬约定返回**块数组**（返回字符串会报 content.some is not a function）。 */
const textRender = (_args, value) => [{ type: 'text', text: String(value) }];

export async function apply(ctx, config = {}) {
  const log = { warn: (m) => { try { ctx?.logger?.warn?.(m); } catch { /* 忽略 */ } } };
  const dirs = listToolDirs();

  // ── 1) 工具 + 指令：按目录动态注册（一个文件夹一个工具，名字取自文件夹）──
  for (const { name, entry } of dirs) {
    try {
      const mod = await import(pathToFileURL(entry).href);
      if (typeof mod.run !== 'function') { log.warn(`dsh-useful-tools: ${name} 未导出 run，跳过`); continue; }
      const spec = {
        name,
        description: String(mod.description || name),
        parameters: mod.parameters || { type: 'object', properties: {} },
        output: { schema: { type: 'string' }, render: textRender },
        async execute(args, exec) {
          try {
            const out = await mod.run(args || {}, { ctx, exec, config, log });
            return JSON.stringify(out ?? { ok: true });
          } catch (e) {
            return JSON.stringify({ ok: false, error: String((e && e.message) || e) });
          }
        },
      };
      ctx.inject(['tools'], (tc) => {
        const registry = tc?.get?.('tools');
        if (!registry?.register) { log.warn('dsh-useful-tools: tools 服务不可用'); return; }
        try { registry.register(registry.defineTool ? registry.defineTool(spec) : spec); } catch (e) {
          log.warn(`dsh-useful-tools: 工具 ${name} 注册失败: ${(e && e.message) || e}`);
        }
      });
      // 同名斜杠指令（名字与目录一致；结果只给界面，不进模型历史）
      ctx.inject(['commands'], (cc) => {
        const registry = cc?.commands || cc?.get?.('commands');
        if (!registry?.register) return;
        try {
          registry.register({
            name,
            description: String(mod.description || name).slice(0, 120),
            input: { type: 'string' },
            handler: async (input) => {
              const text = typeof input === 'string' ? input : String(input?.input ?? input?.text ?? '');
              // 指令形态：把 "action 值…" 解析成参数对象（action 优先，其余按位置给 plugin/port/path 等）
              const tokens = text.trim().split(/\s+/).filter(Boolean);
              const args = {};
              if (tokens.length) {
                const first = tokens[0];
                if (/^(start|call|stop|list|gen|serve|undo|all)$/i.test(first)) args.action = first.toLowerCase();
                const rest = args.action ? tokens.slice(1) : tokens;
                if (rest[0]) args.plugin = rest[0];
                if (rest[1] && /^\d+$/.test(rest[1])) args.port = Number(rest[1]);
                else if (rest[1]) args.path = rest[1];
                if (rest[2]) args.backend = rest[2];
                if (args.action === 'mark-read' || (!args.action && rest.length)) args.paths = rest.join(',');
              }
              const out = await mod.run(args, { ctx, exec: null, config, log });
              return { kind: out?.ok === false ? 'error' : 'success', text: JSON.stringify(out ?? { ok: true }) };
            },
          });
        } catch (e) { log.warn(`dsh-useful-tools: 指令 ${name} 注册失败: ${(e && e.message) || e}`); }
      });
    } catch (e) {
      log.warn(`dsh-useful-tools: 加载 ${name} 失败: ${(e && e.message) || e}`);
    }
  }

  // ── 2) 自动标记钩子（非工具能力：订阅 tools/post-execute，读命令集合走配置）──
  ctx.inject(['fs'], (c) => {
    const on = registerObserveHook(ctx, { fsCtx: c, cfg: config, log });
    if (!on) log.warn('dsh-useful-tools: 自动标记钩子未注册（开关关闭或上下文缺失）');
  });

  return { name: 'dsh-useful-tools', tools: dirs.map((d) => d.name) };
}
