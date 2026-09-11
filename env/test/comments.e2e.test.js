'use strict';

// 段落留言端到端。
//
// 五条需求对应的机制：
// 1. 写上去所有正在看的人都得看见：comment_add 落服务器，广播 comment_added 给整个文档房间；
// 2. 正文后来改字留言还在：留言锚定 nodeId 而非版本，save 只追加 revision，不碰 comments；
// 3. 一人收掉，全员看到同一份已收：comment_resolved 单条广播（含发起者其他标签页）；
// 4. 两人几乎同时用不同说法收同一条：条件 UPDATE 的 CAS，只有先到者生效，
//    后到者收 comment_resolve_stale + 先收那份，绝不两边各显示各的已收；
// 5. 没收掉就反悔：确认弹窗在前端不发请求（这里验证"不发=状态不变"），留言保持 open。
//
// 运行：WS_PORT=3784 DB_FILE=./data/comments.db node test/comments.e2e.test.js

process.env.WS_PORT = process.env.WS_PORT || '3784';
process.env.DB_FILE = process.env.DB_FILE || './data/comments.db';
process.env.WS_PING_MS = process.env.WS_PING_MS || '300';

const fs = require('fs');
for (const f of [process.env.DB_FILE, process.env.DB_FILE + '-wal', process.env.DB_FILE + '-shm']) {
  try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
}

const assert = require('assert');
const WebSocket = require('ws');
const serverMod = require('../server/index');

const PORT = Number(process.env.WS_PORT);
let passed = 0;
function test(name, fn) {
  return Promise.resolve(fn()).then(() => {
    passed++;
    console.log(`  ✓ ${name}`);
  });
}

function connect(userName, userId) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const client = {
    ws,
    user: null,
    messages: [],
    waiters: [],
    send(obj) { ws.send(JSON.stringify(obj)); },
    next(filter = () => true, timeout = 3000) {
      return new Promise((resolve, reject) => {
        const hit = this.messages.find(filter);
        if (hit) return resolve(hit);
        const t = setTimeout(() => reject(new Error('等待消息超时: ' + JSON.stringify(filter.toString().slice(0, 100)))), timeout);
        this.waiters.push({ filter, resolve, reject: (e) => { clearTimeout(t); reject(e); } });
      });
    },
    drain(filter = () => true) {
      const out = this.messages.filter(filter);
      this.messages = this.messages.filter((m) => !filter(m));
      return out;
    },
    close() { ws.close(); },
  };
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const w = client.waiters.find((x) => x.filter(msg));
    if (w) {
      client.waiters.splice(client.waiters.indexOf(w), 1);
      w.resolve(msg);
    } else {
      client.messages.push(msg);
    }
  });
  return new Promise((resolve, reject) => {
    ws.on('open', () => {
      client.send({ type: 'hello', userId: userId || `u-${userName}`, userName });
      client.next((m) => m.type === 'hello').then((m) => {
        client.user = m.user;
        client.next((m) => m.type === 'snapshot').then(() => resolve(client));
      });
    });
    ws.on('error', reject);
  });
}

async function snapshot(client, docId) {
  client.send({ type: 'open_doc', docId });
  return client.next((m) => m.type === 'snapshot' && m.docId === docId);
}

async function latestSnapshot(docId) {
  const tmp = await connect('__snap__' + Math.random().toString(36).slice(2, 7), 'u-snap-' + Math.random().toString(36).slice(2));
  const snap = await snapshot(tmp, docId);
  tmp.close();
  return snap;
}

