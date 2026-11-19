/**
 * github_download 断点续传 · 端到端（本地 http server，不碰真实网络）
 *
 * 续传的四条关键分支只能在「服务端真的按 Range 回应」时才走得通，所以这里起一个
 * 可控的本地 server 分别模拟：支持 Range（206）、忽略 Range（200）、Content-Range 起点不符、
 * 以及 sha256 不匹配。用户最容易被坑的两种情形是：
 *   · 服务端忽略 Range 却把整包 append 到半截文件后 —— 文件翻倍且看着「成功」；
 *   · 远端文件已变但只验长度 —— 拼出大小正确、内容全错的坏文件。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadToPart, downloadWithResume } from '../lib/core/github-download/index.js';
import { readResumeMeta, resumeBytes, resumePaths, writeResumeMeta } from '../lib/core/github-download/resume-state.js';

const PAYLOAD = Buffer.concat([Buffer.from('A'.repeat(5000)), Buffer.from('B'.repeat(5000))]); // 10000 字节
const PAYLOAD_SHA = createHash('sha256').update(PAYLOAD).digest('hex');

/** 起一个可控 server；`ignoreRange` 模拟「镜像那种不透传 Range」的服务端。 */
async function startServer({ ignoreRange = false, badContentRange = false } = {}) {
  const server = createServer((req, res) => {
    const etag = '"v1"';
    const rangeHeader = req.headers.range;
    const matched = /^bytes=(\d+)-$/.exec(String(rangeHeader || ''));
    if (matched && !ignoreRange) {
      const start = Number(matched[1]);
      const slice = PAYLOAD.subarray(start);
      const startReported = badContentRange ? start + 1 : start;
      res.writeHead(206, {
        'content-range': `bytes ${startReported}-${PAYLOAD.length - 1}/${PAYLOAD.length}`,
        'content-length': String(slice.length),
        etag,
        'accept-ranges': 'bytes',
      });
      res.end(slice);
      return;
    }
    res.writeHead(200, { 'content-length': String(PAYLOAD.length), etag, 'accept-ranges': ignoreRange ? 'none' : 'bytes' });
    res.end(PAYLOAD);
  });
  await new Promise((resolveStart) => server.listen(0, '127.0.0.1', resolveStart));
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}/file`, close: () => new Promise((r) => server.close(r)) };
}

const makeDir = () => mkdtempSync(join(tmpdir(), 'dshgp-e2e-'));

test('downloadToPart：首次下载落到 .part 再 rename，产物与 sha256 都正确', async () => {
  const { url, close } = await startServer();
  const dir = makeDir();
  const savePath = join(dir, 'out.bin');
  try {
    const result = await downloadToPart(url, { savePath, timeoutMs: 10000, expectedSha256: PAYLOAD_SHA });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.bytes, PAYLOAD.length);
    assert.equal(readFileSync(savePath).equals(PAYLOAD), true, '产物内容必须与源一致');
    assert.equal(existsSync(resumePaths(savePath).partPath), false, '成功后不应留下分片');
  } finally { await close(); }
});

test('downloadWithResume：已有 4000 字节分片时发 Range 拿 206，拼出完整文件', async () => {
  const { url, close } = await startServer();
  const dir = makeDir();
  const savePath = join(dir, 'out.bin');
  const { partPath } = resumePaths(savePath);
  writeFileSync(partPath, PAYLOAD.subarray(0, 4000));
  writeResumeMeta(savePath, { etag: '"v1"', totalBytes: PAYLOAD.length, savedBytes: 4000, url });
  try {
    const result = await downloadWithResume(url, { savePath, timeoutMs: 10000, expectedSha256: PAYLOAD_SHA });
    assert.ok(result && !result.fallbackToFull, '应走续传而不是回落整下');
    assert.equal(result.ok, true, result.error);
    assert.equal(result.resumedFrom, 4000, '应报告从 4000 字节处续传');
    assert.equal(result.bytes, PAYLOAD.length, '续传后总长应等于远端长度');
    assert.equal(readFileSync(savePath).equals(PAYLOAD), true, '拼接结果必须逐字节正确');
    assert.equal(existsSync(partPath), false, '完成后分片应被 rename 走');
  } finally { await close(); }
});

test('服务端忽略 Range（回 200）：判定不可续、清分片，交给调用方整下', async () => {
  const { url, close } = await startServer({ ignoreRange: true });
  const dir = makeDir();
  const savePath = join(dir, 'out.bin');
  const { partPath } = resumePaths(savePath);
  writeFileSync(partPath, PAYLOAD.subarray(0, 4000));
  writeResumeMeta(savePath, { etag: '"v1"', totalBytes: PAYLOAD.length, savedBytes: 4000, url });
  try {
    const result = await downloadWithResume(url, { savePath, timeoutMs: 10000 });
    assert.equal(result.fallbackToFull, true, '回 200 时必须判不可续');
    assert.match(result.reason, /200/);
    assert.equal(resumeBytes(savePath), 0, '分片必须被清掉，否则下次会把整包接在半截后面');
  } finally { await close(); }
});

test('Content-Range 起点与本地分片不符：判不可续并清分片（防拼错位置）', async () => {
  const { url, close } = await startServer({ badContentRange: true });
  const dir = makeDir();
  const savePath = join(dir, 'out.bin');
  const { partPath } = resumePaths(savePath);
  writeFileSync(partPath, PAYLOAD.subarray(0, 4000));
  writeResumeMeta(savePath, { etag: '"v1"', totalBytes: PAYLOAD.length, savedBytes: 4000, url });
  try {
    const result = await downloadWithResume(url, { savePath, timeoutMs: 10000 });
    assert.equal(result.fallbackToFull, true);
    assert.match(result.reason, /Content-Range/);
    assert.equal(resumeBytes(savePath), 0);
  } finally { await close(); }
});

test('续传后 sha256 不匹配：判失败并清状态（坏分片不能留着重试）', async () => {
  const { url, close } = await startServer();
  const dir = makeDir();
  const savePath = join(dir, 'out.bin');
  const { partPath } = resumePaths(savePath);
  writeFileSync(partPath, PAYLOAD.subarray(0, 4000));
  writeResumeMeta(savePath, { etag: '"v1"', totalBytes: PAYLOAD.length, savedBytes: 4000, url });
  try {
    const wrongSha = 'f'.repeat(64);
    const result = await downloadWithResume(url, { savePath, timeoutMs: 10000, expectedSha256: wrongSha });
    assert.equal(result.ok, false);
    assert.match(result.error, /sha256 不匹配/);
    assert.equal(existsSync(partPath), false, 'sha 不匹配必须清分片');
    assert.equal(readResumeMeta(savePath), null, '指纹也要清，避免下次用坏分片续');
  } finally { await close(); }
});

test('没有分片时 downloadWithResume 返回 null（调用方应走整下，行为与改动前一致）', async () => {
  const { url, close } = await startServer();
  const dir = makeDir();
  const savePath = join(dir, 'out.bin');
  try {
    const result = await downloadWithResume(url, { savePath, timeoutMs: 10000 });
    assert.equal(result, null, '无分片就该返回 null，不能自己假装下过了');
  } finally { await close(); }
});
