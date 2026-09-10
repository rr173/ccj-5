'use strict';

/* ================= 常量与全局状态 ================= */

const HEARTBEAT_MS = 8000;      // 编辑期间续租锁
const APP_KEEPALIVE_MS = 20000; // 非编辑期连接保活
const IDLE_RELEASE_MS = 30_000; // 编辑中 30s 无输入：只交锁，不退编辑
const RECONNECT_DELAY = 1200;

// 编辑会话是全局唯一的（同时只能改一段），无论源段落还是某个跟读入口
const edit = {
  sourceId: null,       // 被编辑的源段落 id（锁/版本都以它为准）
  entryNodeId: null,    // 编辑入口：源行 id 或某个跟读行 id（决定编辑器渲染在哪）
  docId: null,          // 源段落所在文档
  hasLock: false,
  lockWanted: true,
  baseVersion: 0,
  serverVersion: 0,
  restoreFromVersion: null,
  draft: '',
  saving: false,
  lastInputAt: 0,
};
// 编辑会话之外的孤儿草稿：key = sourceId
const orphanDrafts = new Map();
const pendingConflict = { current: null };

const state = {
  ws: null,
  connected: false,
  me: null,
  docs: new Map(),       // docId -> { id, title, treeRev, updatedAt }
  views: new Map(),      // docId -> { nodes:Map, children:Map, treeRev, title, locks:Set<sourceId> }
  tabs: [],              // 已打开的文档 docId（有序）
  activeDocId: null,
  usersByDoc: new Map(), // docId -> Map(userId -> user)
  historyNodeId: null,
  pendingFocus: null,    // { docId, nodeId, edit?:bool }，快照到达后滚动/进入编辑
  pendingNewDocId: null, // create_doc 后等待快照自动打开的文档
};

const $ = (sel) => document.querySelector(sel);

/* ================= 工具 ================= */

function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'u-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function initials(name) {
  return String(name || '?').trim().slice(0, 2).toUpperCase();
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function cssEscape(s) {
  return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
}

let toastSeq = 0;
function toast(message, kind = '', ms = 2600) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toast-host').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 250);
  }, ms);
  return ++toastSeq;
}

// 跟读行 -> 源 id；普通行 -> 自己
function sourceIdOf(node) {
  return node.kind === 'mirror' ? node.mirrorOf : node.id;
}

function viewOf(docId) {
  return state.views.get(docId);
}

function findRow(nodeId) {
  for (const v of state.views.values()) {
    if (v.nodes.has(nodeId)) return { view: v, node: v.nodes.get(nodeId) };
  }
  return null;
}

// 某个源 id 在各已加载文档里的全部可见行（源行本身 + 跟读行）
function rowsOfSource(sourceId) {
  const out = [];
  for (const view of state.views.values()) {
    const own = view.nodes.get(sourceId);
    if (own) out.push({ view, node: own });
    for (const node of view.nodes.values()) {
      if (node.kind === 'mirror' && node.mirrorOf === sourceId) out.push({ view, node });
    }
  }
  return out;
}

/* ================= 登录 ================= */

function getIdentity() {
  let userId = localStorage.getItem('outline.userId');
  if (!userId) {
    userId = uid();
    localStorage.setItem('outline.userId', userId);
  }
  return userId;
}

$('#login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#name-input').value.trim();
  if (!name) return;
  localStorage.setItem('outline.userName', name);
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  connect(name);
});

(function prefillName() {
  const saved = localStorage.getItem('outline.userName');
  if (saved) $('#name-input').value = saved;
  $('#name-input').focus();
})();

/* ================= hash 路由：一跳进入某份大纲的某段 ================= */

function parseHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const docId = params.get('doc');
  if (!docId) return null;
  return {
    docId,
    nodeId: params.get('node'),
    edit: params.get('edit') === '1',
  };
}

function setHash({ docId, nodeId, edit }) {
  const params = new URLSearchParams();
  params.set('doc', docId);
  if (nodeId) params.set('node', nodeId);
  if (edit) params.set('edit', '1');
  const next = '#' + params.toString();
  if (next !== location.hash) history.replaceState(null, '', next);
}

window.addEventListener('hashchange', async () => {
  if (!state.me) return;
  const route = parseHash();
  if (route) {
    const ok = await ensureOpen(route.docId);
    if (!ok) return;
    activateTab(route.docId);
    state.pendingFocus = { docId: route.docId, nodeId: route.nodeId, edit: route.edit };
    applyPendingFocus();
  }
});

async function ensureOpen(docId) {
  if (!state.docs.has(docId)) {
    // 等文档列表（可能刚 hello）
    for (let i = 0; i < 20 && !state.docs.has(docId); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!state.docs.has(docId)) {
    toast('这份大纲不存在或已被删除', 'error');
    return false;
  }
  if (!state.tabs.includes(docId)) {
    state.tabs.push(docId);
    if (!viewOf(docId)) requestDoc(docId);
  }
  return true;
}

function requestDoc(docId) {
  send({ type: 'open_doc', docId });
}

function activateTab(docId) {
  if (state.activeDocId !== docId) {
    state.activeDocId = docId;
    if (!viewOf(docId)) requestDoc(docId);
    setHash({ docId });
  }
  renderTabs();
  renderActiveDoc();
}

/* ================= WebSocket ================= */

let userNameForReconnect = '';

function connect(name) {
  userNameForReconnect = name;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;
  setConn('connecting');

  ws.addEventListener('open', () => {
    state.connected = true;
    setConn('online');
    send({ type: 'hello', userId: getIdentity(), userName: name });
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleMessage(msg);
  });

  ws.addEventListener('close', () => {
    state.connected = false;
    setConn('offline');
    // 锁随旧连接在服务端释放；编辑会话与草稿保留，重连后重新占用
    edit.hasLock = false;
    for (const v of state.views.values()) {
      v.locks.clear();
      v.lockInfo?.clear(); // 持有者信息一起清，否则断线窗口期徽章残留
    }
    renderActiveDoc();
    setTimeout(() => {
      if (!state.connected) connect(userNameForReconnect);
    }, RECONNECT_DELAY);
  });

  ws.addEventListener('error', () => { /* close 会接管 */ });
}

function send(msg, { quiet = false } = {}) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
    return true;
  }
  if (!quiet) toast('连接已断开，正在重连…（你的内容保留在编辑器里）', 'error');
  return false;
}

