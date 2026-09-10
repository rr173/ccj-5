'use strict';

/* ================= 常量与状态 ================= */

const HEARTBEAT_MS = 8000; // 编辑期间每 8s 续租
const IDELE_RELEASE_MS = 30_000; // 本地 30s 无操作主动释放锁
const RECONNECT_DELAY = 1200;

const state = {
  ws: null,
  connected: false,
  me: null,                 // { userId, userName, color }
  title: '',
  treeRev: 0,
  nodes: new Map(),         // id -> node
  children: new Map(),      // parentId(null=根) -> [id]
  order: [],                // 渲染辅助
  locks: new Map(),         // nodeId -> { userId, userName, color }
  users: new Map(),         // userId -> user
  editingId: null,          // 当前正在编辑的 nodeId
  baseVersion: 0,           // 本次编辑基于的版本
  restoreFromVersion: null, // 非 null 表示是"从历史版本回退后继续编辑"
  draft: '',
  orphanedDraft: null,      // 锁被 TTL 收走时暂存的草稿，重新编辑可恢复
  lastInputAt: 0,
  pendingConflict: null,    // 未解决的冲突上下文
  historyNodeId: null,
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
  const t = String(name || '?').trim();
  return t.slice(0, 2).toUpperCase();
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

let toastSeq = 0;
function toast(message, kind = '', ms = 2600) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toast-host').appendChild(el);
  const id = ++toastSeq;
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 250);
  }, ms);
  return id;
}

/* ================= 登录与身份 ================= */

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

function prefillName() {
  const saved = localStorage.getItem('outline.userName');
  if (saved) $('#name-input').value = saved;
  $('#name-input').focus();
}
prefillName();

/* ================= WebSocket ================= */

function connect(name) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;
  setConn('connecting');

  ws.addEventListener('open', () => {
    state.connected = true;
    setConn('online');
    send({
      type: 'hello',
      userId: getIdentity(),
      userName: name,
    });
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleMessage(msg);
  });

  ws.addEventListener('close', () => {
    state.connected = false;
    setConn('offline');
    // 断线时编辑状态全部失效；重连后用快照重建
    state.editingId = null;
    state.locks.clear();
    renderUsers();
    renderOutline();
    setTimeout(() => {
      if (!state.connected) connect(name);
    }, RECONNECT_DELAY);
  });

  ws.addEventListener('error', () => { /* close 会接管 */ });
}

function send(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
    return true;
  }
  toast('连接已断开，正在重连…', 'error');
  return false;
}

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
    case 'snapshot':
      ingestSnapshot(msg);
      break;
    case 'presence':
      state.users = new Map(msg.users.map((u) => [u.userId, u]));
      renderUsers();
      break;
    case 'locked':
      state.locks.set(msg.nodeId, msg.user);
      patchNodeLock(msg.nodeId);
      break;
    case 'unlocked':
      state.locks.delete(msg.nodeId);
      patchNodeLock(msg.nodeId);
      // 自己手里的锁被 TTL 收走：草稿保留在内存，退出编辑态但提示可一键重开
      if (state.editingId === msg.nodeId) {
        state.orphanedDraft = { nodeId: msg.nodeId, text: state.draft };
        stopEditing(msg.reason === 'ttl'
          ? '编辑锁因长时间无操作被自动释放（草稿已保留，重新点编辑可继续）'
          : '编辑锁已被释放（草稿已保留）');
      }
      break;
    case 'lock_denied':
      toast(`${msg.holder.userName} 正在编辑这一段`, 'error');
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
      });
      break;
    case 'saved':
      // noop 保存（内容无变化）
      break;
    case 'conflict':
      openConflict(msg);
      break;
    case 'history':
      renderHistory(msg);
      break;
    case 'node_added':
      upsertNode(msg.node);
      state.treeRev = msg.treeRev;
      renderOutline();
      break;
    case 'node_moved':
      applyMove(msg);
      break;
    case 'nodes_deleted':
      applyDeleted(msg);
      break;
    case 'tree_stale':
      state.treeRev = msg.treeRev;
      toast('树结构刚被别人改过，已为你刷新', 'error');
      // 服务器会紧接发 snapshot
      break;
    case 'heartbeat_ack':
      // 正常续租；ok=false 说明锁已不属于自己
      if (msg.ok === false && state.editingId === msg.nodeId) {
        stopEditing('编辑锁已失效');
      }
      break;
    case 'error':
      toast(msg.message || '操作失败', 'error');
      break;
  }
}

