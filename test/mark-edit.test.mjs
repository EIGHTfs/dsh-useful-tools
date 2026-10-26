/**
 * mark_edit 回归：标记「这些文件我经手过」→ 按官方 recipe 补发观测 + 落盘持久 + 可撤销。
 *
 * 用**假 ctx** 与**临时 DSH_HOME**钉住行为（不依赖真实宿主、不污染真实配置）：
 *   ① 标记 ⇒ 每个路径一次 emit('fs/observed', target, {kind:'present', version}, exec)，并写进 editPaths
 *   ② 不传 paths ⇒ 用持久清单续期（对应 mark_read「不传 commands 用预置清单」）
 *   ③ undo ⇒ 哨兵版本（必然对不上）+ 从清单移除 ⇒ 重新要求先读
 *   ④ settleMs ⇒ 延迟后才 stat（取到稳定后的版本）
 *   ⑤ 坏路径/非普通文件 ⇒ 记 failed，不影响其余路径
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_PATHS,
  MAX_SETTLE_MS,
  normalizeSettleMs,
  parsePaths,
  runMarkEdit,
  STALE_SENTINEL,
} from '../lib/core/mark-edit/index.js';
import { readEditPaths } from '../lib/core/mark-edit/store.js';
import { extractTargetPath, mightBeMarked, registerEditRefreshHook } from '../lib/core/mark-edit/hook.js';

/** 假 ctx：stat 按 options 返回版本；给 settleAfterMs 时模拟「时间戳晚到」——过该毫秒数后才稳定。 */
function fakeCtx({ kind = 'file', versions = ['v1', 'v2', 'v3'], settleAfterMs = 0 } = {}) {
  const emitted = [];
  const startedAt = Date.now();
  let statCalls = 0;
  const fs = {
    resolve: async (p) => ({ targetKey: p, displayPath: p }),
    stat: async () => {
      if (kind === 'missing') return undefined;
      statCalls += 1;
      // 时间戳晚到模型：窗口内返回 unsettled，窗口外返回 settled
      const version = settleAfterMs > 0
        ? (Date.now() - startedAt >= settleAfterMs ? 'settled' : 'unsettled')
        : versions[Math.min(statCalls - 1, versions.length - 1)];
      return { version, type: kind, size: 1 };
    },
  };
  const ctx = {
    emit: (...args) => { emitted.push(args); },
    get: (k) => (k === 'fs' ? fs : undefined),
  };
  return { ctx, emitted, statCalls: () => statCalls };
}