setInterval(() => {
  if (state.connected && state.ws && state.ws.readyState === WebSocket.OPEN) {
    send({ type: 'heartbeat' }, { quiet: true });
  }
}, APP_KEEPALIVE_MS);

function setConn(status) {
  const dot = $('#conn-state');
  dot.className = `conn-dot ${status}`;
  dot.title = { online: '已连接', offline: '已断开（自动重连中）', connecting: '连接中' }[status] || status;
}

/* ================= 消息分发 ================= */

function handleMessage(msg) {
  switch (msg.type) {
    case 'hello':
      state.me = msg.user;
      break;
    case 'doc_list':
      ingestDocList(msg.docs);
      break;
    case 'doc_created':
      // 服务器会紧接着下发新文档快照；登记一下，快照到达即打开为标签页
      state.pendingNewDocId = msg.doc.id;
      break;
    case 'snapshot':
      ingestSnapshot(msg);
      break;
    case 'presence':
      if (msg.docId) {
        state.usersByDoc.set(msg.docId, new Map((msg.users || []).map((u) => [u.userId, u])));
        if (msg.docId === state.activeDocId) renderUsers();
      }
      break;
    case 'locked':
      onLocked(msg);
      break;
    case 'lock_acquired':
      onLockAcquired(msg);
      break;
    case 'unlocked':
      onUnlocked(msg);
      break;
    case 'lock_denied':
      onLockDenied(msg);
      break;
    case 'content':
      applyContent(msg);
      break;
    case 'merge_notice':
      toast(msg.message || '已自动合并其他人的修改', 'ok');
      applyContent({
        nodeId: msg.nodeId,
        version: msg.revision.version,
        content: msg.revision.content,
        author: msg.revision.author,
        authorId: msg.revision.author_id,
        updatedAt: msg.revision.created_at,
      }, { silent: true });
      if (edit.saving && edit.sourceId === msg.nodeId) finishSave(msg.nodeId);
      break;
    case 'saved': {
      // 自己保存成功。content 广播不回发本人，这里用回执里的 revision 更新本地
      // （源行与所有跟读行），保证保存者的各标签页也收敛到最终文本。
      if (msg.revision) {
        applyContent({
          nodeId: msg.revision.node_id || msg.nodeId,
          version: msg.revision.version,
          content: msg.revision.content,
          author: msg.revision.author,
          authorId: msg.revision.author_id,
          updatedAt: msg.revision.created_at,
        }, { silent: true, self: true });
      }
      finishSave(msg.revision ? msg.revision.node_id || msg.nodeId : msg.nodeId);
      break;
    }
    case 'conflict':
      edit.saving = false;
      openConflict(msg);
      break;
    case 'history':
      renderHistory(msg);
      break;
    case 'node_added':
      upsertNode(msg.docId, msg.node, msg.treeRev);
      break;
    case 'mirror_added':
      upsertNode(msg.docId, msg.node, msg.treeRev);
      if (msg.by === state.me.userId) {
        // 挂跟读的人：直接切到那份大纲看结果
        if (!state.tabs.includes(msg.docId)) state.tabs.push(msg.docId);
        activateTab(msg.docId);
        state.pendingFocus = { docId: msg.docId, nodeId: msg.node.id };
        flashRow(msg.docId, msg.node.id);
      }
      break;
    case 'node_moved':
      applyMove(msg);
      break;
    case 'nodes_deleted':
      applyDeleted(msg);
      break;
    case 'source_deleted':
      applySourceDeleted(msg);
      break;
    case 'tree_stale':
      toast('树结构刚被别人改过，已为你刷新', 'error');
      // snapshot 紧随其后
      break;
    case 'heartbeat_ack':
      if (msg.ok === false && edit.sourceId === msg.nodeId && edit.hasLock) {
        edit.hasLock = false;
        edit.lockWanted = false;
        patchSource(msg.nodeId);
        toast('占用已自动释放，继续输入可重新占用；保存时会自动合并', '', 3600);
      }
      break;
    case 'error':
      toast(msg.message || '操作失败', 'error');
      break;
  }
}

/* ================= 文档列表与标签页 ================= */

function ingestDocList(docs) {
  const wasEmpty = state.docs.size === 0;
  state.docs = new Map(docs.map((d) => [d.id, d]));
  renderTabs();

  // 重连后：服务端房间随连接清空，需要重新订阅打开着的文档
  if (state.connected) {
    for (const docId of state.tabs) requestDoc(docId);
  }

  // 首次拿到列表：打开默认文档，或 hash 里指定的文档
  if (wasEmpty && state.me) {
    const route = parseHash();
    const firstDoc = route && state.docs.has(route.docId)
      ? route.docId
      : (state.docs.has('default') ? 'default' : docs[0]?.id);
    if (firstDoc) {
      state.tabs = [firstDoc];
      state.activeDocId = firstDoc;
      if (route && route.docId === firstDoc && route.nodeId) {
        state.pendingFocus = { docId: firstDoc, nodeId: route.nodeId, edit: route.edit };
      }
      setHash({ docId: firstDoc });
      renderTabs();
      renderActiveDoc();
    }
  }
}

function renderTabs() {
  const host = $('#doc-tabs');
  host.innerHTML = '';
  for (const docId of state.tabs) {
    const doc = state.docs.get(docId);
    const tab = document.createElement('div');
    tab.className = 'doc-tab' + (docId === state.activeDocId ? ' active' : '');
    const label = document.createElement('span');
    label.className = 'doc-tab-label';
    label.textContent = doc ? doc.title : '加载中…';
    label.addEventListener('click', () => activateTab(docId, { focus: true }));
    tab.appendChild(label);
    if (state.tabs.length > 1) {
      const close = document.createElement('button');
      close.className = 'doc-tab-close';
      close.title = '关闭这个标签页（不删除大纲）';
      close.textContent = '✕';
      close.addEventListener('click', () => closeTab(docId));
      tab.appendChild(close);
    }
    host.appendChild(tab);
  }
}

