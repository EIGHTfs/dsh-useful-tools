/**
 * 停滞超时（stall / idle timeout）——下载与拉取共用的判据
 *
 * 为什么需要单独成模块：判定「传输该不该判失败」的规则一旦有两份实现，就必然漂移。
 *   这里收敛成唯一实现，下载工具与插件源码拉取都调它。
 *
 * 核心规则（踩过才写的）：
 *   · 不能用「总时长」判失败：慢速大文件必然中途被判超时，配合「失败删半成品」
 *     就是「明明在下载却判失败、清空重下」，多个源轮流重复同一段，最后一个字节都留不下。
 *   · 判失败的正确依据是「连续一段时间没有任何新数据」。
 *   · 建连（TCP+TLS+等响应头）与传输是两个语义：前者该有上限（对端可能永远不回），
 *     拿到响应头后必须切到停滞判据。
 *   · 停滞阈值要有下限：调用方传几秒「想快点失败」时，健康链路会在握手/回源冷启动阶段被误杀。
 */

/** 建连（TCP+TLS+等响应头）超时：这一段确实该有上限。 */
export const CONNECT_TIMEOUT_MS = 20000;

/** 停滞阈值下限：低于它一律抬高，避免握手阶段误杀健康链路。 */
export const MIN_STALL_TIMEOUT_MS = 15000;

/**
 * 创建带停滞判据的中止信号。
 *
 * 用法：创建即开始按 connectMs 计时；拿到响应头后调 arm() 切到 stallMs 判据；
 *       每收到一块数据再调 arm() 续命；结束（成功/失败/取消）调 disarm()。
 *
 * @param {{stallMs:number, connectMs?:number, externalSignal?:AbortSignal|null, label?:string}} options
 * @returns {{signal:AbortSignal, arm:Function, disarm:Function, stallReason:Function}}
 */
export function createStallSignal({ stallMs, connectMs = CONNECT_TIMEOUT_MS, externalSignal = null, label = '传输' }) {
  const controller = new AbortController();
  let timer = null;
  let reason = '';
  let phase = 'connect';

  const schedule = (ms, why) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      reason = why;
      controller.abort(why);
    }, ms);
    // 看门狗不该把进程钉住
    if (typeof timer.unref === 'function') timer.unref();
  };

  const armConnect = () => {
    phase = 'connect';
    schedule(connectMs, `${label}建连超时（${Math.round(connectMs / 1000)}s 内未拿到响应头）`);
  };

  const arm = () => {
    if (phase === 'connect') phase = 'stream';
    schedule(stallMs, `${label}停滞超过 ${Math.round(stallMs / 1000)}s（期间没有新数据）`);
  };

  const disarm = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  if (externalSignal) {
    if (externalSignal.aborted) controller.abort('cancelled');
    else externalSignal.addEventListener('abort', () => controller.abort('cancelled'), { once: true });
  }

  armConnect();
  return { signal: controller.signal, arm, disarm, stallReason: () => reason };
}

/** 归一化停滞阈值：非正数/非数字回落默认值，过小抬到下限。 */
export function normalizeStallTimeout(rawTimeoutMs, defaultMs = 300000) {
  const parsed = Number(rawTimeoutMs);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultMs;
  return Math.max(MIN_STALL_TIMEOUT_MS, Math.trunc(parsed));
}

/**
 * 读完响应体，边读边续命。
 *
 * 为什么不直接 await response.arrayBuffer()：那是一次性调用，中途没有钩子，
 * 无法在「数据还在流」时重置停滞计时器 —— 等于又退回按总时长判死。
 * 这里逐块读，每块调一次 arm()。
 *
 * 兼容没有 body 流的实现（部分测试桩/自定义 fetchImpl 只给 arrayBuffer）。
 *
 * @param {Response|object} response fetch 的响应
 * @param {{arm:Function}} guard createStallSignal 的返回
 * @returns {Promise<Buffer>}
 */
export async function readBodyWithStall(response, guard) {
  const body = response?.body;
  if (!body || typeof body.getReader !== 'function') {
    // 没有流可读：退回一次性读取（此时只能靠调用方的建连/总上限兜底）
    return Buffer.from(await response.arrayBuffer());
  }
  const reader = body.getReader();
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      guard.arm();
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { reader.releaseLock(); } catch { /* 忽略释放失败 */ }
  }
  return Buffer.concat(chunks);
}
