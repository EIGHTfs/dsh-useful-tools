/**
 * 同步不得破坏可执行位（回归）
 *
 * 缺陷背景：CIFS 上 copyFileCompat 走 readFile+writeFile 回退，新建文件只拿到 umask 默认值
 * （通常 644），源侧的 +x 就此丢失；随后 alignPermissions 按「目标当前 mode」推断，
 * 看到 644 就固化 644 —— 可执行位永久丢失。下游表现是「文件存在但不可执行」，功能静默失效。
 *
 * 三条断言分别锁住修复的三个面：
 *   ① 源可执行 → 同步后目标可执行（复制阶段保 mode）
 *   ② 部署侧独有文件（源里没有，如被 git 忽略的二进制）→ 同步后 mode 不变（对齐阶段不越权）
 *   ③ 源普通文件 → 目标 644（不误加可执行位）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { syncPlugin } from '../lib/core/sync-plugin/sync-plugin.mjs';
import { alignPermissions } from '../lib/core/sync-plugin/permissions.mjs';

/** 造一个临时目录。 */
function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

/** 取文件权限里低 9 位（rwxrwxrwx）。 */
function modeOf(path) {
  return statSync(path).mode & 0o777;
}

test('源里的可执行文件，同步后仍是可执行（复制阶段保住 mode）', async () => {
  const work = tempDir('perms-exec');
  try {
    const source = join(work, 'src');
    const target = join(work, 'dst');
    mkdirSync(join(source, 'tools'), { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'demo', version: '1', files: ['tools', 'package.json'] }));
    writeFileSync(join(source, 'tools', 'runner'), '#!/bin/sh\necho ok\n');
    chmodSync(join(source, 'tools', 'runner'), 0o755);

    const result = await syncPlugin({ source, target, write: true });
    assert.equal(result.ok, true);
    assert.equal(modeOf(join(target, 'tools', 'runner')) & 0o111, 0o111, '可执行位必须保留');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('部署侧独有文件（源里没有）的权限不被同步改动', async () => {
  const work = tempDir('perms-external');
  try {
    const source = join(work, 'src');
    const target = join(work, 'dst');
    mkdirSync(join(source, 'lib'), { recursive: true });
    mkdirSync(join(target, 'tools'), { recursive: true });
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'demo', version: '1', files: ['lib', 'package.json'] }));
    writeFileSync(join(source, 'lib', 'a.js'), 'export const a = 1;\n');
    // 部署侧提供的二进制：源码里没有（被 git 忽略），权限由部署方决定
    writeFileSync(join(target, 'tools', 'external-bin'), '#!/bin/sh\necho external\n');
    chmodSync(join(target, 'tools', 'external-bin'), 0o755);

    const result = await syncPlugin({ source, target, write: true });
    assert.equal(result.ok, true);
    assert.equal(modeOf(join(target, 'tools', 'external-bin')) & 0o111, 0o111, '部署侧二进制的可执行位不能被抹');
    assert.equal(result.permissions.preservedExternal, 1, '应如实计数为「部署侧独有、未改权限」');
    assert.match(result.permissions.notes.join(' '), /部署侧独有文件/, '回执里要说明这类文件没被改');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('源普通文件同步后是 644，不误加可执行位', async () => {
  const work = tempDir('perms-plain');
  try {
    const source = join(work, 'src');
    const target = join(work, 'dst');
    mkdirSync(source, { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'demo', version: '1', files: ['index.js', 'package.json'] }));
    writeFileSync(join(source, 'index.js'), 'export const x = 1;\n');

    await syncPlugin({ source, target, write: true });
    assert.equal(modeOf(join(target, 'index.js')), 0o644, '普通文件保持 644');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('alignPermissions：给了 sourceRoot 才按源判定，源缺失则跳过 chmod', async () => {
  const work = tempDir('perms-align');
  try {
    const source = join(work, 'src');
    const target = join(work, 'dst');
    mkdirSync(source, { recursive: true });
    mkdirSync(join(target, 'tools'), { recursive: true });
    writeFileSync(join(source, 'package.json'), '{}');
    writeFileSync(join(target, 'tools', 'only-in-target'), 'bin\n');
    chmodSync(join(target, 'tools', 'only-in-target'), 0o755);

    const result = alignPermissions({ target, sourceRoot: source });
    assert.equal(result.preservedExternal >= 1, true);
    assert.equal(modeOf(join(target, 'tools', 'only-in-target')) & 0o111, 0o111);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('syncPlugin 的 dryRun 不碰任何权限', async () => {
  const work = tempDir('perms-dry');
  try {
    const source = join(work, 'src');
    const target = join(work, 'dst');
    mkdirSync(join(source, 'tools'), { recursive: true });
    mkdirSync(join(target, 'tools'), { recursive: true });
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'demo', version: '1', files: ['tools', 'package.json'] }));
    writeFileSync(join(source, 'tools', 'bin'), 'x\n');
    chmodSync(join(source, 'tools', 'bin'), 0o755);
    writeFileSync(join(target, 'tools', 'keep'), 'k\n');
    chmodSync(join(target, 'tools', 'keep'), 0o700);

    const before = modeOf(join(target, 'tools', 'keep'));
    const result = await syncPlugin({ source, target, write: false });
    assert.equal(result.written >= 1, true, 'dryRun 照样报出会写哪些');
    assert.equal(modeOf(join(target, 'tools', 'keep')), before, 'dryRun 不得改权限');
    assert.equal(existsSync(join(target, 'tools', 'bin')), false, 'dryRun 不得落盘');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
