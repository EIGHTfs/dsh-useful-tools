/**
 * 插件装载验证（汇总层）：静态分析 + 部署一致性 + 宿主日志，三项一次给全。
 *
 * ⚠ 只做静态分析：只读文件，绝不 import、绝不执行被验证插件的代码。
 *   原因：插件的模块顶层与 apply 都可能带副作用（起服务、写台账、改配置），
 *   验证一个插件不该顺带把它跑起来。代价是「注册是否真的成功」不能替代宿主内实测，
 *   这一点在输出的 staticOnly / notes 里明确标注。
 *
 * 静态分析在 static.mjs（入口/apply/注册调用/effect 风险/patch 结构）；
 * 本文件负责部署一致性（源码 vs profile 副本）与宿主日志扫描，并汇总结论。
 */
import { readFileSync, readdirSync, existsSync, statSync, realpathSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectTargets, listSyncFiles } from '../plugin-sync/sync-plugin.mjs';
import { inspectProfiles } from '../plugin-sync/install.mjs';
import { analyzePlugin } from './static.mjs';

// 日志只读到这个大小，避免把几十 MB 的反代日志整个读进内存
const MAX_LOG_BYTES = 2 * 1024 * 1024;
// 单次扫描最多回报的日志命中行数
const MAX_LOG_HITS = 10;
// 报错关键词：命中其一才算「值得看的日志行」
const LOG_ERROR_RE = /did not activate|Invalid effect|TypeError|ReferenceError|Cannot find|failed to import|Error:/i;

/** 本插件根目录（lib/core/verify-plugin/ 往上三级）。 */
export function defaultPluginRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

/** 相对路径按 plugin 根解析，绝对路径原样返回。 */
function rootOf(value, fallback) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  return isAbsolute(raw) ? raw : resolve(raw);
}

/** 列出某个 profile（或全部 profile）里已安装的本地插件。 */
export function listInstalledPlugins({ dshHome, profile } = {}) {
  const out = [];
  for (const p of inspectProfiles(dshHome)) {
    if (profile && p.name !== profile) continue;
    for (const name of p.localPlugins) out.push({ name, root: join(p.localDir, name), profile: p.name });
  }
  return out;
}

/**
 * 解析目标插件根：绝对/相对路径直接校验；裸插件名则到各 profile 的
 * local-plugins / node_modules 里找——使用者不必记绝对路径。
 */
export function resolvePluginRoot({ plugin, dshHome, profile } = {}) {
  const raw = String(plugin || '').trim();
  if (!raw) return { ok: false, error: '未指定插件（传根目录或插件名；留空则巡检所有已装插件）' };
  if (isAbsolute(raw) || raw.startsWith('.')) {
    const abs = isAbsolute(raw) ? raw : resolve(raw);
    if (!existsSync(abs)) return { ok: false, error: `插件目录不存在: ${abs}` };
    return { ok: true, root: abs };
  }
  const profiles = inspectProfiles(dshHome).filter((p) => !profile || p.name === profile);
  for (const p of profiles) {
    for (const cand of [join(p.localDir, raw), join(p.dir, 'node_modules', raw)]) {
      if (existsSync(cand)) return { ok: true, root: cand, profile: p.name };
    }
  }
  const where = profiles.map((p) => p.name).join(' / ') || '任何';
  return { ok: false, error: `在 ${where} profile 里找不到插件 ${raw}（也可以直接传插件根目录）` };
}

/**
 * 部署一致性：源码根 vs 各 profile 的插件副本，逐文件比内容。
 * 目标来源 detectTargets（local-plugins 优先，其次 node_modules）。
 */
