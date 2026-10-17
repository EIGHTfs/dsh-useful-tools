/**
 * 工具：mark_read —— 文件已读标记（标记 / 撤销 / 批量，全部走参数）
 *
 * 目录即工具名：本目录名 mark_read 就是注册到宿主的工具名（见 lib/index.js 动态扫描）。
 * 实现下沉在 lib/core/mark-read/，这里只做参数面与调度。
 */
import { observeFileForHost, markedPathsSnapshot, clearMarkedPaths } from '../../core/mark-read/observe.js';

export const description = '把文件标记为已读（补发宿主 fs/observed），之后原生 write/edit 可直接改而不报 has not been read。'
  + '参数：paths/file_path 指定文件；all:true 作用于台账内全部文件；undo:true 撤销（还原成宿主原生「要求先读」）。';

export const parameters = {
  type: 'object',
  properties: {
    paths: { type: 'string', description: '目标文件路径，逗号分隔可一次多个' },
    file_path: { type: 'string', description: '单个目标文件路径（与宿主编辑工具同名参数）' },
    all: { type: 'boolean', description: 'true = 作用于台账内全部文件（增加=重标记；配合 undo=true=整体还原）' },
    undo: { type: 'boolean', description: 'true = 撤销标记（还原成宿主原生「要求先读」）' },
  },
};

const UNMARK = () => ({ kind: 'present', version: 'stale:unmarked' });

function splitPaths(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export async function run(args = {}, { ctx, exec } = {}) {
  const undo = args.undo === true || args.undo === 'true';
  const wantAll = args.all === true || args.all === '--all' || args.all === 'all';
  const list = wantAll ? markedPathsSnapshot() : splitPaths(args.paths).concat(splitPaths(args.file_path));
  if (!list.length) {
    return { ok: false, error: wantAll ? '标记台账为空（还没有标记过任何文件）' : '未提供路径（paths / file_path）' };
  }
  const observation = undo ? UNMARK() : undefined;
  const results = [];
  for (const p of list.slice(0, 50)) {
    results.push({ path: p, ...(await observeFileForHost(ctx, exec, p, observation)) });
  }
  const okCount = results.filter((r) => r.ok).length;
  const out = { ok: true, undo, all: wantAll, count: okCount, results };
  if (wantAll && undo) {
    clearMarkedPaths();
    out.summary = `已还原 ${okCount} 个文件的标记`;
  }
  return out;
}
