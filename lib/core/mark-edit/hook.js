/**
 * mark_edit 的自动续期钩子（**全局生效**，与 mark_read 同口径）
 *
 * mark_read：配一次命令集合 ⇒ 集合里的命令读过的**所有文件**自动补发观测（读侧）。
 * mark_edit：开关打开 ⇒ **所有经写改动过的文件**在写完后按稳定版本再补发观测（写侧）。
 *   —— 不需要指定任何文件，也不维护路径清单。
 *
 * 「写改」覆盖两类：
 *   ① 宿主工具 `write` / `edit`（参数里直接给路径）；
 *   ② **bash 里的写命令**——`> >> tee sed -i cp mv touch truncate dd of=`。
 *      这类改动宿主自己看不到，以前写完之后必须重读；现在同样会被补发观测。
 *
 * ## 为什么要「多检查点」
 * 官方写改成功后补发的版本是「rename 后立刻 probe」拿到的值，而版本串是
 * `dev:ino:size:mtimeNs:ctimeNs`；CIFS/SMB 上属性缓存会在写完约 **1000ms** 时回写一次
 * （实测 5 次试验全为 ~1000ms，与文件大小无关）。早于该点的复核拿到的仍是稳定前的值
 * ⇒ 下一次写改 CAS 对不上 ⇒ `file changed since it was read`。
 * 因此缺省在 1100ms 复核一次，再在 +500/+1300ms 各补一次（多次补发无害，最后一次生效）。
 *
 * ## 边界
 * - 只认上面列出的「有明确目标文件」的写形态；`python -c`、`node -e` 这类无法可靠解析，不猜；
 * - 调用内**先解析**目标（此刻 exec 的 cwd/signal 有效），延迟期间只 stat 已解析目标且不带 signal；
 * - 开关与延迟**每次现读配置**（与 mark_read 一致）：改配置即时生效；
 * - 任何异常只记日志，绝不影响工具结果。
 */
import { observeResolvedTarget } from '../mark-read/observe.js';
import { readEditSettings } from './store.js';

/** 会直接改动文件的宿主工具名。 */
export const MUTATION_TOOLS = ['write', 'edit'];
/** bash 类工具名（写命令藏在命令串里）。 */
export const SHELL_TOOLS = ['bash', 'shell', 'exec'];

/**
 * 自证计数器：钩子有没有真的补发、补发的是什么版本。
 * 排查「连续编辑仍失败」时，用 mark_edit 的 status 一眼看出是「没触发」还是「版本对不上」。
 */
export const refreshStats = { emits: 0, last: null };

/** 延迟窗口缺省值（与 store 保持一致：实测漂移点 ~1000ms，故取 1100ms）。 */
export const DEFAULT_SETTLE_MS = 1100;

/** 从工具调用里取目标路径（宿主各版本字段名不同）。非写改工具返回空串。 */
export function extractTargetPath(toolName, args) {
  if (!MUTATION_TOOLS.includes(String(toolName || ''))) return '';
  const v = args?.path ?? args?.file_path ?? args?.filePath;
  return typeof v === 'string' ? v.trim() : '';
}

/** bash 类工具的命令串（宿主各版本字段名不同）。 */
function commandOf(args) {
  return args?.command ?? args?.script ?? args?.cmd ?? '';
}

/** 归一命令名：去路径、小写、去可执行后缀。 */
function canonCommand(raw) {
  return String(raw ?? '').split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1|sh)$/, '');
}

/** 跳过段首的环境变量赋值与 sudo/env，返回首个命令词下标。 */
function commandTokenIndex(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) && t !== 'sudo' && t !== 'env') break;
    i += 1;
  }
  return i;
}

/** 不是「真实文件目标」的取值（设备、fd 复制、选项）。 */
function unusableTarget(token) {
  const t = String(token || '').trim();
  if (!t || t === '&' || t === '-') return true;
  if (/^&?\d*$/.test(t)) return true;
  if (t.startsWith('&') || t.startsWith('/dev/')) return true;
  if (t.startsWith('-')) return true;
  return false;
}

/** 取「非选项参数」，`--` 之后的都算参数。 */
function nonOptionArgs(tokens) {
  const out = [];
  let afterSep = false;
  for (const t of tokens) {
    if (!afterSep && t === '--') { afterSep = true; continue; }
    if (!afterSep && t.startsWith('-')) continue;
    out.push(t);
  }
  return out;
}

/**
 * 从 bash 命令串里提取「被写入的目标文件」（纯函数，便于单测）。
 *
 * 支持形态（保守，宁少不多——目标不明就不猜）：
 *   · 输出重定向：`cmd > f`、`cmd >> f`、`cmd 2> f`、`cmd >f`
 *   · `tee [-a] f…`：全部非选项参数
 *   · `sed -i …  f…`：带 `-i`/`--in-place` 时，脚本之后的文件参数
 *   · `cp/mv/install …  DST`：最后一个参数
 *   · `touch/truncate …  f…`：全部非选项参数
 *   · `dd … of=f`：`of=` 的值
 * @param {string} command
 * @returns {string[]}
 */
