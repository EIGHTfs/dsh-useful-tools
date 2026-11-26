/**
 * 共用停滞超时模块（回归）
 *
 * 为什么要单独测：它是「下载」与「插件源码拉取」两条链路的共同判据，
 *   一旦这里退化成总时长语义，两处会同时回归，而且表现都是「明明在传却判失败」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createStallSignal,
  normalizeStallTimeout,
  readBodyWithStall,
  MIN_STALL_TIMEOUT_MS,
} from '../lib/core/net/stall-signal.js';

/** 等 ms 毫秒：等的是信号状态变化，不是推进流程。 */
function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

test('readBodyWithStall：逐块读取时续命，慢速但持续传输不会被判超时', async () => {
  let arms = 0;
  const guard = {
    arm: () => { arms += 1; },
  };
  // 造一个分 3 块吐出的流
  const chunks = [Buffer.from('abc'), Buffer.from('def'), Buffer.from('ghi')];
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
      controller.close();
    },
  });
  const buffer = await readBodyWithStall({ body }, guard);
  assert.equal(buffer.toString('utf8'), 'abcdefghi');
  assert.equal(arms, 3, '每读到一块都应调一次 arm() 续命');
});

test('readBodyWithStall：没有 body 流时退回 arrayBuffer（兼容桩实现）', async () => {
  const guard = { arm: () => { throw new Error('不该被调用'); } };
  const buffer = await readBodyWithStall({ arrayBuffer: async () => Buffer.from('fallback') }, guard);
  assert.equal(buffer.toString('utf8'), 'fallback');
});

test('createStallSignal：拿到响应头后切到停滞判据，建连上限失效', async () => {
  const guard = createStallSignal({ stallMs: 500, connectMs: 40, label: '测试' });
  try {
    guard.arm();
    await sleep(120);
    assert.equal(guard.signal.aborted, false, '建连上限不该在传输阶段再生效');
  } finally {
    guard.disarm();
  }
});

test('createStallSignal：真的没有新数据时按停滞阈值中止', async () => {
  const guard = createStallSignal({ stallMs: 40, connectMs: 5000, label: '测试' });
  try {
    guard.arm();
    await sleep(120);
    assert.equal(guard.signal.aborted, true);
    assert.match(guard.stallReason(), /停滞/);
  } finally {
    guard.disarm();
  }
});

test('normalizeStallTimeout：过小抬到下限、非法回落默认', () => {
  assert.equal(normalizeStallTimeout(3000) >= MIN_STALL_TIMEOUT_MS, true);
  assert.equal(normalizeStallTimeout(0, 1234), 1234);
  assert.equal(normalizeStallTimeout('x', 1234), 1234);
  assert.equal(normalizeStallTimeout(60000), 60000);
});
