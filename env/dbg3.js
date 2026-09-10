const { merge3, tokenize } = require('./server/merge');

// 小字母表上穷举：base 短串，A/B 各做一次"在某位置插入若干新字符"或替换。
// 双方插入点相同（同一间隙）且插入内容不同 => 语义上必须冲突。
const ALPHA = ['a','b','c'];
function insertedTokens(baseTokens, newTokens) {
  // 返回 newTokens 中无法与 base LCS 对齐的 token（粗略：计数差）
  const cb = new Map(), cn = new Map();
  for (const t of baseTokens) cb.set(t,(cb.get(t)||0)+1);
  for (const t of newTokens) cn.set(t,(cn.get(t)||0)+1);
  const extra = [];
  for (const [t,n] of cn) {
    const d = n - (cb.get(t)||0);
    for (let i=0;i<d;i++) extra.push(t);
  }
  return extra;
}

let cases = 0, lost = [];
function check(base, A, B, desc) {
  cases++;
  const r = merge3(base, A, B);
  if (!r.ok) return; // 正确报冲突
  // 静默合并了：检查双方各自"新增"的 token 是否都在结果里
  const out = r.text;
  const aExtra = insertedTokens(tokenize(base), tokenize(A));
  const bExtra = insertedTokens(tokenize(base), tokenize(B));
  // 简单统计：结果中每个 token 的计数必须 >= base，且新增 token 两侧都得在
  const co = new Map();
  for (const t of tokenize(out)) co.set(t,(co.get(t)||0)+1);
  const ca = new Map(); for (const t of tokenize(A)) ca.set(t,(ca.get(t)||0)+1);
  const cb = new Map(); for (const t of tokenize(B)) cb.set(t,(cb.get(t)||0)+1);
  const missingA = [], missingB = [];
  for (const [t,n] of ca) if ((co.get(t)||0) < n && (co.get(t)||0) < (cb.get(t)||0)) missingA.push(t);
  for (const [t,n] of cb) if ((co.get(t)||0) < n && (co.get(t)||0) < (ca.get(t)||0)) missingB.push(t);
  if (missingA.length || missingB.length) {
    lost.push({ base: JSON.stringify(base), A: JSON.stringify(A), B: JSON.stringify(B), out: JSON.stringify(out), missingA, missingB, desc });
  }
}

// 穷举：base 长度 1..3，双方在每个间隙插入 1..2 个不同字符
function strings(len, prefix='') {
  if (len===0) return [prefix];
  const out=[];
  for (const c of ALPHA) out.push(...strings(len-1, prefix+c));
  return out;
}
for (const base of strings(2)) {
  for (let p=0;p<=base.length;p++) {
    for (const x of ALPHA) for (const y of ALPHA) {
      if (x===y) continue;
      const A = base.slice(0,p)+x+base.slice(p);
      const B = base.slice(0,p)+y+base.slice(p);
      check(base,A,B,'same-point insert');
    }
  }
}
// 替换同一字符
for (const base of strings(2)) {
  for (let p=0;p<base.length;p++) {
    for (const x of ALPHA) for (const y of ALPHA) {
      if (x===y||x===base[p]||y===base[p]) continue;
      const A = base.slice(0,p)+x+base.slice(p+1);
      const B = base.slice(0,p)+y+base.slice(p+1);
      check(base,A,B,'same-point replace');
    }
  }
}
// 句尾追加（CJK 场景在 merge 里按字切，等价于此）
for (const base of strings(2)) {
  for (const x of ALPHA) for (const y of ALPHA) {
    if (x===y) continue;
    check(base, base+x, base+y, 'append');
  }
}
console.log('cases', cases, 'silent-loss', lost.length);
for (const l of lost.slice(0,20)) console.log(l);
