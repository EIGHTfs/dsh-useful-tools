/**
 * dsh-useful-tools · 装配入口（按目录动态注册）
 *
 * 设计约定（一条规则贯穿）：
 *   **lib/shared/<名字>/index.js 一个文件夹 = 一个工具**，工具名取自**文件夹名**，
 *   装配层只做扫描 + 注册，不含任何业务逻辑；功能差异全部通过**参数**表达（如 minihost/preview 的 action）。
 *
 * 斜杠指令不在本插件提供：宿主 commands.register 要求 input 必须带非空 hint，
 * 同名指令的收益低于维护成本，故只注册工具（要恢复时按该契约补 input.hint 即可）。
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

/** 把工具 spec 注册进宿主 tools 服务（服务缺失只记日志，不影响其余工具）。 */
function registerToolSpec(ctx, spec, name, log) {
  ctx.inject(['tools'], (tc) => {
    const registry = tc?.get?.('tools');
    if (!registry?.register) { log.warn('dsh-useful-tools: tools 服务不可用'); return; }
    try { registry.register(registry.defineTool ? registry.defineTool(spec) : spec); } catch (e) {
      log.warn(`dsh-useful-tools: 工具 ${name} 注册失败: ${(e && e.message) || e}`);
    }
  });
}

/** 装配单个工具：import 模块 → 组 spec → 注册。 */
async function registerOneTool(ctx, { name, entry }, log, config) {
  try {
    const mod = await import(pathToFileURL(entry).href);
    if (typeof mod.run !== 'function') { log.warn(`dsh-useful-tools: ${name} 未导出 run，跳过`); return; }
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
    registerToolSpec(ctx, spec, name, log);
  } catch (e) {
    log.warn(`dsh-useful-tools: 加载 ${name} 失败: ${(e && e.message) || e}`);
  }
}

export async function apply(ctx, config = {}) {
  const log = { warn: (m) => { try { ctx?.logger?.warn?.(m); } catch { /* 忽略 */ } } };
  const dirs = listToolDirs();

  // ── 1) 工具：按目录动态注册（一个文件夹一个工具，名字取自文件夹）──
  for (const toolDir of dirs) {
    await registerOneTool(ctx, toolDir, log, config);
  }

  // ── 2) 自动标记钩子（非工具能力：订阅 tools/post-execute，读命令集合走配置）──
  ctx.inject(['fs'], (c) => {
    const on = registerObserveHook(ctx, { fsCtx: c, cfg: config, log });
    if (!on) log.warn('dsh-useful-tools: 自动标记钩子未注册（开关关闭或上下文缺失）');
  });

  // 装配摘要只写日志，不作为返回值：
  // cordis 把 apply 的返回值当作 effect 收集（_execute → safeCollect），
  // 返回普通对象会抛 TypeError: Invalid effect，整条插件 fiber 随即被卸载，
  // 已注册的工具一并失效（现象就是「插件加载了但工具一个都没有」）。
  // 合法返回值只有三种：undefined/null、dispose 函数、thenable/iterator。
  try {
    ctx?.logger?.info?.(`dsh-useful-tools: 已装配 ${dirs.length} 个工具（${dirs.map((d) => d.name).join(' / ')}）`);
  } catch { /* 日志失败不影响装配 */ }
}
