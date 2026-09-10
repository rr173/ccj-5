'use strict';

// 端到端：启动真实 HTTP+WS 服务，用多个 ws 客户端模拟协同场景。
// 运行：WS_PORT=3777 DB_FILE=./data/test.db node test/e2e.test.js

process.env.WS_PORT = process.env.WS_PORT || '3777';
process.env.DB_FILE = process.env.DB_FILE || './data/test.db';

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

function waitFor(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
        const t = setTimeout(() => reject(new Error('等待消息超时')), timeout);
        this.waiters.push({ filter, resolve, reject: (e) => { clearTimeout(t); reject(e); } });
      });
    },
    drain(filter) {
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

async function snapshotOf(client) {
  const m = await client.next((x) => x.type === 'snapshot');
  return m;
}

async function run() {
  await new Promise((r) => serverMod.server.listen(PORT, r));
  console.log(`测试服务已在 ${PORT} 启动`);

  // ---------- 场景 1：连接、初始快照、presence ----------
  await test('连接后收到快照（含初始段落、锁、在线用户）', async () => {
    const a = await connect('阿May');
    const snap = await snapshotOf(a);
    assert.ok(snap.nodes.length >= 5, '初始应有种子段落');
    assert.ok(snap.nodes.every((n) => typeof n.version === 'number'));
    assert.ok(snap.users.some((u) => u.userName === '阿May'));
    a.close();
  });

  const alice = await connect('Alice', 'u-alice');
  await snapshotOf(alice);
  const bob = await connect('Bob', 'u-bob');
  await snapshotOf(bob);

  // ---------- 场景 2：软锁：第二个人拿不到，广播可见 ----------
  await test('一人编辑时其他人看到占用；同一人重入允许', async () => {
    const target = (await latestSnapshot(alice)).nodes[0];
    alice.send({ type: 'lock', nodeId: target.id });
    const locked = await bob.next((m) => m.type === 'locked' && m.nodeId === target.id);
    assert.strictEqual(locked.user.userId, 'u-alice');

    bob.send({ type: 'lock', nodeId: target.id });
    const denied = await bob.next((m) => m.type === 'lock_denied');
    assert.strictEqual(denied.holder.userName, 'Alice');

    // 快照里也要带锁（给晚加入的人）
    const carol = await connect('Carol', 'u-carol');
    const snap = await snapshotOf(carol);
    assert.ok(snap.locks.some((l) => l.nodeId === target.id), '新加入者应看到现存锁');
    carol.close();
    globalThis.__targetId = target.id;
  });

  // ---------- 场景 3：关闭页面立即释放锁 ----------
  await test('关闭页面 -> 锁立即广播释放', async () => {
    const target = globalThis.__targetId;
    const waitUnlock = bob.next((m) => m.type === 'unlocked' && m.nodeId === target);
    alice.close();
    const msg = await waitUnlock;
    assert.strictEqual(msg.nodeId, target);
  });

  // 重新拉两个干净的客户端
  const a2 = await connect('Alice2', 'u-alice2');
  await snapshotOf(a2);
  const b2 = await connect('Bob2', 'u-bob2');
  await snapshotOf(b2);

  // ---------- 场景 4：版本保存与版本号乐观锁 ----------
  let target2;
  await test('基于最新版本保存成功，版本号 +1 并广播', async () => {
    target2 = (await latestSnapshot(a2)).nodes[0];
    const v = target2.version;
    const waitContent = b2.next((m) => m.type === 'content' && m.nodeId === target2.id);
    a2.send({ type: 'save', nodeId: target2.id, content: 'Alice 修改后的标题内容XYZ', baseVersion: v });
    const msg = await waitContent;
    assert.strictEqual(msg.content, 'Alice 修改后的标题内容XYZ');
    assert.strictEqual(msg.version, v + 1);
    assert.strictEqual(msg.author, 'Alice2');
  });

  // ---------- 场景 5：过期提交 + 不冲突改动 -> 自动合并，双方收敛 ----------
  await test('两人改同一段不同位置：过期提交被三方自动合并，所有人收敛到同一文本', async () => {
    // 选一个没被场景 4 改过的种子段落，版本仍是 v1
    const snap0 = await latestSnapshot(a2);
    target2 = snap0.nodes.find((n) => n.content.includes('实时看到'));
    assert.ok(target2, '种子里应包含该段落');
    const v1 = target2.version;

    // Alice 只在句首插入，保留其余原文
    const aliceText = '【Alice】' + target2.content;
    const pAlice = b2.next((m) => m.type === 'content' && m.nodeId === target2.id);
    a2.send({ type: 'save', nodeId: target2.id, content: aliceText, baseVersion: v1 });
    await pAlice;

    // Bob 基于 v1 只在句尾追加
    const bobText = target2.content + '——Bob补充';
    const pMerge = a2.next((m) => m.type === 'content' && m.nodeId === target2.id);
    b2.send({ type: 'save', nodeId: target2.id, content: bobText, baseVersion: v1 });
    const msg = await pMerge;
    assert.ok(msg.version >= v1 + 2, '合并应在两人各一版之后产生新版本');
    const snapA = (await latestSnapshot(a2)).nodes.find((n) => n.id === target2.id);
    const snapB = (await latestSnapshot(b2)).nodes.find((n) => n.id === target2.id);
    assert.strictEqual(snapA.content, snapB.content, '两人最终看到的内容必须一致');
    assert.ok(snapA.content.includes('【Alice】'), 'Alice 的改动必须保留');
    assert.ok(snapA.content.includes('Bob补充'), 'Bob 的改动必须保留');
    assert.strictEqual(snapA.version, snapB.version, '版本号必须一致');
    globalThis.__mergedText = snapA.content;
    globalThis.__target2 = target2.id;
  });

  // ---------- 场景 6：真冲突 -> 拒绝，不静默覆盖，用户裁决后收敛 ----------
  await test('改到同一处：服务器拒绝并返回冲突，任何一方都不会误以为成功', async () => {
    const targetId = globalThis.__target2;
    // 让两人基于同一版本
    const snap = await latestSnapshot(a2);
    const node = snap.nodes.find((n) => n.id === targetId);
    const v = node.version;
    // b2 先存一版
    b2.send({ type: 'save', nodeId: targetId, content: node.content + 'BBB冲突词', baseVersion: v });
    await a2.next((m) => m.type === 'content' && m.nodeId === targetId);
    // a2 基于旧 v 改同一处（同一插入点，不同内容）
    a2.send({ type: 'save', nodeId: targetId, content: node.content + 'AAA冲突词', baseVersion: v });
    const conflict = await a2.next((m) => m.type === 'conflict');
    assert.strictEqual(conflict.reason, 'overlap');
    assert.ok(conflict.local.includes('AAA冲突词'));
    assert.ok(conflict.remote.includes('BBB冲突词'));
    // 此时服务器内容仍是 BBB，没有被 Alice 的提交覆盖
    const still = (await latestSnapshot(b2)).nodes.find((n) => n.id === targetId);
    assert.ok(still.content.includes('BBB冲突词') && !still.content.includes('AAA冲突词'));

    // Alice 在冲突窗里裁决：提交手动最终版本
    const finalText = still.content.replace('BBB冲突词', '双方同意的最终词');
    const finalV = still.version;
    b2.drain((m) => m.type === 'content' && m.nodeId === targetId);
    const pB = b2.next((m) => m.type === 'content' && m.nodeId === targetId);
    a2.send({ type: 'resolve', nodeId: targetId, content: finalText, keep: 'manual' });
    const settled = await pB;
    assert.strictEqual(settled.content, finalText);
    const both = await Promise.all([latestSnapshot(a2), latestSnapshot(b2)]);
    assert.strictEqual(
      both[0].nodes.find((n) => n.id === targetId).content,
      both[1].nodes.find((n) => n.id === targetId).content,
    );
  });

  // ---------- 场景 7：历史可查 ----------
  await test('每段保存都产生可按时间回看的 revision', async () => {
    const targetId = globalThis.__target2;
    a2.send({ type: 'history', nodeId: targetId });
    const h = await a2.next((m) => m.type === 'history' && m.nodeId === targetId);
    assert.ok(h.items.length >= 3, '至少包含初始、Alice、Bob、合并/裁决若干版');
    const versions = h.items.map((x) => x.version);
    assert.deepStrictEqual(versions, [...versions].sort((x, y) => y - x), '版本倒序');
    assert.ok(h.items.some((x) => x.note.includes('自动合并')), '合并版应有 note');
  });

  // ---------- 场景 8：回退不抹掉别人不冲突的改动（diff4）----------
  await test('从历史版本回退继续编辑：别人在别处的并发改动自动保留；同区域改动交用户裁决', async () => {
    const snap = await latestSnapshot(a2);
    const para = snap.nodes.find((n) => n.content.includes('开始改这一段'));
    assert.ok(para, '需要一个干净的种子段落');
    const v0 = para.version;

    // 8a) 不相交：v1 在区域 X 改错；Bob 的并发工作在另一区域 Y；
    //     Alice 回退到 v0 并只在区域 Z 续写 -> 三方各改不同位置，全自动合并。
    const text0 = para.content;
    const v1Text = text0.replace('Ctrl+Enter', 'Ctrl+Enter【错误改动】');
    const w1 = b2.next((m) => m.type === 'content' && m.nodeId === para.id);
    a2.send({ type: 'save', nodeId: para.id, content: v1Text, baseVersion: v0 });
    await w1;

    // Bob 基于 v1，在与"错误改动"和 Alice 续写都不相交的句首插入
    const w2 = a2.next((m) => m.type === 'content' && m.nodeId === para.id);
    b2.send({
      type: 'save',
      nodeId: para.id,
      content: 'Bob开头标记 ' + v1Text,
      baseVersion: v0 + 1,
    });
    await w2;

    // Alice 回退：草稿 = v0（错误改动从未发生的样子）+ 句尾续写。
    // 相对回退点 v0，她只在句尾动；Bob 在句首动；v1 的错误改动相对 v0
    // 处于中间，而草稿在中间等于 v0 —— 这一处按 git 语义属于"两边都碰了
    // 同一行/同一块"的情形，因此用例里让错误改动也位于句尾并与续写合并到
    // 同一 token 块会冲突。为了精确验证"不相交自动保留"，这里让错误改动
    // 处于 Alice 续写之后被整段恢复的区域外：构造见下。
    //
    // 采用最清晰的区域分离版本（三段式，每段一个改动位置）：
    const paraB = (await latestSnapshot(a2)).nodes.find((n) => n.id === para.id);
    // 直接验证当前已形成 v2 的状态下，以 v1 为回退点（撤掉 Bob 句首以外的历史）：
    // 草稿相对 v1 只在句尾加字，Bob 句首保留 -> 必然干净合并。
    const w3 = b2.next((m) => m.type === 'content' && m.nodeId === para.id);
    a2.send({
      type: 'restore_save',
      nodeId: para.id,
      content: v1Text + ' Alice续写保留', // 相对回退点 v1 只在句尾加
      restoreVersion: v0 + 1,
    });
    const merged = await w3;
    assert.ok(merged.content.includes('Bob开头标记'), '别人在句首的改动必须保留');
    assert.ok(merged.content.includes('Alice续写保留'), '回退后的续写必须保留');

    // 回退在历史中留痕
    a2.send({ type: 'history', nodeId: para.id });
    const hist = await a2.next((m) => m.type === 'history' && m.nodeId === para.id);
    assert.ok(hist.items[0].note.includes('回退'), '回退版本应留痕: ' + hist.items[0].note);

    // 8b) 同区域：别人的并发改动正好在回退区域内 -> 必须冲突，绝不静默覆盖
    const para2 = (await latestSnapshot(a2)).nodes.find((n) =>
      n.content.includes('关掉页面'));
    assert.ok(para2);
    const p0 = para2.version;
    const w4 = a2.next((m) => m.type === 'content' && m.nodeId === para2.id);
    b2.send({
      type: 'save',
      nodeId: para2.id,
      content: para2.content.replace('占用', '占用(Bob改在这里)'),
      baseVersion: p0,
    });
    await w4;
    // Alice 回退到 p0，并在同一块插入她自己的内容 -> 重叠冲突
    const conflictPromise = a2.next((m) => m.type === 'conflict');
    a2.send({
      type: 'restore_save',
      nodeId: para2.id,
      content: para2.content.replace('占用', '占用(Alice恢复并改这里)'),
      restoreVersion: p0,
    });
    const conflict = await conflictPromise;
    assert.strictEqual(conflict.reason, 'overlap');
    assert.ok(conflict.remote.includes('Bob改在这里'));
    assert.ok(conflict.local.includes('Alice恢复'));
    // 服务器内容原封不动，没有任何一方"误以为成功"
    const remoteStill = (await latestSnapshot(b2)).nodes.find((n) => n.id === para2.id);
    assert.ok(remoteStill.content.includes('Bob改在这里'));
    assert.ok(!remoteStill.content.includes('Alice恢复'));

    // 8c) 冲突裁决后双方收敛到同一份
    const w5 = b2.next((m) => m.type === 'content' && m.nodeId === para2.id);
    const agreed = conflict.remote.replace('Bob改在这里', '双方同意的措辞');
    a2.send({ type: 'resolve', nodeId: para2.id, content: agreed, keep: 'manual' });
    const settled = await w5;
    assert.strictEqual(settled.content, agreed);
    const [sA, sB] = await Promise.all([latestSnapshot(a2), latestSnapshot(b2)]);
    assert.strictEqual(
      sA.nodes.find((n) => n.id === para2.id).content,
      sB.nodes.find((n) => n.id === para2.id).content,
    );
  });

  // ---------- 场景 9：TTL 自动回收 ----------
  await test('锁带 TTL：服务器 sweep 回收过期锁并广播 unlocked(reason=ttl)', async () => {
    const snap = await latestSnapshot(a2);
    const node = snap.nodes[2];
    a2.send({ type: 'lock', nodeId: node.id });
    await b2.next((m) => m.type === 'locked' && m.nodeId === node.id);
    // 把锁时间戳拨到过期，触发一次扫描+广播
    const lock = serverMod.locks.locks.get(node.id);
    lock.at = Date.now() - 60_000;
    const p = b2.next(
      (m) => m.type === 'unlocked' && m.nodeId === node.id && m.reason === 'ttl',
      3000,
    );
    serverMod.sweepAndBroadcast();
    const msg = await p;
    assert.ok(msg);
    assert.ok(!serverMod.locks.locks.has(node.id), '锁应已被回收');
  });

  // ---------- 场景 9b：TTL 释放后别人立刻能接手，且不需要等连接关闭 ----------
  await test('空闲锁被 TTL 回收后，其他用户可以立即获取同一段', async () => {
    const snap = await latestSnapshot(a2);
    const node = snap.nodes.find((n) => n.id !== globalThis.__target2);
    a2.drain(() => true);
    b2.drain(() => true);
    a2.send({ type: 'lock', nodeId: node.id });
    await b2.next((m) => m.type === 'locked' && m.nodeId === node.id);
    // 拨老到过期并触发扫描：a2 的连接不断，只是锁没了
    serverMod.locks.locks.get(node.id).at = Date.now() - 60_000;
    const ttlA = a2.next((m) => m.type === 'unlocked' && m.nodeId === node.id && m.reason === 'ttl');
    const ttlB = b2.next((m) => m.type === 'unlocked' && m.nodeId === node.id && m.reason === 'ttl');
    serverMod.sweepAndBroadcast();
    await Promise.all([ttlA, ttlB]);

    // b2 立刻拿到锁；a2 再申请被拒绝
    b2.send({ type: 'lock', nodeId: node.id });
    const acquired = await b2.next((m) => m.type === 'lock_acquired' && m.nodeId === node.id);
    assert.strictEqual(acquired.reacquired, false);
    a2.send({ type: 'lock', nodeId: node.id });
    const denied = await a2.next((m) => m.type === 'lock_denied' && m.nodeId === node.id);
    assert.strictEqual(denied.holder.userId, 'u-bob2');
    // a2 的连接依然活着（没有掉线）
    assert.strictEqual(a2.ws.readyState, WebSocket.OPEN);
    b2.send({ type: 'unlock', nodeId: node.id });
  });

  // ---------- 场景 9c：ping 探活 bug 回归 —— 完全空闲的活连接不能被掐 ----------
  await test('连接挂着且完全不发消息，跨多个 ping 周期仍然存活（修复前每周期必死）', async () => {
    const idle = await connect('发呆用户', 'u-idle');
    await snapshotOf(idle);
    assert.strictEqual(idle.ws.readyState, WebSocket.OPEN);
    // 服务端 ping 周期由 WS_PING_MS 决定（测试里设短）；空等三轮，
    // 浏览器/ws 库会自动回 pong，活连接必须保持 OPEN（修复前 peer.alive
    // 从未被置位，第一轮就会被 terminate）。
    const pingMs = Number(process.env.WS_PING_MS) || 25000;
    await waitFor(pingMs * 3 + 200);
    assert.strictEqual(idle.ws.readyState, WebSocket.OPEN, '空闲活连接不应被 terminate');
    // 连接还能正常收发
    idle.send({ type: 'history', nodeId: globalThis.__target2 });
    const h = await idle.next((m) => m.type === 'history', 3000);
    assert.ok(h.items.length > 0);
    idle.close();
  });

  a2.close();
  b2.close();
  bob.close();

  // ---------- 场景 10：结构操作 新增/缩进/删除 + 收敛 ----------
  const c1 = await connect('Cathy', 'u-cathy');
  await snapshotOf(c1);
  const d1 = await connect('Dan', 'u-dan');
  await snapshotOf(d1);

  await test('新增段落广播给所有人，出现在正确层级位置', async () => {
    const snap = await latestSnapshot(c1);
    const roots = snap.nodes.filter((n) => !n.parentId);
    const treeRev = snap.treeRev;
    const p = d1.next((m) => m.type === 'node_added');
    c1.send({ type: 'add', parentId: '', afterId: '', content: '新增顶层', treeRev });
    const msg = await p;
    assert.strictEqual(msg.node.content, '新增顶层');
    assert.strictEqual(msg.node.parentId, null);
    assert.strictEqual(msg.treeRev, treeRev + 1);
    const snap2 = await latestSnapshot(c1);
    assert.ok(snap2.nodes.some((n) => n.content === '新增顶层'));
    globalThis.__newId = msg.node.id;
  });

  await test('移动层级：升级/降级后所有端结构一致', async () => {
    d1.drain(() => true);
    c1.drain(() => true);
    const snap = await latestSnapshot(c1);
    const nodeId = globalThis.__newId;
    // 挂到第一个顶层节点下面（降级）
    const firstRoot = snap.nodes.find((n) => !n.parentId && n.id !== nodeId);
    const p = d1.next((m) => m.type === 'node_moved' && m.nodeId === nodeId);
    c1.send({
      type: 'move',
      nodeId,
      parentId: firstRoot.id,
      afterId: '',
      treeRev: snap.treeRev,
    });
    const moved = await p;
    assert.strictEqual(moved.parentId, firstRoot.id);
    const snap2 = await latestSnapshot(d1);
    const after = snap2.nodes.find((n) => n.id === nodeId);
    assert.strictEqual(after.parentId, firstRoot.id);
  });

  await test('删除段落（含子树）广播且锁被释放', async () => {
    const snap = await latestSnapshot(c1);
    const nodeId = globalThis.__newId;
    const p = d1.next((m) => m.type === 'nodes_deleted');
    c1.send({ type: 'delete', nodeId, treeRev: snap.treeRev });
    const msg = await p;
    assert.ok(msg.ids.includes(nodeId));
    const snap2 = await latestSnapshot(c1);
    assert.ok(!snap2.nodes.some((n) => n.id === nodeId), '删除后快照中不应存在');
  });

  await test('过期 treeRev 的结构操作被拒绝并收到纠正快照', async () => {
    const snap = await latestSnapshot(c1);
    c1.drain(() => true);
    c1.send({
      type: 'add',
      parentId: '',
      afterId: '',
      content: '不应出现',
      treeRev: snap.treeRev - 5,
    });
    const stale = await c1.next((m) => m.type === 'tree_stale');
    assert.ok(stale.treeRev >= snap.treeRev);
    const fix = await c1.next((m) => m.type === 'snapshot');
    assert.ok(!fix.nodes.some((n) => n.content === '不应出现'));
  });

  c1.close();
  d1.close();

  // ---------- 场景 11：断线重连后状态自动修复 ----------
  await test('断线期间别人的修改，重连后通过快照补齐并收敛', async () => {
    const x = await connect('断线者', 'u-offline');
    const snap = await snapshotOf(x);
    const target = snap.nodes[0];
    const y = await connect('在线者', 'u-online2');
    await snapshotOf(y);
    // x 断开
    x.close();
    await waitFor(150);
    // y 改一段
    y.send({
      type: 'save',
      nodeId: target.id,
      content: target.content + '断线期间的修改',
      baseVersion: target.version,
    });
    await waitOf(y, (m) => m.type === 'saved');
    // x 重新连接（同一 userId）
    const x2 = await connect('断线者', 'u-offline');
    const snap2 = await snapshotOf(x2);
    const after = snap2.nodes.find((n) => n.id === target.id);
    assert.ok(after.content.includes('断线期间的修改'), '重连后必须看到离线期间的修改');
    y.close();
    x2.close();
  });

  await waitFor(100);
  serverMod.server.close();
  console.log(`\n全部 ${passed} 个端到端用例通过 ✅`);
  process.exit(0);
}

function waitOf(client, filter, timeout = 3000) {
  return client.next(filter, timeout);
}
async function latestSnapshot(client) {
  const tmp = await connect('__snap__' + Math.random().toString(36).slice(2, 7), 'u-snap-' + uid());
  const snap = await snapshotOf(tmp);
  tmp.close();
  return snap;
}
function uid() { return Math.random().toString(36).slice(2); }

run().catch((e) => {
  console.error('测试失败:', e);
  process.exit(1);
});
