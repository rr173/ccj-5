'use strict';

// 客户端冒烟（整份时间轴）：jsdom 加载真实 index.html + app.js，
// 走"改内容 → 加段落 → 开时间轴 → 回到旧时刻 → 从该时刻接着改 → 回到现在"。
// 运行：node test/client.timetravel.smoke.test.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
process.env.DB_FILE = './data/smoke-tt.db';
for (const f of ['./data/smoke-tt.db', './data/smoke-tt.db-wal', './data/smoke-tt.db-shm']) {
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
  const serverMod = require('../server/index');
  const PORT = 3792;
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
  window.confirm = () => true;

  const errors = [];
  window.addEventListener('error', (e) => errors.push(e.error?.message || String(e.message)));

  window.eval(appJs);
  const $ = (sel) => window.document.querySelector(sel);
  const $$ = (sel) => [...window.document.querySelectorAll(sel)];

  // ---- 登录 ----
  $('#name-input').value = '回看用户';
  $('#login-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(500);
  const seedOuters = $$('#outline .node-outer').length;
  assert(seedOuters === 5, `种子 5 段全部渲染（实际 ${seedOuters}）`);

  // ---- 改一段内容（产生"旧时刻"之后的新版本）----
  const n5outer = $('.node-outer[data-node-id="n5"]');
  const editBtn = [...n5outer.querySelectorAll('.node-actions button')].find((b) => b.textContent === '编辑');
  editBtn.click();
  await sleep(200);
  let ta = $('#outline textarea');
  ta.value = '冒烟改过的正文';
  ta.dispatchEvent(new window.Event('input', { bubbles: true }));
  ta.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
  await sleep(400);
  assert(
    $('.node-outer[data-node-id="n5"] .node-content').textContent === '冒烟改过的正文',
    '段落已保存为新版本',
  );

  // ---- 再加一个顶层段落（"现在这条线"上的结构变化）----
  $('#add-root').click();
  await sleep(400);
  assert($$('#outline .node-outer').length === 6, '新段落出现（共 6 段）');

  // ---- 打开时间轴：事件齐全 ----
  $('#timeline-btn').click();
  await sleep(300);
  assert(!$('#timeline-panel').classList.contains('hidden'), '时间轴抽屉打开');
  const cards = $$('#timeline-list .tl-card');
  assert(cards.length >= 8, `时间轴至少有 7 个事件 + 现在（实际 ${cards.length}）`);
  assert(cards[0].textContent.includes('现在'), '第一张是「现在」');
  assert(cards.some((c) => c.textContent.includes('冒烟改过的正文')), '列表里有刚才的修改事件');

  // ---- 回到最早的时刻（seq=1：只有第一段，还没有子级）----
  cards[cards.length - 1].querySelector('.tl-jump').click();
  await sleep(400);
  assert(!$('#tt-banner').classList.contains('hidden'), '回看横幅出现');
  assert($('#tt-banner').textContent.includes('时刻 #1'), '横幅显示时刻 #1');
  assert($$('#outline .node-outer').length === 1, '时刻 #1 只有第一段（子级还没创建）');
  assert($('#outline .node-content').textContent.includes('项目目标'), '当时正文正确');
  assert($$('#outline .node-actions').length === 0, '回看里没有编辑/结构按钮（只读）');
  assert($('#add-root').disabled, '回看时禁止加顶层段落');
  assert($$('#outline .tt-actions button').length === 1, '当时段落带「从此刻继续编辑」');

  // ---- 回到现在 ----
  $('#tt-exit').click();
  await sleep(300);
  assert($('#tt-banner').classList.contains('hidden'), '退出回看后横幅消失');
  assert($$('#outline .node-outer').length === 6, '实时树恢复（后台一直在收更新）');
  assert(!$('#add-root').disabled, '恢复可加顶层段落');

  // ---- 回到"改完正文、还没加新段"的时刻 ----
  $('#timeline-btn').click();
  await sleep(300);
  const editCard = $$('#timeline-list .tl-card')
    .find((c) => c.textContent.includes('修改') && c.textContent.includes('冒烟改过的正文'));
  assert(!!editCard, '找到那次修改的时刻卡片');
  editCard.querySelector('.tl-jump').click();
  await sleep(400);
  assert($$('.node-outer[data-node-id="n5"]').length === 1, 'n5 在当时的树里');
  assert(
    $('.node-outer[data-node-id="n5"] .node-content').textContent === '冒烟改过的正文',
    'n5 显示当时的正文',
  );
  assert($$('#outline .node-outer').length === 5, '后加的第 6 段当时不存在');

  // ---- 从这个时刻接着改：另开一条线 ----
  $('.node-outer[data-node-id="n5"] .tt-actions button').click();
  await sleep(400);
  assert($('#tt-banner').classList.contains('hidden'), '接着改时自动退出回看');
  ta = $('#outline textarea');
  assert(!!ta, '进入编辑态');
  assert(ta.value === '冒烟改过的正文', '草稿 = 该时刻的正文');
  assert($('#outline .edit-status').textContent.includes('从历史'), '状态行标明从历史继续编辑');
  ta.value = '冒烟改过的正文【从旧时刻接着写】';
  ta.dispatchEvent(new window.Event('input', { bubbles: true }));
  ta.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
  await sleep(500);
  assert(!$('#outline textarea'), '保存后退出编辑态');
  assert(
    $('.node-outer[data-node-id="n5"] .node-content').textContent.includes('【从旧时刻接着写】'),
    '新线内容落库并显示',
  );

  await sleep(100);
  assert(errors.length === 0, '整个流程无未捕获前端错误：' + (errors.join('; ') || '（无）'));

  serverMod.server.close();
  console.log(`\n${failures ? '❌ 冒烟有失败项' : '整份时间轴客户端冒烟全部通过 ✅'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('冒烟脚本崩溃:', e);
  process.exit(1);
});
