/** 静态装配分析回归：apply 返回值形态、注册调用、patch 结构、字符串/嵌套不误判。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyzePlugin, inspectApplyReturns, readBundlePatch } from '../lib/core/verify-plugin/static.mjs';
import { checkClient, checkInject } from '../lib/core/verify-plugin/check.mjs';

/** 造一个临时插件目录：写 package.json + 入口文件，返回根路径。 */
function makePlugin(source, { name = 'fake-plugin', patch = '' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'verify-plugin-'));
  mkdirSync(join(root, 'lib'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name, version: '0.0.0', main: 'lib/index.js' }));
  writeFileSync(join(root, 'lib', 'index.js'), source);
  if (patch) writeFileSync(join(root, 'cordis.patch.yml'), patch);
  return root;
}

test('apply 返回对象字面量：判为风险（Invalid effect 的静态特征）', () => {
  const r = inspectApplyReturns(`
export async function apply(ctx) {
  ctx.inject(['tools'], (c) => { c.get('tools').register({ name: 'x' }); });
  return { name: 'fake', tools: ['x'] };
}
`);
  assert.equal(r.found, true);
  assert.equal(r.risky, true);
  assert.match(r.samples[0], /return \{/);
});

test('apply 无返回 / 返回函数：不判风险', () => {
  assert.equal(inspectApplyReturns('export async function apply() { /* 空 */ }').risky, false);
  assert.equal(inspectApplyReturns('export async function apply() { return () => {}; }').risky, false);
});

test('嵌套函数里的 return {} 不误报（深度跟踪）', () => {
  const r = inspectApplyReturns(`
export function apply() {
  const helper = () => { return { nested: true }; };
  helper();
}
`);
  assert.equal(r.risky, false);
});

test('字符串里的花括号不干扰配对', () => {
  const r = inspectApplyReturns(`
export function apply() {
  const s = "} { \\" }";
  return undefined;
}
`);
  assert.equal(r.risky, false);
});

test('正常插件：apply + tools 注册 + insert patch → 通过', () => {
  const root = makePlugin(`
export async function apply(ctx) {
  ctx.inject(['tools'], (c) => {
    const reg = c.get('tools');
    reg.register(reg.defineTool({ name: 'alpha', execute: async () => '{}' }));
  });
}
`, { name: 'fake-plugin', patch: '- insert:\n    - id: fake-plugin\n      name: fake-plugin\n' });
  try {
    const a = analyzePlugin(root);
    assert.equal(a.ok, true);
    assert.equal(a.hasApply, true);
    assert.equal(a.registersTools, true);
    assert.equal(a.applyReturn.risky, false);
    assert.equal(a.bundlePatch.hasInsert, true);
    assert.equal(a.bundlePatch.idMatchesName, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('apply 返回对象：problems 明确指出 Invalid effect 风险', () => {
  const root = makePlugin(`
export async function apply(ctx) {
  ctx.inject(['tools'], (c) => { c.get('tools').register({ name: 'x' }); });
  return { name: 'fake-plugin', tools: ['x'] };
}
`);
  try {
    const a = analyzePlugin(root);
    assert.equal(a.ok, false);
    assert.ok(a.problems.some((p) => /Invalid effect/.test(p)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('没有 tools 注册调用：降级为 warning（不注册工具的插件也合法）', () => {
  const root = makePlugin('export async function apply(ctx) { ctx.on("x", () => {}); }');
  try {
    const a = analyzePlugin(root);
    assert.equal(a.ok, true);
    assert.ok(a.warnings.some((w) => /tools/.test(w)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('没有导出 apply：problems 指出宿主不会装载', () => {
  const root = makePlugin('export const nope = 1;');
  try {
    const a = analyzePlugin(root);
    assert.equal(a.ok, false);
    assert.ok(a.problems.some((p) => /apply/.test(p)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('patch 缺顶层 insert：判为装载入口缺失', () => {
  const root = makePlugin('export async function apply(ctx) { ctx.inject(["tools"], () => {}); }', { patch: '- id: fake-plugin\n  disabled: true\n' });
  try {
    const a = analyzePlugin(root);
    assert.ok(a.problems.some((p) => /insert/.test(p)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('readBundlePatch：无文件返回 found:false，不报错', () => {
  const root = mkdtempSync(join(tmpdir(), 'verify-plugin-'));
  try {
    assert.equal(readBundlePatch(root, 'x').found, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('客户端入口按 exports["./client"] 识别，不写死 lib/client.js', () => {
  const root = mkdtempSync(join(tmpdir(), 'verify-client-'));
  try {
    mkdirSync(join(root, 'plugin'), { recursive: true });
    const pkg = {
      name: 'p',
      version: '0.0.0',
      exports: { './client': './plugin/client.js' },
      dsh: { client: { platform: 'web' } },
    };
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
    writeFileSync(join(root, 'plugin', 'client.js'), 'window.__ModuleLoader__.load({ id: "p", factory: () => ({}) });');
    const out = checkClient(root, pkg);
    assert.equal(out.exists, true, '导出路径存在时不应判缺失');
    assert.equal(out.hasLoader, true);
    assert.equal(out.problems.length, 0, `不该有 problem，实际：${out.problems.join('；')}`);
    assert.match(out.path, /plugin[/\\]client\.js$/, '应指向 exports 声明的入口');
    assert.equal(out.entryFromExports, './plugin/client.js');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('客户端入口真缺失时仍报错（别把检查改废）', () => {
  const root = mkdtempSync(join(tmpdir(), 'verify-client-miss-'));
  try {
    const pkg = { name: 'p', version: '0.0.0', dsh: { client: { platform: 'web' } } };
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
    const out = checkClient(root, pkg);
    assert.equal(out.exists, false);
    assert.ok(out.problems.length > 0, '声明了 dsh.client 却没有任何入口时必须报错');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('inject 校验：陌生服务名只作提示，不判失败', () => {
  const root = mkdtempSync(join(tmpdir(), 'verify-inject-'));
  try {
    mkdirSync(join(root, 'lib'), { recursive: true });
    // 声明一个宿主池里没有、也没有近邻的名字：可能由依赖/其它插件提供，不该判失败
    writeFileSync(join(root, 'lib', 'index.js'), 'export const inject = ["browser"]; export function apply() {}\n');
    const analysis = { filesAnalyzed: [join(root, 'lib', 'index.js')] };
    const out = checkInject({ analysis });
    assert.deepEqual(out.declared, ['browser']);
    assert.ok(Array.isArray(out.unknown), 'unknown 应为数组');
    // 真实宿主里 browser 能扫到；扫不到时也只应进 unknown（由调用方降级为提示），这里锁住结构
    assert.ok(out.unknown.length <= 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
