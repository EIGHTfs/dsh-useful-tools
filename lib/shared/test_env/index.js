/**
 * 工具：test_env —— 测试环境（隔离实例）管理：创建 / 启动 / 停止 / 状态
 *
 * 目录即工具名（见 lib/index.js 动态扫描）。实现下沉在 lib/core/test-env/。
 * 用途：起一个与主实例完全隔离的 DSH 实例（独立 DSH_HOME、独立端口），
 *   在里面随便装插件、随便改、随便崩，不碰主实例的会话与配置。
 *
 * 环境目录形态：<root>/<dsh版本>@Save-test（与救援环境的路径约定一致）。
 */
import { createEnv, startEnv, stopEnv, envStatus, detectDshVersion, envRoot, envName } from '../../core/test-env/index.js';

export const description = '测试环境（隔离实例）管理：创建 / 启动 / 停止 / 状态，一个工具四个动作。'
  + '环境是独立 DSH_HOME（默认 <工作区>/<版本>@Save-test）+ 自动分配端口（3083-3182），'
  + '与主实例完全隔离，适合装插件、改代码、验证崩溃恢复。'
  + 'action=status(缺省) | create | start | stop。';

export const parameters = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      description: 'status（状态，缺省）| create（创建）| start（创建并启动）| stop（停止）',
      enum: ['status', 'create', 'start', 'stop'],
    },
    kind: { type: 'string', description: 'test（测试环境，可装插件，缺省）| clean（纯净环境，带插件锁定）', enum: ['test', 'clean'] },
    version: { type: 'string', description: 'DSH 版本（缺省探测：DSH_VERSION 或 DSH_HOME 上一级目录名）' },
    root: { type: 'string', description: '环境根目录（缺省 DSH_WORKSPACE 或 DSH_HOME 上一级「工作区」）' },
    force: { type: 'boolean', description: 'create/start 用：已存在时删除重建（缺省 false，幂等复用）' },
    plugin: { type: 'string', description: 'create/start 用：要装进该环境的插件根目录（缺省不装插件，纯裸环境）' },
    pluginName: { type: 'string', description: 'plugin 的包名（缺省读其 package.json 的 name）' },
    dir: { type: 'string', description: 'stop 用：环境目录（缺省按 kind/version/root 推算）' },
    dshBin: { type: 'string', description: 'start 用：DSH 入口 bin.js 路径（缺省取宿主进程的 process.argv[1]）' },
  },
};

/** 读插件根 package.json 的 name（给 plugin 参数补包名）。 */
async function pluginNameOf(pluginRoot = '') {
  if (!pluginRoot) return '';
  try {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const pkg = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'));
    return String(pkg.name || '');
  } catch {
    return '';
  }
}

/** 工具入口：按 action 分派到测试环境生命周期（契约 C-103 规定导出名为 run）。 */
async function runTestEnv(args = {}) {
  const action = String(args.action || 'status').toLowerCase();
  const kind = String(args.kind || 'test').toLowerCase() === 'clean' ? 'clean' : 'test';
  const version = String(args.version || '') || detectDshVersion();
  const root = String(args.root || '');
  const pluginSrc = String(args.plugin || '');
  const pluginName = String(args.pluginName || '') || (pluginSrc ? await pluginNameOf(pluginSrc) : '');

  if (action === 'create') {
    return createEnv({ kind, version, root, force: args.force === true, pluginSrc, pluginName });
  }
  if (action === 'start') {
    return startEnv({ kind, version, root, force: args.force === true, pluginSrc, pluginName, dshBin: String(args.dshBin || '') });
  }
  if (action === 'stop') {
    const dir = String(args.dir || '') || `${envRoot(root)}/${envName(version, kind)}`;
    return stopEnv({ dir });
  }
  const st = await envStatus({ root, version });
  return { ok: true, ...st };
}

export { runTestEnv as run };
