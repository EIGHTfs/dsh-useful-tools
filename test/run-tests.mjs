/**
 * 跨平台测试入口：自己扫描 test/*.test.mjs，把文件列表交给 node --test。
 *
 * 为什么不用 glob：`node --test "test/*.test.mjs"` 依赖 Node 自己展开 glob（Node 20 不支持），
 *   Windows 的 shell 也不会展开通配符；显式传文件列表在 Node 20/22/24 + Windows/Linux 上行为一致。
 * 为什么随时扫描：新增测试文件不需要改这里，也不会漏跑。
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// 只认 *.test.mjs：与契约 C-601 的命名一致，避免把辅助脚本当测试跑
const files = readdirSync(HERE)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => join(HERE, name));

if (files.length === 0) {
  console.error('没有找到 *.test.mjs 测试文件');
  process.exit(1);
}

// 用当前 Node 可执行文件跑，继承 stdio 让 TAP 输出直通
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