async function run() {
  await new Promise((r) => serverMod.server.listen(PORT, r));
  console.log(`留言测试服务已在 ${PORT} 启动`);

  const alice = await connect('Alice', 'u-ca');
  const bob = await connect('Bob', 'u-cb');
  const carol = await connect('Carol', 'u-cc');
  await bob.next((m) => m.type === 'snapshot');
  await carol.next((m) => m.type === 'snapshot');

  const init = await latestSnapshot('default');
  const node = init.nodes.find((n) => n.content.includes('实时看到'));
  const nodeId = node.id;
  let commentId = null;

  // ---------- 1：写留言：全员立刻收到同一条；快照里也有 ----------
  await test('写留言：同房间其他人收到 comment_added（同一 id/同一内容），晚加入者快照里有', async () => {
    commentId = 'cmt-' + Math.random().toString(36).slice(2, 10);
    const pBob = bob.next((m) => m.type === 'comment_added' && m.comment?.id === commentId);
    const pCarol = carol.next((m) => m.type === 'comment_added' && m.comment?.id === commentId);
    alice.send({ type: 'comment_add', nodeId, commentId, content: '这句是不是该补个例子？' });
    const [mBob, mCarol] = await Promise.all([pBob, pCarol]);
    assert.strictEqual(mBob.comment.content, '这句是不是该补个例子？');
    assert.strictEqual(mBob.comment.content, mCarol.comment.content, '两人收到逐字相同的一条');
    assert.strictEqual(mBob.comment.status, 'open');
    assert.strictEqual(mBob.comment.nodeId, nodeId);
    assert.strictEqual(mBob.comment.author, 'Alice');
    assert.strictEqual(mBob.comment.docId, 'default');

    const snap = await latestSnapshot('default');
    const c = snap.comments.find((x) => x.id === commentId);
    assert.ok(c, '快照 comments 里带上这条');
    assert.strictEqual(c.content, '这句是不是该补个例子？');
    assert.strictEqual(c.status, 'open');
  });

  // ---------- 2：正文改了好几版，留言还挂在这段上 ----------
  await test('正文连续保存多版：留言不被删、不进 revisions，快照里仍在且 open', async () => {
    const v0 = (await latestSnapshot('default')).nodes.find((n) => n.id === nodeId).version;
    for (let i = 1; i <= 3; i++) {
      alice.send({
        type: 'save', nodeId,
        content: `正文第 ${i} 次修改（留言不能丢）`,
        baseVersion: v0 + i - 1,
      });
      await alice.next((m) => m.type === 'saved' && m.nodeId === nodeId);
    }
    const snap = await latestSnapshot('default');
    const n = snap.nodes.find((x) => x.id === nodeId);
    assert.strictEqual(n.version, v0 + 3);
    assert.ok(n.content.includes('第 3 次修改'));
    const c = snap.comments.find((x) => x.id === commentId);
    assert.ok(c, '正文改了三版，留言还在');
    assert.strictEqual(c.status, 'open', '留言仍是开着的样子');
    assert.strictEqual(c.content, '这句是不是该补个例子？');
  });

  // ---------- 3：一人收掉：全员（含发起者）收到同一条 comment_resolved ----------
  await test('收掉留言：所有观看者收到同一条 comment_resolved，说法逐字一致', async () => {
    const pAlice = alice.next((m) => m.type === 'comment_resolved' && m.comment?.id === commentId);
    const pBob = bob.next((m) => m.type === 'comment_resolved' && m.comment?.id === commentId);
    const pCarol = carol.next((m) => m.type === 'comment_resolved' && m.comment?.id === commentId);
    carol.send({ type: 'comment_resolve', commentId, content: '已补上例子' });
    const [mA, mB, mC] = await Promise.all([pAlice, pBob, pCarol]);
    for (const m of [mA, mB, mC]) {
      assert.strictEqual(m.comment.status, 'resolved');
      assert.strictEqual(m.comment.resolvedContent, '已补上例子');
      assert.strictEqual(m.comment.resolvedBy, 'Carol');
      assert.ok(m.comment.resolvedAt, '带收掉时间');
    }
    // 发起者没有单独 ack：房间里只有同一条广播这一份事实
    const acks = alice.drain((m) => m.type === 'comment_ack');
    assert.strictEqual(acks.length, 0);

    const snap = await latestSnapshot('default');
    const c = snap.comments.find((x) => x.id === commentId);
    assert.strictEqual(c.status, 'resolved');
    assert.strictEqual(c.resolvedContent, '已补上例子');
  });

  // ---------- 4：已收的不能被第二个人用另一种说法再收一遍 ----------
  await test('重复收掉：后到者收 comment_resolve_stale，带回先收那份；不再广播 resolved', async () => {
    const staleP = bob.next((m) => m.type === 'comment_resolve_stale' && m.comment?.id === commentId);
    bob.send({ type: 'comment_resolve', commentId, content: 'Bob 的另一种说法' });
    const stale = await staleP;
    // Bob 自己收到的 resolved 广播只有 Carol 那一条（说法相同）；绝不能冒出第二条
    const resolvedMsgs = bob.drain((m) => m.type === 'comment_resolved' && m.comment?.id === commentId);
    assert.ok(resolvedMsgs.every((m) => m.comment.resolvedBy === 'Carol' && m.comment.resolvedContent === '已补上例子'),
      '只能看到先收者那一条 resolved');
    assert.strictEqual(stale.comment.status, 'resolved');
    assert.strictEqual(stale.comment.resolvedContent, '已补上例子', '以后到者收敛到先收者说法');
    assert.strictEqual(stale.comment.resolvedBy, 'Carol');
    assert.ok(/Carol/.test(stale.message));

    const snap = await latestSnapshot('default');
    const c = snap.comments.find((x) => x.id === commentId);
    assert.strictEqual(c.resolvedContent, '已补上例子', '存储仍是先收那份');
  });

  // ---------- 5：两人几乎同时、用不同说法收同一条：只有一个说法赢，全员一致 ----------
  await test('并发收掉 CAS：两条请求带着不同说法同时到达，只有先到者生效，三方最终一致', async () => {
    // 再准备一条开着的留言
    const c2 = 'cmt2-' + Math.random().toString(36).slice(2, 10);
    const pAdd = Promise.all([
      alice.next((m) => m.type === 'comment_added' && m.comment?.id === c2),
      bob.next((m) => m.type === 'comment_added' && m.comment?.id === c2),
    ]);
    alice.send({ type: 'comment_add', nodeId, commentId: c2, content: '这里数据口径统一一下？' });
    await pAdd;

    // 先把两人的等待挂好，再在同一拍发出两条不同说法（消息在服务器串行处理）
    const raP = alice.next((m) =>
      (m.type === 'comment_resolved' || m.type === 'comment_resolve_stale') && m.comment?.id === c2);
    const rbP = bob.next((m) =>
      (m.type === 'comment_resolved' || m.type === 'comment_resolve_stale') && m.comment?.id === c2);
    const rcP = carol.next((m) => m.type === 'comment_resolved' && m.comment?.id === c2, 1500)
      .catch(() => null);
    alice.send({ type: 'comment_resolve', commentId: c2, content: 'Alice 说：按 Q2 口径' });
    bob.send({ type: 'comment_resolve', commentId: c2, content: 'Bob 说：按 Q3 口径' });
    const [ra, rb, rc] = await Promise.all([raP, rbP, rcP]);
    // 广播是全房间的（发起者也收同一条）：两人至少都看到同一份 resolved；
    // 输的一方随后还会收到自己那条请求的 stale 回执（下一个断言验证）。
    assert.strictEqual(ra.type, 'comment_resolved', '先到者收到广播');
    assert.strictEqual(rb.type, 'comment_resolved', '后到者也在同一个房间，收到同一条广播');
    const winner = ra.comment.resolvedContent;
    assert.strictEqual(ra.comment.resolvedContent, rb.comment.resolvedContent,
      '两人收到的已收说法逐字一致');
    assert.ok(winner === 'Alice 说：按 Q2 口径' || winner === 'Bob 说：按 Q3 口径',
      '赢的说法必是两人之一原文，不是拼合/覆盖');

    // 输的一方必然还能取到它自己请求的 stale 回执（广播先发、stale 紧随其后）。
    // next() 命中缓存不移除消息，轮询队列直到 stale 入队。
    const loserIsBob = winner.startsWith('Alice');
    const loser = loserIsBob ? bob : alice;
    let stale = null;
    for (let i = 0; i < 40 && !stale; i++) {
      stale = loser.messages.find((m) => m.type === 'comment_resolve_stale' && m.comment?.id === c2) || null;
      if (!stale) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(stale, '输的一方收到 stale 回执');
    assert.strictEqual(stale.comment.resolvedContent, winner, '输的一方回执也指向赢家说法');
    // 赢的一方任何时刻都没有 stale 回执
    const winnerClient = loserIsBob ? alice : bob;
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(
      !winnerClient.messages.some((m) => m.type === 'comment_resolve_stale' && m.comment?.id === c2),
      '赢的一方不应收到 stale',
    );

    const snap = await latestSnapshot('default');
    const c = snap.comments.find((x) => x.id === c2);
    assert.strictEqual(c.status, 'resolved');
    assert.strictEqual(c.resolvedContent, winner, '存储里的说法 = 唯一赢家的说法');
    if (rc) assert.strictEqual(rc.comment.resolvedContent, winner, '旁观第三人只收到唯一一条广播');
  });

  // ---------- 6：没收掉就反悔：不发请求，留言保持 open（且不广播任何 resolved）----------
  await test('取消收掉：没有任何写入，留言在所有人那里仍开着', async () => {
    const c3 = 'cmt3-' + Math.random().toString(36).slice(2, 10);
    const pBob = bob.next((m) => m.type === 'comment_added' && m.comment?.id === c3);
    const pCarol = carol.next((m) => m.type === 'comment_added' && m.comment?.id === c3);
    alice.send({ type: 'comment_add', nodeId, commentId: c3, content: '待反悔的留言' });
    await Promise.all([pBob, pCarol]);

    // 模拟前端"打开确认弹窗又取消"：根本不发 comment_resolve。
    // 等一拍确认没有任何 resolved 消息冒出来（不能用会 reject 的 next 做负向等待）。
    await new Promise((r) => setTimeout(r, 400));
    const leaked = [alice, bob, carol].some((c) =>
      c.messages.some((m) => m.type === 'comment_resolved' && m.comment?.id === c3));
    assert.ok(!leaked, '没发请求就不可能有 resolved 广播');

    const snap = await latestSnapshot('default');
    const c = snap.comments.find((x) => x.id === c3);
    assert.strictEqual(c.status, 'open', '留言还是上一份开着的样子');
    assert.ok(!c.resolvedContent, '没有任何已收说法');
  });

  // ---------- 7：边界：空留言拒绝；摘录行不能留言；viewer 不能留言 ----------
  await test('边界：空内容拒绝；摘录行拒绝；对外观看者写消息一律拒绝', async () => {
    alice.drain(() => true);
    alice.send({ type: 'comment_add', nodeId, commentId: 'cmt-empty', content: '   ' });
    const e1 = await alice.next((m) => m.type === 'error');
    assert.ok(/不能为空/.test(e1.message));

    // 做一个摘录行，留言必须被服务器拒绝
    const created = alice.next((m) => m.type === 'doc_created');
    alice.send({ type: 'create_doc', title: '留言边界用的摘录本' });
    const doc = await created;
    await alice.next((m) => m.type === 'snapshot' && m.docId === doc.doc.id);
    const hs = await latestSnapshot(doc.doc.id);
    alice.send({
      type: 'add_excerpt', sourceId: nodeId, docId: doc.doc.id,
      parentId: '', afterId: '', treeRev: hs.treeRev,
    });
    const added = await alice.next((m) => m.type === 'excerpt_added');
    alice.send({ type: 'comment_add', nodeId: added.node.id, commentId: 'cmt-on-excerpt', content: '想在摘录上留言' });
    const e2 = await alice.next((m) => m.type === 'error');
    assert.ok(/摘录|冻结/.test(e2.message));

    // viewer：服务器消息分发入口直接拒写
    const vws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const viewer = await new Promise((resolve, reject) => {
      const msgs = [];
      vws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        msgs.push(m);
        if (m.type === 'published_state') resolve({ send: (o) => vws.send(JSON.stringify(o)), msgs });
      });
      vws.on('open', () => vws.send(JSON.stringify({
        type: 'hello', userId: 'u-viewer1', userName: '外部观看者', role: 'viewer', docId: 'default',
      })));
      vws.on('error', reject);
      setTimeout(() => reject(new Error('viewer 未收到 published_state')), 2000);
    });
    viewer.send({ type: 'comment_add', nodeId, commentId: 'cmt-viewer', content: '外面的人偷留言' });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!viewer.msgs.some((m) => m.type === 'comment_added'), 'viewer 绝不可能产生广播');
    vws.close();
  });

  // ---------- 8：跟读挂载行上的留言独立于源行：源改正文，留言都在 ----------
  await test('跟读行留言挂在挂载行本身；源改正文两边留言都不丢', async () => {
    const host = await latestSnapshot('default'); // 复用已开的 default 不便于跨文档；另建一份
    const created = alice.next((m) => m.type === 'doc_created');
    alice.send({ type: 'create_doc', title: '留言跟读宿主' });
    const doc = await created;
    await alice.next((m) => m.type === 'snapshot' && m.docId === doc.doc.id);
    const h0 = await latestSnapshot(doc.doc.id);

    // 找一个"干净"的源段（nodeId 已被改多次，仍可用；这里仍用它）
    const addedP = bob.next((m) => m.type === 'mirror_added' && m.docId === doc.doc.id);
    await snapshot(bob, doc.doc.id);
    alice.send({
      type: 'add_mirror', sourceId: nodeId, docId: doc.doc.id,
      parentId: '', afterId: '', treeRev: h0.treeRev,
    });
    const mirror = await addedP;
    const mirrorId = mirror.node.id;

    const cm = 'cmt-mirror-' + Math.random().toString(36).slice(2, 8);
    const pOnMirror = bob.next((m) => m.type === 'comment_added' && m.comment?.id === cm);
    alice.send({ type: 'comment_add', nodeId: mirrorId, commentId: cm, content: '跟读这行也讨论一句' });
    const mm = await pOnMirror;
    assert.strictEqual(mm.comment.nodeId, mirrorId);

    // 源再改一版
    const def = await latestSnapshot('default');
    const srcV = def.nodes.find((n) => n.id === nodeId).version;
    alice.send({ type: 'save', nodeId, content: '源又改了，留言别丢', baseVersion: srcV });
    await alice.next((m) => m.type === 'saved');

    // 源行留言、挂载行留言各自都在
    const dSnap = await latestSnapshot('default');
    assert.ok(dSnap.comments.some((c) => c.nodeId === nodeId), '源行留言还在源文档');
    const hSnap = await latestSnapshot(doc.doc.id);
    const mc = hSnap.comments.find((c) => c.id === cm);
    assert.ok(mc && mc.status === 'open', '跟读挂载行的留言留在宿主文档，源改正文不影响');
    assert.ok(!dSnap.comments.some((c) => c.id === cm), '挂载行留言不串到源文档');
  });

  await new Promise((r) => setTimeout(r, 100));
  alice.close();
  bob.close();
  carol.close();
  serverMod.server.close();
  console.log(`\n全部 ${passed} 个留言用例通过 ✅`);
  process.exit(0);
}

run().catch((e) => {
  console.error('测试失败:', e);
  process.exit(1);
});
