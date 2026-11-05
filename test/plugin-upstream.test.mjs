/**
 * 插件同步增强回归：变动清单语义 + target 参数 + GitHub 上游增量覆盖
 *
 * 覆盖三层：
 *   ① syncPlugin 的 files 现在只回**变动文件**（全量看 totalCount / unchangedCount）
 *   ② runSync 的 target 参数：显式目录校验、缺省沿用旧行为
 *   ③ upstream.mjs：repo 解析 / blob sha / files 白名单 / diff（零下载）/ 覆盖（备份+校验+记录）
 *
 * 全部离线：假 GitHub 用本地 http server 扮演（apiBase / rawBase 注入），
 * 真实 API 与镜像的可用性由上游实测负责，不进单测——否则 CI 会随镜像下线而随机红。
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { syncPlugin } from '../lib/core/sync-plugin/sync-plugin.mjs';
import { runSync } from '../lib/core/sync-plugin/tools.js';
import {
  applyUpstream,
  blobSha,
  diffUpstream,
  isIncludedByFiles,
  parseGithubRepo,
} from '../lib/core/sync-plugin/upstream.mjs';

function tempDir(prefix) {
  return mkdirSync(join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`), { recursive: true });
}

/**
 * 候选清单指向临时空清单：镜像后备通道在测试里必须面对「零候选」，
 * 否则会去真打入库清单里的公共镜像——CI 随镜像下线随机红，还污染学习计数。
 */
let candidatesEnvDir = null;
beforeEach(() => {
  candidatesEnvDir = tempDir('ghup-cand');
  const file = join(candidatesEnvDir, 'candidates.json');
  writeFileSync(file, JSON.stringify({ version: 1, candidates: [] }));
  process.env.DSH_GITHUB_MIRROR_CANDIDATES = file;
});
afterEach(() => {
  delete process.env.DSH_GITHUB_MIRROR_CANDIDATES;
  if (candidatesEnvDir) rmSync(candidatesEnvDir, { recursive: true, force: true });
  candidatesEnvDir = null;
});

const blobOf = (text) => blobSha(Buffer.from(text));

// ─────────────────────────── ① 变动清单语义 ───────────────────────────

test('syncPlugin：files 只含变动文件，未变的进 unchangedCount', async () => {
  const work = tempDir('sync-changed');
  try {
    const source = join(work, 'src');
    const target = join(work, 'dst');
    mkdirSync(join(source, 'lib'), { recursive: true });
    mkdirSync(join(target, 'lib'), { recursive: true });
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'p', version: '1', files: ['lib', 'package.json'] }));
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'p', version: '1', files: ['lib', 'package.json'] }));
    writeFileSync(join(source, 'lib', 'same.js'), '// same\n');
    writeFileSync(join(target, 'lib', 'same.js'), '// same\n');
    writeFileSync(join(source, 'lib', 'new.js'), '// new file\n');

    const dry = await syncPlugin({ source, target, write: false });
    assert.equal(dry.ok, true);
    assert.deepEqual(dry.files, ['lib/new.js'], 'dryRun 的 files 必须只有变动项（本例：本地缺这一个）');
    assert.equal(dry.totalCount, 3, '全量口径 = package.json×2 目录内 + 源侧共 3 个待扫描文件（源视角）');
    assert.equal(dry.unchangedCount, 2);

    const real = await syncPlugin({ source, target, write: true });
    assert.equal(real.ok, true);
    assert.equal(real.written, 1);
    assert.equal(existsSync(join(target, 'lib', 'new.js')), true, 'write:true 才落盘');

    const again = await syncPlugin({ source, target, write: true });
    assert.deepEqual(again.files, [], '全一致时变动清单为空（幂等）');
    assert.equal(again.written, 0);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ─────────────────────────── ② target 参数 ───────────────────────────

