/**
 * github_download 的后台 job 化（回归）
 *
 * 覆盖：
 *   ① spec 结构与 label（宿主 jobs.start 要求 kind / label 非空，run 返回 { cancel, done }）
 *   ② done 的成败映射（status 决定 job 最终状态）
 *   ③ cancel 能真的把中止信号传到下载用的 AbortSignal
 *   ④ startHostJob 的三条路径：带 owner 成功 / owner 失败退无主 / 两步都失败带原因
 *   ⑤ runGithubDownload 的分流：默认后台、background:false 同步、jobs 缺失降级同步、dryRun 不走 job
 *
 * 全部离线：不碰真实网络（需要失败时把 fetch 打成必抛），不依赖宿主 jobs 服务。
 */
import { test, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildDownloadJobSpec, startHostJob, DOWNLOAD_JOB_KIND } from '../lib/core/github-download/job.js';
import { runGithubDownload } from '../lib/core/github-download/index.js';

/**
 * 每个用例把候选清单指到临时空清单。
 * 为什么必须：镜像下载失败会触发失败学习（recordProbe + writeCandidates 回写真实清单），
 * 本文件的用例故意让 fetch 必失败，不隔离就会把随仓库入库的候选全打成 disabled——
 * 实测踩过：三个镜像被写成 failures:3 / disabled:true，下载直接不可用。
 */
let candidatesEnvDir = null;
beforeEach(() => {
  candidatesEnvDir = mkdtempSync(join(tmpdir(), 'ghdl-job-cand-'));
  const file = join(candidatesEnvDir, 'candidates.json');
  writeFileSync(file, JSON.stringify({ version: 1, candidates: [] }));
  process.env.DSH_GITHUB_MIRROR_CANDIDATES = file;
});
afterEach(() => {
  delete process.env.DSH_GITHUB_MIRROR_CANDIDATES;
  if (candidatesEnvDir) rmSync(candidatesEnvDir, { recursive: true, force: true });
  candidatesEnvDir = null;
});

/** 造一个假的 job handle，记录 append / updateProgress 的调用。 */
function fakeHandle() {
  const notes = [];
  const progress = [];
  return {
    notes,
    progress,
    append: (text) => notes.push(text),
    updateProgress: (line) => progress.push(line),
  };
}

/** 造一个假的 jobs 服务：start 返回固定 id。 */
function fakeJobs({ id = 'github-download-test0001', onStart } = {}) {
  return {
    started: [],
    start(spec) {
      this.started.push(spec);
      if (typeof onStart === 'function') return onStart(spec);
      return id;
    },
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('buildDownloadJobSpec：kind / label / run 结构符合宿主契约', () => {
  const spec = buildDownloadJobSpec(
    { url: 'https://github.com/o/r/releases/download/v1/a.bin', fileName: 'a.bin', savePath: join(tmpdir(), 'a.bin') },
    async () => ({ ok: true }),
  );
  assert.equal(spec.kind, DOWNLOAD_JOB_KIND);
  assert.equal(spec.label.length > 0, true, 'label 不能为空，宿主会拒绝');
  assert.match(spec.label, /a\.bin/);
  assert.equal(typeof spec.run, 'function');

  const hooks = spec.run(fakeHandle());
  assert.equal(typeof hooks.cancel, 'function', 'run 必须返回 cancel');
  assert.equal(typeof hooks.done?.then, 'function', 'run 必须返回 done promise');
  return hooks.done;
});

test('done：下载成功映射 completed，失败映射 failed 并带 detail', async () => {
  const okSpec = buildDownloadJobSpec({ url: 'u', fileName: 'f', savePath: join(tmpdir(), 'f') }, async () => ({ ok: true, bytes: 10 }));
  const okOutcome = await okSpec.run(fakeHandle()).done;
  // 状态值必须是宿主枚举（running/stopping/completed/killed/failed）：
  //   写成 succeeded 会让 job_output 报 schema 校验失败，实测踩过。
  assert.equal(okOutcome.status, 'completed');

  const badSpec = buildDownloadJobSpec({ url: 'u', fileName: 'f', savePath: join(tmpdir(), 'f') }, async () => ({ ok: false, error: '通道全挂' }));
  const failed = await badSpec.run(fakeHandle()).done;
  assert.equal(failed.status, 'failed');
  assert.match(failed.detail, /通道全挂/);

  // 抛出异常也要收敛成 failed，不能让 done 被 reject（宿主会记一条契约违规）
  const throwSpec = buildDownloadJobSpec({ url: 'u', fileName: 'f', savePath: join(tmpdir(), 'f') }, async () => { throw new Error('炸了'); });
  const thrown = await throwSpec.run(fakeHandle()).done;
  assert.equal(thrown.status, 'failed');
  assert.match(thrown.detail, /炸了/);
});

test('done：取消映射 killed，与「网络失败」区分开', async () => {
  const spec = buildDownloadJobSpec({ url: 'u', fileName: 'f', savePath: join(tmpdir(), 'f') }, async () => ({ ok: false, cancelled: true }));
  const outcome = await spec.run(fakeHandle()).done;
  assert.equal(outcome.status, 'killed', '取消要报 killed，不能和 failed 混在一起');
  assert.match(outcome.detail, /取消/);
});

test('cancel：中止后 done 返回 killed，且不当作「通道全失败」', async () => {
  const spec = buildDownloadJobSpec({ url: 'u', fileName: 'f', savePath: join(tmpdir(), 'f') }, (signal) => {
    return new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ ok: false, cancelled: true, error: '已取消（用户中止下载）' }), { once: true });
    });
  });
  const hooks = spec.run(fakeHandle());
  hooks.cancel();
  const outcome = await hooks.done;
  assert.equal(outcome.status, 'killed');
  assert.doesNotMatch(String(outcome.detail), /所有通道/, '不能把取消说成通道全挂');
});

