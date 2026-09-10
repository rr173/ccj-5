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
  return {
    type: 'snapshot',
    docId: snap.doc.id,
    title: snap.doc.title,
    treeRev: snap.doc.tree_rev,
    nodes: snap.nodes,
    locks: relevantLocks(docId, snap.nodes),
    users: presenceList(docId),
  };
}

// 快照里只带本文档看得见的锁：源段落在本文档，或本文档挂着它的跟读
function relevantLocks(docId, nodes) {
  const sourceIds = new Set();
  for (const n of nodes) {
    if (n.kind === 'mirror') sourceIds.add(n.mirrorOf);
    else sourceIds.add(n.id);
  }
  return locks.list().filter((l) => sourceIds.has(l.nodeId));
}

function docListMessage() {
  return { type: 'doc_list', docs: store.listDocuments(db) };
}

// ---------- 文档房间 ----------

function handleHello(peer, msg) {
  const userId = String(msg.userId || crypto.randomUUID());
  const userName = String(msg.userName || '匿名用户').slice(0, 40);
  peer.user = { userId, userName, color: colorFor(userId) };
  peer.rooms = new Set();
  send(peer, { type: 'hello', user: peer.user });
  send(peer, docListMessage());

  // 进入即打开默认大纲（保持单文档时代的交互/旧协议兼容）
  joinDoc(peer, store.DEFAULT_DOC);
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

// ---------- 内容保存：版本号乐观锁 + diff3 三方合并 ----------
// 无论编辑入口在源段落还是某个跟读，nodeId 永远是源节点 id
// （跟读没有自己的正文），所以"两人在不同挂载点改同一段"就是
// 现有协议里"两人改同一段"：合并/冲突裁决保证唯一收敛。

function handleSave(peer, msg) {
  const nodeId = String(msg.nodeId || '');
  const content = String(msg.content ?? '').slice(0, 100_000);
  const expectedVersion = Number(msg.baseVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    send(peer, { type: 'error', message: '缺少基准版本号' });
    return;
  }

  const node = store.getNode(db, nodeId);
  if (!node || node.deleted || node.mirror_of) {
    send(peer, { type: 'error', nodeId, message: '该段落已被删除' });
    return;
  }
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
      broadcastContent(nodeId, result.revision, peer.connId);
      send(peer, { type: 'saved', nodeId, revision: result.revision });
    } else if (result.status === 'noop') {
      send(peer, { type: 'saved', nodeId, revision: latest, merged: false });
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
    broadcastContent(nodeId, result.revision, peer.connId);
    send(peer, {
      type: 'merge_notice',
      nodeId,
      revision: result.revision,
      message: '已和其他人的修改自动合并',
    });
  } else {
    send(peer, { type: 'error', nodeId, message: '保存失败，请重试' });
  }
}

function broadcastContent(nodeId, revision, exceptConnId = null) {
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
}

// 回退后继续编辑的保存（diff4 语义）。
function handleRestoreSave(peer, msg) {
  const nodeId = String(msg.nodeId || '');
  const content = String(msg.content ?? '').slice(0, 100_000);
  const restoreVersion = Number(msg.restoreVersion);
  if (!Number.isInteger(restoreVersion) || restoreVersion < 1) {
    send(peer, { type: 'error', message: '缺少回退基准版本号' });
    return;
  }

  const node = store.getNode(db, nodeId);
  if (!node || node.deleted || node.mirror_of) {
    send(peer, { type: 'error', nodeId, message: '该段落已被删除' });
    return;
  }
  const latest = store.getLatestRevision(db, nodeId);
  const baseRev = store.getRevisionByVersion(db, nodeId, restoreVersion);
  if (!baseRev) {
    send(peer, {
      type: 'conflict', nodeId, reason: 'history_gone', current: latest,
      message: '你基于的历史版本已不存在，请刷新后重试',
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
      });
      return;
    }
    finalText = merged.text;
  }

  if (finalText === latest.content) {
    send(peer, { type: 'saved', nodeId, revision: latest });
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
    broadcastContent(nodeId, result.revision, peer.connId);
    send(peer, {
      type: 'merge_notice', nodeId, revision: result.revision,
      message: latest.version !== restoreVersion
        ? '已回退并自动保留其他人不冲突的改动'
        : '已基于历史版本创建新版本',
    });
  } else {
    send(peer, { type: 'error', nodeId, message: '保存失败，请重试' });
  }
}

function handleHistory(peer, msg) {
  const nodeId = String(msg.nodeId || '');
  const items = store.getHistory(db, nodeId, 200);
  send(peer, { type: 'history', nodeId, items });
}

// 冲突解决后用户选定最终文本，再次走保存（基准为当前最新版本）
function handleResolve(peer, msg) {
  const nodeId = String(msg.nodeId || '');
  const content = String(msg.content ?? '').slice(0, 100_000);
  const node = store.getNode(db, nodeId);
  if (!node || node.deleted || node.mirror_of) {
    send(peer, { type: 'error', nodeId, message: '该段落已被删除' });
    return;
  }
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
    broadcastContent(nodeId, result.revision, peer.connId);
    send(peer, { type: 'saved', nodeId, revision: result.revision });
  } else send(peer, { type: 'error', nodeId, message: '保存失败，请重试' });
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
  const result = store.moveNode(db, { nodeId, parentId, pos, treeRev });
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
  if (Number(msg.treeRev) !== doc.tree_rev) {
    sendStale(peer, doc);
    return;
  }

  // 跟读行：只摘掉这一处挂载，源段落与别处跟读都不受影响
  if (row.mirror_of) {
    const result = store.deleteNode(db, { nodeId, treeRev: Number(msg.treeRev) });
    if (result.status !== 'deleted') return;
    sendToDoc(doc.id, {
      type: 'nodes_deleted', docId: doc.id, ids: result.ids, treeRev: result.treeRev,
    });
    return;
  }

  const result = store.deleteNode(db, { nodeId, treeRev: Number(msg.treeRev) });
  if (result.status !== 'deleted') return;

  // 释放被删子树上所有编辑锁（锁以源 id 为键），并通知各房间
  for (const id of result.ids) {
    const lock = locks.locks.get(id);
    if (lock) {
      locks.release(id, lock.connId);
      sendToDocs(audienceDocIds(id), { type: 'unlocked', nodeId: id, reason: 'deleted' });
    }
  }

  // 源文档：节点从树里消失
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
}

// ---------- WebSocket 生命周期 ----------

wss.on('connection', (ws) => {
  const connId = crypto.randomUUID();
  const peer = { connId, ws, user: null, rooms: new Set(), alive: true };
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
    try {
      switch (msg.type) {
        case 'hello': handleHello(peer, msg); break;
        case 'open_doc': handleOpenDoc(peer, msg); break;
        case 'leave_doc': handleLeaveDoc(peer, msg); break;
        case 'create_doc': handleCreateDoc(peer, msg); break;
        case 'add_mirror': handleAddMirror(peer, msg); break;
        case 'lock': handleLock(peer, msg); break;
        case 'unlock': handleUnlock(peer, msg); break;
        case 'heartbeat': handleHeartbeat(peer, msg); break;
        case 'save': handleSave(peer, msg); break;
        case 'restore_save': handleRestoreSave(peer, msg); break;
        case 'resolve': handleResolve(peer, msg); break;
        case 'history': handleHistory(peer, msg); break;
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
module.exports = { server, app, db, locks, sweepAndBroadcast };

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`协同大纲服务已启动: http://localhost:${PORT}`);
    console.log(`数据库: ${DB_FILE}，编辑锁 TTL: ${LOCK_TTL}ms`);
  });
}
