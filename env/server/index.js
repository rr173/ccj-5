'use strict';

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

const store = require('./db');
const { LockManager } = require('./locks');
const { merge3 } = require('./merge');
const { midpoint } = require('./fraction');

const PORT = Number(process.env.PORT || process.env.WS_PORT || 3000);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'app.db');
const LOCK_TTL = Number(process.env.LOCK_TTL_MS || 30000);

const COLORS = [
  '#e11d48', '#2563eb', '#059669', '#d97706', '#7c3aed',
  '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5',
];
function colorFor(userId) {
  let h = 0;
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

const db = store.init(DB_FILE);
const locks = new LockManager({ ttlMs: LOCK_TTL });

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/api/health', (_req, res) => res.json({ ok: true }));
// 对外定稿页（只读观看者入口）；必须在 SPA 兜底之前
app.get('/published', (_req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'published.html')),
);
app.get(/^\/published\/$/, (_req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'published.html')),
);
// SPA 兜底
app.get(/^(?!\/api).*/, (_req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html')),
);

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });

server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://localhost').pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// connId -> { ws, user: {userId, userName, color}, rooms: Set<docId> }
const peers = new Map();

// 讲解轮次是文档级的临时协作状态（不入库）：
// 同一时刻每份大纲最多一个讲解者；服务器是唯一事实源，客户端不做乐观抢占。
// nodeId 可以是普通段落，也可以是本文档里的跟读行。
const presentations = new Map();

function send(peer, msg) {
  if (peer.ws.readyState === peer.ws.OPEN) peer.ws.send(JSON.stringify(msg));
}

function sendToDoc(docId, msg, exceptConnId = null) {
  const data = JSON.stringify(msg);
  for (const [connId, peer] of peers) {
    if (connId === exceptConnId) continue;
    if (!peer.rooms || !peer.rooms.has(docId)) continue;
    if (peer.ws.readyState === peer.ws.OPEN) peer.ws.send(data);
  }
}

function publicUser(user) {
  return { userId: user.userId, userName: user.userName, color: user.color };
}

function getPresentation(docId) {
  return presentations.get(docId) || null;
}

function presentationMessage(docId) {
  const p = getPresentation(docId);
  if (!p) return { type: 'presentation', docId, active: false };
  return {
    type: 'presentation',
    docId,
    active: true,
    leader: publicUser(p.leader),
    nodeId: p.nodeId,
    offer: p.offer ? { userId: p.offer.userId, userName: p.offer.userName } : null,
  };
}

function broadcastPresentation(docId, exceptConnId = null) {
  sendToDoc(docId, presentationMessage(docId), exceptConnId);
}

function presentationNodeExists(docId, nodeId) {
  const row = store.getNode(db, nodeId);
  return !!row && row.doc_id === docId && !row.deleted;
}

function denyWriteWhileFollowing(peer, docId, extra = {}) {
  const current = getPresentation(docId);
  if (!current || current.leader.userId === peer.user.userId) return true;
  send(peer, {
    type: 'presentation_denied',
    docId,
    leader: publicUser(current.leader),
    nodeId: current.nodeId,
    write: true,
    ...extra,
    message: extra.message ||
      `${current.leader.userName} 正在讲这一轮，跟读时不能修改；等 TA 交棒后再操作`,
  });
  return false;
}

// 源段落可能同时以跟读身份出现在多份大纲。只要其中一处正在讲解，
// 就不能从源行或另一个挂载点把内容改掉，避免讲着的段落变化。
function denySourceWriteWhileFollowing(peer, sourceId) {
  for (const docId of audienceDocIds(sourceId)) {
    if (!denyWriteWhileFollowing(peer, docId, { nodeId: sourceId })) return false;
  }
  return true;
}

// 讲解中的源段落被删除时，普通行已不在文档里；跟读行仍会保留成墓碑。
// 本轮不再指段，等待讲解者重新开始或交给下一位。
function clearPresentationIfPointing(docId, nodeIds, exceptConnId = null) {
  const p = getPresentation(docId);
  if (p && nodeIds.includes(p.nodeId)) {
    presentations.delete(docId);
    broadcastPresentation(docId, exceptConnId);
  }
}

// 对外定稿观看者房间：viewer 只收定稿相关消息，工作稿的任何增量都不扇出到这里。
function sendToViewers(docId, msg, exceptConnId = null) {
  const data = JSON.stringify(msg);
  for (const [connId, peer] of peers) {
    if (connId === exceptConnId) continue;
    if (!peer.viewRooms || !peer.viewRooms.has(docId)) continue;
    if (peer.ws.readyState === peer.ws.OPEN) peer.ws.send(data);
  }
}

// 定稿状态变化：观看者整树替换，编辑者同步顶栏的定稿信息。
function broadcastPublication(publication, exceptConnId = null) {
  const msg = {
    type: 'published_changed',
    docId: publication.docId,
    pubSeq: publication.pubSeq,
    timelineSeq: publication.timelineSeq,
    title: publication.title,
    nodes: publication.nodes,
    by: { userId: publication.authorId, userName: publication.author },
    createdAt: publication.createdAt,
  };
  sendToViewers(publication.docId, msg, exceptConnId);
  sendToDoc(publication.docId, msg, exceptConnId);
}

function sendToDocs(docIds, msg, exceptConnId = null) {
  for (const docId of new Set(docIds)) sendToDoc(docId, msg, exceptConnId);
}

function presenceList(docId) {
  const out = [];
  for (const peer of peers.values()) {
    if (peer.rooms && peer.rooms.has(docId)) out.push(peer.user);
  }
  return out;
}

// 源节点变更（正文/锁）需要扇出到的全部文档：
// 源所在文档 + 每一处挂载了该源跟读的宿主文档（跟读可能跨多份大纲）。
function audienceDocIds(sourceIds) {
  const ids = Array.isArray(sourceIds) ? sourceIds : [sourceIds];
  const docs = new Set();
  for (const id of ids) {
    const node = store.getNode(db, id);
    if (node) docs.add(node.doc_id);
    for (const d of store.mirrorHostDocs(db, id)) docs.add(d);
  }
  return [...docs];
}

// 把行节点 id（可能是跟读 id）解析成源节点；返回 { source } 或 { error }
function resolveEditable(nodeId) {
  const row = store.getNode(db, nodeId);
  if (!row || row.deleted) return { error: '该段落已被删除' };
  if (row.mirror_of) {
    const source = store.resolveSource(db, nodeId);
    if (!source || source.deleted) return { error: '跟读的源段落已被删除' };
    return { source, host: row };
  }
  return { source: row };
}

