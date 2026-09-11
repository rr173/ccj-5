'use strict';

// 讲解轮次端到端：唯一讲解者、原子交棒、取消交棒不改所指标题。
process.env.WS_PORT = process.env.WS_PORT || '3782';
process.env.DB_FILE = process.env.DB_FILE || './data/presentation.db';

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
    messages: [],
    waiters: [],
    send(obj) { ws.send(JSON.stringify(obj)); },
    next(filter, timeout = 3000) {
      return new Promise((resolve, reject) => {
        const hit = this.messages.find(filter);
        if (hit) return resolve(hit);
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
      client.next((m) => m.type === 'hello').then(() => resolve(client));
    });
    ws.on('error', reject);
  });
}

async function snapshot(client) {
  return client.next((m) => m.type === 'snapshot');
}
async function presentation(client, fn = () => true) {
  return client.next((m) => m.type === 'presentation' && fn(m));
}

async function run() {
  await new Promise((r) => serverMod.server.listen(PORT, r));
  console.log(`讲解测试服务已在 ${PORT} 启动`);

  const alice = await connect('Alice', 'u-pres-alice');
  const bob = await connect('Bob', 'u-pres-bob');
  const carol = await connect('Carol', 'u-pres-carol');
  const snap = await snapshot(alice);
  await snapshot(bob);
  await snapshot(carol);
  const first = snap.nodes[0];
  const second = snap.nodes.find((n) => n.parentId === first.id) || snap.nodes[1];

  await test('开始讲解：发起者和在场所有人都收到同一段', async () => {
    const pBob = presentation(bob, (m) => m.active && m.nodeId === first.id);
    const pCarol = presentation(carol, (m) => m.active && m.nodeId === first.id);
    alice.send({ type: 'presentation_start', docId: 'default', nodeId: first.id });
    const [m1, m2] = await Promise.all([pBob, pCarol]);
    assert.strictEqual(m1.leader.userId, 'u-pres-alice');
    assert.strictEqual(m2.leader.userId, 'u-pres-alice');
    assert.strictEqual(m1.nodeId, m2.nodeId);
  });

  await test('讲解者换段：所有观看者收到同一条新位置', async () => {
    const pBob = presentation(bob, (m) => m.active && m.nodeId === second.id);
    const pCarol = presentation(carol, (m) => m.active && m.nodeId === second.id);
    alice.send({ type: 'presentation_point', docId: 'default', nodeId: second.id });
    const [m1, m2] = await Promise.all([pBob, pCarol]);
    assert.strictEqual(m1.nodeId, second.id);
    assert.strictEqual(m2.nodeId, second.id);
  });

  await test('并发抢轮：只有一个讲解者，输的一方收到 denied 并被纠正', async () => {
    const x = await connect('X', 'u-pres-x');
    const y = await connect('Y', 'u-pres-y');
    await snapshot(x);
    await snapshot(y);
    for (const c of [alice, bob, carol, x, y]) {
      c.drain((m) => m.type === 'presentation' || m.type === 'presence');
    }
    alice.send({ type: 'presentation_stop', docId: 'default' });
    await Promise.all([
      presentation(bob, (m) => m.active === false),
      presentation(x, (m) => m.active === false),
      presentation(y, (m) => m.active === false),
    ]);
    x.send({ type: 'presentation_start', docId: 'default', nodeId: first.id });
    y.send({ type: 'presentation_start', docId: 'default', nodeId: first.id });
    const denied = await y.next((m) => m.type === 'presentation_denied' || (
      m.type === 'presentation' && m.leader?.userId === 'u-pres-y'
    ));
    assert.strictEqual(denied.type, 'presentation_denied');
    assert.strictEqual(denied.leader.userId, 'u-pres-x');
    const winner = await x.next((m) => m.type === 'presentation' && m.leader?.userId === 'u-pres-x');
    assert.strictEqual(winner.nodeId, first.id);
    const pCloseAlice = alice.next((m) => m.type === 'presentation' && m.active === false);
    const pCloseBob = bob.next((m) => m.type === 'presentation' && m.active === false);
    const pCloseCarol = carol.next((m) => m.type === 'presentation' && m.active === false);
    x.close();
    y.close();
    await Promise.all([pCloseAlice, pCloseBob, pCloseCarol]);
    alice.send({ type: 'presentation_start', docId: 'default', nodeId: second.id });
    await Promise.all([
      presentation(bob, (m) => m.leader?.userId === 'u-pres-alice' && m.nodeId === second.id),
      presentation(carol, (m) => m.leader?.userId === 'u-pres-alice' && m.nodeId === second.id),
    ]);
  });

  await test('交棒是两阶段：offer 未接受前 leader 和位置都不变', async () => {
    alice.send({ type: 'presentation_start', docId: 'default', nodeId: second.id });
    await Promise.all([
      presentation(bob, (m) => m.leader?.userId === 'u-pres-alice' && m.nodeId === second.id),
      presentation(carol, (m) => m.leader?.userId === 'u-pres-alice' && m.nodeId === second.id),
    ]);
    const offerBob = presentation(bob, (m) => m.offer?.userId === 'u-pres-bob');
    const offerCarol = presentation(carol, (m) => m.offer?.userId === 'u-pres-bob');
    alice.send({ type: 'presentation_handoff', docId: 'default', targetUserId: 'u-pres-bob' });
    const [m1, m2] = await Promise.all([offerBob, offerCarol]);
    assert.strictEqual(m1.leader.userId, 'u-pres-alice');
    assert.strictEqual(m2.leader.userId, 'u-pres-alice');
    assert.strictEqual(m1.nodeId, second.id);
    assert.strictEqual(m2.nodeId, second.id);
  });

  await test('交出去之前反悔：offer 清掉，大家仍停在上一轮的同一段', async () => {
    for (const c of [alice, bob, carol]) c.drain((m) => m.type === 'presentation');
    const pBob = presentation(bob, (m) => m.active && !m.offer);
    const pCarol = presentation(carol, (m) => m.active && !m.offer);
    alice.send({ type: 'presentation_cancel_handoff', docId: 'default' });
    const [m1, m2] = await Promise.all([pBob, pCarol]);
    assert.strictEqual(m1.leader.userId, 'u-pres-alice');
    assert.strictEqual(m2.leader.userId, 'u-pres-alice');
    assert.strictEqual(m1.nodeId, second.id);
    assert.strictEqual(m2.nodeId, second.id);
  });

  await test('接受交棒：leader 原子切换到下一人，所有人跟随新人的轮次和当前段', async () => {
    for (const c of [alice, bob, carol]) c.drain((m) => m.type === 'presentation');
    alice.send({ type: 'presentation_handoff', docId: 'default', targetUserId: 'u-pres-bob' });
    await Promise.all([
      presentation(alice, (m) => m.offer?.userId === 'u-pres-bob'),
      presentation(bob, (m) => m.offer?.userId === 'u-pres-bob'),
    ]);
    const pAlice = presentation(alice, (m) => m.leader?.userId === 'u-pres-bob' && !m.offer);
    const pCarol = presentation(carol, (m) => m.leader?.userId === 'u-pres-bob' && !m.offer);
    bob.send({ type: 'presentation_accept', docId: 'default' });
    const [m1, m2] = await Promise.all([pAlice, pCarol]);
    assert.strictEqual(m1.nodeId, second.id);
    assert.strictEqual(m2.nodeId, second.id);
    assert.strictEqual(m1.leader.userName, 'Bob');
  });

  await test('旧讲解者不能再移动位置，新讲解者换段后全员一起走', async () => {
    alice.send({ type: 'presentation_point', docId: 'default', nodeId: first.id });
    const denied = await alice.next((m) => m.type === 'presentation_denied');
    assert.strictEqual(denied.leader.userId, 'u-pres-bob');
    const pAlice = presentation(alice, (m) => m.nodeId === first.id && m.leader?.userId === 'u-pres-bob');
    bob.send({ type: 'presentation_point', docId: 'default', nodeId: first.id });
    const msg = await pAlice;
    assert.strictEqual(msg.nodeId, first.id);
  });

  await test('跟读者不能改正文：服务器拒绝并再次下发当前讲解轮次', async () => {
    const node = (await snapshot(alice)).nodes.find((n) => n.id === first.id);
    alice.send({
      type: 'save',
      nodeId: first.id,
      content: '跟读者试图偷改',
      baseVersion: node.version,
    });
    const denied = await alice.next((m) =>
      m.type === 'presentation_denied' && m.write === true
    );
    assert.strictEqual(denied.leader.userId, 'u-pres-bob');
    assert.strictEqual(denied.nodeId, first.id);
  });

  await test('晚加入者从快照直接拿到当前讲解者和所指标题', async () => {
    const dave = await connect('Dave', 'u-pres-dave');
    const s = await dave.next((m) => m.type === 'snapshot');
    assert.ok(s.presentation);
    assert.strictEqual(s.presentation.leader.userId, 'u-pres-bob');
    assert.strictEqual(s.presentation.nodeId, first.id);
    dave.close();
  });

  await test('讲解者最后一个连接断开：本轮结束，其余人收到 active=false', async () => {
    const waitAlice = alice.next((m) => m.type === 'presentation' && m.active === false);
    const waitCarol = carol.next((m) => m.type === 'presentation' && m.active === false);
    bob.close();
    const [m1, m2] = await Promise.all([waitAlice, waitCarol]);
    assert.strictEqual(m1.docId, 'default');
    assert.strictEqual(m2.docId, 'default');
  });

  console.log(`\n讲解轮次 ${passed} 个场景全部通过`);
  alice.close();
  bob.close();
  carol.close();
  setTimeout(() => {
    serverMod.server.close(() => process.exit(0));
  }, 100);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
