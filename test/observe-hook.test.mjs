/** 自动标记钩子回归：名单/多形态解析/放行不改结果/失败不阻断/开关。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectReadPaths, registerObserveHook, DEFAULT_OBSERVE_TOOLS, MAX_FILES_PER_CALL } from '../lib/mark-read/hook.js';

function fakeFsCtx({ throwOnResolve = false } = {}) {
  const emitted = [];
  return {
    emitted,
    ctx: {
      emit: (...a) => emitted.push(a),
      get: (k) => (k === 'fs' ? {
        resolve: async (p) => { if (throwOnResolve) throw new Error('boom'); return { targetKey: p, displayPath: p }; },
        stat: async () => ({ version: 'v1', type: 'file', size: 3 }),
      } : undefined),
    },
  };
}

test('名单外工具不提取；grep 结构化/文本/参数三路都提', () => {
  assert.deepEqual(collectReadPaths('edit_after_read', {}, { matches: [{ path: '/a/b.js' }] }), []);
  assert.deepEqual(collectReadPaths('grep', {}, { matches: [{ path: '/a/b.js' }] }), ['/a/b.js']);
  assert.deepEqual(collectReadPaths('grep', {}, { value: { matches: [{ file: '/x/b.ts' }] } }), ['/x/b.ts']);
  assert.deepEqual(collectReadPaths('grep', {}, '/x/d.js:12: hit'), ['/x/d.js']);
  assert.deepEqual(collectReadPaths('grep', { path: '/x/f.js' }, {}), ['/x/f.js']);
  assert.deepEqual(collectReadPaths('grep', { path: 'src/lib' }, {}), []);
  assert.equal(DEFAULT_OBSERVE_TOOLS.includes('grep'), true);
});

test('去重 + 上限', () => {
  const dup = { matches: [{ path: '/a/s.js' }, { path: '/a/s.js' }] };
  assert.deepEqual(collectReadPaths('grep', {}, dup), ['/a/s.js']);
  const many = { matches: Array.from({ length: MAX_FILES_PER_CALL + 20 }, (_, i) => ({ path: `/a/f${i}.js` })) };
  assert.equal(collectReadPaths('grep', {}, many).length, MAX_FILES_PER_CALL);
});

test('名单配置：逗号字符串生效（自定义命令集合）', () => {
  const r = { matches: [{ path: '/a/b.js' }] };
  assert.deepEqual(collectReadPaths('grep', {}, r, { tools: ['read'] }), [], '名单不含 grep 时不算');
  assert.deepEqual(collectReadPaths('read', {}, r, { tools: ['read', 'grep'] }), ['/a/b.js']);
});

test('钩子：先放行原样返回；命中文件补发观测；失败不阻断；开关/缺上下文不注册', async () => {
  let handler = null;
  const ctx = { on: (_n, fn) => { handler = fn; } };
  const { ctx: fsCtx, emitted } = fakeFsCtx();
  assert.equal(registerObserveHook(ctx, { fsCtx, cfg: { observeTools: 'grep,ripgrep' }, log: null }), true);
  const decision = { kind: 'allow' };
  const got = await handler({ name: 'grep', arguments: {} }, { matches: [{ path: '/x/a.js' }] }, async () => decision);
  assert.equal(got, decision);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0][0], 'fs/observed');
  assert.deepEqual(emitted[0][2], { kind: 'present', version: 'v1' });
  const { ctx: boomFs } = fakeFsCtx({ throwOnResolve: true });
  const got2 = await handler({ name: 'grep', arguments: {} }, { matches: [{ path: '/x/a.js' }] }, async () => decision);
  assert.equal(got2, decision, '观测抛错不影响工具结果');
  assert.equal(registerObserveHook({ on: () => {} }, { fsCtx: boomFs, cfg: { observeHook: false } }), false);
  assert.equal(registerObserveHook({ on: () => {} }, { fsCtx: null, cfg: {} }), false);
  assert.equal(registerObserveHook({}, { fsCtx: boomFs, cfg: {} }), false);
});