function snapshotMessage(docId) {
  const snap = store.getSnapshot(db, docId);
  const pub = store.getCurrentPublication(db, docId);
  const presentation = getPresentation(docId);
  return {
    type: 'snapshot',
    docId: snap.doc.id,
    title: snap.doc.title,
    treeRev: snap.doc.tree_rev,
    nodes: snap.nodes,
    locks: relevantLocks(docId, snap.nodes),
    presentation: presentation
      ? {
          leader: publicUser(presentation.leader),
          nodeId: presentation.nodeId,
          offer: presentation.offer
            ? { userId: presentation.offer.userId, userName: presentation.offer.userName }
            : null,
        }
      : null,
    suggestions: relevantSuggestions(snap.nodes),
    users: presenceList(docId),
    published: pub
      ? {
          pubSeq: pub.pubSeq,
          timelineSeq: pub.timelineSeq,
          title: pub.title,
          by: { userId: pub.authorId, userName: pub.author },
          createdAt: pub.createdAt,
        }
      : null,
  };
}

// 快照里只带本文档看得见的锁：源段落在本文档，或本文档挂着它的跟读
function relevantLocks(docId, nodes) {
  const sourceIds = visibleSourceIds(nodes);
  return locks.list().filter((l) => sourceIds.has(l.nodeId));
}

// 快照只带当前文档可见源段的待决改写（源行与跟读行共用同一份）
function relevantSuggestions(nodes) {
  return store.listPendingSuggestions(db, [...visibleSourceIds(nodes)]);
}

function visibleSourceIds(nodes) {
  const sourceIds = new Set();
  for (const n of nodes) {
    if (n.kind === 'mirror') sourceIds.add(n.mirrorOf);
    else sourceIds.add(n.id);
  }
  return sourceIds;
}

function docListMessage() {
  return { type: 'doc_list', docs: store.listDocuments(db) };
}

// ---------- 文档房间 ----------

function handleHello(peer, msg) {
  const userId = String(msg.userId || crypto.randomUUID());
  const userName = String(msg.userName || (msg.role === 'viewer' ? '外部观看者' : '匿名用户')).slice(0, 40);
  const role = msg.role === 'viewer' ? 'viewer' : 'editor';
  peer.user = { userId, userName, color: colorFor(userId) };
  peer.role = role;
  peer.rooms = new Set();
  peer.viewRooms = new Set();
  send(peer, { type: 'hello', user: peer.user, role });

  // 对外定稿页：hello 即带上要观看的文档，直接进观看房间，永远拿不到工作稿
  if (role === 'viewer') {
    const docId = String(msg.docId || '');
    if (docId) joinViewRoom(peer, docId);
    return;
  }

  send(peer, docListMessage());

  // 进入即打开默认大纲（保持单文档时代的交互/旧协议兼容）
  joinDoc(peer, store.DEFAULT_DOC);
}

// ---------- 对外定稿：观看房间（只读） ----------

function publishedStateMessage(docId) {
  const pub = store.getCurrentPublication(db, docId);
  if (!pub) {
    const doc = store.getDoc(db, docId);
    return {
      type: 'published_state',
      docId,
      pubSeq: 0,
      title: doc ? doc.title : '',
      nodes: null, // null = 从未定稿，观看端显示空状态，绝不回退到工作稿
    };
  }
  return {
    type: 'published_state',
    docId,
    pubSeq: pub.pubSeq,
    timelineSeq: pub.timelineSeq,
    title: pub.title,
    nodes: pub.nodes,
    by: { userId: pub.authorId, userName: pub.author },
    createdAt: pub.createdAt,
  };
}

function joinViewRoom(peer, docId) {
  const doc = store.getDoc(db, docId);
  if (!doc) {
    send(peer, { type: 'error', message: '大纲不存在' });
    return;
  }
  peer.viewRooms.add(docId);
  send(peer, publishedStateMessage(docId));
  sendToViewers(docId, { type: 'presence', docId, scope: 'published', users: viewerPresence(docId) }, peer.connId);
}

function viewerPresence(docId) {
  const out = [];
  for (const peer of peers.values()) {
    if (peer.viewRooms && peer.viewRooms.has(docId)) out.push(peer.user);
  }
  return out;
}

function handleOpenPublished(peer, msg) {
  const docId = String(msg.docId || '');
  if (!store.getDoc(db, docId)) {
    send(peer, { type: 'error', message: '大纲不存在' });
    return;
  }
  if (!peer.viewRooms.has(docId)) {
    joinViewRoom(peer, docId);
  } else {
    send(peer, publishedStateMessage(docId));
  }
}

function handleLeavePublished(peer, msg) {
  const docId = String(msg.docId || '');
  if (peer.viewRooms.delete(docId)) {
    sendToViewers(docId, { type: 'presence', docId, scope: 'published', users: viewerPresence(docId) });
  }
}

// ---------- 定稿（发布）：只有编辑者；CAS 防并发双定 ----------

function handlePublish(peer, msg) {
  if (peer.role === 'viewer') {
    send(peer, { type: 'error', message: '对外定稿页是只读的' });
    return;
  }
  const docId = String(msg.docId || '');
  const doc = store.getDoc(db, docId);
  if (!doc) {
    send(peer, { type: 'error', message: '大纲不存在' });
    return;
  }
  if (!denyWriteWhileFollowing(peer, docId)) return;
  const basePubSeq = Number(msg.basePubSeq);
  if (!Number.isInteger(basePubSeq) || basePubSeq < 0) {
    send(peer, { type: 'error', docId, message: '缺少定稿基准序号' });
    return;
  }
  const result = store.publishDoc(db, {
    docId,
    basePubSeq,
    userId: peer.user.userId,
    userName: peer.user.userName,
  });
  if (result.status === 'missing') {
    send(peer, { type: 'error', docId, message: '大纲不存在' });
    return;
  }
  if (result.status === 'stale') {
    // 别人刚定过一版：把最新定稿带给后来者，由他确认后基于新版重新定
    send(peer, {
      type: 'publish_stale',
      docId,
      current: result.current
        ? {
            pubSeq: result.current.pubSeq,
            title: result.current.title,
            by: result.current.author,
            createdAt: result.current.createdAt,
          }
        : { pubSeq: 0 },
      message: '在你确认期间已有人定出新版，请看一眼当前定稿后再决定是否把工作稿重新定出去',
    });
    return;
  }
  if (result.status === 'unchanged') {
    send(peer, {
      type: 'published_ack',
      docId,
      pubSeq: result.publication.pubSeq,
      unchanged: true,
      message: '工作稿与当前定稿一致，没有产生新版本',
    });
    return;
  }

  send(peer, {
    type: 'published_ack',
    docId,
    pubSeq: result.publication.pubSeq,
    timelineSeq: result.publication.timelineSeq,
  });
  broadcastPublication(result.publication);
}

