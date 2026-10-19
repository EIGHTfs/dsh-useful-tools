// UI 静态骨架解析器：从 client.js 里识别 React 元素调用，还原成节点树。
//
// 为什么不用正则硬匹配嵌套：元素调用是任意深度嵌套的，正则处理不了括号配对；
// 这里用「字符跳跃扫描 + 括号配平」，跳过字符串、模板串、注释与正则字面量。
//
// 支持的写法（实测本机插件里最常见）：
//   h('div', {className:'x'}, h('button', null, '保存'))
//   React.createElement(Page, null)
//   react_jsx_runtime.jsx('div', {className:'x', children: [...]})
//
// 明确排除：document.createElement('style') —— 那是 DOM 操作，不是 React 节点。
// 这是本解析器最重要的排除项：漏了它会把样式注入代码误报成界面控件。

// 被当作「创建元素」的函数名（末段匹配）。h 是 React.createElement 的常见别名。
const ELEMENT_FNS = new Set(['h', 'createElement', 'jsx', 'jsxs', 'jsxDEV']);
// 这些前缀下同名函数不是 React（document.createElement 等 DOM API）
const DOM_OWNERS = new Set(['document', 'window', 'globalThis']);
// jsx 系列把 children 放在 props 里，createElement/h 放在后续参数里
const JSX_FNS = new Set(['jsx', 'jsxs', 'jsxDEV']);

// ── 基础扫描：跳过不参与结构判断的片段 ──────────────────────────────

// 从 i 开始跳过一个字符串（' " `），返回结束位置的下一个字符下标。
// 模板串里的 ${...} 也按「整体跳过」处理：内部表达式不当作元素调用，
// 因为静态无法求值，硬解析只会产出假节点。
function skipString(src, i) {
  const quote = src[i];
  i += 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === quote) return i + 1;
    i += 1;
  }
  return i;
}

// 从 i 开始跳过一个注释，返回结束位置；不是注释返回 -1。
function skipComment(src, i) {
  if (src[i] !== '/') return -1;
  if (src[i + 1] === '/') {
    const nl = src.indexOf('\n', i);
    return nl < 0 ? src.length : nl;
  }
  if (src[i + 1] === '*') {
    const end = src.indexOf('*/', i + 2);
    return end < 0 ? src.length : end + 2;
  }
  return -1;
}

