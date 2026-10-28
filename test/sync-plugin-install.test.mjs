// 插件安装形态与 HMR 自检的单元测试（纯 Node，用临时目录造 profile，不碰真实数据）。
//
// 覆盖（对应 sync-plugin-install.mjs 的对外能力）：
//   ① dshRootOf 两种入参形态（DSH_HOME 本尊 / 已含 .dsh）
//   ② readHmrConfig + judgeHmr：root 为空 ⇒ 不可热重载；root 覆盖 local-plugins ⇒ 可；只在 node_modules ⇒ 不可
//   ③ planInstall：真源只认 local-plugins（缺 ⇒ create-local、是软链 ⇒ delink-local）；
//      node_modules **不由本工具建链**（旧版 link-nm/relink-nm 已移除，入口交给 DSH 安装流程），
//      但 node_modules 下是**真实目录副本**时必须报警（实测会顶掉真源）
//   ④ applyInstall：默认不动盘；on=true 只处理 local-plugins，node_modules 相关只报告不删数据
//   ⑤ depHints：link:绝对路径 ⇒ 提示改 file:local-plugins/<插件>
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dshRootOf, readHmrConfig, judgeHmr, planInstall, applyInstall, depHints, pickProfile, inspectProfiles } from '../lib/core/plugin-sync/install.mjs';
import { ensureHmrConfig } from '../lib/core/plugin-sync/hmr-config.mjs';

/** 造一个假 DSH_HOME：<tmp>/.dsh/profiles/web（withDsh=false 时目录结构只到 <tmp>/profiles/web）。 */
function fakeHome({ profile = 'web' } = {}) {
  const sandboxDir = mkdtempSync(join(tmpdir(), 'dsh-sync-install-'));
  const dsh = join(sandboxDir, '.dsh');
  const pd = join(dsh, 'profiles', profile);
  mkdirSync(join(pd, 'local-plugins'), { recursive: true });
  mkdirSync(join(pd, 'node_modules'), { recursive: true });
  return { sandboxDir, dsh, pd };
}
const clean = (p) => { try { rmSync(p, { recursive: true, force: true }); } catch { /* noop */ } };

test('dshRootOf：DSH_HOME 本尊与已含 .dsh 两种形态都能定位', () => {
  const { sandboxDir, dsh } = fakeHome();
  try {
    assert.equal(dshRootOf(sandboxDir), dsh, 'DSH_HOME 本尊（不含 .dsh）应补出 .dsh');
    assert.equal(dshRootOf(dsh), dsh, '已含 .dsh 的路径应原样使用');
  } finally { clean(sandboxDir); }
});

test('judgeHmr：root 为空 ⇒ 不可热重载（module roots are opt-in）', () => {
  const { sandboxDir, pd } = fakeHome();
  try {
    writeFileSync(join(pd, 'cordis.patch.yml'), '- id: hmr\n  config:\n    base: ' + pd + '\n    root: []\n', 'utf8');
    mkdirSync(join(pd, 'local-plugins', 'p1'), { recursive: true });
    const hmr = readHmrConfig(pd);
    const r = judgeHmr({ hmr, profileDir: pd, pluginName: 'p1' });
    assert.equal(r.hot, false);
    assert.match(r.reason, /root 为空|opt-in/);
  } finally { clean(sandboxDir); }
});

test('judgeHmr：root 覆盖 local-plugins ⇒ 可热重载；只在 node_modules ⇒ 不可', () => {
  const { sandboxDir, pd } = fakeHome();
  try {
    writeFileSync(join(pd, 'cordis.patch.yml'), `- id: hmr\n  config:\n    base: ${pd}\n    root:\n      - local-plugins\n`, 'utf8');
    mkdirSync(join(pd, 'local-plugins', 'p1'), { recursive: true });
    const hmr = readHmrConfig(pd);
    assert.equal(readHmrConfig(pd).base, pd);
    assert.equal(judgeHmr({ hmr, profileDir: pd, pluginName: 'p1' }).hot, true);
    // 只存在 node_modules 形态
    mkdirSync(join(pd, 'node_modules', 'p2'), { recursive: true });
    const r2 = judgeHmr({ hmr, profileDir: pd, pluginName: 'p2' });
    assert.equal(r2.hot, false);
    assert.match(r2.reason, /node_modules|剪枝|覆盖范围/);
  } finally { clean(sandboxDir); }
});

