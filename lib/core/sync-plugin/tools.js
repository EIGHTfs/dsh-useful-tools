/**
 * 插件同步工具封装：把 sync-plugin.mjs 的能力暴露成 toolcall 与斜杠命令。
 *
 * 用途：开发期把「本插件工作区代码」同步进各 profile 的 local-plugins（软链布局下免重启热重载）。
 * 默认 dryRun（只报差异不写入）；write:true 才真同步——与 scripts/sync-plugin.mjs CLI 同一口径。
 */
import { syncPlugin } from './sync-plugin.mjs';
import { applyUpstream } from './upstream.mjs';
import { inspectProfiles, readHmrConfig, judgeHmr } from './install.mjs';
import { ensureHmrConfig } from './hmr-config.mjs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, statSync, writeFileSync, lstatSync, cpSync } from 'node:fs';

/** 工具结果里最多回报的待写文件数（完整清单由 files 总量 + 说明体现）。 */
const MAX_FILES_IN_RESULT = 20;

/** 安全读一个目录里的 package.json 的 name（读不到返回空串，不抛）。 */
function packageNameIn(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return String(pkg?.name ?? '').trim();
  } catch {
    return '';
  }
}

/** 解析同步目标：profile 名 → local-plugins/<插件名> 目录。 */
export function resolveTarget(dshHome, profileName, pluginName) {
  const list = inspectProfiles(dshHome).filter((p) => !profileName || p.name === profileName);
  for (const p of list) {
    if (!Array.isArray(p.localPlugins)) continue;
    const first = String(p.localPlugins[0] || '');
    if (!first) continue;
    // localPlugins 记录的是插件名数组；localDir 字段就是 local-plugins 目录本体
    const base = p.localPluginsDir || p.localDir || (first.includes('/') ? dirname(first) : '');
    if (base && existsSync(base)) return { dir: `${base}/${pluginName}`, profile: p.name };
  }
  return null;
}

/**
 * 注册插件到 profile：写 dependencies（file:local-plugins/<名>）+ 把插件名加进 dsh.profile.bundles。
 * 目标 profile 由 dshHome + profile 名决定（不写死路径）——因此同一份代码可注册进主实例或测试环境。
 * 幂等：已存在同值不改写；bundles 已含则不重复追加。
 * @returns {{ok:boolean, profileDir?:string, changed?:string[], error?:string}}
 */
