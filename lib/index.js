/**
 * dsh-useful-tools · DSH 有用小工具箱（0.1.0）
 *
 * 首个工具：文件观测标记（mark_read / unmark_read / 自动标记钩子）
 *   mark_read    手动把文件标记为已读 ⇒ 之后原生 write/edit 可直接改
 *   unmark_read  撤回标记 ⇒ 原生写恢复「要求先读」的门禁
 *   钩子         对配置集合里的工具（默认 grep）执行后自动补发观测
 *
 * 设计取舍：
 *   · 官方 read 只看几行也算读过（门禁尺度 = 有过观测），故把 grep 纳入与宿主自身语义一致；
 *   · 观测有效到文件版本再变为止，文件一变自动作废 ⇒ 不会出现照旧内容改新文件；
 *   · bash 里 cat/sed 等无法可靠判定读了哪些文件，不进默认集合（命令集合开放，填什么生效什么）。
 */
import { observeFileForHost } from './observe.js';
import { registerObserveHook } from './observe-hook.js';

export { observeFileForHost };

/** 解析「路径集合」参数：支持数组或逗号分隔字符串。 */
function splitPaths(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function apply(ctx, config = {}) {
  const log = { warn: (m) => { try { ctx?.logger?.warn?.(m); } catch { /* 忽略 */ } } };
  const toolSpecs = [];

  const makeTool = (name, description, buildObservation) => ({
    name,
    description,
    parameters: {
      type: 'object',
      properties: {
        paths: { type: 'string', description: '目标文件路径，逗号分隔可一次多个' },
        file_path: { type: 'string', description: '单个目标文件路径（与宿主编辑工具同名参数）' },
      },
    },
    output: { schema: { type: 'string' }, render: (v) => String(v) },
    async execute(args, exec) {
      const list = splitPaths(args?.paths).concat(splitPaths(args?.file_path));
      if (!list.length) return JSON.stringify({ ok: false, error: '未提供路径（paths 或 file_path）' });
      const results = [];
      for (const p of list.slice(0, 50)) {
        results.push({ path: p, ...(await observeFileForHost(ctx, exec, p, buildObservation?.(args))) });
      }
      return JSON.stringify({ tool: name, results });
    },
  });

  // 工具注册：钩进 tools 服务（defineTool 与 register 都从服务拿，与宿主装配约定一致）
  ctx.inject(['tools'], (tc) => {
    const registry = tc?.get?.('tools');
    if (!registry?.register) { log.warn('dsh-useful-tools: tools 服务不可用，mark/unmark 未注册'); return; }
    const defineTool = registry.defineTool;
    const specs = [
      makeTool('mark_read', '把文件标记为已读（补发宿主 fs/observed），之后原生 write/edit 可直接修改该文件而不报 has not been read。反向操作用 unmark_read。', () => undefined),
      makeTool('unmark_read', '撤回 mark_read 的标记：让原生 write/edit 对该文件恢复「必须先读」的门禁（会改为报 file changed since it was read）。', () => ({ kind: 'present', version: 'stale:unmarked' })),
    ];
    try {
      for (const spec of specs) {
        registry.register(defineTool ? defineTool(spec) : spec);
        toolSpecs.push(spec);
      }
    } catch (e) { log.warn(`dsh-useful-tools: 工具注册失败: ${(e && e.message) || e}`); }
  });

  // 自动标记钩子：fs 服务就绪后注册（inject 回调内，避免 fsCtx 尚未就绪导致早退）
  ctx.inject(['fs'], (c) => {
    const on = registerObserveHook(ctx, { fsCtx: c, cfg: config, log });
    if (!on) log.warn('dsh-useful-tools: 自动标记钩子未注册（开关关闭或上下文缺失）');
  });

  return { name: 'dsh-useful-tools' };
}
