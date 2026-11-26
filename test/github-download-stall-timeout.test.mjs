/**
 * 下载超时语义（回归）：停滞超时，不是总时长超时
 *
 * 为什么单独立这个文件：这里锁的是一条**曾被反复违反**的设计约束——
 *   用「总时长」判下载失败，会让慢速大文件在下到一半时被掐断、文件被清空、
 *   换下一个通道从零开始。实测 164MB 经镜像下载时三个镜像各被掐一次，
 *   耗时 79 秒、一个字节没留下。
 *
 * 正确的判据是「多久没有新数据」（停滞），并且：
 *   ① 只要数据还在流入，跑多久都不算失败；
 *   ② 建连阶段与传输阶段用不同上限（连不上 ≠ 下得慢）；
 *   ③ 停滞阈值有下限，避免调用方传个 3 秒把健康链路误杀在握手阶段。
 *
 * 测试用小毫秒值直接驱动信号工厂，不依赖真实网络、也不拖慢测试。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createStallSignal, normalizeTimeout } from '../lib/core/github-download/index.js';

/** 等待 ms 毫秒（测试里唯一允许的"等时间"：等的是信号状态变化，不是流程推进）。 */
function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

test('持续有数据流入时，超过停滞阈值也不会被判超时', async () => {
  const guard = createStallSignal({ stallMs: 60, connectMs: 60, label: '测试' });
  try {
    // 每 20ms 喂一次数据，总时长远超 60ms 的停滞阈值
    for (let index = 0; index < 10; index += 1) {
      await sleep(20);
      guard.arm();
      assert.equal(guard.signal.aborted, false, `第 ${index + 1} 次喂数据前不该被判超时`);
    }
    assert.equal(guard.signal.aborted, false, '一直有数据流入就不该中止');
  } finally {
    guard.disarm();
  }
});

test('真的停滞（无新数据）时按停滞阈值中止，并给出停滞原因', async () => {
  const guard = createStallSignal({ stallMs: 50, connectMs: 5000, label: '测试' });
  try {
    guard.arm(); // 先模拟「已拿到响应头」，进入传输阶段
    await sleep(120);
    assert.equal(guard.signal.aborted, true, '没有任何新数据就该中止');
    assert.match(guard.stallReason(), /停滞/, '原因要说明是停滞，不是笼统超时');
  } finally {
    guard.disarm();
  }
});

test('建连阶段用独立上限，原因写明建连而不是停滞', async () => {
  const guard = createStallSignal({ stallMs: 5000, connectMs: 50, label: '测试' });
  try {
    await sleep(120);
    assert.equal(guard.signal.aborted, true);
    assert.match(guard.stallReason(), /建连/, '还没拿到响应头就失败，原因应是建连超时');
  } finally {
    guard.disarm();
  }
});

test('拿到响应头后切到停滞判据：arm() 之后不再按建连上限计时', async () => {
  const guard = createStallSignal({ stallMs: 500, connectMs: 40, label: '测试' });
  try {
    guard.arm(); // 模拟收到响应头
    await sleep(120); // 已超过建连上限 40ms
    assert.equal(guard.signal.aborted, false, '切到停滞判据后，建连上限不该再生效');
  } finally {
    guard.disarm();
  }
});

test('外部中止信号能穿透（job_kill 用）', async () => {
  const external = new AbortController();
  const guard = createStallSignal({ stallMs: 5000, connectMs: 5000, label: '测试' });
  try {
    external.abort('user-cancel');
    // 用一个新的 guard 模拟「创建时外部已中止」
    const already = createStallSignal({ stallMs: 5000, connectMs: 5000, externalSignal: external.signal, label: '测试' });
    assert.equal(already.signal.aborted, true, '外部已中止时新信号应立刻是中止态');
    already.disarm();
  } finally {
    guard.disarm();
  }
});

test('normalizeTimeout：过小的值被抬到下限，非正数回落默认值', () => {
  // 3 秒对「停滞」来说太短：握手与镜像回源都可能超过它
  assert.equal(normalizeTimeout(3000) >= 15000, true, '低于下限的值必须被抬高');
  assert.equal(normalizeTimeout(0), 300000);
  assert.equal(normalizeTimeout(-1), 300000);
  assert.equal(normalizeTimeout('abc'), 300000);
  assert.equal(normalizeTimeout(60000), 60000, '合理值原样保留');
});
