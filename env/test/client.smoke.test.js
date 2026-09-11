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