/* ================= 快照与增量维护 ================= */

function ingestSnapshot(msg) {
  state.title = msg.title;
  state.treeRev = msg.treeRev;
  state.nodes = new Map(msg.nodes.map((n) => [n.id, n]));
  state.locks = new Map((msg.locks || []).map((l) => [l.nodeId, l]));
  state.users = new Map((msg.users || []).map((u) => [u.userId, u]));
  $('#doc-title').textContent = state.title;
  indexChildren();
  renderUsers();
  renderOutline();
  // 重连后若历史抽屉开着，刷新
  if (state.historyNodeId) send({ type: 'history', nodeId: state.historyNodeId });
}

function indexChildren() {
  const children = new Map();
  for (const node of state.nodes.values()) {
    const key = node.parentId ?? null;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(node.id);
  }
  for (const ids of children.values()) {
    ids.sort((a, b) => {
      const pa = state.nodes.get(a).pos || '';
      const pb = state.nodes.get(b).pos || '';
      return pa < pb ? -1 : pa > pb ? 1 : 0;
    });
  }
  state.children = children;
}

function upsertNode(node) {
  state.nodes.set(node.id, node);
  indexChildren();
}

function applyContent(msg) {
  const node = state.nodes.get(msg.nodeId);
  if (!node) return; // 已删除或尚未收到
  const wasEditing = state.editingId === msg.nodeId;
  node.version = msg.version;
  node.content = msg.content;
  node.author = msg.author;
  node.authorId = msg.authorId;
  node.updatedAt = msg.updatedAt;
  if (wasEditing) {
    // 自己保存的回执；他人内容不会在自己持锁时到达
    state.baseVersion = msg.version;
    renderOutline();
    flashNode(msg.nodeId);
  } else {
    patchNodeContent(msg.nodeId);
    flashNode(msg.nodeId);
  }
  if (state.historyNodeId === msg.nodeId) {
    send({ type: 'history', nodeId: msg.nodeId });
  }
}

function applyMove(msg) {
  state.treeRev = msg.treeRev;
  const node = state.nodes.get(msg.nodeId);
  if (!node) return;
  node.parentId = msg.parentId;
  node.pos = msg.pos;
  indexChildren();
  renderOutline();
}

function applyDeleted(msg) {
  state.treeRev = msg.treeRev;
  for (const id of msg.ids) {
    state.nodes.delete(id);
    state.locks.delete(id);
  }
  indexChildren();
  if (state.editingId && msg.ids.includes(state.editingId)) stopEditing('段落被删除');
  renderOutline();
}

/* ================= 渲染：在线用户 ================= */

function renderUsers() {
  const host = $('#users');
  host.innerHTML = '';
  for (const u of state.users.values()) {
    const chip = document.createElement('span');
    chip.className = 'user-chip';
    chip.title = u.userName;
    chip.innerHTML =
      `<span class="avatar" style="background:${escapeHtml(u.color)}">${escapeHtml(initials(u.userName))}</span>`;
    host.appendChild(chip);
  }
}

/* ================= 渲染：大纲树 ================= */

function depthOf(nodeId) {
  let d = 0;
  let cur = state.nodes.get(nodeId);
  const guard = new Set();
  while (cur && cur.parentId && !guard.has(cur.id)) {
    guard.add(cur.id);
    d++;
    cur = state.nodes.get(cur.parentId);
  }
  return d;
}

function renderOutline() {
  const root = $('#outline');
  root.innerHTML = '';
  const roots = state.children.get(null) || [];
  for (const id of roots) root.appendChild(renderNode(id));
}

function renderNode(id) {
  const node = state.nodes.get(id);
  const wrap = document.createElement('div');
  wrap.className = 'node-outer';
  wrap.dataset.nodeId = id;
  wrap.appendChild(renderNodeRow(node));
  const kids = state.children.get(id);
  if (kids && kids.length) {
    const childWrap = document.createElement('div');
    childWrap.className = 'children';
    for (const cid of kids) childWrap.appendChild(renderNode(cid));
    wrap.appendChild(childWrap);
  }
  return wrap;
}

