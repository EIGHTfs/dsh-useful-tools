/**
 * ui_check 单测：静态骨架解析 + 产物生成。
 *
 * 用**合成源码**覆盖真实写法（createElement / h / jsx），并锁住几条踩过的坑：
 *   · document.createElement 必须排除（否则样式注入被误报成控件）
 *   · 注释里的示例代码不能污染组件名
 *   · 条件表达式里的元素必须收进清单（否则漏报大半）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  scanElementCalls,
  parseTopLevelElements,
  scanSlotRegistrations,
  findComponentBody,
} from '../lib/core/ui-check/parse.js';
import { buildSkeleton, toHtml } from '../lib/core/ui-check/emit.js';
import { run as runUiCheck } from '../lib/shared/ui_check/index.js';

test('识别三种写法：createElement / h / jsx，并排除 document.createElement', () => {
  const src = `
    const a = React.createElement('div', { className: 'x' }, 'hi')
    const b = h('button', null, '保存')
    const c = react_jsx_runtime.jsx('span', { children: 'ok' })
    const d = document.createElement('style')
    const e = window.document.createElement('textarea')
  `;
  const calls = scanElementCalls(src);
  assert.equal(calls.length, 3, '只应识别 3 个 React 元素调用');
  assert.ok(calls.every((c) => !['document', 'window'].includes(c.owner)));
  assert.deepEqual(calls.map((c) => c.name), ['React.createElement', 'h', 'react_jsx_runtime.jsx']);
});

test('props：className / 内联样式 / i18n key 都能取到', () => {
  const src = `
    h('div', { className: 'scs_row', style: { marginTop: 8, color: '#fff' } },
      h('span', null, tr('settings.title')),
      h('button', { type: 'button', disabled: busy }, '保存'),
    )
  `;
  const [tree] = parseTopLevelElements(src);
  assert.equal(tree.tag, 'div');
  assert.equal(tree.props.className, 'scs_row');
  assert.match(tree.props.style, /margin-top: 8px/);
  assert.match(tree.props.style, /color: #fff/);
  // 第一个子节点是 span，带 i18n 表达式；第二个是 button 带文本
  const span = tree.children[0];
  assert.equal(span.tag, 'span');
  assert.equal(span.children[0].i18nKey, 'settings.title');
  const button = tree.children[1];
  assert.equal(button.tag, 'button');
  assert.equal(button.children[0].text, '保存');
  assert.ok(button.props.others.includes('disabled'));
});

test('条件表达式里的元素要收进清单（否则漏报）', () => {
  const src = `
    h('div', null,
      loading ? h('div', { className: 'spinner' }) : null,
      msg && h('span', { className: 'err' }, msg),
    )
  `;
  const [tree] = parseTopLevelElements(src);
  const tags = [];
  const walk = (nodes) => nodes.forEach((n) => { if (n.tag) tags.push(n.tag); walk(n.children || []); });
  walk([tree]);
  assert.ok(tags.includes('div'), '三元里的 div 应被收集');
  assert.ok(tags.includes('span'), '逻辑与里的 span 应被收集');
  const conditional = (tree.children || []).filter((n) => n.kind === 'expr' && n.conditional);
  assert.equal(conditional.length, 2, '两个条件表达式都应标记 conditional');
});

test('插槽注册：注释里的假组件名不能污染结果', () => {
  const src = `
    slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'demo', order: 10, label },
      // 注释示例：jsx(Comp, null) 会抛错
      () => React.createElement(RealPage, null),
    ))
  `;
  const slots = scanSlotRegistrations(src);
  assert.equal(slots.length, 1);
  assert.equal(slots[0].slotName, 'settings.section');
  assert.equal(slots[0].id, 'demo');
  assert.equal(slots[0].component, 'RealPage', '不得取到注释里的 Comp');
});

test('组件体定位与展开：找到定义后能解析出 UI', () => {
  const src = `
    function Card(props) {
      return h('div', { className: 'card' }, h('b', null, props.title))
    }
    slots.inject('settings.plugin.item', () => slots.register({ name: 'settings.plugin.item' }, Card))
  `;
  const body = findComponentBody(src, 'Card');
  assert.ok(body, '应能找到 Card 的函数体');
  const tree = parseTopLevelElements(src.slice(body.start, body.end));
  assert.equal(tree[0].tag, 'div');
  assert.equal(tree[0].props.className, 'card');

  const sk = buildSkeleton(src, { file: 'demo.js' });
  assert.equal(sk.slots[0].resolved, true);
  assert.equal(sk.slots[0].component, 'Card');
  assert.ok(sk.slotTrees.length >= 1, '应产出插槽树');
});

test('全文件树与插槽树并存：控件清单取全量，不被插槽替换', () => {
  const src = `
    function Panel() { return h('section', null, h('button', null, 'A')) }
    const extra = h('footer', null, h('span', null, 'B'))
  `;
  const sk = buildSkeleton(src, { file: 'demo.js' });
  assert.ok(sk.controls.some((c) => c.tag === 'section'), '插槽外/函数内的 UI 也要在清单里');
  assert.ok(sk.controls.some((c) => c.tag === 'footer'));
});

test('压缩产物：平均行长超阈值要告警', () => {
  const longLine = 'h("div",null,' + 'h("span",null,"x"),'.repeat(200) + 'null)';
  const sk = buildSkeleton(longLine, { file: 'bundle.min.js' });
  assert.equal(sk.source.minified, true);
  assert.ok(sk.warnings.some((w) => /压缩|混淆/.test(w)));
});

test('空文件：产出警告而不是崩溃', () => {
  const sk = buildSkeleton('// 没有 UI\nconst x = 1;\n', { file: 'empty.js' });
  assert.equal(sk.controls.length, 0);
  assert.ok(sk.warnings.some((w) => /没有识别到任何 React 元素/.test(w)));
});

test('HTML 产物包含关键区块与安全转义', () => {
  const src = `h('div', { className: 'x' }, h('script', null, '<img src=x onerror=alert(1)>'))`;
  const sk = buildSkeleton(src, { file: 'demo.js' });
  const html = toHtml(sk);
  assert.ok(html.includes('插槽展开'));
  assert.ok(html.includes('控件清单'));
  assert.ok(html.includes('渲染预览'));
  assert.ok(html.includes('&lt;img'), '源码里的标签必须被转义，不能原样注入');
  assert.ok(!html.includes('<img src=x'), '不得出现未转义的原始标签');
});

test('工具入口：写盘产出 HTML + JSON，且能只解析不写盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ui-check-'));
  const prev = process.cwd();
  try {
    mkdirSync(join(dir, 'lib'), { recursive: true });
    writeFileSync(join(dir, 'lib', 'client.js'), `h('div', { className: 'a' }, h('button', null, 'go'))\n`, 'utf8');

    // 只解析
    const dry = await runUiCheck({ plugin: dir, write: false });
    assert.equal(dry.ok, true);
    assert.equal(dry.file, null, 'write:false 不产生产物路径');
    assert.equal(existsSync(join(dir, 'assets')), false);

    // 写盘
    const real = await runUiCheck({ plugin: dir });
    assert.equal(real.ok, true);
    assert.ok(existsSync(real.file), 'HTML 应写入');
    assert.ok(existsSync(real.json), 'JSON 应写入');
    const json = JSON.parse(readFileSync(real.json, 'utf8'));
    assert.equal(json.schema, 'dsh-ui-skeleton/1');
    assert.ok(json.controls.length >= 2);
    assert.ok(json.controls.every((c) => c.visible === null), 'visible 必须留给渲染探针');

    // 缺文件时给可操作提示
    const missing = await runUiCheck({ plugin: join(dir, 'nope') });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /插件根目录不存在/);
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});
