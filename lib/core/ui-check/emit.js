// 骨架 → 产物：JSON 清单（给 AI/将来 diff）与单文件 HTML（给人看）。
//
// 为什么清单里留 `visible: null`：静态解析永远不知道元素最终有没有被渲染出来。
// 将来若接真渲染探针（CDP），只需把同一份清单里的 visible 填成 true/false，
// 两份清单就能直接 diff 出「声明了但没渲染」的控件——这正是本次工具留的接口。
import {
  parseTopLevelElements,
  scanSlotRegistrations,
  findComponentBody,
} from './parse.js';

// 清单格式版本：字段变动时改这里，消费方据此判断兼容性。
export const SCHEMA = 'dsh-ui-skeleton/1';

// 平均行长超过这个值就警告「疑似压缩产物」，因为压缩后还原不可靠。
const MINIFIED_AVG_LINE = 200;

// 把节点树压平成控件清单：每个元素一条，带父链路径与来源行号。
export function flattenControls(tree, path = '', out = []) {
  for (const node of tree || []) {
    const label = node.kind === 'element' ? node.tag : (node.kind === 'component' ? `<${node.component}>` : '');
    const here = label ? (path ? `${path} > ${label}` : label) : path;
    if (node.kind === 'element' || node.kind === 'component') {
      out.push({
        tag: node.tag || '',
        component: node.component || '',
        text: collectText(node),
        className: node.props?.className || '',
        style: node.props?.style || '',
        others: node.props?.others || [],
        line: node.line,
        path: here,
        // 静态未知：将来渲染探针填 true/false
        visible: null,
      });
    }
    flattenControls(node.children || [], here, out);
  }
  return out;
}

// 收集一个节点下的纯文本（只取直接文本子节点，避免把子控件的文案重复计入）。
function collectText(node) {
  const parts = [];
  for (const child of node.children || []) {
    if (child.kind === 'text') parts.push(child.text);
    else if (child.kind === 'expr' && child.i18nKey) parts.push(`«${child.i18nKey}»`);
  }
  return parts.join(' ').trim();
}

// 统计节点数量与标签分布。
function statsOf(tree, controls) {
  const byTag = {};
  let expressions = 0;
  let components = 0;
  const walk = (nodes) => {
    for (const node of nodes || []) {
      if (node.kind === 'element') byTag[node.tag] = (byTag[node.tag] || 0) + 1;
      else if (node.kind === 'expr') expressions += 1;
      else if (node.kind === 'component') components += 1;
      walk(node.children);
    }
  };
  walk(tree);
  return { controls: controls.length, byTag, expressions, components };
}

/**
 * 解析源码，产出骨架对象。
 * @param {string} src client.js 源码
 * @param {{file?: string, bytes?: number}} meta
 */
export function buildSkeleton(src, meta = {}) {
  const warnings = [];
  const lines = src.split('\n').length;
  const avgLine = src.length / Math.max(1, lines);
  if (avgLine > MINIFIED_AVG_LINE) {
    warnings.push(`平均行长 ${avgLine.toFixed(0)} 字符，疑似压缩/混淆产物：静态还原不可靠，建议指向未压缩的源码`);
  }

  // 插槽：能定位到组件定义就展开该组件的 UI，否则只登记、标注未展开
  const slots = scanSlotRegistrations(src).map((entry) => {
    let tree = [];
    let resolved = false;
    if (entry.component) {
      const body = findComponentBody(src, entry.component);
      if (body) {
        tree = parseTopLevelElements(src.slice(body.start, body.end));
        resolved = true;
      } else {
        warnings.push(`插槽 ${entry.slotName || entry.id} 的组件 ${entry.component} 未在文件内定义，未展开（跨文件或工厂函数返回的组件暂不支持）`);
      }
    } else {
      warnings.push(`插槽 ${entry.slotName || entry.id} 未识别到组件引用（注册写法可能不在支持范围内）`);
    }
    return {
      slot: entry.slotName,
      id: entry.id,
      component: entry.component,
      line: entry.line,
      resolved,
      nodeCount: tree.length,
      tree,
    };
  });

  // tree 始终用「全文件顶层树」：它才是「代码里声明了哪些控件」的全量视图。
  // 插槽树单独放在 slotTrees 里——两者用途不同，不能用一个替换另一个
  // （踩过：用插槽树替换后，session-conductor 的 160+ 个 UI 片段只剩 9 个）。
  const tree = parseTopLevelElements(src);
  if (!tree.length) {
    warnings.push('没有识别到任何 React 元素调用：可能写法不在支持范围内（createElement / h / jsx），或文件不是客户端 UI');
  }

  const controls = flattenControls(tree);
  const stats = statsOf(tree, controls);

  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    source: {
      file: meta.file || 'lib/client.js',
      bytes: meta.bytes ?? Buffer.byteLength(src, 'utf8'),
      lines,
      minified: avgLine > MINIFIED_AVG_LINE,
    },
    slots: slots.map(({ tree: _t, ...rest }) => rest),
    slotTrees: slots.filter((s) => s.tree.length).map((s) => ({ slot: s.slot || s.id, component: s.component, tree: s.tree })),
    tree,
    controls,
    stats,
    warnings,
  };
}

