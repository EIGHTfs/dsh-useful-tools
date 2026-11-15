/**
 * 把下载注册为宿主官方后台 job（`ctx.jobs`，由 base bundle 的 jobs-local 提供）。
 *
 * 为什么需要：大文件下载会阻塞工具调用直到传输结束，期间调用方只能干等。
 * 注册成 job 后工具立即返回 jobId，用宿主原生的 job_output / job_list / job_kill
 * 查询进度与中止——与 git_clone / git_push / npm_publish 同一套体验。
 *
 * 宿主契约（实测自 dsh-jobs-local 的 start()）：
 *   · spec 必填 kind（非空串）、label（非空串）、run；
 *   · run(handle) 必须返回 { cancel, done }：cancel 供 job_kill 调用，done 是
 *     Promise<{ status, detail? }>，status 决定 job 最终状态；
 *   · handle 提供 append(text) 与 updateProgress(line)，可写进度与输出；
 *   · jobId 形如 `<kind>-<uuid16>`。
 *
 * owner 语义：必须是**有活 agent 的会话 id 字符串**，否则 resolveOwner 抛
 * 「session ... has no live agent」。带 owner 失败不等于不能后台化——退一步用
 * 无主注册通常仍能拿到 jobId；两步都失败才降级同步，并把原因带回结果。
 */

/** 宿主 job 的 kind，用于 jobId 前缀与列表归类。 */
export const DOWNLOAD_JOB_KIND = 'github-download';

/** 进度写盘的最小间隔字节数：太频繁会把 job 输出刷爆，太稀疏又看不出在动。 */
const PROGRESS_STEP_BYTES = 4 * 1024 * 1024;

/**
 * 组装一个下载 job 的 spec。
 *
 * @param {{url: string, fileName: string, savePath: string}} meta 仅用于 label 与进度文案
 * @param {(signal: AbortSignal, onProgress: (bytes: number) => void) => Promise<object>} doDownload
 *   真正执行下载；必须响应 signal 以便 job_kill 能真的中断传输
 * @returns {{kind: string, label: string, run: (handle: object) => {cancel: Function, done: Promise<object>}}}
 */
export function buildDownloadJobSpec(meta, doDownload) {
  const fileName = String(meta?.fileName || '').trim();
  const label = fileName ? `download ${fileName}` : `download ${String(meta?.url || '').slice(0, 80)}`;
  return {
    kind: DOWNLOAD_JOB_KIND,
    label,
    run: (handle) => {
      // AbortController 让 job_kill 能真正掐断正在进行的 fetch——
      //   没有它 cancel 只能改个布尔标记，传输会继续跑到超时。
      const controller = new AbortController();
      let lastReportedBytes = 0;
      const onProgress = (bytesWritten) => {
        if (bytesWritten - lastReportedBytes < PROGRESS_STEP_BYTES) return;
        lastReportedBytes = bytesWritten;
        try {
          handle?.updateProgress?.(`已下载 ${(bytesWritten / (1024 * 1024)).toFixed(1)} MB`);
        } catch { /* 进度写失败不影响下载 */ }
      };
      const done = (async () => {
        try {
          handle?.append?.(`开始下载 ${meta?.url || ''}\n→ ${meta?.savePath || ''}`);
          const result = await doDownload(controller.signal, onProgress);
          const finished = result?.ok === true;
          // 状态值必须用宿主枚举：running / stopping / completed / killed / failed。
          //   写成 succeeded 会在 job_output 里被 schema 校验拒掉
          //   （报 "value.job.status must be one of [...]"），实测踩过。
          return {
            status: finished ? 'completed' : 'failed',
            detail: finished ? `下载完成：${meta?.savePath || ''}` : String(result?.error || '下载失败'),
          };
        } catch (error) {
          return { status: 'failed', detail: String((error && error.message) || error) };
        }
      })();
      return { cancel: () => controller.abort('job-cancelled'), done };
    },
  };
}

/**
 * 注册 job：先带 owner 试，失败再退「无主」试一次。
 *
 * 两步都失败才返回 error（由调用方降级同步），原因一并带回——
 * 静默降级会让「为什么没拿到 jobId」变成一个只能靠猜的问题。
 *
 * @returns {{jobId?: string, error?: string}}
 */
export function startHostJob(jobs, spec, owner) {
  const reasons = [];
  if (owner) {
    try { return { jobId: jobs.start({ ...spec, owner }) }; } catch (error) { reasons.push(`owner=${owner} 失败：${(error && error.message) || error}`); }
  }
  try { return { jobId: jobs.start(spec) }; } catch (error) { reasons.push(`unowned 失败：${(error && error.message) || error}`); }
  return { error: reasons.join(' ｜ ') };
}
