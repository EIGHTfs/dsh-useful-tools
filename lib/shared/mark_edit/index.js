/**
 * 工具：mark_edit —— 编辑后标记（把「我刚改过这些文件」补发给宿主）
 *
 * 目录即工具名（见 lib/index.js 动态扫描）。实现下沉在 lib/core/mark-edit/。
 *
 * 与 mark_read 的分工：
 *   mark_read —— 管「**读**了什么算已知」：命令集合里的命令读过的文件自动补发观测；
 *   mark_edit —— 管「**写**过什么算已知」：把指定文件按当前磁盘版本补发观测。
 *
 * 解决的是官方补不到的缺口：官方 write/edit 成功后会自己补发观测，
 *   但 bash 里的 `sed -i` / heredoc 重定向 / `tee`、别的工具或别的会话改过的文件没人补，
 *   于是下一次 edit 报 `file changed since it was read`，只能重读全文。
 *
 * 同一通道：`fs/observed` + `fs.stat()` 现取的 version（宿主自己补发用的就是这条 recipe）。
 */
import { runMarkEdit } from '../../core/mark-edit/index.js';

export const description = '编辑后标记：把「我刚改过这些文件」按当前磁盘版本补发给宿主，后续 write/edit 不必重读全文。'
  + '专治「文件被 bash（sed -i / heredoc / tee）或别的工具改过 ⇒ file changed since it was read」。'
  + '参数 paths 是文件路径（逗号 / 分号 / 换行分隔，也可传 @清单文件）；参数 undo 撤销标记（重新要求先读）。'
  + '注意：本工具不读文件内容，只声明「这份文件现在是什么」——只在自己确实经手写入时用。';

export const parameters = {
  type: 'object',
  properties: {
    paths: { type: 'string', description: '文件路径，逗号 / 分号 / 换行分隔；或 @清单文件（文件内每行或逗号一个路径）' },
    undo: { type: 'boolean', description: 'true = 撤销标记（补发必然对不上的版本，使这些文件重新要求先读）；缺省 = 标记' },
  },
};

/** 工具入口（契约 C-103 规定导出名为 run；内部用表意名后起别名）。 */
async function runMarkEditTool(args = {}, toolCtx = {}) {
  return runMarkEdit(args, toolCtx);
}

export { runMarkEditTool as run };
