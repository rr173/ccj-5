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

/* ================= 离线暂存：断线改的字先落本机，联网后自动对齐 =================
 *
 * 断线时的「保存」不走网络，写进 localStorage 队列（同一段只留最新正文 +
 * 最初的基准版本），本地乐观显示并挂「待同步」徽章；编辑器里没保存的草稿
 * 也随输入落盘，刷新/关页面都不丢。
 * 重连拿到服务器最新快照后按序回放队列：每条带 clientTag 走正常 save，
 * 服务器的版本号 + diff3 合并机制负责与线上对齐——不撞的自动合并全员广播
 * （跟读行同一份）；撞上的段落留在队列里标 conflict，行内红徽章明示
 * 「当前以线上为准」，等人裁决，绝不出现"两边都显示成功却对不上"。
 */
const OFFLINE_QUEUE_KEY = 'outline.offlineQueue.v1';
const DRAFTS_KEY = 'outline.drafts.v1';

// op: { id, nodeId, content, baseVersion, restoreFromVersion, queuedAt,
//       status: 'pending' | 'conflict', conflict?: { base, local, remote, current },
//       inEditor?: true }   —— inEditor 是运行时标记：正折在编辑器里，
//       刷新/重开页面后一律视为待同步（编辑会话已不存在）。
const offlineQueue = (() => {
  const v = loadJson(OFFLINE_QUEUE_KEY, []);
  if (!Array.isArray(v)) return [];
  return v.filter((o) => o && o.nodeId).map((o) => {
    delete o.inEditor;
    return o;
  });
})();
// sourceId -> { content, baseVersion, restoreFromVersion, at }
const draftStore = (() => {
  const v = loadJson(DRAFTS_KEY, {});
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
})();

const offlineSync = {
  flushing: false,   // 正在逐条回放
  current: null,     // { op, resolve, wantModal } 在飞的那一条
  armed: true,       // 重连后收到第一份快照时触发一次回放（页面刚打开也算）
};

function loadJson(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '');
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function persistOfflineQueue() {
  try {
    if (offlineQueue.length) localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(offlineQueue));
    else localStorage.removeItem(OFFLINE_QUEUE_KEY);
  } catch { /* 存储写不进不阻断编辑 */ }
  renderSyncState();
}

let draftSaveTimer = null;
function persistDraftsNow() {
  clearTimeout(draftSaveTimer);
  try {
    if (Object.keys(draftStore).length) localStorage.setItem(DRAFTS_KEY, JSON.stringify(draftStore));
    else localStorage.removeItem(DRAFTS_KEY);
  } catch { /* ignore */ }
}
function persistDraftsSoon() {
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(persistDraftsNow, 400);
}

// 编辑器里还没点保存的草稿随输入落盘：断线/刷新/关页面都不丢
function rememberDraft() {
  if (!edit.sourceId) return;
  draftStore[edit.sourceId] = {
    content: edit.draft,
    baseVersion: edit.baseVersion,
    restoreFromVersion: edit.restoreFromVersion || null,
    at: Date.now(),
  };
  persistDraftsSoon();
}

function clearPersistedDraft(sourceId) {
  if (sourceId && draftStore[sourceId]) {
    delete draftStore[sourceId];
    persistDraftsSoon();
  }
}

// 启动时把上次落盘的未保存草稿装回孤儿草稿池（beginEdit 会认领）
for (const [k, v] of Object.entries(draftStore)) {
  if (v && typeof v.content === 'string') orphanDrafts.set(k, v);
}

function pendingOpFor(sourceId) {
  return offlineQueue.find((o) => o.nodeId === sourceId) || null;
}

// 编辑会话折进了队列里的离线改动：取消/被迫结束编辑时把它原样还给队列
// （内容保持已存本机的那一版），等联网后照常与线上对齐。
function releaseFoldedOp(sourceId) {
  const op = pendingOpFor(sourceId);
  if (op && op.inEditor) {
    delete op.inEditor;
    persistOfflineQueue();
  }
}

function removeOp(op) {
  const idx = offlineQueue.indexOf(op);
  if (idx >= 0) offlineQueue.splice(idx, 1);
  persistOfflineQueue();
}

