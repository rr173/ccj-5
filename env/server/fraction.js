'use strict';

// 分数索引 (fractional indexing)：用可排序字符串表示同级节点的顺序。
// midpoint(lo, hi) 返回严格满足 lo < mid < hi（字典序）的字符串。
//
// 字符集 0-9A-Zaxtmnopqrstuvwxyz（62 个数字，digit 0..61）。
// 唯一不变量：生成的索引永不以 '0' 结尾（'0' 保留为内部填充位，
// 这样在最小键之前仍可不断插入：'1' -> '0z' -> '00z' ...）。
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length; // 62
const MIN_D = 1;
const MAX_D = BASE - 1;

function digitAt(s, i) {
  // 越界位视作 0
  if (s === null || i >= s.length) return 0;
  const d = DIGITS.indexOf(s[i]);
  if (d < 0) throw new Error(`非法索引字符: ${s}`);
  return d;
}

// lo/hi 均可能为 null（或 ''）表示该侧无界
function midpoint(lo, hi) {
  let a = lo === '' ? null : lo;
  let b = hi === '' ? null : hi;

  if (a !== null && b !== null && a >= b) {
    throw new Error(`midpoint 参数错误: "${a}" >= "${b}"`);
  }
  if (a !== null && a.endsWith('0')) {
    throw new Error(`下界索引不能以 0 结尾: "${a}"`);
  }
  // 防御：按不变量生成的键不会以 0 结尾。若调用方传入，剥掉填充位。
  while (b !== null && b.endsWith('0')) b = b.slice(0, -1);
  if (b !== null && a !== null && a >= b) {
    throw new Error(`midpoint 参数错误: 去掉 0 尾后 "${a}" >= "${b}"`);
  }

  if (a === null) {
    if (b === null) return DIGITS[MIN_D]; // 第一个键
    const bd = digitAt(b, 0);
    if (bd > MIN_D) return DIGITS[bd - 1];
    if (bd === MIN_D) return '0' + DIGITS[MAX_D]; // '1' 之前 -> '0z'
    return '0' + midpoint(null, b.slice(1)); // bd === 0：共用 0 前缀
  }

  if (b === null) {
    const last = digitAt(a, a.length - 1);
    if (last < MAX_D) return a.slice(0, -1) + DIGITS[last + 1];
    return a + DIGITS[MIN_D]; // 末位饱和：追加，'zz' -> 'zz1'
  }

  const ad = digitAt(a, 0);
  if (ad === digitAt(b, 0)) {
    return a[0] + midpoint(a.slice(1), b.slice(1));
  }
  if (ad + 1 < digitAt(b, 0)) {
    return DIGITS[Math.floor((ad + digitAt(b, 0)) / 2)];
  }
  // 相邻数字：沿用 a 的首位，在其后缀与无界之间取值（天然 < b）
  return a[0] + midpoint(a.slice(1), null);
}

module.exports = { midpoint, DIGITS };
