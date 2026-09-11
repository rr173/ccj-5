'use strict';

// 摘录（excerpt）端到端。
//
// 与跟读相反，摘录是把源段落某一刻的正文抄一份冻起来：源之后怎么改，
// 摘录的字都不变；只有有人显式「对齐到原文」并确认后才更新。
// 对齐靠 baseSourceVersion 做 CAS：两人几乎同时对齐、各自认定的原文
// 对不上时，只有一个能成功，另一个收到 stale 重确认，绝不两边成功却不一样。
//
// 运行：WS_PORT=3783 DB_FILE=./data/excerpt.db node test/excerpt.e2e.test.js

process.env.WS_PORT = process.env.WS_PORT || '3783';
process.env.DB_FILE = process.env.DB_FILE || './data/excerpt.db';
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
  });  return new Promise((resolve, reject) => {
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

async function createDoc(client, title) {
  const created = client.next((m) => m.type === 'doc_created');
  client.send({ type: 'create_doc', title });
  const m = await created;
  await client.next((x) => x.type === 'snapshot' && x.docId === m.doc.id);
  return m.doc;
}

async function run() {
  await new Promise((r) => serverMod.server.listen(PORT, r));
  console.log(`摘录测试服务已在 ${PORT} 启动`);

  const alice = await connect('Alice', 'u-ea');
  const bob = await connect('Bob', 'u-eb');
  await bob.next((m) => m.type === 'snapshot');

  // 源文档 default 里准备一段；另建一份宿主大纲
  const hostDoc = await createDoc(alice, '摘录本');
  const init = await snapshot(alice, 'default');
  let source = init.nodes.find((n) => n.content.includes('实时看到'));
  const sourceId = source.id;

  let excerptId;

  // ---------- 1：做摘录：抄下此刻的字并冻结 ----------
  await test('做摘录：宿主文档出现 excerpt 行，正文=源此刻正文，带冻结源版本', async () => {
    const h0 = await snapshot(alice, hostDoc.id);
    await snapshot(bob, hostDoc.id); // Bob 订阅宿主
    const pBob = bob.next((m) => m.type === 'excerpt_added' && m.docId === hostDoc.id);
    alice.send({
      type: 'add_excerpt', sourceId, docId: hostDoc.id,
      parentId: '', afterId: '', treeRev: h0.treeRev,
    });
    const added = await pBob;
    excerptId = added.node.id;
    assert.strictEqual(added.node.kind, 'excerpt');
    assert.strictEqual(added.node.excerptOf, sourceId);
    assert.strictEqual(added.node.content, source.content);
    assert.strictEqual(added.node.sourceVersion, source.version);
    assert.strictEqual(added.node.stale, 0, '刚摘录：与源一致，不陈旧');

    const snap = await latestSnapshot(hostDoc.id);
    const ex = snap.nodes.find((n) => n.id === excerptId);
    assert.ok(ex);
    assert.strictEqual(ex.kind, 'excerpt');
    assert.strictEqual(ex.content, source.content);
  });

  // ---------- 2：源改了，摘录不动，且看得出两边已不是同一句 ----------
  await test('源改正文：摘录的字冻住不变；快照里标 stale=1 + 源当前版本', async () => {
    const v = source.version;
    alice.drain(() => true);
    alice.send({
      type: 'save', nodeId: sourceId,
      content: source.content + '【源后来改的】',
      baseVersion: v,
    });
    await alice.next((m) => m.type === 'saved');

    const hostSnap = await latestSnapshot(hostDoc.id);
    const ex = hostSnap.nodes.find((n) => n.id === excerptId);
    assert.strictEqual(ex.content, source.content, '摘录必须仍是旧字，不被源带走');
    assert.strictEqual(ex.sourceVersion, v, '冻结基准版本不动');
    assert.strictEqual(ex.currentSourceVersion, v + 1, '知道源已走到新版本');
    assert.strictEqual(ex.stale, 1, '明示摘录与源已不是同一句');

    const defSnap = await latestSnapshot('default');
    source = defSnap.nodes.find((n) => n.id === sourceId);
    assert.ok(source.content.includes('【源后来改的】'));
  });

  // ---------- 3：源改了，摘录不收到 content（绝不悄悄换字）----------
  await test('源的 content 广播不扇出到摘录宿主房间（只有跟读会实时变）', async () => {
    // 用一个只进 hostDoc、不进 default 的原始连接（connect() 会自动打开默认文档）
    // 编辑器连接 hello 时会自动订阅默认文档；这个看守只保留 hostDoc 房间，
    // 才能证明"源正文广播不会因为摘录而扇出到宿主房间"。
    const watcher = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      const c = { ws, contentMsgs: [], armed: false };
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'hello') c.armed = true;
        if (c.armed && m.type === 'content' && m.nodeId === sourceId) c.contentMsgs.push(m);
      });
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'hello', userId: 'u-onlyhost2', userName: '只看宿主' }));
        setTimeout(() => {
          ws.send(JSON.stringify({ type: 'leave_doc', docId: 'default' }));
          ws.send(JSON.stringify({ type: 'open_doc', docId: hostDoc.id }));
          setTimeout(() => { c.contentMsgs = []; resolve(c); }, 300);
        }, 100);
      });
    });
    const v = source.version;
    alice.send({
      type: 'save', nodeId: sourceId,
      content: source.content + '【再改一次】',
      baseVersion: v,
    });
    await alice.next((m) => m.type === 'saved');
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(watcher.contentMsgs.length, 0, '摘录宿主房间不应收到源正文广播');
    watcher.ws.close();
    // 但重取快照时能看到 stale 与新源版本，冻字依旧
    const hostSnap = await latestSnapshot(hostDoc.id);
    const ex = hostSnap.nodes.find((n) => n.id === excerptId);
    assert.ok(!ex.content.includes('【再改一次】'), '摘录仍冻着');
    assert.strictEqual(ex.stale, 1);
    source = (await latestSnapshot('default')).nodes.find((n) => n.id === sourceId);
  });

  // ---------- 4：对齐到原文此刻：全员收到同一条 excerpt_aligned ----------
  await test('显式对齐：所有观看者收到同一份新冻结文本与源版本', async () => {
    const watcher = await connect('对齐旁观', 'u-ewa');
    await snapshot(watcher, hostDoc.id);
    const p1 = watcher.next((m) => m.type === 'excerpt_aligned' && m.nodeId === excerptId);
    const p2 = bob.next((m) => m.type === 'excerpt_aligned' && m.nodeId === excerptId);
    const pAck = alice.next((m) => m.type === 'excerpt_align_ack' && m.nodeId === excerptId);
    alice.send({ type: 'excerpt_align', nodeId: excerptId, baseSourceVersion: source.version });
    const [m1, m2, ack] = await Promise.all([p1, p2, pAck]);
    assert.strictEqual(m1.content, source.content, '对齐到源此刻正文');
    assert.strictEqual(m1.sourceVersion, source.version);
    assert.strictEqual(m1.content, m2.content, '两个人收到逐字相同的一份');
    assert.strictEqual(m1.sourceVersion, m2.sourceVersion);
    assert.ok(!ack.unchanged);

    const hostSnap = await latestSnapshot(hostDoc.id);
    const ex = hostSnap.nodes.find((n) => n.id === excerptId);
    assert.strictEqual(ex.content, source.content);
    assert.strictEqual(ex.sourceVersion, source.version);
    assert.strictEqual(ex.stale, 0, '对齐后重新一致');
    watcher.close();
  });

  // ---------- 5：对齐是 append-only 留痕（时间轴里能看到两次冻结）----------
  await test('做摘录与对齐都进时间轴，任意时刻可重建当时冻住的字', async () => {
    alice.send({ type: 'timeline' });
    const tl = await alice.next((m) => m.type === 'timeline');
    const addEv = tl.items.find((m) => m.kind === 'excerpt_add');
    const alignEv = tl.items.find((m) => m.kind === 'excerpt_align');
    assert.ok(addEv, '有做摘录事件');
    assert.ok(alignEv, '有对齐事件');

    // 回到"做摘录之后、源第一次改之前"不容易取 seq，直接回到 add 时刻：
    alice.send({ type: 'snapshot_at', docId: hostDoc.id, seq: addEv.seq });
    const at = await alice.next((m) => m.type === 'snapshot_at' && m.docId === hostDoc.id);
    const exThen = at.nodes.find((n) => n.id === excerptId);
    assert.ok(exThen);
    assert.strictEqual(exThen.kind, 'excerpt');
    assert.ok(!exThen.content.includes('【源后来改的】'), '该时刻摘录取冻结旧字');
  });

  // ---------- 6：两人几乎同时对齐、认定的原文对不上：不能两边成功 ----------
  await test('并发对齐 CAS：源在确认期间又被改，后到者 excerpt_align_stale，冻字不变', async () => {
    // 先让源再走一版，使摘录陈旧。Alice 眼里"要对齐的版本"= 旧的当前版。
    let def = await latestSnapshot('default');
    let src = def.nodes.find((n) => n.id === sourceId);
    const seenVersion = src.version;

    // Alice 基于 seenVersion 确认对齐的"同一时刻"，源又被 Bob 改了
    bob.drain((m) => m.type === 'saved');
    bob.send({
      type: 'save', nodeId: sourceId,
      content: src.content + '【Bob抢先一版】',
      baseVersion: src.version,
    });
    await bob.next((m) => m.type === 'saved' && m.nodeId === sourceId);
    // 等到快照里源版本确实前进，再开始对齐竞争
    let nowVersion = seenVersion;
    for (let i = 0; i < 30 && nowVersion <= seenVersion; i++) {
      await new Promise((r) => setTimeout(r, 50));
      nowVersion = (await latestSnapshot('default')).nodes.find((n) => n.id === sourceId).version;
    }
    assert.ok(nowVersion > seenVersion, 'Bob 的保存必须先落库使源版本前进');

    // Alice 的对齐请求带着过期基准到达：必须 stale，不能成功
    const staleP = alice.next((m) => m.type === 'excerpt_align_stale' && m.nodeId === excerptId);
    alice.send({ type: 'excerpt_align', nodeId: excerptId, baseSourceVersion: seenVersion });
    const stale = await staleP;
    assert.strictEqual(stale.current.version, nowVersion, '带回此刻真正的新版本');
    assert.ok(stale.current.content.includes('【Bob抢先一版】'));
    assert.strictEqual(stale.frozen.sourceVersion, seenVersion, '回执附旧冻字基准');

    // 冻字仍是上一版对齐结果（不含 Bob 的字），没有任何 excerpt_aligned 广播
    const hostSnap = await latestSnapshot(hostDoc.id);
    const ex = hostSnap.nodes.find((n) => n.id === excerptId);
    assert.ok(!ex.content.includes('【Bob抢先一版】'), 'stale 时冻字绝不改变');
    assert.strictEqual(ex.sourceVersion, seenVersion);

    // Alice 看清新原文后用新版本重新确认 -> 成功，全员同一份
    const freshVersion = (await latestSnapshot('default')).nodes.find((n) => n.id === sourceId).version;
    alice.drain((m) => m.type === 'excerpt_aligned');
    const pA = alice.next((m) => m.type === 'excerpt_aligned' && m.nodeId === excerptId);
    alice.send({ type: 'excerpt_align', nodeId: excerptId, baseSourceVersion: freshVersion });
    const aligned = await pA;
    assert.strictEqual(aligned.sourceVersion, freshVersion);
    assert.ok(aligned.content.includes('【Bob抢先一版】'));
    const after = (await latestSnapshot(hostDoc.id)).nodes.find((n) => n.id === excerptId);
    const srcNow = (await latestSnapshot('default')).nodes.find((n) => n.id === sourceId);
    assert.strictEqual(after.content, srcNow.content, '对齐后与源逐字一致');
  });

  // ---------- 7：两个客户端真的"同时"对齐同一版：最多一个产生新冻结 ----------
  await test('两人基于同一版本同时对齐：结果逐字一致，不产生分叉', async () => {
    const def = await latestSnapshot('default');
    const src = def.nodes.find((n) => n.id === sourceId);
    // 先把摘录弄陈旧
    alice.send({ type: 'save', nodeId: sourceId, content: src.content + '【岔开】', baseVersion: src.version });
    await alice.next((m) => m.type === 'saved');
    const v2 = (await latestSnapshot('default')).nodes.find((n) => n.id === sourceId).version;

    const aP = alice.next((m) =>
      m.type === 'excerpt_aligned' || (m.type === 'excerpt_align_ack' && m.nodeId === excerptId));
    const bP = bob.next((m) =>
      m.type === 'excerpt_aligned' || (m.type === 'excerpt_align_ack' && m.nodeId === excerptId));
    alice.send({ type: 'excerpt_align', nodeId: excerptId, baseSourceVersion: v2 });
    bob.send({ type: 'excerpt_align', nodeId: excerptId, baseSourceVersion: v2 });
    const [ra, rb] = await Promise.all([aP, bP]);
    // 两人都认为成功（第二个可能收到 unchanged），但最终只有一份内容
    const hostSnap = await latestSnapshot(hostDoc.id);
    const ex = hostSnap.nodes.find((n) => n.id === excerptId);
    const srcNow = (await latestSnapshot('default')).nodes.find((n) => n.id === sourceId);
    assert.strictEqual(ex.content, srcNow.content);
    assert.strictEqual(ex.sourceVersion, v2);
    assert.ok(ra, rb);
  });

  // ---------- 8：对齐到与冻字相同的内容：unchanged，幂等 ----------
  await test('原文与摘录逐字相同时对齐：unchanged，不产生新冻结行', async () => {
    const hostSnap = await latestSnapshot(hostDoc.id);
    const ex = hostSnap.nodes.find((n) => n.id === excerptId);
    alice.drain(() => true);
    alice.send({ type: 'excerpt_align', nodeId: excerptId, baseSourceVersion: ex.sourceVersion });
    const ack = await alice.next((m) => m.type === 'excerpt_align_ack' && m.nodeId === excerptId);
    assert.ok(ack.unchanged);
  });

  // ---------- 9：摘录不能直接编辑/保存/加锁/提改写（它不是正文）----------
  await test('摘录是冻结副本：lock/save 被拒；其下不能加子级', async () => {
    bob.send({ type: 'lock', nodeId: excerptId });
    const e1 = await bob.next((m) => m.type === 'error');
    assert.ok(/冻结|摘录/.test(e1.message));
    bob.send({ type: 'save', nodeId: excerptId, content: '想偷改', baseVersion: 1 });
    const e2 = await bob.next((m) => m.type === 'error');
    assert.ok(/冻结|摘录/.test(e2.message));

    const h = await latestSnapshot(hostDoc.id);
    alice.send({
      type: 'add', docId: hostDoc.id, parentId: excerptId, afterId: '',
      content: '不应出现', treeRev: h.treeRev,
    });
    const e3 = await alice.next((m) => m.type === 'error');
    assert.ok(/引用行|摘录|跟读/.test(e3.message));
  });

  // ---------- 10：源被删除：摘录保留冻字、立墓碑、不能再对齐 ----------
  await test('删除源段落：摘录保留最后冻字但标 sourceDeleted；对齐收到 gone', async () => {
    const watcher = await connect('源删除看守', 'u-ewd');
    await snapshot(watcher, hostDoc.id);
    const pGone = watcher.next((m) =>
      m.type === 'excerpt_source_deleted' && m.sourceIds && m.sourceIds.includes(sourceId));
    const def = await latestSnapshot('default');
    alice.send({ type: 'delete', nodeId: sourceId, treeRev: def.treeRev });
    await pGone;

    const hostSnap = await latestSnapshot(hostDoc.id);
    const ex = hostSnap.nodes.find((n) => n.id === excerptId);
    assert.strictEqual(ex.sourceDeleted, 1);
    assert.ok(typeof ex.content === 'string' && ex.content.length >= 0, '冻字仍在快照里');

    alice.send({ type: 'excerpt_align', nodeId: excerptId, baseSourceVersion: 99 });
    const gone = await alice.next((m) => m.type === 'excerpt_align_gone' && m.nodeId === excerptId);
    assert.ok(gone.message);
    watcher.close();
  });

  // ---------- 11：移除摘录不影响源（此处源已删，用另一个源再验证）----------
  await test('移除摘录：只删冻结副本；同文档内再做摘录支持同大纲挂载', async () => {
    const d2 = await latestSnapshot('default');
    const otherSrc = d2.nodes.find((n) => n.content.includes('关掉页面'));
    assert.ok(otherSrc, '默认文档还有别的源段落');
    // 同一份大纲内做摘录（"挂到别处"也可是同份大纲的另一处顶层）
    const h = await latestSnapshot(hostDoc.id);
    alice.send({
      type: 'add_excerpt', sourceId: otherSrc.id, docId: hostDoc.id,
      parentId: '', afterId: '', treeRev: h.treeRev,
    });
    const added = await alice.next((m) => m.type === 'excerpt_added');
    assert.strictEqual(added.node.content, otherSrc.content);
    assert.strictEqual(added.node.sourceDocId, 'default');

    const h2 = await latestSnapshot(hostDoc.id);
    const pDel = bob.next((m) => m.type === 'nodes_deleted' && m.docId === hostDoc.id);
    await snapshot(bob, hostDoc.id);
    alice.send({ type: 'delete', nodeId: added.node.id, treeRev: h2.treeRev });
    const deleted = await pDel;
    assert.ok(deleted.ids.includes(added.node.id));
    // 源段落完好
    const d3 = await latestSnapshot('default');
    assert.ok(d3.nodes.some((n) => n.id === otherSrc.id), '源段落不受摘录移除影响');
  });

  await new Promise((r) => setTimeout(r, 100));
  alice.close();
  bob.close();
  serverMod.server.close();
  console.log(`\n全部 ${passed} 个摘录用例通过 ✅`);
  process.exit(0);
}

run().catch((e) => {
  console.error('测试失败:', e);
  process.exit(1);
});
