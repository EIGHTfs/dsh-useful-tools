/**
 * mark_edit 回归：把「我刚改过这些文件」按官方 recipe 补发观测。
 *
 * 用**假 ctx** 钉住行为（不依赖真实宿主）：
 *   ① 正常标记 ⇒ 每个路径一次 emit('fs/observed', target, {kind:'present', version}, exec)
 *   ② undo     ⇒ 补发哨兵版本（必然对不上）⇒ 宿主 CAS 判 stale ⇒ 重新要求先读
 *   ③ 坏路径/非普通文件 ⇒ 记进 failed，不影响其余路径（批量场景）
 *   ④ 入参解析（逗号 / 分号 / 换行 / @清单文件 / 数组）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAX_PATHS, parsePaths, runMarkEdit, STALE_SENTINEL } from '../lib/core/mark-edit/index.js';

/** 假 ctx：resolve 按路径回显，stat 按需返回文件/目录/不存在。 */
function fakeCtx({ kind = 'file', version = 'v9' } = {}) {
  const emitted = [];
  const fs = {
    resolve: async (p) => ({ targetKey: p, displayPath: p }),
    stat: async () => (kind === 'missing' ? undefined : { version, type: kind, size: 1 }),
  };
  const ctx = {
    emit: (...args) => { emitted.push(args); },
    get: (k) => (k === 'fs' ? fs : undefined),
  };
  return { ctx, emitted };
}

test('parsePaths：逗号/分号/换行混用，去空白与空项', () => {
  assert.deepEqual(parsePaths('a.js, b.js;c.js\nd.js'), ['a.js', 'b.js', 'c.js', 'd.js']);
  assert.deepEqual(parsePaths('  '), []);
  assert.deepEqual(parsePaths(['x', ' y ', '']), ['x', 'y']);
});

test('parsePaths：@清单文件（每行或逗号一个）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mark-edit-'));
  try {
    const listFile = join(dir, 'list.txt');
    writeFileSync(listFile, 'one.js\ntwo.js,three.js\n', 'utf8');
    assert.deepEqual(parsePaths(`@${listFile}`), ['one.js', 'two.js', 'three.js']);
    // 清单文件不存在：按普通路径处理，不静默丢
    assert.deepEqual(parsePaths('@/no/such/list.txt'), ['@/no/such/list.txt']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('标记：每个路径补发一次 present + 当前版本，actor 是本次 exec', async () => {
  const exec = { agent: 'a1' };
  const { ctx, emitted } = fakeCtx({ version: 'v42' });
  const r = await runMarkEdit({ paths: 'a.js,b.js' }, { ctx, exec });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'mark');
  assert.equal(r.marked.length, 2);
  assert.deepEqual(r.marked[0], { path: 'a.js', version: 'v42' });
  assert.equal(emitted.length, 2);
  assert.equal(emitted[0][0], 'fs/observed');
  assert.deepEqual(emitted[0][2], { kind: 'present', version: 'v42' });
  assert.equal(emitted[0][3], exec, 'actor 必须是本次工具的 exec（台账按 owner 隔离）');
});

test('undo：补发哨兵版本（必然对不上）⇒ 重新要求先读', async () => {
  const { ctx, emitted } = fakeCtx();
  const r = await runMarkEdit({ paths: 'a.js', undo: true }, { ctx, exec: {} });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'undo');
  assert.deepEqual(emitted[0][2], STALE_SENTINEL);
  assert.equal(STALE_SENTINEL.version, '__mark_edit_undo__');
});

test('坏路径 / 非普通文件：记 failed，不影响其余路径', async () => {
  const missing = fakeCtx({ kind: 'missing' });
  const r1 = await runMarkEdit({ paths: 'gone.js' }, { ctx: missing.ctx, exec: {} });
  assert.equal(r1.ok, false, '全部失败时 ok:false');
  assert.equal(r1.failed.length, 1);
  assert.match(r1.failed[0].error, /不存在/);

  const dirTarget = fakeCtx({ kind: 'dir' });
  const r2 = await runMarkEdit({ paths: 'somedir' }, { ctx: dirTarget.ctx, exec: {} });
  assert.equal(r2.ok, false);
  assert.match(r2.failed[0].error, /非普通文件/);
});

test('缺上下文 / 缺 fs 服务 / 空路径：ok:false 且给出可读原因', async () => {
  assert.match((await runMarkEdit({ paths: 'a.js' }, {})).error, /缺少宿主上下文/);
  const bare = { emit: () => {}, get: () => undefined };
  assert.match((await runMarkEdit({ paths: 'a.js' }, { ctx: bare })).error, /fs 服务不可用/);
  assert.match((await runMarkEdit({ paths: '  ' }, { ctx: bare })).error, /paths 为空/);
});

test('超过上限时截断并报告剩余数量', async () => {
  const { ctx } = fakeCtx();
  const many = Array.from({ length: MAX_PATHS + 5 }, (_, i) => `f${i}.js`).join(',');
  const r = await runMarkEdit({ paths: many }, { ctx, exec: {} });
  assert.equal(r.marked.length, MAX_PATHS);
  assert.equal(r.truncated, 5);
});