// 断线保存：同一段只留一条（保留最初基准版本，正文取最新），
// 本地各行立即乐观显示离线正文（版本号不动，徽章标明"待同步"）。
function enqueueOfflineSave() {
  const sourceId = edit.sourceId;
  const existing = pendingOpFor(sourceId);
  if (existing) {
    existing.content = edit.draft;
    existing.queuedAt = Date.now();
    existing.status = 'pending';
    delete existing.conflict;
    delete existing.inEditor; // 本次编辑会话结束，回到待同步
  } else {
    offlineQueue.push({
      id: 'op-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      nodeId: sourceId,
      content: edit.draft,
      baseVersion: edit.baseVersion,
      restoreFromVersion: edit.restoreFromVersion || null,
      queuedAt: Date.now(),
      status: 'pending',
    });
  }
  persistOfflineQueue();
  for (const { view, node } of rowsOfSource(sourceId)) {
    node.content = edit.draft;
    patchRow(view, node.id);
  }
  clearPersistedDraft(sourceId);
  resetEditState();
  updateEditingHint();
  renderActiveDoc();
  toast('已存到本机（离线）。联网后自动与线上对齐；若与别人撞上会标出来请你裁决', 'ok', 4200);
}

// ---------- 重连回放：把队列里的离线改动逐条对齐到线上 ----------

async function flushOfflineQueue({ includeConflicts = false } = {}) {
  if (offlineSync.flushing || !state.connected || !state.me) return;
  if (includeConflicts) {
    for (const o of offlineQueue) {
      if (o.status === 'conflict' && !o.inEditor) o.status = 'pending';
    }
    persistOfflineQueue();
  }
  if (!offlineQueue.some((o) => o.status === 'pending' && !o.inEditor)) {
    renderSyncState();
    return;
  }
  offlineSync.flushing = true;
  let saved = 0, merged = 0, conflicts = 0, failed = 0;
  try {
    for (;;) {
      if (!state.connected) break;
      // 折在编辑器里的（inEditor）不动：它随编辑会话的保存/取消走
      const op = offlineQueue.find((o) => o.status === 'pending' && !o.inEditor);
      if (!op) break;
      const outcome = await syncOneOp(op, { wantModal: false });
      if (outcome === 'saved') saved++;
      else if (outcome === 'merged') merged++;
      else if (outcome === 'conflict') conflicts++;
      else if (outcome === 'failed') failed++;
      else break; // aborted：又掉线了，剩下的下次重连接着来
    }
  } finally {
    offlineSync.flushing = false;
    persistOfflineQueue();
    renderActiveDoc();
  }
  const parts = [];
  if (saved) parts.push(`${saved} 段已同步`);
  if (merged) parts.push(`${merged} 段与线上自动合并`);
  if (conflicts) parts.push(`${conflicts} 段与线上冲突待裁决（当前以线上为准）`);
  if (failed) parts.push(`${failed} 段未能同步`);
  if (parts.length) {
    toast('离线改动对齐：' + parts.join('，'), conflicts || failed ? 'error' : 'ok', 5600);
  }
}

// 回放一条离线改动；结果通过带 clientTag 的回执路由回来（routeSyncMessage）
function syncOneOp(op, { wantModal }) {
  return new Promise((resolve) => {
    const payload = op.restoreFromVersion
      ? {
          type: 'restore_save', nodeId: op.nodeId, content: op.content,
          restoreVersion: op.restoreFromVersion, clientTag: op.id,
        }
      : {
          type: 'save', nodeId: op.nodeId, content: op.content,
          baseVersion: op.baseVersion, clientTag: op.id,
        };
    if (!send(payload, { quiet: true })) {
      resolve('aborted');
      return;
    }
    offlineSync.current = { op, resolve, wantModal };
  });
}

function finishSyncWait(tag, outcome) {
  const cur = offlineSync.current;
  if (cur && cur.op.id === tag) {
    offlineSync.current = null;
    cur.resolve(outcome);
  }
}