async function closeTab(docId) {
  if (edit.sourceId && edit.docId === docId) {
    toast('请先保存或取消当前编辑', 'error');
    return;
  }
  const idx = state.tabs.indexOf(docId);
  if (idx < 0) return;
  state.tabs.splice(idx, 1);
  send({ type: 'leave_doc', docId });
  if (state.activeDocId === docId) {
    state.activeDocId = state.tabs[Math.max(0, idx - 1)] || null;
    if (state.activeDocId) {
      activateTab(state.activeDocId);
    } else {
      renderActiveDoc();
    }
  }
  renderTabs();
}

$('#new-doc-btn').addEventListener('click', () => {
  $('#newdoc-title').value = '';
  $('#newdoc-mask').classList.remove('hidden');
  $('#newdoc-title').focus();
});
$('#newdoc-cancel').addEventListener('click', () => $('#newdoc-mask').classList.add('hidden'));
$('#newdoc-mask').addEventListener('click', (e) => {
  if (e.target === $('#newdoc-mask')) $('#newdoc-mask').classList.add('hidden');
});
$('#newdoc-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const title = $('#newdoc-title').value.trim();
  if (!title) return;
  send({ type: 'create_doc', title });
  $('#newdoc-mask').classList.add('hidden');
});

/* ================= 快照与增量 ================= */

function ingestSnapshot(msg) {
  const docId = msg.docId;
  const nodes = new Map(msg.nodes.map((n) => [n.id, n]));
  const children = new Map();
  for (const node of nodes.values()) {
    const key = node.parentId ?? null;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(node.id);
  }
  for (const ids of children.values()) {
    ids.sort((a, b) => {
      const pa = nodes.get(a).pos || '';
      const pb = nodes.get(b).pos || '';
      return pa < pb ? -1 : pa > pb ? 1 : 0;
    });
  }
  state.views.set(docId, {
    nodes,
    children,
    treeRev: msg.treeRev,
    title: msg.title,
    locks: new Set((msg.locks || []).map((l) => l.nodeId)),
    lockInfo: new Map((msg.locks || []).map((l) => [l.nodeId, l])),
  });
  if (state.docs.has(docId)) {
    state.docs.get(docId).title = msg.title;
    state.docs.get(docId).treeRev = msg.treeRev;
  }
  state.usersByDoc.set(docId, new Map((msg.users || []).map((u) => [u.userId, u])));

  if (state.pendingNewDocId === docId) {
    // 新建文档的第一份快照：自动打开为标签页
    state.pendingNewDocId = null;
    if (!state.tabs.includes(docId)) state.tabs.push(docId);
    state.activeDocId = docId;
    setHash({ docId });
  }

  if (!state.tabs.includes(docId)) {
    // 预取完成（选择器等待）
    return;
  }
  renderTabs();
  if (docId === state.activeDocId) {
    renderActiveDoc();
    renderUsers();
  }
  if (state.historyNodeId && nodes.has(state.historyNodeId)) {
    send({ type: 'history', nodeId: state.historyNodeId });
  }

  // 重连后恢复编辑占用（锁在旧连接关闭时已由服务端释放）
  if (edit.sourceId) {
    const src = nodes.get(edit.sourceId);
    if (src) {
      edit.hasLock = false;
      edit.lockWanted = true;
      edit.serverVersion = src.version;
      send({ type: 'lock', nodeId: edit.entryNodeId || edit.sourceId });
    }
  }

  applyPendingFocus();
}

function applyPendingFocus() {
  const f = state.pendingFocus;
  if (!f || f.docId !== state.activeDocId) return;
  const view = viewOf(f.docId);
  if (!view || !view.nodes.has(f.nodeId)) return;
  state.pendingFocus = null;
  setHash({ docId: f.docId, nodeId: f.nodeId, edit: f.edit });
  requestAnimationFrame(() => {
    scrollToRow(f.nodeId);
    flashRow(f.docId, f.nodeId, 2400);
  });
  if (f.edit) {
    const node = view.nodes.get(f.nodeId);
    if (node.kind !== 'mirror' || !node.sourceDeleted) beginEdit(node.id);
  }
}

