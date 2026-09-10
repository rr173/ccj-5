'use strict';

// Bug A 精确复现：旁观者视角。
//  B 在跟读行点编辑（持锁）；A 盯着源文档；C 盯着跟读文档。
//  空等触发服务端 TTL 回收后，A、C 看到的"XX 正在编辑"提示都必须自己消失，
//  且无需任何人再点编辑。
// 运行：node test/repro.lock.ui.test.js

process.env.WS_PORT = '3799';
process.env.WS_PING_MS = '60000';
process.env.DB_FILE = './data/reprolock.db';
process.env.LOCK_TTL_MS = '30000';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
for (const f of ['./data/reprolock.db', './data/reprolock.db-wal', './data/reprolock.db-shm']) {
  try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
}

const { JSDOM } = require('jsdom');
const WS = require('ws');
const serverMod = require('../server/index');

const PORT = 3799;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function user(name, userId) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const dom = new JSDOM(html, {
    url: `http://127.0.0.1:${PORT}/`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.WebSocket = WS;
  Object.defineProperty(window, 'crypto', { value: crypto.webcrypto, configurable: true, writable: true });
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.confirm = () => true;
  window.localStorage.setItem('outline.userId', userId);

  const errors = [];
  window.addEventListener('error', (e) => errors.push(e.error?.message || String(e.message)));
  window.eval(appJs);
  const $ = (s) => window.document.querySelector(s);
  const $$ = (s) => [...window.document.querySelectorAll(s)];

  $('#name-input').value = name;
  $('#login-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(400);

  return {
    window, $, $$, errors,
    async newDoc(t) {
      $('#new-doc-btn').click(); await sleep(40);
      $('#newdoc-title').value = t;
      $('#newdoc-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      await sleep(400);
    },
    async openDoc(title) {
      // 已在标签页就切过去；否则用选择器
      let label = [...$$('.doc-tab-label')].find((l) => l.textContent.includes(title));
      if (!label) {
        // 兜底：通过协议打开（测试里用户都已 hello 且有 doc_list）
        return false;
      }
      label.click(); await sleep(250); return true;
    },
    first() { return $('#outline > .node-outer').dataset.nodeId; },
    text(id) {
      return $(`.node-outer[data-node-id="${id}"] > .node .node-content`)?.textContent || '';
    },
    otherLockBadge(id) {
      // 行 meta 上"XX 正在编辑…"徽标（别人持锁时才有）
      const els = $$(`.node-outer[data-node-id="${id}"] .lock-badge`);
      return els.map((e) => e.textContent).join('|');
    },
    rowClasses(id) {
      return $(`.node-outer[data-node-id="${id}"] > .node`)?.className || '';
    },
    async attachFirstAsMirror(targetDocTitle) {
      const src = this.first();
      [...$$(`.node-outer[data-node-id="${src}"] .node-actions button`)]
        .find((b) => b.textContent.includes('挂跟读')).click();
      await sleep(80);
      const opt = [...$$('#mirror-doc-select option')].find((o) => o.textContent.includes(targetDocTitle));
      $('#mirror-doc-select').value = opt.value;
      $('#mirror-confirm').click();
      await sleep(400);
      return { src, mirror: $('#outline .node.mirror-node').dataset.nodeId };
    },
    async edit(id) {
      [...$$(`.node-outer[data-node-id="${id}"] .node-actions button`)]
        .find((b) => b.textContent === '编辑').click();
      await sleep(250);
    },
    async openDocByProtocol(title) {
      // 通过 app 内部不可见；改为点击标签。若没有标签则新建订阅不可行，
      // 因此旁观者 C 需要先由自己 create/join —— 见脚本里用 open_doc 注入。
    },
    sendRaw(obj) {
      // 直接用页面里的 ws 不行（闭包内）；测试通过服务端房间安排让 C 已订阅。
      return obj;
    },
  };
}

async function main() {
  await new Promise((r) => serverMod.server.listen(PORT, r));
  const failures = [];
  const check = (cond, msg) => {
    if (cond) console.log('  ✓ ' + msg);
    else { failures.push(msg); console.error('  ✗ ' + msg); }
  };

  // A 拥有源段落；B 建跟读文档并把 A 的首段挂进去
  const A = await user('源文档的人', 'u-a');
  const src = A.first();

  const B = await user('挂跟读的人', 'u-b');
  await B.newDoc('跟读文档');
  await B.openDoc('团队共享大纲');
  const { mirror } = await B.attachFirstAsMirror('跟读文档');
  await sleep(100);
  // 挂完 B 自动跳到跟读文档

  // C：第三个旁观者，盯着跟读文档。
  // C 登录后默认打开 default，再切到跟读文档前需要它出现在 doc_list（已广播）。
  const C = await user('跟读旁观者', 'u-c');
  await sleep(200);
  // C 的标签里现在只有 default；通过点击"新大纲"不行——我们需要打开已存在的跟读文档。
  // UI 没有"打开已有大纲"的入口（只有新建），所以这里用 hash 路由打开。
  const docRow = serverMod.db.prepare("SELECT id FROM documents WHERE title='跟读文档'").get();
  C.window.location.hash = `#doc=${docRow.id}`;
  C.window.dispatchEvent(new C.window.Event('hashchange'));
  await sleep(500);

  console.log('C 当前标签:', [...C.$$('.doc-tab-label')].map((l) => l.textContent));
  console.log('C 看到跟读行:', !!C.$(`.node-outer[data-node-id="${mirror}"]`));

  // B 在跟读行点编辑，A/C 都应看到"B 正在编辑"
  await B.edit(mirror);
  await sleep(300);

  check(/正在编辑/.test(A.otherLockBadge(src)), 'TTL 前：源文档旁观者 A 看到 B 的占用');
  check(/正在编辑/.test(C.otherLockBadge(mirror)), 'TTL 前：跟读文档旁观者 C 看到 B 的占用');
  check(C.rowClasses(mirror).includes('locked-by-other'), 'C 的跟读行带 locked-by-other 高亮');

  // 空等：模拟 B 心跳停止、服务端 TTL 到期
  serverMod.locks.locks.get(src).at = Date.now() - 60_000;
  serverMod.sweepAndBroadcast();
  await sleep(500);

  check(!serverMod.locks.locks.has(src), '服务端已回收锁（别人此刻能点进去）');
  check(!/正在编辑/.test(A.otherLockBadge(src)), '源文档：占用提示随 TTL 自己消失');
  check(!/正在编辑/.test(C.otherLockBadge(mirror)), '跟读文档：占用提示随 TTL 自己消失（不靠再点编辑）');
  check(!C.rowClasses(mirror).includes('locked-by-other'), 'C 的跟读行去掉 locked-by-other 高亮');

  if (!failures.length) console.log('\n锁提示回收：全部正常 ✅');
  else console.log(`\n${failures.length} 个问题：\n - ${failures.join('\n - ')}`);
  serverMod.server.close();
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
