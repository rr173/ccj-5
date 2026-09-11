'use strict';

// 端到端：公开改写提议（suggestion）
// - pending 时全员可见，但正文不变；
// - 收下后源段落与全部跟读统一到同一份 revision；
// - 并发收下由数据库事务做 CAS，只可能一版成功；
// - 撤稿不改正文，也不占用/阻塞段落编辑锁。

process.env.WS_PORT = process.env.WS_PORT || '3780';
process.env.DB_FILE = process.env.DB_FILE || './data/suggestions.db';

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
    next(filter, timeout = 3000) {
      return new Promise((resolve, reject) => {
        const hit = this.messages.find(filter);
        if (hit) return resolve(hit);
        const t = setTimeout(() => reject(new Error(`等待消息超时: ${filter.toString()}`)), timeout);
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
        resolve(client);
      });
    });
    ws.on('error', reject);
  });
}

async function snapshotFor(client, docId = 'default') {
  client.send({ type: 'open_doc', docId });
  return client.next((m) => m.type === 'snapshot' && m.docId === docId);
}

async function latestSnapshot(client, docId = 'default') {
  const c = await connect('__snap__' + Math.random().toString(36).slice(2), 'u-snap-' + Math.random().toString(36).slice(2));
  const snap = await snapshotFor(c, docId);
  c.close();
  return snap;
}

function addSuggestion(client, nodeId, content, baseVersion) {
  client.send({ type: 'suggestion_add', nodeId, content, baseVersion });
}

function run() {
  return new Promise((resolve) => serverMod.server.listen(PORT, resolve));
}

