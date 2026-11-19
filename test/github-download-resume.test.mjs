/**
 * github_download 断点续传 · 通道判据与 Range 解析（第一部分）
 *
 * 这两组纯函数决定「要不要发 Range」与「响应能不能拼」——续传出坏文件的两个根源都在这里：
 *   ① 在不支持 Range 的通道（镜像）上发 Range：服务端回 200 整包，若被当成 206 拼接，文件直接翻倍；
 *   ② Content-Range 的起始位置与本地已有字节不相等却照样拼接：差一个字节就是坏文件。
 * 所以先把它们单测钉死，再动下载主路径。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseContentRange, supportsResume } from '../lib/core/github-download/channels.js';
import {
  acquireResumeLock, clearResumeState, isSameRemoteFile, readResumeMeta, resumeBytes, resumePaths, writeResumeMeta,
} from '../lib/core/github-download/resume-state.js';

test('supportsResume：只有「直连 + raw」才尝试续传', () => {
  assert.equal(supportsResume({ channel: 'direct', kind: 'raw' }), true, 'raw 直连实测支持 206');
  assert.equal(supportsResume({ channel: 'mirror', kind: 'raw' }), false, '镜像不透传 Range，带 Range 会回整包');
  assert.equal(supportsResume({ channel: 'direct', kind: 'release' }), false, 'release 走 302 跳到别的域，Range 语义要重新校验，先不做');
  assert.equal(supportsResume({ channel: 'direct', kind: 'archive' }), false, 'codeload 忽略 Range（实测），先不做');
  assert.equal(supportsResume({ channel: 'direct', kind: 'other' }), false);
  assert.equal(supportsResume({}), false, '参数缺失一律保守：不续传');
  assert.equal(supportsResume(), false);
});

test('parseContentRange：正常值解析出 start/end/total', () => {
  const parsed = parseContentRange('bytes 100-999/1000');
  assert.deepEqual(parsed, { start: 100, end: 999, total: 1000 });
});

test('parseContentRange：total 为 * 时表示未知，不能当成 0', () => {
  const parsed = parseContentRange('bytes 0-99/*');
  assert.deepEqual(parsed, { start: 0, end: 99, total: null }, '未知总长必须是 null，否则会拿 0 去比长度判成败');
});

test('parseContentRange：非法输入一律返回 null（按不可信处理）', () => {
  for (const bad of ['', null, undefined, 'bytes', 'bytes 100/200', 'bytes abc-def/200', 'bytes 999-100/1000', 'items 0-9/10']) {
    assert.equal(parseContentRange(bad), null, `${String(bad)} 应判为不可解析`);
  }
});

test('parseContentRange：end < start 视为非法（防止拿坏头去算长度）', () => {
  assert.equal(parseContentRange('bytes 500-100/1000'), null);
});

test('支持的 Range 头格式容错：多余空白', () => {
  assert.deepEqual(parseContentRange('  bytes   0-9/10  '), { start: 0, end: 9, total: 10 });
});

/* ───────── 第二部分：续传状态、指纹、互斥 ───────── */

const makeTemp = () => mkdtempSync(join(tmpdir(), 'dshgp-resume-'));

test('resumeBytes：以分片文件真实大小为准（不存在即 0）', () => {
  const dir = makeTemp();
  const savePath = join(dir, 'a.bin');
  assert.equal(resumeBytes(savePath), 0, '没有分片时应为 0');
  const { partPath } = resumePaths(savePath);
  writeFileSync(partPath, Buffer.alloc(123));
  assert.equal(resumeBytes(savePath), 123, '应按实际写入的字节数返回，而不是 meta 记账值');
});

test('meta 往返：写进去能读回来，字段类型正确', () => {
  const dir = makeTemp();
  const savePath = join(dir, 'b.bin');
  writeResumeMeta(savePath, { etag: '"abc"', totalBytes: 1000, savedBytes: 400, url: 'https://x/y' });
  const meta = readResumeMeta(savePath);
  assert.equal(meta.etag, '"abc"');
  assert.equal(meta.totalBytes, 1000);
  assert.equal(meta.savedBytes, 400);
  assert.equal(meta.url, 'https://x/y');
  assert.ok(meta.updatedAt, '应记录更新时间');
});

test('meta 损坏：读回 null，而不是抛错', () => {
  const dir = makeTemp();
  const savePath = join(dir, 'c.bin');
  writeFileSync(resumePaths(savePath).metaPath, '{ 坏 JSON', 'utf8');
  assert.equal(readResumeMeta(savePath), null);
});

test('isSameRemoteFile：ETag 优先，其次总长；两者都缺 → 判不可信', () => {
  const meta = { etag: '"v1"', totalBytes: 100 };
  assert.equal(isSameRemoteFile(meta, { etag: '"v1"', totalBytes: 100 }), true);
  assert.equal(isSameRemoteFile(meta, { etag: '"v2"', totalBytes: 100 }), false, 'ETag 变了说明远端文件变了');
  assert.equal(isSameRemoteFile({ etag: '', totalBytes: 100 }, { etag: '', totalBytes: 100 }), true, '无 ETag 时用总长比');
  assert.equal(isSameRemoteFile({ etag: '', totalBytes: 100 }, { etag: '', totalBytes: 200 }), false);
  assert.equal(isSameRemoteFile({ etag: '', totalBytes: null }, { etag: '', totalBytes: null }), false,
    '两个可选项都拿不到时不能乐观续传，否则「远端已变」这条唯一可识别的情形会被放过');
  assert.equal(isSameRemoteFile(null, { etag: 'x', totalBytes: 1 }), false);
});

test('clearResumeState：分片、指纹、锁一并清掉', () => {
  const dir = makeTemp();
  const savePath = join(dir, 'd.bin');
  const { partPath, metaPath, lockPath } = resumePaths(savePath);
  writeFileSync(partPath, 'x');
  writeFileSync(metaPath, '{}');
  writeFileSync(lockPath, '{}');
  clearResumeState(savePath);
  assert.equal(existsSync(partPath), false);
  assert.equal(existsSync(metaPath), false);
  assert.equal(existsSync(lockPath), false);
});

test('acquireResumeLock：同路径第二次被拒，release 后可再拿', () => {
  const dir = makeTemp();
  const savePath = join(dir, 'e.bin');
  const first = acquireResumeLock(savePath);
  assert.equal(first.ok, true);
  const second = acquireResumeLock(savePath);
  assert.equal(second.ok, false, '同一路径并发下载必须被拒，否则两边交替 append 会交叉损坏');
  assert.match(second.error, /在进行/);
  first.release();
  const third = acquireResumeLock(savePath);
  assert.equal(third.ok, true, '释放后应能重新获取');
  third.release();
});

test('acquireResumeLock：崩溃残留的死锁能被接管', () => {
  const dir = makeTemp();
  const savePath = join(dir, 'f.bin');
  const { lockPath } = resumePaths(savePath);
  mkdirSync(dirname(lockPath), { recursive: true });
  // 用一个几乎不可能存在的 pid 模拟「上次进程崩溃留下的锁」
  writeFileSync(lockPath, JSON.stringify({ pid: 999999, at: new Date().toISOString() }), 'utf8');
  const got = acquireResumeLock(savePath);
  assert.equal(got.ok, true, '持锁进程已死时应接管，而不是让文件永久卡住');
  got.release();
});