function joinDoc(peer, docId) {
  const doc = store.getDoc(db, docId);
  if (!doc) {
    send(peer, { type: 'error', message: '大纲不存在' });
    return;
  }
  peer.rooms.add(docId);
  send(peer, snapshotMessage(docId));
  sendToDoc(docId, { type: 'presence', docId, users: presenceList(docId) }, peer.connId);
}

function handleOpenDoc(peer, msg) {
  const docId = String(msg.docId || '');
  if (!docId || !store.getDoc(db, docId)) {
    send(peer, { type: 'error', message: '大纲不存在' });
    return;
  }
  if (!peer.rooms.has(docId)) joinDoc(peer, docId);
  else send(peer, snapshotMessage(docId)); // 已订阅：仅刷新快照
}

function handleLeaveDoc(peer, msg) {
  const docId = String(msg.docId || '');
  if (peer.rooms.delete(docId)) {
    sendToDoc(docId, { type: 'presence', docId, users: presenceList(docId) });
  }
}

function handleCreateDoc(peer, msg) {
  const title = String(msg.title || '').trim().slice(0, 80) || '未命名大纲';
  const id = crypto.randomUUID();
  store.createDocument(db, { id, title });
  send(peer, { type: 'doc_created', doc: store.getDoc(db, id) });
  // 所有在线端刷新大纲列表
  for (const p of peers.values()) send(p, docListMessage());
  joinDoc(peer, id);
}

// ---------- 锁（占用提示）。跟读上的编辑占用 = 源段落的锁 ----------

function handleLock(peer, msg) {
  const nodeId = String(msg.nodeId || '');
  const resolved = resolveEditable(nodeId);
  if (resolved.error) {
    send(peer, { type: 'error', nodeId, message: resolved.error });
    return;
  }
  const sourceId = resolved.source.id;
  const prev = locks.locks.get(sourceId);
  const held = locks.acquire(sourceId, peer.user, peer.connId);
  if (held) {
    send(peer, { type: 'lock_denied', nodeId: sourceId, holder: sanitizeLock(held) });
    return;
  }
  const reacquired = !!prev && prev.userId === peer.user.userId;
  send(peer, { type: 'lock_acquired', nodeId: sourceId, reacquired });
  if (!reacquired) {
    // 源文档 + 所有挂了跟读的文档都要立刻看到"有人占用"
    sendToDocs(audienceDocIds(sourceId), {
      type: 'locked',
      nodeId: sourceId,
      user: { userId: peer.user.userId, userName: peer.user.userName, color: peer.user.color },
    }, peer.connId);
  }
}

function sanitizeLock(lock) {
  return { userId: lock.userId, userName: lock.userName, color: lock.color };
}

function handleUnlock(peer, msg) {
  const nodeId = String(msg.nodeId || '');
  const row = store.getNode(db, nodeId);
  const sourceId = row && row.mirror_of ? store.resolveSource(db, nodeId)?.id : nodeId;
  if (sourceId && locks.release(sourceId, peer.connId)) {
    sendToDocs(audienceDocIds(sourceId), { type: 'unlocked', nodeId: sourceId }, peer.connId);
  }
}

function handleHeartbeat(peer, msg) {
  if (msg.nodeId) {
    const ok = locks.renew(String(msg.nodeId), peer.connId);
    send(peer, { type: 'heartbeat_ack', nodeId: msg.nodeId, ok, serverTime: Date.now() });
  } else {
    send(peer, { type: 'heartbeat_ack', serverTime: Date.now() });
  }
}

// ---------- 讲解/跟读：文档级唯一讲解者，服务器原子裁决 ----------
//
// 关键语义：
// - 同一文档的 state 只有一个 leader；两个 start 顺序进入同一个 JS 事件循环，
//   后到者只收到 denied，不会出现两个本机都自认讲解者。
// - point 只改服务器状态后全员广播，所有观看端按同一条消息滚到同一段。
// - handoff 只是"递给某人"的待决 offer；leader 与 nodeId 不立刻变化。
//   对方 accept 后才在同一次处理里原子切换；leader 或目标在 accept 前取消，
//   大家仍停在上一轮 leader 指着的 nodeId。

function presentationUserInDoc(docId, userId) {
  for (const p of peers.values()) {
    if (p.user && p.rooms?.has(docId) && p.user.userId === userId) return publicUser(p.user);
  }
  return null;
}

function handlePresentationStart(peer, msg) {
  const docId = String(msg.docId || '');
  const nodeId = String(msg.nodeId || '');
  if (!store.getDoc(db, docId)) {
    send(peer, { type: 'error', docId, message: '大纲不存在' });
    return;
  }
  if (!presentationNodeExists(docId, nodeId)) {
    send(peer, { type: 'error', docId, message: '讲解段落不存在' });
    return;
  }
  const current = getPresentation(docId);
  if (current && current.leader.userId !== peer.user.userId) {
    send(peer, {
      type: 'presentation_denied',
      docId,
      leader: publicUser(current.leader),
      nodeId: current.nodeId,
      message: `${current.leader.userName} 正在讲这一轮`,
    });
    return;
  }
  presentations.set(docId, {
    leader: { ...publicUser(peer.user), connId: peer.connId },
    nodeId,
    offer: null,
  });
  broadcastPresentation(docId);
}

function requirePresentationLeader(peer, docId) {
  const current = getPresentation(docId);
  if (!current) {
    send(peer, { type: 'presentation_state', docId, active: false });
    return null;
  }
  if (current.leader.userId !== peer.user.userId) {
    send(peer, {
      type: 'presentation_denied',
      docId,
      leader: publicUser(current.leader),
      nodeId: current.nodeId,
      message: `只有当前讲解者 ${current.leader.userName} 可以操作这一轮`,
    });
    return null;
  }
  return current;
}

function handlePresentationPoint(peer, msg) {
  const docId = String(msg.docId || '');
  const nodeId = String(msg.nodeId || '');
  const current = requirePresentationLeader(peer, docId);
  if (!current) return;
  if (!presentationNodeExists(docId, nodeId)) {
    send(peer, { type: 'error', docId, message: '讲解段落不存在' });
    return;
  }
  current.nodeId = nodeId;
  current.offer = null; // 讲解者继续指向新段，之前未接受的交棒作废
  broadcastPresentation(docId);
}

function handlePresentationStop(peer, msg) {
  const docId = String(msg.docId || '');
  const current = getPresentation(docId);
  if (!current) return;
  if (current.leader.userId !== peer.user.userId) {
    send(peer, {
      type: 'presentation_denied',
      docId,
      leader: publicUser(current.leader),
      nodeId: current.nodeId,
      message: `只有 ${current.leader.userName} 可以结束这一轮`,
    });
    return;
  }
  presentations.delete(docId);
  broadcastPresentation(docId);
}