/** 把 DSH_HOME 指向临时目录跑一段逻辑（配置读写都落在临时目录里）。 */
async function withTempHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mark-edit-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 读临时 home 里的 config.json。 */
function readConfigOf(home) {
  try {
    return JSON.parse(readFileSync(join(home, 'useful-tools', 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

test('parsePaths：逗号/分号/换行混用；@清单文件', () => {
  assert.deepEqual(parsePaths('a.js, b.js;c.js\nd.js'), ['a.js', 'b.js', 'c.js', 'd.js']);
  assert.deepEqual(parsePaths('  '), []);
  assert.deepEqual(parsePaths(['x', ' y ', '']), ['x', 'y']);

  const dir = mkdtempSync(join(tmpdir(), 'mark-edit-list-'));
  try {
    const listFile = join(dir, 'list.txt');
    writeFileSync(listFile, 'one.js\ntwo.js,three.js\n', 'utf8');
    assert.deepEqual(parsePaths(`@${listFile}`), ['one.js', 'two.js', 'three.js']);
    assert.deepEqual(parsePaths('@/no/such/list.txt'), ['@/no/such/list.txt']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizeSettleMs：非法归零、上限截断', () => {
  assert.equal(normalizeSettleMs(undefined), 0);
  assert.equal(normalizeSettleMs(-5), 0);
  assert.equal(normalizeSettleMs('abc'), 0);
  assert.equal(normalizeSettleMs(120), 120);
  assert.equal(normalizeSettleMs(99999), MAX_SETTLE_MS);
});

test('标记：补发 present+版本、actor 透传，并写入持久清单', async () => {
  await withTempHome(async (home) => {
    const exec = { agent: 'a1' };
    const { ctx, emitted } = fakeCtx({ versions: ['v42'] });
    const r = await runMarkEdit({ paths: 'a.js,b.js' }, { ctx, exec });

    assert.equal(r.ok, true);
    assert.equal(r.action, 'mark');
    assert.deepEqual(r.marked, [{ path: 'a.js', version: 'v42' }, { path: 'b.js', version: 'v42' }]);
    assert.equal(emitted.length, 2);
    assert.equal(emitted[0][0], 'fs/observed');
    assert.deepEqual(emitted[0][2], { kind: 'present', version: 'v42' });
    assert.equal(emitted[0][3], exec, 'actor 必须是本次工具的 exec（台账按 owner 隔离）');

    assert.deepEqual(readEditPaths(), ['a.js', 'b.js'], '清单应落盘');
    assert.deepEqual(readConfigOf(home).editPaths, ['a.js', 'b.js']);
  });
});

test('不传 paths：用持久清单续期（renewed）', async () => {
  await withTempHome(async () => {
    const first = fakeCtx({ versions: ['v1'] });
    await runMarkEdit({ paths: 'a.js' }, { ctx: first.ctx, exec: {} });

    // 换一个 ctx（新版本），不传 paths ⇒ 应按清单重新补发
    const again = fakeCtx({ versions: ['v9'] });
    const r = await runMarkEdit({}, { ctx: again.ctx, exec: {} });
    assert.equal(r.ok, true);
    assert.equal(r.renewed, true);
    assert.deepEqual(r.marked, [{ path: 'a.js', version: 'v9' }]);
    assert.equal(again.emitted.length, 1);
  });
});

test('undo：补发哨兵版本并从清单移除（门禁恢复）', async () => {
  await withTempHome(async () => {
    const mark = fakeCtx({ versions: ['v1'] });
    await runMarkEdit({ paths: 'a.js' }, { ctx: mark.ctx, exec: {} });
    assert.deepEqual(readEditPaths(), ['a.js']);

    const un = fakeCtx({ versions: ['v2'] });
    const r = await runMarkEdit({ paths: 'a.js', undo: true }, { ctx: un.ctx, exec: {} });
    assert.equal(r.action, 'undo');
    assert.deepEqual(un.emitted[0][2], STALE_SENTINEL);
    assert.equal(STALE_SENTINEL.version, '__mark_edit_undo__');
    assert.deepEqual(readEditPaths(), [], '撤销后清单应为空');
  });
});

test('settleMs：延迟后才 stat，取到稳定后的版本', async () => {
  await withTempHome(async () => {
    // 窗口 40ms：立即标记拿到 unsettled（模拟写后立刻 probe 的官方行为）
    const immediate = fakeCtx({ settleAfterMs: 40 });
    const r1 = await runMarkEdit({ paths: 'a.js' }, { ctx: immediate.ctx, exec: {} });
    assert.equal(r1.marked[0].version, 'unsettled');

    // settleMs 60 > 窗口 40：等过窗口再 stat，拿到 settled
    const delayed = fakeCtx({ settleAfterMs: 40 });
    const r2 = await runMarkEdit({ paths: 'a.js', settleMs: 60 }, { ctx: delayed.ctx, exec: {} });
    assert.equal(r2.settleMs, 60);
    assert.equal(r2.marked[0].version, 'settled', '延迟后应取到稳定后的版本');
  });
});

test('坏路径 / 非普通文件：记 failed，不影响其余路径', async () => {
  await withTempHome(async () => {
    const missing = fakeCtx({ kind: 'missing' });
    const r1 = await runMarkEdit({ paths: 'gone.js' }, { ctx: missing.ctx, exec: {} });
    assert.equal(r1.ok, false, '全部失败时 ok:false');
    assert.match(r1.failed[0].error, /不存在/);

    const dirTarget = fakeCtx({ kind: 'dir' });
    const r2 = await runMarkEdit({ paths: 'somedir' }, { ctx: dirTarget.ctx, exec: {} });
    assert.equal(r2.ok, false);
    assert.match(r2.failed[0].error, /非普通文件/);
  });
});

test('缺上下文 / 缺 fs 服务 / 空参数：ok:false 且给出可读原因', async () => {
  await withTempHome(async () => {
    assert.match((await runMarkEdit({ paths: 'a.js' }, {})).error, /缺少宿主上下文/);
    const bare = { emit: () => {}, get: () => undefined };
    assert.match((await runMarkEdit({ paths: 'a.js' }, { ctx: bare })).error, /fs 服务不可用/);
    assert.match((await runMarkEdit({ paths: '  ' }, { ctx: bare })).error, /没有可处理的路径/);
  });
});

test('超过上限时截断并报告剩余数量', async () => {
  await withTempHome(async () => {
    const { ctx } = fakeCtx({ versions: ['v1'] });
    const many = Array.from({ length: MAX_PATHS + 5 }, (_, i) => `f${i}.js`).join(',');
    const r = await runMarkEdit({ paths: many }, { ctx, exec: {} });
    assert.equal(r.marked.length, MAX_PATHS);
    assert.equal(r.truncated, 5);
    assert.equal(readEditPaths().length, MAX_PATHS, '清单只记实际标记成功的');
  });
});

test('落盘保留配置文件里的其它键（与 mark_read 等共用）', async () => {
  await withTempHome(async (home) => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(home, 'useful-tools'), { recursive: true });
    const cfgPath = join(home, 'useful-tools', 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ observeHook: true, observeTools: ['grep'], testEnvRoot: '/x' }), 'utf8');

    const { ctx } = fakeCtx({ versions: ['v1'] });
    await runMarkEdit({ paths: 'a.js' }, { ctx, exec: {} });

    const cfg = readConfigOf(home);
    assert.deepEqual(cfg.editPaths, ['a.js']);
    assert.deepEqual(cfg.observeTools, ['grep'], '不得动 mark_read 的键');
    assert.equal(cfg.testEnvRoot, '/x', '不得丢其它消费方的键');
  });
});

// ── 自动续期钩子（持久清单里的路径被写改后，等时间戳写稳再补发一次）──────────

test('extractTargetPath：只认 write / edit', () => {
  assert.equal(extractTargetPath('write', { path: '/a.js' }), '/a.js');
  assert.equal(extractTargetPath('edit', { file_path: 'b.js' }), 'b.js');
  assert.equal(extractTargetPath('write', { filePath: 'c.js' }), 'c.js');
  assert.equal(extractTargetPath('read', { path: '/a.js' }), '', '读不算改动');
  assert.equal(extractTargetPath('write', {}), '');
});

test('mightBeMarked：绝对路径精确比、相对路径按片段后缀比', () => {
  const marked = ['/w/a.js', '/w/sub/b.js'];
  assert.equal(mightBeMarked('/w/a.js', marked), true);
  assert.equal(mightBeMarked('a.js', marked), true);
  assert.equal(mightBeMarked('sub/b.js', marked), true);
  assert.equal(mightBeMarked('other/c.js', marked), false);
  assert.equal(mightBeMarked('', marked), false);
  assert.equal(mightBeMarked('/w/a.js', []), false);
});

test('续期钩子：只对标记过的路径补发，未标记完全不碰', async () => {
  await withTempHome(async () => {
    // 预置清单：只标记 /w/marked.js
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(process.env.DSH_HOME, 'useful-tools'), { recursive: true });
    writeFileSync(join(process.env.DSH_HOME, 'useful-tools', 'config.json'),
      JSON.stringify({ editPaths: ['/w/marked.js'] }), 'utf8');

    const emitted = [];
    const fsCtx = {
      emit: (...args) => emitted.push(args),
      get: (k) => (k === 'fs' ? {
        resolve: async (p) => ({ targetKey: p, displayPath: p }),
        stat: async () => ({ version: 'settled', type: 'file', size: 1 }),
      } : undefined),
    };
    const listeners = [];
    const ctx = { on: (name, fn) => { if (name === 'tools/post-execute') listeners.push(fn); } };

    assert.equal(registerEditRefreshHook(ctx, { fsCtx, cfg: { editSettleMs: 0 } }), true);
    assert.equal(listeners.length, 1);

    const exec = { name: 'write', arguments: { path: '/w/marked.js' } };
    await listeners[0](exec, {}, async () => 'decision');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(emitted.length, 1, '标记过的路径应续期补发一次');
    assert.deepEqual(emitted[0][2], { kind: 'present', version: 'settled' });

    // 未标记路径：不补发
    const exec2 = { name: 'edit', arguments: { path: '/w/other.js' } };
    await listeners[0](exec2, {}, async () => 'decision');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(emitted.length, 1, '未标记的路径不得被碰');
  });
});