test('runSync：target 指向不存在目录时拒绝，不做任何写入', async () => {
  const missing = join(tmpdir(), `no-such-dir-${Date.now()}`);
  const r = await runSync({ target: missing });
  assert.equal(r.ok, false);
  assert.match(r.error, /target 不是已存在的目录/);
});

test('runSync：显式 target 直接作为目标（旧行为按 local-plugins 推算不变）', async () => {
  const work = tempDir('sync-target');
  try {
    const source = join(work, 'src');
    const target = join(work, 'installed', 'x');
    mkdirSync(source, { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'p', version: '1', files: ['package.json', 'index.js'] }));
    writeFileSync(join(source, 'index.js'), 'export const v = 2;\n');

    const r = await runSync({ source, target, write: true });
    assert.equal(r.ok, true);
    assert.equal(r.mode, 'local');
    assert.equal(r.target, target);
    assert.equal(existsSync(join(target, 'index.js')), true, '显式 target 就是写入目标（旧行为只认 local-plugins）');
    assert.deepEqual(r.files, ['index.js', 'package.json'], 'files 只回变动项，不是全量清单');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ─────────────────────────── ②b 显式 target 的插件名防呆 ───────────────────────────

test('runSync：带 target 且源/目标插件名不一致时拒绝，防拿 A 源码覆盖 B', async () => {
  const work = tempDir('sync-mismatch');
  try {
    const source = join(work, 'src');
    const target = join(work, 'installed', 'other');
    mkdirSync(source, { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'aaa', version: '1', files: ['package.json', 'index.js'] }));
    writeFileSync(join(source, 'index.js'), 'export const who = "aaa";\n');
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name: 'bbb', version: '1' }));

    const blocked = await runSync({ source, target, write: true });
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /aaa[\s\S]*bbb|别|覆盖/, '错误要点出两边插件名');
    assert.equal(existsSync(join(target, 'index.js')), false, '被拦时绝不写盘');

    const forced = await runSync({ source, target, write: true, allowMismatch: true });
    assert.equal(forced.ok, true, '显式 allowMismatch:true 才放行');
    assert.equal(existsSync(join(target, 'index.js')), true);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('runSync：目标无 package.json（空目录/装机版裸文件）时不误拦', async () => {
  const work = tempDir('sync-no-pkg');
  try {
    const source = join(work, 'src');
    const target = join(work, 'installed', 'bare');
    mkdirSync(source, { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'aaa', version: '1', files: ['package.json', 'a.js'] }));
    writeFileSync(join(source, 'a.js'), 'x\n');
    // 目标没有 package.json → 防呆要求两边名字都非空才比对，这里应放行
    const r = await runSync({ source, target, write: true });
    assert.equal(r.ok, true);
    assert.equal(existsSync(join(target, 'a.js')), true);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// ─────────────────────────── ③ upstream 纯函数 ───────────────────────────

test('parseGithubRepo：简写 / https / ssh / 镜像前缀 / 非法输入', () => {
  assert.deepEqual(parseGithubRepo('MerkyorLynn/dsh-live-compact'), { ok: true, repo: 'MerkyorLynn/dsh-live-compact' });
  assert.deepEqual(parseGithubRepo('https://github.com/a/b'), { ok: true, repo: 'a/b' });
  assert.deepEqual(parseGithubRepo('https://github.com/a/b.git'), { ok: true, repo: 'a/b' });
  assert.deepEqual(parseGithubRepo('git@github.com:a/b.git'), { ok: true, repo: 'a/b' });
  assert.deepEqual(parseGithubRepo('https://ghfast.top/https://github.com/a/b'), { ok: true, repo: 'a/b' });
  assert.deepEqual(parseGithubRepo('https://github.com/a/b/tree/main'), { ok: true, repo: 'a/b' });
  assert.equal(parseGithubRepo('').ok, false);
  assert.equal(parseGithubRepo('https://gitlab.com/a/b').ok, false);
});

test('blobSha：空内容等于公知空 blob，且与 git hash-object 口径一致', () => {
  assert.equal(blobSha(Buffer.from('')), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  const text = 'hello world\n';
  assert.equal(blobSha(Buffer.from(text)), createHash('sha1').update(`blob ${Buffer.byteLength(text)}\u0000${text}`).digest('hex'));
});

test('isIncludedByFiles：目录/精确/否定/始终包含/空清单', () => {
  const files = ['lib', 'index.js', 'README.md', 'test/'];
  assert.equal(isIncludedByFiles(files, 'lib/a/b.js'), true, '目录条目含其下全部');
  assert.equal(isIncludedByFiles(files, 'index.js'), true, '精确文件');
  assert.equal(isIncludedByFiles(files, 'docs/x.md'), false, '白名单外不装');
  assert.equal(isIncludedByFiles(files, 'package.json'), true, 'npm 始终包含');
  assert.equal(isIncludedByFiles(files, 'LICENSE'), true, 'npm 始终包含');
  assert.equal(isIncludedByFiles([], 'anything.js'), true, '未声明 files = 全收');
  assert.equal(isIncludedByFiles(['lib', '!lib/dev.js'], 'lib/dev.js'), false, '否定条目');
});

// ─────────────────────────── ③ upstream 链路（假 API） ───────────────────────────

/**
 * 起一个假 GitHub：`/repos/x/y` 报默认分支、`/repos/x/y/git/trees/...` 报文件树、
 * raw 路径按 `/<repo>/<ref>/<path>` 回内容。package.json 自动合成（含 files 白名单）。
 * 返回 { apiBase, rawBase, close }。
 */
async function startFakeGithub({ repo = 'fake/plugin', branch = 'main', files = {}, pkgFiles = null }) {
  const pkgText = JSON.stringify({ name: 'plugin', version: '2.0.0', ...(pkgFiles === null ? {} : { files: pkgFiles }) });
  const allFiles = { 'package.json': pkgText, ...files };
  const trees = Object.entries(allFiles).map(([path, content]) => ({
    path, type: 'blob', sha: blobOf(content), size: Buffer.byteLength(content),
  }));
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const sendJson = (payload) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    if (url.pathname === `/repos/${repo}`) return sendJson({ default_branch: branch });
    if (url.pathname.startsWith(`/repos/${repo}/git/trees/`)) return sendJson({ sha: 'HEADSHA', truncated: false, tree: trees });
    const raw = url.pathname.match(new RegExp(`^/${repo}/[^/]+/(.+)$`));
    if (raw && allFiles[raw[1]] !== undefined) {
      response.writeHead(200, { 'content-type': 'text/plain' });
      return response.end(allFiles[raw[1]]);
    }
    response.writeHead(404).end('Not Found');
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    apiBase: base,
    rawBase: base,
    close: () => new Promise((done) => server.close(done)),
  };
}

test('diffUpstream：零下载算出 变动/新增/本地多余', async () => {
  const fake = await startFakeGithub({
    files: { 'index.js': 'v2\n', 'lib/core.js': 'core v2\n', 'docs/guide.md': 'doc\n', 'test/t.mjs': 't\n' },
    pkgFiles: ['index.js', 'lib', 'package.json'],
  });
  const work = tempDir('ghdiff');
  try {
    const installDir = join(work, 'installed');
    mkdirSync(join(installDir, 'lib'), { recursive: true });
    writeFileSync(join(installDir, 'index.js'), 'v1\n');
    writeFileSync(join(installDir, 'lib', 'core.js'), 'core v2\n');
    writeFileSync(join(installDir, 'stale.js'), 'leftover\n');

    const diff = await diffUpstream({ repo: 'fake/plugin', ref: 'main', installDir, apiBase: fake.apiBase, rawBase: fake.rawBase });
    assert.equal(diff.ok, true);
    assert.deepEqual(diff.changed.map((f) => f.path), ['index.js'], '内容不同 → changed');
    // added = 远端白名单内、本地没有的：package.json（docs/test 被白名单挡掉，lib/core.js 本地已一致）
    assert.deepEqual(diff.added.map((f) => f.path), ['package.json']);
    assert.deepEqual(diff.removed, ['stale.js'], '本地多余只报告，不删');
    assert.equal(diff.unchangedCount, 1);
  } finally {
    await fake.close();
    rmSync(work, { recursive: true, force: true });
  }
});

test('applyUpstream：dryRun 不动盘；write 才覆盖 + 备份旧文件 + 落记录', async () => {
  const fake = await startFakeGithub({ files: { 'index.js': 'NEW\n' }, pkgFiles: ['index.js', 'package.json'] });
  const work = tempDir('ghapply');
  try {
    const installDir = join(work, 'installed');
    const backupRoot = join(work, 'backup');
    const recordDir = join(work, 'records');
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(installDir, 'index.js'), 'OLD\n');

    const dry = await applyUpstream({ repo: 'fake/plugin', installDir, write: false, backupRoot, recordDir, apiBase: fake.apiBase, rawBase: fake.rawBase });
    assert.equal(dry.ok, true);
    assert.equal(dry.dryRun, true);
    assert.deepEqual(dry.changed, ['index.js']);
    assert.equal(readFileSync(join(installDir, 'index.js'), 'utf8'), 'OLD\n', 'dryRun 绝不动盘');

    const applied = await applyUpstream({ repo: 'fake/plugin', pluginName: 'plugin-x', installDir, write: true, backupRoot, recordDir, apiBase: fake.apiBase, rawBase: fake.rawBase });
    assert.equal(applied.ok, true);
    assert.equal(readFileSync(join(installDir, 'index.js'), 'utf8'), 'NEW\n', 'write:true 才覆盖');
    assert.equal(readFileSync(join(installDir, 'package.json'), 'utf8').includes('"files"'), true, '白名单内新增文件也要装上');
    // 备份可还原
    const backups = readdirSync(backupRoot);
    assert.equal(backups.length, 1);
    const backupIndex = join(backupRoot, backups[0], 'index.js');
    assert.equal(readFileSync(backupIndex, 'utf8'), 'OLD\n', '被覆盖的旧文件有备份');
    // 记录可用于「生效没」核验
    const records = readdirSync(recordDir).filter((f) => f.endsWith('.json'));
    assert.ok(records.length >= 1);
    const record = JSON.parse(readFileSync(join(recordDir, records[0]), 'utf8'));
    assert.equal(record.headSha, 'HEADSHA');
    assert.equal(record.written.some((w) => w.path === 'index.js'), true);
    assert.match(applied.restartNote, /重启/);
  } finally {
    await fake.close();
    rmSync(work, { recursive: true, force: true });
  }
});

test('applyUpstream：内容 sha 对不上远端 blob sha 时拒绝写入', async () => {
  const fake = await startFakeGithub({ files: { 'index.js': 'REAL\n' } });
  const work = tempDir('ghtamper');
  try {
    const installDir = join(work, 'installed');
    mkdirSync(installDir, { recursive: true });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const response = await originalFetch(input, init);
      if (String(input).includes('/index.js')) {
        const body = new Response('CORRUPT\n', { status: 200 });
        return body;
      }
      return response;
    };
    try {
      const r = await applyUpstream({
        repo: 'fake/plugin',
        ref: 'main',
        installDir,
        write: true,
        backupRoot: join(work, 'backup'),
        recordDir: join(work, 'records'),
        apiBase: fake.apiBase,
        rawBase: fake.rawBase,
      });
      assert.equal(r.ok, false);
      assert.match(String(r.error), /取不到/);
      assert.equal(existsSync(join(installDir, 'index.js')), false, '校验不过不落盘');
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    await fake.close();
    rmSync(work, { recursive: true, force: true });
  }
});