function handlePresentationHandoff(peer, msg) {
  const docId = String(msg.docId || '');
  const targetUserId = String(msg.targetUserId || '');
  const current = requirePresentationLeader(peer, docId);
  if (!current) return;
  if (targetUserId === peer.user.userId) {
    send(peer, { type: 'error', docId, message: '这一轮已经在你手里' });
    return;
  }
  const target = presentationUserInDoc(docId, targetUserId);
  if (!target) {
    send(peer, { type: 'error', docId, message: '对方当前不在这份大纲里' });
    return;
  }
  current.offer = { userId: target.userId, userName: target.userName };
  broadcastPresentation(docId);
}

function handlePresentationCancelHandoff(peer, msg) {
  const docId = String(msg.docId || '');
  const current = getPresentation(docId);
  if (!current?.offer) return;
  const isLeader = current.leader.userId === peer.user.userId;
  const isTarget = current.offer.userId === peer.user.userId;
  if (!isLeader && !isTarget) return;
  current.offer = null;
  broadcastPresentation(docId);
}

function handlePresentationAccept(peer, msg) {
  const docId = String(msg.docId || '');
  const current = getPresentation(docId);
  if (!current) return;
  if (!current.offer || current.offer.userId !== peer.user.userId) {
    send(peer, {
      type: 'presentation_denied',
      docId,
      leader: publicUser(current.leader),
      nodeId: current.nodeId,
      message: '这一轮没有交到你这里',
    });
    return;
  }
  if (!presentationNodeExists(docId, current.nodeId)) {
    presentations.delete(docId);
    broadcastPresentation(docId);
    send(peer, { type: 'error', docId, message: '刚才指着的段落已不存在，请重新开始一轮' });
    return;
  }
  // 原子完成交棒：同一时刻只替换 leader，不产生两个 leader 的中间状态。
  current.leader = { ...publicUser(peer.user), connId: peer.connId };
  current.offer = null;
  broadcastPresentation(docId);
}

function cleanupPresentationsOnDisconnect(closedPeer) {
  for (const docId of [...closedPeer.rooms]) {
    const current = getPresentation(docId);
    if (!current) continue;
    const sameUserStillOpen = [...peers.values()].some((p) =>
      p !== closedPeer &&
      p.user &&
      p.rooms?.has(docId) &&
      p.user.userId === current.leader.userId,
    );
    if (current.leader.userId === closedPeer.user.userId && !sameUserStillOpen) {
      // 讲解者最后一个连接断开：这一轮无法继续操作，直接结束，避免出现幽灵讲解者。
      presentations.delete(docId);
      broadcastPresentation(docId);
    } else if (current.offer?.userId === closedPeer.user.userId) {
      const targetStillOpen = [...peers.values()].some((p) =>
        p !== closedPeer &&
        p.user &&
        p.rooms?.has(docId) &&
        p.user.userId === current.offer.userId,
      );
      if (!targetStillOpen) {
        current.offer = null;
        broadcastPresentation(docId);
      }
    }
  }
}

// ---------- 改写提议：公开草稿，不占编辑锁、不改正文 ----------

function handleSuggestionAdd(peer, msg) {
  const entryId = String(msg.nodeId || '');
  const resolved = resolveEditable(entryId);
  if (resolved.error) {
    send(peer, { type: 'error', nodeId: entryId, message: resolved.error });
    return;
  }
  const source = resolved.source;
  if (!denySourceWriteWhileFollowing(peer, source.id)) return;
  const content = String(msg.content ?? '').slice(0, 100_000);
  const baseVersion = Number(msg.baseVersion);
  if (!Number.isInteger(baseVersion) || baseVersion < 1) {
    send(peer, { type: 'error', nodeId: source.id, message: '缺少改写所基于的版本号' });
    return;
  }

  const id = crypto.randomUUID();
  const result = store.createSuggestion(db, {
    id,
    nodeId: source.id,
    content,
    baseVersion,
    userId: peer.user.userId,
    userName: peer.user.userName,
  });
  if (result.status === 'stale') {
    send(peer, {
      type: 'suggestion_stale',
      nodeId: source.id,
      current: result.latest,
      message: '这段正文已有新版本，请刷新到最新内容后再提改写',
    });
    return;
  }
  if (result.status === 'noop') {
    send(peer, {
      type: 'suggestion_noop',
      nodeId: source.id,
      revision: result.latest,
      message: '这版内容与当前正文相同，无需提出改写',
    });
    return;
  }
  if (result.status !== 'created') {
    send(peer, { type: 'error', nodeId: source.id, message: '无法提出改写' });
    return;
  }
  sendToDocs(audienceDocIds(source.id), {
    type: 'suggestion_added',
    nodeId: source.id,
    suggestion: result.suggestion,
  });
}

function handleSuggestionWithdraw(peer, msg) {
  const suggestionId = String(msg.suggestionId || '');
  const existing = store.getSuggestion(db, suggestionId);
  if (existing && !denySourceWriteWhileFollowing(peer, existing.node_id)) return;
  const result = store.withdrawSuggestion(db, { suggestionId, userId: peer.user.userId });
  if (result.status === 'missing') {
    send(peer, { type: 'error', message: '改写不存在或已被处理' });
    return;
  }
  if (result.status === 'forbidden') {
    send(peer, { type: 'error', message: '只能撤掉自己提出的改写' });
    return;
  }
  if (result.status !== 'withdrawn') {
    send(peer, {
      type: 'error',
      nodeId: result.suggestion.nodeId,
      message: '这版改写已被收下或失效，不能撤掉',
    });
    return;
  }
  // 撤稿只删公开草稿：不写 revision、不动正文，也不释放/影响段落编辑锁。
  sendToDocs(audienceDocIds(result.suggestion.nodeId), {
    type: 'suggestion_withdrawn',
    nodeId: result.suggestion.nodeId,
    suggestionId,
  });
}

