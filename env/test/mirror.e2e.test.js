'use strict';

// 多文档 + 跟读（镜像段落）端到端。
// 运行：WS_PORT=3778 WS_PING_MS=300 DB_FILE=./data/mirror.db node test/mirror.e2e.test.js

process.env.WS_PORT = process.env.WS_PORT || '3778';
process.env.DB_FILE = process.env.DB_FILE || './data/mirror.db';
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
        const t = setTimeout(() => reject(new Error('等待消息超时: ' + JSON.stringify(filter.toString().slice(0, 80)))), timeout);
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
        // 消费自动打开的默认文档快照与 doc_list
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

async function createDoc(client, title) {
  const created = client.next((m) => m.type === 'doc_created');
  client.send({ type: 'create_doc', title });
  const m = await created;
  // 服务器随后会发 snapshot（自动打开）
  await client.next((x) => x.type === 'snapshot' && x.docId === m.doc.id);
  return m.doc;
}

async function run() {
  await new Promise((r) => serverMod.server.listen(PORT, r));
  console.log(`多文档/跟读测试服务已在 ${PORT} 启动`);

  const alice = await connect('Alice', 'u-ma');
  const bob = await connect('Bob', 'u-mb');
  await bob.next((m) => m.type === 'snapshot');

  // ---------- 1：创建第二份大纲；doc_list 广播；树独立 ----------
  let docB;
  await test('创建新大纲：创建者收到 doc_created + 快照，其他人收到 doc_list', async () => {
    bob.drain((m) => m.type === 'doc_list');
    const listP = bob.next((m) =>
      m.type === 'doc_list' && m.docs.some((d) => d.title === '会议纪要'));
    docB = await createDoc(alice, '会议纪要');
    assert.ok(docB.id);
    const list = await listP;
    assert.ok(list.docs.some((d) => d.id === docB.id && d.title === '会议纪要'));
    const defSnap = await latestSnapshot('default');
    const bSnap = await latestSnapshot(docB.id);
    assert.ok(defSnap.nodes.length >= 5, '默认文档种子段落不动');
    assert.strictEqual(bSnap.nodes.length, 0, '新大纲初始为空');
    assert.strictEqual(bSnap.docId, docB.id, '快照属于新大纲');
    globalThis.__docB = docB.id;
  });
  const docBId = globalThis.__docB;

  // ---------- 2：把默认文档的一段挂为跟读进 docB ----------
  let mirrorId, sourceId;
  await test('挂跟读：目标文档出现 mirror 行，正文投影自源，带 sourceDocId', async () => {
    const def = await snapshot(alice, 'default');
    sourceId = def.nodes.find((n) => n.content.includes('实时看到')).id;

    const b0 = await snapshot(alice, docBId);
    const addP = bob.next((m) => m.type === 'mirror_added' && m.docId === docBId);
    await snapshot(bob, docBId); // 订阅
    alice.send({
      type: 'add_mirror',
      sourceId,
      docId: docBId,
      parentId: '',
      afterId: '',
      treeRev: b0.treeRev,
    });
    const added = await addP;
    mirrorId = added.node.id;
    assert.strictEqual(added.node.kind, 'mirror');
    assert.strictEqual(added.node.mirrorOf, sourceId);
    assert.strictEqual(added.node.content, def.nodes.find((n) => n.id === sourceId).content);

    const snap = await latestSnapshot(docBId);
    const m = snap.nodes.find((n) => n.id === mirrorId);
    assert.ok(m, '跟读在目标大纲快照里');
    assert.strictEqual(m.kind, 'mirror');
    assert.strictEqual(m.sourceDocId, 'default');
    assert.ok(!m.sourceDeleted);
  });

  // ---------- 3：源改正文，跟读处内容跟着变（跨文档 content 扇出）----------
  await test('源段落修改：跟读宿主文档实时收到 content，两边是同一份文本/版本', async () => {
    const def = await latestSnapshot('default');
    const src = def.nodes.find((n) => n.id === sourceId);
    const pBob = bob.next((m) => m.type === 'content' && m.nodeId === sourceId);
    alice.send({
      type: 'save', nodeId: sourceId,
      content: src.content + '【源改动】',
      baseVersion: src.version,
    });
    const content = await pBob;
    assert.ok(content.content.includes('【源改动】'));

    // 跟读宿主快照投影的也是新正文
    const bSnap = await latestSnapshot(docBId);
    const m = bSnap.nodes.find((n) => n.id === mirrorId);
    assert.strictEqual(m.content, content.content, '跟读投影必须等于源当前正文');
    assert.strictEqual(m.version, content.version, '跟读没有自己的版本：版本即源版本');
  });

  // ---------- 4：占用跨文档可见：在跟读上锁，源文档里看得见 ----------
  await test('在跟读上申请编辑：源文档房间立刻看到同一把锁（以源 id 为键）', async () => {
    alice.drain(() => true);
    bob.drain(() => true);
    await snapshot(bob, 'default');
    const pLockInDefault = bob.next((m) => m.type === 'locked' && m.nodeId === sourceId);
    // Alice 在 docB 的跟读行上点编辑
    alice.send({ type: 'lock', nodeId: mirrorId });
    const acq = await alice.next((m) => m.type === 'lock_acquired' && m.nodeId === sourceId);
    assert.strictEqual(acq.nodeId, sourceId, '锁必须解析到源 id');
    const locked = await pLockInDefault;
    assert.strictEqual(locked.user.userId, 'u-ma');

    // 快照里的锁：源文档与跟读文档都带这把锁
    const sDef = await latestSnapshot('default');
    const sB = await latestSnapshot(docBId);
    assert.ok(sDef.locks.some((l) => l.nodeId === sourceId), '源文档快照带锁');
    assert.ok(sB.locks.some((l) => l.nodeId === sourceId), '跟读宿主快照带锁');

    // 第二个人无论从源还是跟读都拿不到
    bob.send({ type: 'lock', nodeId: sourceId });
    const denied1 = await bob.next((m) => m.type === 'lock_denied' && m.nodeId === sourceId);
    assert.strictEqual(denied1.holder.userId, 'u-ma');
    bob.send({ type: 'lock', nodeId: mirrorId });
    const denied2 = await bob.next((m) => m.type === 'lock_denied' && m.nodeId === sourceId);
    assert.strictEqual(denied2.holder.userId, 'u-ma');
  });

  // ---------- 5：TTL 回收：两边占用同时消失 ----------
  await test('跟读锁 TTL 到期：源文档与跟读文档都收到 unlocked(reason=ttl)', async () => {
    serverMod.locks.locks.get(sourceId).at = Date.now() - 60_000;
    // 两个房间各放一个观察者
    const watcherDef = await connect('守源', 'u-wd');
    await snapshot(watcherDef, 'default');
    const watcherB = await connect('守跟读', 'u-wb');
    await snapshot(watcherB, docBId);
    const pDef = watcherDef.next((m) => m.type === 'unlocked' && m.nodeId === sourceId && m.reason === 'ttl');
    const pB = watcherB.next((m) => m.type === 'unlocked' && m.nodeId === sourceId && m.reason === 'ttl');
    serverMod.sweepAndBroadcast();
    const [a, b] = await Promise.all([pDef, pB]);
    assert.strictEqual(a.nodeId, sourceId);
    assert.strictEqual(b.nodeId, sourceId);
    watcherDef.close();
    watcherB.close();
  });

  // ---------- 6：一个人在源改、另一个人在跟读改 -> 同一收敛协议 ----------
  await test('源与跟读两个入口并发编辑不同位置：自动合并，所有挂载点收敛一致', async () => {
    const def = await latestSnapshot('default');
    const src = def.nodes.find((n) => n.id === sourceId);
    const v = src.version;

    // Alice 从源保存（句首）
    alice.drain(() => true); bob.drain(() => true);
    const p1 = bob.next((m) => m.type === 'content' && m.nodeId === sourceId);
    alice.send({ type: 'save', nodeId: sourceId, content: '【Alice在源】' + src.content, baseVersion: v });
    await p1;

    // Bob 从跟读保存（句尾），仍基于旧版本 v —— 必须走三方合并
    const pMerge = alice.next((m) => m.type === 'content' && m.nodeId === sourceId);
    bob.send({
      type: 'save', nodeId: sourceId, // 跟读提交的也是源 id
      content: src.content + '【Bob在跟读】',
      baseVersion: v,
    });
    const merged = await pMerge;
    assert.ok(merged.content.includes('【Alice在源】'));
    assert.ok(merged.content.includes('【Bob在跟读】'));

    const sDef = await latestSnapshot('default');
    const sB = await latestSnapshot(docBId);
    const inDef = sDef.nodes.find((n) => n.id === sourceId).content;
    const inB = sB.nodes.find((n) => n.id === mirrorId).content;
    assert.strictEqual(inDef, inB, '源与跟读必须收敛到同一份');
    assert.strictEqual(inDef, merged.content);
  });

  // ---------- 7：同一处的真重叠：跟读侧保存也被冲突拒绝，裁决后收敛 ----------
  await test('两个入口改到同一处：跟读侧保存收到 conflict，不允许两边各自成功', async () => {
    const def = await latestSnapshot('default');
    const src = def.nodes.find((n) => n.id === sourceId);
    const v = src.version;

    bob.drain(() => true); alice.drain(() => true);
    const pA = alice.next((m) => m.type === 'content' && m.nodeId === sourceId);
    bob.send({ type: 'save', nodeId: sourceId, content: src.content + 'BBB', baseVersion: v });
    await pA;

    // Alice 从跟读入口、基于旧 v 改同一处
    alice.send({ type: 'save', nodeId: sourceId, content: src.content + 'AAA', baseVersion: v });
    const conflict = await alice.next((m) => m.type === 'conflict' && m.nodeId === sourceId);
    assert.strictEqual(conflict.reason, 'overlap');
    const still = (await latestSnapshot('default')).nodes.find((n) => n.id === sourceId);
    assert.ok(still.content.includes('BBB') && !still.content.includes('AAA'), '服务器内容不被覆盖');

    // 裁决后再看两边一致
    const agreed = still.content.replace('BBB', '双方定稿');
    const pFinal = bob.next((m) => m.type === 'content' && m.nodeId === sourceId);
    alice.send({ type: 'resolve', nodeId: sourceId, content: agreed, keep: 'manual' });
    await pFinal;
    const sDef = await latestSnapshot('default');
    const sB = await latestSnapshot(docBId);
    assert.strictEqual(
      sDef.nodes.find((n) => n.id === sourceId).content,
      sB.nodes.find((n) => n.id === mirrorId).content,
    );
  });

  // ---------- 8：源段落删除：跟读变墓碑，不显示旧正文 ----------
  await test('删除源段落：跟读收到 source_deleted 并在快照中为 sourceDeleted，无正文投影', async () => {
    const watcherB = await connect('跟读旁观者', 'u-wmir');
    await snapshot(watcherB, docBId);
    const pTomb = watcherB.next((m) =>
      m.type === 'source_deleted' && m.sourceIds && m.sourceIds.includes(sourceId));
    const def = await latestSnapshot('default');
    alice.send({ type: 'delete', nodeId: sourceId, treeRev: def.treeRev });
    const tomb = await pTomb;
    assert.ok(tomb.sourceIds.includes(sourceId));

    const sB = await latestSnapshot(docBId);
    const m = sB.nodes.find((n) => n.id === mirrorId);
    assert.ok(m, '跟读行本身仍在宿主大纲里');
    assert.strictEqual(m.sourceDeleted, 1, '必须标记为源已删除');
    assert.strictEqual(m.content, undefined, '绝不能继续投影旧正文');
    watcherB.close();
  });

  // ---------- 9：源没了以后：不能再对跟读加锁/保存；锁被一并释放 ----------
  await test('源删除后在跟读上编辑被拒绝', async () => {    bob.send({ type: 'lock', nodeId: mirrorId });
    const err = await bob.next((m) => m.type === 'error');
    assert.ok(/删除/.test(err.message));
    bob.send({
      type: 'save', nodeId: mirrorId, content: 'x', baseVersion: 1,
    });
    const err2 = await bob.next((m) => m.type === 'error');
    assert.ok(err2.message);
  });

  // ---------- 10：移除跟读不影响源；presence 按文档房间隔离 ----------
  await test('移除跟读只删宿主行，源不受影响；在线名单按文档隔离', async () => {
    // 先把 docB 再清到只剩……直接删 mirror 行
    const bSnap = await latestSnapshot(docBId);
    const p = bob.next((m) => m.type === 'nodes_deleted' && m.docId === docBId);
    await snapshot(bob, docBId);
    alice.send({ type: 'delete', nodeId: mirrorId, treeRev: bSnap.treeRev });
    const deleted = await p;
    assert.ok(deleted.ids.includes(mirrorId));
    const sB = await latestSnapshot(docBId);
    assert.ok(!sB.nodes.some((n) => n.id === mirrorId));

    // presence：加入/离开文档房间时，房间内其他成员收到名单变化
    bob.drain((m) => m.type === 'presence' && m.docId === docBId);
    const stranger = await connect('路人', 'u-stranger');
    await snapshot(stranger, 'default');
    const presenceInB = bob.next((m) =>
      m.type === 'presence' && m.docId === docBId &&
      m.users.some((u) => u.userId === 'u-stranger'));
    stranger.send({ type: 'open_doc', docId: docBId });
    const got = await presenceInB;
    assert.ok(got.users.some((u) => u.userId === 'u-stranger'));
    // 离开房间同样通知
    const leaveP = bob.next((m) =>
      m.type === 'presence' && m.docId === docBId &&
      !m.users.some((u) => u.userId === 'u-stranger'));
    stranger.send({ type: 'leave_doc', docId: docBId });
    const left = await leaveP;
    assert.ok(!left.users.some((u) => u.userId === 'u-stranger'));
    stranger.close();
  });

  // ---------- 11：跟读下禁止加子级 / 挂跟读 ----------
  await test('结构约束：跟读不能做父级', async () => {
    // 新挂一个跟读用于该用例
    const def = await latestSnapshot('default');
    const anotherSource = def.nodes.find((n) => n.content.includes('关掉页面'));
    assert.ok(anotherSource);
    const bSnap = await latestSnapshot(docBId);
    alice.send({
      type: 'add_mirror', sourceId: anotherSource.id, docId: docBId,
      parentId: '', afterId: '', treeRev: bSnap.treeRev,
    });
    const added = await alice.next((m) => m.type === 'mirror_added');
    const mid2 = added.node.id;
    const bSnap2 = await latestSnapshot(docBId);

    // add 到跟读下面 -> error
    alice.send({
      type: 'add', docId: docBId, parentId: mid2, afterId: '',
      content: '不应出现', treeRev: bSnap2.treeRev,
    });
    const e1 = await alice.next((m) => m.type === 'error');
    assert.ok(/跟读/.test(e1.message));

    // move 到跟读下面 -> error
    // 先在 docB 建一个普通顶层段落
    const bSnap3 = await latestSnapshot(docBId);
    alice.send({
      type: 'add', docId: docBId, parentId: '', afterId: '',
      content: '普通段落', treeRev: bSnap3.treeRev,
    });
    const na = await alice.next((m) => m.type === 'node_added');
    const bSnap4 = await latestSnapshot(docBId);
    alice.send({
      type: 'move', nodeId: na.node.id, parentId: mid2, afterId: '',
      treeRev: bSnap4.treeRev,
    });
    const e2 = await alice.next((m) => m.type === 'error');
    assert.ok(/跟读/.test(e2.message));

    // 拿已删除的源来挂跟读 -> error
    alice.send({
      type: 'add_mirror', sourceId, docId: docBId,
      parentId: '', afterId: '', treeRev: bSnap4.treeRev,
    });
    const e3 = await alice.next((m) => m.type === 'error');
    assert.ok(/不存在|删除/.test(e3.message));
  });

  await new Promise((r) => setTimeout(r, 100));
  alice.close();
  bob.close();
  serverMod.server.close();
  console.log(`\n全部 ${passed} 个多文档/跟读用例通过 ✅`);
  process.exit(0);
}

run().catch((e) => {
  console.error('测试失败:', e);
  process.exit(1);
});
