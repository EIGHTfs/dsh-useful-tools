/**
 * 工具：patch_cifs_write —— 给官方 `@deepseek-ai/dsh-fs-local` 打「chmod 降级」补丁
 *
 * ## 解决什么问题
 *
 * CIFS/SMB 等挂载文件系统不实现 POSIX chmod。官方写入实现 `writeFileAtomic()` 的流程是：
 *
 *     mkdir 临时目录 .xxx.tmpdir → chmod 0700 → open 临时文件 → chmod 0600
 *       → write → fsync → (可选) chmod 目标 mode → rename 到最终路径
 *
 * 第二步 chmod 就抛 `EPERM: operation not permitted, chmod "...tmpdir"`，
 * 导致 write / edit 工具在 CIFS 上一次都写不进去 —— 而目录明明是可写的
 * （`ls -ld` 显示 drwxrwxrwx、`touch` 也成功），极易误判成权限问题。
 *
 * ## 补丁做什么
 *
 * 把三处 chmod 调用包进 `chmodBestEffort()`：
 *   - 只吞「文件系统不支持 chmod」这一类错误（EPERM / ENOTSUP / EOPNOTSUPP）
 *   - 其它错误（EACCES / ENOENT / EIO …）照常抛出，不掩盖真实故障
 *   - **rename 与原子性完全不动** —— 只是「权限收紧」这一步降级为尽力而为
 *
 * ## 为什么做成工具而不是手改
 *
 * 补丁目标是套件安装目录 `node_modules/@deepseek-ai/dsh-fs-local/`，DSH 升级会覆盖。
 * 做成工具后：升级完跑一次 `apply` 即可重打，且带备份与自动回滚。
 *
 * ## 动作
 *
 *   check  （缺省）只读检测：定位文件、是否已打、chmod 是否真的不可用
 *   apply  （dryRun 缺省 true）备份 → 替换 → node --check 校验 → 报告需重启
 *   revert 从最新备份还原
 *
 * ## 生效条件
 *
 * 打完必须**重启 DSH** —— 官方模块在宿主启动时已进 ESM 缓存，热改文件不会重新加载。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 官方包在安装树里的相对位置（从 target 根算起） */
const PKG_REL = path.join('node_modules', '@deepseek-ai', 'dsh-fs-local', 'lib', 'index.js');

/** 补丁标记：文件里出现它即视为「已打补丁」，保证 apply 幂等 */
const PATCH_MARKER = 'chmodBestEffort';

/** helper 插入锚点：官方写入函数签名（用它定位，不依赖行号） */
const ANCHOR_FN = 'async function writeFileAtomic(';

/**
 * 三处需要降级的 chmod 调用。
 * 用「原文 → 改写」成对描述，替换时逐条断言命中次数必须为 1，
 * 命中 0 次（官方改版）或多次（代码结构变化）都直接 abort，绝不盲改。
 */
const PATCH_SITES = [
  {
    name: '临时目录 chmod 0700',
    from: '\t\tawait chmod(stagingDir, 448);',
    to: '\t\tawait chmodBestEffort(() => chmod(stagingDir, 448));',
  },
  {
    name: '临时文件 chmod 0600',
    from: '\t\tawait handle.chmod(384);',
    to: '\t\tawait chmodBestEffort(() => handle.chmod(384));',
  },
  {
    name: '目标 mode chmod',
    from: '\t\tif (mode !== void 0) await handle.chmod(mode);',
    to: '\t\tif (mode !== void 0) await chmodBestEffort(() => handle.chmod(mode));',
  },
];

/** 插入到 writeFileAtomic 之前的 helper 定义 */
const HELPER_SNIPPET = `/** CIFS/SMB 等文件系统不实现 POSIX chmod：权限收紧失败不应中断原子写（只吞不支持类错误，其余照抛）。 */
const CHMOD_UNSUPPORTED_CODES = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP"]);
async function chmodBestEffort(apply) {
	try {
		return await apply();
	} catch (error) {
		if (CHMOD_UNSUPPORTED_CODES.has(error?.code)) return void 0;
		throw error;
	}
}
`;

/**
 * 定位 dsh-fs-local 的 index.js。
 *
 * 探测顺序（不写死单一路径，换机器/换套件名也能用）：
 *   ① 环境变量 DSH_FS_LOCAL_PATH 显式指定
 *   ② 显式传入的 packageRoot + 固定相对路径
 *   ③ 扫 /var/packages/<套件名>/target 下是否存在该相对路径（群晖套件布局）
 */
