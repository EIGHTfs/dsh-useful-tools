/**
 * 依赖体检：插件的 dependencies / peerDependencies 在目标 profile 里能不能解析。
 *
 * 为什么需要：开发态依赖写成 `file:../xxx.tgz` 或指向工作区时，
 * 同步进 `local-plugins/` 后路径失效 → 插件 import 失败 → 表现为「装了但不激活」，
 * 症状与装配问题一模一样，但根因完全不同，必须分开报。
 *
 * 判据（不执行被验证插件）：
 *   ① `<profile>/node_modules/<name>` 存在 ⇒ 可解析（最可靠，不依赖模块格式）
 *   ② 否则用 createRequire 从 profile 的 package.json 解析（可能命中上层 node_modules）
 *   ③ file:/link: 依赖额外检查源路径是否存在（开发态最容易坏的一类）
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

/**
 * @param {{pluginRoot: string, profileDir: string}} params
 * @returns {{ok: boolean, checked: number, missing: Array<{name: string, spec: string, why: string}>, notes: string[]}}
 */
export function checkDeps({ pluginRoot, profileDir }) {
  const notes = [];
  const missing = [];
  if (!pluginRoot || !existsSync(join(pluginRoot, 'package.json'))) {
    return { ok: false, checked: 0, missing: [{ name: '(package.json)', spec: '', why: '插件根缺少 package.json' }], notes };
  }
  if (!profileDir || !existsSync(profileDir)) {
    return { ok: false, checked: 0, missing: [], notes: ['没有目标 profile 目录，跳过依赖体检'] };
  }

  let pkg = {};
  try { pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')); } catch (e) {
    return { ok: false, checked: 0, missing: [{ name: '(package.json)', spec: '', why: `解析失败：${(e && e.message) || e}` }], notes };
  }

  const specs = { ...(pkg.dependencies || {}), ...(pkg.peerDependencies || {}) };
  const names = Object.keys(specs);
  if (!names.length) return { ok: true, checked: 0, missing, notes: ['插件没有 dependencies / peerDependencies'] };

  // 从目标 profile 出发解析：命中上层 node_modules 也算可解析
  let requireFrom = null;
  try { requireFrom = createRequire(join(profileDir, 'package.json')); } catch { /* 构造失败则只用目录判据 */ }

  for (const name of names) {
    const spec = String(specs[name] || '');
    // ① 目标 profile 的 node_modules 里直接有
    if (existsSync(join(profileDir, 'node_modules', name))) continue;
    // ③ file:/link: 形态：源路径在开发态下是否存在
    const local = /^(?:file|link):(.+)$/.exec(spec);
    if (local) {
      const raw = local[1];
      const abs = isAbsolute(raw) ? raw : resolve(pluginRoot, raw);
      if (!existsSync(abs)) {
        missing.push({ name, spec, why: `本地路径不存在：${abs}（同步到 local-plugins 后相对路径会失效，建议改成相对 profile 的 file: 或在 profile 里安装）` });
        continue;
      }
      notes.push(`${name} 的 ${spec} 指向本地路径且存在，但同步后该路径相对部署副本可能失效`);
      continue;
    }
    // ② 交给 Node 解析（可能命中上层 node_modules）
    if (requireFrom) {
      try { requireFrom.resolve(name); continue; } catch { /* 落到下面报缺失 */ }
    }
    missing.push({ name, spec, why: '目标 profile 的 node_modules 与 Node 解析都找不到' });
  }

  return { ok: missing.length === 0, checked: names.length, missing, notes };
}