function scrollToRow(nodeId) {
  const el = document.querySelector(`.node-outer[data-node-id="${cssEscape(nodeId)}"]`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function flashRow(docId, nodeId, ms = 1200) {
  if (docId !== state.activeDocId) return;
  requestAnimationFrame(() => {
    const el = document.querySelector(`.node[data-node-id="${cssEscape(nodeId)}"]`);
    if (!el) return;
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    if (ms !== 1200) setTimeout(() => el.classList.remove('flash'), ms);
  });
}

function upsertNode(docId, node, treeRev) {
  const view = viewOf(docId);
  if (!view) return; // 未订阅该文档（预取视图之外的消息忽略）
  view.nodes.set(node.id, node);
  view.treeRev = treeRev;
  reindex(view);
  if (docId === state.activeDocId) {
    renderOutline();
    flashRow(docId, node.id);
  }
}

function reindex(view) {
  const children = new Map();
  for (const node of view.nodes.values()) {
    const key = node.parentId ?? null;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(node.id);
  }
  for (const ids of children.values()) {
    ids.sort((a, b) => {
      const pa = view.nodes.get(a).pos || '';
      const pb = view.nodes.get(b).pos || '';
      return pa < pb ? -1 : pa > pb ? 1 : 0;
    });
  }
  view.children = children;
}

function applyContent(msg, { silent = false, self = false } = {}) {
  // msg.nodeId 永远是源 id；同步源行与所有跟读行
  const rows = rowsOfSource(msg.nodeId);
  for (const { view, node } of rows) {
    node.version = msg.version;
    node.content = msg.content;
    node.author = msg.author;
    node.authorId = msg.authorId;
    node.updatedAt = msg.updatedAt;
    node.sourceDeleted = 0;
    patchRow(view, node.id);
  }
  if (edit.sourceId === msg.nodeId) {
    edit.serverVersion = msg.version;
    patchSource(msg.nodeId);
  }
  if (!self && state.historyNodeId === msg.nodeId) {
    send({ type: 'history', nodeId: msg.nodeId });
  }
}

function applyMove(msg) {
  const view = viewOf(msg.docId);
  if (!view) return;
  const node = view.nodes.get(msg.nodeId);
  if (!node) return;
  node.parentId = msg.parentId;
  node.pos = msg.pos;
  view.treeRev = msg.treeRev;
  reindex(view);
  if (msg.docId === state.activeDocId) renderOutline();
}

function applyDeleted(msg) {
  const view = viewOf(msg.docId);
  if (!view) return;
  view.treeRev = msg.treeRev;
  for (const id of msg.ids) {
    view.nodes.delete(id);
    view.locks.delete(id);
    view.lockInfo?.delete(id);
  }
  reindex(view);
  if (edit.sourceId && msg.ids.includes(edit.sourceId)) {
    stopEditing('正在编辑的段落已被删除');
  }
  if (msg.docId === state.activeDocId) renderOutline();
}

// 源段落被删：挂在本文档（以及所有宿主文档）的跟读立即变墓碑，
// 绝不再显示旧正文
function applySourceDeleted(msg) {
  for (const sourceId of msg.sourceIds || []) {
    for (const { view, node } of rowsOfSource(sourceId)) {
      node.sourceDeleted = 1;
      delete node.content;
      delete node.version;
      patchRow(view, node.id);
    }
    for (const view of state.views.values()) {
      if (view.locks.has(sourceId)) {
        view.locks.delete(sourceId);
        view.lockInfo?.delete(sourceId);
      }
    }
    if (edit.sourceId === sourceId) stopEditing('跟读的源段落已被删除');
  }
}

/* ================= 锁消息（key 一律为源 id）================= */

function onLocked(msg) {
  for (const { view } of rowsOfSource(msg.nodeId)) {
    view.locks.add(msg.nodeId);
    view.lockInfo.set(msg.nodeId, msg.user);
  }
  patchSource(msg.nodeId);
}

function onLockAcquired(msg) {
  if (edit.sourceId === msg.nodeId) {
    edit.hasLock = true;
    edit.lockWanted = true;
    patchSource(msg.nodeId);
    if (msg.reacquired) toast('已重新占用该段落', 'ok', 1800);
  }
}

function onUnlocked(msg) {
  const wasMine = edit.sourceId === msg.nodeId && edit.hasLock;
  for (const { view } of rowsOfSource(msg.nodeId)) {
    view.locks.delete(msg.nodeId);
    view.lockInfo?.delete(msg.nodeId);
  }
  if (wasMine) {
    edit.hasLock = false;
    edit.lockWanted = false;
    patchSource(msg.nodeId);
    toast(
      msg.reason === 'ttl'
        ? '你有一阵没操作，占用已自动释放，别人现在可以改这段；继续输入会重新占用'
        : msg.reason === 'deleted'
          ? '段落已被删除，占用随之释放'
          : '编辑占用已释放，继续输入会重新占用',
      '', 4200,
    );
  } else {
    patchSource(msg.nodeId);
  }
}

function onLockDenied(msg) {
  if (edit.sourceId === msg.nodeId) {
    edit.hasLock = false;
    edit.lockWanted = false;
    patchSource(msg.nodeId);
    toast(`${msg.holder.userName} 已在编辑这段，你仍可输入；保存时若冲突会让你确认`, '', 4200);
  } else {
    toast(`${msg.holder.userName} 正在编辑这一段`, 'error');
  }
}

/* ================= 渲染：在线用户 ================= */

function renderUsers() {
  const host = $('#users');
  host.innerHTML = '';
  const users = state.usersByDoc.get(state.activeDocId);
  if (!users) return;
  for (const u of users.values()) {
    const chip = document.createElement('span');
    chip.className = 'user-chip';
    chip.title = u.userName;
    chip.innerHTML =
      `<span class="avatar" style="background:${escapeHtml(u.color)}">${escapeHtml(initials(u.userName))}</span>`;
    host.appendChild(chip);
  }
}

/* ================= 渲染：大纲树 ================= */

function renderActiveDoc() {
  const view = viewOf(state.activeDocId);
  const doc = state.docs.get(state.activeDocId);
  $('#doc-title').textContent = view ? view.title : (doc ? doc.title : '协同大纲');
  renderUsers();
  renderOutline();
  $('#add-root').disabled = !state.activeDocId;
  updateEditingHint();
}

function renderOutline() {
  const root = $('#outline');
  root.innerHTML = '';
  const view = viewOf(state.activeDocId);
  if (!view) return;
  const roots = view.children.get(null) || [];
  for (const id of roots) root.appendChild(renderNode(view, id));
}

function renderNode(view, id) {
  const node = view.nodes.get(id);
  const wrap = document.createElement('div');
  wrap.className = 'node-outer';
  wrap.dataset.nodeId = id;
  wrap.appendChild(renderNodeRow(view, node));
  const kids = view.children.get(id);
  if (kids && kids.length) {
    const childWrap = document.createElement('div');
    childWrap.className = 'children';
    for (const cid of kids) childWrap.appendChild(renderNode(view, cid));
    wrap.appendChild(childWrap);
  }
  return wrap;
}

function renderNodeRow(view, node) {
  const sourceId = sourceIdOf(node);
  const isEditingHere =
    edit.sourceId === sourceId && (edit.entryNodeId === node.id || edit.entryNodeId === null);
  const lock = view.lockInfo?.get(sourceId);
  const lockedByMe = (lock && state.me && lock.userId === state.me.userId) ||
    (isEditingHere && edit.hasLock);
  const lockedByOther = !!lock && (!state.me || lock.userId !== state.me.userId);

  const el = document.createElement('div');
  el.className = 'node' + (node.kind === 'mirror' ? ' mirror-node' : '');
  el.dataset.nodeId = node.id;
  if (isEditingHere || lockedByMe) el.classList.add('locked-by-me');
  if (lockedByOther) el.classList.add('locked-by-other');
  if (node.kind === 'mirror' && node.sourceDeleted) el.classList.add('source-gone');

  if (isEditingHere) {
    el.appendChild(renderEditor(node));
    return el;
  }

  const row = document.createElement('div');
  row.className = 'node-row';

  const content = document.createElement('div');
  if (node.kind === 'mirror' && node.sourceDeleted) {
    // 墓碑：明确告诉人"源已经没了"，不展示旧正文
    content.className = 'node-content mirror-tombstone';
    content.innerHTML =
      '<span class="tombstone-mark">🪦</span> 跟读的源段落已被删除' +
      '<div class="tombstone-sub">此处不再显示正文；可打开源大纲查看历史或重新建立跟读</div>';
  } else {
    content.className = 'node-content' + (node.content ? '' : ' placeholder');
    content.textContent = node.content || '（空段落）';
  }
  row.appendChild(content);

  const actions = document.createElement('div');
  actions.className = 'node-actions';
  if (node.kind === 'mirror') {
    if (!node.sourceDeleted) {
      actions.append(
        actionBtn('编辑', () => beginEdit(node.id)),
        actionBtn('↗ 去源大纲编辑', () => jumpToSource(node, { edit: true })),
      );
    } else {
      actions.append(actionBtn('↗ 打开源大纲', () => jumpToSource(node, {})));
    }
    actions.append(
      actionBtn('＋ 同级', () => addNode(node.parentId, node.id)),
      actionBtn('移除跟读', () => removeMirror(node.id), true),
    );
  } else {
    actions.append(
      actionBtn('编辑', () => beginEdit(node.id)),
      actionBtn('＋子级', () => addNode(node.id, null)),
      actionBtn('＋ 同级', () => addNode(node.parentId, node.id)),
      actionBtn('挂跟读', () => openMirrorPicker(node)),
      actionBtn('历史', () => openHistory(node.id)),
    );
  }
  row.appendChild(actions);
  el.appendChild(row);

  // 元信息行
  const meta = document.createElement('div');
  meta.className = 'node-meta';
  if (node.kind === 'mirror') {
    const tag = document.createElement('span');
    tag.className = 'mirror-tag';
    const srcDoc = node.sourceDocId ? state.docs.get(node.sourceDocId) : null;
    tag.textContent = '🔗 跟读自：' + (srcDoc ? srcDoc.title : '另一份大纲');
    if (!node.sourceDeleted) {
      tag.classList.add('mirror-tag-link');
      tag.title = '点此跳到源大纲';
      tag.addEventListener('click', () => jumpToSource(node, {}));
    }
    meta.appendChild(tag);
  }
  const versionTag = document.createElement('span');
  versionTag.className = 'version-tag';
  versionTag.textContent = `v${node.version ?? '—'}`;
  meta.appendChild(versionTag);
  if (node.author && !node.sourceDeleted) {
    const tag = document.createElement('span');
    tag.className = 'muted';
    tag.textContent = `最后修改：${node.author} · ${fmtTime(node.updatedAt)}`;
    meta.appendChild(tag);
  }
  if (lockedByOther) {
    const badge = document.createElement('span');
    badge.className = 'lock-badge';
    badge.innerHTML =
      `<span class="avatar small" style="background:${escapeHtml(lock.color)}">` +
      `${escapeHtml(initials(lock.userName))}</span> ${escapeHtml(lock.userName)} 正在编辑…`;
    meta.appendChild(badge);
  }
  if (lockedByMe) {
    const badge = document.createElement('span');
    badge.className = 'lock-badge';
    badge.textContent = '你正在编辑';
    meta.appendChild(badge);
  }
  el.appendChild(meta);
  return el;
}

function actionBtn(label, onClick, danger = false) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (danger) b.classList.add('danger-text');
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

/* 局部补丁：源段落变了，把所有挂载点（源行 + 跟读行）的 DOM 换掉 */
function patchSource(sourceId) {
  for (const { view, node } of rowsOfSource(sourceId)) patchRow(view, node.id);
  // 编辑器正开在这段上：占用/版本提示也要跟着锁消息变（跟读入口同样生效），
  // 不能等下次点编辑才对上号
  if (edit.sourceId === sourceId) patchEditorStatus();
  updateEditingHint();
}

// 只刷新编辑器里的状态行，textarea 不动（patchRow 会跳过编辑入口行）
function patchEditorStatus() {
  const el = document.querySelector('.node-edit .edit-status');
  if (el) el.innerHTML = editorStatusHtml();
}

function patchRow(view, nodeId) {
  if (edit.entryNodeId === nodeId) return; // 编辑器自己管内容，不重绘
  const outer = document.querySelector(`.node-outer[data-node-id="${cssEscape(nodeId)}"]`);
  if (!outer) return;
  const node = view.nodes.get(nodeId);
  if (!node) return;
  const fresh = renderNodeRow(view, node);
  const old = outer.querySelector(':scope > .node');
  if (old) old.replaceWith(fresh);
}

/* ================= 跳转源大纲 ================= */

async function jumpToSource(node, { edit = false } = {}) {
  if (!node.sourceDocId) {
    toast('源所在的大纲信息缺失', 'error');
    return;
  }
  const ok = await ensureOpen(node.sourceDocId);
  if (!ok) return;
  activateTab(node.sourceDocId);
  if (node.sourceDeleted) {
    // 源段落已删：只把那份大纲打开；历史里仍可回看
    toast('源段落已在源大纲中被删除（软删，历史仍保留）', '', 4000);
    return;
  }
  state.pendingFocus = { docId: node.sourceDocId, nodeId: node.mirrorOf, edit };
  // 源文档视图可能还没到
  if (!viewOf(node.sourceDocId)) requestDoc(node.sourceDocId);
  applyPendingFocus();
}

/* ================= 编辑器与锁 ================= */

let heartbeatTimer = null;

function beginEdit(nodeId) {
  if (edit.sourceId) {
    toast('请先保存或取消当前编辑', 'error');
    return;
  }
  const found = findRow(nodeId);
  if (!found) return;
  const { node } = found;
  if (node.kind === 'mirror' && node.sourceDeleted) {
    toast('源段落已删除，不能再编辑', 'error');
    return;
  }
  const sourceId = sourceIdOf(node);
  const sourceRow = rowsOfSource(sourceId).find((r) => r.node.kind !== 'mirror')?.node;
  const lockHolder = [...state.views.values()]
    .map((v) => v.lockInfo?.get(sourceId))
    .find(Boolean);
  if (lockHolder && state.me && lockHolder.userId !== state.me.userId) {
    toast(`${lockHolder.userName} 正在编辑这一段，稍候再试`, 'error');
    return;
  }

  edit.sourceId = sourceId;
  edit.entryNodeId = nodeId;
  edit.docId = findDocOfNode(sourceId);
  edit.baseVersion = sourceRow ? sourceRow.version : node.version;
  edit.serverVersion = sourceRow ? sourceRow.version : node.version;
  edit.restoreFromVersion = null;
  edit.hasLock = false;
  edit.lockWanted = true;
  edit.saving = false;

  const orphan = orphanDrafts.get(sourceId);
  if (orphan) {
    edit.draft = orphan;
    orphanDrafts.delete(sourceId);
    toast('已恢复你未保存的草稿，保存时会与服务器版本自动合并', 'ok', 3600);
  } else {
    edit.draft = sourceRow ? sourceRow.content || '' : node.content || '';
  }
  edit.lastInputAt = Date.now();

  // 编辑器渲染在入口行；入口若在别的标签页先切过去
  const entryDocId = [...state.views.entries()]
    .find(([, v]) => v.nodes.has(nodeId))?.[0];
  if (entryDocId && entryDocId !== state.activeDocId) activateTab(entryDocId);
  renderOutline();
  send({ type: 'lock', nodeId }); // 服务器自行把跟读 id 解析成源锁
  focusEditor(nodeId);
  startLockTimers(nodeId);
  updateEditingHint();
}

function findDocOfNode(nodeId) {
  for (const [docId, view] of state.views) {
    const n = view.nodes.get(nodeId);
    if (n && n.kind !== 'mirror') return docId;
  }
  return state.activeDocId;
}

function focusEditor(nodeId) {
  const ta = document.querySelector(`.node[data-node-id="${cssEscape(nodeId)}"] textarea`);
  if (ta) {
    ta.focus();
    const len = ta.value.length;
    ta.setSelectionRange(len, len);
  }
}

function isMirrorEntry() {
  return edit.entryNodeId && edit.entryNodeId !== edit.sourceId;
}

function renderEditor(node) {
  const box = document.createElement('div');
  box.className = 'node-edit';
  box.style.padding = '8px 10px';

  const ta = document.createElement('textarea');
  ta.value = edit.draft;
  ta.placeholder = '输入段落内容…';
  if (edit.saving) ta.disabled = true;
  ta.addEventListener('input', () => {
    edit.draft = ta.value;
    edit.lastInputAt = Date.now();
    if (edit.lockWanted && !edit.hasLock) {
      send({ type: 'lock', nodeId: edit.entryNodeId || edit.sourceId });
    }
    edit.lockWanted = true;
  });
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      saveEdit();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  });
  box.appendChild(ta);

  const bar = document.createElement('div');
  bar.className = 'edit-toolbar';

  const tools = document.createElement('div');
  tools.className = 'edit-tools';
  // 结构操作只属于源行；跟读入口只改字
  const mirrorEntry = isMirrorEntry();
  if (!mirrorEntry) {
    tools.append(
      toolBtn('⇥ 降级', () => indent(edit.sourceId, +1)),
      toolBtn('⇤ 升级', () => indent(edit.sourceId, -1)),
      toolBtn('↑ 上移', () => moveVertical(edit.sourceId, -1)),
      toolBtn('↓ 下移', () => moveVertical(edit.sourceId, +1)),
      toolBtn('删除', () => deleteNode(edit.sourceId), true),
    );
  } else {
    const hint = document.createElement('span');
    hint.className = 'hint-inline mirror-edit-hint';
    hint.textContent = '正在跟读处编辑：改动直接写入源段落，所有挂载点同步';
    tools.appendChild(hint);
  }
  bar.appendChild(tools);

  const right = document.createElement('div');
  right.style.display = 'flex';
  right.style.gap = '8px';
  right.style.alignItems = 'center';

  right.innerHTML = `<span class="hint-inline edit-status">${editorStatusHtml()}</span>`;
  const cancel = document.createElement('button');
  cancel.className = 'ghost';
  cancel.textContent = '取消';
  cancel.disabled = edit.saving;
  cancel.addEventListener('click', cancelEdit);
  const save = document.createElement('button');
  save.className = 'primary';
  save.textContent = edit.saving ? '保存中…' : '保存';
  save.disabled = edit.saving;
  save.addEventListener('click', saveEdit);
  right.append(cancel, save);
  bar.appendChild(right);

  box.appendChild(bar);
  return box;
}

