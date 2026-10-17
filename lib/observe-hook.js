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
 * 注册自动标记钩子。
 * @param {object} ctx 插件上下文（需提供 on）
 * @param {{fsCtx?: object, cfg?: object, log?: object}} opts
 *   cfg.observeTools  读命令集合（逗号分隔字符串或数组；每次工具调用现读，改动即时生效）
 *   cfg.observeHook   总开关（默认开）
 */
export function registerObserveHook(ctx, { fsCtx, cfg, log } = {}) {
  if (typeof ctx?.on !== 'function' || !fsCtx) return false;
  if (cfg?.observeHook === false) return false;
  try {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next(); // 先放行：工具结果与后续流程不受本钩子影响
      try {
        // 名单每次现读：填什么命令、什么就生效（改配置无需重启）
        const tools = toolList(cfg?.observeTools);
        const args = exec?.arguments ?? exec?.args ?? exec?.input ?? exec?.parameters ?? {};
        for (const path of collectReadPaths(exec?.name, args, result, { tools })) {
          await observeFileForHost(fsCtx, exec, path);
        }
      } catch (e) {
        if (typeof log?.warn === 'function') log.warn(`dsh-useful-tools: 补发观测失败（已忽略）: ${(e && e.message) || e}`);
      }
      return decision;
    });
    return true;
  } catch (e) {
    if (typeof log?.warn === 'function') log.warn(`dsh-useful-tools: 观测钩子注册失败: ${(e && e.message) || e}`);
    return false;
  }
}
