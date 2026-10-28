/**
 * mark_edit 回归：**全局生效**（与 mark_read 对称）——所有 write/edit 改过的文件自动续期。
 *
 * 用**假 ctx** 与**临时 DSH_HOME**钉住行为（不依赖真实宿主、不污染真实配置）：
 *   ① 缺省即开启：readEditSettings → { editHook:true, editSettleMs:150 }
 *   ② 任何时候的 write/edit 都会续期（**不需要标记、不需要清单**）；read 等其它工具不触发
 *   ③ 关掉开关后不再续期（每次现读配置）
 *   ④ paths 是「补标非 write/edit 的改动」；undo 补发哨兵恢复门禁
 *   ⑤ 工具参数 enabled / settleMs 写入配置并长期有效
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAX_PATHS, parsePaths, runMarkEdit, STALE_SENTINEL } from '../lib/core/mark-edit/index.js';
import {
  DEFAULT_SETTLE_MS,
  MAX_SETTLE_MS,
  normalizeSettleMs,
  readEditSettings,
} from '../lib/core/mark-edit/store.js';
import { extractBashWrites, extractTargetPath, registerEditRefreshHook } from '../lib/core/mark-edit/hook.js';
import { observeFileForHost } from '../lib/core/mark-read/observe.js';

/** 把 DSH_HOME 指向临时目录跑一段逻辑。 */
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

