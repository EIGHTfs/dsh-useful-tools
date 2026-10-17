/** bash 命令解析回归：extractBashReads 从命令串里提取「集合内命令读过的文件」。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractBashReads } from '../lib/core/mark-read/hook.js';

test('集合内命令：提取文件参数', () => {
  assert.deepEqual(extractBashReads('cat a.txt', ['cat']), ['a.txt']);
  assert.deepEqual(extractBashReads('cat a.txt b.txt', ['cat']), ['a.txt', 'b.txt']);
});

test('选项参数不算文件', () => {
  assert.deepEqual(extractBashReads('grep -n x a.txt', ['grep']), ['a.txt']);
  assert.deepEqual(extractBashReads('head -20 a.txt', ['head']), ['a.txt']);
});

test('命令不在集合 ⇒ 不提取', () => {
  assert.deepEqual(extractBashReads('cat a.txt', ['grep']), []);
  assert.deepEqual(extractBashReads('rm -rf x', ['cat']), []);
});

test('管道分段：每段各看命令名', () => {
  assert.deepEqual(extractBashReads('cat a.txt | grep x', ['cat']), ['a.txt']);
  // 只配 grep 时：grep 的 x 是模式不是文件 ⇒ 空
  assert.deepEqual(extractBashReads('cat a.txt | grep x', ['grep']), []);
  assert.deepEqual(extractBashReads('cat a.txt | grep -n x b.txt', ['cat', 'grep']), ['a.txt', 'b.txt']);
});

test('绝对路径命令名归一（/bin/cat → cat）', () => {
  assert.deepEqual(extractBashReads('/bin/cat a.txt', ['cat']), ['a.txt']);
  assert.deepEqual(extractBashReads('sudo cat a.txt', ['cat']), ['a.txt']);
});

test('重定向之后不再当输入文件', () => {
  assert.deepEqual(extractBashReads('cat a.txt > out.txt', ['cat']), ['a.txt']);
});

test('空命令 / 空集合 ⇒ 空数组', () => {
  assert.deepEqual(extractBashReads('', ['cat']), []);
  assert.deepEqual(extractBashReads('cat a.txt', []), []);
});

test('跨平台别名：Get-Content / gc / type → cat，Select-String / findstr → grep', () => {
  assert.deepEqual(extractBashReads('Get-Content a.txt', ['cat']), ['a.txt']);
  assert.deepEqual(extractBashReads('gc a.txt', ['cat']), ['a.txt']);
  assert.deepEqual(extractBashReads('type a.txt', ['cat']), ['a.txt']);
  assert.deepEqual(extractBashReads('Select-String -Pattern x a.txt', ['grep']), ['a.txt']);
  assert.deepEqual(extractBashReads('findstr x a.txt', ['grep']), ['a.txt']);
});

test('Windows 路径分隔符：C:\\\\dir\\\\cat.exe 归一为 cat', () => {
  assert.deepEqual(extractBashReads('C:\\Windows\\System32\\cat.exe a.txt', ['cat']), ['a.txt']);
});