test('planInstall：真源只认 local-plugins；副本**内容漂移**才报警（同内容硬链接副本不报）', () => {
  const { sandboxDir, pd } = fakeHome();
  try {
    const outside = join(sandboxDir, 'outside-plugin');
    mkdirSync(outside, { recursive: true });
    // node_modules 是（绝对）软链：已不属本工具职责 ⇒ 不产生任何 node_modules 相关待办
    symlinkSync(outside, join(pd, 'node_modules', 'p1'));
    assert.deepEqual(planInstall({ profileDir: pd, pluginName: 'p1' }).map((x) => x.kind), ['create-local'],
      '只应提示建 local-plugins 真实目录（入口链交给 DSH 安装流程）');
    // 已有 local 真实目录 + node_modules 完全缺条目 ⇒ 也不再提示建链（旧版会报 link-nm）
    mkdirSync(join(pd, 'local-plugins', 'p1'), { recursive: true });
    rmSync(join(pd, 'node_modules', 'p1'), { force: true });
    assert.deepEqual(planInstall({ profileDir: pd, pluginName: 'p1' }).map((x) => x.kind), [],
      '入口缺失不是本工具的待办（由安装流程生成）');
    // node_modules 是真实目录、且与真源**内容一致**（模拟 pnpm 硬链接副本）⇒ 不应报警
    mkdirSync(join(pd, 'node_modules', 'p1'), { recursive: true });
    writeFileSync(join(pd, 'local-plugins', 'p1', 'package.json'), '{"version":"9.9.9"}', 'utf8');
    writeFileSync(join(pd, 'node_modules', 'p1', 'package.json'), '{"version":"9.9.9"}', 'utf8');
    assert.deepEqual(planInstall({ profileDir: pd, pluginName: 'p1' }).map((x) => x.kind), [],
      '同内容副本是正常安装产物，不该报警');
    // 内容漂移（副本陈旧）⇒ 必须报警：它会顶掉真源、让宿主跑旧代码
    writeFileSync(join(pd, 'node_modules', 'p1', 'package.json'), '{"version":"1.0.0"}', 'utf8');
    const a3 = planInstall({ profileDir: pd, pluginName: 'p1' });
    assert.deepEqual(a3.map((x) => x.kind), ['nm-drift']);
    assert.match(a3[0].desc, /内容不一致|顶掉/);
    // local-plugins 下是软链 ⇒ delink
    rmSync(join(pd, 'local-plugins', 'p1'), { recursive: true, force: true });
    symlinkSync(outside, join(pd, 'local-plugins', 'p1'));
    assert.ok(planInstall({ profileDir: pd, pluginName: 'p1' }).some((x) => x.kind === 'delink-local'));
  } finally { clean(sandboxDir); }
});

