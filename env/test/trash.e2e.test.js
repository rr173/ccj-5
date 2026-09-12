'use strict';

// 捞回删除段落（回收站）端到端。
//
// 用户的五条需求对应的机制：
// 1. 被拿掉的段要有一份"当时看着的人都能看见"的可捞名单：
//    删除普通段落（含子树）同事务写 trash_events，广播 nodes_deleted 之外再广播
//    一条 trash_update（整个房间，含发起者其他标签页）；晚加入者从 snapshot.trash
//    整份拿到。跟读/摘录的摘除只是移除引用，源还在，不进名单。
// 2. 有人捞回：整棵子树在单个事务里复活，nodes_restored 一条广播带回"拿掉前的
//    位置（parentId/pos）+ 原文快照（nodes）"，全员（含跟读宿主 source_restored）
//    看到同一份；挂跟读的墓碑撤除、重新投影原文；留言随段一起回来。
// 3. 两人几乎同时捞同一批、手里认定的树还不一样：tree_rev 乐观锁 + 批次
//    active=1 的 CAS，只有先到者那条 nodes_restored 被广播，后到者收
//    restore_stale（随整份快照纠正），不可能两边都显示捞回来、位置对不上。
// 4. 捞回还没发出去就反悔：确认弹窗不发 restore（这里验证"不发=树保持拿掉的样子"）。
// 5. 摘录取回不自动换字（顺带守住）：source_restored 只撤墓碑，摘录不收到正文。
//
// 运行：WS_PORT=3786 DB_FILE=./data/trash.db node test/trash.e2e.test.js

process.env.WS_PORT = process.env.WS_PORT || '3786';
process.env.DB_FILE = process.env.DB_FILE || './data/trash.db';
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
        const t = setTimeout(() => reject(new Error('等待消息超时: ' + String(filter.name || '').slice(0, 100))), timeout);
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

// 删除并拿到这一批名单条目（nodes_deleted 之后广播 trash_update）
async function deleteAndGetTrash(deleter, docId, nodeId) {
  const treeRev = (await latestSnapshot(docId)).treeRev;
  const pDel = deleter.next((m) => m.type === 'nodes_deleted' && m.ids.includes(nodeId));
  const pTrash = deleter.next((m) => m.type === 'trash_update' && m.docId === docId);
  deleter.send({ type: 'delete', nodeId, treeRev });
  const [del, upd] = await Promise.all([pDel, pTrash]);
  return { del, item: upd.trash.find((t) => t.rootId === nodeId), treeRevAfter: del.treeRev };
}

