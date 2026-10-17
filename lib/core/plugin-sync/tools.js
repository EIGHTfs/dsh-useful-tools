/**
 * 插件同步工具封装：把 sync-plugin.mjs 的能力暴露成 toolcall 与斜杠命令。
 *
 * 用途：开发期把「本插件工作区代码」同步进各 profile 的 local-plugins（软链布局下免重启热重载）。
 * 默认 dryRun（只报差异不写入）；write:true 才真同步——与 scripts/sync-plugin.mjs CLI 同一口径。
 */
import { syncPlugin } from './sync-plugin.mjs';
import { inspectProfiles } from './install.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync, lstatSync, cpSync } from 'node:fs';

/** 工具结果里最多回报的待写文件数（完整清单由 files 总量 + 说明体现）。 */
const MAX_FILES_IN_RESULT = 20;

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

export async function runSync(args = {}) {
  const dshHome = String(args.dshHome || process.env.DSH_HOME || '');
  const pluginName = String(args.pluginName || 'dsh-useful-tools');
  // 插件根 = lib/core/plugin-sync 上溯三层；用 fileURLToPath 而非 URL.pathname（后者在 Windows 得到 /C:/...）
  const source = String(args.source || fileURLToPath(new URL('../../../', import.meta.url)));
  let target = String(args.target || '');
  let profile = String(args.profile || '');
  if (!target && dshHome) {
    const hit = resolveTarget(dshHome, profile, pluginName);
    if (hit) { target = hit.dir; profile = hit.profile; }
    // 兜底：新建的环境（如测试环境）可能还没有 local-plugins 目录——按第一个 profile 推算目标，
    //   目录由同步步骤自己创建，不要求预先存在。
    if (!target) {
      const first = inspectProfiles(dshHome).find((p) => !profile || p.name === profile);
      if (first) { target = join(first.dir, 'local-plugins', pluginName); profile = first.name; }
    }
  }
  if (!target) return { ok: false, error: '未定位到目标（需 target 参数或 DSH_HOME 指向含 profiles 的 .dsh 目录）' };
  const r = await syncPlugin({ source, target, write: args.write === true });
  const out = {
    ok: r.ok, profile, target, write: args.write === true,
    written: r.written, skipped: r.skipped, error: r.error || undefined,
    files: (r.files || []).slice(0, MAX_FILES_IN_RESULT),
  };
  // 注册（可选）：同步落盘后把插件写进 profile 的 dependencies + dsh.profile.bundles。
  //   目标 profile 由 dshHome 决定 ⇒ 同一份代码可注册进主实例或测试环境（不写死路径）。
  if (args.register === true) {
    out.register = args.write === true
      ? registerPlugin({ dshHome, profile, pluginName })
      : { ok: false, skipped: 'register 需要 write:true（dryRun 不写盘）' };
  }
  return out;
}

/** 注册到宿主：工具 sync_plugin + 斜杠命令 /sync-plugin（--write 真写，缺省 dryRun）。 */
export function registerSyncTools(ctx, { log } = {}) {
  const spec = {
    name: 'tool_sync_plugin',
    description: '把本插件工作区代码同步到 DSH profile 的 local-plugins（软链布局免重启热重载）。默认 dryRun 只报差异；write:true 才真写。',
    parameters: {
      type: 'object',
      properties: {
        write: { type: 'boolean', description: 'true = 真同步写盘（缺省只预演）' },
        profile: { type: 'string', description: '目标 profile 名（缺省取第一个能定位到的）' },
        source: { type: 'string', description: '插件源码根目录（缺省本插件根）' },
      },
    },
    output: { schema: { type: 'string' }, render: (v) => [{ type: 'text', text: String(v) }] },
    async execute(args) { return JSON.stringify(await runSync(args)); },
  };
  try {
    ctx.inject(['tools'], (tc) => {
      const registry = tc?.get?.('tools');
      if (!registry?.register) { log?.warn?.('dsh-useful-tools: tools 服务不可用，sync_plugin 未注册'); return; }
      registry.register(registry.defineTool ? registry.defineTool(spec) : spec);
    });
  } catch (e) { log?.warn?.(`dsh-useful-tools: sync_plugin 注册失败: ${(e && e.message) || e}`); }

  try {
    ctx.inject(['commands'], (cc) => {
      const registry = cc?.commands || cc?.get?.('commands');
      if (!registry?.register) return;
      registry.register({
        name: 'sync-plugin',
        description: '同步本插件代码到 profile（缺省 dryRun；--write 真写）',
        input: { type: 'string' },
        handler: async (input) => {
          const tokens = String(input ?? '').trim().split(/\s+/).filter(Boolean);
          const write = tokens.some((t) => /^(--write|-w)$/i.test(t));
          const pi = tokens.findIndex((t) => t === '--profile');
          const profile = pi >= 0 ? tokens[pi + 1] : undefined;
          const r = await runSync({ write, profile });
          return { kind: r.ok ? 'success' : 'error', text: JSON.stringify(r) };
        },
      });
    });
  } catch (e) { log?.warn?.(`dsh-useful-tools: /sync-plugin 注册失败: ${(e && e.message) || e}`); }
}