function renderNodeRow(node) {
  const isEditing = state.editingId === node.id;
  const lock = state.locks.get(node.id);
  const lockedByMe = lock && state.me && lock.userId === state.me.userId;
  const lockedByOther = lock && (!state.me || lock.userId !== state.me.userId);

  const el = document.createElement('div');
  el.className = 'node';
  el.dataset.nodeId = node.id;
  if (isEditing || lockedByMe) el.classList.add('locked-by-me');
  if (lockedByOther) el.classList.add('locked-by-other');

  if (isEditing) {
    el.appendChild(renderEditor(node));
    return el;
  }

  const row = document.createElement('div');
  row.className = 'node-row';

  // 缩进占位由 .children 层级完成；这里放内容
  const content = document.createElement('div');
  content.className = 'node-content' + (node.content ? '' : ' placeholder');
  content.textContent = node.content || '（空段落）';
  row.appendChild(content);

  const actions = document.createElement('div');
  actions.className = 'node-actions';
  actions.append(
    actionBtn('编辑', () => beginEdit(node.id)),
    actionBtn('＋ 子级', () => addNode(node.id, null)),
    actionBtn('＋ 同级', () => addNode(node.parentId, node.id)),
    actionBtn('历史', () => openHistory(node.id)),
  );
  row.appendChild(actions);
  el.appendChild(row);

  const meta = document.createElement('div');
  meta.className = 'node-meta';
  meta.innerHTML = `<span class="version-tag">v${node.version ?? 1}</span>`;
  if (node.author) {
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

function actionBtn(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function flashNode(nodeId) {
  const el = document.querySelector(`.node[data-node-id="${cssEscape(nodeId)}"]`);
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

function cssEscape(s) {
  return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
}

/* 局部补丁：内容/锁变化不整树重绘（避免打断 hover、滚动） */
function patchNodeContent(nodeId) {
  const outer = document.querySelector(`.node-outer[data-node-id="${cssEscape(nodeId)}"]`);
  if (!outer || state.editingId === nodeId) return;
  const node = state.nodes.get(nodeId);
  const fresh = renderNodeRow(node);
  const old = outer.querySelector(':scope > .node');
  if (old) old.replaceWith(fresh);
}

function patchNodeLock(nodeId) {
  const outer = document.querySelector(`.node-outer[data-node-id="${cssEscape(nodeId)}"]`);
  if (!outer || state.editingId === nodeId) return;
  patchNodeContent(nodeId);
}

/* ================= 编辑器与锁 ================= */

let heartbeatTimer = null;
let idleTimer = null;

function beginEdit(nodeId) {
  if (state.editingId) {
    toast('请先保存或取消当前编辑', 'error');
    return;
  }
  const lock = state.locks.get(nodeId);
  if (lock && state.me && lock.userId !== state.me.userId) {
    toast(`${lock.userName} 正在编辑这一段`, 'error');
    return;
  }
  // 先乐观进入编辑态，同时向服务器申请锁
  state.editingId = nodeId;
  state.baseVersion = state.nodes.get(nodeId).version;
  state.restoreFromVersion = null;
  // 恢复被 TTL 打断时暂存的草稿（基准仍是当前版本，保存时走三方合并）
  if (state.orphanedDraft && state.orphanedDraft.nodeId === nodeId) {
    state.draft = state.orphanedDraft.text;
    state.orphanedDraft = null;
    toast('已恢复你未保存的草稿，保存时会与服务器版本自动合并', 'ok', 3600);
  } else {
    state.draft = state.nodes.get(nodeId).content || '';
  }
  state.lastInputAt = Date.now();
  renderOutline();
  send({ type: 'lock', nodeId });
  focusEditor(nodeId);
  startLockTimers(nodeId);
  updateEditingHint();
}

function focusEditor(nodeId) {
  const ta = document.querySelector(`.node[data-node-id="${cssEscape(nodeId)}"] textarea`);
  if (ta) {
    ta.focus();
    const len = ta.value.length;
    ta.setSelectionRange(len, len);
  }
}

function renderEditor(node) {
  const box = document.createElement('div');
  box.className = 'node-edit';
  box.style.padding = '8px 10px';

  const ta = document.createElement('textarea');
  ta.value = state.editingId === node.id ? state.draft : node.content || '';
  ta.placeholder = '输入段落内容…';
  ta.addEventListener('input', () => {
    state.draft = ta.value;
    state.lastInputAt = Date.now();
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
  tools.append(
    toolBtn('⇥ 降级', () => indent(node.id, +1)),
    toolBtn('⇤ 升级', () => indent(node.id, -1)),
    toolBtn('↑ 上移', () => moveVertical(node.id, -1)),
    toolBtn('↓ 下移', () => moveVertical(node.id, +1)),
    toolBtn('删除', () => deleteNode(node.id), true),
  );
  bar.appendChild(tools);

  const right = document.createElement('div');
  right.style.display = 'flex';
  right.style.gap = '8px';
  right.style.alignItems = 'center';
  right.innerHTML =
    `<span class="hint-inline"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> 保存 · <kbd>Esc</kbd> 取消 · ` +
    (state.restoreFromVersion
      ? `从历史 <b>v${state.restoreFromVersion}</b> 继续编辑（保存时自动保留他人不冲突改动）`
      : `基于 v${state.baseVersion}`) +
    `</span>`;
  const cancel = document.createElement('button');
  cancel.className = 'ghost';
  cancel.textContent = '取消';
  cancel.addEventListener('click', cancelEdit);
  const save = document.createElement('button');
  save.className = 'primary';
  save.textContent = '保存';
  save.addEventListener('click', saveEdit);
  right.append(cancel, save);
  bar.appendChild(right);

  box.appendChild(bar);
  return box;
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

function startLockTimers(nodeId) {
  clearInterval(heartbeatTimer);
  clearTimeout(idleTimer);
  heartbeatTimer = setInterval(() => {
    if (state.editingId !== nodeId) return;
    // 30s 无本地输入：主动交锁，避免"人开着页面去开会"一直占着
    if (Date.now() - state.lastInputAt > IDELE_RELEASE_MS) {
      toast('长时间未输入，已自动释放编辑锁', '');
      send({ type: 'unlock', nodeId });
      stopEditing('编辑锁因无操作已释放');
      return;
    }
    send({ type: 'heartbeat', nodeId });
  }, HEARTBEAT_MS);
}

function stopEditing(reason) {
  const id = state.editingId;
  state.editingId = null;
  state.restoreFromVersion = null;
  clearInterval(heartbeatTimer);
  clearTimeout(idleTimer);
  updateEditingHint();
  renderOutline();
  if (id && reason) toast(reason, reason.includes('失效') || reason.includes('释放') ? 'error' : '');
}

function cancelEdit() {
  const id = state.editingId;
  if (id) send({ type: 'unlock', nodeId: id });
  stopEditing();
}

function saveEdit() {
  const nodeId = state.editingId;
  if (!nodeId) return;
  const payload = state.restoreFromVersion
    ? {
        type: 'restore_save',
        nodeId,
        content: state.draft,
        restoreVersion: state.restoreFromVersion,
      }
    : {
        type: 'save',
        nodeId,
        content: state.draft,
        baseVersion: state.baseVersion,
      };
  const ok = send(payload);
  if (!ok) return;
  // 乐观结束编辑态；若冲突服务器会回 conflict -> openConflict 重新处理
  send({ type: 'unlock', nodeId });
  state.editingId = null;
  state.restoreFromVersion = null;
  clearInterval(heartbeatTimer);
  clearTimeout(idleTimer);
  updateEditingHint();
  renderOutline();
}

function updateEditingHint() {
  const hint = $('#editing-hint');
  if (state.editingId) {
    hint.classList.remove('hidden');
    hint.textContent = '编辑中：修改会实时占用该段落，30 秒无操作自动释放';
  } else {
    hint.classList.add('hidden');
  }
}

/* ================= 结构操作 ================= */

// 计算"把 nodeId 移到 targetParent 下 afterId 之后"的请求；成功与否以服务器确认为准
function requestMove(nodeId, parentId, afterId) {
  if (parentId === nodeId) return;
  send({ type: 'move', nodeId, parentId, afterId: afterId || '', treeRev: state.treeRev });
}

function siblingsInfo(nodeId) {
  const node = state.nodes.get(nodeId);
  if (!node) return null;
  const parentId = node.parentId;
  const ids = (state.children.get(parentId) || []).filter((x) => x !== nodeId);
  return { parentId, ids, current: node };
}

function moveVertical(nodeId, dir) {
  const info = siblingsInfo(nodeId);
  if (!info) return;
  const all = (state.children.get(info.parentId) || []).slice();
  const i = all.indexOf(nodeId);
  const j = i + dir;
  if (j < 0 || j >= all.length) {
    toast(dir < 0 ? '已经是最前面了' : '已经是最后面了');
    return;
  }
  // 与相邻节点交换：插到它前/后
  if (dir < 0) {
    const neighborPrevId = j === 0 ? null : all[j - 1];
    requestMove(nodeId, info.parentId, neighborPrevId);
  } else {
    requestMove(nodeId, info.parentId, all[j]);
  }
}

function indent(nodeId, delta) {
  const node = state.nodes.get(nodeId);
  if (!node) return;
  if (delta > 0) {
    // 降级：成为前一个同级的最后一个子级
    const ids = state.children.get(node.parentId) || [];
    const i = ids.indexOf(nodeId);
    if (i <= 0) {
      toast('前面没有段落可以挂接，无法降级');
      return;
    }
    const newParent = ids[i - 1];
    // 插到 newParent 子级的末尾
    const kids = state.children.get(newParent) || [];
    requestMove(nodeId, newParent, kids.length ? kids[kids.length - 1] : '');
  } else {
    // 升级：挂到祖父的同级，排在原父节点之后
    const parent = node.parentId ? state.nodes.get(node.parentId) : null;
    if (!parent) {
      toast('已经是顶层段落');
      return;
    }
    requestMove(nodeId, parent.parentId, parent.id);
  }
}

function addNode(parentId, afterId) {
  send({
    type: 'add',
    parentId: parentId || '',
    afterId: afterId || '',
    content: '',
    treeRev: state.treeRev,
  });
}

$('#add-root').addEventListener('click', () => addNode(null, null));

function deleteNode(nodeId) {
  if (!confirm('确定删除该段落及其所有子段落？（历史仍保留，但视图中会移除）')) return;
  send({ type: 'delete', nodeId, treeRev: state.treeRev });
  if (state.editingId === nodeId) stopEditing();
}

/* ================= 历史与回退 ================= */

function openHistory(nodeId) {
  state.historyNodeId = nodeId;
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
  const node = state.nodes.get(msg.nodeId);
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

// 回退 = 把旧内容作为草稿载入编辑器。保存时 baseVersion 仍是当前版本，
// 于是服务端会执行 merge3(当前服务器, 旧草稿, ...)：
//   - 别人之后在别处的改动会自动保留（三方合并）；
//   - 与旧内容重叠且与你"回退意图"冲突的，才弹冲突窗人工裁决。
function restoreRevision(nodeId, rev) {
  const node = state.nodes.get(nodeId);
  if (!node) {
    toast('该段落已不存在', 'error');
    return;
  }
  if (state.editingId && state.editingId !== nodeId) {
    toast('请先结束当前段落的编辑', 'error');
    return;
  }
  const lock = state.locks.get(nodeId);
  if (lock && state.me && lock.userId !== state.me.userId) {
    toast(`${lock.userName} 正在编辑这一段，稍候再试`, 'error');
    return;
  }
  $('#history-panel').classList.add('hidden');

  const wasNotEditing = state.editingId !== nodeId;
  state.editingId = nodeId;
  state.baseVersion = node.version; // 展示用
  state.restoreFromVersion = rev.version; // 保存时按 diff4 合并
  state.draft = rev.content;
  state.lastInputAt = Date.now();
  renderOutline();
  if (wasNotEditing) {
    send({ type: 'lock', nodeId });
    startLockTimers(nodeId);
  }
  focusEditor(nodeId);
  updateEditingHint();
  toast(
    `已载入 v${rev.version} 的内容作为草稿。保存时将与当前 v${node.version} 合并，` +
    '其他人不冲突的改动会保留',
    'ok',
    4200,
  );
}

/* ================= 冲突解决 ================= */

function openConflict(msg) {
  state.pendingConflict = msg;
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
  state.pendingConflict = null;
  // 放弃本地草稿，退出编辑
  stopEditing();
});
$('#conflict-save').addEventListener('click', () => {
  const c = state.pendingConflict;
  if (!c) return;
  const final = $('#conflict-final').value;
  send({
    type: 'resolve',
    nodeId: c.nodeId,
    content: final,
    keep: final === c.remote ? 'remote' : 'manual',
  });
  $('#conflict-mask').classList.add('hidden');
  state.pendingConflict = null;
  // 若锁还在则释放
  send({ type: 'unlock', nodeId: c.nodeId });
  state.editingId = null;
  clearInterval(heartbeatTimer);
  clearTimeout(idleTimer);
  updateEditingHint();
  renderOutline();
  toast('已提交最终版本', 'ok');
});

/* ================= 离开页面：立即释放锁 ================= */

window.addEventListener('beforeunload', () => {
  if (state.editingId && state.ws && state.ws.readyState === WebSocket.OPEN) {
    // 尽力同步发送解锁；服务端 close 事件会兜底
    try {
      state.ws.send(JSON.stringify({ type: 'unlock', nodeId: state.editingId }));
    } catch { /* ignore */ }
  }
});