test('applyInstall：默认不写盘；on=true 只处理 local-plugins，不碰 node_modules', () => {
  const { sandboxDir, pd } = fakeHome();
  try {
    const outside = join(sandboxDir, 'outside-plugin');
    mkdirSync(outside, { recursive: true });
    // local-plugins 是指向 outside 的软链（真源内容 = outside/*）
    writeFileSync(join(outside, 'package.json'), '{"version":"9.9.9"}', 'utf8');
    symlinkSync(outside, join(pd, 'local-plugins', 'p1'));            // ⇒ delink-local
    // node_modules 是真实目录、内容与真源不一致 ⇒ nm-drift（只报告不动盘）
    mkdirSync(join(pd, 'node_modules', 'p1'), { recursive: true });
    writeFileSync(join(pd, 'node_modules', 'p1', 'package.json'), '{"version":"1.0.0"}', 'utf8');
    const actions = planInstall({ profileDir: pd, pluginName: 'p1' });
    assert.deepEqual(actions.map((x) => x.kind), ['delink-local', 'nm-drift']);
    applyInstall(actions, { on: false });
    assert.equal(lstatSync(join(pd, 'local-plugins', 'p1')).isSymbolicLink(), true, 'dry-run 不应动盘');
    const r = applyInstall(actions, { on: true });
    assert.deepEqual(r.done, ['delink-local'], '只执行 local-plugins 解链');
    assert.equal(lstatSync(join(pd, 'local-plugins', 'p1')).isSymbolicLink(), false, '解链后应是真实目录');
    assert.deepEqual(r.skipped, ['nm-drift'], 'node_modules 相关只报告、不动盘');
    assert.equal(lstatSync(join(pd, 'node_modules', 'p1')).isDirectory(), true, '不应删掉 node_modules 里的既有数据');
  } finally { clean(sandboxDir); }
});

test('depHints：link:绝对路径应提示改 file:local-plugins/<插件>', () => {
  const { sandboxDir, pd } = fakeHome();
  try {
    writeFileSync(join(pd, 'package.json'), JSON.stringify({ name: 'web', dependencies: { p1: 'link:/abs/path/p1' } }, null, 2), 'utf8');
    const h = depHints(pd, 'p1');
    assert.equal(h.length, 1);
    assert.match(h[0], /file:local-plugins\/p1/);
    writeFileSync(join(pd, 'package.json'), JSON.stringify({ name: 'web', dependencies: { p1: 'file:local-plugins/p1' } }, null, 2), 'utf8');
    assert.deepEqual(depHints(pd, 'p1'), [], '已正确则不应有提示');
  } finally { clean(sandboxDir); }
});

test('pickProfile：优先 local-plugins；多命中要求显式；只在 node_modules 也算命中', () => {
  const sandboxDir = mkdtempSync(join(tmpdir(), 'dsh-pick-'));
  const proot = join(sandboxDir, '.dsh', 'profiles');
  for (const n of ['a', 'b']) {
    mkdirSync(join(proot, n, 'local-plugins'), { recursive: true });
    mkdirSync(join(proot, n, 'node_modules'), { recursive: true });
  }
  try {
    // 只有 b 的 local-plugins 有 p1 ⇒ 应选 b（本条正是 dry-run 实测踩到的坑：自动取首个会选到错 profile）
    mkdirSync(join(proot, 'b', 'local-plugins', 'p1'), { recursive: true });
    const r1 = pickProfile(inspectProfiles(sandboxDir), 'p1');
    assert.equal(r1.profile, 'b');
    assert.equal(r1.ambiguous, undefined);
    // 两个 profile 的 local-plugins 都有 ⇒ 要求显式
    mkdirSync(join(proot, 'a', 'local-plugins', 'p1'), { recursive: true });
    assert.equal(pickProfile(inspectProfiles(sandboxDir), 'p1').ambiguous, true);
    // 都只落在 node_modules ⇒ 仍能命中（但理由会提示应迁到 local-plugins）
    rmSync(join(proot, 'a', 'local-plugins', 'p1'), { recursive: true, force: true });
    rmSync(join(proot, 'b', 'local-plugins', 'p1'), { recursive: true, force: true });
    mkdirSync(join(proot, 'a', 'node_modules', 'p2'), { recursive: true });
    const r2 = pickProfile(inspectProfiles(sandboxDir), 'p2');
    assert.equal(r2.profile, 'a');
    assert.match(r2.reason, /node_modules|local-plugins/);
    // 完全没装 ⇒ 不命中
    assert.equal(pickProfile(inspectProfiles(sandboxDir), 'nope').dir, '');
  } finally { clean(sandboxDir); }
});

// ── ensureHmrConfig：sync_plugin 的 hmr 参数背后的幂等启用 ─────────────────

