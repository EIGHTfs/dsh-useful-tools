/**
 * profile 的模块热重载（hmr）配置：读取与幂等启用
 *
 * ## 为什么单独成模块
 * `sync_plugin` 的 `hmr` 参数要「启用热重载」，而热重载是否工作取决于两处：
 *   ① profile 的 `cordis.patch.yml` 里有没有 `- id: hmr` 且 `root` 含 `local-plugins`；
 *   ② 插件实际落在 `local-plugins`（真源）还是只在 `node_modules`（hmr 默认把该目录整棵剪枝）。
 * 这里管 ①，②由 install.mjs 的 judgeHmr 判定。
 *
 * ## base 必须用版本无关表达式
 * `base: !!js 'ctx.get("profileContext").dir'`
 * 写死版本目录（`…/0.2.0/.dsh/profiles/web`）会在升级后指向不存在的目录，hmr 在 init 阶段
 * `realpathSync(baseDir)` 就抛错 → 监视器根本没建起来，且崩掉的 hmr 连配置变更都监视不了
 * （改配置也不自愈，必须重启宿主一次）。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 推荐的 base 写法（版本无关：启动器提供的当前 profile 绝对路径）。 */
export const RECOMMENDED_BASE = `!!js 'ctx.get("profileContext").dir'`;
/** 本工具负责补进 root 的监视目录。 */
export const WATCH_ROOT = 'local-plugins';
/** 判断 base 是否写死了版本号（如 /0.2.0/、-v1.2.3/）。 */
const VERSION_PINNED = /[\\/]\d+\.\d+\.\d+/;

/**
 * 读 profile 的 hmr 配置（`cordis.patch.yml` 里 `- id: hmr` 块的 base / root）。
 * 文本扫描而非引 YAML 依赖：只需要两项，且该文件由插件管理器生成、结构稳定。
 * @returns {{found:boolean, profileDir:string, base:string, root:string[], reason:string}}
 */
export function readHmrConfig(profileDir, patchPath = '') {
  const baseDir = profileDir || '';
  const file = patchPath || join(baseDir, 'cordis.patch.yml');
  if (!baseDir && !patchPath) return { found: false, profileDir: baseDir, base: '', root: [], reason: '未给出 profile 目录' };
  if (!existsSync(file)) return { found: false, profileDir: baseDir, base: '', root: [], reason: '该 profile 没有 cordis.patch.yml' };
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return { found: false, profileDir: baseDir, base: '', root: [], reason: 'cordis.patch.yml 读失败' }; }
  const i = text.search(/^-\s*id:\s*hmr\s*$/m);
  if (i < 0) {
    return { found: false, profileDir: baseDir, base: '', root: [], reason: '未配置 id: hmr —— hmr 默认 root:[] 只重载 profile 配置，不 watch 任何模块目录' };
  }
  const rest = text.slice(i);
  const nextIdx = rest.slice(1).search(/^-\s/m);
  const block = nextIdx < 0 ? rest : rest.slice(0, nextIdx + 1);
  // base 可能是普通路径，也可能是 `!!js '表达式'`（含空格）——取引号内整体，再退回标量
  const baseLine = (block.match(/^[ \t]*base:[ \t]*(.*?)[ \t]*$/m) || [])[1] || '';
  const base = (baseLine.match(/'([^']+)'/) || baseLine.match(/"([^"]+)"/) || [])[1] || baseLine.trim();
  // ⚠ 这里不能用 \s*（\s 含换行，会把 root: 后的换行吃掉，导致再要求 \n 时匹配失败）——只吃行内空白。
  const rootBlock = ((block.match(/^[ \t]*root:[ \t]*\r?\n((?:[ \t]+-[ \t]*\S+[ \t]*\r?\n?)+)/m) || [])[1] || '');
  const root = [...rootBlock.matchAll(/-[ \t]*(\S+)/g)].map((m) => m[1]);
  return { found: true, profileDir: baseDir, base, root, reason: '' };
}

