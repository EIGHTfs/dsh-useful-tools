/**
 * 执行快捷命令：Linux/macOS 用 bash -c，Windows 用 cmd /c，带超时与输出截断。
 *
 * 设计取舍：
 *   · 任何失败都转成结构化结果（ok/exitCode/stderr），不向调用方抛异常——
 *     命令本身报错是「可预期结果」，不是工具故障。
 *   · 输出上限 20000 字符，超出截断并注明：一次 ls -R 之类不该把整个会话上下文刷爆。
 *   · 超时用 SIGKILL（命令可能已经卡死在不可中断状态，SIGTERM 不一定收得掉）。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/** 单次执行回传的最大输出字符数（stdout/stderr 各自计算）。 */
const MAX_OUTPUT_CHARS = 20000;
/** 超时下限：再小的值也按 1 秒算，避免误传 0 时立刻被杀。 */
const MIN_TIMEOUT_MS = 1000;

/** 截断超长输出，并明确告诉调用方被截断了多少。 */
function truncate(text) {
  const value = String(text || '');
  if (value.length <= MAX_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n…（输出超过 ${MAX_OUTPUT_CHARS} 字符，已截断）`;
}

/** 选 shell：Windows 用 cmd，其余优先绝对路径的 bash（PATH 里不一定有）。 */
function shellOf() {
  if (process.platform === 'win32') {
    return { file: 'cmd.exe', toArgs: (command) => ['/c', command] };
  }
  const bash = existsSync('/bin/bash') ? '/bin/bash' : 'bash';
  return { file: bash, toArgs: (command) => ['-c', command] };
}

/**
 * 执行一条 shell 命令。
 * @param {string} command 命令串
 * @param {{timeoutMs?: number, cwd?: string}} [options]
 * @returns {Promise<{ok:boolean, exitCode:number|null, stdout:string, stderr:string, durationMs:number, timedOut?:boolean, error?:string}>}
 */
export function runShellCommand(command, { timeoutMs = 60000, cwd = '' } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const shell = shellOf();
    const limit = Math.max(MIN_TIMEOUT_MS, Number(timeoutMs) || 60000);
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;

    // 统一收口：无论成功/失败/超时，只 resolve 一次
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ durationMs: Date.now() - started, stdout: truncate(stdout), stderr: truncate(stderr), ...extra });
    };

    let child;
    try {
      child = spawn(shell.file, shell.toArgs(String(command)), {
        cwd: cwd || undefined,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({ ok: false, exitCode: null, error: String((error && error.message) || error) });
      return;
    }

    // 数据先攒到内存，超过上限就不再追加（避免超长输出撑爆内存）
    child.stdout.on('data', (chunk) => { if (stdout.length < MAX_OUTPUT_CHARS * 2) stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { if (stderr.length < MAX_OUTPUT_CHARS * 2) stderr += chunk.toString(); });
    child.on('error', (error) => finish({ ok: false, exitCode: null, error: String((error && error.message) || error) }));
    child.on('close', (code) => finish({ ok: code === 0, exitCode: code }));

    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 进程可能已退出 */ }
      finish({ ok: false, timedOut: true, exitCode: null, error: `命令超时（${limit}ms）已终止` });
    }, limit);
  });
}