/** 造一个带 cordis.patch.yml 的假 profile。 */
function fakeProfile(patchText) {
  const { sandboxDir, pd } = fakeHome();
  if (patchText !== undefined) writeFileSync(join(pd, 'cordis.patch.yml'), patchText, 'utf8');
  return { sandboxDir, pd, patchPath: join(pd, 'cordis.patch.yml') };
}
const readPatch = (f) => readFileSync(f.patchPath, 'utf8');

test('ensureHmrConfig：没有 hmr 条目时追加（dryRun 不动盘，apply 才写）', () => {
  const f = fakeProfile('- insert:\n    - id: some-plugin\n      name: some-plugin\n');
  try {
    const dry = ensureHmrConfig({ profileDir: f.pd });
    assert.equal(dry.ok, true);
    assert.deepEqual(dry.changed, [], 'dryRun 不该报已改');
    assert.equal(dry.plan.length, 1, 'dryRun 要给出计划');
    assert.equal(readPatch(f).includes('hmr'), false, 'dryRun 绝不能写盘');

    const real = ensureHmrConfig({ profileDir: f.pd }, { write: true });
    assert.equal(real.changed.length, 1, 'apply 后 changed 应记录实际落盘项');
    assert.match(real.changed[0], /新建 hmr 条目/);
    const text = readPatch(f);
    assert.match(text, /^- insert:/, '原有内容必须保留');
    assert.match(text, /- id: hmr/);
    assert.match(text, /root:\s*\n\s+- local-plugins/);
    // base 用版本无关表达式，写死版本目录会在升级后崩掉 hmr
    assert.match(text, /profileContext/);
    assert.equal(real.restartNote !== undefined, true, '首次启用要给重启提示');
  } finally {
    clean(f.sandboxDir);
  }
});

test('ensureHmrConfig：已齐备则不动盘（幂等）', () => {
  const text = '- id: hmr\n  config:\n    base: !!js \'ctx.get("profileContext").dir\'\n    root:\n      - local-plugins\n';
  const f = fakeProfile(text);
  try {
    const r = ensureHmrConfig({ profileDir: f.pd }, { write: true });
    assert.deepEqual(r.changed, [], '齐备时不该有任何改动');
    assert.equal(r.nowWatching, true);
    assert.equal(readPatch(f), text, '文件必须逐字节不变');
  } finally {
    clean(f.sandboxDir);
  }
});

test('ensureHmrConfig：root 为空时补 local-plugins，并保留其它块', () => {
  const text = "- id: hmr\n  config:\n    base: !!js 'ctx.get(\"profileContext\").dir'\n    root: []\n- id: computer-use\n  disabled: true\n";
  const f = fakeProfile(text);
  try {
    assert.equal(readHmrConfig(f.pd).root.length, 0, '前置：root 为空');
    const r = ensureHmrConfig({ profileDir: f.pd }, { write: true });
    assert.equal(r.changed.length, 1, `应补一项，实际 ${JSON.stringify(r.changed)}`);
    assert.equal(readHmrConfig(f.pd).root.includes('local-plugins'), true);
    const after = readPatch(f);
    assert.match(after, /computer-use/, '其它条目不能被吃掉');
    assert.match(after, /disabled: true/);
  } finally {
    clean(f.sandboxDir);
  }
});

test('ensureHmrConfig：base 写死版本目录 ⇒ 给出警告而不静默改', () => {
  const f = fakeProfile("- id: hmr\n  config:\n    base: /x/0.2.0/.dsh/profiles/web\n    root:\n      - local-plugins\n");
  try {
    const dry = ensureHmrConfig({ profileDir: f.pd });
    assert.equal(dry.plan.some((line) => line.includes('版本目录')), true, `应警告写死版本目录：${JSON.stringify(dry.plan)}`);
    assert.equal(readPatch(f), "- id: hmr\n  config:\n    base: /x/0.2.0/.dsh/profiles/web\n    root:\n      - local-plugins\n", '警告不应改盘');
  } finally {
    clean(f.sandboxDir);
  }
});

