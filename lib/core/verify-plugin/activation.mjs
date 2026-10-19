/**
 * 激活诊断：插件「装了但没起来」的离线判定。
 *
 * 覆盖三类静默失败（都不会报错，只会让 apply() 不执行、路由 404）：
 *   ① profile 的 dependencies 没登记插件（pnpm/DSH 解析不到）
 *   ② profile 的 dsh.profile.bundles 没列插件（bundle 不被加载）
 *   ③ 离线组合出的 loader 行里没有插件（bundle patch 缺 insert / 未被应用）
 *
 * 全部只读文件、不启动宿主；「离线组合」= profile 的 cordis.patch.yml + 各 bundle 自己声明的 patch。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { inspectProfiles } from '../plugin-sync/install.mjs';

/**
 * 从一段 cordis.patch.yml 文本里解析 insert 行。
 * 只认顶层 `- insert:` 块内的 `- id:` 与 `name:`（零依赖，不引 YAML 解析器）。
 */
export function parseInsertLines(text, source = '') {
  const lines = [];
  const rows = String(text || '').split('\n');
  let inInsert = false;
  let insertIndent = 0;
  let current = null;
  for (const row of rows) {
    const indent = row.length - row.trimStart().length;
    const trimmed = row.trim();
    if (!trimmed) continue;
    if (/^-\s*insert:\s*$/.test(trimmed)) {
      inInsert = true;
      insertIndent = indent;
      current = null;
      continue;
    }
    if (!inInsert) continue;
    // 同级或更浅缩进出现新条目 ⇒ insert 块结束
    if (indent <= insertIndent && /^-/.test(trimmed)) {
      inInsert = false;
      current = null;
      continue;
    }
    const idMatch = /^-\s*id:\s*(\S+)/.exec(trimmed);
    if (idMatch) {
      current = { id: idMatch[1], name: '', source };
      lines.push(current);
      continue;
    }
    const nameMatch = /^name:\s*(\S+)/.exec(trimmed);
    if (nameMatch && current && !current.name) current.name = nameMatch[1];
  }
  return lines;
}

/** 读某个已安装包自己声明的 bundle patch，并解析出 insert 行。 */
function linesFromBundlePatch(profileDir, pkgName) {
  const pkgPath = join(profileDir, 'node_modules', pkgName, 'package.json');
  if (!existsSync(pkgPath)) return { pkgName, lines: [], reason: 'node_modules 里没有该包' };
  let pkg;
  try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')); } catch { return { pkgName, lines: [], reason: 'package.json 解析失败' }; }
  const rel = pkg?.dsh?.bundle?.patch;
  if (!rel) return { pkgName, lines: [], reason: 'package.json 未声明 dsh.bundle.patch' };
  const patchPath = join(profileDir, 'node_modules', pkgName, String(rel));
  if (!existsSync(patchPath)) return { pkgName, lines: [], reason: `patch 文件不存在：${rel}` };
  let text = '';
  try { text = readFileSync(patchPath, 'utf8'); } catch { return { pkgName, lines: [], reason: 'patch 读取失败' }; }
  return { pkgName, lines: parseInsertLines(text, `${pkgName}:${rel}`), reason: '' };
}

/**
 * 离线组合某个 profile 的装配信息。
 * @param {{dshHome?: string, profile?: string}} options
 */
