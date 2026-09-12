'use strict';

// 捞回删除段落（回收站）端到端。
//
// 用户的五条需求对应的机制：
// 1. 被拿掉的段要有一份"当时看着的人都能看见"的可捞名单：
//    删除普通段落（含子树）同事务写 trash_events，广播 nodes_deleted 之外再广播
//    一条 trash_update（整个房间，含发起者其他标签页）；晚加入者从 snapshot.trash
//    整份拿到。跟读/摘录的摘除只是移除引用，源还在，不进名单。
// 2. 有人捞回：整棵子树在单个事务里复活，nodes_restored 一条广播带回"拿掉前的
//    位置（夹在删前邻居之间）+ 原文快照（nodes）"，全员（含跟读宿主 source_restored）
//    看到同一份；挂跟读的墓碑撤除、重新投影原文；留言随段一起回来。
// 3. 两人几乎同时捞同一批、手里认定的树还不一样：tree_rev 乐观锁 + 批次
//    active=1 的 CAS，只有先到者那条 nodes_restored 被广播，后到者收
//    restore_stale（随整份快照纠正），不可能两边都显示捞回来、位置对不上。
// 4. 捞回还没发出去就反悔：确认弹窗不发 restore（这里验证"不发=树保持拿掉的样子"）。
// 5. 顶层夹在两邻居之间的段落捞回后排回原位置（不落到大纲最底下），包括删除期间
//    同一分数槽被新段占用的撞槽情形。
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
        if (hit) {
          this.messages.splice(this.messages.indexOf(hit), 1);
          return resolve(hit);
        }
        const t = setTimeout(() => reject(new Error('等待消息超时')), timeout);
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

// 严格打开：先排空历史消息，再请求；只消费这次请求之后到达的那份快照
async function openDoc(client, docId) {
  client.drain(() => true);
  client.send({ type: 'open_doc', docId });
  return client.next((m) => m.type === 'snapshot' && m.docId === docId);
}

async function latestSnapshot(docId) {
  const tmp = await connect('__snap__' + Math.random().toString(36).slice(2, 7), 'u-snap-' + Math.random().toString(36).slice(2));
  const snap = await openDoc(tmp, docId);
  tmp.close();
  return snap;
}

function topOrder(snap) {
  return snap.nodes
    .filter((n) => n.parentId == null)
    .sort((a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : 0))
    .map((n) => n.content);
}

// 删除并拿到这一批名单条目（nodes_deleted 与 trash_update 是删一次同时下发的）
async function deleteAndGetTrash(deleter, docId, nodeId) {
  const treeRev = (await latestSnapshot(docId)).treeRev;
  deleter.drain(() => true);
  deleter.send({ type: 'delete', nodeId, treeRev });
  const del = await deleter.next((m) => m.type === 'nodes_deleted' && m.ids.includes(nodeId));
  const upd = await deleter.next((m) => m.type === 'trash_update' && m.docId === docId);
  return { del, item: upd.trash.find((t) => t.rootId === nodeId), treeRevAfter: del.treeRev };
}