export function extractBashWrites(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return [];
  const out = new Set();
  const push = (token) => {
    const t = String(token ?? '').trim().replace(/^['"]|['"]$/g, '');
    if (!unusableTarget(t)) out.add(t);
  };

  for (const seg of cmd.split(/[|;&]+/)) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const start = commandTokenIndex(tokens);
    if (start >= tokens.length) continue;
    const name = canonCommand(tokens[start]);
    const rest = tokens.slice(start + 1);

    // ① 重定向写出：任何命令都可能带，先按 token 形态收
    for (let i = 0; i < rest.length; i += 1) {
      const t = rest[i];
      const m = /^\d?(>>?)(.+)?$/.exec(t);
      if (!m) continue;
      if (m[2]) push(m[2]);            // `>f` 紧贴写法
      else if (rest[i + 1]) push(rest[i + 1]); // `> f`
    }

    // ② 按命令名收目标
    if (name === 'tee') {
      for (const t of nonOptionArgs(rest)) push(t);
    } else if (name === 'sed') {
      const inPlace = rest.some((t) => t === '--in-place' || /^-i/.test(t));
      if (inPlace) {
        const args = nonOptionArgs(rest);
        // 首个非选项参数是脚本（如 's/a/b/'），其后才是文件
        for (const t of args.slice(1)) push(t);
      }
    } else if (['cp', 'mv', 'install', 'ln'].includes(name)) {
      const args = nonOptionArgs(rest);
      if (args.length >= 2) push(args[args.length - 1]);
    } else if (['touch', 'truncate'].includes(name)) {
      for (const t of nonOptionArgs(rest)) push(t);
    } else if (name === 'dd') {
      for (const t of rest) {
        const m = /^of=(.+)$/.exec(t);
        if (m) push(m[1]);
      }
    }
  }
  return [...out];
}

/** 目标解析：拿不到 cwd 就不带（由 fs 服务用默认值）。 */
async function resolveCwd(fsCtx, exec) {
  try {
    const workingDirectory = fsCtx.get?.('workingDirectory');
    if (!workingDirectory?.ensure || !exec?.agent) return undefined;
    return await workingDirectory.ensure(exec.agent, exec.signal);
  } catch {
    return undefined;
  }
}

/** 按「首次延迟 + 若干偏移」分批复核并补发（多次补发无害，最后一次即稳定值）。 */
function scheduleRefresh(fsCtx, exec, resolved, settings, log) {
  const offsets = [0, ...(settings.editRefreshOffsets || [])];
  for (const offset of offsets) {
    const timer = setTimeout(async () => {
      try {
        const r = await observeResolvedTarget(fsCtx, exec, resolved, undefined, { ignoreSignal: true });
        if (r.ok) {
          refreshStats.emits += 1;
          refreshStats.last = {
            target: r.target,
            version: r.version,
            at: new Date().toISOString(),
            offset: settings.editSettleMs + offset,
          };
        } else if (typeof log?.warn === 'function') {
          log.warn(`dsh-useful-tools: mark_edit 续期失败（已忽略）: ${r.error}`);
        }
      } catch { /* 续期失败不影响任何主流程 */ }
    }, settings.editSettleMs + offset);
    timer.unref?.();
  }
}

/**
 * 注册续期钩子。
 * @param {object} ctx 插件上下文
 * @param {{fsCtx?: object, cfg?: object, log?: object}} opts
 * @returns {boolean} 是否注册成功
 */
export function registerEditRefreshHook(ctx, { fsCtx, cfg, log } = {}) {
  if (typeof ctx?.on !== 'function' || !fsCtx) return false;
  const initial = readEditSettings(cfg);
  if (!initial.editHook) return false;
  const fs = fsCtx.get?.('fs') || fsCtx.fs;
  if (!fs?.resolve) return false;
  try {
    // 返回 ctx.on 的 disposer：热重载时解绑，避免监听叠加
    return ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next(); // 先放行：工具结果与后续流程不受本钩子影响
      try {
        const settings = readEditSettings(cfg);
        if (!settings.editHook) return decision;
        const args = exec?.arguments ?? exec?.args ?? exec?.input ?? exec?.parameters ?? {};
        const toolName = String(exec?.name || '');

        // 目标集合：宿主写改工具取参数路径；bash 取命令串里的写目标
        let targets = [];
        const direct = extractTargetPath(toolName, args);
        if (direct) targets = [direct];
        else if (SHELL_TOOLS.includes(toolName)) targets = extractBashWrites(commandOf(args));
        if (!targets.length) return decision;

        // 调用内先解析（此刻 exec 的 cwd/signal 有效），延迟期间只 stat 已解析目标
        const cwd = await resolveCwd(fsCtx, exec);
        for (const target of targets) {
          let resolved;
          try {
            resolved = await fs.resolve(target, { ...(cwd ? { cwd } : {}), signal: exec?.signal });
          } catch { continue; }
          scheduleRefresh(fsCtx, exec, resolved, settings, log);
        }
      } catch { /* 钩子自身绝不抛错 */ }
      return decision;
    });
  } catch (e) {
    if (typeof log?.warn === 'function') log.warn(`dsh-useful-tools: 续期钩子注册失败: ${(e && e.message) || e}`);
    return false;
  }
}
