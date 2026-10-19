/**
 * inject 服务名校验：插件声明的服务名在「当前 DSH 安装」里到底存不存在。
 *
 * 为什么单列一个模块：服务名拼错（webserver vs webServer）不会报错，
 * 插件会「加载成功但拿不到服务」，业务代码走守卫降级 → 路由永远 404。
 * 这类静默失败只能靠静态比对发现，是本工具最值钱的检查之一。
 *
 * 可用服务名的来源（按可靠度）：
 *   ① `ctx.provide('name')` / `ctx.set('name', …)` —— cordis 注册服务的写法，最可靠
 *   ② `ctx.inject(['a','b'], …)` / `ctx.get('name')` —— 消费方写法，能反推存在性
 *   ③ 内置兜底清单（扫不到时用，并在结果里标注来源，避免假装「扫描过」）
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { findDshRoot } from '../preview/locate.js';

// 扫描上限：DSH 安装里包很多，无上限会拖慢每次验证
const MAX_FILES = 4000;
const MAX_FILE_BYTES = 512 * 1024;
// 目录递归深度上限（软链可能指到别处，给个硬边界防意外展开）
const MAX_DEPTH = 6;
// 只扫这些目录（相对 DSH 根）：DSH 自身装配代码 + 核心包源码 + 包入口
const SCAN_ROOTS = ['apps/cli/lib', 'packages/core', 'node_modules/@deepseek-ai'];

// 扫不到 DSH 源码时的兜底服务名（DSH 0.2.x 实测存在；结果里会标注 fallback:true）
const FALLBACK_SERVICES = [
  'tools', 'fs', 'sessions', 'commands', 'locale', 'slots', 'webServer',
  'storageDomain', 'workspaceRegistry', 'sandbox', 'models', 'credentials',
];

// 模块级缓存：同一个 DSH 根只扫一次（巡检多个插件时避免重复遍历）
const cache = new Map();

/** 递归列文件（带数量上限）。软链要按真实目标判断类型：
 *  pnpm 布局下 `node_modules/@deepseek-ai/*` 都是符号链接，只看 isDirectory() 会把它们全跳过
 *  （实测：漏了这一步只扫到 15 个文件、服务名表几乎是空的）。 */
function walkFiles(dir, out, limit, depth = 0) {
  if (out.length >= limit || depth > MAX_DEPTH) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (out.length >= limit) return;
    const full = join(dir, entry.name);
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      try { isDir = statSync(full).isDirectory(); } catch { isDir = false; }
    }
    if (isDir) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      walkFiles(full, out, limit, depth + 1);
    } else if (/\.(js|mjs|cjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
}

/** 服务名形态过滤：排除常量、特殊字符、过短过长的噪声
 *  （不滤的话 `EXA_API_KEY`、`(Default)`、`*` 这类都会混进「可用服务名」，
 *  把真正拼错的名字判成「存在」——那比不检查更糟）。 */
function isServiceName(name) {
  const value = String(name || '');
  if (!/^[a-zA-Z][\w]*$/.test(value)) return false;
  if (value.length < 2 || value.length > 40) return false;
  if (/^[A-Z0-9_]+$/.test(value)) return false;
  return true;
}

/** 从一份源码里抽取服务名。 */
function servicesIn(text) {
  const names = new Set();
  const add = (name) => { if (isServiceName(name)) names.add(name); };
  // class X extends Service { constructor(ctx) { super(ctx, 'tools') } } —— cordis 的服务名写法，最可靠
  for (const m of text.matchAll(/super\s*\(\s*ctx\s*,\s*['"]([^'"]+)['"]/g)) add(m[1]);
  // ctx.provide('x') —— 显式注册
  for (const m of text.matchAll(/\bprovide\s*\(\s*['"]([^'"]+)['"]/g)) add(m[1]);
  // ctx.inject(['a','b'], …) —— 数组里都是服务名
  for (const m of text.matchAll(/\binject\s*\(\s*\[([^\]]*)\]/g)) {
    for (const s of m[1].matchAll(/['"]([^'"]+)['"]/g)) add(s[1]);
  }
  // .get('x') —— 消费方写法（不用 ctx.set：Map.set 会引入大量噪声）
  for (const m of text.matchAll(/\.get\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) add(m[1]);
  return names;
}

/**
 * 收集当前 DSH 安装里出现过的服务名。
 * @param {{dshRoot?: string}} options
 * @returns {{services: string[], scannedFiles: number, source: 'scan'|'fallback', dshRoot: string}}
 */
export function collectDshServices({ dshRoot = '' } = {}) {
  const root = String(dshRoot || '').trim() || findDshRoot();
  const key = root || '(none)';
  if (cache.has(key)) return cache.get(key);

  const files = [];
  for (const rel of SCAN_ROOTS) {
    const dir = join(root, rel);
    if (existsSync(dir)) walkFiles(dir, files, MAX_FILES);
  }

  const services = new Set();
  for (const file of files) {
    try {
      if (statSync(file).size > MAX_FILE_BYTES) continue;
      for (const name of servicesIn(readFileSync(file, 'utf8'))) services.add(name);
    } catch { /* 单文件读失败不影响整体 */ }
  }

  const result = files.length && services.size
    ? { services: [...services].sort(), scannedFiles: files.length, source: 'scan', dshRoot: root }
    : { services: [...FALLBACK_SERVICES].sort(), scannedFiles: files.length, source: 'fallback', dshRoot: root };
  cache.set(key, result);
  return result;
}

/**
 * 从插件源码里抽取「声明的 inject 服务名」。
 * 认两种写法：`export const inject = ['a','b']` 与 `ctx.inject(['a'], …)`。
 */
export function extractPluginInject(src) {
  const declared = new Set();
  // export const inject = [...] / inject: [...]
  for (const m of String(src).matchAll(/\binject\s*(?:=|:)\s*\[([^\]]*)\]/g)) {
    for (const s of m[1].matchAll(/['"]([^'"]+)['"]/g)) declared.add(s[1]);
  }
  // ctx.inject(['a'], …)
  for (const m of String(src).matchAll(/\.inject\s*\(\s*\[([^\]]*)\]/g)) {
    for (const s of m[1].matchAll(/['"]([^'"]+)['"]/g)) declared.add(s[1]);
  }
  return [...declared].sort();
}

/** 编辑距离（只用于给出「你是不是想写 X」的近似建议，输入都很短）。 */
function distance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j += 1) dp[0][j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[m][n];
}

/**
 * 校验声明的服务名：返回不存在的名字 + 近似建议。
 * 建议优先按「忽略大小写相同」再按编辑距离，避免给一堆无关候选。
 */
export function checkInjectNames(declared, available) {
  const known = new Set(available);
  const lower = new Map(available.map((name) => [name.toLowerCase(), name]));
  const unknown = [];
  const suggestions = [];
  for (const name of declared) {
    if (known.has(name)) continue;
    unknown.push(name);
    const caseHit = lower.get(String(name).toLowerCase());
    if (caseHit) { suggestions.push({ from: name, to: caseHit, why: '大小写不一致' }); continue; }
    let best = '';
    let bestDistance = 3;
    for (const cand of available) {
      const d = distance(name, cand);
      if (d < bestDistance) { bestDistance = d; best = cand; }
    }
    if (best) suggestions.push({ from: name, to: best, why: `编辑距离 ${bestDistance}` });
  }
  return { unknown, suggestions };
}
