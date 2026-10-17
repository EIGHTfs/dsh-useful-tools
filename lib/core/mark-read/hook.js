/**
 * 工具执行后自动补发观测：把「读过内容的工具」算作已读
 *
 * 订阅 tools/post-execute（waterfall）：先 next() 放行拿到原结果，再从
 * 「工具名 + 解析后的参数 + 结果」提取被读过的文件，逐个按官方 recipe 补发观测。
 *
 * 与 dsh-git-push 版的关键差异：**允许名单每次调用时现读配置**（读命令集合是设置项，
 * 填什么生效什么，改动即时生效、无需重启），而不是注册时定死。
 *
 * 安全边界：① 绝不修改工具结果、绝不向调用方抛错；② 默认名单只有 grep；
 *   ③ bash 里 cat/sed 等无法可靠判定读了哪些文件，不建议加进名单。
 */
import { observeFileForHost } from './observe.js';
import { readConfig } from './config.js';

export const DEFAULT_OBSERVE_TOOLS = ['grep'];
export const MAX_FILES_PER_CALL = 40;

const FILE_LIKE_RE = /\.[A-Za-z0-9]{1,12}$/;
const TEXT_HIT_RE = /^([^\s:][^:]*\.[A-Za-z0-9]{1,12}):\d+:/;

/** 解析名单配置：数组或逗号分隔字符串，空则回退默认。 */
function toolList(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  const cleaned = list.map((t) => String(t).trim()).filter(Boolean);
  return cleaned.length ? cleaned : DEFAULT_OBSERVE_TOOLS;
}

/**
 * 从工具调用与结果里提取「读过内容的文件路径」（纯函数，便于单测）。
 * 结果对象外层字段在不同版本可能是 result/value/output 之一，多形态兼容。
 */
export function collectReadPaths(toolName, args, result, { tools = DEFAULT_OBSERVE_TOOLS } = {}) {
  if (!Array.isArray(tools) || !tools.includes(String(toolName || ''))) return [];
  const out = new Set();
  const push = (value) => {
    const str = String(value ?? '').trim();
    if (str && str.length <= 4096) out.add(str);
  };
  const argPath = args?.path ?? args?.file_path ?? args?.filePath;
  if (typeof argPath === 'string' && FILE_LIKE_RE.test(argPath)) push(argPath);
  for (const match of matchesOf(result)) {
    push(match?.path ?? match?.file ?? match?.filePath ?? match?.filename);
  }
  const text = textOf(result);
  if (text) {
    for (const line of text.split('\n')) {
      const hit = line.match(TEXT_HIT_RE);
      if (hit) push(hit[1]);
    }
  }
  return [...out].slice(0, MAX_FILES_PER_CALL);
}

function matchesOf(result) {
  if (!result) return [];
  for (const node of [result, result.value, result.output, result.result, result.data]) {
    if (Array.isArray(node?.matches)) return node.matches;
    if (Array.isArray(node)) return node;
  }
  return [];
}

function textOf(result) {
  if (typeof result === 'string') return result;
  if (!result) return '';
  for (const node of [result, result.value, result.output, result.result]) {
    if (typeof node === 'string') return node;
    if (typeof node?.text === 'string') return node.text;
  }
  return '';
}

/**
 * 读命令的跨平台别名（归一到一个规范名再比对集合）。
 *   Linux/macOS：cat / grep / head / tail / less / more …
 *   Windows PowerShell：Get-Content(gc) / type / Select-String(sls) / findstr
 *   Windows cmd：type / more / findstr
 * 归一后集合里只写规范名（cat/grep/…）即可跨平台生效。
 */
const READ_ALIASES = {
  'get-content': 'cat',
  gc: 'cat',
  type: 'cat',
  more: 'cat',
  'select-string': 'grep',
  sls: 'grep',
  findstr: 'grep',
};

/** 命令名归一：去路径、小写、去可执行后缀、别名映射。 */
export function canonCommand(raw) {
  const n = String(raw ?? '').split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
  return READ_ALIASES[n] || n;
}

/**
 * 从 bash 命令串里提取「集合内命令读过的文件」。
 *
 * 为什么需要：bash 工具的 exec.name 恒为 "bash"，命令名（cat/grep/head…）在参数里。
 *   若不解析，`cat file` 永远不会算读（用户实测反馈「cat 不能直接用吗」）。
 * 跨平台：命令名先经 canonCommand 归一（Get-Content/gc/type → cat，Select-String/sls/findstr → grep），
 *   集合里只写规范名即可。
 * 解析口径（保守，宁少不多）：
 *   · 按 | ; & 切成多段，每段取第一个非环境变量赋值的词为命令名；
 *   · 命令名（归一后）必须在读命令集合里；
 *   · 其后的非选项参数视为文件；遇到重定向（< >）即停止；
 *   · grep/rg/ag/sed/awk 的第一个非选项参数是「模式」，跳过它。
 */
