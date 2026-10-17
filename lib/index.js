/**
 * dsh-useful-tools · DSH 有用小工具箱（0.1.0）
 *
 * 首个工具：文件观测标记 —— 一个工具双向用法（撤销是参数，不是另一个工具）：
 *   mark_read paths:"…"            标记已读 ⇒ 原生 write/edit 可直接改
 *   mark_read undo:true paths:"…"  撤销指定文件的标记（还原成宿主原生「要求先读」）
 *   mark_read undo:true all:true   撤销本插件标记过的全部文件（= 完全还原成 dsh 原本状态）
 * 斜杠命令 /mark-read（只给 UI，不进模型历史）：--undo 撤销 · --all 全部 · 其余 token 是路径
 * 自动标记钩子：对配置集合里的工具（默认 grep）执行后自动补发观测，无需手动 mark。
 *
 * 设计取舍：
 *   · 官方 read 只看几行也算读过（门禁尺度 = 有过观测），把 grep 纳入与宿主自身语义一致；
 *   · 观测有效到文件版本再变为止，文件一变自动作废 ⇒ 不会照旧内容改新文件；
 *   · bash 里 cat/sed 等无法可靠判定读了哪些文件，不进默认集合（命令集合开放，填什么生效什么）。
 */
import { observeFileForHost, markedPathsSnapshot, clearMarkedPaths } from './observe.js';
import { registerObserveHook } from './observe-hook.js';
import { registerSyncTools } from './sync-tools.js';

export { observeFileForHost };

/** 解析「路径集合」参数：支持数组或逗号分隔字符串。 */
function splitPaths(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

const UNMARK_PAYLOAD = () => ({ kind: 'present', version: 'stale:unmarked' });

export function apply(ctx, config = {}) {
  const log = { warn: (m) => { try { ctx?.logger?.warn?.(m); } catch { /* 忽略 */ } } };

  /** 核心动作：标记 / 撤销。缺省 = 增加；undo:true = 撤销；
   *  all:true 作用于「读命令集合标记过的全部文件」（台账）：增加模式重标记、撤销模式整体还原。 */
  const runMark = async (args = {}, exec) => {
    const undo = args?.undo === true || args?.undo === 'true';
    const wantAll = args?.all === true || args?.all === '--all' || args?.all === 'all';
    const list = wantAll ? markedPathsSnapshot() : splitPaths(args?.paths).concat(splitPaths(args?.file_path));
    if (!list.length) {
      return { ok: false, error: wantAll ? '标记台账为空（读命令集合还没有标记过任何文件）' : '未提供路径（paths / file_path）' };
    }
    const observation = undo ? UNMARK_PAYLOAD() : undefined;
    const results = [];
    for (const p of list.slice(0, 50)) {
      results.push({ path: p, ...(await observeFileForHost(ctx, exec, p, observation)) });
    }
    const okCount = results.filter((r) => r.ok).length;
    const out = { ok: true, undo, all: wantAll, count: okCount, results };
    if (wantAll && undo) {
      clearMarkedPaths(); // 仅撤销全部时清台账：状态即宿主原生（重读后才算已读）
      out.summary = `已还原 ${okCount} 个文件的标记`;
    }
    return out;
  };

  // ── 1) 工具（toolcall）：一个 mark_read，undo/all 都是参数 ──
  ctx.inject(['tools'], (tc) => {
    const registry = tc?.get?.('tools');
    if (!registry?.register) { log.warn('dsh-useful-tools: tools 服务不可用，mark_read 未注册'); return; }
    const defineTool = registry.defineTool;
    const spec = {
      name: 'mark_read',
      description: '把文件标记为已读（补发宿主 fs/observed），之后原生 write/edit 可直接修改而不报 has not been read。参数：undo:true 撤销指定文件；all:true 作用于「读命令集合标记过的全部文件」（增加模式=重新标记全部，undo:true+all:true=整体还原成宿主原生状态）。',
      parameters: {
        type: 'object',
        properties: {
          paths: { type: 'string', description: '目标文件路径，逗号分隔可一次多个' },
          file_path: { type: 'string', description: '单个目标文件路径（与宿主编辑工具同名参数）' },
          all: { type: 'boolean', description: 'true = 作用于读命令集合标记过的全部文件（增加=重标记全部；配合 undo=true=整体还原）' },
          undo: { type: 'boolean', description: 'true = 撤销标记（还原成宿主原生「要求先读」）' },
        },
      },
      output: { schema: { type: 'string' }, render: (v) => String(v) },
      async execute(args, exec) { return JSON.stringify(await runMark(args, exec)); },
    };
    try {
      registry.register(defineTool ? defineTool(spec) : spec);
    } catch (e) { log.warn(`dsh-useful-tools: 工具注册失败: ${(e && e.message) || e}`); }
  });

  // ── 2) 用户指令（斜杠命令，结果只给 UI）：/mark-read [--undo] [--all] <paths…> ──
  ctx.inject(['commands'], (cc) => {
    const registry = cc?.commands || cc?.get?.('commands');
    if (!registry?.register) { log.warn('dsh-useful-tools: commands 服务不可用，/mark-read 未注册'); return; }
    try {
      registry.register({
        name: 'mark-read',
        description: '标记文件已读（原生 write/edit 可直接改）；--undo 撤销；--all 作用于全部标记过的文件',
        input: { type: 'string' },
        handler: async (input) => {
          const text = typeof input === 'string' ? input : String(input?.input ?? input?.text ?? '');
          const tokens = text.trim().split(/\s+/).filter(Boolean);
          const undo = tokens.some((t) => /^(--undo|-u)$/i.test(t));
          const all = tokens.some((t) => /^(--all|-a)$/i.test(t));
          const paths = tokens.filter((t) => !t.startsWith('-')).join(',');
          const r = await runMark({ paths, all, undo }, null);
          return { kind: r.ok ? 'success' : 'error', text: JSON.stringify(r) };
        },
      });
    } catch (e) { log.warn(`dsh-useful-tools: 斜杠命令注册失败: ${(e && e.message) || e}`); }
  });

  // ── 3) 自动标记钩子：fs 服务就绪后注册（inject 回调内，避免上下文未就绪早退） ──
  ctx.inject(['fs'], (c) => {
    const on = registerObserveHook(ctx, { fsCtx: c, cfg: config, log });
    if (!on) log.warn('dsh-useful-tools: 自动标记钩子未注册（开关关闭或上下文缺失）');
  });

  // ── 4) 插件同步：工具 sync_plugin + 指令 /sync-plugin（缺省 dryRun，--write 真写） ──
  registerSyncTools(ctx, { log });

  return { name: 'dsh-useful-tools' };
}
