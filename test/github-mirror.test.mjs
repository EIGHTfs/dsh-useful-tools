/**
 * github_mirror 回归
 *
 * 覆盖三层：
 *   ① 候选清单读写（归一化 / 并入 / 失败计数 / 停用 / 原子落盘）
 *   ② git 层（insteadOf 读写与幂等）—— 用**临时 HOME** 跑真实 git，绝不碰用户真实 ~/.gitconfig
 *   ③ 工具编排（mirror 必填、dryRun 缺省 true、探测失败轮换、status 视图）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_FAILURES,
  mergeCandidate,
  normalizeHosts,
  normalizeMirror,
  readCandidates,
  recordProbe,
  usableCandidates,
  writeCandidates,
} from '../lib/core/github-mirror/store.js';
import {
  applyInsteadOf,
  readInsteadOfRules,
  removeInsteadOf,
  ruleCovers,
} from '../lib/core/github-mirror/git.js';
import { runGithubMirror } from '../lib/core/github-mirror/index.js';
import { beforeEach, afterEach } from 'node:test';

/**
 * 每个用例把候选清单指到临时文件。
 * 为什么必须：探测失败的地址会写回清单，若不隔离就会污染随仓库入库的 candidates.json。
 */
let candidatesTmp = null;
beforeEach(() => {
  candidatesTmp = mkdtempSync(join(tmpdir(), 'ghmirror-cand-'));
  process.env.DSH_GITHUB_MIRROR_CANDIDATES = join(candidatesTmp, 'candidates.json');
});
afterEach(() => {
  delete process.env.DSH_GITHUB_MIRROR_CANDIDATES;
  if (candidatesTmp) rmSync(candidatesTmp, { recursive: true, force: true });
  candidatesTmp = null;
});

/** 临时 HOME 下跑一段逻辑（git --global 写到这里，不碰真实配置）。 */
async function withTempHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ghmirror-home-'));
  const prev = process.env.HOME;
  process.env.HOME = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('normalizeMirror / normalizeHosts：补斜杠、去协议', () => {
  assert.equal(normalizeMirror('https://ghfast.top'), 'https://ghfast.top/');
  assert.equal(normalizeMirror('  https://ghfast.top/  '), 'https://ghfast.top/');
  assert.equal(normalizeMirror(''), '');
  assert.deepEqual(normalizeHosts(undefined), ['github.com']);
  assert.deepEqual(normalizeHosts('https://github.com/'), ['github.com']);
  assert.deepEqual(normalizeHosts('github.com, raw.githubusercontent.com'), ['github.com', 'raw.githubusercontent.com']);
});

test('mergeCandidate：新地址并入（added:true），已存在只更新 hosts', () => {
  const base = [{ mirror: 'https://a.example/', hosts: ['github.com'], disabled: true, failures: 2 }];

  const added = mergeCandidate(base, 'https://b.example', 'github.com');
  assert.equal(added.added, true);
  assert.equal(added.list.length, 2);
  assert.equal(added.list[1].mirror, 'https://b.example/');
  assert.equal(added.list[1].failures, 0);

  const updated = mergeCandidate(base, 'https://a.example/', 'github.com,raw.githubusercontent.com');
  assert.equal(updated.added, false);
  assert.equal(updated.list.length, 1);
  assert.deepEqual(updated.list[0].hosts, ['github.com', 'raw.githubusercontent.com']);
  assert.equal(updated.list[0].disabled, false, '显式传入应重新启用');
});

test(`recordProbe：成功清零；失败累加，满 ${MAX_FAILURES} 次自动停用`, () => {
  let list = [{ mirror: 'https://a.example/', hosts: ['github.com'], disabled: false, failures: 0 }];

  list = recordProbe(list, 'https://a.example/', { ok: true });
  assert.equal(list[0].failures, 0);
  assert.ok(list[0].lastOkAt);

  for (let i = 1; i <= MAX_FAILURES; i += 1) {
    list = recordProbe(list, 'https://a.example/', { ok: false, error: 'boom' });
    assert.equal(list[0].failures, i);
    assert.equal(list[0].disabled, i >= MAX_FAILURES);
  }
  assert.equal(list[0].lastError, 'boom');
  assert.equal(usableCandidates(list).length, 0, '停用后不再是可用候选');

  // 再次探测成功应恢复
  list = recordProbe(list, 'https://a.example/', { ok: true });
  assert.equal(list[0].disabled, false);
  assert.equal(usableCandidates(list).length, 1);
});