// ── HTML 渲染 ───────────────────────────────────────────────────

// 转义文本，防止源码里的尖括号破坏页面结构
function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 把节点序列渲染成「结构树」文本（缩进展示 kind/tag/className/行号）
function treeText(nodes, depth = 0, out = []) {
  for (const node of nodes || []) {
    const pad = '  '.repeat(depth);
    if (node.kind === 'text') {
      out.push(`${pad}"${node.text}"`);
    } else if (node.kind === 'expr') {
      out.push(`${pad}${node.i18nKey ? `«${node.i18nKey}»` : '{expr}'}  ${node.raw ? `// ${node.raw}` : ''}`);
    } else if (node.kind === 'component') {
      out.push(`${pad}<${node.component}>  // 组件（静态未展开）  L${node.line}`);
    } else {
      const cls = node.props?.className ? ` .${node.props.className}` : '';
      const style = node.props?.style ? `  {${node.props.style}}` : '';
      out.push(`${pad}${node.tag}${cls}${style}  L${node.line}`);
    }
    treeText(node.children, depth + 1, out);
  }
  return out;
}

// 把节点序列渲染成接近真实的 HTML（用于「长什么样」预览）
function htmlOf(nodes) {
  const out = [];
  for (const node of nodes || []) {
    if (node.kind === 'text') { out.push(esc(node.text)); continue; }
    if (node.kind === 'expr') {
      out.push(`<span class="ph">${esc(node.i18nKey ? `«${node.i18nKey}»` : '{表达式}')}</span>`);
      continue;
    }
    if (node.kind === 'component') {
      out.push(`<span class="comp">&lt;${esc(node.component)}&gt;</span>`);
      for (const child of node.children || []) out.push(htmlOf([child]));
      continue;
    }
    const attrs = [];
    if (node.props?.className) attrs.push(`class="${esc(node.props.className)}"`);
    if (node.props?.style) attrs.push(`style="${esc(node.props.style)}"`);
    attrs.push(`data-line="${node.line}"`);
    const inner = htmlOf(node.children);
    if (node.tag === 'input' || node.tag === 'br' || node.tag === 'img') {
      out.push(`<${node.tag} ${attrs.join(' ')}>`);
    } else {
      out.push(`<${node.tag} ${attrs.join(' ')}>${inner}</${node.tag}>`);
    }
  }
  return out.join('');
}

/**
 * 生成单文件 HTML 报告：人打开就能看到结构、控件清单与解析告警。
 * @param {ReturnType<typeof buildSkeleton>} skeleton
 */
export function toHtml(skeleton) {
  const { source, stats, slots, slotTrees, tree, controls, warnings } = skeleton;
  const treeBody = treeText(tree).join('\n');
  const preview = htmlOf(tree);

  const slotRows = slots.length
    ? slots.map((s) => `<tr><td>${esc(s.slot || s.id || '?')}</td><td>${esc(s.component || '—')}</td>
<td>${s.resolved ? '✅ 已展开' : '⚠️ 未展开'}</td><td>${s.nodeCount}</td><td>L${s.line}</td></tr>`).join('\n')
    : '<tr><td colspan="5">未识别到 slots.register(...)</td></tr>';

  const warnList = warnings.length
    ? warnings.map((w) => `<li>${esc(w)}</li>`).join('\n')
    : '<li>无</li>';

  const controlRows = controls.slice(0, 400).map((c) => `<tr>
<td>${esc(c.tag || `<${c.component}>`)}</td><td>${esc(c.text)}</td><td>${esc(c.className)}</td>
<td>${esc(c.style)}</td><td>L${c.line}</td></tr>`).join('\n');

  // 插槽展开区块：能定位到组件定义的插槽，单独给一棵树 + 预览（比全文件树更贴近真实页面）
  const slotBlocks = slotTrees.length
    ? slotTrees.map((s) => `<h3>${esc(s.slot)} · ${esc(s.component)}</h3>
<pre class="tree">${esc(treeText(s.tree).join('\n'))}</pre>
<div class="stage">${htmlOf(s.tree)}</div>`).join('\n')
    : '<p class="note">没有可展开的插槽组件（组件可能由工厂函数返回或定义在别的文件）。</p>';

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>UI 静态骨架 · ${esc(source.file)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; padding:24px; background:#12141a; color:#dfe3ea;
         font:14px/1.6 -apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif; }
  h1 { font-size:18px; margin:0 0 4px; }
  h2 { font-size:15px; margin:24px 0 8px; color:#8ab4f8; }
  .meta { color:#8b93a1; font-size:12px; margin-bottom:16px; }
  .stat { display:inline-block; margin-right:14px; }
  .stat b { color:#e8eaf0; font-size:15px; }
  .warn { background:#2a2118; border-left:3px solid #d9a441; padding:10px 14px; border-radius:6px; }
  .warn li { color:#e2c07a; }
  table { border-collapse:collapse; width:100%; font-size:12.5px; }
  th,td { text-align:left; padding:6px 10px; border-bottom:1px solid #252936; vertical-align:top; }
  th { color:#8b93a1; font-weight:500; }
  pre.tree { background:#171a22; border:1px solid #252936; border-radius:8px; padding:14px;
             overflow:auto; font:12.5px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace; color:#b9c2d0; }
  .stage { background:#0d0f14; border:1px solid #2a2f3d; border-radius:8px; padding:18px;
           margin:10px 0 4px; }
  .stage * { max-width:100%; }
  .ph { color:#6b7590; font-style:italic; }
  .comp { color:#d98ad9; font-weight:600; }
  .note { color:#7d8698; font-size:12px; }
</style></head>
<body>
<h1>UI 静态骨架 · ${esc(source.file)}</h1>
<div class="meta">${esc(source.bytes)} 字节 / ${source.lines} 行${source.minified ? ' · <b style="color:#e2574c">疑似压缩</b>' : ''} · 生成于 ${esc(skeleton.generatedAt)}</div>
<div>
  <span class="stat">控件 <b>${stats.controls}</b></span>
  <span class="stat">插槽 <b>${slots.length}</b></span>
  <span class="stat">表达式 <b>${stats.expressions}</b></span>
  <span class="stat">组件占位 <b>${stats.components}</b></span>
</div>

<h2>插槽注册</h2>
<table><thead><tr><th>插槽</th><th>组件</th><th>展开</th><th>节点</th><th>位置</th></tr></thead>
<tbody>${slotRows}</tbody></table>

<h2>解析告警</h2>
<ul class="warn">${warnList}</ul>

<h2>插槽展开</h2>
${slotBlocks}

<h2>结构树（全文件 · 源码级）</h2>
<pre class="tree">${esc(treeBody)}</pre>

<h2>渲染预览（静态还原，非运行结果）</h2>
<div class="stage">${preview || '<span class="note">没有可渲染的节点</span>'}</div>
<p class="note">预览只反映「代码里写了什么」：条件分支、列表数据、i18n 文案、主题样式都不会参与求值。
判断「实际渲染出来没有」请在真实宿主里看，或用将来的渲染探针（visible 字段）。</p>

<h2>控件清单（${controls.length}）</h2>
<table><thead><tr><th>标签</th><th>文本</th><th>class</th><th>内联样式</th><th>位置</th></tr></thead>
<tbody>${controlRows}</tbody></table>
${controls.length > 400 ? '<p class="note">仅展示前 400 条，完整清单见 JSON。</p>' : ''}
</body></html>`;
}
