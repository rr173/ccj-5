'use strict';
const assert = require('assert');
const { midpoint } = require('../server/fraction');

// 基础边界
assert.strictEqual(midpoint(null, null), '1');
assert.ok(midpoint(null, '1') < '1');
assert.ok(midpoint('1', null) > '1');
assert.strictEqual(midpoint('1', '3'), '2');
assert.strictEqual(midpoint('a', 'c'), 'b');

// 相邻：需要加长
let m = midpoint('1', '2');
assert.ok('1' < m && m < '2', m);

// next 以 0 结尾（饱和填充）
m = midpoint('1' + 'z'.repeat(5), null);
assert.ok(m > '1' + 'z'.repeat(5), m);
let m2 = midpoint(null, '2' + '0'.repeat(3));
assert.ok('' < m2 && m2 < '2' + '0'.repeat(3), m2);
assert.ok(!m2.endsWith('0'), m2);

// 随机插入排序测试：反复在随机相邻间隙插入，顺序必须保持
function stress(seed) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const arr = [midpoint(null, null)];
  for (let i = 0; i < 2000; i++) {
    const pos = Math.floor(rnd() * (arr.length + 1));
    const prev = pos === 0 ? null : arr[pos - 1];
    const next = pos === arr.length ? null : arr[pos];
    const val = midpoint(prev, next);
    if (prev) assert.ok(prev < val, `${prev} < ${val}`);
    if (next) assert.ok(val < next, `${val} < ${next}`);
    arr.splice(pos, 0, val);
  }
  for (let i = 1; i < arr.length; i++) assert.ok(arr[i - 1] < arr[i]);
  assert.strictEqual(new Set(arr).size, arr.length, '索引不能重复');
}
stress(42);
stress(7);
stress(99991);

// 头部反复插入、尾部反复插入
let head = null;
for (let i = 0; i < 500; i++) {
  head = midpoint(null, head);
}
let tail = '1';
for (let i = 0; i < 500; i++) {
  tail = midpoint(tail, null);
}
console.log('fraction OK, head len', head.length, 'tail len', tail.length);
