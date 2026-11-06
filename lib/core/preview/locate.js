/**
 * 预览页基础设施 · 环境定位（DSH 安装根 / DSH_HOME / React UMD）
 *
 * 为什么单独成文件：原先每个插件的 preview-gen 都抄一份「找 DSH 根 + 找 UMD + 下载缓存」的
 * 探测链，换机/换工作区就失效、四处漂移。这里收敛为唯一实现，各插件只写自己的垫片。
 *
 * 探测顺序（均可用环境变量覆盖）：
 *   DSH 根  ：DSH_ROOT → DSH_HOME 上级链 → 常见安装位 → 插件根上溯（判据：含 package.json + node_modules）
 *   DSH_HOME：DSH_HOME 环境变量 → ~/.dsh（不枚举数据根猜布局）
 *   UMD     ：REACT_UMD_DIR → <DSH_HOME>/cache/react-umd（扁平或 react/umd 嵌套）→ 各 profile/node_modules
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';

/** 判断某目录像不像 DSH 安装根。 */
export function isDshRoot(dir) {
  return Boolean(dir) && existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'node_modules'));
}

/**
 * 常见安装位（探测候选，**不是硬依赖**）：命中就用，命中不了还有 env 与上溯兜底。
 * 候选按平台覆盖：Linux 自带套件布局、容器布局、用户目录；macOS 走 ~/Applications 与 Homebrew；
 * Windows 走 %LOCALAPPDATA% 与 Program Files。没有覆盖到的安装位仍可由 DSH_ROOT 指定。
 */
const DSH_ROOT_CANDIDATES = [
  '/volume1/@appstore/DeepSeekHarness-NAS', // 群晖套件安装位  dsh-allow-cross-platform: 安装根无统一环境变量，候选 + 上溯兜底
  '/var/packages/DeepSeekHarness-NAS/target', // 群晖套件 target  dsh-allow-cross-platform
  '/app/DeepSeekHarness-NAS', // 容器/自定义安装位
  join(homedir(), 'DeepSeekHarness-NAS'), // 用户目录自装（跨平台兜底）
  join(homedir(), 'Applications', 'DeepSeekHarness-NAS'), // macOS
  join(homedir(), 'Library', 'Application Support', 'DeepSeekHarness-NAS'), // macOS 数据旁落
  join(process.env.LOCALAPPDATA || '', 'DeepSeekHarness-NAS'), // Windows 用户级
  join(process.env.ProgramFiles || '', 'DeepSeekHarness-NAS'), // Windows 机器级
].filter((candidate) => Boolean(candidate) && isAbsolute(candidate));

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
  for (const guess of DSH_ROOT_CANDIDATES) {
    if (isDshRoot(guess)) return guess;
  }
  return ascendForRoot(pluginRoot);
}

/**
 * 定位 DSH_HOME（数据目录 .dsh）。
 *
 * 只认两个来源：`DSH_HOME` 环境变量 → `~/.dsh`。
 * 不再枚举「常见数据根」去猜套件/版本目录——DSH 进程里 `DSH_HOME` 本身就是可直接取到的值，
 * 猜布局既写死了别人机器的路径（换机即失效），也会在无关目录上空跑一遍 readdir。
 */
export function findDshHome() {
  const fromEnv = String(process.env.DSH_HOME || '').trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  // 用 os.homedir() 而不是 process.env.HOME：Windows 上 HOME 通常不存在（那里用 USERPROFILE），
  //   拿到空串后 join 会退化成相对路径 .dsh，变成「按当前工作目录去找」——跨平台必错。
  const fromHome = join(homedir(), '.dsh');
  if (existsSync(join(fromHome, 'profiles'))) return fromHome;
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

/** 候选目录清单：安装根下的 UMD 目录 + DSH_HOME 的 UMD 缓存与 profile 的 node_modules。 */
function umdCandidateDirs(root, dshHome, profile) {
  const dirs = [];
  if (root) for (const name of UMD_DIR_NAMES) dirs.push(join(root, name));
  if (!dshHome) return dirs;
  const cache = join(dshHome, 'cache', 'react-umd');
  dirs.push(cache);
  for (const name of UMD_DIR_NAMES) dirs.push(join(cache, name));
  const profileDir = join(dshHome, 'profiles', profile);
  dirs.push(join(profileDir, 'node_modules', 'react', 'umd'),
    join(profileDir, 'node_modules', 'react-dom', 'umd'),
    join(profileDir, 'node_modules'));
  return dirs;
}

/** 在候选根目录下枚举 react / react-dom 的 UMD。 */
function searchUmd(root, dshHome, profile) {
  let react = '';
  let dom = '';
  for (const dir of umdCandidateDirs(root, dshHome, profile)) {
    if (!react) react = pick(dir, REACT_PATTERNS);
    if (!dom) dom = pick(dir, DOM_PATTERNS);
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
  // os.tmpdir() 才认 Windows 的 TEMP/TMP；写死 '/tmp' 在 Windows 上会落到盘根 C:\tmp。
  const cacheDir = process.env.REACT_UMD_DIR || join(home || join(tmpdir(), 'dsh-preview'), 'cache', 'preview-umd');
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
  const reactSource = readFileSync(react, 'utf8');
  const domSource = readFileSync(dom, 'utf8');
  writeFileSync(cached.react, reactSource);
  writeFileSync(cached.reactDom, domSource);
  return { react: reactSource, reactDom: domSource, from: cacheDir };
}