/** 读临时 home 的 config.json。 */
function readConfigOf(home) {
  try {
    return JSON.parse(readFileSync(join(home, 'useful-tools', 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** 假 fs ctx：stat 回固定版本，emit 记账。 */
function fakeFsCtx({ version = 'settled-v', kind = 'file' } = {}) {
  const emitted = [];
  const fs = {
    resolve: async (p) => ({ targetKey: p, displayPath: p }),
    stat: async () => (kind === 'missing' ? undefined : { version, type: kind, size: 1 }),
  };
  return {
    emitted,
    ctx: { emit: (...a) => emitted.push(a), get: (k) => (k === 'fs' ? fs : undefined) },
  };
}

/** 收集 tools/post-execute 监听器（只收我们注册的那个）。 */
function captureHook(fsCtx, cfg = {}) {
  const listeners = [];
  // mock 与真实 cordis 同契约：on() 返回 disposer（真实实现就是返回解绑函数）
  const ctx = { on: (name, fn) => { if (name === 'tools/post-execute') listeners.push(fn); return () => true; } };
  const disposer = registerEditRefreshHook(ctx, { fsCtx, cfg });
  return { ok: typeof disposer === 'function', listeners };
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizeSettleMs：非法归缺省、零保留、上限截断', () => {
  assert.equal(normalizeSettleMs(undefined), DEFAULT_SETTLE_MS);
  assert.equal(DEFAULT_SETTLE_MS, 1100, '缺省必须晚于实测漂移点 ~1000ms');
  assert.equal(normalizeSettleMs('abc'), DEFAULT_SETTLE_MS);
  assert.equal(normalizeSettleMs(0), 0);
  assert.equal(normalizeSettleMs(120), 120);
  assert.equal(normalizeSettleMs(99999), MAX_SETTLE_MS);
});

test('缺省即开启（全局）：editHook=true、延迟 150ms', async () => {
  await withTempHome(async () => {
    const s = readEditSettings();
    assert.equal(s.editHook, true, '缺省就应全局开启');
    assert.equal(s.editSettleMs, DEFAULT_SETTLE_MS);
    assert.equal(s.source, 'default');
  });
});

test('status：不传参数返回当前设置，不报错', async () => {
  await withTempHome(async () => {
    const r = await runMarkEdit({}, {});
    assert.equal(r.ok, true);
    assert.equal(r.action, 'status');
    assert.equal(r.editHook, true);
    assert.equal(r.editSettleMs, DEFAULT_SETTLE_MS);
  });
});

test('configure：enabled / settleMs 落盘并长期有效', async () => {
  await withTempHome(async (home) => {
    const off = await runMarkEdit({ enabled: false }, {});
    assert.equal(off.action, 'configure');
    assert.equal(off.editHook, false);
    assert.equal(readConfigOf(home).editHook, false);

    const settle = await runMarkEdit({ settleMs: 300 }, {});
    assert.equal(settle.editSettleMs, 300);
    assert.equal(readConfigOf(home).editSettleMs, 300);
    assert.equal(readConfigOf(home).editHook, false, '只改延迟不应把开关打开');

    const back = await runMarkEdit({ enabled: true }, {});
    assert.equal(back.editHook, true);
  });
});

test('全局钩子：任意 write/edit 都续期（多检查点、无需标记）；read 不触发', async () => {
  await withTempHome(async () => {
    const { emitted, ctx: fsCtx } = fakeFsCtx({ version: 'settled-v' });
    // 用很小的延迟与偏移跑测试（生产缺省 1100ms + [500,1300]）
    const cfg = { editSettleMs: 0, editRefreshOffsets: [30, 60] };
    const { ok, listeners } = captureHook(fsCtx, cfg);
    assert.equal(ok, true);

    // 一个从没标记过的路径：照样续期（这就是「对所有文件有效」）
    await listeners[0]({ name: 'write', arguments: { path: '/w/never-marked.js' } }, {}, async () => 'd');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(emitted.length, 3, '三个检查点各补发一次');
    assert.deepEqual(emitted[emitted.length - 1][2], { kind: 'present', version: 'settled-v' });

    await listeners[0]({ name: 'edit', arguments: { file_path: '/w/other.js' } }, {}, async () => 'd');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(emitted.length, 6, 'edit 也应触发三个检查点');

    await listeners[0]({ name: 'read', arguments: { path: '/w/x.js' } }, {}, async () => 'd');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(emitted.length, 6, 'read 不该触发续期');
  });
});

test('关掉开关后不再续期（每次现读配置）', async () => {
  await withTempHome(async () => {
    await runMarkEdit({ settleMs: 0 }, {});
    const { emitted, ctx: fsCtx } = fakeFsCtx();
    const { listeners } = captureHook(fsCtx);

    await listeners[0]({ name: 'write', arguments: { path: '/w/a.js' } }, {}, async () => 'd');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(emitted.length, 1);

    await runMarkEdit({ enabled: false }, {});
    await listeners[0]({ name: 'write', arguments: { path: '/w/b.js' } }, {}, async () => 'd');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(emitted.length, 1, '关闭后不得再补发');
  });
});

test('开关关闭时不注册钩子', async () => {
  await withTempHome(async () => {
    await runMarkEdit({ enabled: false }, {});
    const { ctx: fsCtx } = fakeFsCtx();
    const { ok, listeners } = captureHook(fsCtx);
    assert.equal(ok, false, '关闭时应直接不注册');
    assert.equal(listeners.length, 0);
  });
});

test('extractTargetPath：只认 write / edit', () => {
  assert.equal(extractTargetPath('write', { path: '/a.js' }), '/a.js');
  assert.equal(extractTargetPath('edit', { file_path: 'b.js' }), 'b.js');
  assert.equal(extractTargetPath('read', { path: '/a.js' }), '');
  assert.equal(extractTargetPath('write', {}), '');
});

test('paths 补标：present+版本、actor 透传；undo 哨兵', async () => {
  await withTempHome(async () => {
    const exec = { agent: 'a1' };
    const { emitted, ctx } = fakeFsCtx({ version: 'v42' });
    const r = await runMarkEdit({ paths: 'a.js,b.js' }, { ctx, exec });
    assert.equal(r.action, 'mark');
    assert.deepEqual(r.marked, [{ path: 'a.js', version: 'v42' }, { path: 'b.js', version: 'v42' }]);
    assert.deepEqual(emitted[0][2], { kind: 'present', version: 'v42' });
    assert.equal(emitted[0][3], exec, 'actor 必须是本次工具的 exec');

    const un = fakeFsCtx({ version: 'v43' });
    const r2 = await runMarkEdit({ paths: 'a.js', undo: true }, { ctx: un.ctx, exec });
    assert.equal(r2.action, 'undo');
    assert.deepEqual(un.emitted[0][2], STALE_SENTINEL);
  });
});

test('坏路径隔离 / 缺上下文 / 上限截断', async () => {
  await withTempHome(async () => {
    const missing = fakeFsCtx({ kind: 'missing' });
    const r1 = await runMarkEdit({ paths: 'gone.js' }, { ctx: missing.ctx, exec: {} });
    assert.equal(r1.ok, false);
    assert.match(r1.failed[0].error, /不存在/);

    assert.match((await runMarkEdit({ paths: 'a.js' }, {})).error, /缺少宿主上下文/);
    const bare = { emit: () => {}, get: () => undefined };
    assert.match((await runMarkEdit({ paths: 'a.js' }, { ctx: bare })).error, /fs 服务不可用/);

    const many = Array.from({ length: MAX_PATHS + 5 }, (_, i) => `f${i}.js`).join(',');
    const big = fakeFsCtx();
    const r2 = await runMarkEdit({ paths: many }, { ctx: big.ctx, exec: {} });
    assert.equal(r2.marked.length, MAX_PATHS);
    assert.equal(r2.truncated, 5);
  });
});

test('配置写入保留其它键（与 mark_read 等共用同一文件）', async () => {
  await withTempHome(async (home) => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(home, 'useful-tools'), { recursive: true });
    writeFileSync(join(home, 'useful-tools', 'config.json'),
      JSON.stringify({ observeHook: true, observeTools: ['grep'], testEnvRoot: '/x' }), 'utf8');

    await runMarkEdit({ enabled: false, settleMs: 80 }, {});

    const cfg = readConfigOf(home);
    assert.equal(cfg.editHook, false);
    assert.equal(cfg.editSettleMs, 80);
    assert.deepEqual(cfg.observeTools, ['grep'], '不得动 mark_read 的键');
    assert.equal(cfg.testEnvRoot, '/x', '不得丢其它消费方的键');
  });
});

test('observeFileForHost 的 settleMs：只发一条，且用稳定后的版本', async () => {
  const emitted = [];
  let calls = 0;
  const fs = {
    resolve: async (p) => ({ targetKey: p, displayPath: p }),
    stat: async () => ({ version: calls++ === 0 ? 'unsettled' : 'settled', type: 'file', size: 1 }),
  };
  const fsCtx = { emit: (...a) => emitted.push(a), get: (k) => (k === 'fs' ? fs : undefined) };
  const r = await observeFileForHost(fsCtx, {}, '/w/x.js', undefined, { settleMs: 10 });
  assert.equal(r.ok, true);
  assert.equal(emitted.length, 1, '只发一条（不是先发未稳定再发稳定）');
  assert.deepEqual(emitted[0][2], { kind: 'present', version: 'settled' }, '必须用稳定后的版本');
  assert.equal(calls, 2, '应 stat 两次');
});

test('关掉开关后不再续期（每次现读配置）', async () => {
  await withTempHome(async () => {
    await runMarkEdit({ settleMs: 0 }, {});
    const { emitted, ctx: fsCtx } = fakeFsCtx();
    const { listeners } = captureHook(fsCtx);

    await listeners[0]({ name: 'write', arguments: { path: '/w/a.js' } }, {}, async () => 'd');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(emitted.length, 1);

    await runMarkEdit({ enabled: false }, {});
    await listeners[0]({ name: 'write', arguments: { path: '/w/b.js' } }, {}, async () => 'd');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(emitted.length, 1, '关闭后不得再补发');
  });
});

test('开关关闭时不注册钩子', async () => {
  await withTempHome(async () => {
    await runMarkEdit({ enabled: false }, {});
    const { ctx: fsCtx } = fakeFsCtx();
    const { ok, listeners } = captureHook(fsCtx);
    assert.equal(ok, false, '关闭时应直接不注册');
    assert.equal(listeners.length, 0);
  });
});

test('extractTargetPath：只认 write / edit', () => {
  assert.equal(extractTargetPath('write', { path: '/a.js' }), '/a.js');
  assert.equal(extractTargetPath('edit', { file_path: 'b.js' }), 'b.js');
  assert.equal(extractTargetPath('read', { path: '/a.js' }), '');
  assert.equal(extractTargetPath('write', {}), '');
});

test('paths 补标：present+版本、actor 透传；undo 哨兵', async () => {
  await withTempHome(async () => {
    const exec = { agent: 'a1' };
    const { emitted, ctx } = fakeFsCtx({ version: 'v42' });
    const r = await runMarkEdit({ paths: 'a.js,b.js' }, { ctx, exec });
    assert.equal(r.action, 'mark');
    assert.deepEqual(r.marked, [{ path: 'a.js', version: 'v42' }, { path: 'b.js', version: 'v42' }]);
    assert.deepEqual(emitted[0][2], { kind: 'present', version: 'v42' });
    assert.equal(emitted[0][3], exec, 'actor 必须是本次工具的 exec');

    const un = fakeFsCtx({ version: 'v43' });
    const r2 = await runMarkEdit({ paths: 'a.js', undo: true }, { ctx: un.ctx, exec });
    assert.equal(r2.action, 'undo');
    assert.deepEqual(un.emitted[0][2], STALE_SENTINEL);
  });
});

test('坏路径隔离 / 缺上下文 / 上限截断', async () => {
  await withTempHome(async () => {
    const missing = fakeFsCtx({ kind: 'missing' });
    const r1 = await runMarkEdit({ paths: 'gone.js' }, { ctx: missing.ctx, exec: {} });
    assert.equal(r1.ok, false);
    assert.match(r1.failed[0].error, /不存在/);

    assert.match((await runMarkEdit({ paths: 'a.js' }, {})).error, /缺少宿主上下文/);
    const bare = { emit: () => {}, get: () => undefined };
    assert.match((await runMarkEdit({ paths: 'a.js' }, { ctx: bare })).error, /fs 服务不可用/);

    const many = Array.from({ length: MAX_PATHS + 5 }, (_, i) => `f${i}.js`).join(',');
    const big = fakeFsCtx();
    const r2 = await runMarkEdit({ paths: many }, { ctx: big.ctx, exec: {} });
    assert.equal(r2.marked.length, MAX_PATHS);
    assert.equal(r2.truncated, 5);
  });
});

test('配置写入保留其它键（与 mark_read 等共用同一文件）', async () => {
  await withTempHome(async (home) => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(home, 'useful-tools'), { recursive: true });
    writeFileSync(join(home, 'useful-tools', 'config.json'),
      JSON.stringify({ observeHook: true, observeTools: ['grep'], testEnvRoot: '/x' }), 'utf8');

    await runMarkEdit({ enabled: false, settleMs: 80 }, {});

    const cfg = readConfigOf(home);
    assert.equal(cfg.editHook, false);
    assert.equal(cfg.editSettleMs, 80);
    assert.deepEqual(cfg.observeTools, ['grep'], '不得动 mark_read 的键');
    assert.equal(cfg.testEnvRoot, '/x', '不得丢其它消费方的键');
  });
});