export async function checkDeploy({ source, dshHome, profile, pluginName }) {
  if (!dshHome) return { ok: false, error: 'DSH_HOME 未设置，无法定位部署目标' };
  if (!pluginName) return { ok: false, error: '插件 package.json 缺少 name，无法定位部署目标' };
  const targets = detectTargets(dshHome, pluginName, profile);
  if (!targets.length) return { ok: false, error: `未找到部署目标（${pluginName} 不在任何 profile 的 local-plugins / node_modules）`, targets: [] };
  // 去重：node_modules/<插件> 通常是软链指向 local-plugins/<插件>，realpath 相同只查一次
  const seen = new Set();
  const uniqueTargets = [];
  for (const t of targets) {
    let key = t;
    try { key = realpathSync(t); } catch { /* 软链坏了就按原路径算 */ }
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueTargets.push(t);
  }
  let files;
  try { files = await listSyncFiles(source); } catch (e) {
    return { ok: false, error: `列源码文件失败: ${e?.message || e}`, targets };
  }
  const detail = [];
  for (const target of uniqueTargets) {
    const missing = [];
    const different = [];
    for (const rel of files) {
      const from = join(source, rel);
      const to = join(target, rel);
      if (!existsSync(to)) { missing.push(rel); continue; }
      try {
        if (readFileSync(from, 'utf8') !== readFileSync(to, 'utf8')) different.push(rel);
      } catch { different.push(rel); }
    }
    detail.push({ target, missing, different, inSync: missing.length === 0 && different.length === 0 });
  }
  const ok = detail.every((d) => d.inSync);
  return { ok, targets: detail };
}