test('done 的 status 只能取宿主认可的枚举值', async () => {
  const allowed = new Set(['running', 'stopping', 'completed', 'killed', 'failed']);
  const cases = [
    async () => ({ ok: true }),
    async () => ({ ok: false, error: 'x' }),
    async () => ({ ok: false, cancelled: true }),
    async () => { throw new Error('y'); },
  ];
  for (const doDownload of cases) {
    const spec = buildDownloadJobSpec({ url: 'u', fileName: 'f', savePath: join(tmpdir(), 'f') }, doDownload);
    const outcome = await spec.run(fakeHandle()).done;
    assert.equal(allowed.has(outcome.status), true, `非法状态值：${outcome.status}`);
  }
});

test('cancel：中止信号真的传到下载函数', async () => {
  let received = null;
  const spec = buildDownloadJobSpec({ url: 'u', fileName: 'f', savePath: join(tmpdir(), 'f') }, (signal) => {
    received = signal;
    return new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ ok: false, error: 'aborted' }), { once: true });
    });
  });
  const hooks = spec.run(fakeHandle());
  assert.equal(received.aborted, false);
  hooks.cancel();
  assert.equal(received.aborted, true, 'cancel 必须触发 AbortSignal');
  const outcome = await hooks.done;
  assert.equal(outcome.status, 'failed');
});

test('startHostJob：带 owner 成功就用它', () => {
  const jobs = fakeJobs();
  const started = startHostJob(jobs, { kind: 'k', label: 'l' }, 'session-abc');
  assert.equal(started.jobId, 'github-download-test0001');
  assert.equal(jobs.started[0].owner, 'session-abc');
});

test('startHostJob：owner 抛错时退无主注册', () => {
  const jobs = fakeJobs({
    onStart: (spec) => {
      if (spec.owner) throw new Error('session "x" has no live agent');
      return 'unowned-job';
    },
  });
  const started = startHostJob(jobs, { kind: 'k', label: 'l' }, 'x');
  assert.equal(started.jobId, 'unowned-job');
});

test('startHostJob：两条路径都失败时返回原因，不抛', () => {
  const jobs = { start: () => { throw new Error('no job controller serves this agent'); } };
  const started = startHostJob(jobs, { kind: 'k', label: 'l' }, 'x');
  assert.equal(started.jobId, undefined);
  assert.match(started.error, /owner=/, '要带上 owner 那条的失败原因');
  assert.match(started.error, /unowned/, '也要带无主那条的失败原因');
});

test('runGithubDownload：默认注册后台 job，立即返回 jobId 不等待下载', async () => {
  const jobs = fakeJobs();
  const out = await runGithubDownload(
    { url: 'https://github.com/o/r/releases/download/v1/a.bin', savePath: join(tmpdir(), 'a.bin') },
    { jobs, owner: 'session-abc' },
  );
  assert.equal(out.ok, true);
  assert.equal(out.async, true);
  assert.equal(typeof out.jobId, 'string');
  assert.match(out.hint, /job_output/);
  assert.equal(jobs.started.length, 1, '应当注册了一次 job');
  assert.equal(jobs.started[0].kind, DOWNLOAD_JOB_KIND);
});

test('runGithubDownload：background:false 走同步，不注册 job', async () => {
  const jobs = fakeJobs();
  globalThis.fetch = async () => { throw new Error('offline-test'); };
  const out = await runGithubDownload(
    { url: 'https://github.com/o/r/releases/download/v1/a.bin', savePath: join(tmpdir(), 'a.bin'), background: false, timeoutMs: 50 },
    { jobs },
  );
  assert.equal(jobs.started.length, 0, '同步模式不该注册 job');
  assert.equal(out.ok, false);
  assert.equal(out.async, false, '显式同步也要标注 async:false');
});

test('runGithubDownload：jobs 缺失时降级同步并带回原因', async () => {
  globalThis.fetch = async () => { throw new Error('offline-test'); };
  const out = await runGithubDownload(
    { url: 'https://github.com/o/r/releases/download/v1/a.bin', savePath: join(tmpdir(), 'a.bin'), timeoutMs: 50 },
    { jobs: undefined },
  );
  assert.equal(out.ok, false);
  assert.equal(out.async, false, 'jobs 缺失时应明确回 async:false');
});

test('runGithubDownload：注册失败降级同步时带 jobFallbackReason', async () => {
  globalThis.fetch = async () => { throw new Error('offline-test'); };
  const jobs = { start: () => { throw new Error('no job controller'); } };
  const out = await runGithubDownload(
    { url: 'https://github.com/o/r/releases/download/v1/a.bin', savePath: join(tmpdir(), 'a.bin'), timeoutMs: 50 },
    { jobs, owner: 'x' },
  );
  assert.equal(out.jobFallback, true);
  assert.match(String(out.jobFallbackReason), /no job controller/);
});

test('runGithubDownload：dryRun 不注册 job（只探通道，没有后台化的意义）', async () => {
  const jobs = fakeJobs();
  globalThis.fetch = async () => new Response('', { status: 200 });
  const out = await runGithubDownload(
    { url: 'https://github.com/o/r/releases/download/v1/a.bin', dryRun: true },
    { jobs },
  );
  assert.equal(jobs.started.length, 0);
  assert.equal(out.dryRun, true);
});
