/**
 * 依赖体检：插件的 dependencies / peerDependencies 在目标 profile 里能不能解析。
 *
 * 为什么需要：开发态依赖写成 `file:../xxx.tgz` 或指向工作区时，
 * 同步进 `local-plugins/` 后路径失效 → 插件 import 失败 → 表现为「装了但不激活」，
 * 症状与装配问题一模一样，但根因完全不同，必须分开报。
 *
 * 判据（不执行被验证插件），**解析基准必须与插件运行时一致**：
 *   插件代码在 `<targetDir>` 里，它 import 时 Node 从那里向上找，
 *   所以 `<targetDir>/node_modules/<name>`（嵌套依赖）是最常见且完全合法的位置。
 *   旧实现只从 profile 根解析，把「装在插件自己 node_modules 里的依赖」一律报成缺失
 *   （实测误报：某插件的 tree-sitter-wasms 就在 `local-plugins/<插件>/node_modules` 下，
 *   运行时一切正常，体检却每次都说找不到）。
 *
 *   ① `<targetDir>/node_modules/<name>` 存在 ⇒ 可解析（插件内嵌套，最常见）
 *   ② `<profile>/node_modules/<name>` 存在 ⇒ 可解析（被 hoist 到 profile 顶层）
 *   ③ 否则用 createRequire 从 `<targetDir>`（缺失时退化为 profile）解析，可能命中更上层
 *   ④ file:/link: 依赖额外检查源路径是否存在（开发态最容易坏的一类）
 *   ⑤ optionalDependencies 不参与判定——它们允许缺席
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

/**
 * @param {{pluginRoot: string, profileDir: string, targetDir?: string}} params
 *   targetDir = 插件在部署端的实际目录（如 `<profile>/local-plugins/<插件>`）。
 *   省略时退化为只按 profile 解析（旧行为，会有嵌套依赖误报）。
 * @returns {{ok: boolean, checked: number, missing: Array<{name: string, spec: string, why: string}>, notes: string[]}}
 */
export function checkDeps({ pluginRoot, profileDir, targetDir = '' }) {
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
  const optionalNames = Object.keys(pkg.optionalDependencies || {});
  if (!names.length) return { ok: true, checked: 0, missing, notes: ['插件没有 dependencies / peerDependencies'] };

  // 插件在部署端的目录：Node 运行插件时就是从这里解析依赖的，判定基准必须与之一致
  const deployedDir = targetDir && existsSync(join(targetDir, 'package.json')) ? targetDir : '';
  if (targetDir && !deployedDir) {
    notes.push(`目标目录里没有 package.json（${targetDir}），依赖按 profile 根解析，嵌套依赖可能被误报`);
  }

  // 解析基准：优先插件实际位置，命中不到再退到 profile 根
  const requireFrom = [];
  for (const base of [deployedDir, profileDir].filter(Boolean)) {
    try { requireFrom.push(createRequire(join(base, 'package.json'))); } catch { /* 构造失败就跳过一个基准 */ }
  }

  for (const name of names) {
    const spec = String(specs[name] || '');
    // ① / ② 目录判据：插件内嵌套与 profile 顶层都算可解析
    if (deployedDir && existsSync(join(deployedDir, 'node_modules', name))) continue;
    if (existsSync(join(profileDir, 'node_modules', name))) continue;
    // ④ file:/link: 形态：源路径在开发态下是否存在
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
    // ③ 交给 Node 解析（从插件位置出发，可命中更上层 node_modules）
    if (requireFrom.some((req) => { try { req.resolve(name); return true; } catch { return false; } })) continue;
    // ⑤ 可选依赖允许缺席，报出来但不算失败
    if (optionalNames.includes(name)) {
      notes.push(`${name} 是可选依赖（optionalDependencies），未安装属正常`);
      continue;
    }
    missing.push({ name, spec, why: '插件目录与 profile 的 node_modules 都找不到，Node 解析也未命中' });
  }

  return { ok: missing.length === 0, checked: names.length, missing, notes };
}