/** 定位 `- id: hmr` 块的行区间 [start, end)（end 不含尾部空行）。 */
function findHmrBlock(lines) {
  const start = lines.findIndex((line) => /^-\s*id:\s*hmr\s*$/.test(line));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^-\s/.test(lines[i]) || /^-\S/.test(lines[i])) { end = i; break; }
  }
  let last = end;
  while (last - 1 > start && lines[last - 1].trim() === '') last -= 1;
  return { start, end: last };
}

/**
 * 整块重建 hmr 条目。
 *
 * 为什么重建而非逐行替换：逐行正则替换会在 `root: []` 这种行内写法下留下**重复键与错缩进**
 * （实测把一个可用的 patch 文件写坏过）。重建的语义是「root = 原有项 ∪ local-plugins（保序），
 * base 缺失或写死版本目录时替换为表达式，其它键原样保留」。
 * @returns {{lines:string[], changed:string[], warnings:string[]}}
 */
function rebuildHmrBlock(blockLines) {
  const head = blockLines[0];
  const cfgIdx = blockLines.findIndex((line) => /^[ \t]+config:/.test(line));
  const cfgIndent = cfgIdx >= 0 ? /^[ \t]*/.exec(blockLines[cfgIdx])[0] : '  ';
  const childIndent = `${cfgIndent}  `;
  const beforeCfg = cfgIdx >= 0 ? blockLines.slice(1, cfgIdx) : blockLines.slice(1);
  const body = cfgIdx >= 0 ? blockLines.slice(cfgIdx + 1) : [];

  const roots = [];
  const kept = [];
  let hadRootKey = false;
  for (let i = 0; i < body.length; i += 1) {
    const line = body[i];
    const rootMatch = /^([ \t]+)root:[ \t]*(.*)$/.exec(line);
    if (rootMatch) {
      hadRootKey = true;
      const inline = rootMatch[2].trim();
      // 行内形式：root: [a, b] 或 root: []
      if (inline && inline !== '[]') {
        for (const piece of inline.replace(/^\[/, '').replace(/\]$/, '').split(',')) {
          const v = piece.trim().replace(/^['"]|['"]$/g, '');
          if (v && !roots.includes(v)) roots.push(v);
        }
      }
      // 列表形式：吃掉后续更深缩进的 `- item`
      while (i + 1 < body.length && /^[ \t]+-[ \t]*\S+/.test(body[i + 1])) {
        i += 1;
        const item = /^-[ \t]*(\S+)/.exec(body[i].trim());
        if (item && !roots.includes(item[1])) roots.push(item[1]);
      }
      continue;
    }
    if (line.trim() === '') continue;
    kept.push(line);
  }

  const changed = [];
  const warnings = [];
  const baseLine = kept.find((line) => /^[ \t]+base:/.test(line)) || '';
  const baseValue = (/^[ \t]+base:[ \t]*(.*)$/.exec(baseLine) || [])[1] || '';
  let baseOut = baseLine;
  if (!baseValue) {
    baseOut = `${childIndent}base: ${RECOMMENDED_BASE}`;
    changed.push('补 hmr.base（profileContext.dir 表达式）');
  } else if (/profileContext/.test(baseValue)) {
    // 已经是版本无关表达式，保持原样
  } else if (VERSION_PINNED.test(baseValue)) {
    baseOut = `${childIndent}base: ${RECOMMENDED_BASE}`;
    changed.push('hmr.base 由写死版本目录改为 profileContext.dir');
    warnings.push(`base 原本写死版本目录（${baseValue}），升级后 hmr 会在 init 阶段抛错并整体失效`);
  }

  if (!roots.includes(WATCH_ROOT)) {
    roots.push(WATCH_ROOT);
    changed.push(hadRootKey ? `hmr.root += ${WATCH_ROOT}` : `补 hmr.root: [${WATCH_ROOT}]`);
  }

  const out = [head, ...beforeCfg.filter((line) => line.trim()), `${cfgIndent}config:`];
  if (baseOut) out.push(baseOut);
  for (const line of kept) if (!/^[ \t]+base:/.test(line)) out.push(line);
  out.push(`${childIndent}root:`);
  for (const r of roots) out.push(`${childIndent}  - ${r}`);
  return { lines: out, changed, warnings };
}

/**
 * 幂等启用 profile 的模块热重载（`sync_plugin` 的 hmr 参数用）。
 *
 * 只补不破坏：已有 hmr 块时保留其结构与其它条目；已齐备时不动盘。
 * @param {{profileDir?: string}} p
 * @param {{write?: boolean}} [opts] 缺省 dryRun（只报计划）
 * @returns {{ok:boolean, changed:string[], plan:string[], path?:string, nowWatching:boolean, warnings?:string[], restartNote?:string, error?:string}}
 */
export function ensureHmrConfig({ profileDir = '' } = {}, { write = false } = {}) {
  if (!profileDir) return { ok: false, changed: [], plan: [], nowWatching: false, error: '缺少 profile 目录' };
  const patchPath = join(profileDir, 'cordis.patch.yml');
  let text = '';
  if (existsSync(patchPath)) {
    try { text = readFileSync(patchPath, 'utf8'); } catch (e) {
      return { ok: false, changed: [], plan: [], nowWatching: false, path: patchPath, error: `cordis.patch.yml 读取失败：${(e && e.message) || e}` };
    }
  }

  const lines = text.split(/\r?\n/);
  const block = findHmrBlock(lines);
  // planned = 本次需要补的项；changed 只在**真落盘**时才非空（dryRun 不能谎报已改）
  const planned = [];
  const warnings = [];
  let nextLines = lines;

  if (!block) {
    planned.push(`新建 hmr 条目（base=profileContext.dir、root=[${WATCH_ROOT}]）`);
    if (write) {
      // 接在最后一个非空行之后，保持原文件的末尾空行习惯
      let last = nextLines.length;
      while (last > 0 && nextLines[last - 1].trim() === '') last -= 1;
      const tail = ['- id: hmr', '  config:', `    base: ${RECOMMENDED_BASE}`, '    root:', `      - ${WATCH_ROOT}`];
      nextLines = [...nextLines.slice(0, last), ...tail, ''];
    }
  } else {
    const rebuilt = rebuildHmrBlock(lines.slice(block.start, block.end));
    planned.push(...rebuilt.changed);
    warnings.push(...rebuilt.warnings);
    if (write && rebuilt.changed.length) {
      nextLines = [...lines.slice(0, block.start), ...rebuilt.lines, ...lines.slice(block.end)];
    }
  }

  let changed = [];
  if (write && planned.length) {
    try {
      const out = nextLines.join('\n');
      const tmp = `${patchPath}.tmp-${process.pid}`;
      writeFileSync(tmp, out.endsWith('\n') ? out : `${out}\n`, 'utf8');
      renameSync(tmp, patchPath);
      changed = planned;
    } catch (e) {
      return { ok: false, changed: [], plan: planned, nowWatching: false, path: patchPath, error: `写入失败：${(e && e.message) || e}` };
    }
  }

  // 复查以**磁盘现状**为准：写盘时确认已含 WATCH_ROOT；dryRun 时反映「现在还没 watch」
  const after = readHmrConfig(profileDir);
  const nowWatching = after.root.includes(WATCH_ROOT);

  const result = {
    ok: true,
    changed,
    plan: planned,
    path: patchPath,
    nowWatching,
    ...(warnings.length ? { warnings } : {}),
  };
  if (write && changed.length) {
    result.restartNote = '配置类改动通常免重启；但若 hmr 此前从未成功启动过（例如 base 曾指向不存在的版本目录），需重启宿主一次才能建起 watcher';
  }
  return result;
}
