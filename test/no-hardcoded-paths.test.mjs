/**
 * 门禁：禁止在 lib/ 里写死平台路径常量
 *
 * 为什么需要这道门禁：这类问题**单元测试和 CI 都看不见**——
 *   测试跑在与开发机相同的平台，`process.env.HOME` 在 Linux 上有值、`/tmp` 存在、
 *   `process.chdir` 行为一致，断言全绿；换到 Windows 才暴露。
 *   CI 又固定 ubuntu-latest。所以只能靠静态扫描把规则钉死。
 *
 * 判据（违反即失败）：
 *   ① `process.env.HOME` —— 应使用 `os.homedir()`（Windows 上 HOME 通常不存在，会拼出相对路径）
 *   ② `process.env.TMPDIR` —— 应使用 `os.tmpdir()`（Windows 用 TEMP/TMP）
 *   ③ 本机锚定路径 `/volume<N>/`、`/vol<N>/`、`/var/packages/`、`@appstore`、`@appdata` —— 换机即失效
 *   ④ 字面量 `'/tmp'` —— 同上
 *   ⑤ Windows 盘符绝对路径 `'C:\\...'` —— 硬编码在代码里没有意义
 *
 * 允许的例外：行内含 `dsh-allow-cross-platform` 注释。
 *   目前只有「DSH 安装根候选」用到——安装根没有统一环境变量，只能探测，
 *   且必须同时具备 DSH_ROOT 覆盖入口与上溯兜底（见契约 C-125）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB_DIR = fileURLToPath(new URL('../lib', import.meta.url));

/** 违规模式。加规则时同步补上面的文档注释。 */
const RULES = [
  { name: 'process.env.HOME（应使用 os.homedir()）', re: /process\.env\.HOME\b/ },
  { name: 'process.env.TMPDIR（应使用 os.tmpdir()）', re: /process\.env\.TMPDIR\b/ },
  {
    name: '本机锚定路径（换机即失效）',
    // 只认「行首就是路径字面量」或「join/resolve 直接吃本机路径」这两种**真在用的**形态；
    // 文案里提到路径（错误提示、参数说明）不算——那不是逻辑，也不会让程序走错目录。
    re: /^\s*['"](?:\/volume[0-9]+|\/vol[0-9]+|\/var\/packages)\/|(?:join|resolve)\(\s*['"](?:\/volume[0-9]+|\/vol[0-9]+|\/var\/packages)/,
  },
  { name: "字面量 '/tmp'", re: /['"]\/tmp['"]/ },
  { name: 'Windows 盘符绝对路径', re: /['"][A-Za-z]:[\\/]/ },
];

/** 行内豁免标记。 */
const ALLOW_MARK = 'dsh-allow-cross-platform';

/** 该行是不是纯注释（注释里提到 process.env.HOME 是在解释原因，不算违规）。 */
function isCommentLine(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/** 递归列出 lib 下的脚本文件。 */
function listScripts(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listScripts(join(dir, entry.name), rel));
    else if (/\.(js|mjs)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

test('lib/ 里不得写死平台路径常量（HOME / TMPDIR / 本机锚定路径 / 字面量 /tmp）', () => {
  const violations = [];
  for (const rel of listScripts(LIB_DIR)) {
    const lines = readFileSync(join(LIB_DIR, rel), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (isCommentLine(line) || line.includes(ALLOW_MARK)) return;
      for (const rule of RULES) {
        if (rule.re.test(line)) {
          violations.push(`${rel}:${index + 1}  [${rule.name}]  ${line.trim().slice(0, 120)}`);
        }
      }
    });
  }
  assert.deepEqual(
    violations,
    [],
    `发现写死的平台路径常量（应改用 os.homedir() / os.tmpdir() / 环境变量）：\n${violations.join('\n')}`,
  );
});

test('豁免标记只用于「安装根候选」这种确有必要的地方', () => {
  const marked = [];
  for (const rel of listScripts(LIB_DIR)) {
    const lines = readFileSync(join(LIB_DIR, rel), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (line.includes(ALLOW_MARK)) marked.push({ file: rel, line: index + 1, text: line.trim() });
    });
  }
  // 豁免必须连带有 DSH_ROOT 覆盖入口，否则就是真的写死
  for (const item of marked) {
    assert.match(
      item.text,
      /DSH_ROOT|@appstore|@appdata|\/var\/packages/,
      `豁免应只落在安装根候选行：${item.file}:${item.line}`,
    );
  }
  assert.equal(marked.length <= 5, true, `豁免点过多（${marked.length} 处），检查是否在滥用豁免`);
});
