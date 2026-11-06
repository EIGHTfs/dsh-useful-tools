/**
 * 预览页基础设施 · 环境定位（DSH 安装根 / DSH_HOME / React UMD）
 *
 * 为什么单独成文件：原先每个插件的 preview-gen 都抄一份「找 DSH 根 + 找 UMD + 下载缓存」的
 * 探测链，换机/换工作区就失效、四处漂移。这里收敛为唯一实现，各插件只写自己的垫片。
 *
 * 探测顺序（均可用环境变量覆盖）：
 *   DSH 根  ：DSH_ROOT → DSH_HOME 上级链 → 配置 dshRootCandidates → 插件根上溯（判据：含 package.json + node_modules）
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
 * 外置配置里的安装根候选（`<DSH_HOME>/useful-tools/config.json` 的 `dshRootCandidates`）。
 *
 * 为什么不在代码里写候选：DSH 装在哪因机器而异，写死的路径换机即失效，
 * 而且「常见安装位」永远枚举不完。需要非标准位置时由使用者写进配置，
 * 或者直接给 `DSH_ROOT` 环境变量——代码不猜。
 */
function configuredRootCandidates() {
  const home = String(process.env.DSH_HOME || '').trim() || findDshHome();
  if (!home) return [];
  try {
    const cfg = JSON.parse(readFileSync(join(home, 'useful-tools', 'config.json'), 'utf8'));
    const list = Array.isArray(cfg?.dshRootCandidates) ? cfg.dshRootCandidates : [];
    return list.map((item) => String(item || '').trim()).filter((item) => item && isAbsolute(item));
  } catch {
    return [];
  }
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
  // ① 显式环境变量：给了就以它为准；给了但无效直接返回空，让调用方报错，
  //    而不是悄悄换一条猜的路径继续跑（那样问题会以「找不到 UMD」之类的形式跑到别处）。
  const explicit = String(process.env.DSH_ROOT || '').trim();
  if (explicit) return isDshRoot(explicit) ? explicit : '';
  // ② 从 DSH_HOME 推导：数据目录的上级链里通常就是安装根
  const home = process.env.DSH_HOME || findDshHome();
  if (home) {
    const hit = ascendForRoot(dirname(home)) || ascendForRoot(home);
    if (hit) return hit;
  }
  // ③ 外置配置给的候选（非标准安装位写在这里，不写进代码）
  for (const candidate of configuredRootCandidates()) {
    if (isDshRoot(candidate)) return candidate;
  }
  // ④ 从插件根上溯（零配置兜底）
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
