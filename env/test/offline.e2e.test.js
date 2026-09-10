'use strict';

// 离线续改端到端：jsdom 真实客户端 + 可停可启的真实服务器 + 原生 ws 客户端。
// 覆盖：
//   1) 断线时保存 → 写入本机队列（localStorage）、本地乐观显示、待同步徽章；
//      结构改动离线时被明确拦下；
//   2) 重连后自动回放：不撞的改动三方合并，全员（含跟读行）收敛到同一份；
//   3) 两人断线时改了同一段同一处：后到的一方不会"显示成功却对不上"——
//      行内红徽章明示"当前以线上为准"，裁决后全员逐字收敛；
//   4) clientTag 透传；未保存草稿随输入落盘、取消后清除。
// 运行：node test/offline.e2e.test.js

process.env.DB_FILE = './data/offline.db';
const fs = require('fs');
for (const f of [process.env.DB_FILE, process.env.DB_FILE + '-wal', process.env.DB_FILE + '-shm']) {
  try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
}
const path = require('path');
const crypto = require('crypto');
const { JSDOM } = require('jsdom');
const WebSocket = require('ws');

const PORT = 3794;

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error('  ✗ ' + msg); }
  else console.log('  ✓ ' + msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, what, timeout = 12000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = cond();
      if (v) return v;
    } catch { /* ignore */ }
    if (Date.now() - t0 > timeout) throw new Error('等待超时: ' + what);
    await sleep(200);
  }
}

// ---- 原生 ws 客户端（扮演另一个用户"在线乙"）----
function connectRaw(userName, userId) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const client = {
    ws,
    user: null,
    messages: [],
    waiters: [],
    send(obj) { ws.send(JSON.stringify(obj)); },
    next(filter = () => true, timeout = 6000) {
      return new Promise((resolve, reject) => {
        const hit = this.messages.find(filter);
        if (hit) return resolve(hit);
        const t = setTimeout(() => reject(new Error('等待消息超时')), timeout);
        this.waiters.push({ filter, resolve, reject: (e) => { clearTimeout(t); reject(e); } });
      });
    },
    close() { try { ws.close(); } catch { /* ignore */ } },
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
      client.send({ type: 'hello', userId, userName });
      client.next((m) => m.type === 'hello').then((m) => {
        client.user = m.user;
        resolve(client);
      });
    });
    ws.on('error', () => { /* 重连交给调用方 */ });
  });
}