// 带 clientTag 的回执：属于离线回放，绝不触碰交互式编辑会话
function routeSyncMessage(msg) {
  const tag = msg.clientTag;
  const op = offlineQueue.find((o) => o.id === tag) || null;
  if (msg.type === 'saved' || msg.type === 'merge_notice') {
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
    if (op) {
      removeOp(op);
      toast(
        msg.type === 'merge_notice'
          ? '你的离线改动已与线上最新内容自动合并'
          : '你的离线改动已同步到线上',
        'ok', 3000,
      );
      renderActiveDoc();
    }
    finishSyncWait(tag, msg.type === 'merge_notice' ? 'merged' : 'saved');
    return;
  }
  if (msg.type === 'conflict') {
    if (op) {
      op.status = 'conflict';
      op.conflict = { base: msg.base, local: msg.local, remote: msg.remote, current: msg.current || null };
      persistOfflineQueue();
      renderActiveDoc();
      if (offlineSync.current?.op === op && offlineSync.current.wantModal) {
        openOfflineConflict(op);
      }
    }
    finishSyncWait(tag, 'conflict');
    return;
  }
  if (msg.type === 'error') {
    if (op) {
      removeOp(op);
      // 不丢字：同步失败的原文存回本机草稿（段落若还在，下次编辑可找回）
      draftStore[op.nodeId] = {
        content: op.content,
        baseVersion: op.baseVersion,
        restoreFromVersion: op.restoreFromVersion || null,
        at: Date.now(),
      };
      orphanDrafts.set(op.nodeId, draftStore[op.nodeId]);
      persistDraftsNow();
      toast(`离线改动未能同步：${msg.message || '服务器拒绝'}。原文已保留在本机草稿`, 'error', 5600);
      renderActiveDoc();
    }
    finishSyncWait(tag, 'failed');
  }
}

// 点行内徽章 / 顶栏计数：pending 触发回放；conflict 重新对齐一次并弹裁决窗
function onSyncBadgeClick(op) {
  if (!state.connected) {
    toast('离线中：改动已存本机，恢复连接后自动对齐', '');
    return;
  }
  if (op.inEditor) {
    toast('这段正在编辑器里：保存即同步，取消则回到待同步队列', '');
    return;
  }
  if (offlineSync.flushing || offlineSync.current) {
    toast('正在同步中，请稍候', '');
    return;
  }
  if (op.status === 'conflict') {
    syncOneOp(op, { wantModal: true }).then(() => renderActiveDoc());
  } else {
    flushOfflineQueue();
  }
}

// 离线冲突裁决窗：三栏不变，文案明示"裁决前所有人看到的是线上版本"
function openOfflineConflict(op) {
  const c = op.conflict;
  if (!c) return;
  pendingConflict.current = { nodeId: op.nodeId, local: c.local, remote: c.remote, clientTag: op.id };
  const cur = c.current || {};
  const who = cur.author ? `${cur.author} 的 v${cur.version}` : '线上当前版本';
  const when = cur.created_at ? `（${fmtTime(cur.created_at)}）` : '';
  $('#conflict-title').textContent = '离线改动与线上版本冲突';
  $('#conflict-sub').textContent =
    `你断线期间改的这段，线上已有${who}${when}。在你裁决之前，所有人（含跟读）看到的都是线上版本，` +
    '你的离线改动暂未生效；提交最终版本后，全员统一为最终内容。';
  $('#conflict-local-label').textContent = '你的离线改动（暂未生效）';
  $('#conflict-remote-label').textContent = `线上当前版本：${who}，裁决前以此为准`;
  $('#conflict-local').value = c.local;
  $('#conflict-remote').value = c.remote;
  $('#conflict-final').value = c.remote;
  $('#conflict-mask').classList.remove('hidden');
}

// 顶栏同步状态胶囊：有待同步/待裁决时可见，点击立即对齐
function renderSyncState() {
  const el = $('#sync-state');
  if (!el) return;
  const conflicts = offlineQueue.filter((o) => o.status === 'conflict').length;
  const pending = offlineQueue.length - conflicts;
  if (!offlineQueue.length) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  el.classList.toggle('has-conflict', conflicts > 0);
  if (conflicts) {
    el.textContent = `⚠ ${conflicts} 段离线改动与线上冲突，待裁决`;
    el.title = '这些段落在你断线期间被别人改过，当前以线上版本为准。点击逐段对齐并裁决。';
  } else if (state.connected) {
    el.textContent = `⏳ 正在同步 ${pending} 段离线改动…`;
    el.title = '断线期间的改动正在与线上对齐。点击重试。';
  } else {
    el.textContent = `⏳ ${pending} 段离线改动待同步（已存本机）`;
    el.title = '断线期间的改动已保存在本机，恢复连接后自动与线上对齐。';
  }
}


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

