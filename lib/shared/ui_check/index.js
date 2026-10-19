/**
 * 工具：ui_check —— UI 静态骨架检查（解析 lib/client.js，产出 HTML 骨架 + 控件清单）
 *
 * 定位（必须说清，否则会被误用）：这是**静态解析**，回答「代码里写了哪些控件」，
 * 不回答「运行时渲染出来没有」。条件分支、列表数据、i18n 文案、主题样式都不参与求值，
 * 因此它不能替代真渲染检查；它的价值是快、零依赖、能给出「源码里声明了什么」的依据。
 *
 * 产物（两份）：
 *   · HTML 骨架页：结构树 + 静态还原预览 + 控件清单，浏览器打开即可看
 *   · JSON 清单：给 AI 读、可 diff；控件带 `visible: null`，将来渲染探针填 true/false 即可对比
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { buildSkeleton, toHtml } from '../../core/ui-check/emit.js';

export const description = 'UI 静态骨架检查：解析插件的 lib/client.js，产出「代码里声明了哪些控件」的 HTML 骨架页与 JSON 清单'
  + '（含插槽注册、层级结构、className/内联样式、来源行号）。'
  + '注意：这是静态解析，不执行代码、不渲染——它回答「代码里写了什么」，不回答「运行时渲染出来没有」。';

export const parameters = {
  type: 'object',
  properties: {
    plugin: { type: 'string', description: '插件根目录（缺省当前工作目录）' },
    file: { type: 'string', description: '要解析的客户端入口（缺省 <plugin>/lib/client.js）' },
    out: { type: 'string', description: 'HTML 输出路径（缺省 <plugin>/assets/ui-skeleton.html；同目录同时写 .json）' },
    write: { type: 'boolean', description: 'false = 只解析不写盘（缺省 true）' },
    limit: { type: 'number', description: '返回结果里附带多少条控件明细（缺省 30，完整清单在 JSON 文件）' },
  },
};

/** 统一失败返回。 */
function fail(error, extra = {}) {
  return { ok: false, error, ...extra };
}

/**
 * 工具入口（契约 C-103 规定导出名为 run）。
 * 内部用表意名，末尾以 `export { runUiCheck as run }` 起别名导出。
 */
async function runUiCheck(args = {}) {
  const pluginRoot = resolve(String(args.plugin || process.cwd()));
  if (!existsSync(pluginRoot)) return fail(`插件根目录不存在：${pluginRoot}`);

  const file = args.file
    ? (isAbsolute(String(args.file)) ? String(args.file) : resolve(pluginRoot, String(args.file)))
    : join(pluginRoot, 'lib', 'client.js');
  if (!existsSync(file)) {
    return fail(`找不到客户端入口：${file}`, {
      hint: 'ui_check 默认解析 <插件根>/lib/client.js；若 UI 在其他文件，用 file 参数显式指定',
    });
  }

  let src = '';
  try {
    src = readFileSync(file, 'utf8');
  } catch (error) {
    return fail(`读取失败：${(error && error.message) || error}`);
  }

  const skeleton = buildSkeleton(src, { file, bytes: statSync(file).size });

  // 写盘：HTML 与 JSON 同目录同名前缀，方便一起看、一起 diff
  const out = args.out
    ? (isAbsolute(String(args.out)) ? String(args.out) : resolve(pluginRoot, String(args.out)))
    : join(pluginRoot, 'assets', 'ui-skeleton.html');
  let written = null;
  if (args.write !== false) {
    try {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, toHtml(skeleton), 'utf8');
      const jsonPath = out.replace(/\.html?$/i, '') + '.json';
      writeFileSync(jsonPath, JSON.stringify(skeleton, null, 2) + '\n', 'utf8');
      written = { html: out, json: jsonPath };
    } catch (error) {
      return fail(`写盘失败：${(error && error.message) || error}`, { source: file });
    }
  }

  const limit = Math.max(1, Number(args.limit) || 30);
  return {
    ok: true,
    source: file,
    file: written && written.html,
    json: written && written.json,
    stats: skeleton.stats,
    slots: skeleton.slots,
    warnings: skeleton.warnings,
    // 只回前若干条：完整清单在 JSON 里，避免一次性刷满会话上下文
    controls: skeleton.controls.slice(0, limit),
    controlsTotal: skeleton.controls.length,
    note: '静态骨架：只回答「代码里声明了哪些控件」，不代表运行时渲染结果；控件 visible=null 是留给渲染探针的字段',
  };
}

export { runUiCheck as run };