function handleSuggestionAccept(peer, msg) {
  const suggestionId = String(msg.suggestionId || '');
  const existing = store.getSuggestion(db, suggestionId);
  if (existing && existing.status === 'pending' &&
      !denySourceWriteWhileFollowing(peer, existing.node_id)) return;
  const result = store.acceptSuggestion(db, {
    suggestionId,
    userId: peer.user.userId,
    userName: peer.user.userName,
  });
  if (result.status === 'missing') {
    send(peer, { type: 'error', message: '改写不存在或段落已删除' });
    return;
  }
  const nodeId = result.suggestion?.nodeId;
  if (result.status === 'not_pending') {
    send(peer, {
      type: 'suggestion_stale',
      nodeId,
      suggestionId,
      message: '这版改写已被收下或撤掉',
    });
    return;
  }
  if (result.status === 'stale') {
    sendToDocs(audienceDocIds(nodeId), {
      type: 'suggestions_superseded',
      nodeId,
      suggestionIds: result.supersededIds,
      reason: '正文已有新版本，请基于最新版本重新提出改写',
    });
    send(peer, {
      type: 'suggestion_stale',
      nodeId,
      suggestionId,
      current: result.latest,
      message: '这版改写基于旧正文；为避免覆盖新改动，未收入正文',
    });
    return;
  }
  if (result.status === 'noop') {
    sendToDocs(audienceDocIds(nodeId), {
      type: 'suggestion_accepted',
      nodeId,
      suggestionId,
      revision: result.revision,
      by: peer.user,
      noop: true,
    });
    return;
  }
  if (result.status !== 'saved') {
    send(peer, { type: 'error', nodeId, message: '收下改写失败，请重试' });
    return;
  }

  const audience = audienceDocIds(nodeId);
  // 先发 accepted，再发正文；客户端据此移除被收的卡片并等待同一份 revision。
  sendToDocs(audience, {
    type: 'suggestion_accepted',
    nodeId,
    suggestionId,
    by: peer.user,
  });
  if (result.supersededIds.length) {
    sendToDocs(audience, {
      type: 'suggestions_superseded',
      nodeId,
      suggestionIds: result.supersededIds,
      reason: '同一段已收下另一版改写',
    });
  }
  sendToDocs(audience, {
    type: 'content',
    nodeId,
    docId: store.getNode(db, nodeId).doc_id,
    version: result.revision.version,
    content: result.revision.content,
    author: result.revision.author,
    authorId: result.revision.author_id,
    updatedAt: result.revision.created_at,
    acceptedBy: peer.user,
    acceptedSuggestionId: suggestionId,
  });
}

// ---------- 内容保存：版本号乐观锁 + diff3 三方合并 ----------
// 无论编辑入口在源段落还是某个跟读，nodeId 永远是源节点 id
// （跟读没有自己的正文），所以"两人在不同挂载点改同一段"就是
// 现有协议里"两人改同一段"：合并/冲突裁决保证唯一收敛。
//
// clientTag：客户端（离线回放队列）给每条保存贴的回执标签，服务器原样透传
// 回 saved / merge_notice / conflict / error，客户端据此把回执对号到
// 具体的离线改动，不会误触当前正在进行的交互式编辑会话。

function clientTagOf(msg) {
  return typeof msg.clientTag === 'string' && msg.clientTag
    ? msg.clientTag.slice(0, 64)
    : undefined;
}

function handleSave(peer, msg) {
  const nodeId = String(msg.nodeId || '');
  const content = String(msg.content ?? '').slice(0, 100_000);
  const expectedVersion = Number(msg.baseVersion);
  const clientTag = clientTagOf(msg);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    send(peer, { type: 'error', message: '缺少基准版本号', clientTag });
    return;
  }

  const node = store.getNode(db, nodeId);
  if (!node || node.deleted || node.mirror_of) {
    send(peer, { type: 'error', nodeId, message: '该段落已被删除', clientTag });
    return;
  }
  if (!denySourceWriteWhileFollowing(peer, nodeId)) return;
  const latest = store.getLatestRevision(db, nodeId);

  // 版本一致：直接落库
  if (latest.version === expectedVersion) {
    const result = store.saveContent(db, {
      nodeId,
      content,
      expectedVersion,
      userId: peer.user.userId,
      userName: peer.user.userName,
    });
    if (result.status === 'saved') {
      broadcastContent(nodeId, result.revision, peer.connId, result.supersededSuggestionIds);
      send(peer, { type: 'saved', nodeId, revision: result.revision, clientTag });
    } else if (result.status === 'noop') {
      send(peer, { type: 'saved', nodeId, revision: latest, merged: false, clientTag });
    }
    return;
  }

  // 过期提交：三方合并。base=用户编辑时的旧版本
  const base = store.getRevisionByVersion(db, nodeId, expectedVersion);
  if (!base) {
    send(peer, {
      type: 'conflict',
      nodeId,
      reason: 'history_gone',
      current: latest,
      message: '你基于的历史版本已不存在，请刷新后重试',
      clientTag,
    });
    return;
  }

  const merged = merge3(base.content, content, latest.content);
  if (!merged.ok) {
    send(peer, {
      type: 'conflict',
      nodeId,
      reason: 'overlap',
      base: base.content,
      local: content,
      remote: latest.content,
      current: latest,
      clientTag,
    });
    return;
  }

  const result = store.saveContent(db, {
    nodeId,
    content: merged.text,
    expectedVersion: latest.version,
    userId: peer.user.userId,
    userName: peer.user.userName,
    note: `自动合并：基于 v${base.version} 与 v${latest.version}`,
  });
  if (result.status === 'saved') {
    broadcastContent(nodeId, result.revision, peer.connId, result.supersededSuggestionIds);
    send(peer, {
      type: 'merge_notice',
      nodeId,
      revision: result.revision,
      message: '已和其他人的修改自动合并',
      clientTag,
    });
  } else if (result.status === 'noop') {
    // 合并结果与线上完全一致（双方离线改成了一样）：已收敛，算成功而非失败
    send(peer, { type: 'saved', nodeId, revision: latest, clientTag });
  } else {
    send(peer, { type: 'error', nodeId, message: '保存失败，请重试', clientTag });
  }
}

function broadcastContent(nodeId, revision, exceptConnId = null, supersededSuggestionIds = []) {
  // 扇出到源文档与全部跟读宿主文档：同一份 revision，所有挂载点同步更新
  sendToDocs(audienceDocIds(nodeId), {
    type: 'content',
    nodeId,
    docId: store.getNode(db, nodeId).doc_id,
    version: revision.version,
    content: revision.content,
    author: revision.author,
    authorId: revision.author_id,
    updatedAt: revision.created_at,
  }, exceptConnId);
  // 提议失效要通知保存者自己：否则他屏幕上会残留已被自己新正文顶掉的卡片。
  broadcastSuggestionsSuperseded(nodeId, supersededSuggestionIds, null);
}

function broadcastSuggestionsSuperseded(nodeId, suggestionIds = [], exceptConnId = null, reason = '正文已更新为新版本') {
  if (!suggestionIds.length) return;
  sendToDocs(audienceDocIds(nodeId), {
    type: 'suggestions_superseded',
    nodeId,
    suggestionIds,
    reason,
  }, exceptConnId);
}