// 编辑器工具栏左侧的状态行：占用状态 + 落后版本提醒 + 快捷键/基准版本。
// 锁消息到达时会用它原地刷新（不重绘 textarea，输入不被打断）。
function editorStatusHtml() {
  const lockLine = edit.hasLock
    ? '<span class="lock-state on">● 你正占用此段</span>'
    : '<span class="lock-state off">○ 未占用（30 秒无输入会自动让出，继续输入即重新占用）</span>';
  const behind = edit.serverVersion > edit.baseVersion
    ? `<span class="lock-state warn">⚠ 期间已有 v${edit.serverVersion}，保存将自动合并</span>` : '';
  const baseLine = edit.restoreFromVersion
    ? `从历史 <b>v${edit.restoreFromVersion}</b> 继续编辑`
    : `基于 v${edit.baseVersion}`;
  return `${lockLine} ${behind}<br>` +
    `<kbd>Ctrl</kbd>+<kbd>Enter</kbd> 保存 · <kbd>Esc</kbd> 取消 · ${baseLine}`;
}

function toolBtn(label, fn, danger = false) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = danger ? 'danger' : '';
  b.textContent = label;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    fn();
  });
  return b;
}

function startLockTimers() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (!edit.sourceId) return;
    const idleFor = Date.now() - edit.lastInputAt;
    if (idleFor > IDLE_RELEASE_MS && edit.hasLock) {
      edit.hasLock = false;
      edit.lockWanted = false;
      send({ type: 'unlock', nodeId: edit.sourceId });
      patchSource(edit.sourceId);
      toast('已空闲 30 秒，占用自动释放；继续输入可重新占用', '', 3600);
    } else if (edit.hasLock) {
      send({ type: 'heartbeat', nodeId: edit.sourceId }, { quiet: true });
    }
  }, HEARTBEAT_MS);
}

