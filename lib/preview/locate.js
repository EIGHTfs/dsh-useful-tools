/**
 * 预览页基础设施 · 环境定位（DSH 安装根 / DSH_HOME / React UMD）
 *
 * 为什么单独成文件：原先每个插件的 preview-gen 都抄一份「找 DSH 根 + 找 UMD + 下载缓存」的
 * 探测链，换机/换工作区就失效、四处漂移。这里收敛为唯一实现，各插件只写自己的垫片。
 *
 * 探测顺序（均可用环境变量覆盖）：
 *   DSH 根  ：DSH_ROOT → DSH_HOME 上级链 → 常见安装位 → 插件根上溯（判据：含 package.json + node_modules）
 *   DSH_HOME：env → 常见数据目录（/volume1/@appdata/<套件>/<版本>/.dsh 等）
 *   UMD     ：REACT_UMD_DIR → <DSH_HOME>/cache/react-umd（扁平或 react/umd 嵌套）→ 各 profile/node_modules
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** 判断某目录像不像 DSH 安装根。 */
export function isDshRoot(dir) {
  return Boolean(dir) && existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'node_modules'));
}

/** 从起始目录逐级上溯找 DSH 安装根。 */
function ascendForRoot(start) {
  let cur = resolve(start);
  for (let i = 0; i < 12; i += 1) {
    if (isDshRoot(cur)) return cur;
    const up = resolve(cur, '..');
    if (up === cur) break;
    cur = up;
  }
  return '';
}

/**
 * 定位 DSH 安装根。
 * @param {string} [pluginRoot] 上溯兜底起点
 */
export function findDshRoot(pluginRoot = process.cwd()) {
  if (process.env.DSH_ROOT && isDshRoot(process.env.DSH_ROOT)) return process.env.DSH_ROOT;
  const home = process.env.DSH_HOME || findDshHome();
  if (home) {
    const hit = ascendForRoot(dirname(home)) || ascendForRoot(home);
    if (hit) return hit;
  }
  for (const guess of ['/volume1/@appstore/DeepSeekHarness-NAS', '/app/DeepSeekHarness-NAS']) {
    if (isDshRoot(guess)) return guess;
  }
  return ascendForRoot(pluginRoot);
}

/**
 * 定位 DSH_HOME（数据目录 .dsh）。
 * 顺序：DSH_HOME → /volume1/@appdata/<任意>/<版本>/.dsh → ~/.dsh
 */
export function findDshHome() {
  if (process.env.DSH_HOME && existsSync(process.env.DSH_HOME)) return process.env.DSH_HOME;
  const roots = ['/volume1/@appdata', '/vol1/@appdata', join(process.env.HOME || '', '.dsh')];
  // /volume1/@appdata/<套件>/<版本>/.dsh
  try {
    for (const pkg of readdirSync('/volume1/@appdata', { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      const base = join('/volume1/@appdata', pkg.name);
      let versions = [];
      try { versions = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { continue; }
      for (const v of versions.sort().reverse()) {
        const cand = join(base, v, '.dsh');
        if (existsSync(join(cand, 'profiles'))) return cand;
      }
    }
  } catch { /* 无该目录 */ }
  for (const r of roots) if (r && existsSync(join(r, 'profiles'))) return r;
  return '';
}

const REACT_PATTERNS = ['react.production.min.js', 'react.development.js', 'react.js'];
const DOM_PATTERNS = ['react-dom.production.min.js', 'react-dom.development.js', 'react-dom.js'];
const UMD_DIR_NAMES = ['umd', join('node_modules', 'react', 'umd'), join('react', 'umd')];

function pick(dir, patterns) {
  if (!dir || !existsSync(dir)) return '';
  for (const name of patterns) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return '';
}

/** 在候选根目录下枚举 react / react-dom 的 UMD。 */
function searchUmd(root, dshHome, profile) {
  const dirs = [];
  if (root) for (const n of UMD_DIR_NAMES) dirs.push(join(root, n));
  if (dshHome) {
    const cache = join(dshHome, 'cache', 'react-umd');
    for (const n of ['', ...UMD_DIR_NAMES]) dirs.push(n ? join(cache, n) : cache);
    const prof = join(dshHome, 'profiles', profile);
    dirs.push(join(prof, 'node_modules', 'react', 'umd'), join(prof, 'node_modules', 'react-dom', 'umd'), join(prof, 'node_modules'));
  }
  let react = '';
  let dom = '';
  for (const d of dirs) {
    if (!react) react = pick(d, REACT_PATTERNS);
    if (!dom) dom = pick(d, DOM_PATTERNS);
    if (react && dom) break;
  }
  return { react, dom };
}

/**
 * 取 React / ReactDOM 两份 UMD 源码（带磁盘缓存，离线可复用）。
 * @param {{dshRoot?:string, dshHome?:string, profile?:string}} opts
 */
export function loadUmd({ dshRoot = '', dshHome = '', profile = 'web' } = {}) {
  const home = dshHome || findDshHome();
  const cacheDir = process.env.REACT_UMD_DIR || join(home || join(process.env.TMPDIR || '/tmp', 'dsh-preview'), 'cache', 'preview-umd');
  const cached = { react: join(cacheDir, 'react.js'), reactDom: join(cacheDir, 'react-dom.js') };
  if (existsSync(cached.react) && existsSync(cached.reactDom)) {
    return { react: readFileSync(cached.react, 'utf8'), reactDom: readFileSync(cached.reactDom, 'utf8'), from: cacheDir };
  }
  const root = dshRoot || findDshRoot();
  let { react, dom } = searchUmd(root, home, profile);
  if (!react || !dom) {
    // 换 profile 再试一轮（多 profile 环境）
    let profiles = [];
    try { profiles = readdirSync(join(home, 'profiles'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* 忽略 */ }
    for (const p of profiles) {
      const hit = searchUmd('', home, p);
      if (!react && hit.react) react = hit.react;
      if (!dom && hit.dom) dom = hit.dom;
      if (react && dom) break;
    }
  }
  if (!react || !dom) {
    throw new Error(`找不到 React UMD（DSH 根=${root || '未定位'} · DSH_HOME=${home || '未定位'} · profile=${profile}）。可用 REACT_UMD_DIR 指定含 react.js/react-dom.js 的目录。`);
  }
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cached.react, readFileSync(react, 'utf8'));
  writeFileSync(cached.reactDom, readFileSync(dom, 'utf8'));
  return { react: readFileSync(cached.react, 'utf8'), reactDom: readFileSync(cached.reactDom, 'utf8'), from: cacheDir };
}