// 回退后继续编辑的保存（diff4 语义）。
function handleRestoreSave(peer, msg) {
  const nodeId = String(msg.nodeId || '');
  const content = String(msg.content ?? '').slice(0, 100_000);
  const restoreVersion = Number(msg.restoreVersion);
  const clientTag = clientTagOf(msg);
  if (!Number.isInteger(restoreVersion) || restoreVersion < 1) {
    send(peer, { type: 'error', message: '缺少回退基准版本号', clientTag });
    return;
  }

  const node = store.getNode(db, nodeId);
  if (!node || node.deleted || node.mirror_of) {
    send(peer, { type: 'error', nodeId, message: '该段落已被删除', clientTag });
    return;
  }
  if (!denySourceWriteWhileFollowing(peer, nodeId)) return;
  const latest = store.getLatestRevision(db, nodeId);
  const baseRev = store.getRevisionByVersion(db, nodeId, restoreVersion);
  if (!baseRev) {
    send(peer, {
      type: 'conflict', nodeId, reason: 'history_gone', current: latest,
      message: '你基于的历史版本已不存在，请刷新后重试', clientTag,
    });
    return;
  }

  let finalText = content;
  if (latest.version !== restoreVersion) {
    const merged = merge3(baseRev.content, latest.content, content);
    if (!merged.ok) {
      send(peer, {
        type: 'conflict', nodeId, reason: 'overlap',
        base: baseRev.content, local: content, remote: latest.content, current: latest,
        clientTag,
      });
      return;
    }
    finalText = merged.text;
  }

  if (finalText === latest.content) {
    send(peer, { type: 'saved', nodeId, revision: latest, clientTag });
    return;
  }

  const result = store.saveContent(db, {
    nodeId,
    content: finalText,
    expectedVersion: latest.version,
    userId: peer.user.userId,
    userName: peer.user.userName,
    note: latest.version !== restoreVersion
      ? `回退到 v${restoreVersion} 后继续编辑（与 v${latest.version} 三方合并）`
      : `回退到 v${restoreVersion} 后继续编辑`,
  });

  if (result.status === 'saved') {
    broadcastContent(nodeId, result.revision, peer.connId, result.supersededSuggestionIds);
    send(peer, {
      type: 'merge_notice', nodeId, revision: result.revision,
      message: latest.version !== restoreVersion
        ? '已回退并自动保留其他人不冲突的改动'
        : '已基于历史版本创建新版本',
      clientTag,
    });
  } else {
    send(peer, { type: 'error', nodeId, message: '保存失败，请重试', clientTag });
  }
}

function handleHistory(peer, msg) {
  const nodeId = String(msg.nodeId || '');
  const items = store.getHistory(db, nodeId, 200);
  send(peer, { type: 'history', nodeId, items });
}

// ---------- 整份时间轴：按时刻回看整棵树的层级与正文 ----------

function handleTimeline(peer) {
  send(peer, {
    type: 'timeline',
    latestSeq: store.latestSeq(db),
    items: store.getTimeline(db, 300),
  });
}

// 把指定文档重建到时刻 seq（结构+正文；跟读投影源在同一 seq 的内容）。
// 重建是 seq 的纯函数：所有人拿到同一份结果，不存在"各看各的"。
function handleSnapshotAt(peer, msg) {
  const docId = String(msg.docId || '');
  const seq = Number(msg.seq);
  if (!store.getDoc(db, docId)) {
    send(peer, { type: 'error', message: '大纲不存在' });
    return;
  }
  if (!Number.isInteger(seq) || seq < 1) {
    send(peer, { type: 'error', message: '缺少有效的时刻序号' });
    return;
  }
  const snap = store.getSnapshotAt(db, docId, seq);
  send(peer, {
    type: 'snapshot_at',
    docId,
    title: snap.doc.title,
    asOf: snap.asOf,
    nodes: snap.nodes,
  });
}

// 冲突解决后用户选定最终文本，再次走保存（基准为当前最新版本）
function handleResolve(peer, msg) {
  const nodeId = String(msg.nodeId || '');
  const content = String(msg.content ?? '').slice(0, 100_000);
  const clientTag = clientTagOf(msg);
  const node = store.getNode(db, nodeId);
  if (!node || node.deleted || node.mirror_of) {
    send(peer, { type: 'error', nodeId, message: '该段落已被删除', clientTag });
    return;
  }
  if (!denySourceWriteWhileFollowing(peer, nodeId)) return;
  const latest = store.getLatestRevision(db, nodeId);
  const result = store.saveContent(db, {
    nodeId,
    content,
    expectedVersion: latest.version,
    userId: peer.user.userId,
    userName: peer.user.userName,
    note: msg.keep === 'remote' ? '冲突解决：采用对方版本' : '冲突解决：手动合并',
  });
  if (result.status === 'saved') {
    broadcastContent(nodeId, result.revision, peer.connId, result.supersededSuggestionIds);
    send(peer, { type: 'saved', nodeId, revision: result.revision, clientTag });
  } else if (result.status === 'noop') {
    // 最终文本与线上一致（例如采用对方版本）：已收敛，直接回执成功
    send(peer, { type: 'saved', nodeId, revision: latest, clientTag });
  } else send(peer, { type: 'error', nodeId, message: '保存失败，请重试', clientTag });
}

// ---------- 结构操作（增/删/移动层级 / 挂跟读）----------

// 新增普通段落。文档归属规则：
//   指定了 parentId -> 与父级同文档（禁止跨文档父级）；
//   顶层新增 -> msg.docId（缺省为默认文档）。
function handleAdd(peer, msg) {
  const parentId = msg.parentId ? String(msg.parentId) : null;
  const afterId = msg.afterId ? String(msg.afterId) : null;
  let docId;
  if (parentId) {
    const parent = store.getNode(db, parentId);
    if (!parent || parent.deleted) {
      send(peer, { type: 'error', message: '父级段落不存在' });
      return;
    }
    if (parent.mirror_of) {
      send(peer, { type: 'error', message: '跟读段落下不能再加子级' });
      return;
    }
    docId = parent.doc_id;
  } else {
    docId = String(msg.docId || store.DEFAULT_DOC);
  }
  const doc = store.getDoc(db, docId);
  if (!doc) {
    send(peer, { type: 'error', message: '大纲不存在' });
    return;
  }
  if (!denyWriteWhileFollowing(peer, docId)) return;
  if (Number(msg.treeRev) !== doc.tree_rev) {
    sendStale(peer, doc);
    return;
  }

  const pos = computePosAfter(db, docId, parentId, afterId);
  const newId = crypto.randomUUID();
  const added = store.addNode(db, {
    id: newId,
    docId,
    parentId,
    pos,
    content: String(msg.content || '').slice(0, 100_000) || '新段落',
    userId: peer.user.userId,
    userName: peer.user.userName,
  });
  sendToDoc(docId, {
    type: 'node_added',
    docId,
    node: added.node,
    treeRev: added.treeRev,
    by: peer.user.userId,
  });
}

