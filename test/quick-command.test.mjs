/**
 * quick_command 单测：定义读写、run 持久化、管理动作、执行与超时。
 *
 * 隔离方式：每个用例把 DSH_HOME 指向 mkdtemp 出来的临时目录，结束恢复环境并删目录——
 *   不碰真实 <DSH_HOME>/useful-tools，也不在 /tmp 留残留。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run as runQuickCommand } from '../lib/shared/quick_command/index.js';

/** 在临时 DSH_HOME 里跑一个用例，结束后恢复环境变量并清理目录。 */
async function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'quick-command-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

/** 定义文件路径（与实现同源：<DSH_HOME>/useful-tools/quick-commands.json）。 */
function storeFile(home) {
  return join(home, 'useful-tools', 'quick-commands.json');
}

test('list：首次没有文件时返回预置 restart，并标记 preset', async () => {
  await withHome(async (home) => {
    const r = await runQuickCommand({ action: 'list' });
    assert.equal(r.ok, true);
    assert.equal(r.preset, true);
    assert.ok(r.items.restart, '应带预置 restart');
    assert.ok(r.items.restart.command.includes('start.sh'), '预置命令应指向 start.sh');
    assert.ok(Array.isArray(r.list), 'list 应给出名字+命令的数组形态');
    assert.equal(r.list[0].name, 'restart');
    assert.ok(r.list[0].command.includes('start.sh'));
    assert.equal(existsSync(storeFile(home)), false, 'list 不应写盘');
  });
});

test('add：写盘且能 list 到；重名报错', async () => {
  await withHome(async (home) => {
    const added = await runQuickCommand({ action: 'add', name: 'hello', command: 'echo hi', description: '打招呼' });
    assert.equal(added.ok, true);
    assert.ok(existsSync(storeFile(home)));

    const raw = JSON.parse(readFileSync(storeFile(home), 'utf8'));
    assert.deepEqual(raw.hello, { command: 'echo hi', description: '打招呼' });
    assert.ok(raw.restart, '首次写盘应把预置一并保留');

    const list = await runQuickCommand({ action: 'list' });
    assert.equal(list.preset, false);
    assert.ok(list.items.hello);

    const dup = await runQuickCommand({ action: 'add', name: 'hello', command: 'echo again' });
    assert.equal(dup.ok, false);
    assert.match(dup.error, /已存在/);
  });
});

test('edit：只改命令时保留原说明', async () => {
  await withHome(async (home) => {
    await runQuickCommand({ action: 'add', name: 'hi', command: 'echo v1', description: '原说明' });
    const edited = await runQuickCommand({ action: 'edit', name: 'hi', command: 'echo v2' });
    assert.equal(edited.ok, true);
    assert.equal(edited.command, 'echo v2');
    assert.equal(edited.description, '原说明');
    const raw = JSON.parse(readFileSync(storeFile(home), 'utf8'));
    assert.equal(raw.hi.command, 'echo v2');
  });
});

test('delete：移除后不会把预置写回', async () => {
  await withHome(async (home) => {
    const deleted = await runQuickCommand({ action: 'delete', name: 'restart' });
    assert.equal(deleted.ok, true);
    const raw = JSON.parse(readFileSync(storeFile(home), 'utf8'));
    assert.equal(raw.restart, undefined, 'delete 后不应被写回');
    const list = await runQuickCommand({ action: 'list' });
    assert.equal(list.items.restart, undefined);
  });
});

test('run：按 name 执行并回传 stdout', async () => {
  await withHome(async () => {
    await runQuickCommand({ action: 'add', name: 'say', command: 'echo hello-run' });
    const r = await runQuickCommand({ action: 'run', name: 'say' });
    assert.equal(r.ok, true);
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /hello-run/);
    assert.equal(r.persisted, false);
  });
});

test('run 带 command：先持久化（新增/更新）再执行', async () => {
  await withHome(async (home) => {
    const first = await runQuickCommand({ action: 'run', name: 'greet', command: 'echo first' });
    assert.equal(first.ok, true);
    assert.equal(first.persisted, true);
    assert.match(first.stdout, /first/);
    assert.ok(existsSync(storeFile(home)));
    assert.equal(JSON.parse(readFileSync(storeFile(home), 'utf8')).greet.command, 'echo first');

    // 同名再 run 一次带新命令：应更新并执行新命令
    const second = await runQuickCommand({ action: 'run', name: 'greet', command: 'echo second' });
    assert.match(second.stdout, /second/);
    assert.equal(JSON.parse(readFileSync(storeFile(home), 'utf8')).greet.command, 'echo second');
  });
});

test('run：只传 command 没有 name 时报错（命令必须能落盘）', async () => {
  await withHome(async () => {
    const r = await runQuickCommand({ action: 'run', command: 'echo x' });
    assert.equal(r.ok, false);
    assert.match(r.error, /name/);
  });
});

test('run：未知名字报错并给出可选名字', async () => {
  await withHome(async () => {
    const r = await runQuickCommand({ action: 'run', name: 'nope' });
    assert.equal(r.ok, false);
    assert.ok(Array.isArray(r.names));
    assert.ok(r.names.includes('restart'));
  });
});

test('run：超时会被终止并标记 timedOut', async () => {
  await withHome(async () => {
    await runQuickCommand({ action: 'add', name: 'slow', command: 'sleep 5' });
    const r = await runQuickCommand({ action: 'run', name: 'slow', timeoutMs: 1000 });
    assert.equal(r.ok, false);
    assert.equal(r.timedOut, true);
  });
});

test('非法快捷名被拒（不写进 JSON）', async () => {
  await withHome(async () => {
    const r = await runQuickCommand({ action: 'add', name: 'bad name', command: 'echo x' });
    assert.equal(r.ok, false);
    assert.match(r.error, /不合法/);
  });
});
