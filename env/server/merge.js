'use strict';

// 段落内容的 token 级 diff3 三方合并。
//
//   base   —— 双方编辑开始时共同基于的旧版本
//   local  —— 当前用户提交的文本（A）
//   remote —— 服务端当前文本（B，期间被别人改过）
//
// 流程：分别求 O->A、O->B 的 LCS diff；把两侧 hunk 在 old 轴上取并集；
// 并集之外是双方一致的稳定区，直接取 base；并集内的每个 region，只有
// 一侧动过就采用那一侧，两侧都动且结果不同则报冲突，交给用户裁决。

// 英文/数字按词切，CJK 等无空白语言按单字切，空白与标点各自成 token。
const TOKEN_RE =
  /[A-Za-z0-9]+|\s+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[^\sA-Za-z0-9]/gu;

function tokenize(text) {
  return text.match(TOKEN_RE) || [];
}

function join(tokens) {
  return tokens.join('');
}

// LCS 动态规划，返回 old -> new 的改动 hunk 列表。
// hunk: { oStart, oEnd, nStart, nEnd }，半开区间。
function diffHunks(oldArr, newArr) {
  const n = oldArr.length;
  const m = newArr.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldArr[i] === newArr[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const hunks = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && oldArr[i] === newArr[j]) {
      i++;
      j++;
    } else {
      const oStart = i;
      const nStart = j;
      let oEnd = oStart;
      let nEnd = nStart;
      while (i < n || j < m) {
        if (j < m && (i === n || dp[i][j] === dp[i][j + 1])) {
          j++; // 沿 new 前进（插入 / 替换的新侧）
        } else if (i < n && (j === m || dp[i][j] === dp[i + 1][j])) {
          i++; // 沿 old 前进（删除 / 替换的旧侧）
        } else {
          break; // 重新对齐
        }
        oEnd = i;
        nEnd = j;
      }
      hunks.push({ oStart, oEnd, nStart, nEnd });
    }
  }
  return hunks;
}

// 把 old 轴边界 o 映射到 new 轴。region 的前/后边界（atEnd）对
// 纯插入 hunk [p,p)->[ns,ne) 必须区分：
//   前边界 p 在插入之前 -> ns；后边界 p 在插入之后 -> ne。
//
// 对替换/删除型（os < oe）：
//   o < os       : 之前，不变
//   o === os     : -> ns
//   os < o < oe  : 内部，夹到 ns
//   o === oe     : -> ne（等价于"经过该 hunk 后"的位移结果）
//   o > oe       : 应用长度差
function mapToNew(hunks, o, atEnd) {
  let x = o;
  for (const h of hunks) {
    if (o < h.oStart) break;
    if (h.oStart === h.oEnd) {
      // 纯插入 [p,p)
      if (o === h.oStart && atEnd) return h.nEnd;
      if (o > h.oStart) x += h.nEnd - h.nStart;
    } else if (o === h.oStart && !atEnd) {
      return h.nStart;
    } else if (o < h.oEnd) {
      return h.nStart;
    } else {
      // o >= oe：经过整个 hunk，后边界自然得 nEnd
      x += h.nEnd - h.nStart - (h.oEnd - h.oStart);
    }
  }
  return x;
}

// 两侧 hunk 在 old 轴上取并集（重叠就合并；纯插入点 [p,p) 与相邻区间
// 端点相接也需要正确并组）。用扫描线 + 深度计数实现。
//
// 同一坐标上可能同时有结束(-1)和开始(+1)事件：
//   - 两个"有宽度"的区间首尾相接（如 [5,8) 和 [8,10)）应合并为一个
//     region，否则会丢失中间的边界判断；
//   - 纯插入区间 [p,p) 是 +1、-1 同点，必须产出零宽 region。
// 规则：同点先处理 +1 再处理 -1。这样相接的宽区间不会断开（深度先升后
// 降，中间不归零）；而零宽插入在深度 0 上先 +1 记录 start、再 -1 闭区间。
function unionRegions(hA, hB) {
  const events = [];
  for (const h of hA) events.push([h.oStart, 1], [h.oEnd, -1]);
  for (const h of hB) events.push([h.oStart, 1], [h.oEnd, -1]);
  events.sort((p, q) => p[0] - q[0] || q[1] - p[1]); // +1 在 -1 前

  const regions = [];
  let depth = 0;
  let start = -1;
  for (const [pos, delta] of events) {
    if (depth === 0 && delta > 0) start = pos;
    depth += delta;
    if (depth === 0) regions.push({ oStart: start, oEnd: pos });
  }
  return regions;
}

// 判断 region [rs, re) 是否真正包含该侧某个 hunk（端点相接也算）。
function sideTouched(hunks, rs, re) {
  return hunks.some((h) => h.oStart <= re && h.oEnd >= rs);
}

// 返回 { ok: true, text } 或 { ok: false, base, local, remote }
function merge3(baseText, localText, remoteText) {
  if (localText === remoteText) return { ok: true, text: localText };
  if (localText === baseText) return { ok: true, text: remoteText };
  if (remoteText === baseText) return { ok: true, text: localText };

  const O = tokenize(baseText);
  const A = tokenize(localText);
  const B = tokenize(remoteText);
  const hA = diffHunks(O, A);
  const hB = diffHunks(O, B);
  if (hA.length === 0) return { ok: true, text: remoteText };
  if (hB.length === 0) return { ok: true, text: localText };

  const regions = unionRegions(hA, hB);
  const out = [];
  let oCursor = 0;
  let conflict = false;

  for (const r of regions) {
    // 稳定区：两侧一致，直接取 base 原文
    out.push(...O.slice(oCursor, r.oStart));

    const aStart = mapToNew(hA, r.oStart, false);
    const aEnd = mapToNew(hA, r.oEnd, true);
    const bStart = mapToNew(hB, r.oStart, false);
    const bEnd = mapToNew(hB, r.oEnd, true);
    const partA = A.slice(aStart, aEnd);
    const partB = B.slice(bStart, bEnd);
    const aChanged = sideTouched(hA, r.oStart, r.oEnd);
    const bChanged = sideTouched(hB, r.oStart, r.oEnd);

    if (!aChanged && !bChanged) {
      out.push(...O.slice(r.oStart, r.oEnd)); // 理论上不会发生
    } else if (!aChanged) {
      out.push(...partB);
    } else if (!bChanged) {
      out.push(...partA);
    } else if (join(partA) === join(partB)) {
      out.push(...partA); // 两侧改成一样
    } else {
      conflict = true;
      out.push(
        '\n<<<<<<< 你的版本\n',
        ...partA,
        '\n=======\n',
        ...partB,
        '\n>>>>>>> 对方版本\n',
      );
    }
    oCursor = r.oEnd;
  }
  out.push(...O.slice(oCursor));

  if (conflict) {
    return { ok: false, base: baseText, local: localText, remote: remoteText };
  }
  return { ok: true, text: join(out) };
}

module.exports = { tokenize, join, diffHunks, merge3 };
