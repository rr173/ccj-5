'use strict';

// 整份时间轴端到端：
//   1) 结构+内容共用全局时刻 seq，事件齐全单调；
//   2) snapshot_at 把整棵树（层级+正文）重建到指定时刻；
//   3) 源文档与跟读宿主文档用同一 seq 对照，两个客户端看到逐字节一致；
//   4) 从旧时刻接着改 = 另开一条线（restore_save 三方合并），别人后来
//      不冲突的改动保留；两人从同一时刻接着改最终收敛，重叠走冲突裁决；
//   5) 当前已删的段落：回看可见但接着改被拒绝；
//   6) 旧库（无 timeline）升级自动回填。
// 运行：WS_PORT=3779 WS_PING_MS=300 DB_FILE=./data/timetravel.db node test/timetravel.e2e.test.js

process.env.WS_PORT = process.env.WS_PORT || '3779';
process.env.DB_FILE = process.env.DB_FILE || './data/timetravel.db';
process.env.WS_PING_MS = process.env.WS_PING_MS || '300';

const fs = require('fs');
for (const f of [process.env.DB_FILE, process.env.DB_FILE + '-wal', process.env.DB_FILE + '-shm']) {
  try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
}

const assert = require('assert');
const WebSocket = require('ws');
const serverMod = require('../server/index');
const store = require('../server/db');

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
    next(filter = () => true, timeout = 4000) {
      return new Promise((resolve, reject) => {
        const hit = this.messages.find(filter);
        if (hit) return resolve(hit);
        const t = setTimeout(() => reject(new Error('等待消息超时: ' + String(filter).slice(0, 90))), timeout);
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
  const tmp = await connect('__snap__' + Math.random().toString(36).slice(2, 7),
    'u-snap-' + Math.random().toString(36).slice(2));
  const snap = await snapshot(tmp, docId);
  tmp.close();
  return snap;
}

async function timeline(client) {
  client.send({ type: 'timeline' });
  return client.next((m) => m.type === 'timeline');
}

async function snapshotAt(client, docId, seq) {
  client.send({ type: 'snapshot_at', docId, seq });
  return client.next((m) => m.type === 'snapshot_at' && m.docId === docId);
}

async function saveAndWait(client, nodeId, content, baseVersion) {
  const p = client.next((m) =>
    (m.type === 'saved' || m.type === 'merge_notice' || m.type === 'conflict') &&
    (m.nodeId === nodeId || (m.revision && m.revision.node_id === nodeId)));
  client.send({ type: 'save', nodeId, content, baseVersion });
  return p;
}

async function restoreAndWait(client, nodeId, content, restoreVersion) {
  const p = client.next((m) =>
    (m.type === 'saved' || m.type === 'merge_notice' || m.type === 'conflict') &&
    (m.nodeId === nodeId || (m.revision && m.revision.node_id === nodeId)));
  client.send({ type: 'restore_save', nodeId, content, restoreVersion });
  return p;
}

function nodeContent(snap, nodeId) {
  const n = snap.nodes.find((x) => x.id === nodeId);
  return n ? n.content : undefined;
}

async function run() {
  await new Promise((r) => serverMod.server.listen(PORT, r));
  console.log(`整份时间轴测试服务已在 ${PORT} 启动`);

  const alice = await connect('Alice', 'u-ta');
  const bob = await connect('Bob', 'u-tb');
  await bob.next((m) => m.type === 'snapshot');

  // ---------- 构造一条跨结构+内容的时间线 ----------
  // 初始：种子 n1..n5（5 个 add 事件）
  const def0 = await latestSnapshot('default');
  const n5 = def0.nodes.find((n) => n.content.includes('Ctrl+Enter'));
  const n2 = def0.nodes.find((n) => n.content.includes('实时看到'));

  // S1: alice 把 n5 改成 v2「时刻锚点 共同 基础」
  let r = await saveAndWait(alice, n5.id, '时刻锚点 共同 基础', n5.version);
  assert.strictEqual(r.type, 'saved');

  // S2: alice 加顶层段落 X「新段落甲」
  let treeRev = (await latestSnapshot('default')).treeRev;
  let p = alice.next((m) => m.type === 'node_added');
  alice.send({ type: 'add', docId: 'default', parentId: '', afterId: '', content: '新段落甲', treeRev });
  const nodeX = (await p).node.id;

  // S3: alice 把 X 移到 n4 下面
  const n4 = def0.nodes.find((n) => n.content.includes('本周计划'));
  treeRev = (await latestSnapshot('default')).treeRev;
  p = alice.next((m) => m.type === 'node_moved' && m.nodeId === nodeX);
  alice.send({ type: 'move', nodeId: nodeX, parentId: n4.id, afterId: '', treeRev });
  await p;

  // S4: alice 加段落 Y「将被删除的段落」；S5: 随即删掉
  treeRev = (await latestSnapshot('default')).treeRev;
  p = alice.next((m) => m.type === 'node_added');
  alice.send({ type: 'add', docId: 'default', parentId: '', afterId: '', content: '将被删除的段落', treeRev });
  const nodeY = (await p).node.id;
  treeRev = (await latestSnapshot('default')).treeRev;
  p = alice.next((m) => m.type === 'nodes_deleted' && m.ids.includes(nodeY));
  alice.send({ type: 'delete', nodeId: nodeY, treeRev });
  await p;

  // S6: bob 建 docB；alice 把 n2 挂跟读进去
  const createdP = bob.next((m) => m.type === 'doc_created');
  bob.send({ type: 'create_doc', title: '跟读宿主大纲' });
  const docB = (await createdP).doc;
  await snapshot(alice, docB.id); // alice 订阅宿主文档，方便收 mirror_added
  treeRev = (await latestSnapshot(docB.id)).treeRev;
  p = alice.next((m) => m.type === 'mirror_added' && m.docId === docB.id);
  alice.send({ type: 'add_mirror', sourceId: n2.id, docId: docB.id, parentId: '', afterId: '', treeRev });
  const mirrorId = (await p).node.id;

  // S7: alice 把源段落 n2 改成 v2
  const n2cur = (await latestSnapshot('default')).nodes.find((n) => n.id === n2.id);
  r = await saveAndWait(alice, n2.id, '源段落的新正文', n2cur.version);
  assert.strictEqual(r.type, 'saved');

  // S8: bob 把 n5 改成 v3（句尾追加）——"现在这条线上别人后来写下的改动"
  const n5cur = (await latestSnapshot('default')).nodes.find((n) => n.id === n5.id);
  r = await saveAndWait(bob, n5.id, '时刻锚点 共同 基础，bob 后来补的句尾', n5cur.version);
  assert.strictEqual(r.type, 'saved');

  // ---------- 1：时间轴事件齐全、seq 单调、带作者与摘要 ----------
  const S = {};
  await test('时间轴：结构（增/移/删/挂跟读）与内容（保存）共用全局单调时刻', async () => {
    const tl = await timeline(alice);
    assert.ok(tl.latestSeq >= 13, `至少 13 个事件（5 种子 + 8 操作），实际 ${tl.latestSeq}`);
    const items = tl.items;
    for (let i = 1; i < items.length; i++) {
      assert.ok(items[i - 1].seq > items[i].seq, '列表按时刻倒序且严格单调');
    }
    for (const it of items) {
      assert.ok(it.author, '每条事件有作者');
      assert.ok(it.createdAt > 0, '每条事件有时间戳');
      assert.ok(it.summary, '每条事件有摘要');
      assert.ok(it.docTitle, '每条事件有所属大纲标题');
    }
    const find = (kind, kw) => items.find((i) => i.kind === kind && i.summary.includes(kw));
    // v2 与 v3 的摘要都含「时刻锚点」（v3 在其基础上追加），取 seq 最小的那条才是 v2
    S.v2 = Math.min(...items.filter((i) => i.kind === 'content' && i.summary.includes('时刻锚点')).map((i) => i.seq));
    S.addX = find('add', '新段落甲').seq;
    S.moveX = items.find((i) => i.kind === 'move').seq;
    S.addY = find('add', '将被删除').seq;
    S.delY = items.find((i) => i.kind === 'delete').seq;
    S.mirror = items.find((i) => i.kind === 'mirror_add').seq;
    S.n2v2 = find('content', '源段落的新正文').seq;
    S.n5v3 = find('content', 'bob 后来补的句尾').seq;
    const order = [S.v2, S.addX, S.moveX, S.addY, S.delY, S.mirror, S.n2v2, S.n5v3];
    for (let i = 1; i < order.length; i++) {
      assert.ok(order[i] > order[i - 1], `事件发生顺序与操作顺序一致: ${order}`);
    }
    assert.strictEqual(tl.latestSeq, S.n5v3, '最后一个事件就是最新时刻');
  });

  // ---------- 2：整树回到旧时刻：层级与正文都对 ----------
  await test('整份回看：旧时刻的层级与正文整体还原（后加的没出现、后删的还在、移动前的位置）', async () => {
    // S.v2 时刻：只有种子结构，n5 是当时正文
    let at = await snapshotAt(alice, 'default', S.v2);
    assert.strictEqual(at.asOf.seq, S.v2);
    assert.strictEqual(nodeContent(at, n5.id), '时刻锚点 共同 基础');
    assert.ok(!at.nodes.some((n) => n.id === nodeX), '后加的 X 当时不存在');
    assert.ok(!at.nodes.some((n) => n.id === nodeY), '后加的 Y 当时不存在');
    assert.ok(nodeContent(at, n2.id).includes('实时看到'), 'n2 还是种子正文');

    // X 刚加：在顶层；移动后：在 n4 下
    at = await snapshotAt(alice, 'default', S.addX);
    assert.strictEqual(at.nodes.find((n) => n.id === nodeX).parentId, null);
    at = await snapshotAt(alice, 'default', S.moveX);
    assert.strictEqual(at.nodes.find((n) => n.id === nodeX).parentId, n4.id);

    // Y 删除前可见（且标记当前已删），删除后消失
    at = await snapshotAt(alice, 'default', S.addY);
    const y = at.nodes.find((n) => n.id === nodeY);
    assert.ok(y, '删除前 Y 在当时的树里');
    assert.strictEqual(y.aliveNow, 0, 'Y 在当前已被删除，前端要把「接着改」置灰');
    at = await snapshotAt(alice, 'default', S.delY);
    assert.ok(!at.nodes.some((n) => n.id === nodeY), '删除后 Y 不在当时的树里');
  });

  // ---------- 3：源与跟读用同一时刻对照；所有人看到的一致 ----------
  await test('同一时刻：源大纲与跟读大纲各自重建，投影一致；两个客户端拿到逐字节相同的结果', async () => {
    // 挂跟读那一刻：跟读行投影的是源当时的正文（v1 种子）
    const atB6 = await snapshotAt(alice, docB.id, S.mirror);
    const m6 = atB6.nodes.find((n) => n.id === mirrorId);
    assert.ok(m6 && m6.kind === 'mirror');
    assert.ok(m6.content.includes('实时看到'), '跟读投影源在同一时刻的内容');
    assert.strictEqual(m6.sourceDocId, 'default');

    // 源改动之后：跟读投影跟着到同时刻的新正文
    const atB7 = await snapshotAt(alice, docB.id, S.n2v2);
    assert.strictEqual(atB7.nodes.find((n) => n.id === mirrorId).content, '源段落的新正文');
    const atD7 = await snapshotAt(alice, 'default', S.n2v2);
    assert.strictEqual(nodeContent(atD7, n2.id), '源段落的新正文', '源大纲同一时刻同一正文');

    // 两个客户端各自请求同一时刻：结果必须逐字节一致
    const [sa, sb] = await Promise.all([
      snapshotAt(alice, 'default', S.mirror),
      snapshotAt(bob, 'default', S.mirror),
    ]);
    assert.deepStrictEqual(sa.nodes, sb.nodes, '任何人看同一时刻都是同一份');
    assert.strictEqual(sa.asOf.seq, sb.asOf.seq);
  });

  // ---------- 4：从旧时刻接着改 = 另开一条线，别人后来的改动保留 ----------
  await test('从旧时刻接着改：与当前线三方合并，别人后来不冲突的改动自动保留', async () => {
    // 当前 n5 = v3「时刻锚点 共同 基础，bob 后来补的句尾」；
    // alice 从 v2 时刻接着改句首
    const notice = await restoreAndWait(alice, n5.id, 'alice 改句首 共同 基础', 2);
    assert.strictEqual(notice.type, 'merge_notice', '与当前线自动合并');
    const cur = nodeContent(await latestSnapshot('default'), n5.id);
    assert.ok(cur.includes('alice 改句首'), '新线上的改动在');
    assert.ok(cur.includes('bob 后来补的句尾'), '当前线上 bob 后来的改动也在');

    // 历史留痕：新版本注明从 v2 另开的线
    alice.send({ type: 'history', nodeId: n5.id });
    const hist = await alice.next((m) => m.type === 'history' && m.nodeId === n5.id);
    assert.ok(hist.items[0].note.includes('回退到 v2'), 'note 记录另开一条线的来源');
  });

  // ---------- 5：两人同时从同一旧时刻接着改：收敛；重叠走裁决 ----------
  await test('两人从同一旧时刻接着改：不重叠收敛成同一份；重叠时后到者收到冲突，裁决后收敛', async () => {
    // 新段落 Z，v1 =「起点 共同 终点」就是两人共同的旧时刻
    const treeRevNow = (await latestSnapshot('default')).treeRev;
    const addP = alice.next((m) => m.type === 'node_added');
    alice.send({ type: 'add', docId: 'default', parentId: '', afterId: '', content: '起点 共同 终点', treeRev: treeRevNow });
    const z = (await addP).node.id;

    // 不重叠：alice 句尾、bob 句首，都基于 v1
    // （restore_save 成功一律回 merge_notice：直接落库与三方合并只是文案不同）
    let ra = await restoreAndWait(alice, z, '起点 共同 终点【A尾】', 1);
    assert.strictEqual(ra.type, 'merge_notice');
    assert.strictEqual(ra.revision.content, '起点 共同 终点【A尾】');
    let rb = await restoreAndWait(bob, z, '【B首】起点 共同 终点', 1);
    assert.strictEqual(rb.type, 'merge_notice', 'bob 基于同一旧时刻，与 alice 的线自动合并');
    let cur = nodeContent(await latestSnapshot('default'), z);
    assert.ok(cur.includes('【A尾】') && cur.includes('【B首】'), '两条线的改动都在');

    // 重叠：两人都基于 v1 改「共同」这个词
    ra = await restoreAndWait(alice, z, '起点 甲 终点', 1);
    assert.strictEqual(ra.type, 'merge_notice');
    const beforeConflict = nodeContent(await latestSnapshot('default'), z);
    assert.ok(beforeConflict.includes('甲'));

    rb = await restoreAndWait(bob, z, '起点 乙 终点', 1);
    assert.strictEqual(rb.type, 'conflict', '真重叠必须拒绝，不允许两边各自成功');
    assert.strictEqual(rb.reason, 'overlap');
    assert.strictEqual(
      nodeContent(await latestSnapshot('default'), z),
      beforeConflict,
      '冲突期间服务器内容不被覆盖',
    );

    // bob 裁决后：所有人收敛到同一份
    const final = '【B首】起点 乙 终点【A尾】（裁决定稿）';
    const savedP = bob.next((m) => m.type === 'saved' && m.nodeId === z);
    bob.send({ type: 'resolve', nodeId: z, content: final, keep: 'manual' });
    await savedP;
    const [sa, sb] = await Promise.all([latestSnapshot('default'), latestSnapshot('default')]);
    assert.strictEqual(nodeContent(sa, z), final);
    assert.strictEqual(nodeContent(sb, z), final, '裁决后所有人看到同一份');
  });

  // ---------- 6：当前已删的段落：回看可见，接着改被拒绝 ----------
  await test('当前已删的段落：不能从旧时刻接着改（服务器明确拒绝）', async () => {
    const errP = alice.next((m) => m.type === 'error');
    alice.send({ type: 'restore_save', nodeId: nodeY, content: '想复活', restoreVersion: 1 });
    const err = await errP;
    assert.ok(/删除/.test(err.message), '已删段落接着改必须被拒绝');

    // 非法时刻序号同样被拒绝
    const err2P = alice.next((m) => m.type === 'error');
    alice.send({ type: 'snapshot_at', docId: 'default', seq: 0 });
    const err2 = await err2P;
    assert.ok(err2.message);
  });

  // ---------- 7：旧库迁移：没有 timeline 的库升级后自动回填，可回看 ----------
  await test('旧库升级：按 created_at 回填时间轴，升级前的内容历史也能回看', async () => {
    const Database = require('better-sqlite3');
    const oldFile = './data/timetravel-old.db';
    for (const f of [oldFile, oldFile + '-wal', oldFile + '-shm']) {
      try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
    }
    // 造一个"旧时代"的库：没有 timeline 表，nodes 也没有 mirror_of
    const old = new Database(oldFile);
    old.exec(`
      CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT NOT NULL, tree_rev INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE nodes (id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, parent_id TEXT, pos TEXT NOT NULL DEFAULT '', deleted INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE revisions (id INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT NOT NULL, doc_id TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL, author_id TEXT NOT NULL, author TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
    `);
    old.prepare('INSERT INTO documents VALUES (?, ?, 1, ?, ?)').run('d1', '旧大纲', 1000, 1000);
    const insNode = old.prepare('INSERT INTO nodes (id, doc_id, parent_id, pos, deleted, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    insNode.run('a1', 'd1', null, '1', 0, 1000);
    insNode.run('a2', 'd1', null, '2', 1, 2000); // 已软删
    const insRev = old.prepare('INSERT INTO revisions (node_id, doc_id, version, content, author_id, author, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    insRev.run('a1', 'd1', 1, '旧版正文', 'u-old', '旧人', '初始', 1000);
    insRev.run('a2', 'd1', 1, '被删段落', 'u-old', '旧人', '初始', 2000);
    insRev.run('a1', 'd1', 2, '新版正文', 'u-old', '旧人', '修改', 3000);
    old.close();

    const mdb = store.init(oldFile);
    const items = store.getTimeline(mdb);
    const kinds = items.map((i) => i.kind).sort();
    assert.deepStrictEqual(kinds, ['add', 'add', 'content', 'delete'], '回填出创建/内容/删除事件');

    const atV1 = store.getSnapshotAt(mdb, 'd1', items.find((i) => i.kind === 'add' && i.summary.includes('旧版正文')).seq);
    assert.strictEqual(atV1.nodes.find((n) => n.id === 'a1').content, '旧版正文', '回看升级前的 v1');
    const atV2 = store.getSnapshotAt(mdb, 'd1', items.find((i) => i.kind === 'content').seq);
    assert.strictEqual(atV2.nodes.find((n) => n.id === 'a1').content, '新版正文');
    assert.ok(atV2.nodes.some((n) => n.id === 'a2'), '删除前的时刻里 a2 还在');
    const atNow = store.getSnapshotAt(mdb, 'd1', store.latestSeq(mdb));
    assert.ok(!atNow.nodes.some((n) => n.id === 'a2'), '最新时刻里 a2 已删');
    mdb.close();
  });

  await new Promise((r) => setTimeout(r, 100));
  alice.close();
  bob.close();
  serverMod.server.close();
  console.log(`\n全部 ${passed} 个整份时间轴用例通过 ✅`);
  process.exit(0);
}

run().catch((e) => {
  console.error('测试失败:', e);
  process.exit(1);
});