function resetEditState() {
  edit.sourceId = null;
  edit.entryNodeId = null;
  edit.docId = null;
  edit.hasLock = false;
  edit.lockWanted = true;
  edit.restoreFromVersion = null;
  edit.saving = false;
  edit.serverVersion = 0;
  clearInterval(heartbeatTimer);
}

function stopEditing(reason) {
  resetEditState();
  updateEditingHint();
  renderActiveDoc();
  if (reason) toast(reason, 'error');
}

function cancelEdit() {
  if (!edit.sourceId) return;
  if (edit.hasLock) send({ type: 'unlock', nodeId: edit.sourceId });
  resetEditState();
  updateEditingHint();
  renderActiveDoc();
}

function saveEdit() {
  if (!edit.sourceId || edit.saving) return;
  const payload = edit.restoreFromVersion
    ? {
        type: 'restore_save',
        nodeId: edit.sourceId,
        content: edit.draft,
        restoreVersion: edit.restoreFromVersion,
      }
    : {
        type: 'save',
        nodeId: edit.sourceId, // 跟读处编辑也提交源 id：只有源有正文/版本
        content: edit.draft,
        baseVersion: edit.baseVersion,
      };
  const queued = send(payload);
  if (!queued) {
    toast('当前离线，内容保留在编辑器里，恢复连接后再保存', 'error');
    return;
  }
  edit.saving = true;
  renderActiveDoc();
  focusEditor(edit.entryNodeId || edit.sourceId);
}

