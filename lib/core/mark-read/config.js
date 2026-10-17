/**
 * 读命令集合的配置读写（mark_read 工具与自动钩子共用）
 *
 * 为什么单独成文件：配置必须**落盘**（「命令配置一次、永久有效」），且钩子要**每次现读**
 *   （改完即时生效，不用重启）。放在这里给两个消费方共用，避免两处各自读文件导致口径漂移。
 *
 * 配置文件：<DSH_HOME>/useful-tools/config.json
 *   { "observeHook": true, "observeTools": ["grep", "cat"] }
 *
 * 兜底：文件缺失/坏 JSON → 默认 { observeHook: true, observeTools: ['grep'] }（不崩）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DEFAULT_OBSERVE_TOOLS = ['grep'];

/** 配置文件路径（DSH_HOME 缺失时返回空串，调用方退回默认值）。 */
export function configPath() {
  const home = String(process.env.DSH_HOME || '').trim();
  if (!home) return '';
  return join(home, 'useful-tools', 'config.json');
}

/** 归一化命令集合：数组或逗号分隔字符串 → 去空去重的字符串数组。 */
export function normalizeTools(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(list.map((t) => String(t).trim()).filter(Boolean))];
}

/**
 * 读配置（每次现读，不缓存）。
 * @returns {{observeHook:boolean, observeTools:string[]}}
 */
export function readConfig() {
  const p = configPath();
  const base = { observeHook: true, observeTools: [...DEFAULT_OBSERVE_TOOLS] };
  if (!p || !existsSync(p)) return base;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) || {};
    const tools = normalizeTools(raw.observeTools);
    return {
      observeHook: raw.observeHook !== false,
      observeTools: tools.length ? tools : [...DEFAULT_OBSERVE_TOOLS],
    };
  } catch {
    return base;
  }
}

/**
 * 写配置（合并：只覆盖传入的键）。
 * @param {{observeHook?:boolean, observeTools?:string[]}} patch
 * @returns {{ok:boolean, path?:string, config?:object, error?:string}}
 */
export function writeConfig(patch = {}) {
  const p = configPath();
  if (!p) return { ok: false, error: 'DSH_HOME 未设置，无法定位配置文件' };
  try {
    const cur = readConfig();
    // 保留文件里已有的其它键（如 test_env 的 testEnvRoot）——只覆盖本次传入的 observe* 键
    let raw = {};
    try { raw = JSON.parse(readFileSync(p, 'utf8')) || {}; } catch { raw = {}; }
    const next = {
      ...raw,
      observeHook: patch.observeHook === undefined ? cur.observeHook : patch.observeHook !== false,
      observeTools: patch.observeTools === undefined ? cur.observeTools : normalizeTools(patch.observeTools),
    };
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(next, null, 2) + '\n', 'utf8');
    return { ok: true, path: p, config: next };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