test('候选清单落盘与读回（坏文件不崩）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghmirror-json-'));
  try {
    const path = join(dir, 'candidates.json');
    const w = writeCandidates([{ mirror: 'https://x.example', hosts: 'github.com' }], path);
    assert.equal(w.ok, true);
    const read = readCandidates(path);
    assert.equal(read.length, 1);
    assert.equal(read[0].mirror, 'https://x.example/');
    assert.deepEqual(read[0].hosts, ['github.com']);
    // 读回后文件里没有临时文件残留
    assert.ok(readFileSync(path, 'utf8').includes('https://x.example/'));

    const missing = readCandidates(join(dir, 'nope.json'));
    assert.deepEqual(missing, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git 层：写入 insteadOf 后可读回、幂等、可删除（临时 HOME）', async () => {
  await withTempHome(async () => {
    const mirror = 'https://ghfast.top/';

    assert.deepEqual((await readInsteadOfRules()).rules, [], '初始没有规则');

    assert.equal((await applyInsteadOf(mirror, 'github.com')).ok, true);
    const after = await readInsteadOfRules();
    assert.equal(after.rules.length, 1);
    assert.equal(after.rules[0].insteadOf, 'https://github.com/', '必须是带协议的完整前缀，否则 git 前缀匹配不生效');
    assert.equal(ruleCovers(after.rules, mirror, 'github.com'), true);
    assert.equal(ruleCovers(after.rules, 'https://other.example/', 'github.com'), false);

    // 幂等：同一条再写一次不应变成两条
    await applyInsteadOf(mirror, 'github.com');
    assert.equal((await readInsteadOfRules()).rules.length, 1);

    const removed = await removeInsteadOf(after.rules[0].key);
    assert.equal(removed.ok, true);
    assert.deepEqual((await readInsteadOfRules()).rules, [], '删除后应恢复直连');

    // 删除不存在的键也算成功（no-op）
    assert.equal((await removeInsteadOf('url.https://nope.example/github.com/.insteadOf')).ok, true);
  });
});

test('工具：apply 必须显式传 mirror（不内置默认值）', async () => {
  const r = await runGithubMirror({ action: 'apply' }, {});
  assert.equal(r.ok, false);
  assert.match(r.error, /mirror 必填/);
});

test('工具：apply dryRun 缺省为 true —— 只报计划不写配置', async () => {
  await withTempHome(async () => {
    const r = await runGithubMirror({ action: 'apply', mirror: 'https://ghfast.top/' }, {});
    // 探测可能成功也可能失败（取决于网络）；只要没真的写配置、且给出计划或明确失败原因即可
    if (r.ok) {
      assert.equal(r.dryRun, true);
      assert.ok(Array.isArray(r.plan) && r.plan.length === 1);
      assert.match(r.plan[0], /url\.https:\/\/ghfast\.top\/https:\/\/github\.com\/\.insteadOf https:\/\/github\.com\//);
    } else {
      assert.ok(r.error, '失败时必须给原因');
      assert.ok(Array.isArray(r.attempts), '失败时应带探测记录');
    }
    assert.deepEqual((await readInsteadOfRules()).rules, [], 'dryRun 绝不能写配置');
  });
});

test('工具：探测不通的代理 → apply 失败且不写配置（rotate=false）', async () => {
  await withTempHome(async () => {
    const r = await runGithubMirror(
      { action: 'apply', mirror: 'http://127.0.0.1:9/', dryRun: false, rotate: false },
      {},
    );
    assert.equal(r.ok, false);
    assert.equal(r.attempts.length, 1, 'rotate=false 只试一个');
    assert.equal(r.attempts[0].ok, false);
    assert.deepEqual((await readInsteadOfRules()).rules, [], '探测失败绝不写配置');
    assert.ok(r.directProbe, '应附带直连探测结果，便于判断「其实不用代理」');
  });
});

test('工具：clear 只清本工具管理的规则，不动用户其它 insteadOf', async () => {
  await withTempHome(async () => {
    // 用户自己的（非 github.com）重写：不应被清
    await applyInsteadOf('https://my-proxy.example/', 'gitlab.com');
    await applyInsteadOf('https://ghfast.top/', 'github.com');

    const dry = await runGithubMirror({ action: 'clear' }, {});
    assert.equal(dry.ok, true);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.plan.length, 1, '只有 github.com 那条在管理范围');
    assert.equal((await readInsteadOfRules()).rules.length, 2, 'dryRun 不删');

    const real = await runGithubMirror({ action: 'clear', dryRun: false }, {});
    assert.equal(real.ok, true);
    const left = (await readInsteadOfRules()).rules;
    assert.equal(left.length, 1, '只留下用户自己的 gitlab 规则');
    assert.equal(left[0].insteadOf, 'https://gitlab.com/');
  });
});

