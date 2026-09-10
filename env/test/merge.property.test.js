'use strict';
const assert = require('assert');
const { merge3, tokenize, diffHunks } = require('../server/merge');

// 随机编辑：在基准 token 序列上做若干次 插入/删除/替换
function makeRng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
const WORDS = 'alpha beta gamma delta 甲乙丙丁 项目 大纲 段落'.split(' ');

function randomEdit(base, rng) {
  const toks = tokenize(base);
  const ops = 1 + Math.floor(rng() * 4);
  for (let k = 0; k < ops; k++) {
    const pos = Math.floor(rng() * (toks.length + 1));
    const kind = rng();
    if (kind < 0.45 || toks.length === 0) {
      toks.splice(pos, 0, WORDS[Math.floor(rng() * WORDS.length)]);
    } else if (kind < 0.75) {
      const len = 1 + Math.floor(rng() * Math.min(3, toks.length - pos));
      toks.splice(pos, Math.min(len, toks.length - pos));
    } else {
      if (pos < toks.length) toks[pos] = WORDS[Math.floor(rng() * WORDS.length)];
    }
  }
  return toks.join('');
}

let autoCount = 0;
let conflictCount = 0;
for (let seed = 1; seed <= 4000; seed++) {
  const rng = makeRng(seed);
  const base = randomEdit('', makeRng(seed * 7 + 1)) || '起点';
  const a = randomEdit(base, rng);
  const b = randomEdit(base, rng);

  const r1 = merge3(base, a, b);
  const r2 = merge3(base, b, a);
  assert.strictEqual(r1.ok, r2.ok, `seed ${seed}: 冲突判定不满足交换律`);
  const hA = diffHunks(tokenize(base), tokenize(a));
  const hB = diffHunks(tokenize(base), tokenize(b));
  if (r1.ok) {
    autoCount++;
    assert.strictEqual(r1.text, r2.text, `seed ${seed}: 合并不满足交换律\n${r1.text}\nvs\n${r2.text}`);
  } else {
    conflictCount++;
    // 报冲突时，两侧改动在 old 轴上必须相交或端点相接（相接时保守判冲突，
    // 与经典 diff3 行合并行为一致）。
    const touched = (x, y) => x.oStart <= y.oEnd && y.oStart <= x.oEnd;
    assert.ok(
      hA.some((x) => hB.some((y) => touched(x, y))),
      `seed ${seed}: 误报冲突（两侧改动不相交）`,
    );
  }
}
console.log(`merge property OK (${autoCount} auto, ${conflictCount} conflicts)`);