/** 候选日志文件：DSH_HOME 上一级的主日志 + DSH_HOME/logs 下最新的几个。 */
function logCandidates(dshHome) {
  const out = [];
  if (!dshHome) return out;
  const main = join(dirname(dshHome), 'DeepSeekHarness-NAS.log');
  if (existsSync(main)) out.push(main);
  const logsDir = join(dshHome, 'logs');
  if (existsSync(logsDir)) {
    try {
      const files = readdirSync(logsDir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith('.log'))
        .map((d) => ({ path: join(logsDir, d.name), mtime: statSync(join(logsDir, d.name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 3);
      for (const f of files) out.push(f.path);
    } catch { /* 目录读不了就跳过 */ }
  }
  return out;
}

/**
 * 读候选日志的正文（巡检时只读一次，各插件共用，避免重复读盘）。
 * 大文件（>MAX_LOG_BYTES）跳过——反代日志几十 MB，读它只会拖慢检查。
 */
export function readLogTexts(dshHome) {
  const out = [];
  for (const file of logCandidates(dshHome)) {
    let fileStat;
    try { fileStat = statSync(file); } catch { continue; }
    if (fileStat.size > MAX_LOG_BYTES) { out.push({ file, skipped: `体积 ${(fileStat.size / 1048576).toFixed(1)}MB 超限` }); continue; }
    try { out.push({ file, text: readFileSync(file, 'utf8'), mtime: fileStat.mtimeMs }); } catch { /* 读失败跳过 */ }
  }
  return out;
}

/**
 * 宿主日志扫描：只回报「带插件名且像报错」的行，最多 maxHits 条。
 * @param logTexts 可选的预读结果（巡检模式复用同一份，避免重复读盘）
 */
export function scanHostLog({ dshHome, pluginName, maxHits = MAX_LOG_HITS, logTexts } = {}) {
  const files = logTexts || readLogTexts(dshHome);
  const hits = [];
  const scanned = [];
  for (const f of files) {
    if (f.text === undefined) { scanned.push({ file: f.file, skipped: f.skipped }); continue; }
    scanned.push({ file: f.file, lines: f.text.split('\n').length, mtime: f.mtime ? new Date(f.mtime).toISOString() : undefined });
    for (const line of f.text.split('\n')) {
      if (!line.includes(pluginName)) continue;
      if (!LOG_ERROR_RE.test(line)) continue;
      hits.push({ file: f.file, line: line.trim().slice(0, 400) });
    }
  }
  return { scanned, hits: hits.slice(-maxHits) };
}

/** 验证单个插件：静态分析 + 部署一致性 + 宿主日志。 */
async function verifyOne({ root, source, dshHome, profile, args, logTexts }) {
  const analysis = analyzePlugin(root);
  if (analysis.error && /package\.json/.test(analysis.error)) {
    // 不是插件目录（残留/软链/说明文件），巡检时跳过而不是算失败
    return { ok: true, skipped: true, reason: analysis.error, plugin: { root, name: basename(root) } };
  }
  const pluginName = analysis.packageName || '';
  const deploy = await checkDeploy({ source: source || root, dshHome, profile, pluginName });
  const log = args.log === false ? { scanned: [], hits: [] } : scanHostLog({ dshHome, pluginName, logTexts });

  // 结论：硬伤排前面，启发式提示单列
  const problems = [...(analysis.problems || [])];
  const warnings = [...(analysis.warnings || [])];
  if (analysis.error) problems.unshift(analysis.error);
  if (!deploy.ok) {
    if (deploy.error) problems.push(`部署检查失败：${deploy.error}`);
    for (const d of deploy.targets || []) {
      if (d.inSync) continue;
      if (d.missing.length) problems.push(`部署副本缺 ${d.missing.length} 个文件：${d.missing.slice(0, 5).join(', ')}`);
      if (d.different.length) problems.push(`部署副本与源码不一致（${d.different.length} 个）：${d.different.slice(0, 5).join(', ')}`);
    }
  }
  if (log.hits.length) {
    // 日志里的报错可能早于本次修复：日志文件最后写入时间 < 源码最后修改时间 ⇒ 判为历史记录
    const srcMtime = Math.max(0, ...(analysis.filesAnalyzed || []).map((f) => {
      try { return statSync(f).mtimeMs; } catch { return 0; }
    }));
    const logMtime = new Map((log.scanned || []).filter((s) => s.mtime).map((s) => [s.file, Date.parse(s.mtime)]));
    for (const hit of log.hits) hit.stale = (logMtime.get(hit.file) || 0) > 0 && (logMtime.get(hit.file) || 0) < srcMtime;
    const fresh = log.hits.filter((h) => !h.stale);
    if (fresh.length) problems.push(`宿主日志有 ${fresh.length} 条相关报错（见 log.hits）`);
    else warnings.push(`宿主日志有 ${log.hits.length} 条相关报错，但日志早于当前源码的最后修改——判为修复前的历史记录，等宿主重载/重启后日志才会刷新`);
  }

  return {
    ok: problems.length === 0,
    conclusion: problems.length ? problems : ['静态检查通过：入口/注册调用/effect 形态正常，部署副本一致，宿主日志无相关报错'],
    warnings,
    plugin: { root, source: source || root, name: pluginName, version: analysis.packageVersion },
    analysis,
    deploy,
    log,
    staticOnly: true,
    notes: ['只做静态分析：未执行插件代码，因此「注册是否真的成功」仍需宿主内实测（工具是否真的出现在工具清单里）。'],
  };
}

/**
 * 汇总入口：
 *   - 传 plugin（根目录或插件名）→ 验证单个插件；
 *   - 不传 plugin → 巡检 profile 里所有已装插件，逐个给结论。
 * @returns 结构化结果；单插件时 ok/conclusion 在顶层，巡检时在 plugins[] 里。
 */
export async function runVerify(args = {}) {
  const dshHome = String(args.dshHome || process.env.DSH_HOME || '');
  const profile = String(args.profile || '');
  const rawPlugin = String(args.plugin || '').trim();
  // 宿主日志只读一次：巡检与单插件两条路径共用同一份（log:false 表示不扫日志）
  const logTexts = args.log === false ? [] : readLogTexts(dshHome);

  // 巡检模式：不给 plugin 就逐个验已装插件（日志复用上面这一份）
  if (!rawPlugin) {
    const installed = listInstalledPlugins({ dshHome, profile });
    if (!installed.length) return { ok: false, mode: 'scan', conclusion: ['没有找到任何已安装的本地插件（profile 的 local-plugins 为空）'], plugins: [] };
    const plugins = [];
    for (const p of installed) {
      plugins.push(await verifyOne({ root: p.root, dshHome, profile: p.profile, args, logTexts }));
    }
    const checked = plugins.filter((p) => !p.skipped);
    const bad = checked.filter((p) => !p.ok);
    return {
      ok: bad.length === 0,
      mode: 'scan',
      staticOnly: true,
      summary: { total: plugins.length, checked: checked.length, ok: checked.length - bad.length, failed: bad.length, skipped: plugins.length - checked.length },
      conclusion: bad.length
        ? bad.map((p) => `${p.plugin.name || p.plugin.root}：${p.conclusion[0]}`)
        : [`${checked.length} 个插件全部通过静态检查`],
      plugins,
    };
  }

  const hit = resolvePluginRoot({ plugin: rawPlugin, dshHome, profile });
  if (!hit.ok) return { ok: false, mode: 'single', conclusion: [hit.error] };
  const out = await verifyOne({
    root: hit.root,
    source: rootOf(args.source, ''),
    dshHome,
    profile: hit.profile || profile,
    args,
    logTexts,
  });
  out.mode = 'single';
  return out;
}
