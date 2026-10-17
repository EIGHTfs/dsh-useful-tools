/**
 * quick_command 单测：定义读写、run 持久化、管理动作、执行与超时、cwd。
 *
 * 隔离方式：每个用例把 DSH_HOME 指向 mkdtemp 出来的临时目录，结束恢复环境并删目录——
 *   不碰真实 <DSH_HOME>/useful-tools，也不在 /tmp 留残留。
 *
 * 跨平台：命令一律用 node -e 而不是 pwd/sleep/ls（那些只有某类 shell 有）；
 *   glob 由 test/run-tests.mjs 扫描，本文件不依赖 shell 展开。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, realpathSync } from 'node:fs';
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

/**
 * 跨平台「打印当前目录」命令：不用 shell 内置（pwd 只有 bash 系有，cmd 要用 cd），
 * 统一走 node，Windows/Linux/macOS 行为一致。
 */
const PRINT_CWD = 'node -e "process.stdout.write(process.cwd())"';

test('list：首次没有文件时返回空表（不带任何内置预置）', async () => {
  await withHome(async (home) => {
    const r = await runQuickCommand({ action: 'list' });
    assert.equal(r.ok, true);
    assert.equal(r.exists, false);
    assert.equal(r.count, 0);
    assert.deepEqual(r.list, []);
    assert.ok(typeof r.note === 'string' && r.note.includes('add'), '空表应提示用 add 添加');
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
    assert.deepEqual(Object.keys(raw), ['hello'], '文件里只应有用户定义，没有预置');

    const list = await runQuickCommand({ action: 'list' });
    assert.equal(list.exists, true);
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

test('delete：移除后文件里不再有该名字', async () => {
  await withHome(async (home) => {
    await runQuickCommand({ action: 'add', name: 'gone', command: 'echo x' });
    const deleted = await runQuickCommand({ action: 'delete', name: 'gone' });
    assert.equal(deleted.ok, true);
    assert.deepEqual(deleted.remaining, []);
    const raw = JSON.parse(readFileSync(storeFile(home), 'utf8'));
    assert.equal(raw.gone, undefined);
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

test('run：未知名字报错并给出空的可选名字', async () => {
  await withHome(async () => {
    const r = await runQuickCommand({ action: 'run', name: 'nope' });
    assert.equal(r.ok, false);
    assert.deepEqual(r.names, [], '空表时可选名字应为空数组');
    assert.match(r.error, /未定义快捷命令/);
  });
});

test('run：超时会被终止并标记 timedOut', async () => {
  await withHome(async () => {
    // 阻塞命令必须避免 `>`（cmd 会当输出重定向把命令截断），所以用 function 形态而不是箭头函数
    await runQuickCommand({ action: 'add', name: 'slow', command: 'node -e "setTimeout(function(){},5000)"' });
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

test('cwd：add 带目录，run 时在该目录执行', async () => {
  await withHome(async (home) => {
    const dir = join(home, 'workdir');
    mkdirSync(dir, { recursive: true });
    const added = await runQuickCommand({ action: 'add', name: 'pwdin', command: PRINT_CWD, cwd: dir });
    assert.equal(added.ok, true);
    assert.equal(added.cwd, dir, 'cwd 应解析成绝对路径');
    const r = await runQuickCommand({ action: 'run', name: 'pwdin' });
    assert.equal(r.ok, true);
    // 用 realpath 比较：os.tmpdir() 是逻辑路径（/var/packages/.../tmp），
    //   而命令里的 getcwd 输出物理路径（/volume1/@apptemp/...），同一目录两种视图
    assert.equal(realpathSync(r.stdout.trim()), realpathSync(dir));
    assert.equal(r.cwd, dir);
  });
});

test('cwd：run 单独传 cwd 只对本次生效，不改定义', async () => {
  await withHome(async (home) => {
    const dir = join(home, 'other');
    mkdirSync(dir, { recursive: true });
    await runQuickCommand({ action: 'add', name: 'plain', command: PRINT_CWD });
    const r = await runQuickCommand({ action: 'run', name: 'plain', cwd: dir });
    assert.equal(realpathSync(r.stdout.trim()), realpathSync(dir), '本次执行应在传入目录');
    assert.equal(r.persisted, false);
    const raw = JSON.parse(readFileSync(storeFile(home), 'utf8'));
    assert.equal(raw.plain.cwd, undefined, '临时 cwd 不应写进定义');
  });
});

test('cwd：不存在的目录被拒（add 与 run 都校验）', async () => {
  await withHome(async (home) => {
    const missing = join(home, 'nope-dir');
    const added = await runQuickCommand({ action: 'add', name: 'badcwd', command: PRINT_CWD, cwd: missing });
    assert.equal(added.ok, false);
    assert.match(added.error, /cwd 不存在/);

    await runQuickCommand({ action: 'add', name: 'ok', command: PRINT_CWD });
    const run = await runQuickCommand({ action: 'run', name: 'ok', cwd: missing });
    assert.equal(run.ok, false);
    assert.match(run.error, /cwd 不存在/);
  });
});

test('cwd：edit 可改执行目录', async () => {
  await withHome(async (home) => {
    const a = join(home, 'a');
    const b = join(home, 'b');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    await runQuickCommand({ action: 'add', name: 'move', command: PRINT_CWD, cwd: a });
    const edited = await runQuickCommand({ action: 'edit', name: 'move', cwd: b });
    assert.equal(edited.ok, true);
    assert.equal(edited.cwd, b);
    const r = await runQuickCommand({ action: 'run', name: 'move' });
    assert.equal(realpathSync(r.stdout.trim()), realpathSync(b));
  });
});