export function collectActivation({ dshHome = process.env.DSH_HOME || '', profile = '' } = {}) {
  const profiles = inspectProfiles(dshHome);
  const picked = profiles.find((p) => p.name === profile) || profiles[0];
  if (!picked) {
    return { ok: false, error: `在 ${dshHome || '(未设置 DSH_HOME)'} 下没找到任何 profile`, profiles: [] };
  }
  const pkgPath = join(picked.dir, 'package.json');
  if (!existsSync(pkgPath)) return { ok: false, error: `profile 缺少 package.json：${pkgPath}` };
  let pkg = {};
  try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')); } catch (e) {
    return { ok: false, error: `profile package.json 解析失败：${(e && e.message) || e}` };
  }

  const dependencies = pkg.dependencies || {};
  const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];

  // ① profile 自己的 patch
  const profilePatch = join(picked.dir, 'cordis.patch.yml');
  const lines = [];
  const notes = [];
  if (existsSync(profilePatch)) {
    try {
      lines.push(...parseInsertLines(readFileSync(profilePatch, 'utf8'), 'profile:cordis.patch.yml'));
    } catch { notes.push('profile 的 cordis.patch.yml 读取失败'); }
  } else {
    notes.push('profile 没有 cordis.patch.yml（loader 行可能全部来自各 bundle 的 patch）');
  }

  // ② 每个 bundle 自己声明的 patch
  for (const pkgName of bundles) {
    const got = linesFromBundlePatch(picked.dir, pkgName);
    if (got.reason) notes.push(`${pkgName}: ${got.reason}`);
    lines.push(...got.lines);
  }

  return {
    ok: true,
    profile: picked.name,
    profileDir: picked.dir,
    dependencies,
    bundles,
    lines,
    notes,
    availableProfiles: profiles.map((p) => p.name),
  };
}

/**
 * 判定目标插件「是否会被加载」。
 * @param {{pluginName: string, info: ReturnType<typeof collectActivation>}} params
 */
export function checkActivation({ pluginName, info }) {
  const problems = [];
  const warnings = [];
  if (!pluginName) return { problems: ['插件 package.json 缺少 name，无法判定激活'], warnings, facts: {} };
  if (!info || !info.ok) return { problems: [info?.error || '装配信息收集失败'], warnings, facts: {} };

  const inDependencies = Object.prototype.hasOwnProperty.call(info.dependencies, pluginName);
  const depSpec = info.dependencies[pluginName] || '';
  const inBundles = info.bundles.includes(pluginName);
  const line = info.lines.find((l) => l.name === pluginName || l.id === pluginName) || null;

  if (!inDependencies) {
    problems.push(`profile(${info.profile}) 的 dependencies 里没有 ${pluginName} —— 应写 "file:local-plugins/${pluginName}"，否则宿主解析不到`);
  } else if (!String(depSpec).startsWith('file:') && !String(depSpec).startsWith('link:')) {
    warnings.push(`dependencies 里的 ${pluginName} 指向 ${depSpec}（不是 file:local-plugins/… 形态），开发态可能解析到别处`);
  }
  if (!inBundles) {
    problems.push(`profile(${info.profile}) 的 dsh.profile.bundles 里没有 ${pluginName} —— bundle 不会被加载，apply() 不会执行`);
  }
  if (!line) {
    problems.push(`离线组合出的 loader 行里没有 ${pluginName} —— bundle 的 cordis.patch.yml 可能缺顶层 "- insert:"，或 patch 未被应用`);
  }

  return {
    problems,
    warnings,
    facts: {
      profile: info.profile,
      profileDir: info.profileDir,
      inDependencies,
      dependencySpec: depSpec,
      inBundles,
      loaderLine: line,
      loaderLineCount: info.lines.length,
      bundles: info.bundles,
    },
  };
}

/**
 * 从日志里提取 `did not activate` 段落，并按包名归类。
 * 第三方插件的激活失败通常只出现在这里，而 verify_plugin 过去只报「有 N 条报错」。
 */
export function parseDidNotActivate(logTexts = []) {
  const hits = [];
  for (const file of logTexts) {
    if (!file.text) continue;
    for (const line of file.text.split('\n')) {
      if (!/did not activate/i.test(line)) continue;
      // 抓 @scope/name 或裸包名；去掉常见噪声词
      const names = [...line.matchAll(/(@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*|\b[a-z][\w.-]{2,})/gi)]
        .map((m) => m[0])
        .filter((n) => !['did', 'not', 'activate', 'the', 'and', 'plugin', 'plugins'].includes(n.toLowerCase()));
      hits.push({ file: file.file, line: line.trim().slice(0, 300), names: [...new Set(names)].slice(0, 8) });
    }
  }
  // 按名字聚合：同一个包反复报错只留最后一条
  const byName = new Map();
  for (const hit of hits) {
    const key = hit.names[0] || '(未识别)';
    byName.set(key, hit);
  }
  return { hits: hits.slice(-20), byName: [...byName.entries()].map(([name, hit]) => ({ name, ...hit })) };
}