async function locateTarget({ explicitRoot, explicitFile } = {}) {
  if (explicitFile) {
    try {
      await fs.access(explicitFile);
      return { file: explicitFile, via: '参数指定 explicitFile' };
    } catch {
      throw new Error(`指定的文件不存在：${explicitFile}`);
    }
  }

  if (process.env.DSH_FS_LOCAL_PATH) {
    const f = process.env.DSH_FS_LOCAL_PATH;
    await fs.access(f);
    return { file: f, via: '环境变量 DSH_FS_LOCAL_PATH' };
  }

  if (explicitRoot) {
    const f = path.join(explicitRoot, PKG_REL);
    await fs.access(f);
    return { file: f, via: `参数指定 packageRoot=${explicitRoot}` };
  }

  // 扫群晖套件目录
  const base = '/var/packages';
  const owners = await fs.readdir(base).catch(() => []);
  const hits = [];
  for (const pkg of owners) {
    const f = path.join(base, pkg, 'target', PKG_REL);
    try {
      await fs.access(f);
      hits.push({ pkg, file: f });
    } catch {
      /* 该套件没装 dsh-fs-local，跳过 */
    }
  }

  if (hits.length === 0) {
    throw new Error(
      '未找到 dsh-fs-local/lib/index.js。已尝试：参数 explicitFile / 环境变量 DSH_FS_LOCAL_PATH / /var/packages/*/target。'
      + '可用 parameters.file 显式指定路径。',
    );
  }
  if (hits.length > 1) {
    return {
      file: null,
      via: '/var/packages 扫描',
      ambiguous: hits.map((h) => `${h.pkg} → ${h.file}`),
    };
  }
  return { file: hits[0].file, via: `/var/packages 扫描（套件 ${hits[0].pkg}）` };
}

/**
 * 实测目标目录所在文件系统是否支持 chmod。
 * 不靠「挂载类型猜」——直接建临时文件试一次，拿到真实结论。
 */
async function probeChmodSupport(dir) {
  const probe = path.join(dir, `.chmod-probe-${process.pid}-${Date.now()}`);
  try {
    await fs.writeFile(probe, 'probe');
    try {
      await fs.chmod(probe, 0o600);
      const st = await fs.stat(probe);
      const mode = (st.mode & 0o777).toString(8);
      return { supported: mode === '600', actualMode: mode, detail: 'chmod 未抛错但权限未变（挂载固定 mode）' };
    } catch (error) {
      const code = error?.code;
      if (['EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(code)) {
        return { supported: false, code, detail: `${code}：文件系统不支持 POSIX chmod` };
      }
      return { supported: null, code, detail: `意外错误 ${code}：${error.message}` };
    }
  } finally {
    await fs.rm(probe, { force: true }).catch(() => {});
  }
}

/** 语法校验：用与运行环境同版本的 node 做 --check，避免打进去一个坏文件 */
async function syntaxCheck(file) {
  try {
    await execFileAsync(process.execPath, ['--check', file], { timeout: 30_000 });
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: (error.stderr || error.message || '').slice(0, 600) };
  }
}

/** 找同目录下最新的备份文件 */
async function findLatestBackup(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const entries = await fs.readdir(dir).catch(() => []);
  const backups = entries
    .filter((n) => n.startsWith(`${base}.bak-`))
    .sort()
    .reverse();
  return backups.length > 0 ? path.join(dir, backups[0]) : null;
}

export const description = 'CIFS/SMB 挂载下 write/edit 工具报 EPERM chmod 的官方修复补丁管理器：'
  + '给 @deepseek-ai/dsh-fs-local 的三处 chmod 包上降级容错（只吞 EPERM/ENOTSUP，其余照抛，原子写不受影响）。'
  + 'action=check（缺省，只读检测）/ apply（备份+打补丁+语法校验，dryRun 缺省 true）/ revert（还原备份）。'
  + '打完必须重启 DSH 才生效（官方模块已在宿主 ESM 缓存中）。DSH 升级会覆盖补丁，升级后重跑 apply 即可。';

export const parameters = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['check', 'apply', 'revert'],
      description: 'check=只读检测（缺省）；apply=打补丁；revert=从最新备份还原',
    },
    dryRun: {
      type: 'boolean',
      description: 'apply/revert 时缺省 true（只报计划不落盘）；要真改传 false',
    },
    file: {
      type: 'string',
      description: '可选：显式指定 dsh-fs-local/lib/index.js 的绝对路径（自动探测失败时用）',
    },
    packageRoot: {
      type: 'string',
      description: '可选：套件 target 根目录（如 /var/packages/<套件>/target），自动探测失败时用',
    },
    probeDir: {
      type: 'string',
      description: '可选：check 时探测 chmod 支持性的目录（缺省为当前工作目录）。要探测挂载盘就把挂载路径传进来',
    },
  },
  additionalProperties: false,
};

/**
 * @param {{action?: string, dryRun?: boolean, file?: string, packageRoot?: string}} args
 */
