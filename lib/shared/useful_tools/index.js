/**
 * 工具：useful_tools —— 本插件工具清单（动态扫描 lib/shared，不维护硬编码清单）
 *
 * 动作（action）：
 *   help（缺省）—— 输出每个工具的「名字 + 说明 + 参数 + 示例调用」
 *   list        —— 只输出名字与一句话说明（紧凑）
 *
 * 为什么动态：目录即工具名（契约 C-101），新增工具只需新建目录、不必改本文件；
 *   写死清单必然漂移（README 与实现就曾对不上过）。
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// 本文件在 lib/shared/useful_tools/ 下，上一级就是所有工具目录的父目录
const SHARED_DIR = join(HERE, '..');

export const description = '本插件（dsh-useful-tools）工具清单：动态扫描 lib/shared 输出每个工具的名字、说明、参数与示例调用。'
  + 'action=help（缺省，完整说明）/ list（紧凑清单）；tool 可选，只看某一个工具。';

export const parameters = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['help', 'list'], description: '动作，缺省 help' },
    tool: { type: 'string', description: '只看某个工具（传工具名）' },
  },
};

/** 扫描 lib/shared 下每个含 index.js 的目录，import 出 description/parameters。 */
async function loadTools() {
  if (!existsSync(SHARED_DIR)) return [];
  const names = readdirSync(SHARED_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(SHARED_DIR, entry.name, 'index.js')))
    .map((entry) => entry.name)
    .sort();
  const tools = [];
  for (const name of names) {
    try {
      const mod = await import(pathToFileURL(join(SHARED_DIR, name, 'index.js')).href);
      tools.push({
        name,
        description: String(mod.description || ''),
        parameters: mod.parameters || {},
      });
    } catch (error) {
      // 单个工具加载失败不拖垮整份清单：记下错误，其余照常列出
      tools.push({ name, description: '', parameters: {}, error: String((error && error.message) || error) });
    }
  }
  return tools;
}

/** 参数名列表（按声明顺序）。 */
function paramNames(tool) {
  return Object.keys(tool.parameters?.properties || {});
}

/**
 * 生成一条示例调用。
 * 规则：action 类工具给枚举首值（更贴近实际用法），其余参数给 <类型> 占位。
 */
function exampleOf(tool) {
  const props = tool.parameters?.properties || {};
  const keys = Object.keys(props);
  if (!keys.length) return tool.name;
  const parts = keys.map((key) => {
    const prop = props[key];
    if (key === 'action' && Array.isArray(prop?.enum) && prop.enum.length) return `action="${prop.enum[0]}"`;
    return `${key}=<${prop?.type || 'string'}>`;
  });
  return `${tool.name} ${parts.join(' ')}`;
}

/** 单个工具的完整说明文本。 */
function describeTool(tool) {
  const lines = [];
  lines.push(`${tool.name}`);
  lines.push(`  说明：${tool.description || '（无）'}`);
  const props = tool.parameters?.properties || {};
  const keys = Object.keys(props);
  if (keys.length) {
    const params = keys.map((key) => {
      const prop = props[key] || {};
      const type = Array.isArray(prop.enum) ? prop.enum.join('|') : (prop.type || 'string');
      return `${key}(${type})${prop.description ? ` ${prop.description}` : ''}`;
    });
    lines.push(`  参数：${params.join('；')}`);
  }
  lines.push(`  示例：${exampleOf(tool)}`);
  if (tool.error) lines.push(`  加载失败：${tool.error}`);
  return lines.join('\n');
}

/**
 * 工具入口（契约 C-103 规定导出名为 run）。
 * 内部用表意名，末尾以 `export { runUsefulTools as run }` 起别名导出。
 */
async function runUsefulTools(args = {}) {
  const action = String(args.action || 'help').trim().toLowerCase();
  const only = String(args.tool || '').trim();
  let tools = await loadTools();

  if (only) {
    tools = tools.filter((tool) => tool.name === only);
    if (!tools.length) {
      const all = await loadTools();
      return { ok: false, error: `没有这个工具：${only}`, names: all.map((tool) => tool.name) };
    }
  }

  if (action === 'list') {
    return {
      ok: true,
      action: 'list',
      count: tools.length,
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description, params: paramNames(tool) })),
      text: tools.map((tool) => `${tool.name} — ${tool.description || '（无说明）'}`).join('\n'),
    };
  }

  if (action !== 'help') {
    return { ok: false, error: `未知 action：${action}（可用 help / list）` };
  }

  // 症状 → 工具 索引：工具清单本身不解决「我该用哪个」，这段是给排障用的
  const triage = [
    '症状 → 工具',
    '  装了不生效 / apply 没执行 → verify_plugin（激活诊断：dependencies / bundles / loader 行）',
    '  服务拿不到、路由 404 → verify_plugin（inject 段，拼错会给近似建议）',
    '  依赖解析失败 → sync_plugin（deps 段）/ verify_plugin（deps 段）',
    '  UI 空白、控件没出来 → ui_check（controls=0 或插槽 0 节点会直接报）',
    '  改了代码没生效 → verify_plugin（hmr 段：是否在 watch 范围）',
    '  同步后宿主读不到文件 → sync_plugin（permissions / readable 段）',
    '  路由 404 想本地自测 → minihost（404 会带原因提示）',
  ].join('\n');
  // 排障索引只在全量清单里给：查单个工具时塞一张症状表反而是噪声
  const parts = [`dsh-useful-tools 工具清单（${tools.length} 个）`, ...tools.map(describeTool)];
  if (!only) parts.push(triage);
  const text = parts.join('\n\n');
  return { ok: true, action: 'help', count: tools.length, tools: tools.map((tool) => tool.name), text };
}

export { runUsefulTools as run };
