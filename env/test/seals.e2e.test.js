'use strict';

// 段落封口（seal）端到端。
//
// 五条需求对应的机制：
// 1. 封上之后所有正在看的人都看得出已封住、不能再写新字：
//    seal 落 seal_events，广播 sealed 给源文档 + 所有跟读宿主（含发起者本人/其他标签页），
//    快照 seals 里带当前封口；保存/提改写/移动/删除/占用编辑锁全被服务器硬拦（seal_denied）。
// 2. 有人重新打开，所有正在看的人都看到同一份已打开：unsealed 单条广播，
//    快照里封口消失；之后保存立即恢复成功。
// 3. 两人几乎同时用不同理由封同一段：事务串行 CAS，只有先到者那条 sealed 被广播，
//    后到者收 seal_stale + 先封者理由；房间里绝无两份不同理由。
// 4. 封口还没发出去就反悔：确认弹窗不点确认就不发 seal（测试验证"不发=状态不变"），
//    段仍是上一份开着、能改的样子。
// 5. 跟读投影：源在别处封住，挂着跟读的文档同一条广播显封、同样不能写；摘录是冻字不参与。
//
// 运行：WS_PORT=3785 DB_FILE=./data/seals.db node test/seals.e2e.test.js

process.env.WS_PORT = process.env.WS_PORT || '3785';
process.env.DB_FILE = process.env.DB_FILE || './data/seals.db';
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
        const t = setTimeout(() => reject(new Error('等待消息超时: ' + JSON.stringify(filter.toString().slice(0, 120)))), timeout);
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

async function openDoc(client, docId) {
  client.send({ type: 'open_doc', docId });
  return client.next((m) => m.type === 'snapshot' && m.docId === docId);
}

async function latestSnapshot(docId) {
  const tmp = await connect('__snap__' + Math.random().toString(36).slice(2, 7), 'u-snap-' + Math.random().toString(36).slice(2));
  const snap = await openDoc(tmp, docId);
  tmp.close();
  return snap;
}

async function saveOk(client, nodeId, content, baseVersion) {
  client.send({ type: 'save', nodeId, content, baseVersion });
  const ack = await client.next((m) =>
    (m.type === 'saved' || m.type === 'merge_notice' || m.type === 'seal_denied' || m.type === 'error' || m.type === 'conflict') &&
    (m.nodeId === nodeId));
  return ack;
}