async function run() {
  await new Promise((r) => serverMod.server.listen(PORT, r));
  console.log(`捞回测试服务已在 ${PORT} 启动`);

  const alice = await connect('Alice', 'u-ta');
  const bob = await connect('Bob', 'u-tb');
  const carol = await connect('Carol', 'u-tc');

  const init = await latestSnapshot('default');
  const parent = init.nodes.find((n) => n.content.includes('项目目标'));
  const child = init.nodes.find((n) => n.content.includes('实时看到'));
  const child2 = init.nodes.find((n) => n.content.includes('关掉页面'));
  const parentId = parent.id;
  const childId = child.id;
  const child2Id = child2.id;
  const childContent = child.content;
  const subtreeIds = [parentId, childId, child2Id].sort();

  // ---------- 1：删除后全员（含发起者）同一份名单；快照里也有 ----------
  let batch = null;
  await test('删除：三人收到同一条 trash_update，名单条目（root/数量/摘要/原位/原文）逐字一致', async () => {
    const pA = alice.next((m) => m.type === 'trash_update');
    const pB = bob.next((m) => m.type === 'trash_update');
    const pC = carol.next((m) => m.type === 'trash_update');
    alice.send({ type: 'delete', nodeId: parentId, treeRev: init.treeRev });
    const [uA, uB, uC] = await Promise.all([pA, pB, pC]);
    const itemsA = uA.trash.filter((t) => t.rootId === parentId);
    assert.strictEqual(itemsA.length, 1);
    batch = itemsA[0];
    assert.strictEqual(batch.active, 1);
    assert.deepStrictEqual([...batch.ids].sort(), subtreeIds);
    assert.strictEqual(batch.count, 3);
    assert.ok(batch.preview.includes('项目目标'));
    assert.strictEqual(batch.content, parent.content, '名单里带 root 删前完整原文');
    assert.strictEqual(batch.parentId, null, '删掉前在顶层');
    assert.strictEqual(batch.author, 'Alice');
    const norm = (list) => list.map((t) => ({ ...t, ids: [...t.ids].sort() }));
    assert.deepStrictEqual(norm(uB.trash), norm(uA.trash), 'Bob 与 Alice 的名单逐字一致');
    assert.deepStrictEqual(norm(uC.trash), norm(uA.trash), 'Carol 与 Alice 的名单逐字一致');
    // 树上确实没了（nodes_deleted 广播）
    for (const c of [alice, bob, carol]) {
      const gone = c.drain((m) => m.type === 'nodes_deleted');
      assert.ok(gone.some((m) => m.ids.includes(parentId) && m.ids.includes(childId) && m.ids.includes(child2Id)));
    }
  });

  await test('晚加入的人从 snapshot.trash 拿到同一份名单（不是只有当时在场的人屏幕上有）', async () => {
    const snap = await latestSnapshot('default');
    const item = snap.trash.find((t) => t.rootId === parentId);
    assert.ok(item, '快照 trash 里有这批');
    assert.strictEqual(item.id, batch.id);
    assert.strictEqual(item.content, parent.content);
    assert.ok(!snap.nodes.some((n) => n.id === parentId || n.id === childId || n.id === child2Id), '快照树里已拿掉');
  });

  // ---------- 2：捞回后全员看到同一份"原位 + 原文"，子树一起回来 ----------
  await test('捞回：一条 nodes_restored 带回原位与原文快照，三人的树逐字一致；顺序排在删前邻居之间', async () => {
    const pA = alice.next((m) => m.type === 'nodes_restored' && m.trashId === batch.id);
    const pB = bob.next((m) => m.type === 'nodes_restored' && m.trashId === batch.id);
    const pC = carol.next((m) => m.type === 'nodes_restored' && m.trashId === batch.id);
    bob.send({ type: 'restore', trashId: batch.id, treeRev: (await latestSnapshot('default')).treeRev });
    const [mA, mB, mC] = await Promise.all([pA, pB, pC]);
    for (const m of [mA, mB, mC]) {
      assert.deepStrictEqual([...m.ids].sort(), subtreeIds);
      assert.strictEqual(m.rootId, parentId);
      assert.strictEqual(m.parentId, null, '放回顶层（拿掉前的位置）');
      assert.ok(m.pos, '带回拿掉前的同级位置');
      const rootNode = m.nodes.find((n) => n.id === parentId);
      const childNode = m.nodes.find((n) => n.id === childId);
      const child2Node = m.nodes.find((n) => n.id === child2Id);
      assert.strictEqual(rootNode.content, parent.content, 'root 原文逐字回来');
      assert.strictEqual(childNode.content, childContent, '子段原文逐字回来');
      assert.strictEqual(childNode.parentId, parentId, '子段仍挂在原父级下');
      assert.strictEqual(child2Node.parentId, parentId, '整棵子树一起回来');
      assert.ok(!m.trash.some((t) => t.id === batch.id), '名单里这批消失');
    }
    // 晚加入快照也一致
    const snap = await latestSnapshot('default');
    const rootRow = snap.nodes.find((n) => n.id === parentId);
    const childRow = snap.nodes.find((n) => n.id === childId);
    assert.strictEqual(rootRow.content, parent.content);
    assert.strictEqual(childRow.content, childContent);
    assert.strictEqual(childRow.parentId, parentId);
    assert.ok(snap.nodes.some((n) => n.id === child2Id));
    assert.ok(!snap.trash.some((t) => t.id === batch.id));
    // 顶层顺序：parent(n1) 必须排回 n4 前面（不能掉到大纲最底下）
    const topIds = snap.nodes
      .filter((n) => n.parentId == null)
      .sort((a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : 0))
      .map((n) => n.id);
    assert.ok(topIds.indexOf(parentId) < topIds.indexOf('n4'), '捞回后夹在删前邻居之间，而不是排到末尾');
  });

  // ---------- 2b：夹在顶层中间的段：删除后邻居保留，捞回必须回到两邻居中间 ----------
  await test('回归：夹在顶层中间的段捞回后排回原邻居之间（同房间所有人看到同一顺序）', async () => {
    for (const c of [alice, bob, carol]) c.drain(() => true);
    alice.send({ type: 'create_doc', title: '顺序回归-' + Math.random().toString(36).slice(2, 6) });
    const docId = (await alice.next((m) => m.type === 'doc_created')).doc.id;
    await alice.next((m) => m.type === 'snapshot' && m.docId === docId);

    async function addTop(content, afterId) {
      const s = await openDoc(alice, docId);
      const p = alice.next((m) => m.type === 'node_added');
      alice.send({ type: 'add', docId, parentId: '', afterId: afterId || '', content, treeRev: s.treeRev });
      return (await p).node.id;
    }
    const aId = await addTop('段A', '');
    const bId = await addTop('段B', aId);
    const cId = await addTop('段C', bId);
    const order = async () => topOrder(await latestSnapshot(docId));
    assert.deepStrictEqual(await order(), ['段A', '段B', '段C']);

    // Bob 也进这份文档，观察捞回广播里的顺序
    await openDoc(bob, docId);
    const s0 = await latestSnapshot(docId);
    alice.drain(() => true); bob.drain(() => true);
    const pBob = bob.next((m) => m.type === 'nodes_restored');
    const pAlice = alice.next((m) => m.type === 'nodes_restored');
    alice.send({ type: 'delete', nodeId: bId, treeRev: s0.treeRev });
    const upd = await alice.next((m) => m.type === 'trash_update');
    const item = upd.trash.find((t) => t.rootId === bId);
    assert.deepStrictEqual(
      (await latestSnapshot(docId)).nodes.filter((n) => n.parentId == null)
        .sort((x, y) => (x.pos < y.pos ? -1 : 1)).map((n) => n.content),
      ['段A', '段C'], '删除后前后邻居保留');

    let s = await latestSnapshot(docId);
    alice.send({ type: 'restore', trashId: item.id, treeRev: s.treeRev });
    const [rAlice, rBob] = await Promise.all([pAlice, pBob]);
    for (const m of [rAlice, rBob]) {
      assert.strictEqual(m.nodes.find((n) => n.id === bId).content, '段B', '原文逐字回来');
    }
    assert.deepStrictEqual(await order(), ['段A', '段B', '段C'], '捞回后回到 A、C 中间');

    // 撞槽情形：删掉 B 后在 A 之后插入新段——midpoint('1','3') 恰好等于 B 的旧 pos，
    // 旧位置槽被占用；捞回 B 必须贴着占用者落回原间隙，而不是掉到末尾。
    s = await latestSnapshot(docId);
    alice.drain(() => true);
    alice.send({ type: 'delete', nodeId: bId, treeRev: s.treeRev });
    const upd2 = await alice.next((m) => m.type === 'trash_update');
    const item2 = upd2.trash.find((t) => t.rootId === bId);
    const sAdd = await openDoc(alice, docId);
    const pNew = alice.next((m) => m.type === 'node_added');
    alice.send({ type: 'add', docId, parentId: '', afterId: aId, content: '段E', treeRev: sAdd.treeRev });
    await pNew;
    s = await latestSnapshot(docId);
    alice.drain(() => true);
    const pBack = alice.next((m) => m.type === 'nodes_restored');
    alice.send({ type: 'restore', trashId: item2.id, treeRev: s.treeRev });
    await pBack;
    assert.deepStrictEqual(await order(), ['段A', '段B', '段E', '段C'],
      '旧位置槽被占用也不落到末尾：B 贴着占用者落回原间隙（仍在 C 之前）');
    void cId;
  });

  // ---------- 3：挂跟读的地方也一起回来 ----------
  let second = null;
  await test('源被删时跟读变墓碑；捞回后跟读宿主收到 source_restored，墓碑撤除、投影原文', async () => {
    for (const c of [alice, bob, carol]) c.drain(() => true);
    const title = '跟读宿主-' + Math.random().toString(36).slice(2, 6);
    alice.send({ type: 'create_doc', title });
    const hostId = (await alice.next((m) => m.type === 'doc_created')).doc.id;
    await alice.next((m) => m.type === 'snapshot' && m.docId === hostId);

    const hostSnap = await openDoc(alice, hostId);
    const pMirror = alice.next((m) => m.type === 'mirror_added');
    alice.send({
      type: 'add_mirror', sourceId: parentId, docId: hostId,
      parentId: '', afterId: '', treeRev: hostSnap.treeRev,
    });
    const mirrorId = (await pMirror).node.id;

    const bobHost = await openDoc(bob, hostId);
    assert.ok(bobHost.nodes.some((n) => n.id === mirrorId && n.content === parent.content));

    const defSnap = await openDoc(alice, 'default');
    const pHostTomb = alice.next((m) => m.type === 'source_deleted' && m.sourceIds.includes(parentId));
    alice.send({ type: 'delete', nodeId: parentId, treeRev: defSnap.treeRev });
    second = (await alice.next((m) => m.type === 'trash_update')).trash.find((t) => t.rootId === parentId);
    await pHostTomb;
    const tombSnap = await openDoc(alice, hostId);
    const tombRow = tombSnap.nodes.find((n) => n.id === mirrorId);
    assert.strictEqual(tombRow.sourceDeleted, 1, '跟读行是墓碑');
    assert.ok(!tombRow.content, '墓碑不带旧正文');
    await bob.next((m) => m.type === 'source_deleted' && m.sourceIds.includes(parentId));

    // carol 从默认文档捞回（发起人不限删除者）
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
  await test('两人几乎同时捞同一批：只有一条 nodes_restored，另一人收 stale + 快照，两边最终一致', async () => {
    for (const c of [alice, bob, carol]) c.drain(() => true);
    const s1 = await latestSnapshot('default');
    assert.ok(s1.nodes.some((n) => n.id === childId), '前置：child 已随上一批捞回');
    const d = await deleteAndGetTrash(alice, 'default', childId);
    const third = d.item;
    assert.deepStrictEqual(third.ids, [childId]);

    const sNow = await latestSnapshot('default');
    // 注意：nodes_restored 是房间广播（输的人也会收到，界面正是靠它收敛）。
    // 区分输赢只能看服务器单发给请求者的 stale 类回执：赢家没有个人回执。
    const staleFilter = (m) => m.type === 'restore_stale' || m.type === 'tree_stale';
    let loser = null;
    const pA = alice.next(staleFilter).then(() => { loser = 'alice'; });
    const pB = bob.next(staleFilter).then(() => { loser = 'bob'; });
    alice.send({ type: 'restore', trashId: third.id, treeRev: sNow.treeRev });
    bob.send({ type: 'restore', trashId: third.id, treeRev: sNow.treeRev });
    await Promise.race([pA, pB, new Promise((r) => setTimeout(r, 2000))]);
    assert.ok(loser, '恰好一个人收到只发给本人的 stale 回执（另一个人赢，无个人回执）');
    // 等广播送达各端
    await new Promise((r) => setTimeout(r, 300));
    // 三个人都只可能收到一条 nodes_restored 广播
    for (const c of [alice, bob, carol]) {
      const seen = c.drain((m) => m.type === 'nodes_restored' && m.trashId === third.id);
      assert.strictEqual(seen.length, 1, '房间里只有一条捞回广播');
    }

    const finalSnap = await latestSnapshot('default');
    assert.ok(finalSnap.nodes.some((n) => n.id === childId && n.content === childContent),
      '两边最终树一致：child 已在原位、原文');
    assert.ok(!finalSnap.trash.some((t) => t.id === third.id), '名单已无这批');
  });

  // ---------- 5：没发请求就反悔：树保持上一份拿掉的样子 ----------
  await test('不发 restore 就没有任何变化：打开确认/取消期间树仍是拿掉状态、名单仍在', async () => {
    for (const c of [alice, bob, carol]) c.drain(() => true);
    const d = await deleteAndGetTrash(alice, 'default', parentId);
    const fourth = d.item;
    alice.send({ type: 'heartbeat' });
    await alice.next((m) => m.type === 'heartbeat_ack');
    const still = await latestSnapshot('default');
    assert.ok(still.trash.some((t) => t.id === fourth.id), '反悔后名单仍在');
    assert.ok(!still.nodes.some((n) => n.id === parentId), '反悔后树仍是拿掉的样子');
    assert.strictEqual(still.treeRev, d.treeRevAfter, '没有任何结构写入');
    // 清理：真正捞回来
    alice.drain(() => true);
    alice.send({ type: 'restore', trashId: fourth.id, treeRev: still.treeRev });
    await alice.next((m) => m.type === 'nodes_restored' && m.trashId === fourth.id);
  });

  // ---------- 6：跟读/摘录的摘除不进名单 ----------
  await test('移除摘录只是删引用行：不进可捞名单（源还在，不用捞）', async () => {
    for (const c of [alice, bob, carol]) c.drain(() => true);
    alice.send({ type: 'create_doc', title: '摘录宿主-' + Math.random().toString(36).slice(2, 6) });
    const exHost = (await alice.next((m) => m.type === 'doc_created')).doc.id;
    await alice.next((m) => m.type === 'snapshot' && m.docId === exHost);
    const hsnap = await openDoc(alice, exHost);
    alice.send({
      type: 'add_excerpt', sourceId: parentId, docId: exHost,
      parentId: '', afterId: '', treeRev: hsnap.treeRev,
    });
    const exId = (await alice.next((m) => m.type === 'excerpt_added')).node.id;
    const hsnap2 = await openDoc(alice, exHost);
    alice.send({ type: 'delete', nodeId: exId, treeRev: hsnap2.treeRev });
    await alice.next((m) => m.type === 'nodes_deleted' && m.ids.includes(exId));
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(alice.drain((m) => m.type === 'trash_update').length, 0);
    assert.strictEqual((await openDoc(alice, exHost)).trash.length, 0, '宿主文档名单为空');
    assert.ok(!(await openDoc(alice, 'default')).trash.some((t) => t.rootId === exId), '源文档名单里也没有引用行');
    const def = await latestSnapshot('default');
    assert.ok(def.nodes.some((n) => n.id === parentId), '源段落本身还活着');
  });

  // ---------- 7：留言随段捞回 ----------
  await test('删除期间留言不丢：捞回广播带回这些段上的留言', async () => {
    for (const c of [alice, bob, carol]) c.drain(() => true);
    const cid = 'cmt-restore-' + Math.random().toString(36).slice(2, 8);
    alice.send({ type: 'comment_add', nodeId: parentId, commentId: cid, content: '删之前留的话' });
    await bob.next((m) => m.type === 'comment_added' && m.comment?.id === cid);
    const d = await deleteAndGetTrash(alice, 'default', parentId);
    alice.drain(() => true);
    alice.send({ type: 'restore', trashId: d.item.id, treeRev: (await latestSnapshot('default')).treeRev });
    const restored = await alice.next((m) => m.type === 'nodes_restored' && m.trashId === d.item.id);
    const cm = restored.comments.find((x) => x.id === cid);
    assert.ok(cm, '捞回广播带回留言');
    assert.strictEqual(cm.content, '删之前留的话');
    assert.strictEqual(cm.nodeId, parentId);
  });

  // ---------- 8：捞回进时间轴；时刻重建是 seq 的纯函数 ----------
  await test('捞回写时间轴 restore：时间轴事件可见，snapshot_at 在捞回时刻能重建该段', async () => {
    alice.drain(() => true);
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