// ── bash 写命令目标解析（mark_edit 兼管 bash 写入）──────────────────────────

test('extractBashWrites：重定向 / tee / sed -i / cp / mv / touch / dd', () => {
  assert.deepEqual(extractBashWrites("printf 'x' > a.txt"), ['a.txt']);
  assert.deepEqual(extractBashWrites('echo hi >> b.txt'), ['b.txt']);
  assert.deepEqual(extractBashWrites('echo hi >c.txt'), ['c.txt'], '紧贴写法');
  assert.deepEqual(extractBashWrites('cat x | tee -a d.txt'), ['d.txt']);
  assert.deepEqual(extractBashWrites("sed -i 's/a/b/' e.txt"), ['e.txt']);
  assert.deepEqual(extractBashWrites('cp src.txt f.txt'), ['f.txt']);
  assert.deepEqual(extractBashWrites('mv f.txt g.txt'), ['g.txt']);
  assert.deepEqual(extractBashWrites('touch h.txt'), ['h.txt']);
  assert.deepEqual(extractBashWrites('dd if=/dev/zero of=i.txt bs=1 count=1'), ['i.txt']);
});

test('extractBashWrites：只读命令与 /dev/null 不算写目标', () => {
  assert.deepEqual(extractBashWrites('cat a.txt'), []);
  assert.deepEqual(extractBashWrites('grep -rn x dir'), []);
  assert.deepEqual(extractBashWrites('echo hi > /dev/null'), []);
  assert.deepEqual(extractBashWrites('cmd 2>&1'), []);
  assert.deepEqual(extractBashWrites(''), []);
});
