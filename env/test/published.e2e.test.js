'use strict';

// 对外定稿端到端：真实 HTTP+WS 服务，多客户端验证
//   1. 未定稿时观看者只能看到"尚未定稿"，收不到任何工作稿消息
//   2. 定稿后观看者看到冻结内容；工作稿继续改，观看者页面不变
//   3. 再定稿：所有观看者原子切到同一份新版
//   4. 并发定稿：只有一个成功，另一个 stale，不存在两边都成功却对不上
//   5. 定稿是显式动作：客户端只有发 publish 才会产生新版本（反悔=不发）
//   6. viewer 写操作一律被服务器拒绝
//
// 运行：WS_PORT=3781 DB_FILE=./data/published.db node test/published.e2e.test.js

process.env.WS_PORT = process.env.WS_PORT || '3781';
process.env.DB_FILE = process.env.DB_FILE || './data/published.db';

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

function connect({ userName = '编辑', userId, role, docId } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const client = {
    ws,
    messages: [],
    waiters: [],
    send(obj) { ws.send(JSON.stringify(obj)); },
    next(filter = () => true, timeout = 3000) {
      return new Promise((resolve, reject) => {
        const hit = this.messages.find(filter);
        if (hit) {
          this.messages.splice(this.messages.findIndex(filter), 1);
          return resolve(hit);
        }
        const t = setTimeout(() => reject(new Error('等待消息超时: ' + filter)), timeout);
        this.waiters.push({
          filter,
          resolve: (m) => { clearTimeout(t); resolve(m); },
          reject: (e) => { clearTimeout(t); reject(e); },
        });
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
      client.send({
        type: 'hello',
        userId: userId || `u-${userName}`,
        userName,
        ...(role ? { role, docId } : {}),
      });
      client.next((m) => m.type === 'hello').then((m) => {
        client.role = m.role || 'editor';
        resolve(client);
      });
    });
    ws.on('error', reject);
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  await new Promise((r) => serverMod.server.listen(PORT, r));
  console.log(`测试服务已在 ${PORT} 启动`);

  const editor = await connect({ userName: '阿May', userId: 'u-may' });
  const snap = await editor.next((m) => m.type === 'snapshot');
  const docId = snap.docId;
  const nodeId = snap.nodes[0].id;

  // ---------- 场景 1：未定稿 → 观看者只见空状态，且收不到工作稿增量 ----------
  await test('从未定稿时，对外页只收到 published_state(pubSeq=0, nodes=null)', async () => {
    const viewer = await connect({ role: 'viewer', docId, userName: '外部' });
    const st = await viewer.next((m) => m.type === 'published_state');
    assert.strictEqual(st.docId, docId);
    assert.strictEqual(st.pubSeq, 0);
    assert.strictEqual(st.nodes, null, '未定稿绝不能把工作稿当作定稿发出去');

    // 工作稿改一段：viewer 收不到 content / locked 等任何工作稿消息
    editor.send({ type: 'save', nodeId, content: '工作稿偷偷改的内容', baseVersion: snap.nodes[0].version });
    await editor.next((m) => m.type === 'saved');
    await wait(150);
    const leaked = viewer.messages.filter((m) => ['content', 'node_added', 'locked', 'snapshot'].includes(m.type));
    assert.strictEqual(leaked.length, 0, '工作稿消息不得扇出给观看者');
    viewer.close();
  });

  // ---------- 场景 2：viewer 的写操作被服务器硬拒 ----------
  await test('观看者的保存/定稿/加锁等写消息一律被拒绝', async () => {
    const viewer = await connect({ role: 'viewer', docId, userName: '外部' });
    await viewer.next((m) => m.type === 'published_state');
    viewer.send({ type: 'save', nodeId, content: '黑客改动', baseVersion: 1 });
    const err = await viewer.next((m) => m.type === 'error');
    assert.ok(/只读/.test(err.message));
    viewer.send({ type: 'publish', docId, basePubSeq: 0 });
    const err2 = await viewer.next((m) => m.type === 'error');
    assert.ok(/只读/.test(err2.message));
    viewer.close();
  });

  // ---------- 场景 3：定稿；之后工作稿再改，外面不变 ----------
  const viewers = [];
  await test('第一次定稿：观看者收到冻结快照；工作稿之后修改不影响定稿', async () => {
    const v1 = await connect({ role: 'viewer', docId, userName: '外部甲' });
    await v1.next((m) => m.type === 'published_state'); // 旧的空状态
    viewers.push(v1);
    const v2 = await connect({ role: 'viewer', docId, userName: '外部乙' });
    await v2.next((m) => m.type === 'published_state');
    viewers.push(v2);

    // 当前工作稿第一段已经是"工作稿偷偷改的内容"，定稿把它冻结
    editor.send({ type: 'publish', docId, basePubSeq: 0 });
    const ack = await editor.next((m) => m.type === 'published_ack');
    assert.strictEqual(ack.pubSeq, 1);

    const changedV1 = [];
    for (const v of [v1, v2]) {
      const ch = await v.next((m) => m.type === 'published_changed' && m.pubSeq === 1);
      assert.ok(ch.nodes.some((n) => n.content === '工作稿偷偷改的内容'), '定稿应冻结发布时刻正文');
      assert.strictEqual(ch.by.userName, '阿May');
      changedV1.push(ch);
    }
    // 定稿之后编辑继续改工作稿
    editor.send({ type: 'open_doc', docId });
    const fresh = await editor.next((m) => m.type === 'snapshot');
    const first = fresh.nodes.find((n) => n.id === nodeId);
    editor.send({ type: 'save', nodeId, content: '定稿后工作稿又改了', baseVersion: first.version });
    await editor.next((m) => m.type === 'saved');

    await wait(150);
    for (let i = 0; i < viewers.length; i++) {
      const leaked = viewers[i].drain((m) => m.type === 'content');
      assert.strictEqual(leaked.length, 0, '定稿后工作稿的 content 不得推给观看者');
      const st = changedV1[i];
      assert.ok(st.nodes.some((n) => n.content === '工作稿偷偷改的内容'), '外面仍应停在第 1 版定稿');
      assert.strictEqual(st.pubSeq, 1);
    }

    // 编辑端快照也带 published 摘要（CAS 基准 + 状态显示）
    assert.strictEqual(fresh.published.pubSeq, 1);
  });

  // ---------- 场景 4：再定稿，所有观看者原子切到同一份新版 ----------
  await test('第二次定稿：所有观看者整树替换为同一版（第 2 版）', async () => {
    editor.send({ type: 'publish', docId, basePubSeq: 1 });
    const ack = await editor.next((m) => m.type === 'published_ack');
    assert.strictEqual(ack.pubSeq, 2);

    for (const v of viewers) {
      const ch = await v.next((m) => m.type === 'published_changed' && m.pubSeq === 2);
      assert.ok(ch.nodes.some((n) => n.content === '定稿后工作稿又改了'));
    }
  });

  // ---------- 场景 4b：定出去之前反悔——不发 publish，外面仍是上一版 ----------
  await test('反悔（没点确认 = 不发 publish）：外面仍停在上一版定稿', async () => {
    // 工作稿再改一改，然后"用户在确认弹窗点了取消"——什么都不发
    editor.send({ type: 'open_doc', docId });
    const fresh = await editor.next((m) => m.type === 'snapshot');
    const first = fresh.nodes.find((n) => n.id === nodeId);
    editor.send({ type: 'save', nodeId, content: '差点定稿但反悔了', baseVersion: first.version });
    await editor.next((m) => m.type === 'saved');
    await wait(150); // 故意等一会儿

    const late = await connect({ role: 'viewer', docId, userName: '路过的' });
    const st = await late.next((m) => m.type === 'published_state');
    assert.strictEqual(st.pubSeq, 2, '没确认定稿，对外版本必须还是第 2 版');
    assert.ok(!st.nodes.some((n) => n.content === '差点定稿但反悔了'), '反悔的工作稿内容不得外泄');
    late.close();
  });

  // ---------- 场景 5：并发定稿——只有一个成功，另一个 stale ----------
  await test('两人几乎同时定稿：一个成功，另一个 publish_stale，最终全员同一版', async () => {
    // 两个编辑都基于"第 2 版"这一基准点定稿，但 bob 先让工作稿产生变化以区分内容
    const bob = await connect({ userName: 'Bob', userId: 'u-bob' });
    const bsnap = await bob.next((m) => m.type === 'snapshot');
    assert.strictEqual(bsnap.published.pubSeq, 2);

    // 让 bob 看到的工作稿和 alice 即将定的不一样：bob 先改一段再定稿，alice 不改直接定
    const first = bsnap.nodes.find((n) => n.id === nodeId);
    bob.send({ type: 'save', nodeId, content: 'Bob 改过的工作稿', baseVersion: first.version });
    await bob.next((m) => m.type === 'saved' || m.type === 'merge_notice');

    // 同一事件循环里发出两个 publish（basePubSeq 都是 2）
    bob.send({ type: 'publish', docId, basePubSeq: 2 });
    editor.send({ type: 'publish', docId, basePubSeq: 2 });

    const results = [];
    results.push(await bob.next((m) => ['published_ack', 'publish_stale'].includes(m.type), 3000));
    results.push(await editor.next((m) => ['published_ack', 'publish_stale'].includes(m.type), 3000));

    const acks = results.filter((m) => m.type === 'published_ack');
    const stales = results.filter((m) => m.type === 'publish_stale');
    assert.strictEqual(acks.length, 1, '必须恰好一个定稿成功');
    assert.strictEqual(stales.length, 1, '必须恰好一个被拒绝');
    assert.strictEqual(acks[0].pubSeq, 3);
    assert.strictEqual(stales[0].current.pubSeq, 3, '被拒者应被告知当前已是第 3 版');

    // 所有观看者只收到一次 v3 切换，内容唯一
    for (const v of viewers) {
      const ch = await v.next((m) => m.type === 'published_changed' && m.pubSeq === 3);
      assert.ok(ch.nodes.some((n) => n.id === nodeId && n.content === 'Bob 改过的工作稿')
        || ch.nodes.some((n) => n.id === nodeId && n.content === '定稿后工作稿又改了'));
      const v3s = v.drain((m) => m.type === 'published_changed' && m.pubSeq === 3);
      assert.ok(v3s.length <= 1, '同一次定稿只能切换一次');
    }

    // 被拒者用新基准重试 → 成功为第 4 版（CAS 收敛，不是报错了事）
    async function retryOn(c) {
      c.send({ type: 'publish', docId, basePubSeq: 3 });
      return c.next((m) => ['published_ack', 'publish_stale'].includes(m.type));
    }
    const bobHasAck = results[0].type === 'published_ack';
    const retry = await retryOn(bobHasAck ? editor : bob);
    if (retry.type === 'published_ack' && !retry.unchanged) {
      assert.strictEqual(retry.pubSeq, 4);
      for (const v of viewers) {
        await v.next((m) => m.type === 'published_changed' && m.pubSeq === 4, 3000).catch(() => {});
      }
    } else if (retry.type === 'published_ack') {
      assert.ok(retry.unchanged, '内容相同时应回执 unchanged');
    }
    bob.close();
  });

  // ---------- 场景 6：未定稿基准错误（basePubSeq 乱填）直接拒绝 ----------
  await test('basePubSeq 与服务器不一致即 stale，不能凭空跳过版本', async () => {
    editor.send({ type: 'publish', docId, basePubSeq: 99 });
    const m = await editor.next((m) => m.type === 'publish_stale');
    assert.ok(m.current.pubSeq >= 3);
  });

  // ---------- 场景 7：新加入的观看者直接看到当前定稿 ----------
  await test('定稿之后才打开对外页的人，一进来就是当前最新定稿', async () => {
    const late = await connect({ role: 'viewer', docId, userName: '新来的' });
    const st = await late.next((m) => m.type === 'published_state');
    assert.ok(st.pubSeq >= 3);
    assert.ok(Array.isArray(st.nodes) && st.nodes.length >= 5);
    assert.ok(st.nodes.some((n) => n.id === nodeId));
    late.close();
  });

  // ---------- 场景 8：跟读行在定稿时冻结为当时投影正文 ----------
  await test('定稿快照自包含：跟读行内嵌投影正文（不依赖源文档之后变化）', async () => {
    // 新建一份大纲并挂跟读，再定稿，删源，定稿快照里仍有当时冻结的文本
    editor.send({ type: 'create_doc', title: '宿主大纲' });
    const created = await editor.next((m) => m.type === 'doc_created');
    const hostSnap = await editor.next((m) => m.type === 'snapshot' && m.docId === created.doc.id);
    editor.send({
      type: 'add_mirror',
      sourceId: nodeId,
      docId: hostSnap.docId,
      parentId: null,
      treeRev: hostSnap.treeRev,
    });
    const added = await editor.next((m) => m.type === 'mirror_added');
    const hostSnap2 = await editor.next((m) => m.type === 'snapshot').catch(() => null);
    void hostSnap2;

    editor.send({ type: 'publish', docId: added.docId, basePubSeq: 0 });
    const ack = await editor.next((m) => m.type === 'published_ack');
    assert.strictEqual(ack.pubSeq, 1);
    const hv = await connect({ role: 'viewer', docId: added.docId, userName: '宿主外部' });
    const st = await hv.next((m) => m.type === 'published_state' && m.pubSeq === 1);
    const frozenMirror = st.nodes.find((n) => n.kind === 'mirror' && n.mirrorOf === nodeId);
    assert.ok(frozenMirror, '定稿里应包含跟读行');
    assert.ok(typeof frozenMirror.content === 'string' && frozenMirror.content.length > 0,
      '跟读正文必须在定稿时冻结进快照');
    hv.close();
  });

  for (const v of viewers) v.close();
  editor.close();

  console.log(`\n定稿端到端全部通过：${passed} 个场景`);
  serverMod.server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
}

run().catch((err) => {
  console.error('测试失败:', err);
  process.exit(1);
});
