/**
 * 摩擦清单修复 + 残留报告（回归）
 *
 * 覆盖：
 *   ① minihost 工具层把 core 已有的能力暴露出来（env / force / preview / all）
 *   ② preview 的 spec 可以 inline（对象或 JSON 文本），不必先落文件
 *   ③ sync_plugin 的 stale 清单：目标有、源码没有的文件只报告，且标出受保护项
 *
 * 不测 minihost 的台账归属过滤：台账路径固定在仓库根的 .minihost，跑测试会污染真实台账。
 * 那条逻辑靠「默认只列 ownerPid 相同项」这一句本身足够直白，改坏时人工一看就懂。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parameters as minihostParameters } from '../lib/shared/minihost/index.js';
import { description as syncDescription } from '../lib/shared/sync_plugin/index.js';
import { loadSpec } from '../lib/core/preview/gen.js';
import { listStaleFiles } from '../lib/core/sync-plugin/sync-plugin.mjs';

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

test('minihost 工具层暴露 env / force / preview / all', () => {
  const props = minihostParameters.properties;
  for (const key of ['env', 'force', 'preview', 'all']) {
    assert.equal(Boolean(props[key]), true, `缺参数 ${key}——core 有该能力但工具层没暴露，调用方只能绕路`);
  }
  // env 必须能表达「覆盖 DSH_HOME」这件事，否则隔离验证没法做
  assert.match(props.env.description, /DSH_HOME/);
});

test('sync_plugin 的工具描述提到 stale（残留只报告不删除）', () => {
  assert.match(syncDescription, /stale/);
  assert.match(syncDescription, /只报告不删除/);
});

test('loadSpec 接受 inline 对象', async () => {
  const spec = await loadSpec({ title: 't', body: '<div></div>' });
  assert.equal(spec.title, 't');
});

test('loadSpec 接受 inline JSON 文本', async () => {
  const spec = await loadSpec('{"title":"inline","client":"lib/client.js"}');
  assert.equal(spec.title, 'inline');
  assert.equal(spec.client, 'lib/client.js');
});

test('loadSpec 遇到坏 JSON 明确报错，而不是当成文件名', async () => {
  await assert.rejects(() => loadSpec('{not json}'), /inline JSON/);
});

test('loadSpec 仍按文件路径工作（向后兼容）', async () => {
  const dir = tempDir('spec-file');
  try {
    const file = join(dir, 'preview.spec.json');
    writeFileSync(file, JSON.stringify({ title: 'from-file' }));
    const spec = await loadSpec(file);
    assert.equal(spec.title, 'from-file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listStaleFiles：报出源码没有的文件，tools/ 下的标记为受保护', () => {
  const dir = tempDir('stale');
  try {
    mkdirSync(join(dir, 'lib'), { recursive: true });
    mkdirSync(join(dir, 'tools'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(dir, 'lib', 'keep.js'), 'k\n');
    writeFileSync(join(dir, 'lib', 'old-name.js'), 'old\n');
    writeFileSync(join(dir, 'tools', 'ruff'), 'bin\n');
    writeFileSync(join(dir, 'node_modules', 'x', 'ignored.js'), 'i\n');

    const stale = listStaleFiles(dir, ['lib/keep.js']);
    const paths = stale.map((s) => s.path);
    assert.deepEqual(paths.sort(), ['lib/old-name.js', 'tools/ruff'], 'node_modules 不参与残留判定');
    assert.equal(stale.find((s) => s.path === 'tools/ruff').protected, true, 'tools/ 下是部署侧提供，要标受保护');
    assert.equal(stale.find((s) => s.path === 'lib/old-name.js').protected, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listStaleFiles：目标目录不存在时返回空数组，不抛', () => {
  assert.deepEqual(listStaleFiles('/tmp/definitely-not-exist-' + Date.now(), []), []);
});
