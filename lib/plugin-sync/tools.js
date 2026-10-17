/**
 * 插件同步工具封装：把 sync-plugin.mjs 的能力暴露成 toolcall 与斜杠命令。
 *
 * 用途：开发期把「本插件工作区代码」同步进各 profile 的 local-plugins（软链布局下免重启热重载）。
 * 默认 dryRun（只报差异不写入）；write:true 才真同步——与 scripts/sync-plugin.mjs CLI 同一口径。
 */
import { syncPlugin } from './sync-plugin.mjs';
import { inspectProfiles } from './install.mjs';
import { dirname } from 'node:path';
import { existsSync } from 'node:fs';

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

export async function runSync(args = {}) {
  const dshHome = String(args.dshHome || process.env.DSH_HOME || '');
  const pluginName = String(args.pluginName || 'dsh-useful-tools');
  const source = String(args.source || new URL('../', import.meta.url).pathname);
  let target = String(args.target || '');
  let profile = String(args.profile || '');
  if (!target && dshHome) {
    const hit = resolveTarget(dshHome, profile, pluginName);
    if (hit) { target = hit.dir; profile = hit.profile; }
  }
  if (!target) return { ok: false, error: '未定位到目标（需 target 参数或 DSH_HOME 指向含 profiles 的 .dsh 目录）' };
  const r = await syncPlugin({ source, target, write: args.write === true });
  return {
    ok: r.ok, profile, target, write: args.write === true,
    written: r.written, skipped: r.skipped, error: r.error || undefined,
    files: (r.files || []).slice(0, 20),
  };
}

/** 注册到宿主：工具 sync_plugin + 斜杠命令 /sync-plugin（--write 真写，缺省 dryRun）。 */
export function registerSyncTools(ctx, { log } = {}) {
  const spec = {
    name: 'sync_plugin',
    description: '把本插件工作区代码同步到 DSH profile 的 local-plugins（软链布局免重启热重载）。默认 dryRun 只报差异；write:true 才真写。',
    parameters: {
      type: 'object',
      properties: {
        write: { type: 'boolean', description: 'true = 真同步写盘（缺省只预演）' },
        profile: { type: 'string', description: '目标 profile 名（缺省取第一个能定位到的）' },
        source: { type: 'string', description: '插件源码根目录（缺省本插件根）' },
      },
    },
    output: { schema: { type: 'string' }, render: (v) => String(v) },
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
