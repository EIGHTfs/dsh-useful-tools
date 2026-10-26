/**
 * 工具：mark_edit —— 编辑后标记（把「我刚改过这些文件」补发给宿主，并落盘记着）
 *
 * 目录即工具名（见 lib/index.js 动态扫描）。实现下沉在 lib/core/mark-edit/。
 *
 * 与 mark_read 的分工与对称性：
 *   mark_read —— 管「**读**了什么算已知」：配命令集合，集合里的命令读过的文件自动补发观测（落盘、可撤销）。
 *   mark_edit —— 管「**写**过什么算已知」：标记指定文件，按当前磁盘版本补发观测（**同样落盘、可撤销**）；
 *                不传 paths 时用清单续期，对应 mark_read「不传 commands 用预置清单」。
 *
 * 解决的是官方补不到 / 补不稳的缺口：版本串含 mtimeNs+ctimeNs，CIFS 上写入后时间戳会晚到地再变，
 *   官方「写完立刻 probe」记下的是稳定前的值 ⇒ 下一次写改 CAS 对不上，报
 *   `file changed since it was read`。本工具在标记时（可选延迟）取稳定值。
 *
 * 同一通道：`fs/observed` + `fs.stat()` 现取的 version（宿主自己补发用的就是这条 recipe）。
 */
import { runMarkEdit } from '../../core/mark-edit/index.js';

export const description = '编辑后标记：把「我刚改过这些文件」按当前磁盘版本补发给宿主，之后 write/edit 不必重读全文，'
  + '清单落盘持久（跨重启有效、可 undo 撤销）；不传 paths 时用清单续期。'
  + '专治「连续编辑 / 文件被 bash（sed -i、heredoc、tee）或别的工具改过 ⇒ file changed since it was read」。'
  + '参数 paths 是文件路径（逗号 / 分号 / 换行分隔，也可传 @清单文件）；undo 撤销；settleMs 可选延迟毫秒（等文件系统时间戳写稳，默认 0 = 立即）。'
  + '注意：本工具不读文件内容，只声明「这份文件现在是什么」——只在自己确实经手写入时用。';

export const parameters = {
  type: 'object',
  properties: {
    paths: { type: 'string', description: '文件路径，逗号 / 分号 / 换行分隔；或 @清单文件（文件内每行或逗号一个路径）。不传 = 用持久清单续期' },
    undo: { type: 'boolean', description: 'true = 撤销标记（从持久清单移除，并补发必然对不上的版本，使这些文件重新要求先读）' },
    settleMs: { type: 'number', description: '可选：延迟多少毫秒再取版本（等 CIFS 等文件系统把 mtime/ctime 写稳）；缺省 0 = 立即，上限 2000' },
  },
};

/** 工具入口（契约 C-103 规定导出名为 run；内部用表意名后起别名）。 */
async function runMarkEditTool(args = {}, toolCtx = {}) {
  return runMarkEdit(args, toolCtx);
}

export { runMarkEditTool as run };