// 整份时间轴回看。active 时当前标签页渲染"时刻 seq"的整棵树（层级+正文，只读），
// 实时视图在后台照常接收更新，退出回看立即回到最新。
// seq 是全局时刻坐标：源大纲与跟读宿主大纲用同一 seq 对照，看到的状态严格一致。
const timeTravel = {
  active: false,
  seq: 0,
  at: null,             // 该时刻的服务器时间戳（横幅显示用）
  latestSeq: 0,
  byDoc: new Map(),     // docId -> { nodes, children, title, asOf }，切标签页按同一 seq 对照
};
const timelineCache = { items: [], latestSeq: 0 };

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
  // 回看模式中切标签页：新文档也回到同一时刻，方便源/跟读两份对照
  if (timeTravel.active) ensureTimeSnapshot(docId);
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
    // 保存半途掉线：解开"保存中"的禁用态，草稿还在，重连后可重试
    if (edit.saving) edit.saving = false;
    // 重连拿到新快照后回放本机离线队列
    offlineSync.armed = true;
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

// 结构改动（增/删/移动/挂跟读）不进离线队列：树版本乐观锁无法离线暂存，
// 明确拦住并说明；段落正文编辑不受影响（自动存本机）。
function requireOnline() {
  if (state.connected) return true;
  toast('离线中：增/删/移动/挂跟读这类结构改动不能暂存，请联网后再试（段落正文编辑会自动存本机）', 'error', 4600);
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
  renderSyncState(); // 待同步徽章的文案随连接状态变化
}

/* ================= 消息分发 ================= */