async function main() {
  await run();
  console.log('改写提议测试服务已在', PORT, '启动');

  const alice = await connect('Alice', 'u-alice');
  await alice.next((m) => m.type === 'snapshot');
  const bob = await connect('Bob', 'u-bob');
  await bob.next((m) => m.type === 'snapshot');

  await test('提出后全员（含晚加入者）可见；收下前正文仍是原版本', async () => {
    const snap = await latestSnapshot(alice);
    const node = snap.nodes.find((n) => n.id === 'n1');
    const waitAdded = bob.next((m) =>
      m.type === 'suggestion_added' && m.nodeId === 'n1' && m.suggestion.content === 'Alice 提议标题');
    addSuggestion(alice, 'n1', 'Alice 提议标题', node.version);
    const added = await waitAdded;
    assert.strictEqual(added.suggestion.baseVersion, node.version);
    assert.strictEqual(added.suggestion.authorId, 'u-alice');

    const still = await latestSnapshot(alice);
    const current = still.nodes.find((n) => n.id === 'n1');
    assert.strictEqual(current.content, node.content);
    assert.strictEqual(current.version, node.version);
    assert.ok(still.suggestions.some((s) => s.id === added.suggestion.id));
    globalThis.__s1 = added.suggestion.id;
  });

  await test('有人收下：accepted 与同一 revision 到达，源正文统一更新', async () => {
    const sid = globalThis.__s1;
    const before = await latestSnapshot(alice);
    const oldV = before.nodes.find((n) => n.id === 'n1').version;
    bob.drain((m) => m.nodeId === 'n1');
    alice.drain((m) => m.nodeId === 'n1');

    const waitAccepted = alice.next((m) => m.type === 'suggestion_accepted' && m.suggestionId === sid);
    const waitContent = bob.next((m) => m.type === 'content' && m.nodeId === 'n1');
    bob.send({ type: 'suggestion_accept', suggestionId: sid });
    const accepted = await waitAccepted;
    const content = await waitContent;
    assert.strictEqual(content.content, 'Alice 提议标题');
    assert.strictEqual(content.version, oldV + 1);
    assert.strictEqual(accepted.nodeId, 'n1');

    const [sa, sb] = await Promise.all([latestSnapshot(alice), latestSnapshot(bob)]);
    assert.strictEqual(
      sa.nodes.find((n) => n.id === 'n1').content,
      sb.nodes.find((n) => n.id === 'n1').content,
    );
    assert.ok(!sa.suggestions.some((s) => s.id === sid));
    assert.ok(!sb.suggestions.some((s) => s.id === sid));
  });

  await test('撤稿只移除公开草稿，正文不变；不占用也不影响别人的编辑锁', async () => {
    const snap = await latestSnapshot(alice);
    const node = snap.nodes.find((n) => n.id === 'n2');
    const original = node.content;

    // Bob 正在直接编辑 n2，持有现有段落锁。
    bob.send({ type: 'lock', nodeId: 'n2' });
    await alice.next((m) => m.type === 'locked' && m.nodeId === 'n2');

    const waitAdded = bob.next((m) => m.type === 'suggestion_added' && m.nodeId === 'n2');
    addSuggestion(alice, 'n2', 'Alice 对 n2 的临时改写', node.version);
    const added = await waitAdded;

    const waitWithdrawn = bob.next((m) =>
      m.type === 'suggestion_withdrawn' && m.suggestionId === added.suggestion.id);
    alice.send({ type: 'suggestion_withdraw', suggestionId: added.suggestion.id });
    await waitWithdrawn;

    const after = await latestSnapshot(alice);
    assert.strictEqual(after.nodes.find((n) => n.id === 'n2').content, original);
    assert.ok(!after.suggestions.some((s) => s.id === added.suggestion.id));

    // 锁仍在 Bob 手里：他的正常保存成功，证明提议/撤稿没有卡住占用。
    const waitContent = alice.next((m) => m.type === 'content' && m.nodeId === 'n2');
    bob.send({
      type: 'save',
      nodeId: 'n2',
      content: original + '——Bob 直接保存',
      baseVersion: node.version,
    });
    const saved = await waitContent;
    assert.strictEqual(saved.content, original + '——Bob 直接保存');
  });

  await test('几乎同时收下两版：只有一版进入正文，另一版明确 stale 且全员移除', async () => {
    const snap = await latestSnapshot(alice);
    const node = snap.nodes.find((n) => n.id === 'n3');
    const v = node.version;

    addSuggestion(alice, 'n3', 'n3 第一版改写', v);
    const p1Added = await alice.next((m) =>
      m.type === 'suggestion_added' && m.nodeId === 'n3' && m.suggestion.content === 'n3 第一版改写');
    await bob.next((m) =>
      m.type === 'suggestion_added' && m.nodeId === 'n3' && m.suggestion.content === 'n3 第一版改写');
    addSuggestion(bob, 'n3', 'n3 第二版改写', v);
    const p2Added = await bob.next((m) =>
      m.type === 'suggestion_added' && m.nodeId === 'n3' && m.suggestion.content === 'n3 第二版改写');
    await alice.next((m) =>
      m.type === 'suggestion_added' && m.nodeId === 'n3' && m.suggestion.content === 'n3 第二版改写');
    const p1 = { suggestion: p1Added.suggestion };
    const p2 = { suggestion: p2Added.suggestion };

    alice.drain((m) => m.nodeId === 'n3');
    bob.drain((m) => m.nodeId === 'n3');

    const stale = bob.next((m) => m.type === 'suggestion_stale' && m.suggestionId === p2.suggestion.id);
    const accepted = alice.next((m) =>
      m.type === 'suggestion_accepted' && m.suggestionId === p1.suggestion.id);
    const contentP = alice.next((m) => m.type === 'content' && m.nodeId === 'n3');
    alice.send({ type: 'suggestion_accept', suggestionId: p1.suggestion.id });
    bob.send({ type: 'suggestion_accept', suggestionId: p2.suggestion.id });

    const [, finalMsg] = await Promise.all([accepted, contentP, stale]);
    assert.strictEqual(finalMsg.content, 'n3 第一版改写');
    assert.strictEqual(finalMsg.version, v + 1);

    const [sa, sb] = await Promise.all([latestSnapshot(alice), latestSnapshot(bob)]);
    const na = sa.nodes.find((n) => n.id === 'n3');
    const nb = sb.nodes.find((n) => n.id === 'n3');
    assert.strictEqual(na.content, 'n3 第一版改写');
    assert.strictEqual(na.content, nb.content);
    assert.strictEqual(na.version, nb.version);
    assert.strictEqual(sa.suggestions.length + sb.suggestions.length, 0);
  });

  await test('正文直接更新后，旧改写自动失效；再收下不会覆盖新正文', async () => {
    const snap = await latestSnapshot(alice);
    const node = snap.nodes.find((n) => n.id === 'n4');
    const v = node.version;

    addSuggestion(alice, 'n4', 'Alice 旧提议', v);
    const proposal = await alice.next((m) => m.type === 'suggestion_added' && m.nodeId === 'n4');

    const waitSuperseded = alice.next((m) =>
      m.type === 'suggestions_superseded' &&
      m.suggestionIds.includes(proposal.suggestion.id));
    const waitContent = alice.next((m) => m.type === 'content' && m.nodeId === 'n4');
    bob.send({ type: 'save', nodeId: 'n4', content: 'Bob 直接改正文', baseVersion: v });
    await Promise.all([waitSuperseded, waitContent]);

    bob.drain((m) => m.nodeId === 'n4');
    alice.send({ type: 'suggestion_accept', suggestionId: proposal.suggestion.id });
    const stale = await alice.next((m) => m.type === 'suggestion_stale');
    assert.ok(stale.current.version === v + 1);

    const after = await latestSnapshot(alice);
    assert.strictEqual(after.nodes.find((n) => n.id === 'n4').content, 'Bob 直接改正文');
    assert.ok(!after.suggestions.some((s) => s.id === proposal.suggestion.id));
  });

  await test('在跟读处提出/广播，收下后源文档与跟读宿主是同一份正文', async () => {
    const hostTitle = '改写跟读宿主-' + Math.random().toString(36).slice(2, 7);
    alice.send({ type: 'create_doc', title: hostTitle });
    const created = await alice.next((m) => m.type === 'doc_created');
    const hostId = created.doc.id;
    await alice.next((m) => m.type === 'snapshot' && m.docId === hostId);
    await snapshotFor(bob, hostId);

    const sourceSnap = await latestSnapshot(alice);
    const source = sourceSnap.nodes.find((n) => n.id === 'n5');
    alice.send({
      type: 'add_mirror',
      sourceId: 'n5',
      docId: hostId,
      parentId: '',
      afterId: '',
      treeRev: 1,
    });
    const mirrorAdded = await alice.next((m) => m.type === 'mirror_added' && m.docId === hostId);
    const mirrorId = mirrorAdded.node.id;
    await bob.next((m) => m.type === 'mirror_added' && m.docId === hostId);

    const hostSnap = await snapshotFor(bob, hostId);
    const mirror = hostSnap.nodes.find((n) => n.id === mirrorId);
    assert.strictEqual(mirror.mirrorOf, 'n5');

    const proposalText = '从跟读处提出的一版改写';
    bob.send({
      type: 'suggestion_add',
      nodeId: mirrorId,
      content: proposalText,
      baseVersion: source.version,
    });
    const added = await alice.next((m) =>
      m.type === 'suggestion_added' && m.nodeId === 'n5' && m.suggestion.content === proposalText);

    alice.drain((m) => m.nodeId === 'n5');
    bob.drain((m) => m.nodeId === 'n5');
    alice.send({ type: 'suggestion_accept', suggestionId: added.suggestion.id });
    await Promise.all([
      alice.next((m) => m.type === 'content' && m.nodeId === 'n5' && m.content === proposalText),
      bob.next((m) => m.type === 'content' && m.nodeId === 'n5' && m.content === proposalText),
    ]);

    const sourceAfter = await latestSnapshot(alice, 'default');
    const hostAfter = await latestSnapshot(bob, hostId);
    assert.strictEqual(sourceAfter.nodes.find((n) => n.id === 'n5').content, proposalText);
    assert.strictEqual(hostAfter.nodes.find((n) => n.id === mirrorId).content, proposalText);
    assert.strictEqual(
      sourceAfter.nodes.find((n) => n.id === 'n5').version,
      hostAfter.nodes.find((n) => n.id === mirrorId).version,
    );
  });

  console.log(`\n改写提议测试全部通过：${passed} 项`);
  serverMod.server.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('测试失败:', err);
  process.exit(1);
});
