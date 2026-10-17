/**
 * 工具：quick_command —— 快捷命令（定义存 <DSH_HOME>/useful-tools/quick-commands.json）
 *
 * 动作（action）：
 *   run（缺省）—— 按 name 执行已定义命令；**同时传 command 时先持久化（新增或更新）再执行**，
 *                  语义是「等效 add 后执行」，不是临时执行。
 *   add        —— 新增定义（name + command；已存在要改走 edit/run）
 *   edit       —— 修改已有定义（name + command/description 至少一项）
 *   delete     —— 删除定义
 *   list       —— 列出全部定义
 *
 * 安全边界：执行的是本机 shell 命令，stdout/stderr 会回传给调用方；
 *   预置 restart 会重启 DSH、断开当前连接，调用前确认。
 */
import { NAME_RE, readStore, writeStore } from '../../core/quick-command/store.js';
import { runShellCommand } from '../../core/quick-command/exec.js';

export const description = '快捷命令：执行/管理 <DSH_HOME>/useful-tools/quick-commands.json 里定义的命令。'
  + 'action=run（缺省）：按 name 执行；同时传 command 会先写入 JSON（新增或更新）再执行，等效 add 后执行。'
  + 'action=add/edit/delete/list 管理定义。注意：执行的是本机 shell 命令；预置 restart 会重启 DSH 并断开当前连接。';

export const parameters = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['run', 'add', 'edit', 'delete', 'list'], description: '动作，缺省 run' },
    name: { type: 'string', description: '快捷名（run/add/edit/delete 用；只允许字母数字 _ . -）' },
    command: { type: 'string', description: '命令串（add 必填；run 传了会先持久化再执行；edit 可改）' },
    description: { type: 'string', description: '说明文字（add/edit 可选）' },
    timeoutMs: { type: 'number', description: 'run 的超时毫秒，缺省 60000' },
  },
};

/** 统一失败返回，避免各分支字段不一致。 */
function fail(error, extra = {}) {
  return { ok: false, error, ...extra };
}

/**
 * 工具入口（契约 C-103 规定导出名为 run）。
 * 内部用表意名，末尾以 `export { runQuickCommand as run }` 起别名导出。
 */
async function runQuickCommand(args = {}) {
  const action = String(args.action || 'run').trim().toLowerCase();
  const name = String(args.name || '').trim();
  const command = String(args.command || '').trim();
  const note = String(args.description || '').trim();

  // ── list：只读，直接回定义表 ──
  if (action === 'list') {
    const store = readStore();
    if (!store.ok) return fail(store.error);
    return {
      ok: true,
      action: 'list',
      path: store.path,
      preset: store.preset === true,
      count: Object.keys(store.items).length,
      items: store.items,
      // 数组形态：直接给出「名字 → 命令」，便于一眼看完所有快捷命令
      list: Object.entries(store.items).map(([name, def]) => ({
        name,
        command: def.command,
        description: def.description,
      })),
    };
  }

  // ── run：按 name 执行；带 command 时先 upsert 再执行 ──
  if (action === 'run') {
    if (!name && !command) return fail('run 需要 name（执行已定义命令）或 name + command（持久化后执行）');
    if (!name) return fail('run 传 command 时必须同时给 name——命令要持久化进 quick-commands.json');
    if (!NAME_RE.test(name)) return fail(`快捷名不合法（只允许字母数字 _ . -）：${name}`);

    const store = readStore();
    if (!store.ok) return fail(store.error);

    let def = store.items[name];
    let persisted = false;
    // 带 command：等效 add 后执行——不存在则新增，存在则更新命令（description 没传就保留原值）
    if (command) {
      const items = { ...store.items };
      items[name] = { command, description: note || def?.description || '' };
      const written = writeStore(items);
      if (!written.ok) return fail(written.error);
      def = items[name];
      persisted = true;
    }
    if (!def || !def.command) {
      return fail(`未定义快捷命令：${name}`, { path: store.path, names: Object.keys(store.items) });
    }

    const result = await runShellCommand(def.command, { timeoutMs: args.timeoutMs });
    return {
      ok: result.ok,
      action: 'run',
      name,
      command: def.command,
      description: def.description,
      persisted,
      path: store.path,
      ...result,
    };
  }

  // ── add / edit / delete：都要 name ──
  if (!name) return fail(`${action} 需要 name`);
  if (!NAME_RE.test(name)) return fail(`快捷名不合法（只允许字母数字 _ . -）：${name}`);

  const store = readStore();
  if (!store.ok) return fail(store.error);
  const items = { ...store.items };

  if (action === 'add') {
    if (!command) return fail('add 需要 command');
    if (items[name]) return fail(`已存在快捷命令：${name}（改用 edit 修改，或 run 传 command 更新后执行）`);
    items[name] = { command, description: note };
    const written = writeStore(items);
    if (!written.ok) return fail(written.error);
    return { ok: true, action: 'add', name, ...items[name], path: written.path };
  }

  if (action === 'edit') {
    if (!items[name]) return fail(`未定义快捷命令：${name}（改用 add 新增）`, { names: Object.keys(items) });
    if (!command && !note) return fail('edit 需要 command 或 description 至少一项');
    items[name] = {
      command: command || items[name].command,
      description: note || items[name].description,
    };
    const written = writeStore(items);
    if (!written.ok) return fail(written.error);
    return { ok: true, action: 'edit', name, ...items[name], path: written.path };
  }

  if (action === 'delete') {
    if (!items[name]) return fail(`未定义快捷命令：${name}`, { names: Object.keys(items) });
    const removed = items[name];
    delete items[name];
    const written = writeStore(items);
    if (!written.ok) return fail(written.error);
    return {
      ok: true,
      action: 'delete',
      name,
      removed,
      path: written.path,
      remaining: Object.keys(items),
    };
  }

  return fail(`未知 action：${action}（可用 run / add / edit / delete / list）`);
}

export { runQuickCommand as run };
