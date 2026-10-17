/**
 * useful_tools 单测：动态清单来自 lib/shared 目录，不维护硬编码列表。
 *
 * 断言只依赖「至少存在若干工具」与「清单包含已知工具名」，
 * 不写死工具总数——新增工具时本测试不需要改。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { run as runUsefulTools } from '../lib/shared/useful_tools/index.js';

test('help：返回工具清单文本，包含已知工具与参数', async () => {
  const r = await runUsefulTools({ action: 'help' });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'help');
  assert.ok(r.count >= 6, '至少应列出 6 个工具');
  assert.ok(r.text.includes('mark_read'), '文本应包含 mark_read');
  assert.ok(r.text.includes('quick_command'), '文本应包含 quick_command');
  assert.ok(r.text.includes('参数：'), '文本应包含参数说明');
  assert.ok(r.text.includes('示例：'), '文本应包含示例调用');
  assert.ok(r.text.includes('sync_plugin'), '文本应包含 sync_plugin');
});

test('list：紧凑清单，每项有名字/说明/参数名', async () => {
  const r = await runUsefulTools({ action: 'list' });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'list');
  assert.ok(Array.isArray(r.tools));
  const names = r.tools.map((tool) => tool.name);
  assert.ok(names.includes('mark_read'));
  assert.ok(names.includes('useful_tools'), '清单应包含自身');
  const quick = r.tools.find((tool) => tool.name === 'quick_command');
  assert.ok(quick, '应有 quick_command');
  assert.ok(Array.isArray(quick.params) && quick.params.includes('action'));
  assert.ok(typeof r.text === 'string' && r.text.includes('quick_command'));
});

test('tool 过滤：只返回指定工具', async () => {
  const r = await runUsefulTools({ action: 'help', tool: 'mark_read' });
  assert.equal(r.ok, true);
  assert.equal(r.count, 1);
  assert.ok(r.text.includes('mark_read'));
  assert.ok(!r.text.includes('sync_plugin'), '过滤后不应包含其他工具');
});

test('未知工具：报错并给出可选名字', async () => {
  const r = await runUsefulTools({ action: 'list', tool: 'nope' });
  assert.equal(r.ok, false);
  assert.ok(Array.isArray(r.names));
  assert.ok(r.names.includes('mark_read'));
});

test('未知 action：报错', async () => {
  const r = await runUsefulTools({ action: 'wat' });
  assert.equal(r.ok, false);
  assert.match(r.error, /未知 action/);
});