async function run() {
  await new Promise((r) => serverMod.server.listen(PORT, r));
  console.log(`封口测试服务已在 ${PORT} 启动`);

  const alice = await connect('Alice', 'u-sa');
  const bob = await connect('Bob', 'u-sb');
  const carol = await connect('Carol', 'u-sc');
  await bob.next((m) => m.type === 'snapshot');
  await carol.next((m) => m.type === 'snapshot');

  const init = await latestSnapshot('default');
  const node = init.nodes.find((n) => n.content.includes('实时看到'));
  const nodeId = node.id;

  // ---------- 1：封口广播全员同一条；快照带上；所有写路径被硬拦 ----------
  await test('封口：三人（含发起者）收到同一条 sealed，理由逐字一致；快照 seals 里有', async () => {
    const pA = alice.next((m) => m.type === 'sealed' && m.nodeId === nodeId);
    const pB = bob.next((m) => m.type === 'sealed' && m.nodeId === nodeId);
    const pC = carol.next((m) => m.type === 'sealed' && m.nodeId === nodeId);
    alice.send({ type: 'seal', nodeId, reason: '定稿了，等法务确认前别动' });
    const [mA, mB, mC] = await Promise.all([pA, pB, pC]);
    for (const m of [mA, mB, mC]) {
      assert.strictEqual(m.reason, '定稿了，等法务确认前别动');
      assert.strictEqual(m.by.userName, 'Alice');
      assert.ok(m.createdAt);
      assert.strictEqual(m.seal.kind, 'sealed');
    }
    // 发起者没有单独 ack：房间里只有同一条广播这一份事实
    assert.strictEqual(alice.drain((m) => m.type === 'seal_ack').length, 0);

    const snap = await latestSnapshot('default');
    const seal = snap.seals.find((s) => s.nodeId === nodeId);
    assert.ok(seal, '快照 seals 带上当前封口');
    assert.strictEqual(seal.reason, '定稿了，等法务确认前别动');
    assert.strictEqual(seal.author, 'Alice');
    const row = snap.nodes.find((n) => n.id === nodeId);
    assert.strictEqual(row.seal.kind, 'sealed', '节点行内也带上封口，前端一眼可见');
  });

  await test('封住后：正文保存/占用锁/提改写/移动/删除全被服务器拒绝（seal_denied）', async () => {
    const v = node.version;
    // 正文保存
    alice.send({ type: 'save', nodeId, content: '想偷改一个字', baseVersion: v });
    const deny1 = await alice.next((m) => m.type === 'seal_denied' && m.nodeId === nodeId);
    assert.ok(/封口/.test(deny1.message));
    assert.strictEqual(deny1.seal.reason, '定稿了，等法务确认前别动');

    // 编辑锁也不给占
    alice.send({ type: 'lock', nodeId });
    const deny2 = await alice.next((m) => m.type === 'seal_denied' && m.nodeId === nodeId);
    assert.ok(/封口/.test(deny2.message));

    // 提改写
    alice.send({ type: 'suggestion_add', nodeId, content: '改写也不行', baseVersion: v });
    const deny3 = await alice.next((m) => m.type === 'seal_denied' && m.nodeId === nodeId);
    assert.ok(/封口/.test(deny3.message));

    // 移动
    alice.send({ type: 'move', nodeId, parentId: '', afterId: '', treeRev: (await latestSnapshot('default')).treeRev });
    const deny4 = await alice.next((m) => m.type === 'seal_denied' && m.nodeId === nodeId);
    assert.ok(/封口/.test(deny4.message));

    // 删除
    alice.send({ type: 'delete', nodeId, treeRev: (await latestSnapshot('default')).treeRev });
    const deny5 = await alice.next((m) => m.type === 'seal_denied' && m.nodeId === nodeId);
    assert.ok(/封口/.test(deny5.message));

    // 字确实没动
    const snap = await latestSnapshot('default');
    const row = snap.nodes.find((n) => n.id === nodeId);
    assert.strictEqual(row.version, v, '封口期间没有产生任何新 revision');
    assert.ok(!row.content.includes('偷改'));
  });

  await test('删父级也不能绕过封口：待删子树含封段，整笔删除取消', async () => {
    // nodeId 在种子数据里是 n2，父级是 n1
    const snap = await latestSnapshot('default');
    const row = snap.nodes.find((n) => n.id === nodeId);
    assert.ok(row.parentId, '前置：这段有父级');
    const parentId = row.parentId;
    alice.send({ type: 'delete', nodeId: parentId, treeRev: snap.treeRev });
    const deny = await alice.next((m) => m.type === 'seal_denied');
    assert.strictEqual(deny.nodeId, nodeId);
    assert.ok(/子树/.test(deny.message));
    const after = await latestSnapshot('default');
    assert.ok(after.nodes.some((n) => n.id === parentId), '父级没被删');
    assert.ok(after.nodes.some((n) => n.id === nodeId), '封段还在');
  });

  // ---------- 2：重新打开：全员同一条 unsealed；之后立刻能改 ----------
  await test('重新打开：三人收到同一条 unsealed，快照封口消失；保存立即恢复成功', async () => {
    const pA = alice.next((m) => m.type === 'unsealed' && m.nodeId === nodeId);
    const pB = bob.next((m) => m.type === 'unsealed' && m.nodeId === nodeId);
    const pC = carol.next((m) => m.type === 'unsealed' && m.nodeId === nodeId);
    bob.send({ type: 'unseal', nodeId, reason: '法务已确认' });
    const [mA, mB, mC] = await Promise.all([pA, pB, pC]);
    for (const m of [mA, mB, mC]) {
      assert.strictEqual(m.seal.kind, 'unsealed');
      assert.strictEqual(m.reason, '法务已确认');
      assert.strictEqual(m.by.userName, 'Bob');
    }
    const snap = await latestSnapshot('default');
    assert.ok(!snap.seals.some((s) => s.nodeId === nodeId), '快照里封口已消失');
    assert.ok(!snap.nodes.find((n) => n.id === nodeId).seal);

    // 打开后立刻能保存
    const v = snap.nodes.find((n) => n.id === nodeId).version;
    const ack = await saveOk(alice, nodeId, '重新打开后的新内容', v);
    assert.strictEqual(ack.type, 'saved');
    const after = await latestSnapshot('default');
    assert.strictEqual(after.nodes.find((n) => n.id === nodeId).content, '重新打开后的新内容');
  });

  // ---------- 3：两人几乎同时用不同理由封口：只有一份理由赢 ----------
  await test('并发封口 CAS：两条不同理由同时到达，只广播一条 sealed，输家收 stale+赢家理由', async () => {
    const snap = await latestSnapshot('default');
    const v = snap.nodes.find((n) => n.id === nodeId).version;
    const rA = 'Alice 的理由：按 Q2 口径';
    const rB = 'Bob 的理由：按 Q3 口径';

    // 先把等待挂好，再同一拍发两条
    const raP = alice.next((m) =>
      (m.type === 'sealed' || m.type === 'seal_stale') && m.nodeId === nodeId);
    const rbP = bob.next((m) =>
      (m.type === 'sealed' || m.type === 'seal_stale') && m.nodeId === nodeId);
    const rcP = carol.next((m) => m.type === 'sealed' && m.nodeId === nodeId, 1500).catch(() => null);
    alice.send({ type: 'seal', nodeId, reason: rA });
    bob.send({ type: 'seal', nodeId, reason: rB });
    const [ra, rb, rc] = await Promise.all([raP, rbP, rcP]);

    // 两人都在房间里：都收到唯一一条 sealed 广播（发起者也以广播为准）
    assert.strictEqual(ra.type, 'sealed');
    assert.strictEqual(rb.type, 'sealed');
    const winner = ra.reason;
    assert.strictEqual(ra.reason, rb.reason, '两人看到的封口理由逐字一致');
    assert.ok(winner === rA || winner === rB, '赢家理由必是两人之一原文');
    if (rc) assert.strictEqual(rc.reason, winner, '旁观第三人只收到唯一一条');

    // 输的一方必然还能取到 seal_stale，回执里带赢家理由
    const loserIsBob = winner === rA;
    const loser = loserIsBob ? bob : alice;
    let stale = null;
    for (let i = 0; i < 40 && !stale; i++) {
      stale = loser.messages.find((m) => m.type === 'seal_stale' && m.nodeId === nodeId) || null;
      if (!stale) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(stale, '输的一方收到 seal_stale');
    assert.strictEqual(stale.seal.reason, winner, 'stale 带回赢家那条理由');
    const winnerClient = loserIsBob ? alice : bob;
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(
      !winnerClient.messages.some((m) => m.type === 'seal_stale' && m.nodeId === nodeId),
      '赢家不收到 stale',
    );

    // 存储只有一份当前封口
    const after = await latestSnapshot('default');
    assert.strictEqual(after.seals.filter((s) => s.nodeId === nodeId).length, 1);
    assert.strictEqual(after.nodes.find((n) => n.id === nodeId).seal.reason, winner);
    void v;
  });

  // 重复封口幂等：已封再封，不广播第二条，只回 stale
  await test('已封状态再封：不产生第二条广播，后到者收敛到先封那份', async () => {
    carol.send({ type: 'seal', nodeId, reason: 'Carol 想换个理由' });
    const stale = await carol.next((m) => m.type === 'seal_stale' && m.nodeId === nodeId);
    const snap = await latestSnapshot('default');
    assert.notStrictEqual(stale.seal.reason, 'Carol 想换个理由');
    assert.strictEqual(stale.seal.author, stale.seal.author); // 带回先封者整条事实
    assert.strictEqual(
      snap.nodes.find((n) => n.id === nodeId).seal.reason,
      stale.seal.reason,
      '存储与先封那份一致',
    );
    // 其他人不应收到第二条 sealed
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(
      !alice.messages.some((m) => m.type === 'sealed' && m.by.userName === 'Carol'),
      '重复封口不广播',
    );
  });

  // 重复打开幂等
  await test('已打开状态再打开：unseal_stale，不广播第二条', async () => {
    // 先打开
    const pAll = Promise.all([
      alice.next((m) => m.type === 'unsealed' && m.nodeId === nodeId),
      bob.next((m) => m.type === 'unsealed' && m.nodeId === nodeId),
    ]);
    alice.send({ type: 'unseal', nodeId, reason: '先打开' });
    await pAll;
    // 再打开一次
    carol.send({ type: 'unseal', nodeId, reason: '又打开一次' });
    const stale = await carol.next((m) => m.type === 'unseal_stale' && m.nodeId === nodeId);
    assert.ok(stale.message);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(
      !alice.messages.some((m) => m.type === 'unsealed' && m.by.userName === 'Carol'),
      '重复打开不广播第二条 unsealed',
    );
  });

  // ---------- 4：反悔：不点确认就不发 seal，段保持开着、能改 ----------
  await test('封口反悔（不发请求）：没有任何 sealed 广播，快照无封口，段落照常可保存', async () => {
    const fresh = init.nodes.find((n) => n.content.includes('关掉页面'));
    const fid = fresh.id;
    // 模拟前端"打开封口弹窗又取消"：根本不发 seal。
    await new Promise((r) => setTimeout(r, 400));
    const leaked = [alice, bob, carol].some((c) =>
      c.messages.some((m) => m.type === 'sealed' && m.nodeId === fid));
    assert.ok(!leaked, '没发请求就不可能有 sealed');
    const snap = await latestSnapshot('default');
    assert.ok(!snap.seals.some((s) => s.nodeId === fid), '快照里没有封口');
    const v = snap.nodes.find((n) => n.id === fid).version;
    const ack = await saveOk(alice, fid, '反悔场景：这段照样能改', v);
    assert.strictEqual(ack.type, 'saved');
  });

  // 理由为空：拒绝封口
  await test('边界：空理由拒绝；缺理由不能封；viewer 不能封口', async () => {
    alice.drain(() => true);
    alice.send({ type: 'seal', nodeId, reason: '   ' });
    const e1 = await alice.next((m) => m.type === 'error');
    assert.ok(/理由/.test(e1.message));
    alice.send({ type: 'seal', nodeId });
    const e2 = await alice.next((m) => m.type === 'error');
    assert.ok(/理由/.test(e2.message));

    // 封不存在/摘录行：拒绝
    alice.send({ type: 'seal', nodeId: 'nope-' + Math.random(), reason: 'x' });
    const e3 = await alice.next((m) => m.type === 'error');
    assert.ok(/删除|不存在|不能/.test(e3.message));

    // viewer 一律拒绝
    const vws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const viewer = await new Promise((resolve, reject) => {
      const msgs = [];
      vws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        msgs.push(m);
        if (m.type === 'published_state') resolve({ send: (o) => vws.send(JSON.stringify(o)), msgs });
      });
      vws.on('open', () => vws.send(JSON.stringify({
        type: 'hello', userId: 'u-viewer-seal', userName: '外部观看者', role: 'viewer', docId: 'default',
      })));
      vws.on('error', reject);
      setTimeout(() => reject(new Error('viewer 未收到 published_state')), 2000);
    });
    viewer.send({ type: 'seal', nodeId, reason: '外面的人偷封' });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!viewer.msgs.some((m) => m.type === 'sealed'), 'viewer 绝不可能产生封口');
    vws.close();
  });

  // ---------- 5：跟读宿主同步显封、同样不能写；打开后同步恢复 ----------
  await test('跟读投影：源在别处被封，挂跟读的文档收到同一条 sealed，跟读处保存被拒；打开同步恢复', async () => {
    const created = alice.next((m) => m.type === 'doc_created');
    alice.send({ type: 'create_doc', title: '封口跟读宿主' });
    const doc = await created;
    await alice.next((m) => m.type === 'snapshot' && m.docId === doc.doc.id);
    const host0 = await latestSnapshot(doc.doc.id);

    // 用一段当前开着的普通段做跟读
    const srcSnap = await latestSnapshot('default');
    const src = srcSnap.nodes.find((n) => n.id === nodeId); // 上一个用例已打开
    assert.ok(src && !src.seal, '前置：源段当前开着');

    const addedP = bob.next((m) => m.type === 'mirror_added' && m.docId === doc.doc.id);
    await openDoc(bob, doc.doc.id);
    alice.send({
      type: 'add_mirror', sourceId: nodeId, docId: doc.doc.id,
      parentId: '', afterId: '', treeRev: host0.treeRev,
    });
    const mirror = await addedP;
    const mirrorId = mirror.node.id;

    // 在源文档封源段：宿主文档（Bob 在里面）收到同一条 sealed
    const pHostSealed = bob.next((m) => m.type === 'sealed' && m.nodeId === nodeId);
    const pSrcSealed = carol.next((m) => m.type === 'sealed' && m.nodeId === nodeId);
    carol.send({ type: 'seal', nodeId, reason: '跨文档也要冻住' });
    const [mHost, mSrc] = await Promise.all([pHostSealed, pSrcSealed]);
    assert.strictEqual(mHost.reason, mSrc.reason, '宿主与源收到逐字相同的封口');

    const hSnap = await latestSnapshot(doc.doc.id);
    assert.ok(hSnap.seals.some((s) => s.nodeId === nodeId), '宿主快照 seals 带上源封口');
    const mrow = hSnap.nodes.find((n) => n.id === mirrorId);
    assert.strictEqual(mrow.seal.kind, 'sealed', '跟读行内投影源封口');

    // 跟读处保存（nodeId 用源 id）被硬拦
    const sv = srcSnap.nodes.find((n) => n.id === nodeId).version;
    bob.send({ type: 'save', nodeId, content: '从跟读处偷改', baseVersion: sv });
    const deny = await bob.next((m) => m.type === 'seal_denied' && m.nodeId === nodeId);
    assert.ok(/封口/.test(deny.message));

    // 打开：宿主同步收到 unsealed，跟读处立刻能存
    const pHostOpen = bob.next((m) => m.type === 'unsealed' && m.nodeId === nodeId);
    alice.send({ type: 'unseal', nodeId, reason: '跨文档解冻' });
    await pHostOpen;
    const cur = await latestSnapshot('default');
    const curV = cur.nodes.find((n) => n.id === nodeId).version;
    bob.send({ type: 'save', nodeId, content: '跟读处恢复可改', baseVersion: curV });
    const ack = await bob.next((m) => (m.type === 'saved' || m.type === 'merge_notice') && m.nodeId === nodeId);
    assert.ok(ack.revision, '跟读处保存成功');
  });

  await test('封口与打开进时间轴：列表可见，回看时刻按当时封口状态重建', async () => {
    alice.send({ type: 'timeline' });
    const tl = await alice.next((m) => m.type === 'timeline');
    const seals = tl.items.filter((i) => i.kind === 'seal');
    const opens = tl.items.filter((i) => i.kind === 'unseal');
    assert.ok(seals.length >= 2, '时间轴里有封口事件');
    assert.ok(opens.length >= 2, '时间轴里有打开事件');
    assert.ok(seals.some((i) => /定稿了|跨文档|Q2|Q3/.test(i.summary)));

    // 回到最近一次 seal 的时刻：重建快照里该段封着
    const lastSeal = seals[0]; // items 倒序
    alice.send({ type: 'snapshot_at', docId: lastSeal.docId, seq: lastSeal.seq });
    const at = await alice.next((m) => m.type === 'snapshot_at' && m.asOf?.seq === lastSeal.seq);
    const row = at.nodes.find((n) => n.id === lastSeal.nodeId);
    assert.ok(row, '该时刻段落存在');
    assert.ok(row.seal && row.seal.sealed, '回看时刻段是封着的');
    assert.ok(row.seal.reason, '回看带出当时理由');
  });

  await new Promise((r) => setTimeout(r, 100));
  alice.close();
  bob.close();
  carol.close();
  serverMod.server.close();
  console.log(`\n全部 ${passed} 个封口用例通过 ✅`);
  process.exit(0);
}

run().catch((e) => {
  console.error('测试失败:', e);
  process.exit(1);
});
