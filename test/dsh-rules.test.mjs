/**
 * DSH 插件专属规则的单测（与 dsh-git-push 的 audit-rules-dsh.yml 一一对应）。
 *
 * 每条规则都验证「正例命中 + 关键负例不误报」，避免规则只在纸面上存在。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkDshRules, DSH_RULES, isClientFile } from '../lib/core/verify-plugin/dsh-rules.mjs';

/** 建一个临时插件目录并写入给定文件。 */
function makePlugin(files) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rules-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

test('规则表与 git-push 的 9 条规则一一对应', () => {
  const ids = DSH_RULES.map((r) => r.id).sort();
  assert.deepEqual(ids, [
    'dsh/client-module-loader-id',
    'dsh/client-node-builtin-require',
    'dsh/ctx-undeclared-property-read',
    'dsh/host-api-guessed-fallback-chain',
    'dsh/import-bare-cordis',
    'dsh/import-bare-schemastery',
    'dsh/patch-insert-unique-id',
    'dsh/schema-secret-field-role',
    'dsh/tool-render-empty-body',
  ]);
});

test('裸名导入：cordis / schemastery 各命中，scoped 包不误报', () => {
  const dir = makePlugin({
    'lib/a.js': [
      "import { Context } from 'cordis'",
      "import z from 'schemastery'",
      "import { Service } from '@deepseek-ai/cordis'",
      "import zz from '@deepseek-ai/schemastery'",
    ].join('\n'),
  });
  try {
    const hits = checkDshRules({ root: dir }).hits.filter((h) => h.rule.startsWith('dsh/import-bare'));
    assert.equal(hits.length, 2);
    assert.deepEqual(hits.map((h) => h.line).sort(), [1, 2]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('工具 render 空实现命中，正常实现不误报', () => {
  const dir = makePlugin({
    'lib/tools.js': [
      'const a = { output: { render(args, value) {} } }',
      'const b = { output: { render(args, value) { return null; } } }',
      'const c = { output: { render(args, value) { return [{ type: "text", text: String(value) }]; } } }',
    ].join('\n'),
  });
  try {
    const hits = checkDshRules({ root: dir }).hits.filter((h) => h.rule === 'dsh/tool-render-empty-body');
    assert.equal(hits.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('client 半部 require Node 内置命中；服务端同写法不误报', () => {
  const dir = makePlugin({
    'lib/client.js': "const fs = require('fs')\nwindow.__ModuleLoader__.load({})\n",
    'lib/server.js': "const fs = require('node:fs')\n",
  });
  try {
    const hits = checkDshRules({ root: dir }).hits.filter((h) => h.rule === 'dsh/client-node-builtin-require');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].file, 'lib/client.js');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('凭据字段缺 role("secret") 命中，带 role 不误报', () => {
  const dir = makePlugin({
    'lib/schema.js': [
      'const a = { token: z.string() }',
      'const b = { token: z.string().role("secret") }',
      'const c = { name: z.string() }',
    ].join('\n'),
  });
  try {
    const hits = checkDshRules({ root: dir }).hits.filter((h) => h.rule === 'dsh/schema-secret-field-role');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('patch insert id 与覆盖行重复命中；不重复不误报', () => {
  const dup = makePlugin({
    'cordis.patch.yml': ['- insert:', '    - id: same-id', '      name: pkg', '- id: same-id', '  config: {}'].join('\n'),
  });
  const ok = makePlugin({
    'cordis.patch.yml': ['- insert:', '    - id: new-id', '      name: pkg', '- id: other-id'].join('\n'),
  });
  try {
    const dupHits = checkDshRules({ root: dup }).hits.filter((h) => h.rule === 'dsh/patch-insert-unique-id');
    assert.equal(dupHits.length, 1);
    assert.match(dupHits[0].text, /same-id/);
    const okHits = checkDshRules({ root: ok }).hits.filter((h) => h.rule === 'dsh/patch-insert-unique-id');
    assert.equal(okHits.length, 0);
  } finally {
    rmSync(dup, { recursive: true, force: true });
    rmSync(ok, { recursive: true, force: true });
  }
});

test('client 缺 __ModuleLoader__ 命中；有则不误报', () => {
  const bad = makePlugin({ 'lib/client.js': 'exports.x = 1\n' });
  const good = makePlugin({ 'lib/client.js': 'window.__ModuleLoader__.load({ id: "x", factory: () => ({}) })\n' });
  try {
    assert.equal(checkDshRules({ root: bad }).hits.filter((h) => h.rule === 'dsh/client-module-loader-id').length, 1);
    assert.equal(checkDshRules({ root: good }).hits.filter((h) => h.rule === 'dsh/client-module-loader-id').length, 0);
  } finally {
    rmSync(bad, { recursive: true, force: true });
    rmSync(good, { recursive: true, force: true });
  }
});

test('ctx 未注入属性：代码命中，注释整行豁免', () => {
  const dir = makePlugin({
    'lib/handler.js': [
      'function f(ctx) { return ctx.sessionId }',
      '// 说明：不要读 ctx.sessionId（注释里的示例不算）',
      '/* ctx.workspaceRoot 也不能读 */',
      'const ok = ctx.get("sessions")',
    ].join('\n'),
  });
  try {
    const hits = checkDshRules({ root: dir }).hits.filter((h) => h.rule === 'dsh/ctx-undeclared-property-read');
    assert.equal(hits.length, 1, '只有第 1 行是真代码');
    assert.equal(hits[0].line, 1);
    assert.equal(hits[0].severity, 'blocker');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('猜宿主 API 兜底链命中，直接调用不误报', () => {
  const dir = makePlugin({
    'lib/routes.js': [
      'const a = webServer.addRoute || webServer.route || webServer.use',
      'webServer.register({ kind: "prefix", path: "/x", handler })',
    ].join('\n'),
  });
  try {
    const hits = checkDshRules({ root: dir }).hits.filter((h) => h.rule === 'dsh/host-api-guessed-fallback-chain');
    assert.equal(hits.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isClientFile：native-host 不算浏览器侧', () => {
  assert.equal(isClientFile('lib/client.js'), true);
  assert.equal(isClientFile('client/app.js'), true);
  assert.equal(isClientFile('crx/background.js'), true);
  assert.equal(isClientFile('crx/native-host/host.js'), false);
  assert.equal(isClientFile('lib/server.js'), false);
});

// ── 自指误报回归（规则不能命中自己的说明文案）──────────────────────────

test('规则说明字符串里的违规写法不产生 finding（自指误报回归）', () => {
  const dir = makePlugin({
    'lib/rules-meta.js': [
      // 真实形态：规则表里的 message 文案，写出违规写法以便说明规则
      "const rule = {",
      "  id: 'dsh/host-api-guessed-fallback-chain',",
      "  message: '用 addRoute || route || use 这类猜测 API 兜底，真实 API 不匹配时静默 return',",
      "  other: '禁止 require(\"fs\") 与 import x from \"cordis\" 这类写法',",
      '}',
    ].join('\n'),
  });
  try {
    const rules = checkDshRules({ root: dir }).hits.map((h) => h.rule);
    assert.deepEqual(rules, [], `字符串字面量里的写法不是代码，不应产生 finding：${rules.join(', ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('注释里写违规写法不产生 finding（行内注释也算）', () => {
  const dir = makePlugin({
    'lib/routes.js': [
      '// 反例：webServer.addRoute || webServer.route 会静默失败',
      'const ok = webServer.register({ kind: "prefix", path: "/x", handler }) /* ctx.sessionId 也不能读 */',
    ].join('\n'),
  });
  try {
    const rules = checkDshRules({ root: dir }).hits.map((h) => h.rule);
    assert.deepEqual(rules, [], `注释不是代码：${rules.join(', ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('反向验证：真实代码里的同一写法仍然报错（不是把规则关掉）', () => {
  const dir = makePlugin({
    'lib/routes.js': [
      'const r = srv.addRoute || srv.route',
      'function f(ctx) { return ctx.sessionId }',
    ].join('\n'),
  });
  try {
    const rules = checkDshRules({ root: dir }).hits.map((h) => h.rule).sort();
    assert.deepEqual(rules, ['dsh/ctx-undeclared-property-read', 'dsh/host-api-guessed-fallback-chain']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('规则定义文件自身不被扫描（dsh-rules.mjs）', () => {
  const dir = makePlugin({
    'lib/core/verify-plugin/dsh-rules.mjs': "const message = '用 addRoute || route || use 兜底'\n",
    'lib/other.js': 'const a = 1\n',
  });
  try {
    const r = checkDshRules({ root: dir });
    assert.equal(r.hits.length, 0);
    assert.equal(r.scannedFiles, 1, '只应扫到 lib/other.js，规则定义文件被跳过');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('需要字符串内容的规则不受遮蔽影响（模块名 / require 内置）', () => {
  const dir = makePlugin({
    'lib/a.js': "import z from 'schemastery'\n",
    'lib/client.js': "const fs = require('fs')\nwindow.__ModuleLoader__.load({})\n",
  });
  try {
    const rules = checkDshRules({ root: dir }).hits.map((h) => h.rule).sort();
    assert.deepEqual(rules, ['dsh/client-node-builtin-require', 'dsh/import-bare-schemastery']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