function finishSave(sourceId) {
  if (!sourceId || edit.sourceId !== sourceId) {
    edit.saving = false;
    return;
  }
  if (edit.hasLock) send({ type: 'unlock', nodeId: sourceId });
  resetEditState();
  updateEditingHint();
  renderActiveDoc();
}

function updateEditingHint() {
  const hint = $('#editing-hint');
  if (edit.sourceId) {
    hint.classList.remove('hidden');
    hint.textContent = isMirrorEntry()
      ? '正在跟读处编辑源段落：30 秒无操作自动让出占用（不会关闭编辑器或断开连接）'
      : '编辑中：30 秒无操作自动让出占用（不会关闭编辑器或断开连接）';
  } else {
    hint.classList.add('hidden');
  }
}

/* ================= 结构操作 ================= */

function requestMove(nodeId, parentId, afterId) {
  if (parentId === nodeId) return;
  const found = findRow(nodeId);
  if (!found) return;
  send({
    type: 'move',
    nodeId,
    parentId: parentId || '',
    afterId: afterId || '',
    treeRev: found.view.treeRev,
  });
}

function siblingsInfo(nodeId) {
  const found = findRow(nodeId);
  if (!found) return null;
  const { view, node } = found;
  const parentId = node.parentId;
  return { view, parentId };
}

function moveVertical(nodeId, dir) {
  const info = siblingsInfo(nodeId);
  if (!info) return;
  const all = (info.view.children.get(info.parentId) || []).slice();
  const i = all.indexOf(nodeId);
  const j = i + dir;
  if (j < 0 || j >= all.length) {
    toast(dir < 0 ? '已经是最前面了' : '已经是最后面了');
    return;
  }
  if (dir < 0) {
    requestMove(nodeId, info.parentId, j === 0 ? null : all[j - 1]);
  } else {
    requestMove(nodeId, info.parentId, all[j]);
  }
}

function indent(nodeId, delta) {
  const info = siblingsInfo(nodeId);
  if (!info) return;
  const node = info.view.nodes.get(nodeId);
  if (delta > 0) {
    const ids = info.view.children.get(node.parentId) || [];
    const i = ids.indexOf(nodeId);
    if (i <= 0) {
      toast('前面没有段落可以挂接，无法降级');
      return;
    }
    const newParent = ids[i - 1];
    const kids = info.view.children.get(newParent) || [];
    requestMove(nodeId, newParent, kids.length ? kids[kids.length - 1] : '');
  } else {
    const parent = node.parentId ? info.view.nodes.get(node.parentId) : null;
    if (!parent) {
      toast('已经是顶层段落');
      return;
    }
    requestMove(nodeId, parent.parentId, parent.id);
  }
}

function addNode(parentId, afterId) {
  let docId = state.activeDocId;
  if (parentId) {
    const found = findRow(parentId);
    if (!found) return;
    if (found.node.kind === 'mirror') {
      toast('跟读段落下不能再加子级', 'error');
      return;
    }
    docId = [...state.views.entries()].find(([, v]) => v.nodes.has(parentId))?.[0];
  }
  const view = viewOf(docId);
  send({
    type: 'add',
    docId,
    parentId: parentId || '',
    afterId: afterId || '',
    content: '',
    treeRev: view.treeRev,
  });
}

$('#add-root').addEventListener('click', () => addNode(null, null));

function deleteNode(nodeId) {
  const found = findRow(nodeId);
  if (!found) return;
  if (found.node.kind === 'mirror') {
    removeMirror(nodeId);
    return;
  }
  const mirrorCount = countMirrors(nodeId);
  const extra = mirrorCount
    ? `\n\n注意：有 ${mirrorCount} 处跟读挂着这段，删除后它们会显示「源段落已被删除」。`
    : '';
  if (!confirm('确定删除该段落及其所有子段落？（历史仍保留，但视图中会移除）' + extra)) return;
  send({ type: 'delete', nodeId, treeRev: found.view.treeRev });
  if (edit.sourceId === nodeId) stopEditing();
}

function countMirrors(sourceId) {
  let n = 0;
  for (const view of state.views.values()) {
    for (const node of view.nodes.values()) {
      if (node.kind === 'mirror' && node.mirrorOf === sourceId) n++;
    }
  }
  return n;
}

function removeMirror(nodeId) {
  const found = findRow(nodeId);
  if (!found) return;
  if (!confirm('移除这处跟读？（源段落和其它大纲里的跟读不受影响）')) return;
  send({ type: 'delete', nodeId, treeRev: found.view.treeRev });
}

/* ================= 挂跟读：选择目标大纲 ================= */

const mirrorPicker = { sourceId: null };

function openMirrorPicker(node) {
  mirrorPicker.sourceId = node.id;
  const select = $('#mirror-doc-select');
  select.innerHTML = '';
  const sourceDocId = findDocOfNode(node.id);
  const others = [...state.docs.values()].filter((d) => d.id !== sourceDocId);
  if (!others.length) {
    toast('还没有别的大纲。先点「＋ 新大纲」再挂跟读', 'error');
    return;
  }
  for (const d of others) {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = d.title;
    select.appendChild(opt);
  }
  $('#mirror-mask').classList.remove('hidden');
}

