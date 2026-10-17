/**
 * 定位 DSH 实例的 start.sh（quick_command 的预置 restart 命令要用它做重启）。
 *
 * 为什么单独探测：预置命令是「用户可 edit 的数据」，但 start.sh 的路径随套件安装位置变化。
 * 探测顺序：DSH_START_SCRIPT 环境变量 > 常见安装位候选 > 空串（调用方保留占位符并提示）。
 */
import { existsSync } from 'node:fs';

/** 常见安装位（换机探测候选；可用 DSH_START_SCRIPT 覆盖）。 */
const START_SCRIPT_CANDIDATES = [
  '/var/packages/DeepSeekHarness-NAS/target/start.sh',
  '/volume1/@appstore/DeepSeekHarness-NAS/start.sh',
];

/**
 * 解析 start.sh 绝对路径。
 * @returns {string} 找到返回路径，找不到返回空串（预置命令里的占位符保持原样，执行时会报错暴露出来）
 */
export function resolveStartScript() {
  const fromEnv = String(process.env.DSH_START_SCRIPT || '').trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const candidate of START_SCRIPT_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return '';
}
