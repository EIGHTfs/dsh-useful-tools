/**
 * 工具：mark_read —— 读命令集合（哪些命令读过的文件算「已读」）
 *
 * 目录即工具名（见 lib/index.js 动态扫描）。实现下沉在 lib/core/mark-read/。
 *
 * 就两个参数（按需求方定稿）：
 *   ① commands —— 命令集合；可直接写（"cat,grep"），也可从文件读（传文件路径或 @文件）；
 *      不传时用预置清单（lib/core/mark-read/read-commands.json：cat/grep/head/tail/sed/awk/seq…）。
 *   ② undo     —— 撤销①里的命令（从集合移除）；不带就是加入。
 *
 * 「所有文件都生效」：集合里的命令执行后，它读过的**所有文件**自动补发观测（tools/post-execute 钩子），
 *   不需要指定文件——要指定文件直接 read 就行了。
 * 「永久有效」：集合落盘（<DSH_HOME>/useful-tools/config.json），钩子每次现读 ⇒ 改完即时生效、重启仍在。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readConfig, writeConfig, normalizeTools } from '../../core/mark-read/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PRESET_FILE = join(HERE, '..', '..', 'core', 'mark-read', 'read-commands.json');

export const description = '读命令集合：哪些命令（cat/grep/head/sed/awk/seq…）读过的文件算已读。'
  + '参数一 commands 是命令集合（可直接写，也可传文件路径从文件读；不传用预置清单）；参数二 undo 撤销这些命令。'
  + '集合里的命令读过的**所有文件**自动生效，不需要指定文件。';

export const parameters = {
  type: 'object',
  properties: {
    commands: { type: 'string', description: '命令集合（逗号分隔，如 "cat,grep"），或传文件路径/@"文件"从文件读；不传用预置清单' },
    undo: { type: 'boolean', description: 'true = 撤销这些命令（从集合移除）；缺省 = 加入集合（持久生效）' },
  },
};

/** 读预置命令清单。 */
function loadPreset() {
  try {
    const raw = JSON.parse(readFileSync(PRESET_FILE, 'utf8'));
    return Array.isArray(raw?.commands) ? raw.commands : [];
  } catch {
    return [];
  }
}

/**
 * 解析第一个参数：命令集合。
 * 支持三种形态：① 逗号分隔命令串 ② 文件路径（文件里每行/逗号一个命令）③ 空 → 预置清单。
 */
function parseCommands(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return loadPreset();
  const filePath = v.startsWith('@') ? v.slice(1) : (existsSync(v) ? v : '');
  if (filePath) {
    try {
      const text = readFileSync(filePath, 'utf8');
      const list = text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
      if (list.length) return list;
    } catch { /* 读不到就按命令串解析 */ }
  }
  return normalizeTools(v);
}

export async function run(args = {}) {
  const undo = args.undo === true || args.undo === 'true';
  const incoming = parseCommands(args.commands);
  if (!incoming.length) return { ok: false, error: '命令集合为空：请传 commands（命令串或文件路径），或确认预置清单存在' };

  const cur = readConfig();
  const next = undo
    ? cur.observeTools.filter((t) => !incoming.includes(t))
    : [...new Set([...cur.observeTools, ...incoming])];
  const r = writeConfig({ observeTools: next });
  if (!r.ok) return { ok: false, error: r.error };
  return {
    ok: true,
    action: undo ? 'remove' : 'add',
    undo,
    changed: incoming,
    commands: r.config.observeTools,
    path: r.path,
    note: undo ? '已从读命令集合移除' : '已加入读命令集合（持久生效，所有文件自动生效）',
  };
}
