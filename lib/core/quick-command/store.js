/**
 * 快捷命令定义的读写：<DSH_HOME>/useful-tools/quick-commands.json
 *
 * 结构：{ "<名字>": { "command": "...", "description": "..." } }
 *   · 兼容值为纯字符串（{"名字": "命令"}）——读时归一成对象。
 *   · 文件不存在时返回预置定义（lib/core/quick-command/preset.json），
 *     预置里的 {startScript} 占位符在读取时替换成探测到的 start.sh 路径。
 *
 * 为什么预置也走 JSON 文件：命令是「用户可 edit 的数据」，不该硬编码在代码里。
 * 为什么写盘用临时文件 + rename：直接覆盖时进程被杀会留下半个 JSON，
 *   下次读取整张表报废；rename 是原子的（同目录内）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStartScript } from './locate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PRESET_FILE = join(HERE, 'preset.json');

/** 快捷名白名单：字母数字下划线点连字符（限制成安全字符，避免写进 JSON 的键破坏结构）。 */
export const NAME_RE = /^[A-Za-z0-9_.-]+$/;

/** 定义文件路径（DSH_HOME 缺失时返回空串，调用方报错）。 */
export function storePath() {
  const home = String(process.env.DSH_HOME || '').trim();
  return home ? join(home, 'useful-tools', 'quick-commands.json') : '';
}

/**
 * 读预置定义，并展开 {startScript} 占位符。
 * @returns {Record<string, {command: string, description: string}>}
 */
export function readPreset() {
  try {
    const raw = JSON.parse(readFileSync(PRESET_FILE, 'utf8')) || {};
    const startScript = resolveStartScript();
    const out = {};
    for (const [name, def] of Object.entries(raw)) {
      out[name] = {
        command: String(def?.command ?? '').replaceAll('{startScript}', startScript),
        description: String(def?.description ?? ''),
      };
    }
    return out;
  } catch {
    return {};
  }
}

/** 归一一条定义：纯字符串 → 对象；缺字段补空串。 */
function normalizeDef(value) {
  if (typeof value === 'string') return { command: value, description: '' };
  return { command: String(value?.command ?? ''), description: String(value?.description ?? '') };
}

/**
 * 读定义表。
 * @returns {{ok: boolean, path?: string, items?: Record<string, {command: string, description: string}>, preset?: boolean, error?: string}}
 */
export function readStore() {
  const path = storePath();
  if (!path) return { ok: false, error: 'DSH_HOME 未设置，无法定位 quick-commands.json' };
  // 首次使用：文件不存在时给预置定义（restart 等），并标记 preset
  if (!existsSync(path)) return { ok: true, path, items: readPreset(), preset: true };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) || {};
    const items = {};
    for (const [name, def] of Object.entries(raw)) items[name] = normalizeDef(def);
    return { ok: true, path, items, preset: false };
  } catch (error) {
    return { ok: false, path, error: `quick-commands.json 解析失败：${(error && error.message) || error}` };
  }
}

/**
 * 写定义表（原子替换）。
 * 调用方负责把要保留的条目一并传进来——本函数不做「合并预置」，
 *   否则用户 delete restart 之后会被悄悄写回去。
 * @param {Record<string, {command: string, description: string}>} items
 */
export function writeStore(items) {
  const path = storePath();
  if (!path) return { ok: false, error: 'DSH_HOME 未设置，无法定位 quick-commands.json' };
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(items, null, 2) + '\n', 'utf8');
    renameSync(tmp, path);
    return { ok: true, path, items };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}