function handleMessage(msg) {
  // 离线回放的回执（带 clientTag）走专用通道，不触碰交互式编辑会话
  if (msg.clientTag) {
    routeSyncMessage(msg);
    return;
  }
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
    case 'timeline':
      timelineCache.items = msg.items || [];
      timelineCache.latestSeq = msg.latestSeq || 0;
      timeTravel.latestSeq = timelineCache.latestSeq;
      drawTimeline();
      break;
    case 'snapshot_at':
      ingestSnapshotAt(msg);
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
  if (!requireOnline()) return;
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

  // 重连后的第一份快照到了：本地已是线上真相，稍候把离线队列逐条对齐上去
  // （等 400ms 是让其余标签页的快照一起落地，回放基于最新状态）
  if (offlineSync.armed) {
    offlineSync.armed = false;
    setTimeout(() => flushOfflineQueue(), 400);
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
  renderTimeBanner();
  renderSyncState();
  $('#add-root').disabled = !state.activeDocId || timeTravel.active;
  updateEditingHint();
}

function renderOutline() {
  const root = $('#outline');
  root.innerHTML = '';
  if (timeTravel.active) {
    renderTimeTree(root);
    return;
  }
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
  // 离线改动状态：待同步（黄）/ 与线上冲突待裁决（红，明示当前以线上为准）
  const pendingOp = pendingOpFor(sourceId);
  if (pendingOp && !(node.kind === 'mirror' && node.sourceDeleted)) {
    const badge = document.createElement('span');
    if (pendingOp.status === 'conflict') {
      const cur = pendingOp.conflict?.current;
      badge.className = 'sync-badge conflict';
      badge.textContent = cur && cur.author
        ? `⚠ 离线改动与线上冲突 · 当前以线上（${cur.author} 的 v${cur.version}）为准，点此裁决`
        : '⚠ 离线改动与线上冲突 · 当前以线上为准，点此裁决';
      badge.title = '你断线时改的这段与线上新版本撞上了，线上版本暂未被你覆盖。点击重新对齐并选择最终内容。';
    } else {
      badge.className = 'sync-badge pending';
      badge.textContent = state.connected ? '⏳ 离线改动同步中…' : '⏳ 离线改动待同步（已存本机）';
      badge.title = '断线时的改动已保存在本机，联网后自动与线上对齐';
    }
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      onSyncBadgeClick(pendingOp);
    });
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
  if (timeTravel.active) {
    toast('回看模式里不能直接编辑；请用段落上的「从此刻继续编辑」另开一条线', 'error');
    return;
  }
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

  const queuedOp = pendingOpFor(sourceId);
  const orphan = orphanDrafts.get(sourceId);
  if (queuedOp && offlineSync.current?.op !== queuedOp) {
    // 这段有断线时存进本机的改动：折进编辑器，但**不移出队列**（只打 inEditor
    // 标记）——取消编辑要把它原样还给队列，在线保存成功才真正移除。
    // 已存本机的改动绝不能因为"点开看一眼再取消"丢掉。
    queuedOp.inEditor = true;
    persistOfflineQueue();
    edit.baseVersion = queuedOp.baseVersion ?? edit.baseVersion;
    edit.restoreFromVersion = queuedOp.restoreFromVersion || null;
    if (orphan) {
      // 上次折进编辑器后又敲了字（没保存）就刷新/关页面：草稿更新，优先恢复
      edit.draft = orphan.content;
      edit.baseVersion = orphan.baseVersion ?? edit.baseVersion;
      edit.restoreFromVersion = orphan.restoreFromVersion || null;
      orphanDrafts.delete(sourceId);
      toast('已恢复你未保存的草稿；本段还有一份待同步的离线改动', 'ok', 3600);
    } else {
      edit.draft = queuedOp.content;
      toast('已载入你断线时改的内容；保存时会与线上自动合并，取消也不会丢', 'ok', 3600);
    }
    rememberDraft();
  } else if (orphan) {
    edit.draft = orphan.content;
    // 草稿基于的旧版本一并恢复：保存时三方合并的 base 才是真正的共同祖先
    edit.baseVersion = orphan.baseVersion ?? edit.baseVersion;
    edit.restoreFromVersion = orphan.restoreFromVersion || null;
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
  // 离线时静默：锁等重连后会自动重新申请（见 ingestSnapshot）
  send({ type: 'lock', nodeId }, { quiet: !state.connected }); // 服务器自行把跟读 id 解析成源锁
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
    rememberDraft(); // 未保存的草稿也落盘：断线/刷新不丢
    if (state.connected && edit.lockWanted && !edit.hasLock) {
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
  releaseFoldedOp(edit.sourceId); // 折进编辑器的离线改动还给队列，不丢
  clearPersistedDraft(edit.sourceId);
  resetEditState();
  updateEditingHint();
  renderActiveDoc();
  if (reason) toast(reason, 'error');
}

function cancelEdit() {
  if (!edit.sourceId) return;
  if (edit.hasLock) send({ type: 'unlock', nodeId: edit.sourceId });
  // 已存本机的离线改动：取消编辑不丢，还给队列等联网对齐；
  // 只在框里敲了一半、从没保存过的草稿：照旧清掉。
  releaseFoldedOp(edit.sourceId);
  clearPersistedDraft(edit.sourceId);
  resetEditState();
  updateEditingHint();
  renderActiveDoc();
}

function saveEdit() {
  if (!edit.sourceId || edit.saving) return;
  // 断线：不进网络，写入本机离线队列（乐观显示 + 待同步徽章），联网后自动对齐
  if (!state.connected) {
    enqueueOfflineSave();
    return;
  }
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
    // 连接刚断的一瞬间：同样落入本机队列，不丢字
    enqueueOfflineSave();
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
  // 折进编辑器的离线改动已随这次保存上线：从队列移除（否则回放会再存一遍旧文）
  const folded = pendingOpFor(sourceId);
  if (folded && folded.inEditor) removeOp(folded);
  clearPersistedDraft(sourceId);
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
  if (!requireOnline()) return;
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
  if (!requireOnline()) return;
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
  if (!requireOnline()) return;
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
  if (!requireOnline()) return;
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
  if (!requireOnline()) return;
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
    toast('该段落在当前已不存在（可能已被删除），无法从旧时刻接着改', 'error');
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

/* ================= 整份时间轴：按时刻回看 + 从该时刻另开一条线 ================= */

$('#timeline-btn').addEventListener('click', () => {
  $('#timeline-panel').classList.remove('hidden');
  send({ type: 'timeline' });
});
$('#timeline-close').addEventListener('click', () => {
  $('#timeline-panel').classList.add('hidden');
});
$('#tt-exit').addEventListener('click', exitTimeTravel);

const TL_KIND_LABEL = { add: '新增', content: '修改', move: '移动', delete: '删除', mirror_add: '跟读' };

function drawTimeline() {
  const list = $('#timeline-list');
  if (!list) return;
  list.innerHTML = '';

  const nowCard = document.createElement('div');
  nowCard.className = 'rev-card tl-card' + (!timeTravel.active ? ' current' : '');
  nowCard.innerHTML =
    `<div class="rev-head"><span><strong>现在</strong> · 最新状态（时刻 #${timelineCache.latestSeq}）</span></div>` +
    (timeTravel.active ? '<div class="rev-actions"><button class="tl-jump">回到现在</button></div>' : '');
  if (timeTravel.active) {
    nowCard.querySelector('.tl-jump').addEventListener('click', exitTimeTravel);
  }
  list.appendChild(nowCard);

  for (const item of timelineCache.items) {
    const card = document.createElement('div');
    card.className = 'rev-card tl-card' +
      (timeTravel.active && item.seq === timeTravel.seq ? ' current' : '');
    card.innerHTML = `
      <div class="rev-head">
        <span><span class="tl-kind ${escapeHtml(item.kind)}">${escapeHtml(TL_KIND_LABEL[item.kind] || item.kind)}</span>
        <strong>#${item.seq}</strong> · ${escapeHtml(item.author || '系统')}</span>
        <span class="muted">${fmtTime(item.createdAt)}</span>
      </div>
      <div class="rev-content"></div>
      <div class="tl-doc">${escapeHtml(item.docTitle || '')}</div>
      ${item.note ? `<div class="rev-note">${escapeHtml(item.note)}</div>` : ''}
      <div class="rev-actions"><button class="tl-jump">回到这一刻</button></div>`;
    card.querySelector('.rev-content').textContent = item.summary || '';
    card.querySelector('.tl-jump').addEventListener('click', () => enterTimeTravel(item.seq));
    list.appendChild(card);
  }
}

function enterTimeTravel(seq) {
  if (edit.sourceId) {
    toast('请先保存或取消当前编辑，再进入整份回看', 'error');
    return;
  }
  timeTravel.active = true;
  timeTravel.seq = seq;
  timeTravel.byDoc.clear();
  ensureTimeSnapshot(state.activeDocId);
  renderActiveDoc();
  drawTimeline();
  toast(`已回到时刻 #${seq} 的整份大纲；切标签页可按同一时刻对照跟读的两份大纲`, 'ok', 3600);
}

function exitTimeTravel() {
  if (!timeTravel.active) return;
  timeTravel.active = false;
  timeTravel.byDoc.clear();
  renderActiveDoc();
  drawTimeline();
}

function ensureTimeSnapshot(docId) {
  if (!docId || timeTravel.byDoc.has(docId)) return;
  send({ type: 'snapshot_at', docId, seq: timeTravel.seq });
}

function ingestSnapshotAt(msg) {
  // 只接受当前时刻的响应（连点几个时刻时，过期响应直接丢弃）
  if (!timeTravel.active || !msg.asOf || msg.asOf.seq !== timeTravel.seq) return;
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
  timeTravel.at = msg.asOf.createdAt;
  timeTravel.latestSeq = msg.asOf.latestSeq || timeTravel.latestSeq;
  timeTravel.byDoc.set(msg.docId, { nodes, children, title: msg.title, asOf: msg.asOf });
  if (msg.docId === state.activeDocId) renderActiveDoc();
}

function renderTimeBanner() {
  const banner = $('#tt-banner');
  if (!timeTravel.active) {
    banner.classList.add('hidden');
    return;
  }
  banner.classList.remove('hidden');
  $('#tt-banner-text').textContent =
    `正在回看时刻 #${timeTravel.seq}${timeTravel.at ? '（' + fmtTime(timeTravel.at) + '）' : ''} 的整份大纲：` +
    '层级与正文只读。点段落上的「从此刻继续编辑」会另开一条线接着写，与现在的内容自动合并';
}

function renderTimeTree(root) {
  const tt = timeTravel.byDoc.get(state.activeDocId);
  if (!tt) {
    const tip = document.createElement('div');
    tip.className = 'muted';
    tip.style.padding = '12px 4px';
    tip.textContent = '正在重建这一时刻的整份大纲…';
    root.appendChild(tip);
    return;
  }
  const roots = tt.children.get(null) || [];
  if (!roots.length) {
    const tip = document.createElement('div');
    tip.className = 'muted';
    tip.style.padding = '12px 4px';
    tip.textContent = '这一时刻这份大纲还是空的';
    root.appendChild(tip);
    return;
  }
  for (const id of roots) root.appendChild(renderTimeNode(tt, id));
}

function renderTimeNode(tt, id) {
  const node = tt.nodes.get(id);
  const wrap = document.createElement('div');
  wrap.className = 'node-outer';
  wrap.dataset.nodeId = id;
  wrap.appendChild(renderTimeRow(node));
  const kids = tt.children.get(id);
  if (kids && kids.length) {
    const childWrap = document.createElement('div');
    childWrap.className = 'children';
    for (const cid of kids) childWrap.appendChild(renderTimeNode(tt, cid));
    wrap.appendChild(childWrap);
  }
  return wrap;
}

function renderTimeRow(node) {
  const el = document.createElement('div');
  el.className = 'node tt-node' + (node.kind === 'mirror' ? ' mirror-node' : '');
  if (node.kind === 'mirror' && node.sourceDeleted) el.classList.add('source-gone');

  const row = document.createElement('div');
  row.className = 'node-row';

  const content = document.createElement('div');
  if (node.kind === 'mirror' && node.sourceDeleted) {
    content.className = 'node-content mirror-tombstone';
    content.innerHTML =
      '<span class="tombstone-mark">🪦</span> 该时刻源段落不存在（尚未创建或已被删除）';
  } else {
    content.className = 'node-content' + (node.content ? '' : ' placeholder');
    content.textContent = node.content || '（空段落）';
  }
  row.appendChild(content);

  // 「接着改」的入口：普通行看自己当前是否还活着；跟读行看源当前是否还活着
  const actions = document.createElement('div');
  actions.className = 'tt-actions';
  const goneNow = node.kind === 'mirror' ? !node.sourceAliveNow : !node.aliveNow;
  if (node.kind === 'mirror' && node.sourceDeleted) {
    // 当时源就不存在，无可接着改
  } else if (goneNow) {
    const tag = document.createElement('span');
    tag.className = 'tt-gone-tag';
    tag.textContent = node.kind === 'mirror' ? '源当前已删除' : '当前已删除';
    actions.appendChild(tag);
  } else {
    actions.appendChild(actionBtn('从此刻继续编辑', () => continueFromPast(node)));
  }
  row.appendChild(actions);
  el.appendChild(row);

  const meta = document.createElement('div');
  meta.className = 'node-meta';
  if (node.kind === 'mirror') {
    const tag = document.createElement('span');
    tag.className = 'mirror-tag';
    const srcDoc = node.sourceDocId ? state.docs.get(node.sourceDocId) : null;
    tag.textContent = '🔗 跟读自：' + (srcDoc ? srcDoc.title : '另一份大纲');
    meta.appendChild(tag);
  }
  const versionTag = document.createElement('span');
  versionTag.className = 'version-tag';
  versionTag.textContent = `当时 v${node.version ?? '—'}`;
  meta.appendChild(versionTag);
  if (node.author && !node.sourceDeleted) {
    const tag = document.createElement('span');
    tag.className = 'muted';
    tag.textContent = `${node.author} · ${fmtTime(node.updatedAt)}`;
    meta.appendChild(tag);
  }
  el.appendChild(meta);
  return el;
}

// 从回看的这一刻接着改：退出回看，把该时刻的正文当草稿载入编辑器，
// 保存走 restore_save（diff4 三方合并）——另开一条线，当前线上别人
// 后来写下、不冲突的改动自动保留；真重叠仍会弹冲突窗裁决。
async function continueFromPast(node) {
  const sourceId = node.kind === 'mirror' ? node.mirrorOf : node.id;
  const sourceDocId = node.kind === 'mirror' ? node.sourceDocId : state.activeDocId;
  const rev = { version: node.version, content: node.content ?? '' };
  exitTimeTravel();
  $('#timeline-panel').classList.add('hidden');
  if (sourceDocId && sourceDocId !== state.activeDocId) {
    const ok = await ensureOpen(sourceDocId);
    if (!ok) return;
    activateTab(sourceDocId);
  }
  // 源文档快照可能还在路上（尤其从跟读行跳回源大纲），等它到了再进编辑器
  for (let i = 0; i < 30 && !findRow(sourceId); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  restoreRevision(sourceId, rev);
}

/* ================= 冲突解决 ================= */

function openConflict(msg) {
  pendingConflict.current = msg;
  $('#conflict-title').textContent = '保存冲突：同一段被两个人改到了同一处';
  $('#conflict-sub').textContent =
    '你们基于同一版本改了重叠的内容，服务器没有替任何人覆盖。当前所有人看到的是「对方版本」；' +
    '请选择最终保留的文本——其他人在此版本之后的其它不冲突改动不会丢失。';
  $('#conflict-local-label').textContent = '你的版本';
  $('#conflict-remote-label').textContent = '对方版本（当前服务器内容，裁决前以此为准）';
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
  const c = pendingConflict.current;
  $('#conflict-mask').classList.add('hidden');
  pendingConflict.current = null;
  if (c && c.clientTag) {
    // 放弃同步这段离线改动：线上版本不动；原文存回本机草稿，不丢字
    const op = offlineQueue.find((o) => o.id === c.clientTag);
    if (op) {
      removeOp(op);
      draftStore[op.nodeId] = {
        content: op.content,
        baseVersion: op.baseVersion,
        restoreFromVersion: op.restoreFromVersion || null,
        at: Date.now(),
      };
      orphanDrafts.set(op.nodeId, draftStore[op.nodeId]);
      persistDraftsNow();
      toast('已放弃同步这段离线改动（线上版本不变）；原文已保留在本机草稿', '', 4600);
    }
    renderActiveDoc();
    return;
  }
  edit.saving = false;
  renderActiveDoc();
  if (edit.entryNodeId) focusEditor(edit.entryNodeId);
});
$('#conflict-save').addEventListener('click', () => {
  const c = pendingConflict.current;
  if (!c) return;
  const final = $('#conflict-final').value;
  const payload = {
    type: 'resolve',
    nodeId: c.nodeId, // 源 id
    content: final,
    keep: final === c.remote ? 'remote' : 'manual',
  };
  if (c.clientTag) payload.clientTag = c.clientTag; // 离线裁决：回执对号落队列
  const ok = send(payload);
  if (!ok) return;
  $('#conflict-mask').classList.add('hidden');
  pendingConflict.current = null;
  if (!c.clientTag) {
    edit.saving = true;
    send({ type: 'unlock', nodeId: c.nodeId });
  }
  toast('已提交最终版本', 'ok');
});

/* ================= 离开页面 ================= */

// 顶栏同步状态胶囊：点击立即把本机离线改动对齐到线上（含重试冲突段）
$('#sync-state').addEventListener('click', () => {
  if (!offlineQueue.length) return;
  if (!state.connected) {
    toast('离线中：改动已存本机，恢复连接后自动对齐', '');
    return;
  }
  flushOfflineQueue({ includeConflicts: true });
});

window.addEventListener('beforeunload', () => {
  if (edit.sourceId) {
    rememberDraft(); // 未保存的草稿落盘，下次打开还能找回
    persistDraftsNow();
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      try {
        state.ws.send(JSON.stringify({ type: 'unlock', nodeId: edit.sourceId }));
      } catch { /* ignore */ }
    }
  }
});