async function run() {
  await new Promise((r) => serverMod.server.listen(PORT, r));
  console.log(`捞回测试服务已在 ${PORT} 启动`);

  const alice = await connect('Alice', 'u-ta');
  const bob = await connect('Bob', 'u-tb');
  const carol = await connect('Carol', 'u-tc');
  await bob.next((m) => m.type === 'snapshot');
  await carol.next((m) => m.type === 'snapshot');

  const init = await latestSnapshot('default');
  const parent = init.nodes.find((n) => n.content.includes('项目目标'));
  const child = init.nodes.find((n) => n.content.includes('实时看到'));
  const parentId = parent.id;
  const childId = child.id;
  const childContent = child.content;

  // ---------- 1：删除后全员（含发起者）同一份名单；快照里也有 ----------
  let batch = null;
  await test('删除：三人收到同一条 trash_update，名单条目内容（root/数量/摘要/原位/原文）逐字一致', async () => {
    const treeRev = init.treeRev;
    const pA = alice.next((m) => m.type === 'trash_update');
    const pB = bob.next((m) => m.type === 'trash_update');
    const pC = carol.next((m) => m.type === 'trash_update');
    alice.send({ type: 'delete', nodeId: parentId, treeRev });
    const [uA, uB, uC] = await Promise.all([pA, pB, pC]);
    const itemsA = uA.trash.filter((t) => t.rootId === parentId);
    assert.strictEqual(itemsA.length, 1);
    batch = itemsA[0];
    assert.ok(batch.active === 1);
    assert.deepStrictEqual(batch.ids.sort(), [childId, parentId].sort());
    assert.strictEqual(batch.count, 2);
    assert.ok(batch.preview.includes('项目目标'));
    assert.strictEqual(batch.content, parent.content, '名单里带 root 删前完整原文');
    assert.strictEqual(batch.parentId, null, '删掉前在顶层');
    assert.strictEqual(batch.author, 'Alice');
    assert.deepStrictEqual(uB.trash, uA.trash, 'Bob 与 Alice 的名单逐字一致');
    assert.deepStrictEqual(uC.trash, uA.trash, 'Carol 与 Alice 的名单逐字一致');
    // 树上确实没了
    for (const c of [alice, bob, carol]) {
      const gone = c.drain((m) => m.type === 'nodes_deleted');
      assert.ok(gone.some((m) => m.ids.includes(parentId) && m.ids.includes(childId)));
    }
  });

  await test('晚加入的人从 snapshot.trash 拿到同一份名单（不是只有当时在场的人屏幕上有）', async () => {
    const snap = await latestSnapshot('default');
    const item = snap.trash.find((t) => t.rootId === parentId);
    assert.ok(item, '快照 trash 里有这批');
    assert.strictEqual(item.id, batch.id);
    assert.strictEqual(item.content, parent.content);
    assert.ok(!snap.nodes.some((n) => n.id === parentId || n.id === childId), '快照树里已拿掉');
  });

  // ---------- 2：捞回后全员看到同一份"原位 + 原文"，跟读处一起回来 ----------
  await test('捞回：一条 nodes_restored 带回原位与原文快照，三人的树逐字一致；子树一起回来', async () => {
    const pA = alice.next((m) => m.type === 'nodes_restored' && m.trashId === batch.id);
    const pB = bob.next((m) => m.type === 'nodes_restored' && m.trashId === batch.id);
    const pC = carol.next((m) => m.type === 'nodes_restored' && m.trashId === batch.id);
    bob.send({ type: 'restore', trashId: batch.id, treeRev: batch && (await latestSnapshot('default')).treeRev });
    const [mA, mB, mC] = await Promise.all([pA, pB, pC]);
    for (const m of [mA, mB, mC]) {
      assert.deepStrictEqual(m.ids.sort(), [childId, parentId].sort());
      assert.strictEqual(m.rootId, parentId);
      assert.strictEqual(m.parentId, null, '放回顶层（拿掉前的位置）');
      assert.ok(m.pos, '带回拿掉前的同级位置');
      const rootNode = m.nodes.find((n) => n.id === parentId);
      const childNode = m.nodes.find((n) => n.id === childId);
      assert.strictEqual(rootNode.content, parent.content, 'root 原文逐字回来');
      assert.strictEqual(childNode.content, childContent, '子段原文逐字回来');
      assert.strictEqual(childNode.parentId, parentId, '子段仍挂在原父级下');
      assert.ok(!m.trash.some((t) => t.id === batch.id), '名单里这批消失');
    }
    // 晚加入快照也一致
    const snap = await latestSnapshot('default');
    const rootRow = snap.nodes.find((n) => n.id === parentId);
    const childRow = snap.nodes.find((n) => n.id === childId);
    assert.strictEqual(rootRow.content, parent.content);
    assert.strictEqual(childRow.content, childContent);
    assert.strictEqual(childRow.parentId, parentId);
    assert.ok(!snap.trash.some((t) => t.id === batch.id));
  });

  // ---------- 3：挂跟读的地方也一起回来 ----------
  let second = null;
  await test('源被删时跟读变墓碑；捞回后跟读宿主收到 source_restored，墓碑撤除、投影原文', async () => {
    // 新建一份大纲，把 parent 挂为跟读
    const title = '跟读宿主-' + Math.random().toString(36).slice(2, 6);
    alice.send({ type: 'create_doc', title });
    const created = await alice.next((m) => m.type === 'doc_created');
    const hostId = created.doc.id;
    await alice.next((m) => m.type === 'snapshot' && m.docId === hostId);
    // 等树版本就绪再挂跟读
    let hostSnap = await openDoc(alice, hostId);
    const pMirror = alice.next((m) => m.type === 'mirror_added');
    alice.send({
      type: 'add_mirror', sourceId: parentId, docId: hostId,
      parentId: '', afterId: '', treeRev: hostSnap.treeRev,
    });
    const mirror = await pMirror;
    const mirrorId = mirror.node.id;

    // 在宿主文档也接一个 bob
    const bobHost = await openDoc(bob, hostId);
    assert.ok(bobHost.nodes.some((n) => n.id === mirrorId && n.content === parent.content));

    // 删源（回默认文档）
    const defSnap = await openDoc(alice, 'default');
    const pHostTomb = alice.next((m) => m.type === 'source_deleted' && m.sourceIds.includes(parentId));
    alice.send({ type: 'delete', nodeId: parentId, treeRev: defSnap.treeRev });
    second = (await alice.next((m) => m.type === 'trash_update')).trash.find((t) => t.rootId === parentId);
    await pHostTomb;
    const tombSnap = await openDoc(alice, hostId);
    const tombRow = tombSnap.nodes.find((n) => n.id === mirrorId);
    assert.strictEqual(tombRow.sourceDeleted, 1, '跟读行是墓碑');
    assert.ok(!tombRow.content, '墓碑不带旧正文');

    // bob 在宿主也收到墓碑
    await bob.next((m) => m.type === 'source_deleted' && m.sourceIds.includes(parentId));

    // 从默认文档捞回（carol 动手，验证发起人不限删除者）
    const carolDef = await openDoc(carol, 'default');
    const pHostBack = alice.next((m) => m.type === 'source_restored' && m.sourceIds.includes(parentId));
    const pBobHostBack = bob.next((m) => m.type === 'source_restored' && m.sourceIds.includes(parentId));
    carol.send({ type: 'restore', trashId: second.id, treeRev: carolDef.treeRev });
    const [hostBack, bobHostBack] = await Promise.all([pHostBack, pBobHostBack]);
    const c = hostBack.contents.find((x) => x.nodeId === parentId);
    assert.ok(c, 'source_restored 给跟读宿主带回源当前正文');
    assert.strictEqual(c.content, parent.content, '投影的是拿掉前那份原文');
    assert.ok(bobHostBack.contents.some((x) => x.nodeId === parentId));

    const backSnap = await openDoc(alice, hostId);
    const row = backSnap.nodes.find((n) => n.id === mirrorId);
    assert.strictEqual(row.sourceDeleted, 0, '墓碑撤除');
    assert.strictEqual(row.content, parent.content, '跟读处原文一起回来');
  });

  // ---------- 4：并发捞同一批，只有一份成功 ----------
  await test('两人几乎同时捞同一批：只有一条 nodes_restored，另一人收 restore_stale + 快照，两边最终一致', async () => {
    // 先再造一批：删 child（父 parent 此刻活着）
    const s1 = await latestSnapshot('default');
    assert.ok(s1.nodes.some((n) => n.id === childId), '前置：child 已随上一批捞回');
    const d = await deleteAndGetTrash(alice, 'default', childId);
    const third = d.item;
    assert.ok(third, 'child 进名单');
    assert.deepStrictEqual(third.ids, [childId]);

    // Alice/Bob 都基于同一 treeRev 几乎同时发 restore
    const sNow = await latestSnapshot('default');
    const pA = alice.next((m) =>
      (m.type === 'nodes_restored' && m.trashId === third.id) ||
      (m.type === 'restore_stale' && m.trashId === third.id) ||
      (m.type === 'tree_stale'));
    const pB = bob.next((m) =>
      (m.type === 'nodes_restored' && m.trashId === third.id) ||
      (m.type === 'restore_stale' && m.trashId === third.id) ||
      (m.type === 'tree_stale'));
    alice.send({ type: 'restore', trashId: third.id, treeRev: sNow.treeRev });
    bob.send({ type: 'restore', trashId: third.id, treeRev: sNow.treeRev });
    const [rA, rB] = await Promise.all([pA, pB]);
    const winners = [rA, rB].filter((m) => m.type === 'nodes_restored');
    const losers = [rA, rB].filter((m) => m.type === 'restore_stale' || m.type === 'tree_stale');
    assert.strictEqual(winners.length, 1, '恰好一个人捞成功');
    assert.strictEqual(losers.length, 1, '另一个人被 CAS/乐观锁拦下');
    // Carol（第三人）只可能收到一条 nodes_restored
    const restoredSeen = carol.drain((m) => m.type === 'nodes_restored' && m.trashId === third.id);
    assert.strictEqual(restoredSeen.length, 1, '房间里只有一条捞回广播');

    // 输的人随后会收到快照纠正（tree_stale 后随 snapshot；restore_stale 路径也是）
    for (const c of [alice, bob]) {
      await c.next((m) => m.type === 'snapshot' && m.docId === 'default');
    }
    const finalSnap = await latestSnapshot('default');
    assert.ok(finalSnap.nodes.some((n) => n.id === childId && n.content === childContent),
      '两边最终树一致：child 已在原位、原文');
    assert.ok(!finalSnap.trash.some((t) => t.id === third.id), '名单已无这批');
  });

  // ---------- 5：没发请求就反悔：树保持上一份拿掉的样子 ----------
  await test('不发 restore 就没有任何变化：可反复打开/取消确认，树仍是拿掉状态、名单仍在', async () => {
    const before = await latestSnapshot('default');
    // 模拟"打开确认弹窗又取消"：客户端根本不发 restore。这里用服务器事实验证：
    // 删除一批后只等待，名单仍在、树仍缺段；再发一个无关心跳也不改变。
    const d = await deleteAndGetTrash(alice, 'default', parentId);
    const fourth = d.item;
    alice.send({ type: 'heartbeat' });
    await alice.next((m) => m.type === 'heartbeat_ack');
    const still = await latestSnapshot('default');
    assert.ok(still.trash.some((t) => t.id === fourth.id), '反悔后名单仍在');
    assert.ok(!still.nodes.some((n) => n.id === parentId), '反悔后树仍是拿掉的样子');
    assert.strictEqual(still.treeRev, d.treeRevAfter, '没有任何结构写入');
    // 清理：再真正捞回来，保证下条断言环境干净
    alice.send({ type: 'restore', trashId: fourth.id, treeRev: still.treeRev });
    await alice.next((m) => m.type === 'nodes_restored' && m.trashId === fourth.id);
    void before;
  });

  // ---------- 6：跟读/摘录的摘除不进名单 ----------
  await test('移除跟读/摘录只是删引用行：不进可捞名单（源还在，不用捞）', async () => {
    const title = '摘录宿主-' + Math.random().toString(36).slice(2, 6);
    alice.send({ type: 'create_doc', title });
    const created = await alice.next((m) => m.type === 'doc_created');
    const exHost = created.doc.id;
    await alice.next((m) => m.type === 'snapshot' && m.docId === exHost);
    let hsnap = await openDoc(alice, exHost);
    alice.send({
      type: 'add_excerpt', sourceId: parentId, docId: exHost,
      parentId: '', afterId: '', treeRev: hsnap.treeRev,
    });
    const ex = await alice.next((m) => m.type === 'excerpt_added');
    const exId = ex.node.id;
    hsnap = await openDoc(alice, exHost);
    alice.send({ type: 'delete', nodeId: exId, treeRev: hsnap.treeRev });
    await alice.next((m) => m.type === 'nodes_deleted' && m.ids.includes(exId));
    // 没有 trash_update 即名单不变
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(alice.drain((m) => m.type === 'trash_update').length, 0);
    const hostTrash = (await openDoc(alice, exHost)).trash;
    assert.strictEqual(hostTrash.length, 0, '宿主文档名单为空');
    const defTrash = (await openDoc(alice, 'default')).trash;
    assert.ok(!defTrash.some((t) => t.rootId === exId), '源文档名单里也没有引用行');
    // 源段落本身还活着
    const def = await latestSnapshot('default');
    assert.ok(def.nodes.some((n) => n.id === parentId));
  });

  // ---------- 7：留言随段捞回 ----------
  await test('删除期间留言不丢：捞回广播带回这些段上的留言', async () => {
    const cid = 'cmt-restore-' + Math.random().toString(36).slice(2, 8);
    alice.send({ type: 'comment_add', nodeId: parentId, commentId: cid, content: '删之前留的话' });
    await bob.next((m) => m.type === 'comment_added' && m.comment?.id === cid);
    const d = await deleteAndGetTrash(alice, 'default', parentId);
    // 删除广播里名单有，留言在默认房间视图里随段消失（数据没删）
    alice.send({ type: 'restore', trashId: d.item.id, treeRev: (await latestSnapshot('default')).treeRev });
    const restored = await alice.next((m) => m.type === 'nodes_restored' && m.trashId === d.item.id);
    const cm = restored.comments.find((c) => c.id === cid);
    assert.ok(cm, '捞回广播带回留言');
    assert.strictEqual(cm.content, '删之前留的话');
    assert.strictEqual(cm.nodeId, parentId);
  });

  // ---------- 8：捞回进时间轴；时刻重建是 seq 的纯函数 ----------
  await test('捞回写时间轴 restore：时间轴事件可见，snapshot_at 在捞回时刻能重建该段', async () => {
    alice.send({ type: 'timeline' });
    const tl = await alice.next((m) => m.type === 'timeline');
    const restoreEvents = tl.items.filter((m) => m.kind === 'restore');
    assert.ok(restoreEvents.length >= 3, '至少三次捞回事件');
    const seq = restoreEvents[0].seq;
    alice.send({ type: 'snapshot_at', docId: 'default', seq });
    const at = await alice.next((m) => m.type === 'snapshot_at' && m.asOf?.seq === seq);
    assert.ok(at.nodes.some((n) => n.id === parentId && n.content === parent.content),
      '捞回时刻重建：段在原位、原文');
  });

  console.log(`\n捞回删除段落 ${passed} 个场景全部通过`);
  serverMod.server.close(() => process.exit(0));
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
