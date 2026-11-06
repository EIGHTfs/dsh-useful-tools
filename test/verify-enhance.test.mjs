/**
 * verify_plugin 增强 / sync 权限 / test_env 辅助的单测。
 *
 * 覆盖本轮新增的「静默失败」检查：
 *   · inject 服务名校验（拼错给近似建议）
 *   · 激活诊断（dependencies / bundles / loader 行）
 *   · 依赖解析（file: 路径失效）
 *   · 同步后权限与可读性
 *   · dshBin 是 shell wrapper 时的解析
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseInsertLines, checkActivation } from '../lib/core/verify-plugin/activation.mjs';
import { checkInjectNames, extractPluginInject } from '../lib/core/verify-plugin/inject.mjs';
import { checkDeps } from '../lib/core/verify-plugin/deps.mjs';
import { alignPermissions, verifyReadable } from '../lib/core/sync-plugin/permissions.mjs';
import { resolveDshEntry, logHints } from '../lib/core/test-env/index.js';

test('parseInsertLines：只认 insert 块内的 id/name', () => {
  const yaml = `
- insert:
    - id: dsh-useful-tools
      name: dsh-useful-tools
- id: some-other
  name: not-in-insert
`;
  const lines = parseInsertLines(yaml, 'test');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].id, 'dsh-useful-tools');
  assert.equal(lines[0].name, 'dsh-useful-tools');
  assert.equal(lines[0].source, 'test');
});

test('checkActivation：三项缺失各报一条；全齐时不报', () => {
  const missingAll = checkActivation({
    pluginName: 'demo',
    info: { ok: true, profile: 'web', profileDir: '/tmp/web', dependencies: {}, bundles: [], lines: [] },
  });
  assert.equal(missingAll.problems.length, 3);
  assert.ok(missingAll.problems.some((p) => /dependencies/.test(p)));
  assert.ok(missingAll.problems.some((p) => /bundles/.test(p)));
  assert.ok(missingAll.problems.some((p) => /loader 行/.test(p)));

  const ok = checkActivation({
    pluginName: 'demo',
    info: {
      ok: true, profile: 'web', profileDir: '/tmp/web',
      dependencies: { demo: 'file:local-plugins/demo' },
      bundles: ['demo'],
      lines: [{ id: 'demo', name: 'demo', source: 'demo:cordis.patch.yml' }],
    },
  });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.facts.loaderLine.name, 'demo');
});

test('checkInjectNames：大小写与近似拼写都给出建议', () => {
  const available = ['webServer', 'tools', 'fs', 'sessions', 'locale'];
  const r = checkInjectNames(['webserver', 'toolz', 'tools'], available);
  assert.deepEqual(r.unknown, ['webserver', 'toolz']);
  assert.equal(r.suggestions.find((s) => s.from === 'webserver').to, 'webServer');
  assert.equal(r.suggestions.find((s) => s.from === 'toolz').to, 'tools');
});

test('extractPluginInject：认 export const inject 与 ctx.inject', () => {
  const src = `
    export const inject = ['fs', 'tools']
    function apply(ctx) { ctx.inject(['locale'], () => {}) }
  `;
  const names = extractPluginInject(src);
  assert.deepEqual(names.sort(), ['fs', 'locale', 'tools']);
});

test('checkDeps：装在插件自己 node_modules 里的嵌套依赖不算缺失', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deps-nested-'));
  try {
    const plugin = join(dir, 'plugin');
    const profile = join(dir, 'profile');
    // 部署副本形态：<profile>/local-plugins/<插件>，依赖嵌套在插件自己目录里
    const deployed = join(profile, 'local-plugins', 'demo');
    mkdirSync(join(deployed, 'node_modules', 'nested-dep'), { recursive: true });
    // 部署副本一定带 package.json（缺了就不算有效部署位置，判定会退化为 profile 根）
    writeFileSync(join(deployed, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { 'nested-dep': '0.1.13' } }));
    writeFileSync(join(deployed, 'node_modules', 'nested-dep', 'package.json'), JSON.stringify({ name: 'nested-dep', version: '0.1.13' }));
    writeFileSync(join(deployed, 'node_modules', 'nested-dep', 'index.js'), 'module.exports = 1;\n');
    mkdirSync(plugin, { recursive: true });
    writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { 'nested-dep': '0.1.13' } }), 'utf8');

    // 传 targetDir：按插件实际位置解析 → 命中嵌套依赖，不该报缺失
    const fixed = checkDeps({ pluginRoot: plugin, profileDir: profile, targetDir: deployed });
    assert.equal(fixed.ok, true, `嵌套依赖被误报：${JSON.stringify(fixed.missing)}`);
    assert.equal(fixed.missing.length, 0);

    // 对照：不给 targetDir 时按 profile 根解析，认不出嵌套依赖（这是旧误报的来源）
    const old = checkDeps({ pluginRoot: plugin, profileDir: profile });
    assert.equal(old.missing[0].name, 'nested-dep');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkDeps：optionalDependencies 缺席不算失败', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deps-opt-'));
  try {
    const plugin = join(dir, 'plugin');
    const profile = join(dir, 'profile');
    mkdirSync(plugin, { recursive: true });
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(plugin, 'package.json'), JSON.stringify({
      name: 'demo',
      dependencies: { 'opt-dep': '1.0.0' },
      optionalDependencies: { 'opt-dep': '1.0.0' },
    }), 'utf8');
    const r = checkDeps({ pluginRoot: plugin, profileDir: profile });
    assert.equal(r.ok, true, '可选依赖允许缺席');
    assert.match(r.notes.join(' '), /可选依赖/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkDeps：无依赖通过；file: 路径不存在报缺失', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deps-'));
  try {
    const plugin = join(dir, 'plugin');
    const profile = join(dir, 'profile');
    mkdirSync(plugin, { recursive: true });
    mkdirSync(profile, { recursive: true });

    writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: 'demo', dependencies: {} }), 'utf8');
    const none = checkDeps({ pluginRoot: plugin, profileDir: profile });
    assert.equal(none.ok, true);

    writeFileSync(join(plugin, 'package.json'), JSON.stringify({
      name: 'demo',
      dependencies: { 'broken-dep': 'file:../missing.tgz' },
    }), 'utf8');
    const broken = checkDeps({ pluginRoot: plugin, profileDir: profile });
    assert.equal(broken.ok, false);
    assert.equal(broken.missing[0].name, 'broken-dep');
    assert.match(broken.missing[0].why, /本地路径不存在/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('alignPermissions：文件 644 / 目录 755，并且可读', () => {
  const dir = mkdtempSync(join(tmpdir(), 'perm-'));
  try {
    const sub = join(dir, 'lib');
    mkdirSync(sub, { recursive: true });
    const file = join(sub, 'a.js');
    writeFileSync(file, '// x\n', 'utf8');
    chmodSync(file, 0o600);

    const r = alignPermissions({ target: dir, profileDir: '' });
    assert.ok(r.chmoded >= 2, '目录与文件都应被处理');
    assert.equal(statSync(file).mode & 0o777, 0o644);
    assert.equal(statSync(sub).mode & 0o777, 0o755);

    const readable = verifyReadable(dir);
    assert.equal(readable.ok, true);
    assert.deepEqual(readable.unreadable, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveDshEntry：node 脚本直通，shell wrapper 自动解析到 bin.js', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshbin-'));
  try {
    // 真 JS 入口
    const jsEntry = join(dir, 'bin.js');
    writeFileSync(jsEntry, '#!/usr/bin/env node\nimport("./x.js")\n', 'utf8');
    const direct = resolveDshEntry(jsEntry);
    assert.equal(direct.ok, true);
    assert.equal(direct.via, 'direct');

    // shell wrapper：里面引用真实入口
    const real = join(dir, 'apps', 'cli', 'lib', 'bin.js');
    mkdirSync(join(dir, 'apps', 'cli', 'lib'), { recursive: true });
    writeFileSync(real, 'export const x = 1\n', 'utf8');
    const wrapper = join(dir, 'dsh');
    writeFileSync(wrapper, `#!/bin/sh\nexec node "${real}" "$@"\n`, 'utf8');
    const got = resolveDshEntry(wrapper);
    assert.equal(got.ok, true);
    assert.equal(got.via, 'wrapper');
    assert.equal(got.entry, real);

    // 找不到真实入口 → 明确报错，不静默
    const bad = join(dir, 'bad.sh');
    writeFileSync(bad, '#!/bin/sh\necho hi\n', 'utf8');
    const badResult = resolveDshEntry(bad);
    assert.equal(badResult.ok, false);
    assert.match(badResult.error, /shell 脚本/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logHints：把日志里的关键错误行提出来', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loghint-'));
  try {
    const log = join(dir, 'dsh-env.log');
    writeFileSync(log, [
      'starting...',
      'Error: Cannot find module "node-addon-require-builtin/build/napi-v9"',
      'some noise',
      'TypeError: x is not a function',
    ].join('\n'), 'utf8');
    const hints = logHints(log);
    assert.equal(hints.length, 2);
    assert.match(hints[0], /Cannot find module/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseInsertLines 与真实 patch 文件形状一致（缩进两空格的列表）', () => {
  const yaml = [
    '- insert:',
    '    - id: dsh-plugin-sub2api',
    '      name: dsh-plugin-sub2api',
    '      config: {}',
    '- id: other',
  ].join('\n');
  const lines = parseInsertLines(yaml);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].id, 'dsh-plugin-sub2api');
});
