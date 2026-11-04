/**
 * github_download 回归
 *
 * 覆盖四层：
 *   ① URL 识别（release / raw / archive 分类、非 GitHub 域拒绝、文件名提取）
 *   ② 镜像前缀拼接
 *   ③ 下载全链路（流式落盘、字节统计、sha256 校验、失败删半截文件）
 *   ④ 通道编排（dryRun 报告、全通道失败结构、失败学习回写候选清单）
 *
 * 全部离线：用本地 http server 扮演镜像，不访问真实 GitHub——CI 环境未必能连外网，
 * 而且真实镜像会挂，把测试绑在它们身上等于给自己制造随机失败。
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildMirrorUrl, classifyGithubUrl, directHint, fileNameFromUrl } from '../lib/core/github-download/channels.js';
import { runGithubDownload } from '../lib/core/github-download/index.js';
import { readCandidates, writeCandidates } from '../lib/core/github-mirror/store.js';

/** 每个用例把候选清单指到临时文件，避免运行期回写污染随仓库入库的 candidates.json。 */
let candidatesTmp = null;
let workDir = null;

beforeEach(() => {
  candidatesTmp = mkdtempSync(join(tmpdir(), 'ghdl-cand-'));
  workDir = mkdtempSync(join(tmpdir(), 'ghdl-work-'));
  process.env.DSH_GITHUB_MIRROR_CANDIDATES = join(candidatesTmp, 'candidates.json');
});

afterEach(() => {
  delete process.env.DSH_GITHUB_MIRROR_CANDIDATES;
  if (candidatesTmp) rmSync(candidatesTmp, { recursive: true, force: true });
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  candidatesTmp = null;
  workDir = null;
});

/** 起一个返回固定内容的本地 server，扮演镜像站；返回 { base, close }。 */
async function startFakeMirror(payload) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(payload.length) });
    response.end(payload);
  });
  await new Promise((resolveReady) => server.listen(0, '127.0.0.1', resolveReady));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}/`,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

test('classifyGithubUrl：release / raw / archive 三类识别', () => {
  const release = classifyGithubUrl('https://github.com/cli/cli/releases/download/v2.103.3/gh_2.103.3_linux_amd64.tar.gz');
  assert.equal(release.ok, true);
  assert.equal(release.kind, 'release');
  assert.equal(release.fileName, 'gh_2.103.3_linux_amd64.tar.gz');

  const raw = classifyGithubUrl('https://raw.githubusercontent.com/cli/cli/trunk/README.md');
  assert.equal(raw.kind, 'raw');
  assert.equal(raw.fileName, 'README.md');

  const archive = classifyGithubUrl('https://github.com/cli/cli/archive/refs/tags/v2.103.3.tar.gz');
  assert.equal(archive.kind, 'archive');

  const codeload = classifyGithubUrl('https://codeload.github.com/cli/cli/tar.gz/refs/tags/v2.103.3');
  assert.equal(codeload.kind, 'archive');

  // 被拦的 302 落地域也要认，否则用户直接贴落地地址会被拒
  const landing = classifyGithubUrl('https://release-assets.githubusercontent.com/github-production-release-asset/1/2?token=x');
  assert.equal(landing.ok, true);
});

test('classifyGithubUrl：非 GitHub 域与非法地址拒绝', () => {
  assert.equal(classifyGithubUrl('https://example.com/file.zip').ok, false);
  // 后缀伪装必须挡住：github.com.evil.example 不是 GitHub
  assert.equal(classifyGithubUrl('https://github.com.evil.example/file.zip').ok, false);
  assert.equal(classifyGithubUrl('').ok, false);
  assert.equal(classifyGithubUrl('not-a-url').ok, false);
  assert.equal(classifyGithubUrl('ftp://github.com/a/b').ok, false);
});

test('fileNameFromUrl：解码百分号转义、忽略查询串', () => {
  assert.equal(fileNameFromUrl('https://github.com/a/b/releases/download/v1/my%20file.zip'), 'my file.zip');
  assert.equal(fileNameFromUrl('https://raw.githubusercontent.com/a/b/main/x.txt?token=1'), 'x.txt');
});

test('buildMirrorUrl：拼接前缀并补结尾斜杠', () => {
  const original = 'https://github.com/a/b/releases/download/v1/c.zip';
  assert.equal(buildMirrorUrl('https://ghfast.top/', original), `https://ghfast.top/${original}`);
  assert.equal(buildMirrorUrl('https://ghfast.top', original), `https://ghfast.top/${original}`);
  assert.equal(buildMirrorUrl('', original), '');
});

test('directHint：三类资源都给得出提示', () => {
  assert.match(directHint('release'), /release-assets/);
  assert.match(directHint('raw'), /直连/);
  assert.match(directHint('archive'), /直连/);
});