export function registerPlugin({ dshHome = '', profile = '', pluginName = '' } = {}) {
  if (!dshHome || !pluginName) return { ok: false, error: '注册需要 dshHome 与 pluginName' };
  const profiles = inspectProfiles(dshHome);
  const picked = profiles.find((p) => p.name === profile) || profiles.find((p) => existsSync(join(p.localDir, pluginName))) || profiles[0];
  if (!picked) return { ok: false, error: `在 ${dshHome} 下没找到 profile` };
  const pkgPath = join(picked.dir, 'package.json');
  if (!existsSync(pkgPath)) return { ok: false, error: `profile 缺少 package.json: ${pkgPath}` };
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const changed = [];
    pkg.dependencies = pkg.dependencies || {};
    const want = `file:local-plugins/${pluginName}`;
    if (pkg.dependencies[pluginName] !== want) {
      pkg.dependencies[pluginName] = want;
      changed.push(`dependencies.${pluginName}`);
    }
    pkg.dsh = pkg.dsh || {};
    pkg.dsh.profile = pkg.dsh.profile || {};
    const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
    if (!bundles.includes(pluginName)) {
      bundles.push(pluginName);
      pkg.dsh.profile.bundles = bundles;
      changed.push('dsh.profile.bundles');
    }
    if (changed.length) writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    // 对齐 node_modules 副本：没有 pnpm install 时 DSH 只能从 node_modules 解析 bundle，
    //   而那里若残留旧副本会顶掉 local-plugins 成为实际加载源（旧代码顶新代码）。
    const localDir = join(picked.dir, 'local-plugins', pluginName);
    const nmDir = join(picked.dir, 'node_modules', pluginName);
    try {
      const st = lstatSync(nmDir);
      if (st.isDirectory() && !st.isSymbolicLink() && existsSync(localDir)) {
        cpSync(localDir, nmDir, { recursive: true, force: true });
        changed.push('node_modules 副本已与 local-plugins 对齐');
      }
    } catch { /* 不存在或不可写就跳过——注册本身已生效 */ }
    return { ok: true, profileDir: picked.dir, profile: picked.name, changed };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * 定位写入目标目录（返回 { dir, profile, profileDir, source }）。
 *
 * `target` 显式给了就直接用，并校验它确实存在且是目录：
 *   这条路径可以是任意插件的安装位置（含 `node_modules/<插件名>`，装机版依赖就是这种），
 *   写错目录等于往别人的运行时代码里灌文件，所以宁可拒也不猜。
 * 未给则沿用旧行为：DSH_HOME → profile 的 `local-plugins/<pluginName>`。
 */
function resolveInstallTarget(args, { dshHome, profile, pluginName }) {
  const explicit = String(args.target || '').trim();
  if (explicit) {
    let statInfo = null;
    try { statInfo = statSync(explicit); } catch { /* 交给下面的报错 */ }
    if (!statInfo?.isDirectory()) return { error: `target 不是已存在的目录：${explicit}` };
    // 显式 target 的 profileDir 只在形如 <profile>/local-plugins/<插件> 时有意义；
    // 别的形态（node_modules 直装）没有 profile 归属，置空即可。
    // 判定放在 resolve 之后：入参可能带 ./ 或尾斜杠或 Windows 分隔符，规范化后才能可靠比对。
    const resolvedDir = resolve(explicit);
    const segments = resolvedDir.split(sep);
    const anchor = segments.lastIndexOf('local-plugins');
    const profileDir = anchor > 0 ? segments.slice(0, anchor).join(sep) : '';
    return { dir: resolvedDir, profile: profile || '(显式指定)', profileDir };
  }
  if (!dshHome) return { error: '未定位到目标（需 target 参数或 DSH_HOME 指向含 profiles 的 .dsh 目录）' };
  const hit = resolveTarget(dshHome, profile, pluginName);
  if (hit) return { dir: hit.dir, profile: hit.profile, profileDir: dirname(dirname(hit.dir)) };
  // 兜底：新建的环境（如测试环境）可能还没有 local-plugins 目录——按第一个 profile 推算目标，
  //   目录由同步步骤自己创建，不要求预先存在。
  const first = inspectProfiles(dshHome).find((p) => !profile || p.name === profile);
  if (!first) return { error: `在 ${dshHome} 下没找到 profile` };
  return { dir: join(first.dir, 'local-plugins', pluginName), profile: first.name, profileDir: first.dir };
}

/** 上游更新的数据根：备份与记录都放 `<DSH_HOME>/useful-tools/`（与 config.json 同根，不写死路径）。 */
function upstreamDataRoots(dshHome) {
  const home = String(dshHome || '').trim();
  const base = home ? join(home, 'useful-tools') : join(process.cwd(), '.useful-tools-data');
  return { backupRoot: join(base, 'upstream-backup'), recordDir: join(base, 'upstream-records') };
}

/**
 * 从 GitHub 上游更新「已安装插件目录」：API 算变动、只覆盖变的那些文件。
 * 不 clone、不落 .git；缺省 dryRun，write:true 才动盘（与本地同步同一口径）。
 */
async function runUpstreamSync(args, { dshHome, pluginName, target }) {
  const roots = upstreamDataRoots(dshHome);
  return applyUpstream({
    repo: args.fromGithub,
    ref: args.ref,
    installDir: target.dir,
    pluginName: pluginName || '',
    write: args.write === true,
    backupRoot: roots.backupRoot,
    recordDir: roots.recordDir,
  });
}

export async function runSync(args = {}) {
  const dshHome = String(args.dshHome || process.env.DSH_HOME || '');
  const pluginName = String(args.pluginName || 'dsh-useful-tools');
  // 插件根 = lib/core/sync-plugin 上溯三层；用 fileURLToPath 而非 URL.pathname（后者在 Windows 得到 /C:/...）
  const source = String(args.source || fileURLToPath(new URL('../../../', import.meta.url)));
  const profile = String(args.profile || '');

  // 分支一：fromGithub —— 上游更新装机目录，不碰本地工作区源码。
  if (String(args.fromGithub || '').trim()) {
    const target = resolveInstallTarget(args, { dshHome, profile, pluginName });
    if (target.error) return { ok: false, error: target.error };
    const r = await runUpstreamSync(args, { dshHome, pluginName, target });
    return { ...r, mode: 'upstream', profile: target.profile, target: target.dir };
  }

  // 分支二：本地源码 → 目标目录（旧行为）。
  const target = resolveInstallTarget(args, { dshHome, profile, pluginName });
  if (target.error) return { ok: false, error: target.error };

  // 防呆：显式 target 会把「A 插件的源码」灌进「B 插件的安装位置」。
  //   实测事故——宿主运行态还是旧闭包（不认识 fromGithub）时，一次带 target 的调用
  //   差点把 useful-tools 的 63 个文件同步进 live-compact 目录，只差 write:true 就出事。
  //   拿错目录是必然会发生的人为失误，所以默认拒绝；两边 package.json 名字对不上就要求显式确认。
  if (String(args.target || '').trim() && args.allowMismatch !== true) {
    const sourceName = packageNameIn(source);
    const targetName = packageNameIn(target.dir);
    if (sourceName && targetName && sourceName !== targetName) {
      return {
        ok: false,
        mode: 'local',
        target: target.dir,
        error: `源插件是 ${sourceName}，目标目录已装的是 ${targetName} —— 把源码同步进别的插件的安装位置会覆盖它的运行时代码。确认无误再传 allowMismatch:true`,
      };
    }
  }

  const profileDir = target.profileDir;
  const r = await syncPlugin({ source, target: target.dir, write: args.write === true, profileDir });
  const out = {
    ok: r.ok, profile: target.profile, target: target.dir, write: args.write === true, mode: 'local',
    written: r.written, skipped: r.skipped, error: r.error || undefined,
    // files 现在只含**变动文件**（差异清单），全量口径在 totalCount / unchangedCount
    files: (r.files || []).slice(0, MAX_FILES_IN_RESULT),
    changedCount: (r.files || []).length,
    totalCount: r.totalCount,
    unchangedCount: r.unchangedCount,
    failures: r.failures,
    // 残留：目标里存在、源码没有的文件（改名/删文件后的历史遗留）。
    //   只报告不删除——目标里可能有部署方放的东西，删错一次就够受。
    stale: (r.stale || []).slice(0, MAX_FILES_IN_RESULT),
    staleCount: r.staleCount || 0,
    // 写盘后的收尾检查（dryRun 时为 undefined）
    permissions: r.permissions,
    readable: r.readable,
    deps: r.deps,
  };
  // HMR（可选）：hmr=true 启用该 profile 的模块热重载（改代码免重启）。
  //   做两件事：① 幂等补齐 profile 的 `- id: hmr` + root: [local-plugins]；
  //   ② 顺带报「这个插件现在能不能热重载」——布局不对（只落在 node_modules）时热重载仍不会命中。
  if (args.hmr === true) {
    const wantWrite = args.write === true;
    try {
      const ensured = ensureHmrConfig({ profileDir }, { write: wantWrite });
      const cfg = readHmrConfig(profileDir);
      const judge = judgeHmr({ hmr: cfg, profileDir, pluginName });
      out.hmr = {
        mode: wantWrite ? 'apply' : 'dryrun',
        applied: wantWrite ? ensured.changed : (ensured.plan || []),
        config: { base: cfg.base, root: cfg.root, found: cfg.found, reason: cfg.reason },
        watchable: judge.hot,
        detail: judge.reason,
        ...(ensured.restartNote ? { restartNote: ensured.restartNote } : {}),
      };
    } catch (e) {
      out.hmr = { ok: false, error: String((e && e.message) || e) };
    }
  }
  // 注册（可选）：同步落盘后把插件写进 profile 的 dependencies + dsh.profile.bundles。
  //   目标 profile 由 dshHome 决定 ⇒ 同一份代码可注册进主实例或测试环境（不写死路径）。
  if (args.register === true) {
    out.register = args.write === true
      ? registerPlugin({ dshHome, profile, pluginName })
      : { ok: false, skipped: 'register 需要 write:true（dryRun 不写盘）' };
  }
  return out;
}

