/**
 * 门禁：lib/ 里禁止任何硬编码路径
 *
 * 规则不存在豁免：需要非标准位置时，走**外置配置**（`<DSH_HOME>/useful-tools/config.json`）
 * 或**参数 / 环境变量**，不写进代码。
 *
 * 为什么必须做成静态门禁：这类问题**单元测试与 CI 都看不见**——
 *   测试跑在与开发机相同的平台，`process.env.HOME` 有值、`/tmp` 存在、路径都拼得对，断言全绿；
 *   CI 又固定 ubuntu-latest。只有换到别的平台/别的机器才暴露，那时已经发出去了。
 *
 * 判据（违反即失败）：
 *   ① `process.env.HOME` —— 应使用 `os.homedir()`（Windows 上 HOME 通常不存在，会拼出相对路径）
 *   ② `process.env.TMPDIR` —— 应使用 `os.tmpdir()`（Windows 用 TEMP/TMP）
 *   ③ 本机锚定路径 `/volume<N>/`、`/vol<N>/`、`/var/packages/`、`@appstore`、`@appdata` —— 换机即失效
 *   ④ 字面量 `'/tmp'` —— 同上
 *   ⑤ Windows 盘符绝对路径 `'C:\\...'`
 *
 * 注释里可以提到这些路径（解释为什么不用它），代码里不行。
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
  { name: '本机锚定路径（换机即失效）', re: /\/volume[0-9]+\/|\/vol[0-9]+\/|\/var\/packages\/|@appstore|@appdata/ },
  { name: "字面量 '/tmp'", re: /['"]\/tmp['"]/ },
  { name: 'Windows 盘符绝对路径', re: /['"][A-Za-z]:[\\/]/ },
];

/** 该行是不是纯注释（注释里提到这些路径是在解释原因，不算违规）。 */
function isCommentLine(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/** 行尾注释里出现的不算违规：把行内注释剥掉后再匹配。 */
function stripTrailingComment(line) {
  const index = line.indexOf('//');
  if (index < 0) return line;
  // 粗略判断：`//` 前若是引号内的字符就不当注释（本仓库没有 URL 字面量，够用）
  return line.slice(0, index);
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

test('lib/ 里禁止写死路径：平台常量走 os.*，非标准位置走配置或参数', () => {
  const violations = [];
  for (const rel of listScripts(LIB_DIR)) {
    const lines = readFileSync(join(LIB_DIR, rel), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (isCommentLine(line)) return;
      const code = stripTrailingComment(line);
      for (const rule of RULES) {
        if (rule.re.test(code)) {
          violations.push(`${rel}:${index + 1}  [${rule.name}]  ${line.trim().slice(0, 120)}`);
        }
      }
    });
  }
  assert.deepEqual(
    violations,
    [],
    `发现写死的路径（改用 os.homedir() / os.tmpdir() / 配置 / 参数）：\n${violations.join('\n')}`,
  );
});

test('DSH 安装根只能来自环境变量、外置配置或上溯，不能来自代码里的候选清单', () => {
  const source = readFileSync(join(LIB_DIR, 'core/preview/locate.js'), 'utf8');
  // 这条是上一条的补充：候选清单若以 join(homedir(), 'XxxProductName') 形式出现，路径正则抓不到，
  //   但它同样是「代码里猜位置」。所以显式断言：安装根候选必须来自配置读取函数。
  assert.match(source, /configuredRootCandidates/, '安装根候选必须从配置读取');
  assert.match(source, /DSH_ROOT/, '必须支持 DSH_ROOT 显式指定');
  const suspicious = source
    .split('\n')
    .filter((line) => !isCommentLine(line))
    .filter((line) => /DeepSeekHarness-NAS|dsh-useful-tools['"]/.test(line));
  assert.deepEqual(suspicious, [], `安装根探测里不应出现产品名常量：\n${suspicious.join('\n')}`);
});
