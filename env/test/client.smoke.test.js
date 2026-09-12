'use strict';

// 客户端冒烟：jsdom 加载真实 index.html + app.js，用内存 WebSocket 桩
// 驱动"多文档 + 跟读"完整 UI 流程，捕捉运行时错误。
// 运行：node test/client.smoke.test.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
process.env.DB_FILE = './data/smoke.db';
for (const f of ['./data/smoke.db', './data/smoke.db-wal', './data/smoke.db-shm']) {
  try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
}
const { JSDOM } = require('jsdom');

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error('  ✗ ' + msg); }
  else console.log('  ✓ ' + msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 复用 index.js 模块：创建 wss；测试环境再监听一个端口，
  // jsdom 里用真实 ws 客户端（注入全局 WebSocket）。
  const serverMod = require('../server/index');
  const PORT = 3791;
  await new Promise((r) => serverMod.server.listen(PORT, r));

  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

  const WS = require('ws');
  const dom = new JSDOM(html, {
    url: `http://127.0.0.1:${PORT}/`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // 注入浏览器 API
  window.WebSocket = WS;
  if (!window.crypto?.randomUUID) {
    Object.defineProperty(window, 'crypto', {
      value: crypto.webcrypto, configurable: true, writable: true,
    });
  }
  if (!window.requestAnimationFrame) {
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  }
  window.HTMLElement.prototype.scrollIntoView = function () {};
  // localStorage 已由 jsdom 提供
  window.confirm = () => true;

  const errors = [];
  window.addEventListener('error', (e) => errors.push(e.error?.message || String(e.message)));

  window.eval(appJs);
  const $ = (sel) => window.document.querySelector(sel);
  const $$ = (sel) => [...window.document.querySelectorAll(sel)];

  // ---- 登录 ----
  $('#name-input').value = '冒烟用户';
  $('#login-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(500);
  assert(!$('#login').classList.contains('hidden') === false, '登录后进入主界面');
  const tabs1 = $$('.doc-tab').length;
  assert(tabs1 >= 1, `至少有一个文档标签页（实际 ${tabs1}）`);
  assert($('#outline').children.length >= 2, '默认大纲渲染出顶层段落');
  assert($$('#outline .node-outer').length >= 5, '层级树（含子级）全部渲染');

  // ---- 新建大纲 ----
  $('#new-doc-btn').click();
  await sleep(50);
  assert(!$('#newdoc-mask').classList.contains('hidden'), '新建大纲弹窗打开');
  $('#newdoc-title').value = '第二份大纲冒烟';
  $('#newdoc-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(500);
  assert($$('.doc-tab').length === 2, '创建后出现两个标签页');
  const activeTitle = $('#doc-title').textContent;
  assert(activeTitle.includes('第二份大纲冒烟'), `激活的是新大纲（实际：${activeTitle}）`);
  assert($('#outline').children.length === 0, '新大纲为空');
  const docBId = new URLSearchParams(window.location.hash.slice(1)).get('doc');
  assert(!!docBId, 'hash 里是新文档 id');

  // ---- 回默认大纲，给第一个段落挂跟读 ----
  $$('.doc-tab-label')[0].click();
  await sleep(200);
  assert($('#doc-title').textContent.includes('团队共享大纲'), '切回默认大纲');
  const firstRow = $('#outline > .node-outer > .node');
  const sourceNodeId = firstRow.dataset.nodeId;
  // hover 操作条在 jsdom 里 opacity 不影响点击；直接找到「挂跟读」按钮
  const mirrorBtns = [...firstRow.querySelectorAll('.node-actions button')]
    .filter((b) => b.textContent.includes('挂跟读'));
  assert(mirrorBtns.length === 1, '段落操作条有「挂跟读」');
  mirrorBtns[0].click();
  await sleep(100);
  assert(!$('#mirror-mask').classList.contains('hidden'), '挂跟读弹窗打开');
  const opts = $$('#mirror-doc-select option');
  assert(opts.length === 1 && opts[0].textContent.includes('第二份大纲冒烟'), '目标列表里只有另一份大纲');
  $('#mirror-confirm').click();
  await sleep(400);
  // 客户端应切到第二份大纲
  assert($('#doc-title').textContent.includes('第二份大纲冒烟'), '挂完自动跳到目标大纲');
  const mirrorRow = $('#outline .node.mirror-node');
  assert(!!mirrorRow, '第二份大纲里出现跟读行');
  assert(mirrorRow.textContent.includes('跟读自'), '跟读行有来源标记');
  const mirrorId = mirrorRow.dataset.nodeId;
  const tombBefore = mirrorRow.querySelectorAll('.mirror-tombstone').length;
  assert(tombBefore === 0, '跟读活着时不显示墓碑');

  // ---- 在源上改正文，跟读行应局部更新为同一文本 ----
  $$('.doc-tab-label')[0].click();
  await sleep(250);
  const sourceText = firstRow.querySelector(':scope > .node-row .node-content').textContent;
  // 点源段「编辑」
  const editBtn = [...firstRow.querySelectorAll(':scope > .node-row .node-actions button')]
    .find((b) => b.textContent === '编辑');
  editBtn.click();
  await sleep(200);
  const ta = $('#outline textarea');
  assert(!!ta, '源段落进入编辑态');
  ta.value = sourceText + '【冒烟源改动】';
  ta.dispatchEvent(new window.Event('input', { bubbles: true }));
  // Ctrl+Enter 保存
  ta.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
  await sleep(400);
  assert(!$('#outline textarea'), '保存后退出编辑态');
  assert(
    $(`.node-outer[data-node-id="${sourceNodeId}"]`).textContent.includes('【冒烟源改动】'),
    '源行显示新正文',
  );

  // ---- 回归：编辑一段时，这段底下挂着的留言必须一直可见；别人补话/收掉要实时出现，不能等存完 ----
  {
    const editAgain = [...$$(`.node-outer[data-node-id="${sourceNodeId}"] > .node .node-actions button`)]
      .find((b) => b.textContent === '编辑');
    editAgain.click();
    await sleep(250);
    const editTa = $('#outline textarea');
    assert(!!editTa, '源段落重新进入编辑态（留言回归用例）');

    // 先放一条"早就挂着"的留言（另一个连接写入），进入编辑前/后都应看得到
    await new Promise((resolve, reject) => {
      const other = new WS(`ws://127.0.0.1:${PORT}/ws`);
      let stage = 0;
      other.on('open', () => other.send(JSON.stringify({ type: 'hello', userId: 'u-edit-comment', userName: '编辑时留言的人' })));
      other.on('error', reject);
      other.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'snapshot' && stage === 0) {
          const target = msg.nodes.find((n) => n.id === sourceNodeId);
          stage = 1;
          other.send(JSON.stringify({ type: 'comment_add', nodeId: sourceNodeId, commentId: 'cmt-edit-existing', content: '编辑前就挂着的留言' }));
        } else if (msg.type === 'comment_added' && msg.comment?.id === 'cmt-edit-existing' && stage === 1) {
          stage = 2;
          setTimeout(() => { other.close(); resolve(); }, 300);
        }
      });
    });
    await sleep(300);
    const sOuter = $(`.node-outer[data-node-id="${sourceNodeId}"]`);
    assert(!!sOuter.querySelector('.edit-comments'), '编辑态下有挂在编辑器下方的留言区');
    assert(sOuter.textContent.includes('编辑前就挂着的留言'), '已有留言在编辑态下仍然可见（没有从自己屏幕上消失）');
    assert(sOuter.textContent.includes('写留言'), '编辑态留言区有写留言入口');

    // 打一半、还没保存的草稿
    editTa.value = editTa.value + '【编辑中没保存的草稿】';
    editTa.dispatchEvent(new window.Event('input', { bubbles: true }));

    // 编辑期间，对方再补一句、再把第一句收掉：本界面留言块实时更新，编辑器不动
    await new Promise((resolve, reject) => {
      const other = new WS(`ws://127.0.0.1:${PORT}/ws`);
      let stage = 0;
      other.on('open', () => other.send(JSON.stringify({ type: 'hello', userId: 'u-edit-comment2', userName: '编辑时留言的人' })));
      other.on('error', reject);
      other.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'snapshot' && stage === 0) {
          stage = 1;
          other.send(JSON.stringify({ type: 'comment_add', nodeId: sourceNodeId, commentId: 'cmt-edit-late', content: '你编辑时对方补的一句' }));
        } else if (msg.type === 'comment_added' && msg.comment?.id === 'cmt-edit-late' && stage === 1) {
          stage = 2;
          other.send(JSON.stringify({ type: 'comment_resolve', commentId: 'cmt-edit-existing', content: '边改边收：已处理' }));
        } else if (msg.type === 'comment_resolved' && msg.comment?.id === 'cmt-edit-existing' && stage === 2) {
          stage = 3;
          setTimeout(() => { other.close(); resolve(); }, 300);
        }
      });
    });
    await sleep(300);
    assert(sOuter.textContent.includes('你编辑时对方补的一句'), '编辑期间新来的留言当场出现，不用等存完');
    assert(sOuter.textContent.includes('已收（编辑时留言的人）'), '编辑期间被收掉的留言当场变已收');
    assert(sOuter.textContent.includes('边改边收：已处理'), '收掉的说法实时一致');
    const taStill = $('#outline textarea');
    assert(!!taStill, '编辑器仍然开着（没被留言刷新顶掉）');
    assert(taStill.value.includes('【编辑中没保存的草稿】'), '未保存草稿原样保留（刷留言没碰编辑器）');

    // Esc 取消编辑：草稿不保存，但留言仍在该段（与正文保存与否无关）
    taStill.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await sleep(250);
    const afterOuter = $(`.node-outer[data-node-id="${sourceNodeId}"]`);
    assert(afterOuter.textContent.includes('你编辑时对方补的一句'), '取消编辑后留言仍在');
    assert(afterOuter.textContent.includes('边改边收：已处理'), '取消编辑后已收状态仍在');
    assert(!afterOuter.textContent.includes('【编辑中没保存的草稿】'), '取消即未保存草稿（留言不受影响）');
  }

  // 切到第二份大纲，跟读必须同步（房间始终订阅，消息已应用）
  $$('.doc-tab-label')[1].click();
  await sleep(200);
  const mRow = $(`.node-outer[data-node-id="${mirrorId}"] > .node .node-content`);
  assert(!!mRow && mRow.textContent.includes('【冒烟源改动】'), '跟读行同步为源新正文，不分叉');

  // ---- 在跟读上直接编辑：编辑器落在跟读行，保存后源也变 ----
  const mEdit = [...$$(`.node-outer[data-node-id="${mirrorId}"] .node-actions button`)]
    .find((b) => b.textContent === '编辑');
  mEdit.click();
  await sleep(200);
  const mta = $('#outline textarea');
  assert(!!mta, '跟读行进入编辑态');
  assert($('#outline').textContent.includes('正在跟读处编辑'), '有"跟读处编辑"提示');
  mta.value = mta.value + '【从跟读改】';
  mta.dispatchEvent(new window.Event('input', { bubbles: true }));
  mta.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
  await sleep(400);
  const mRow2 = $(`.node-outer[data-node-id="${mirrorId}"] > .node .node-content`).textContent;
  assert(mRow2.includes('【从跟读改】'), '跟读处保存后跟读更新');
  $$('.doc-tab-label')[0].click();
  await sleep(250);
  const srcRow = $(`.node-outer[data-node-id="${sourceNodeId}"] > .node .node-content`).textContent;
  assert(srcRow.includes('【从跟读改】') && srcRow.includes('【冒烟源改动】'), '源段落就是同一份（两边收敛）');

  // ---- 公开改写：先出卡片不改正文；在跟读处收下后，源与跟读统一 ----
  const proposeBtn = [...$$(`.node-outer[data-node-id="${sourceNodeId}"] > .node .node-actions button`)]
    .find((b) => b.textContent === '提改写');
  assert(!!proposeBtn, '源段落操作条有「提改写」');
  proposeBtn.click();
  await sleep(100);
  assert(!$('#suggestion-mask').classList.contains('hidden'), '提出改写弹窗打开');
  $('#suggestion-content').value = srcRow + '【冒烟提议收下】';
  $('#suggestion-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(300);
  assert($('#suggestion-mask').classList.contains('hidden'), '提交后关闭改写弹窗');
  const proposalCard = $(`.node-outer[data-node-id="${sourceNodeId}"] .suggestion-card`);
  assert(!!proposalCard && proposalCard.textContent.includes('【冒烟提议收下】'), '源行出现公开改写卡片');
  assert(
    !$(`.node-outer[data-node-id="${sourceNodeId}"] > .node .node-content`).textContent.includes('【冒烟提议收下】'),
    '收下前正文仍保持原样',
  );

  $$('.doc-tab-label')[1].click();
  await sleep(250);
  const mirrorProposal = $(`.node-outer[data-node-id="${mirrorId}"] .suggestion-card`);
  assert(!!mirrorProposal, '跟读处也能看到同一版公开改写');
  const acceptBtn = [...mirrorProposal.querySelectorAll('button')].find((b) => b.textContent === '收下这版');
  acceptBtn.click();
  await sleep(400);
  const mirrorAccepted = $(`.node-outer[data-node-id="${mirrorId}"] > .node .node-content`).textContent;
  assert(mirrorAccepted.includes('【冒烟提议收下】'), '跟读处收下后跟读正文更新');
  assert(!$(`.node-outer[data-node-id="${mirrorId}"] .suggestion-card`), '收下后跟读处改写卡片消失');

  $$('.doc-tab-label')[0].click();
  await sleep(250);
  const sourceAccepted = $(`.node-outer[data-node-id="${sourceNodeId}"] > .node .node-content`).textContent;
  assert(sourceAccepted.includes('【冒烟提议收下】'), '收下后源正文也是同一版');
  assert(!$(`.node-outer[data-node-id="${sourceNodeId}"] .suggestion-card`), '收下后源行改写卡片消失');

  // 我仍开着编辑器打字时，别人收下另一版：当前 textarea 必须立即换成定稿
  const editAgainBtn = [...$$(`.node-outer[data-node-id="${sourceNodeId}"] > .node .node-actions button`)]
    .find((b) => b.textContent === '编辑');
  editAgainBtn.click();
  await sleep(200);
  const liveEditor = $('#outline textarea');
  assert(!!liveEditor, '源段落再次进入编辑态');
  liveEditor.value = liveEditor.value + '【我本机还在打的字】';
  liveEditor.dispatchEvent(new window.Event('input', { bubbles: true }));

  await new Promise((resolve, reject) => {
    const other = new WS(`ws://127.0.0.1:${PORT}/ws`);
    let started = false;
    let pendingText = '';
    other.on('open', () => {
      other.send(JSON.stringify({ type: 'hello', userId: 'u-other-proposal', userName: '旁边的人' }));
    });
    other.on('error', reject);
    other.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'snapshot' && !started) {
        started = true;
        const node = msg.nodes.find((n) => n.id === sourceNodeId);
        pendingText = node.content + '【旁边人收下的新版】';
        other.send(JSON.stringify({
          type: 'suggestion_add',
          nodeId: sourceNodeId,
          content: pendingText,
          baseVersion: node.version,
        }));
      }
      if (msg.type === 'suggestion_added' && msg.suggestion?.content === pendingText) {
        other.send(JSON.stringify({ type: 'suggestion_accept', suggestionId: msg.suggestion.id }));
        setTimeout(() => { other.close(); resolve(); }, 500);
      }
    });
  });
  await sleep(300);
  const syncedEditor = $('#outline textarea');
  assert(!!syncedEditor, '收下后编辑器保持打开，但内容已同步');
  assert(syncedEditor.value.includes('【旁边人收下的新版】'), '编辑器里是刚收下的新版正文');
  assert(!syncedEditor.value.includes('【我本机还在打的字】'), '未保存的本机输入不再盖住已收下的正文');
  syncedEditor.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await sleep(200);

  // ---- 删除源段落 -> 跟读墓碑，不显示旧正文 ----
  const editBtn2 = [...$$(`.node-outer[data-node-id="${sourceNodeId}"] > .node .node-actions button`)]
    .find((b) => b.textContent === '编辑');
  editBtn2.click();
  await sleep(200);
  const delBtn = [...$$('.edit-tools button')].find((b) => b.textContent === '删除');
  assert(!!delBtn, '源行编辑器里有删除按钮（跟读编辑器没有结构工具）');
  delBtn.click();
  await sleep(400);
  $$('.doc-tab-label')[1].click();
  await sleep(300);
  const tomb = $(`.node-outer[data-node-id="${mirrorId}"] .mirror-tombstone`);
  assert(!!tomb, '源删除后跟读变成墓碑');
  assert(!$(`.node-outer[data-node-id="${mirrorId}"]`).textContent.includes('【冒烟源改动】'), '墓碑不显示旧正文');
  assert($(`.node-outer[data-node-id="${mirrorId}"]`).textContent.includes('源段落已被删除'), '墓碑文案明确');

  // ---- 跳转：墓碑上仍有「打开源大纲」 ----
  const jumpBtn = [...$$(`.node-outer[data-node-id="${mirrorId}"] .node-actions button`)]
    .find((b) => b.textContent.includes('打开源大纲'));
  assert(!!jumpBtn, '墓碑仍可一跳去源大纲');

  // 活着的跟读上的跳转（新挂一个）：跨文档跳转 + 定位 + 直接进编辑
  // 选另一个顶层种子段挂跟读
  $$('.doc-tab-label')[0].click();
  await sleep(250);
  const roots = $$('#outline > .node-outer');
  const secondId = roots[0]?.dataset.nodeId;
  if (secondId) {
    const btn = [...$$(`.node-outer[data-node-id="${secondId}"] > .node .node-actions button`)]
      .find((b) => b.textContent.includes('挂跟读'));
    btn.click();
    await sleep(150);
    $('#mirror-confirm').click();
    await sleep(500);
    const jumpEdit = [...$$('#outline .mirror-node > .node-row .node-actions button')]
      .find((b) => b.textContent.includes('去源大纲编辑'));
    assert(!!jumpEdit, '活跟读有「去源大纲编辑」一键入口');
    jumpEdit.click();
    await sleep(400);
    const hash = new URLSearchParams(window.location.hash.slice(1));
    assert(hash.get('doc') === 'default' && hash.get('node') === secondId, '一跳 hash 指向源文档源段落');
    assert($('#doc-title').textContent.includes('团队共享大纲'), '已切到源大纲');
    assert(!!$('#outline textarea'), '并直接进入源段编辑态');
    const ta2 = $('#outline textarea');
    if (ta2) ta2.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await sleep(200);
  }

  // ---- 段落留言：写留言→行内卡片/徽章→收掉→已收态；取消反悔不发请求 ----
  // 用一条还活着的顶层种子段（默认文档）
  const commentNodeId = roots[1]?.dataset.nodeId || secondId;
  if (commentNodeId) {
    $$('.doc-tab-label')[0].click();
    await sleep(250);
    const cOuter = $(`.node-outer[data-node-id="${commentNodeId}"]`);
    const openComment = () => [...cOuter.querySelectorAll(':scope > .node > .node-row .node-actions button')]
      .find((b) => b.textContent.includes('留言'));
    openComment().click();
    await sleep(150);
    assert(!$('#comment-mask').classList.contains('hidden'), '留言面板打开');
    $('#comment-input').value = '冒烟留言：这里要不要补数据？';
    $('#comment-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await sleep(400);
    assert(cOuter.textContent.includes('冒烟留言：这里要不要补数据？'), '广播回来后行内出现留言卡片');
    assert(cOuter.textContent.includes('未收留言'), '行上出现未收留言徽章');
    assert(openComment().textContent.includes('1/1'), '操作条按钮带未收/总数计数');

    // 另一个连接直接收掉这条（模拟"别人先收"），本界面必须收敛到同一份已收。
    // 该连接在留言发出之后才进房间：从快照的 comments 里取这条 id（历史消息不会重放）。
    await new Promise((resolve, reject) => {
      const other = new WS(`ws://127.0.0.1:${PORT}/ws`);
      let done = false;
      other.on('open', () => other.send(JSON.stringify({ type: 'hello', userId: 'u-other-resolve', userName: '收留言的人' })));
      other.on('error', reject);
      other.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'snapshot' && !done && Array.isArray(msg.comments)) {
          const target = msg.comments.find((c) => c.content?.startsWith('冒烟留言') && c.status === 'open');
          if (target) {
            done = true;
            other.send(JSON.stringify({ type: 'comment_resolve', commentId: target.id, content: '已补数据' }));
            setTimeout(() => { other.close(); resolve(); }, 500);
          }
        }
      });
    });
    await sleep(400);
    assert(cOuter.textContent.includes('已收（收留言的人）'), '本界面收到广播，显示同一份已收');
    assert(cOuter.textContent.includes('收掉时说：已补数据'), '已收说法逐字一致');
    assert(!cOuter.textContent.includes('未收留言'), '未收徽章消失');
    assert(!$(`.node-outer[data-node-id="${commentNodeId}"] .comment-card:not(.resolved)`), '没有开着的留言卡');

    // 再写一条：打开收留言确认窗又取消——留言必须保持开着
    $('#comment-input').value = '第二条：待反悔';
    $('#comment-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await sleep(400);
    const resolveBtn = [...cOuter.querySelectorAll('.comment-card:not(.resolved) .comment-tools button')]
      .find((b) => b.textContent.includes('收掉这条'));
    assert(!!resolveBtn, '新开的留言上有「收掉这条」');
    resolveBtn.click();
    await sleep(150);
    assert(!$('#comment-resolve-mask').classList.contains('hidden'), '收留言确认弹窗打开');
    $('#cr-note').value = '打了字但反悔';
    $('#comment-resolve-cancel').click();
    await sleep(150);
    assert($('#comment-resolve-mask').classList.contains('hidden'), '取消后弹窗关闭');
    const stillOpen = $(`.node-outer[data-node-id="${commentNodeId}"] .comment-card:not(.resolved)`);
    assert(!!stillOpen && stillOpen.textContent.includes('第二条：待反悔'), '反悔后留言仍是上一份开着的样子');
    assert(!cOuter.textContent.includes('打了字但反悔'), '没点确认，说法没有任何泄露');
    $('#comment-cancel').click();
    await sleep(50);
  }

  // ---- 可捞名单：删除进名单（带计数）→ 打开名单 → 取消不发请求 → 确认捞回原位 ----
  $$('.doc-tab-label')[0].click();
  await sleep(250);
  // 选一个此前提早缓存好的顶层段（roots 是删除操作前缓存的，含 n1/n4 等）
  const trashTargetId = roots[1]?.dataset.nodeId || roots[0]?.dataset.nodeId || null;
  if (trashTargetId) {
    const beforeCountText = $('#trash-count').classList.contains('hidden')
      ? '0' : $('#trash-count').textContent;
    const beforeCount = Number(beforeCountText || 0);
    const tOuter = $(`.node-outer[data-node-id="${trashTargetId}"]`);
    // 删除（confirm 已被桩成 true）
    const delTarget = [...tOuter.querySelectorAll(':scope > .node > .node-row .node-actions button')]
      .find((b) => b.textContent.trim() === '编辑');
    delTarget.click();
    await sleep(200);
    const editorDel = [...$$('.edit-tools button')].find((b) => b.textContent === '删除');
    editorDel.click();
    await sleep(500);
    assert(!$(`.node-outer[data-node-id="${trashTargetId}"]`), '删除后该段从树里消失');
    assert(!$('#trash-count').classList.contains('hidden'), '顶栏捞回计数出现');
    assert(Number($('#trash-count').textContent) === beforeCount + 1, '名单计数 +1（全员同一份）');

    $('#trash-btn').click();
    await sleep(150);
    assert(!$('#trash-panel').classList.contains('hidden'), '可捞名单抽屉打开');
    const cards = $$('#trash-list .trash-card');
    assert(cards.length >= 1, '名单里至少有刚删的这批');

    // 打开确认窗又取消：树保持拿掉的样子，段没有回来
    cards[0].querySelector('.restore-trash-btn').click();
    await sleep(150);
    assert(!$('#restore-mask').classList.contains('hidden'), '捞回确认弹窗打开，能看到删前原文');
    assert($('#restore-quote').value.length >= 0, '弹窗展示删前原文');
    $('#restore-cancel').click();
    await sleep(150);
    assert($('#restore-mask').classList.contains('hidden'), '取消后弹窗关闭');
    assert(!$(`.node-outer[data-node-id="${trashTargetId}"]`), '取消后树仍是拿掉的样子（没发 restore）');

    // 重新打开并确认捞回：段回到树上
    $('#trash-btn').click();
    await sleep(100);
    $$('#trash-list .trash-card')[0].querySelector('.restore-trash-btn').click();
    await sleep(100);
    $('#restore-confirm-btn').click();
    await sleep(600);
    assert(!!$(`.node-outer[data-node-id="${trashTargetId}"]`), '确认捞回后段回到树上');
    $('#trash-close').click();
    await sleep(50);
  }

  // ---- 关闭一个标签页（保留至少一个）----
  await sleep(100);
  const closeBtns = $$('.doc-tab-close');
  if (closeBtns.length) closeBtns[closeBtns.length - 1].click();
  await sleep(250);
  assert($$('.doc-tab').length >= 1, '关掉一个标签后仍有标签');

  await sleep(100);
  assert(errors.length === 0, '整个流程无未捕获前端错误：' + (errors.join('; ') || '（无）'));

  serverMod.server.close();
  console.log(`\n${failures ? '❌ 冒烟有失败项' : '客户端冒烟全部通过 ✅'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('冒烟脚本崩溃:', e);
  process.exit(1);
});