/** 跳过段首的环境变量赋值（FOO=bar）与常见包装（sudo/env），返回首个命令词的下标。 */
function commandTokenIndex(tokens) {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    const isEnvAssign = /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
    if (!isEnvAssign && token !== 'sudo' && token !== 'env') break;
    index += 1;
  }
  return index;
}

/** 取一段命令里「该命令读过的文件」参数：跳过选项与首个模式参数，遇重定向即停。 */
function readFileArgsOf(name, tokens, start) {
  // grep/sed/awk 等的第一个非选项参数是「模式」而不是文件，跳过它（否则会把模式当文件）
  let skipPattern = ['grep', 'rg', 'ag', 'sed', 'awk'].includes(name);
  const files = [];
  for (const token of tokens.slice(start)) {
    if (token.startsWith('-')) continue;
    if (/[<>]/.test(token)) break; // 重定向之后不是输入文件
    if (skipPattern) { skipPattern = false; continue; }
    files.push(token);
  }
  return files;
}

export function extractBashReads(command, tools = []) {
  const cmd = String(command || '').trim();
  if (!cmd || !Array.isArray(tools) || !tools.length) return [];
  const toolsCanon = new Set(tools.map(canonCommand));
  const out = new Set();
  for (const seg of cmd.split(/[|;&]+/)) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    const start = commandTokenIndex(tokens);
    if (start >= tokens.length) continue;
    const name = canonCommand(tokens[start]);
    if (!toolsCanon.has(name)) continue;
    for (const file of readFileArgsOf(name, tokens, start + 1)) out.add(file);
  }
  return [...out];
}

/**
 * 注册自动标记钩子。
 * @param {object} ctx 插件上下文（需提供 on）
 * @param {{fsCtx?: object, cfg?: object, log?: object}} opts
 *   cfg 仅作配置文件缺失时的兜底；正常走 <DSH_HOME>/useful-tools/config.json
 *   配置每次工具调用现读 ⇒ 改完即时生效、重启仍有效（命令配置一次、永久有效）
 */
/** 一次工具调用的入参视图（宿主各版本字段名不同，多形态兼容）。 */
function toolCallOf(exec) {
  return {
    toolName: String(exec?.name || ''),
    args: exec?.arguments ?? exec?.args ?? exec?.input ?? exec?.parameters ?? {},
  };
}

/** 生效的读命令集合：落盘配置优先，空则回退 loader config / 默认清单。 */
function effectiveTools(conf, cfg) {
  if (conf.observeTools.length) return conf.observeTools;
  return toolList(cfg?.observeTools);
}

/** bash 类工具的命令串（宿主各版本字段名不同）。 */
function commandOf(args) {
  return args?.command ?? args?.script ?? args?.cmd ?? '';
}

/**
 * 一次工具调用后的补读：按**当前**配置把读过的文件补发观测。
 * 名单每次现读配置文件（填什么命令、什么就生效，改配置无需重启）；
 * 任何异常只记日志，绝不影响工具结果与后续流程。
 */
async function markReadsOfCall(fsCtx, exec, result, cfg, log) {
  const conf = readConfig();
  if (conf.observeHook === false) return;
  const tools = effectiveTools(conf, cfg);
  const { toolName, args } = toolCallOf(exec);
  try {
    // ① 工具名本身在集合（如宿主的 grep 工具）
    for (const path of collectReadPaths(toolName, args, result, { tools })) {
      await observeFileForHost(fsCtx, exec, path);
    }
    // ② bash 里跑的命令：解析命令名（cat/grep/head…），在集合里就把文件参数标记
    if (toolName === 'bash' || toolName === 'shell' || toolName === 'exec') {
      for (const path of extractBashReads(commandOf(args), tools)) {
        await observeFileForHost(fsCtx, exec, path);
      }
    }
  } catch (e) {
    if (typeof log?.warn === 'function') log.warn(`dsh-useful-tools: 补发观测失败（已忽略）: ${(e && e.message) || e}`);
  }
}

export function registerObserveHook(ctx, { fsCtx, cfg, log } = {}) {
  if (typeof ctx?.on !== 'function' || !fsCtx) return false;
  // 总开关：任一来源关闭即不注册（loader config 的 cfg 与落盘配置文件）
  const initial = readConfig();
  if (cfg?.observeHook === false || initial.observeHook === false) return false;
  try {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next(); // 先放行：工具结果与后续流程不受本钩子影响
      await markReadsOfCall(fsCtx, exec, result, cfg, log);
      return decision;
    });
    return true;
  } catch (e) {
    if (typeof log?.warn === 'function') log.warn(`dsh-useful-tools: 观测钩子注册失败: ${(e && e.message) || e}`);
    return false;
  }
}
