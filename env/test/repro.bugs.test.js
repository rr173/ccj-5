'use strict';

// 用户反馈的两个 bug 的 UI 级复现（双 jsdom 窗口 + 真实 WS 服务）：
//   A. 空等后跟读侧占用提示不消失（源侧正常）
//   B. 一人改源、一人从跟读改同一处，跟读侧误以为保存成功、内容却是对方的
// 运行：node test/repro.bugs.test.js

process.env.WS_PORT = '3793';
process.env.WS_PING_MS = '60000';
process.env.DB_FILE = './data/repro.db';
process.env.LOCK_TTL_MS = '30000';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
for (const f of ['./data/repro.db', './data/repro.db-wal', './data/repro.db-shm']) {
  try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
}

const { JSDOM } = require('jsdom');
const assert = require('assert');
const WS = require('ws');
const serverMod = require('../server/index');

const PORT = 3793;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeUser(name, userId) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
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

  // 用固定 userId（必须在 hello 之前写入）
  window.localStorage.setItem('outline.userId', userId);
  $('#name-input').value = name;
  $('#login-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  await sleep(500);

  return {
    window, $, $$, errors,
    name,
    async newDoc(title) {
      $('#new-doc-btn').click();
      await sleep(50);
      $('#newdoc-title').value = title;
      $('#newdoc-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      await sleep(400);
    },
    async openDocTab(title) {
      const label = [...$$('.doc-tab-label')].find((l) => l.textContent.includes(title));
      label.click();
      await sleep(250);
    },
    firstRowId() {
      return $('#outline > .node-outer').dataset.nodeId;
    },
    rowText(nodeId) {
      return $(`.node-outer[data-node-id="${nodeId}"] > .node .node-content`)?.textContent || '';
    },
    hasLockBadge(nodeId) {
      return $$(`.node-outer[data-node-id="${nodeId}"] .lock-badge`).length > 0;
    },
    editorLockLine() {
      return $('.lock-state')?.textContent || '';
    },
    async attachMirrorToFirst(targetTitle) {
      const src = this.firstRowId();
      const btn = [...$$(`.node-outer[data-node-id="${src}"] .node-actions button`)]
        .find((b) => b.textContent.includes('挂跟读'));
      btn.click();
      await sleep(80);
      // 选中目标大纲并确认
      const opt = [...$$('#mirror-doc-select option')].find((o) => o.textContent.includes(targetTitle));
      $('#mirror-doc-select').value = opt.value;
      $('#mirror-confirm').click();
      await sleep(400);
      return { src, mirror: $('#outline .node.mirror-node').dataset.nodeId };
    },
    async beginEditOn(nodeId) {
      const btn = [...$$(`.node-outer[data-node-id="${nodeId}"] .node-actions button`)]
        .find((b) => b.textContent === '编辑');
      btn.click();
      await sleep(200);
    },
    async saveEdit() {
      const ta = $('#outline textarea');
      ta.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
      await sleep(400);
    },
    setDraft(text) {
      const ta = $('#outline textarea');
      ta.value = text;
      ta.dispatchEvent(new window.Event('input', { bubbles: true }));
    },
    draft() {
      return $('#outline textarea')?.value ?? null;
    },
    hasConflictDialog() {
      return !$('#conflict-mask').classList.contains('hidden');
    },
    hasEditor() {
      return !!$('#outline textarea');
    },
    async close() {
      window.close();
    },
  };
}

async function main() {
  await new Promise((r) => serverMod.server.listen(PORT, r));
  const failures = [];
  function check(cond, msg) {
    if (cond) console.log('  ✓ ' + msg);
    else { failures.push(msg); console.error('  ✗ ' + msg); }
  }

  // 用户 A 拥有默认大纲首段；用户 B 另开一份大纲并把该段挂为跟读
  const A = await makeUser('改源的人', 'u-src');
  const B = await makeUser('跟读的人', 'u-mir');
  await sleep(200);

  await B.newDoc('跟读文档');
  await B.openDocTab('团队共享大纲');
  const { src, mirror } = await B.attachMirrorToFirst('跟读文档');
  // 挂完 B 在跟读文档；A 留在源文档
  await sleep(100);

  const baseText = B.rowText(mirror);

  // ============ BUG A：空等后跟读侧占用提示不消失 ============
  console.log('\n— Bug A：空等释放占用 —');
  await B.beginEditOn(mirror);
  await sleep(300);
  check(/你正占用/.test(B.editorLockLine()), '跟读侧编辑时编辑器显示"你正占用此段"');

  // A 侧（源文档）应看到 B 的占用
  await sleep(150);
  check(A.hasLockBadge(src), '源侧看到跟读编辑者的占用');

  // 模拟"人开着页面但好一会儿没动"：把锁拨过期，触发服务端 TTL sweep
  serverMod.locks.locks.get(src).at = Date.now() - 60_000;
  serverMod.sweepAndBroadcast();
  await sleep(400);

  // 源侧：占用消失（用户说这一侧是好的）
  check(!A.hasLockBadge(src), 'A 源侧：TTL 后占用提示消失');
  // 跟读侧：占用也必须消失 —— bug：编辑器内仍显示"你正占用此段"
  check(!/你正占用/.test(B.editorLockLine()), 'B 跟读侧：TTL 后编辑器内占用状态同步消失（不继续挂着）');
  check(!B.hasLockBadge(mirror), 'B 跟读侧：行上不再有占用徽标');

  // ============ BUG B：两人改同一处，跟读侧不能"假装成功" ============
  console.log('\n— Bug B：源/跟读同一处并发 —');
  // 重新让 B 在跟读上进入编辑（基于当前版本）
  if (!B.hasEditor()) await B.beginEditOn(mirror);
  await sleep(100);
  // A 也在源上进入编辑
  await A.beginEditOn(src);
  await sleep(100);

  const latest = serverMod.db.prepare('SELECT version, content FROM revisions WHERE node_id = ? ORDER BY version DESC LIMIT 1').get(src);
  const v = latest.version;
  const original = latest.content;

  // A 先保存（句尾追加 A 的字）
  A.setDraft(original + '【源侧的字】');
  await A.saveEdit();
  await sleep(200);
  check(A.rowText(src).includes('【源侧的字】'), '源侧保存成功，大家收到源的字');
  await sleep(200);

  // B 从跟读、基于旧版本 v，在同一句尾追加 B 的字（与 A 同一插入点）
  B.setDraft(original + '【跟读侧的字】');
  await B.saveEdit();
  await sleep(400);

  const serverNow = serverMod.db.prepare('SELECT version, content FROM revisions WHERE node_id = ? ORDER BY version DESC LIMIT 1').get(src);
  console.log('    服务器当前内容:', JSON.stringify(serverNow.content));
  console.log('    B 冲突窗是否打开:', B.hasConflictDialog(), ' B 编辑器是否还在:', B.hasEditor());

  // 必须弹冲突，而不是 saved/merge_notice
  check(B.hasConflictDialog(), '跟读侧改到同一处：必须收到 conflict 弹窗，不能静默"成功"');
  check(!serverNow.content.includes('【跟读侧的字】'), '服务器保留源侧的字，跟读侧的覆盖未被静默接受');
  check(serverNow.content.includes('【源侧的字】'), '大家看到的是源侧的字');

  if (!failures.length) {
    console.log('\n复现脚本全部断言通过（即 bug 已修复）✅');
  } else {
    console.log(`\n复现到 ${failures.length} 个问题：\n - ${failures.join('\n - ')}`);
  }
  serverMod.server.close();
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error('复现脚本崩溃:', e);
  process.exit(2);
});