export async function run(args = {}) {
  const action = args.action || 'check';
  const dryRun = args.dryRun !== false;

  // ── 定位目标文件 ─────────────────────────────────────────────
  const located = await locateTarget({ explicitFile: args.file, explicitRoot: args.packageRoot });
  if (located.ambiguous) {
    return {
      ok: false,
      action,
      error: '找到多个候选，请用 parameters.file 或 packageRoot 指定',
      candidates: located.ambiguous,
    };
  }
  const target = located.file;

  // ── check：只读检测 ─────────────────────────────────────────
  if (action === 'check') {
    const src = await fs.readFile(target, 'utf8');
    const patched = src.includes(PATCH_MARKER);
    // 逐个核对补丁点是否还认得出来（官方改版会让特征串失效）
    const sites = PATCH_SITES.map((s) => ({
      name: s.name,
      present: src.includes(s.from) || src.includes(s.to),
      patchedForm: src.includes(s.to),
    }));
    // 探测点必须是「用户实际要写的目录」，不是官方包所在目录 ——
    // 官方包通常在本地盘（chmod 正常），拿它探测会得出「不需要补丁」的错误结论。
    const probeDir = args.probeDir || process.cwd();
    const probe = await probeChmodSupport(probeDir);
    const backup = await findLatestBackup(target);

    return {
      ok: true,
      action: 'check',
      target,
      locatedVia: located.via,
      patched,
      sites,
      chmodProbe: probe,
      latestBackup: backup,
      assessment: patched
        ? (probe.supported === false ? '已打补丁，且该文件系统确实不支持 chmod —— 若工具仍报错，说明进程未重启' : '已打补丁，但当前文件系统支持 chmod（补丁是空转，无害）')
        : (probe.supported === false ? '未打补丁，且 chmod 确实不可用 —— 建议 apply' : '未打补丁，chmod 正常 —— 无需处理'),
      needRestartToTakeEffect: patched,
    };
  }

  // ── revert：从最新备份还原 ───────────────────────────────────
  if (action === 'revert') {
    const backup = await findLatestBackup(target);
    if (!backup) {
      return { ok: false, action: 'revert', target, error: '同目录下没有任何 .bak- 备份，无法还原' };
    }
    if (dryRun) {
      return { ok: true, action: 'revert', dryRun: true, target, wouldRestoreFrom: backup, note: 'dryRun，未落盘；传 dryRun:false 真还原' };
    }
    await fs.copyFile(backup, target);
    const check = await syntaxCheck(target);
    return {
      ok: check.ok,
      action: 'revert',
      target,
      restoredFrom: backup,
      syntaxCheck: check,
      needRestartToTakeEffect: true,
    };
  }

  // ── apply：打补丁 ───────────────────────────────────────────
  const original = await fs.readFile(target, 'utf8');

  if (original.includes(PATCH_MARKER)) {
    return {
      ok: true,
      action: 'apply',
      target,
      alreadyPatched: true,
      note: '已是补丁状态，未做任何改动（幂等）。若工具仍报 chmod 错误，检查是否尚未重启 DSH。',
    };
  }

  // 逐个断言补丁点命中次数，任何异常都 abort（绝不盲改官方代码）
  const hits = [];
  for (const site of PATCH_SITES) {
    const n = original.split(site.from).length - 1;
    hits.push({ name: site.name, expected: 1, actual: n });
  }
  const anchorCount = original.split(ANCHOR_FN).length - 1;
  const bad = hits.filter((h) => h.actual !== 1) || [];
  if (bad.length > 0 || anchorCount !== 1) {
    return {
      ok: false,
      action: 'apply',
      target,
      error: '补丁点无法唯一定位（官方实现可能已变更），已中止，未修改任何文件',
      sites: hits,
      anchor: { name: ANCHOR_FN, expected: 1, actual: anchorCount },
      hint: '请先跑 action=check 看 sites，再按新代码结构更新本工具的 PATCH_SITES',
    };
  }

  // 组装新内容
  let patched = original.replace(ANCHOR_FN, HELPER_SNIPPET + ANCHOR_FN);
  for (const site of PATCH_SITES) {
    patched = patched.replace(site.from, site.to);
  }

  if (dryRun) {
    const before = original.split('\n').length;
    const after = patched.split('\n').length;
    return {
      ok: true,
      action: 'apply',
      dryRun: true,
      target,
      sites: hits,
      linesBefore: before,
      linesAfter: after,
      note: 'dryRun，未落盘；传 dryRun:false 真打补丁',
    };
  }

  // 真打：备份 → 写入 → 语法校验 → 失败自动回滚
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const backupPath = `${target}.bak-${stamp}`;
  await fs.copyFile(target, backupPath);

  await fs.writeFile(target, patched, 'utf8');
  const check = await syntaxCheck(target);
  if (!check.ok) {
    await fs.copyFile(backupPath, target);
    return {
      ok: false,
      action: 'apply',
      target,
      error: '补丁后语法校验失败，已自动回滚到备份',
      backupPath,
      syntaxCheck: check,
    };
  }

  return {
    ok: true,
    action: 'apply',
    target,
    backupPath,
    sites: hits,
    syntaxCheck: check,
    needRestartToTakeEffect: true,
    restartHint: '必须重启 DSH 才生效（官方模块已在宿主 ESM 缓存中）：synopkg restart <套件名>，或你惯用的重启方式。',
  };
}

export default { description, parameters, run };