async function main() {
  const serverMod = require('../server/index');
  await new Promise((r) => serverMod.server.listen(PORT, r));
  console.log(`离线测试服务已在 ${PORT} 启动`);

  // ---------- jsdom 客户端 A（"离线甲"）----------
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const dom = new JSDOM(html, {
    url: `http://127.0.0.1:${PORT}/`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.WebSocket = WebSocket;
  if (!window.crypto?.randomUUID) {
    Object.defineProperty(window, 'crypto', {
      value: crypto.webcrypto, configurable: true, writable: true,
    });
  }
  if (!window.requestAnimationFrame) {
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  }
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.confirm = () => true;
  const errors = [];
  window.addEventListener('error', (e) => errors.push(e.error?.message || String(e.message)));
  window.eval(appJs);

  const $ = (sel) => window.document.querySelector(sel);
  const $$ = (sel) => [...window.document.querySelectorAll(sel)];
  const queueOps = () => JSON.parse(window.localStorage.getItem('outline.offlineQueue.v1') || '[]');
  const rowByText = (text) =>
    $$('#outline .node-outer').find((el) => {
      const c = el.querySelector(':scope > .node .node-content');
      return c && c.textContent.includes(text);
    }) || null;
  const rowContent = (row) => row.querySelector(':scope > .node .node-content').textContent;

  async function editAndSave(rowText, newText) {
    const row = rowByText(rowText);
    assert(row, `找到段落「${rowText}」`);
    const btn = [...row.querySelectorAll(':scope > .node .node-actions button')]
      .find((b) => b.textContent === '编辑');
    btn.click();
    await sleep(150);
    const ta = $('#outline textarea');
    assert(ta, '编辑器已打开');
    ta.value = newText;
    ta.dispatchEvent(new window.Event('input', { bubbles: true }));
    ta.dispatchEvent(new window.KeyboardEvent('keydown', {
      key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    await sleep(250);
  }

  // ---- 登录并准备好多文档 + 跟读 ----
  $('#name-input').value = '离线甲';
  $('#login-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => $$('#outline .node-outer').length >= 5, '默认大纲渲染');

  // 建第二份大纲，把 n2（"实时看到…"）挂跟读过去
  $('#new-doc-btn').click();
  $('#newdoc-title').value = '跟读宿主大纲';
  $('#newdoc-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => $$('.doc-tab').length === 2, '出现第二个标签页');
  const doc2Id = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('doc');
  assert(doc2Id && doc2Id !== 'default', '拿到跟读宿主大纲 id');
  $$('.doc-tab-label').find((t) => t.textContent.includes('团队共享大纲')).click();
  await sleep(300);
  const n2RowForMirror = rowByText('实时看到');
  [...n2RowForMirror.querySelectorAll(':scope > .node .node-actions button')]
    .find((b) => b.textContent.includes('挂跟读')).click();
  await sleep(150);
  $('#mirror-confirm').click();
  await waitFor(() => $('#outline .mirror-node'), '跟读行出现在宿主大纲');
  $$('.doc-tab-label').find((t) => t.textContent.includes('团队共享大纲')).click();
  await sleep(300);

  // ---------- 服务器宕机：全员断线 ----------
  for (const p of serverMod.peers.values()) {
    try { p.ws.terminate(); } catch { /* ignore */ }
  }
  await Promise.race([new Promise((r) => serverMod.server.close(r)), sleep(1500)]);
  await waitFor(() => $('#conn-state').classList.contains('offline'), '甲的连接状态变为离线');

  // ---------- 甲在断线时改两段并保存 ----------
  await editAndSave('项目目标', '项目目标：多人同时维护这份大纲【甲离线句尾】');
  await editAndSave('实时看到', '【甲离线句首】实时看到谁正在编辑哪一段');

  assert(!$('#outline textarea'), '离线保存后编辑器关闭（改动已存本机）');
  assert(queueOps().length === 2, '两段离线改动都写入本机队列（localStorage）');
  assert(rowByText('【甲离线句尾】'), '离线改动在本地乐观显示（n1）');
  assert(rowByText('【甲离线句首】'), '离线改动在本地乐观显示（n2）');
  assert(
    rowByText('项目目标').querySelector(':scope > .node .sync-badge.pending'),
    'n1 行挂出「待同步」徽章',
  );
  assert(
    !$('#sync-state').classList.contains('hidden') && $('#sync-state').textContent.includes('待同步'),
    '顶栏胶囊提示有待同步的离线改动',
  );

  // 结构改动离线时被明确拦下（不进队列）
  const addBtn = [...rowByText('项目目标').querySelectorAll(':scope > .node .node-actions button')]
    .find((b) => b.textContent === '＋子级');
  addBtn.click();
  await sleep(250);
  assert(
    $$('#toast-host .toast').some((t) => t.textContent.includes('结构改动')),
    '离线时增/删/移动被明确拦下并说明',
  );

  // ---------- 服务器恢复。乙（另一客户端）重连并抢先保存 ----------
  // 乙在断线期间也改了这两段（本地持有文本，重连后先提交）：
  //   n1 与甲撞在同一处（句尾同一点插入）→ 必须冲突；
  //   n2 与甲不撞（甲改句首、乙改句尾）→ 必须自动合并。
  await new Promise((r) => serverMod.server.listen(PORT, r));
  const B = await connectRaw('在线乙', 'u-yi');
  const snapB = await B.next((m) => m.type === 'snapshot');
  const n1 = snapB.nodes.find((n) => n.content.includes('项目目标'));
  const n2 = snapB.nodes.find((n) => n.content.includes('实时看到'));
  const n3 = snapB.nodes.find((n) => n.content.includes('关掉页面'));
  B.send({ type: 'save', nodeId: n1.id, content: n1.content + '【乙离线句尾】', baseVersion: n1.version });
  await B.next((m) => m.type === 'saved' && m.nodeId === n1.id);
  B.send({ type: 'save', nodeId: n2.id, content: n2.content + '【乙离线句尾】', baseVersion: n2.version });
  await B.next((m) => m.type === 'saved' && m.nodeId === n2.id);
  B.send({ type: 'open_doc', docId: doc2Id }); // 乙也订阅跟读宿主大纲
  await B.next((m) => m.type === 'snapshot' && m.docId === doc2Id);

  // ---------- 甲自动重连 → 快照 → 自动回放离线队列 ----------
  // n2：不撞 → 自动合并，两人改动都在
  const n2MergedRow = await waitFor(() => {
    const row = $$('#outline .node-outer').find((el) => {
      const c = el.querySelector(':scope > .node .node-content');
      return c && c.textContent.includes('【甲离线句首】') && c.textContent.includes('【乙离线句尾】');
    });
    return row || null;
  }, 'n2 自动合并（甲的句首 + 乙的句尾都在）');
  assert(n2MergedRow, '不撞的离线改动被保留并合并');

  // 乙在源大纲房间收到合并后的同一份
  const n2MsgB = await B.next((m) =>
    m.type === 'content' && m.nodeId === n2.id && m.content.includes('【甲离线句首】'));
  assert(n2MsgB.content.includes('【乙离线句尾】'), '乙也收到合并后的同一份（源大纲）');

  // 乙在跟读宿主大纲房间也收到同一份（跟读投影收敛）
  const n2MirrorMsg = await B.next((m) =>
    m.type === 'content' && m.nodeId === n2.id && m.content.includes('【甲离线句首】'));
  assert(n2MirrorMsg.content.includes('【乙离线句尾】'), '跟读宿主大纲也广播到同一份');

  // 甲切到跟读宿主大纲：跟读行就是合并后的那一份
  $$('.doc-tab-label').find((t) => t.textContent.includes('跟读宿主')).click();
  await waitFor(() => {
    const m = $('#outline .mirror-node .node-content');
    return m && m.textContent.includes('【甲离线句首】') && m.textContent.includes('【乙离线句尾】')
      ? m : null;
  }, '跟读行投影合并后的同一份内容');
  $$('.doc-tab-label').find((t) => t.textContent.includes('团队共享大纲')).click();
  await sleep(300);

  // n1：撞了 → 甲这边绝不"显示成功却对不上"：行显示线上版本 + 红徽章
  const n1ConflictRow = await waitFor(() => {
    const row = $$('#outline .node-outer').find((el) => {
      const c = el.querySelector(':scope > .node .node-content');
      return c && c.textContent.includes('【乙离线句尾】');
    });
    return row && row.querySelector(':scope > .node .sync-badge.conflict') ? row : null;
  }, 'n1 行显示线上版本并挂出冲突徽章');
  const n1Shown = rowContent(n1ConflictRow);
  assert(
    n1Shown.includes('【乙离线句尾】') && !n1Shown.includes('【甲离线句尾】'),
    '冲突段落当前以线上（乙）为准，甲的离线改动没有假装生效',
  );
  assert(
    n1ConflictRow.querySelector('.sync-badge.conflict').textContent.includes('当前以线上'),
    '冲突徽章明示"现在听线上的"',
  );
  assert(
    queueOps().length === 1 && queueOps()[0].status === 'conflict' && queueOps()[0].nodeId === n1.id,
    '冲突的离线改动留在本机队列里等裁决',
  );
  assert($('#sync-state').textContent.includes('冲突'), '顶栏胶囊提示有冲突待裁决');

  // ---------- 甲点徽章裁决：弹窗看清两边，提交后全员收敛 ----------
  n1ConflictRow.querySelector('.sync-badge.conflict').click();
  await waitFor(() => !$('#conflict-mask').classList.contains('hidden'), '离线冲突裁决窗打开');
  assert($('#conflict-title').textContent.includes('离线'), '裁决窗标明是离线改动冲突');
  assert($('#conflict-sub').textContent.includes('线上'), '裁决窗说明裁决前以线上为准');
  assert($('#conflict-local').value.includes('【甲离线句尾】'), '左侧是甲的离线改动');
  assert($('#conflict-remote').value.includes('【乙离线句尾】'), '右侧是线上当前版本');

  $('#conflict-keep-local').click(); // 用甲的
  $('#conflict-save').click();
  await waitFor(() => {
    const row = rowByText('【甲离线句尾】');
    return row && !row.querySelector(':scope > .node .sync-badge') ? row : null;
  }, '裁决后甲的文本生效、徽章消失');
  assert(queueOps().length === 0, '离线队列清空');
  assert($('#sync-state').classList.contains('hidden'), '顶栏胶囊隐藏');

  // 乙收到裁决后的最终版本：两边逐字一致，不存在"各自成功"
  const finalMsg = await B.next((m) =>
    m.type === 'content' && m.nodeId === n1.id && m.content.includes('【甲离线句尾】'));
  const n1FinalA = rowContent(rowByText('【甲离线句尾】'));
  assert(finalMsg.content === n1FinalA, '裁决后甲、乙两边逐字一致');

  // ---------- clientTag 透传 ----------
  B.send({
    type: 'save', nodeId: n3.id, content: n3.content + '【乙改】',
    baseVersion: n3.version, clientTag: 'tag-x',
  });
  const tagged = await B.next((m) => m.type === 'saved' && m.nodeId === n3.id);
  assert(tagged.clientTag === 'tag-x', '服务器在回执里透传 clientTag');

  // ---------- 未保存草稿随输入落盘，取消后清除 ----------
  await waitFor(() => rowByText('【乙改】'), '甲看到乙对 n3 的修改');
  const n3Row = rowByText('关掉页面');
  [...n3Row.querySelectorAll(':scope > .node .node-actions button')]
    .find((b) => b.textContent === '编辑').click();
  await sleep(150);
  const ta = $('#outline textarea');
  ta.value = ta.value + '（甲的临时草稿）';
  ta.dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(700); // 落盘节流 400ms
  const drafts = JSON.parse(window.localStorage.getItem('outline.drafts.v1') || '{}');
  assert(
    Object.values(drafts).some((d) => d.content && d.content.includes('甲的临时草稿')),
    '未保存的草稿随输入落盘（断线/刷新不丢）',
  );
  ta.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await sleep(700);
  const drafts2 = JSON.parse(window.localStorage.getItem('outline.drafts.v1') || '{}');
  assert(
    !Object.values(drafts2).some((d) => d.content && d.content.includes('甲的临时草稿')),
    '取消编辑后落盘草稿被清除',
  );

  assert(errors.length === 0, '整个流程无未捕获前端错误' + (errors.length ? ': ' + errors.join('; ') : ''));

  await sleep(100);
  B.close();
  serverMod.server.close();
  console.log(failures ? `\n❌ ${failures} 个断言失败` : '\n离线续改用例全部通过 ✅');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('离线测试失败:', e);
  process.exit(1);
});