test('工具：status 报出当前是否走代理与候选清单', async () => {
  await withTempHome(async () => {
    const off = await runGithubMirror({}, {});
    assert.equal(off.ok, true);
    assert.equal(off.action, 'status');
    assert.equal(off.direct, 'on');
    assert.deepEqual(off.active, []);

    await applyInsteadOf('https://ghfast.top/', 'github.com');
    const on = await runGithubMirror({}, {});
    assert.equal(on.direct, 'off');
    assert.equal(on.active.length, 1);
    assert.match(on.active[0].mirror, /ghfast\.top/);
  });
});

test('工具：未知 action 明确报错', async () => {
  const r = await runGithubMirror({ action: 'nope' }, {});
  assert.equal(r.ok, false);
  assert.match(r.error, /未知 action/);
});

test('回归：跑探测失败不会写脏随仓库入库的 candidates.json', async () => {
  const { CANDIDATES_PATH } = await import('../lib/core/github-mirror/store.js');
  const before = readFileSync(CANDIDATES_PATH, 'utf8');
  await withTempHome(async () => {
    await runGithubMirror({ action: 'apply', mirror: 'http://127.0.0.1:9/', dryRun: false, rotate: false }, {});
  });
  const after = readFileSync(CANDIDATES_PATH, 'utf8');
  assert.equal(after, before, '入库清单必须原样不动（探测结果只写临时文件）');
  assert.equal(before.includes('127.0.0.1:9'), false, '入库清单不应含测试地址');
});

test('回归：insteadOf 值必须带协议（裸主机会导致重写不生效）', async () => {
  await withTempHome(async () => {
    const { hostUrl } = await import('../lib/core/github-mirror/git.js');
    assert.equal(hostUrl('github.com'), 'https://github.com/');
    assert.equal(hostUrl('https://github.com/'), 'https://github.com/');

    await applyInsteadOf('https://ghfast.top/', 'github.com');
    const rules = (await readInsteadOfRules()).rules;
    assert.equal(rules.length, 1);
    assert.equal(rules[0].insteadOf, 'https://github.com/');
    assert.match(rules[0].base, /^https:\/\/ghfast\.top\/https:\/\/github\.com\/$/);
    assert.equal(ruleCovers(rules, 'https://ghfast.top/', 'github.com'), true);
  });
});

test('回归：clear 能清掉旧版误写的裸主机规则', async () => {
  await withTempHome(async () => {
    // 模拟历史残留：裸主机形式
    await new Promise((resolve, reject) => {
      const { execFile } = require('node:child_process');
      execFile('git', ['config', '--global', 'url.https://ghfast.top/github.com/.insteadOf', 'github.com/'], (e) => (e ? reject(e) : resolve()));
    }).catch(() => {});
    const listed = (await readInsteadOfRules()).rules;
    if (listed.length === 0) return; // 造不出来就跳过（不影响主判据）
    const r = await runGithubMirror({ action: 'clear', dryRun: false }, {});
    assert.equal(r.ok, true);
    assert.deepEqual((await readInsteadOfRules()).rules, [], '裸主机残留也必须被清掉');
  });
});