// 把源段落当作跟读挂进另一份大纲（也允许挂同份大纲的别处，但禁止形成链）
function handleAddMirror(peer, msg) {
  const sourceId = String(msg.sourceId || '');
  const hostDocId = String(msg.docId || '');
  const parentId = msg.parentId ? String(msg.parentId) : null;
  const afterId = msg.afterId ? String(msg.afterId || '') : null;

  const source = store.getNode(db, sourceId);
  if (!source || source.deleted || source.mirror_of) {
    send(peer, { type: 'error', message: '源段落不存在或已删除' });
    return;
  }
  const hostDoc = store.getDoc(db, hostDocId);
  if (!hostDoc) {
    send(peer, { type: 'error', message: '目标大纲不存在' });
    return;
  }
  if (!denyWriteWhileFollowing(peer, hostDocId)) return;
  if (Number(msg.treeRev) !== hostDoc.tree_rev) {
    sendStale(peer, hostDoc);
    return;
  }
  if (parentId) {
    const parent = store.getNode(db, parentId);
    if (!parent || parent.deleted || parent.doc_id !== hostDocId) {
      send(peer, { type: 'error', message: '挂载位置无效' });
      return;
    }
    if (parent.mirror_of) {
      send(peer, { type: 'error', message: '跟读段落下不能再挂跟读' });
      return;
    }
  }

  const pos = computePosAfter(db, hostDocId, parentId, afterId);
  const newId = crypto.randomUUID();
  const added = store.addMirrorNode(db, {
    id: newId,
    docId: hostDocId,
    parentId,
    pos,
    mirrorOf: sourceId,
    userId: peer.user.userId,
    userName: peer.user.userName,
  });
  sendToDoc(hostDocId, {
    type: 'mirror_added',
    docId: hostDocId,
    node: added.node,
    treeRev: added.treeRev,
    by: peer.user.userId,
  });
}

function sendStale(peer, doc) {
  send(peer, { type: 'tree_stale', docId: doc.id, treeRev: doc.tree_rev });
  send(peer, snapshotMessage(doc.id));
}

function computePosAfter(dbx, docId, parentId, afterId) {
  const siblings = dbx
    .prepare(
      'SELECT id, pos FROM nodes WHERE doc_id = ? AND deleted = 0 AND parent_id IS ? ORDER BY pos',
    )
    .all(docId, parentId);
  const idx = afterId ? siblings.findIndex((s) => s.id === afterId) : -1;
  const prev = idx >= 0 ? siblings[idx].pos : null;
  const next = idx + 1 < siblings.length ? siblings[idx + 1].pos : null;
  return midpoint(prev, next);
}

function handleMove(peer, msg) {
  const nodeId = String(msg.nodeId || '');
  const parentId = msg.parentId ? String(msg.parentId) : null;
  const afterId = msg.afterId ? String(msg.afterId || '') : null;
  const treeRev = Number(msg.treeRev);

  const node = store.getNode(db, nodeId);
  if (!node || node.deleted) return;
  const doc = store.getDoc(db, node.doc_id);
  if (!doc) return;
  if (!denyWriteWhileFollowing(peer, doc.id)) return;
  if (treeRev !== doc.tree_rev) {
    sendStale(peer, doc);
    return;
  }
  if (parentId === nodeId || isDescendant(db, nodeId, parentId)) {
    send(peer, { type: 'error', nodeId, message: '不能把段落移动到自己的子级里' });
    return;
  }
  if (parentId) {
    const target = store.getNode(db, parentId);
    if (!target || target.deleted || target.doc_id !== doc.id) {
      send(peer, { type: 'error', nodeId, message: '移动目标不在同一份大纲里' });
      return;
    }
    if (target.mirror_of) {
      send(peer, { type: 'error', nodeId, message: '跟读段落下不能挂子级' });
      return;
    }
  }
  const pos = computePosForMove(db, doc.id, parentId, afterId, nodeId);
  const result = store.moveNode(db, {
    nodeId, parentId, pos, treeRev,
    userId: peer.user.userId, userName: peer.user.userName,
  });
  if (result.status === 'stale') {
    sendStale(peer, doc);
    return;
  }
  if (result.status !== 'moved') return;
  sendToDoc(doc.id, {
    type: 'node_moved', docId: doc.id, nodeId, parentId, pos, treeRev: result.treeRev,
  });
}

function computePosForMove(dbx, docId, parentId, afterId, movingId) {
  const siblings = dbx
    .prepare(
      'SELECT id, pos FROM nodes WHERE doc_id = ? AND deleted = 0 AND parent_id IS ? ORDER BY pos',
    )
    .all(docId, parentId)
    .filter((s) => s.id !== movingId);
  const idx = afterId ? siblings.findIndex((s) => s.id === afterId) : -1;
  const prev = idx >= 0 ? siblings[idx].pos : null;
  const next = idx + 1 < siblings.length ? siblings[idx + 1].pos : null;
  return midpoint(prev, next);
}

function isDescendant(dbx, ancestorId, maybeDescendantId) {
  if (!maybeDescendantId) return false;
  let cur = store.getNode(dbx, maybeDescendantId);
  const seen = new Set();
  while (cur && cur.parent_id && !seen.has(cur.id)) {
    if (cur.parent_id === ancestorId) return true;
    seen.add(cur.id);
    cur = store.getNode(dbx, cur.parent_id);
  }
  return false;
}