test('下载成功：流式落盘、字节统计、sha256 正确', async () => {
  const payload = Buffer.from('github-download-fixture\n'.repeat(200));
  const mirror = await startFakeMirror(payload);
  try {
    const savePath = join(workDir, 'fixture.bin');
    const result = await runGithubDownload({
      url: 'https://github.com/cli/cli/releases/download/v1.0.0/fixture.bin',
      channel: 'mirror',
      mirror: mirror.base,
      savePath,
    });

    assert.equal(result.ok, true);
    assert.equal(result.channel, 'mirror');
    assert.equal(result.kind, 'release');
    assert.equal(result.bytes, payload.length);
    assert.equal(result.sizeText.endsWith('KB'), true);
    assert.equal(result.sha256, createHash('sha256').update(payload).digest('hex'));
    assert.equal(readFileSync(savePath).length, payload.length);
  } finally {
    await mirror.close();
  }
});

test('sha256 不匹配：判失败且删除文件', async () => {
  const payload = Buffer.from('tampered');
  const mirror = await startFakeMirror(payload);
  try {
    const savePath = join(workDir, 'tampered.bin');
    const result = await runGithubDownload({
      url: 'https://github.com/a/b/releases/download/v1/tampered.bin',
      channel: 'mirror',
      mirror: mirror.base,
      savePath,
      sha256: '0'.repeat(64),
    });

    assert.equal(result.ok, false);
    assert.match(result.attempts.at(-1).error, /sha256 不匹配/);
    // 半截/校验失败的文件必须删掉，否则后续步骤会误判成下载成功
    assert.equal(existsSync(savePath), false);
  } finally {
    await mirror.close();
  }
});

test('全通道失败：返回结构化 attempts，不抛异常', async () => {
  const savePath = join(workDir, 'nope.bin');
  // 127.0.0.1:1 必然拒绝连接，用来制造快速失败
  const result = await runGithubDownload({
    url: 'https://github.com/a/b/releases/download/v1/nope.bin',
    channel: 'mirror',
    mirror: 'http://127.0.0.1:1/',
    savePath,
    timeoutMs: 3000,
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /所有通道都失败/);
  assert.equal(Array.isArray(result.attempts), true);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].channel, 'mirror');
  assert.equal(result.attempts[0].ok, false);
  assert.equal(existsSync(savePath), false);
});

test('dryRun：只探通道不落盘，给出推荐', async () => {
  const payload = Buffer.from('probe-only');
  const mirror = await startFakeMirror(payload);
  try {
    const result = await runGithubDownload({
      url: 'https://github.com/a/b/releases/download/v1/probe.bin',
      channel: 'mirror',
      mirror: mirror.base,
      dryRun: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.direct, null);
    assert.equal(result.mirrors.length, 1);
    assert.equal(result.mirrors[0].ok, true);
    assert.equal(result.recommended, mirror.base);
    // dryRun 绝不能写盘
    assert.equal(existsSync(join(process.cwd(), 'probe.bin')), false);
  } finally {
    await mirror.close();
  }
});

test('失败学习：清单镜像失败后 failures 累加', async () => {
  const deadMirror = 'http://127.0.0.1:1/';
  writeCandidates([{ mirror: deadMirror, hosts: ['github.com'], disabled: false, failures: 0 }]);

  const result = await runGithubDownload({
    url: 'https://github.com/a/b/releases/download/v1/x.bin',
    channel: 'mirror',
    savePath: join(workDir, 'x.bin'),
    timeoutMs: 3000,
  });

  assert.equal(result.ok, false);
  const list = readCandidates();
  assert.equal(list.length, 1);
  assert.equal(list[0].failures, 1);
  assert.equal(list[0].disabled, false);
});

test('参数校验：缺 url / 非 GitHub 域 / 推不出文件名', async () => {
  const noUrl = await runGithubDownload({});
  assert.equal(noUrl.ok, false);
  assert.match(noUrl.error, /url 不能为空/);

  const foreign = await runGithubDownload({ url: 'https://example.com/a.zip' });
  assert.equal(foreign.ok, false);
  assert.match(foreign.error, /不是 GitHub 下载域/);

  // 路径末段为空 → 推不出文件名，且没给 savePath
  const noName = await runGithubDownload({ url: 'https://github.com/' });
  assert.equal(noName.ok, false);
  assert.match(noName.error, /savePath/);
});

test('非法 channel 回落 auto，不因参数写错整体失败', async () => {
  const result = await runGithubDownload({
    url: 'https://github.com/a/b/releases/download/v1/y.bin',
    channel: 'not-a-mode',
    mirror: 'http://127.0.0.1:1/',
    savePath: join(workDir, 'y.bin'),
    // 压小超时：回落 auto 会先探直连，这里只验证「不抛异常、结构完整」，
    // 不该为此等满默认探测超时
    timeoutMs: 300,
  });
  // 回落到 auto 后仍会尝试通道，最终失败但结构完整（不是参数错误）
  assert.equal(result.ok, false);
  assert.match(result.error, /所有通道都失败/);
});