$('#mirror-cancel').addEventListener('click', () => $('#mirror-mask').classList.add('hidden'));
$('#mirror-mask').addEventListener('click', (e) => {
  if (e.target === $('#mirror-mask')) $('#mirror-mask').classList.add('hidden');
});
$('#mirror-confirm').addEventListener('click', () => {
  const targetDocId = $('#mirror-doc-select').value;
  const sourceId = mirrorPicker.sourceId;
  if (!targetDocId || !sourceId) return;
  // 需要目标文档当前 treeRev：未加载则让服务器预取快照后我们再发
  const doSend = () => {
    const view = viewOf(targetDocId);
    if (!view) return false;
    send({
      type: 'add_mirror',
      sourceId,
      docId: targetDocId,
      parentId: '',
      afterId: '',
      treeRev: view.treeRev,
    });
    return true;
  };
  if (!doSend()) {
    requestDoc(targetDocId);
    let tries = 0;
    const t = setInterval(() => {
      if (doSend() || ++tries > 20) clearInterval(t);
    }, 100);
  }
  $('#mirror-mask').classList.add('hidden');
});

/* ================= 历史与回退 ================= */

function openHistory(nodeId) {
  state.historyNodeId = nodeId;
  $('#history-title').textContent = '段落历史';
  $('#history-panel').classList.remove('hidden');
  send({ type: 'history', nodeId });
}

$('#history-close').addEventListener('click', () => {
  $('#history-panel').classList.add('hidden');
  state.historyNodeId = null;
});

function renderHistory(msg) {
  const list = $('#history-list');
  list.innerHTML = '';
  const found = findRow(msg.nodeId);
  const node = found?.node;
  $('#history-current').textContent = node
    ? `当前版本 v${node.version}，共 ${msg.items.length} 条记录`
    : `共 ${msg.items.length} 条记录`;

  for (const rev of msg.items) {
    const card = document.createElement('div');
    card.className = 'rev-card' + (node && rev.version === node.version ? ' current' : '');
    card.innerHTML = `
      <div class="rev-head">
        <span><strong>v${rev.version}</strong> · ${escapeHtml(rev.author || '系统')}</span>
        <span class="muted">${fmtTime(rev.createdAt)}</span>
      </div>
      <div class="rev-content"></div>
      ${rev.note ? `<div class="rev-note">${escapeHtml(rev.note)}</div>` : ''}
      <div class="rev-actions">
        <button class="restore-btn">以此版本继续编辑</button>
      </div>`;
    card.querySelector('.rev-content').textContent = rev.content || '（空）';
    card.querySelector('.restore-btn').addEventListener('click', () => {
      restoreRevision(msg.nodeId, rev);
    });
    list.appendChild(card);
  }
}

function restoreRevision(nodeId, rev) {
  const found = findRow(nodeId);
  if (!found) {
    toast('该段落已不存在', 'error');
    return;
  }
  if (edit.sourceId && edit.sourceId !== nodeId) {
    toast('请先结束当前段落的编辑', 'error');
    return;
  }
  const lockHolder = [...state.views.values()]
    .map((v) => v.lockInfo?.get(nodeId))
    .find(Boolean);
  if (lockHolder && state.me && lockHolder.userId !== state.me.userId) {
    toast(`${lockHolder.userName} 正在编辑这一段，稍候再试`, 'error');
    return;
  }
  $('#history-panel').classList.add('hidden');

  const wasNotEditing = edit.sourceId !== nodeId;
  edit.sourceId = nodeId;
  edit.entryNodeId = nodeId;
  edit.docId = findDocOfNode(nodeId);
  edit.baseVersion = found.node.version;
  edit.serverVersion = found.node.version;
  edit.restoreFromVersion = rev.version;
  edit.hasLock = false;
  edit.lockWanted = true;
  edit.saving = false;
  edit.draft = rev.content;
  edit.lastInputAt = Date.now();
  renderActiveDoc();
  if (wasNotEditing) {
    send({ type: 'lock', nodeId });
    startLockTimers();
  }
  focusEditor(nodeId);
  updateEditingHint();
  toast('已载入旧版本内容作为草稿。保存时将保留其他人之后不冲突的改动', 'ok', 4200);
}

/* ================= 冲突解决 ================= */

function openConflict(msg) {
  pendingConflict.current = msg;
  $('#conflict-local').value = msg.local;
  $('#conflict-remote').value = msg.remote;
  $('#conflict-final').value = msg.remote;
  $('#conflict-mask').classList.remove('hidden');
  toast('与他人修改冲突，请选择最终内容', 'error', 4000);
}

$('#conflict-keep-local').addEventListener('click', () => {
  $('#conflict-final').value = $('#conflict-local').value;
});
$('#conflict-keep-remote').addEventListener('click', () => {
  $('#conflict-final').value = $('#conflict-remote').value;
});
$('#conflict-cancel').addEventListener('click', () => {
  $('#conflict-mask').classList.add('hidden');
  pendingConflict.current = null;
  edit.saving = false;
  renderActiveDoc();
  if (edit.entryNodeId) focusEditor(edit.entryNodeId);
});
$('#conflict-save').addEventListener('click', () => {
  const c = pendingConflict.current;
  if (!c) return;
  const final = $('#conflict-final').value;
  const ok = send({
    type: 'resolve',
    nodeId: c.nodeId, // 源 id
    content: final,
    keep: final === c.remote ? 'remote' : 'manual',
  });
  if (!ok) return;
  $('#conflict-mask').classList.add('hidden');
  pendingConflict.current = null;
  edit.saving = true;
  send({ type: 'unlock', nodeId: c.nodeId });
  toast('已提交最终版本', 'ok');
});

/* ================= 离开页面 ================= */

window.addEventListener('beforeunload', () => {
  if (edit.sourceId && state.ws && state.ws.readyState === WebSocket.OPEN) {
    try {
      state.ws.send(JSON.stringify({ type: 'unlock', nodeId: edit.sourceId }));
    } catch { /* ignore */ }
  }
});