function handleDelete(peer, msg) {
  const nodeId = String(msg.nodeId || '');
  const row = store.getNode(db, nodeId);
  if (!row || row.deleted) return;
  const doc = store.getDoc(db, row.doc_id);
  if (!doc) return;
  if (!denyWriteWhileFollowing(peer, doc.id)) return;
  if (Number(msg.treeRev) !== doc.tree_rev) {
    sendStale(peer, doc);
    return;
  }

  // 跟读行：只摘掉这一处挂载，源段落与别处跟读都不受影响
  if (row.mirror_of) {
    const result = store.deleteNode(db, {
      nodeId, treeRev: Number(msg.treeRev),
      userId: peer.user.userId, userName: peer.user.userName,
    });
    if (result.status !== 'deleted') return;
    clearPresentationIfPointing(doc.id, result.ids);
    sendToDoc(doc.id, {
      type: 'nodes_deleted', docId: doc.id, ids: result.ids, treeRev: result.treeRev,
    });
    return;
  }

  const result = store.deleteNode(db, {
    nodeId, treeRev: Number(msg.treeRev),
    userId: peer.user.userId, userName: peer.user.userName,
  });
  if (result.status !== 'deleted') return;

  // 释放被删子树上所有编辑锁（锁以源 id 为键），并通知各房间
  for (const id of result.ids) {
    const lock = locks.locks.get(id);
    if (lock) {
      locks.release(id, lock.connId);
      sendToDocs(audienceDocIds(id), { type: 'unlocked', nodeId: id, reason: 'deleted' });
    }
  }

  // 源文档：节点从树里消失（讲解轮次若正指着被删段落，也在此原子结束）
  clearPresentationIfPointing(doc.id, result.ids);
  sendToDoc(doc.id, {
    type: 'nodes_deleted', docId: doc.id, ids: result.ids, treeRev: result.treeRev,
  });

  // 挂在别的大纲（含同一份大纲别处）里的跟读：不删行、不显示旧正文，
  // 转为"源已删除"墓碑。源行本身已由上面的 nodes_deleted 移除，
  // source_deleted 只作用于 mirrorOf 匹配的镜像行，两者互不重叠。
  const hostDocs = store.mirrorHostDocs(db, result.ids);
  for (const hostDocId of hostDocs) {
    sendToDoc(hostDocId, { type: 'source_deleted', sourceIds: result.ids });
  }
  for (const suggestion of result.supersededSuggestions || []) {
    if (suggestion?.nodeId) {
      broadcastSuggestionsSuperseded(
        suggestion.nodeId,
        [suggestion.id],
        null,
        '段落已删除',
      );
    }
  }
}

// ---------- WebSocket 生命周期 ----------

wss.on('connection', (ws) => {
  const connId = crypto.randomUUID();
  const peer = { connId, ws, user: null, rooms: new Set(), viewRooms: new Set(), role: 'editor', alive: true };
  peers.set(connId, peer);

  ws.on('pong', () => {
    peer.alive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!peer.user && msg.type !== 'hello') {
      send(peer, { type: 'error', message: '请先发送 hello' });
      return;
    }
    // 对外观看者：除观看房间的只读消息外，一律拒绝（安全边界在服务器，不靠前端自觉）
    if (peer.role === 'viewer' && !['open_published', 'leave_published', 'heartbeat'].includes(msg.type)) {
      send(peer, { type: 'error', message: '对外定稿页是只读的，不能修改大纲' });
      return;
    }
    try {
      switch (msg.type) {
        case 'hello': handleHello(peer, msg); break;
        case 'open_doc': handleOpenDoc(peer, msg); break;
        case 'leave_doc': handleLeaveDoc(peer, msg); break;
        case 'create_doc': handleCreateDoc(peer, msg); break;
        case 'open_published': handleOpenPublished(peer, msg); break;
        case 'leave_published': handleLeavePublished(peer, msg); break;
        case 'publish': handlePublish(peer, msg); break;
        case 'add_mirror': handleAddMirror(peer, msg); break;
        case 'lock': handleLock(peer, msg); break;
        case 'unlock': handleUnlock(peer, msg); break;
        case 'heartbeat': handleHeartbeat(peer, msg); break;
        case 'presentation_start': handlePresentationStart(peer, msg); break;
        case 'presentation_point': handlePresentationPoint(peer, msg); break;
        case 'presentation_stop': handlePresentationStop(peer, msg); break;
        case 'presentation_handoff': handlePresentationHandoff(peer, msg); break;
        case 'presentation_cancel_handoff': handlePresentationCancelHandoff(peer, msg); break;
        case 'presentation_accept': handlePresentationAccept(peer, msg); break;
        case 'suggestion_add': handleSuggestionAdd(peer, msg); break;
        case 'suggestion_withdraw': handleSuggestionWithdraw(peer, msg); break;
        case 'suggestion_accept': handleSuggestionAccept(peer, msg); break;
        case 'save': handleSave(peer, msg); break;
        case 'restore_save': handleRestoreSave(peer, msg); break;
        case 'resolve': handleResolve(peer, msg); break;
        case 'history': handleHistory(peer, msg); break;
        case 'timeline': handleTimeline(peer, msg); break;
        case 'snapshot_at': handleSnapshotAt(peer, msg); break;
        case 'add': handleAdd(peer, msg); break;
        case 'move': handleMove(peer, msg); break;
        case 'delete': handleDelete(peer, msg); break;
        default: send(peer, { type: 'error', message: `未知消息类型: ${msg.type}` });
      }
    } catch (err) {
      console.error('handler error:', err);
      send(peer, { type: 'error', message: '服务器内部错误' });
    }
  });

  ws.on('close', () => {
    peers.delete(connId);
    cleanupPresentationsOnDisconnect(peer);
    // 锁释放要扇出到源文档 + 跟读宿主文档（两边占用同时消失）
    const released = locks.releaseAll(connId);
    for (const nodeId of released) {
      sendToDocs(audienceDocIds(nodeId), { type: 'unlocked', nodeId });
    }
    // 离开每个文档房间，更新各房间在线名单
    for (const docId of [...peer.rooms]) {
      peer.rooms.delete(docId);
      sendToDoc(docId, { type: 'presence', docId, users: presenceList(docId) });
    }
    // 离开对外定稿观看房间，更新观看者名单
    for (const docId of [...peer.viewRooms]) {
      peer.viewRooms.delete(docId);
      sendToViewers(docId, { type: 'presence', docId, scope: 'published', users: viewerPresence(docId) });
    }
  });

  ws.on('error', () => {
    // close 会接管清理
  });
});

// 死连接探测
const WS_PING_MS = Number(process.env.WS_PING_MS || 25000);
const pingTimer = setInterval(() => {
  for (const [, peer] of peers) {
    if (!peer.alive) {
      try { peer.ws.terminate(); } catch { /* ignore */ }
      continue;
    }
    peer.alive = false;
    try {
      peer.ws.ping();
    } catch {
      try { peer.ws.terminate(); } catch { /* ignore */ }
    }
  }
}, WS_PING_MS);
pingTimer.unref?.();

// TTL 扫描：回收"人还连着但编辑锁早该过期"的锁。
// 扇出到源文档 + 跟读宿主文档：两边占用都自己消失。
function sweepAndBroadcast() {
  const expired = locks.sweep();
  for (const nodeId of expired) {
    sendToDocs(audienceDocIds(nodeId), { type: 'unlocked', nodeId, reason: 'ttl' });
  }
  return expired;
}
const sweepTimer = setInterval(sweepAndBroadcast, 5000);
sweepTimer.unref?.();

// 暴露给测试
module.exports = { server, app, db, locks, peers, sweepAndBroadcast };

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`协同大纲服务已启动: http://localhost:${PORT}`);
    console.log(`数据库: ${DB_FILE}，编辑锁 TTL: ${LOCK_TTL}ms`);
  });
}