// 从 openIndex（指向 { [ ( ）P开始，跳到配对的闭合符，返回闭合符下标。
// 全程跳过字符串/注释，避免锚点落在字符串里。
export function matchPair(src, openIndex) {
  const open = src[openIndex];
  const close = open === '{' ? '}' : open === '[' ? ']' : ')';
  let depth = 0;
  for (let i = openIndex; i < src.length; i += 1) {
    const ch = src[i];
    const skip = skipComment(src, i);
    if (skip >= 0) { i = skip - 1; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { i = skipString(src, i) - 1; continue; }
    if (ch === open) depth += 1;
    else if (ch === close) { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

// 把开括号内的参数按顶层逗号切开，返回每段的 [start, end) 偏移。
export function splitTopLevel(src, openIndex, closeIndex) {
  const parts = [];
  let depth = 0;
  let start = openIndex + 1;
  for (let i = openIndex + 1; i < closeIndex; i += 1) {
    const ch = src[i];
    const skip = skipComment(src, i);
    if (skip >= 0) { i = skip - 1; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { i = skipString(src, i) - 1; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) { parts.push({ start, end: i }); start = i + 1; }
  }
  if (src.slice(start, closeIndex).trim()) parts.push({ start, end: closeIndex });
  return parts;
}

// 计算某个偏移所在的行号（1 起），供报告标注来源。
function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i += 1) if (src[i] === '\n') line += 1;
  return line;
}

// 取某段的原始文本并压缩空白（用于报告展示与表达式摘要）。
function textOf(src, part) {
  return src.slice(part.start, part.end).trim().replace(/\s+/g, ' ');
}

// ── 调用识别 ────────────────────────────────────────────────────

// 读一个标识符/成员链（a.b.c），返回 { name, end }。name 保留全链，末段用于匹配。
function readMemberChain(src, i) {
  const start = i;
  while (i < src.length) {
    const ch = src[i];
    if (/[A-Za-z0-9_$]/.test(ch) || ch === '.') { i += 1; continue; }
    break;
  }
  return { name: src.slice(start, i), end: i };
}

// 在 src 里找出所有「像是创建元素」的调用点，返回 [{ name, owner, start, openParen, line }]。
// owner 是点号链的前缀（如 document），用于排除 DOM API。
export function scanElementCalls(src) {
  const out = [];
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    const skip = skipComment(src, i);
    if (skip >= 0) { i = skip - 1; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { i = skipString(src, i) - 1; continue; }

    // 形态 A：(0, ns.fn)(...) —— 打包器/ESM 互操作写法
    //   实测 session-conductor 大组件全用这种形态，漏了它整个组件会被判「0 个控件」。
    if (ch === '(') {
      const seq = /^\(\s*\d+\s*,\s*/.exec(src.slice(i, i + 24));
      if (seq) {
        const { name, end } = readMemberChain(src, i + seq[0].length);
        const segments = String(name || '').split('.');
        const last = segments[segments.length - 1];
        const owner = segments.length > 1 ? segments[segments.length - 2] : '';
        let j = end;
        while (j < src.length && /\s/.test(src[j])) j += 1;
        if (name && src[j] === ')') {
          let k = j + 1;
          while (k < src.length && /\s/.test(src[k])) k += 1;
          if (src[k] === '(' && ELEMENT_FNS.has(last) && !DOM_OWNERS.has(owner)) {
            out.push({ name, owner, start: i, openParen: k, line: lineOf(src, i) });
            i = k;
            continue;
          }
        }
      }
      continue;
    }

    if (!/[A-Za-z_$]/.test(ch)) continue;
    // 标识符必须从「边界」开始，避免把属性名（.createElement）重复计数
    const prev = i > 0 ? src[i - 1] : ' ';
    if (/[A-Za-z0-9_$]/.test(prev)) continue;
    const { name, end } = readMemberChain(src, i);
    if (!name) continue;
    const segments = name.split('.');
    const last = segments[segments.length - 1];
    const owner = segments.length > 1 ? segments[segments.length - 2] : '';
    // 跳过空白后必须是 '(' 才是调用
    let j = end;
    while (j < src.length && /\s/.test(src[j])) j += 1;
    if (src[j] === '(' && ELEMENT_FNS.has(last) && !DOM_OWNERS.has(owner)) {
      out.push({ name, owner, start: i, openParen: j, line: lineOf(src, i) });
      i = j;
      continue;
    }
    i = end - 1;
  }
  return out;
}

// ── 值解析 ──────────────────────────────────────────────────────

// 解析一个字符串字面量（'...' "..." `...`），返回原始文本；不是字面量返回空串。
function stringLiteral(raw) {
  const s = String(raw || '').trim();
  if (s.length < 2) return '';
  const q = s[0];
  if (q !== "'" && q !== '"' && q !== '`') return '';
  if (s[s.length - 1] !== q) return '';
  const body = s.slice(1, -1);
  if (body.includes('${')) return ''; // 模板串带插值：不是静态文本
  return body.replace(/\\(['"`\\])/g, '$1');
}

// 从表达式里抽取 i18n key：t('x') / tr('x') / __SC_TR__('x') / i18n('x')。
function i18nKeyOf(raw) {
  const m = /[A-Za-z_$][\w$]*\(\s*(['"])([^'"]+)\1\s*\)/.exec(String(raw || ''));
  return m ? m[2] : '';
}

// 解析 props 对象（浅层）：返回 { className, style, childrenRaw, others, dynamic }。
// 只取对「看界面」有意义的键，其余键名记入 others 供报告展示。
function parseProps(src, part) {
  const raw = textOf(src, part);
  const result = { className: '', style: null, childrenPart: null, others: [], dynamic: [] };
  if (!raw) return result;
  if (raw === 'null' || raw === 'undefined') return result;
  const braceAt = src.indexOf('{', part.start);
  const braceEnd = braceAt >= 0 ? matchPair(src, braceAt) : -1;
  if (braceAt < 0 || braceEnd < 0 || braceEnd > part.end) {
    // 不是对象字面量（变量引用等）：记成动态 props，不猜内容
    result.dynamic.push(raw.slice(0, 60));
    return result;
  }
  for (const kv of splitTopLevel(src, braceAt, braceEnd)) {
    const seg = src.slice(kv.start, kv.end).trim();
    if (!seg) continue;
    const colon = seg.indexOf(':');
    const key = colon > 0 ? seg.slice(0, colon).trim() : seg;
    const valueRaw = colon > 0 ? seg.slice(colon + 1).trim() : '';
    if (key === 'className') {
      const lit = stringLiteral(valueRaw);
      // 拼接/三元的类名：把所有字符串片段收集出来，报告里标注为「动态拼接」
      result.className = lit || [...valueRaw.matchAll(/(['"])([^'"]+)\1/g)].map((m) => m[2]).join(' ');
      if (!lit && valueRaw) result.dynamic.push(`className: ${valueRaw.slice(0, 50)}`);
    } else if (key === 'style') {
      result.style = parseStyleObject(src, kv, valueRaw);
    } else if (key === 'children') {
      // children 写在 props 里（jsx 形态）：记录**绝对偏移**，交给调用方按原始源码解析
      const valueStart = kv.start + colon + 1;
      const rawSlice = src.slice(valueStart, kv.end);
      const lead = rawSlice.length - rawSlice.trimStart().length;
      result.childrenPart = { start: valueStart + lead, end: kv.end };
    } else {
      // 属性名去掉可能的引号，报告里更好读（'aria-label' → aria-label）
      result.others.push(key.replace(/^['"]|['"]$/g, ''));
    }
  }
  return result;
}

// 把 style={{ minWidth: 8, marginTop: 8 }} 转成 CSS 声明串（只认字面量值）。
function parseStyleObject(src, kv, valueRaw) {
  const braceAt = src.indexOf('{', kv.start);
  if (braceAt < 0) return null;
  const braceEnd = matchPair(src, braceAt);
  if (braceEnd < 0) return null;
  const decls = [];
  for (const item of splitTopLevel(src, braceAt, braceEnd)) {
    const seg = src.slice(item.start, item.end).trim();
    const colon = seg.indexOf(':');
    if (colon <= 0) continue;
    const prop = seg.slice(0, colon).trim();
    const value = seg.slice(colon + 1).trim();
    if (!/^[A-Za-z-]+$/.test(prop)) continue;
    // 只收字面量：数字、带引号的字符串、简单常量不做求值
    const num = /^-?\d+(\.\d+)?$/.exec(value);
    if (num) { decls.push(`${camelToKebab(prop)}: ${num[0]}px`); continue; }
    const lit = stringLiteral(value);
    if (lit) decls.push(`${camelToKebab(prop)}: ${lit}`);
  }
  return decls.length ? decls.join('; ') : null;
}

// React 的内联样式用驼峰，CSS 用连字符。
function camelToKebab(name) {
  return String(name).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

// ── 节点解析 ────────────────────────────────────────────────────

// 解析一个「参数段」为节点：元素调用 / 字面量文本 / 表达式。
// part 必须是**原始源码里的绝对偏移**，这样行号与嵌套定位才准确
// （踩过的坑：拿 trim/压缩空白后的子串当源码再解析，偏移全失真、行号全变 1）。
export function parseArgAsNode(src, part) {
  const slice = src.slice(part.start, part.end);
  if (!slice.trim()) return null;
  const calls = scanElementCalls(slice);
  const first = calls[0];
  // 该段以元素调用开头（前面只有空白）才当作元素节点
  if (first && slice.slice(0, first.start).trim() === '') {
    const absStart = part.start + first.start;
    return parseNode(src, {
      name: first.name,
      owner: first.owner,
      start: absStart,
      openParen: part.start + first.openParen,
      line: lineOf(src, absStart),
    });
  }
  const lit = stringLiteral(slice);
  if (lit) return { kind: 'text', text: lit, line: lineOf(src, part.start) };
  if (/^\s*(null|undefined)\s*$/.test(slice)) return null;
  const key = i18nKeyOf(slice);
  // 条件/逻辑表达式里的元素也要收进来：`cond ? h('div', …) : null`、`msg && h('div', …)`
  //   在真实 UI 代码里极常见；若当成普通表达式丢弃，控件清单会大幅漏报
  //   （实测：漏了这一步，session-conductor 的控件数从 160+ 掉到 49）。
  const condTree = shiftLines(parseTopLevelElements(slice), lineOf(src, part.start));
  return {
    kind: 'expr',
    text: key ? `«${key}»` : '',
    i18nKey: key,
    raw: slice.trim().replace(/\s+/g, ' ').slice(0, 60),
    line: lineOf(src, part.start),
    conditional: condTree.length > 0,
    children: condTree,
  };
}

// 把「子串内解析出来的树」的行号平移回原文件（子串行号 + 基准行 - 1）。
function shiftLines(nodes, baseLine) {
  for (const node of nodes || []) {
    node.line = baseLine + (Number(node.line) || 1) - 1;
    if (node.children) shiftLines(node.children, baseLine);
  }
  return nodes;
}

// 解析一个元素调用点，返回节点树（children 递归在同一份源码里进行）。
export function parseNode(src, call) {
  const open = call.openParen;
  const close = matchPair(src, open);
  if (close < 0) return null;
  const args = splitTopLevel(src, open, close);
  const isJsx = JSX_FNS.has(call.name.split('.').pop());
  if (!args.length) return null;

  const headRaw = textOf(src, args[0]);
  const headLit = stringLiteral(headRaw);
  const node = {
    kind: headLit ? 'element' : 'component',
    tag: headLit || '',
    component: headLit ? '' : headRaw.slice(0, 60),
    props: { className: '', style: null, others: [] },
    children: [],
    line: call.line,
  };

  // props 位置：jsx 是第 2 个参数；createElement/h 也是第 2 个（且可为 null）
  if (args[1]) {
    const props = parseProps(src, args[1]);
    node.props = { className: props.className, style: props.style, others: props.others };
    // jsx 的 children 写在 props 里，需要单独按绝对偏移解析
    if (isJsx && props.childrenPart) {
      node.children = parseChildrenFromProps(src, props.childrenPart);
    }
  }

  // h/createElement 的 children 是第 3 个参数起
  if (!isJsx) {
    for (const child of args.slice(2)) {
      const nodeChild = parseArgAsNode(src, child);
      if (nodeChild) node.children.push(nodeChild);
    }
  }
  return node;
}

// jsx 的 children 可能是单个节点、数组或表达式；按绝对偏移在原始源码里解析。
function parseChildrenFromProps(src, part) {
  const out = [];
  const raw = src.slice(part.start, part.end);
  if (!raw.trim()) return out;
  const lead = raw.length - raw.trimStart().length;
  const start = part.start + lead;
  const text = raw.trim();
  // 数组形态：[ a, b ] —— 按顶层逗号切开后逐个解析
  if (text.startsWith('[')) {
    const arrOpen = src.indexOf('[', start);
    const arrClose = arrOpen >= 0 ? matchPair(src, arrOpen) : -1;
    if (arrClose > 0) {
      for (const item of splitTopLevel(src, arrOpen, arrClose)) {
        const node = parseArgAsNode(src, item);
        if (node) out.push(node);
      }
      return out;
    }
  }
  // 单个节点 / 表达式
  const node = parseArgAsNode(src, { start, end: part.end });
  if (node) out.push(node);
  return out;
}

// ── 插槽注册识别 ────────────────────────────────────────────────

// 去掉注释但保留字符串内容：匹配组件名/字段值时不能被注释里的示例代码带偏
// （真实踩坑：注释写着「jsx(Comp, null) 会抛错」，正则把 Comp 当成了真组件名）。
function stripComments(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const skip = skipComment(text, i);
    if (skip >= 0) { i = skip - 1; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = skipString(text, i);
      out += text.slice(i, end);
      i = end - 1;
      continue;
    }
    out += ch;
  }
  return out;
}

// 压缩空白（trim + 折叠内部空白），用于把源码片段变成单行摘要。
function compact(text) {
  return String(text ?? '').trim().replace(/\s+/g, ' ');
}

// 找出 slots.register(...) 调用，返回 [{ slotName, component, line }]。
// 插槽名取 def 对象里的 name 字段（字面量）；组件取第二个参数里的引用。
export function scanSlotRegistrations(src) {
  const out = [];
  const re = /\.?\bregister\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const openAt = src.indexOf('(', m.index);
    if (openAt < 0) continue;
    const closeAt = matchPair(src, openAt);
    if (closeAt < 0) continue;
    // 只认 slots.register / ctx.slots.register。
    // 注意 after 是「register 之前的文本」，点号可能已被正则里的 `\.?` 吃掉，故点号可省。
    const before = src.slice(Math.max(0, m.index - 40), m.index);
    if (!/slots\s*\.?\s*$/.test(before)) continue;
    const parts = splitTopLevel(src, openAt, closeAt);
    if (!parts.length) continue;
    // 先按**原始文本**去注释，再压缩空白：
    //   反例（踩过）：先 replace(/\s+/g,' ') 会把换行压成空格，注释就吃掉了它后面的全部代码。
    const defRaw = compact(stripComments(src.slice(parts[0].start, parts[0].end)));
    const nameMatch = /name\s*:\s*(['"])([^'"]+)\1/.exec(defRaw);
    const idMatch = /id\s*:\s*(['"])([^'"]+)\1/.exec(defRaw);
    const compRaw = compact(stripComments(parts[1] ? src.slice(parts[1].start, parts[1].end) : ''));
    // 组件引用：可能是 Comp、() => React.createElement(Page, null)、() => h(Page)
    let component = '';
    const direct = /^[A-Za-z_$][\w$.]*$/.exec(compRaw);
    if (direct) component = direct[0];
    else {
      const inner = /(?:createElement|h|jsx)\s*\(\s*([A-Za-z_$][\w$.]*)/.exec(compRaw);
      if (inner) component = inner[1];
    }
    out.push({
      slotName: nameMatch ? nameMatch[2] : (idMatch ? idMatch[2] : ''),
      id: idMatch ? idMatch[2] : '',
      component,
      line: lineOf(src, m.index),
    });
  }
  return out;
}

// 找组件的函数体区间：function X(...) { ... } / const X = (...) => {} / const X = function () {}。
// 找不到返回 null（跨文件或外部组件，静态不展开）。
export function findComponentBody(src, name) {
  const plain = String(name || '').split('.').pop();
  if (!plain) return null;
  const patterns = [
    new RegExp(`function\\s+${escapeRe(plain)}\\s*\\(`),
    new RegExp(`(?:const|let|var)\\s+${escapeRe(plain)}\\s*=\\s*(?:async\\s*)?function\\b`),
    new RegExp(`(?:const|let|var)\\s+${escapeRe(plain)}\\s*=\\s*(?:async\\s*)?\\(`),
  ];
  for (const re of patterns) {
    const m = re.exec(src);
    if (!m) continue;
    // 匹配串以 '(' 结尾（function X( / const X = (），先跳过整个参数列表：
    //   参数可能是对象解构 `function X({ a, b }) {`，若直接找 '{' 会把参数当成函数体
    //   （实测：session-conductor 的 4 个组件因此被判「已展开但 0 节点」）。
    let from = m.index + m[0].length;
    if (src[from - 1] === '(') {
      const closeParen = matchPair(src, from - 1);
      if (closeParen < 0) continue;
      from = closeParen + 1;
    }
    let brace = -1;
    for (let i = from; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === "'" || ch === '"' || ch === '`') { i = skipString(src, i) - 1; continue; }
      if (ch === '(') { const e = matchPair(src, i); if (e < 0) break; i = e; continue; }
      if (ch === '{') { brace = i; break; }
      if (ch === ';') break;
    }
    if (brace < 0) continue;
    const end = matchPair(src, brace);
    if (end < 0) continue;
    return { start: brace + 1, end, line: lineOf(src, m.index) };
  }
  return null;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 解析一段源码里**所有**元素调用点（含嵌套，用于控件清单的全量统计）。
export function parseElementsIn(src) {
  const out = [];
  for (const call of scanElementCalls(src)) {
    const node = parseNode(src, call);
    if (node) out.push(node);
  }
  return out;
}

// 只取最外层节点（不被其它调用区间包含），用于生成 HTML 骨架——避免同一棵子树重复渲染。
// 判据用「起始偏移落在另一个调用区间内」，与解析顺序无关。
export function parseTopLevelElements(src) {
  const calls = scanElementCalls(src)
    .map((call) => ({ ...call, closeEnd: matchPair(src, call.openParen) }))
    .filter((call) => call.closeEnd > 0)
    .sort((a, b) => a.start - b.start);
  const tops = [];
  for (const call of calls) {
    if (tops.some((t) => call.start > t.start && call.start < t.closeEnd)) continue;
    tops.push(call);
  }
  return tops.map((call) => parseNode(src, call)).filter(Boolean);
}