test('judgeHmr：base 是 !!js 表达式时按当前 profile 判定（不能拿表达式当路径）', () => {
  const { sandboxDir, pd } = fakeHome();
  try {
    mkdirSync(join(pd, 'local-plugins', 'demo'), { recursive: true });
    const cfg = { found: true, base: 'ctx.get("profileContext").dir', root: ['local-plugins'] };
    assert.equal(judgeHmr({ hmr: cfg, profileDir: pd, pluginName: 'demo' }).hot, true);
    assert.match(judgeHmr({ hmr: cfg, profileDir: pd, pluginName: 'nope' }).reason, /没装到该 profile/);
    // 普通路径 base 仍按原语义工作
    assert.equal(judgeHmr({ hmr: { ...cfg, base: pd }, profileDir: pd, pluginName: 'demo' }).hot, true);
  } finally {
    clean(sandboxDir);
  }
});

// ── ensureHmrConfig 的结构完整性（曾把 patch 文件写坏：留下重复 root 键与错缩进）──

test('ensureHmrConfig：任何入口形态写盘后都必须结构合法（无重复键、层级正确）', () => {
  const inputs = {
    'inline 空数组': "- id: hmr\n  config:\n    base: !!js 'ctx.get(\"profileContext\").dir'\n    root: []\n",
    '行内一项': "- id: hmr\n  config:\n    base: !!js 'ctx.get(\"profileContext\").dir'\n    root: [other]\n",
    '完全没有 root': '- id: hmr\n  config:\n    base: !!js \'x\'\n',
    'root 为空行': '- id: hmr\n  config:\n    root:\n',
    '有其它键要保留': "- id: hmr\n  config:\n    base: !!js 'x'\n    root: []\n    throttleMs: 500\n",
  };
  for (const [label, text] of Object.entries(inputs)) {
    const f = fakeProfile(text);
    try {
      ensureHmrConfig({ profileDir: f.pd }, { write: true });
      const out = readPatch(f);
      const lines = out.split('\n');
      // ① root 键只能出现一次（重复键会让 YAML 语义不确定）
      const rootKeys = lines.filter((l) => /^[ \t]+root:/.test(l));
      assert.equal(rootKeys.length, 1, `${label}：root 键应唯一，实际 ${rootKeys.length} 个\n${out}`);
      // ② base 键也只能出现一次
      assert.equal(lines.filter((l) => /^[ \t]+base:/.test(l)).length, 1, `${label}：base 应唯一\n${out}`);
      // ③ 必须真的 watch 到 local-plugins
      assert.equal(readHmrConfig(f.pd).root.includes('local-plugins'), true, `${label}：root 未含 local-plugins\n${out}`);
      // ④ 层级：root 的列表项必须比 root: 更深，且 config 缩进保持
      const cfgLine = lines.find((l) => /^[ \t]+config:/.test(l)) || '';
      assert.match(cfgLine, /^[ \t]+config:$/, `${label}：config 缩进异常\n${out}`);
      const rootLineIdx = lines.findIndex((l) => /^[ \t]+root:/.test(l));
      const item = lines[rootLineIdx + 1] || '';
      const indentOf = (l) => (l.match(/^[ \t]*/m) || [''])[0].length;
      assert.ok(indentOf(item) > indentOf(lines[rootLineIdx]), `${label}：列表项未深缩进\n${out}`);
      // ⑤ 其它键不丢
      if (label === '有其它键要保留') assert.match(out, /throttleMs: 500/, `${label}：其它配置键被吃掉\n${out}`);
    } finally {
      clean(f.sandboxDir);
    }
  }
});

test('ensureHmrConfig：重复执行不产生漂移（第二次写完文件逐字节不变）', () => {
  const f = fakeProfile('- id: hmr\n  config:\n    root: []\n');
  try {
    ensureHmrConfig({ profileDir: f.pd }, { write: true });
    const first = readPatch(f);
    const again = ensureHmrConfig({ profileDir: f.pd }, { write: true });
    assert.deepEqual(again.changed, [], '第二次应无改动');
    assert.equal(readPatch(f), first, '幂等：文件不能被再改写');
  } finally {
    clean(f.sandboxDir);
  }
});
