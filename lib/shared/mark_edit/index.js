/**
 * 工具：mark_edit —— 写改后自动续期（**全局生效**，与 mark_read 同口径）
 *
 * 目录即工具名（见 lib/index.js 动态扫描）。实现下沉在 lib/core/mark-edit/。
 *
 * 与 mark_read 完全对称：
 *   mark_read —— 配一次命令集合 ⇒ 集合里的命令读过的**所有文件**自动补发观测（不用指定文件）。
 *   mark_edit —— 开关打开（缺省开）⇒ **所有经 write / edit 改过的文件**写完后自动按稳定版本补发观测
 *                （同样不用指定文件），因此连续编辑不必重读。
 *
 * 为什么需要：官方写改后补发的版本是「rename 后立刻 probe」的值，而版本串含 mtimeNs/ctimeNs，
 *   CIFS/SMB 上时间戳会晚到再变（实测 3ms）⇒ 下一次写改 CAS 对不上 ⇒ `file changed since it was read`。
 */
import { runMarkEdit } from '../../core/mark-edit/index.js';

export const description = '写改后自动续期（全局生效，与 mark_read 对称）：缺省开启——所有经 write / edit 改过的文件，'
  + '写完后延迟若干毫秒重新取版本并补发观测，连续编辑不必重读、也不会再报 `file changed since it was read`。'
  + '直接调用可查询/修改配置：enabled 开关、settleMs 延迟毫秒（缺省 1100（实测 CIFS 漂移点 ~1000ms），上限 2000）。'
  + '另外两条用途：paths 补标**没走 write/edit** 的改动（bash 的 sed -i / heredoc / tee、别的会话写入）；undo 撤销这些补标。'
  + '注意：补标不读文件内容，只在自己确实经手写入时用。';

export const parameters = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean', description: '全局续期开关（落盘长期有效）；不传则不改' },
    settleMs: { type: 'number', description: '写改后延迟多少毫秒再取版本（等 CIFS 时间戳写稳）；缺省 1100（实测 CIFS 漂移点 ~1000ms），上限 2000；不传则不改' },
    paths: { type: 'string', description: '可选：额外补标的文件（逗号 / 分号 / 换行分隔，或 @清单文件）——用于没走 write/edit 的改动' },
    undo: { type: 'boolean', description: 'true = 对 paths 里这些文件补发对不上的版本，恢复「先读再改」门禁' },
  },
};

/** 工具入口（契约 C-103 规定导出名为 run；内部用表意名后起别名）。 */
async function runMarkEditTool(args = {}, toolCtx = {}) {
  return runMarkEdit(args, toolCtx);
}

export { runMarkEditTool as run };
