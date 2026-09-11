'use strict';

/* 对外定稿页（只读观看者）
 *
 * 与工作稿完全隔离：WS hello 带 role:'viewer'，服务器只把这个连接放进
 * view:<docId> 房间，推送的只有 published_state / published_changed /
 * presence。工作稿的任何增量（正文、结构、锁、改写提议）都不会到达这里；
 * 服务器同时对 viewer 的一切写消息直接拒绝。
 *
 * 定稿切换是整树替换：published_changed 带着新版的全部行，观看者没有
 * "半新半旧"的中间状态——所有打开这页的人最终渲染的是同一份快照。
 */

const params = new URLSearchParams(location.search);
const docId = params.get('doc') || 'default';

const pubState = {
  ws: null,
  connected: false,
  pubSeq: 0,
  title: '',
  nodes: null, // null = 尚未收到；[] = 已定稿但为空树
  by: null,
  createdAt: null,
  timelineSeq: 0,
  users: new Map(),
};

const $ = (sel) => document.querySelector(sel);

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function initials(name) {
  return String(name || '?').trim().slice(0, 2).toUpperCase();
}

function toast(message, kind = '', ms = 2600) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toast-host').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 250);
  }, ms);
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  pubState.ws = ws;
  setConn('connecting');

  ws.addEventListener('open', () => {
    pubState.connected = true;
    setConn('online');
    // 观看者身份：不写 localStorage、不取编辑者身份，每次都是匿名只读
    ws.send(JSON.stringify({
      type: 'hello',
      role: 'viewer',
      docId,
      userId: 'v-' + Math.random().toString(36).slice(2, 10),
      userName: '外部观看者',
    }));
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleMessage(msg);
  });

  ws.addEventListener('close', () => {
    pubState.connected = false;
    setConn('offline');
    setTimeout(connect, 1200);
  });
  ws.addEventListener('error', () => { /* close 会接管 */ });
}

function setConn(status) {
  const dot = $('#pub-conn');
  dot.className = `conn-dot ${status}`;
  dot.title = { online: '已连接', offline: '已断开（自动重连中）', connecting: '连接中' }[status] || status;
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'published_state':
      ingest(msg);
      break;
    case 'published_changed':
      // 定稿切换：提示后整树替换
      if (pubState.pubSeq && msg.pubSeq > pubState.pubSeq) {
        toast(`定稿已更新到第 ${msg.pubSeq} 版（${msg.by?.userName || '有人'} 刚刚定出）`, 'ok', 3200);
      }
      ingest({
        docId: msg.docId,
        pubSeq: msg.pubSeq,
        timelineSeq: msg.timelineSeq,
        title: msg.title,
        nodes: msg.nodes,
        by: msg.by,
        createdAt: msg.createdAt,
      });
      break;
    case 'presence':
      pubState.users = new Map((msg.users || []).map((u) => [u.userId, u]));
      renderUsers();
      break;
    case 'error':
      if (msg.message === '大纲不存在') {
        $('#pub-title').textContent = '大纲不存在';
        $('#pub-loading').classList.add('hidden');
        $('#pub-empty').classList.remove('hidden');
        $('#pub-empty').querySelector('h3').textContent = '这份大纲不存在';
        $('#pub-empty').querySelector('p').textContent = '请向编辑者确认对外链接。';
      } else {
        toast(msg.message, 'error');
      }
      break;
    default:
      // 观看者不应收到任何工作稿消息；收到也一律忽略
      break;
  }
}

function ingest(msg) {
  pubState.pubSeq = msg.pubSeq;
  pubState.title = msg.title;
  pubState.nodes = msg.nodes;
  pubState.by = msg.by || null;
  pubState.createdAt = msg.createdAt || null;
  pubState.timelineSeq = msg.timelineSeq || 0;
  render();
}

function indexNodes(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map();
  for (const n of nodes) {
    const key = n.parentId ?? null;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(n.id);
  }
  for (const ids of children.values()) {
    ids.sort((a, b) => {
      const pa = byId.get(a).pos || '';
      const pb = byId.get(b).pos || '';
      return pa < pb ? -1 : pa > pb ? 1 : 0;
    });
  }
  return { byId, children };
}

function render() {
  $('#pub-title').textContent = pubState.title || '对外定稿';
  document.title = `${pubState.title || '对外定稿'} · 定稿`;
  const meta = [];
  if (pubState.pubSeq > 0) {
    meta.push(`第 ${pubState.pubSeq} 版`);
    if (pubState.createdAt) meta.push(`定稿于 ${fmtTime(pubState.createdAt)}`);
    if (pubState.by?.userName) meta.push(`定稿人：${pubState.by.userName}`);
  }
  $('#pub-meta').textContent = meta.join('　·　');

  $('#pub-loading').classList.add('hidden');
  const empty = $('#pub-empty');
  const outline = $('#pub-outline');
  if (pubState.nodes === null) {
    empty.classList.remove('hidden');
    empty.querySelector('h3').textContent = '这份大纲还没有定过稿';
    empty.querySelector('p').textContent = '编辑把工作稿「定出去」之后，这里才会出现内容；在此之前看不到工作稿。';
    outline.innerHTML = '';
    return;
  }
  empty.classList.add('hidden');
  renderOutline(outline, pubState.nodes);
}

function renderOutline(host, nodes) {
  const { byId, children } = indexNodes(nodes);
  host.innerHTML = '';
  const renderChildren = (parentId, container, depth) => {
    for (const id of children.get(parentId) || []) {
      const node = byId.get(id);
      if (!node) continue;
      const outer = document.createElement('div');
      outer.className = 'node-outer pub-node-outer';
      outer.dataset.nodeId = node.id;
      outer.style.marginLeft = depth ? '0' : '0';

      const row = document.createElement('div');
      row.className = 'node pub-node';

      const body = document.createElement('div');
      body.className = 'node-body';
      const text = document.createElement('div');
      text.className = 'node-text';
      if (node.kind === 'mirror' && node.sourceDeleted) {
        text.innerHTML = '<span class="pub-gone">（源段落在定稿时已删除）</span>';
      } else {
        text.textContent = node.content || '';
      }
      body.appendChild(text);
      if (node.kind === 'mirror' && !node.sourceDeleted) {
        const tag = document.createElement('span');
        tag.className = 'pub-mirror-tag';
        tag.textContent = '跟读';
        body.appendChild(tag);
      }
      row.appendChild(body);
      outer.appendChild(row);
      container.appendChild(outer);

      const kidWrap = document.createElement('div');
      kidWrap.className = 'node-children pub-children';
      outer.appendChild(kidWrap);
      renderChildren(id, kidWrap, depth + 1);
    }
  };
  const root = document.createElement('div');
  root.className = 'outline-tree';
  host.appendChild(root);
  renderChildren(null, root, 0);
}

function renderUsers() {
  const host = $('#pub-users');
  host.innerHTML = '';
  for (const u of pubState.users.values()) {
    const el = document.createElement('div');
    el.className = 'user-chip';
    el.title = u.userName;
    el.textContent = initials(u.userName);
    el.style.background = u.color || '#64748b';
    host.appendChild(el);
  }
}

connect();
