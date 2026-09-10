'use strict';
const assert = require('assert');
const { merge3 } = require('../server/merge');

function ok(base, a, b, expected) {
  const r = merge3(base, a, b);
  assert.ok(r.ok, `期望自动合并成功，却报了冲突:\n${JSON.stringify(r, null, 2)}`);
  if (expected !== undefined) assert.strictEqual(r.text, expected);
  // 交换律：A/B 两侧结果必须一致（收敛的基本性质）
  const r2 = merge3(base, b, a);
  assert.ok(r2.ok, '交换两侧后不应冲突');
  assert.strictEqual(r2.text, r.text, `合并不满足交换律:\n${r.text}\nvs\n${r2.text}`);
  return r.text;
}

function conflict(base, a, b) {
  const r = merge3(base, a, b);
  assert.ok(!r.ok, '期望冲突，却自动合并了');
  assert.strictEqual(r.base, base);
  assert.strictEqual(r.local, a);
  assert.strictEqual(r.remote, b);
}

// 1) 只有一侧改 -> 直接采用
ok('开头 中间 结尾', '开头 中间 改了', '开头 中间 结尾', '开头 中间 改了');
ok('开头 中间 结尾', '开头 中间 结尾', '新加 开头 中间 结尾', '新加 开头 中间 结尾');

// 2) 两侧改不同位置 -> 都保留（中文按字 tokenize，能精细合并）
ok(
  '标题第一段第二段结尾',
  '标题第一段改了第二段结尾',
  '标题第一段第二段也改结尾',
  '标题第一段改了第二段也改结尾',
);

// 3) 英文按词
ok(
  'the quick brown fox',
  'the slow brown fox',
  'the quick brown dog',
  'the slow brown dog',
);

// 4) 同一插入点两侧插入不同内容：无法判定顺序，算冲突交用户裁决
conflict('一二', '一二甲', '一二乙');
conflict('一二', '一甲二', '一乙二'); // 同为"一/二之间"插入点
//    插入点被各自的修改隔开时则自动合并（A 改前、B 改后）
ok('前 中 后', '新前 中 后', '前 中 新后', '新前 中 新后');

// 5) 同一处改成不同内容 -> 冲突，不静默丢数据
conflict('价格是 100 元', '价格是 200 元', '价格是 300 元');

// 6) 同一处改成相同内容 -> 算成功
ok('版本一', '版本二', '版本二', '版本二');

// 7) 一侧删除、另一侧改同处 -> 冲突
conflict('保留 删除我 结尾', '保留 替换成它 结尾', '保留 结尾');

// 8) 一侧删除整句、另一侧在别处追加 -> 自动合并
{
  const t = ok('无用的废话 有用的内容', '有用的内容', '无用的废话 有用的内容！');
  assert.ok(t.includes('有用的内容') && t.endsWith('！'), t);
}

// 9) 行级场景：两个人分别改不同段落
{
  const base = '第一段\n第二段\n第三段';
  const a = '第一段修改\n第二段\n第三段';
  const b = '第一段\n第二段\n第三段追加';
  const t = ok(base, a, b);
  assert.ok(t.includes('第一段修改'), t);
  assert.ok(t.includes('第三段追加'), t);
}

// 10) 标点与 emoji
{
  const t = ok('Hello，世界！', 'Hello，世界🌍！', 'Hi，世界！');
  assert.ok(t.includes('Hi') && t.includes('🌍'), t);
}

console.log('merge OK');
