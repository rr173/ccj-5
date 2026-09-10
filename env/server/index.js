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
const locks = new LockManager({ ttlMs: LOCK_TTL, sweepIntervalMs: 5000 });

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

// connId -> { ws, user: {userId, userName, color} }
const peers = new Map();

function broadcast(msg, exceptConnId = null) {
  const data = JSON.stringify(msg);
  for (const [connId, peer] of peers) {
    if (connId === exceptConnId) continue;
    if (peer.ws.readyState === peer.ws.OPEN) peer.ws.send(data);
  }
}

function send(peer, msg) {
  if (peer.ws.readyState === peer.ws.OPEN) peer.ws.send(JSON.stringify(msg));
}

function presenceList() {
  return [...peers.values()].map((p) => p.user);
}

function snapshotMessage() {
  const snap = store.getSnapshot(db, store.DEFAULT_DOC);
  return {
    type: 'snapshot',
    title: snap.doc.title,
    treeRev: snap.doc.tree_rev,
    nodes: snap.nodes,
    locks: locks.list(),
    users: presenceList(),
  };
}

// ---------- 消息处理 ----------

function handleHello(peer, msg) {
  const userId = String(msg.userId || crypto.randomUUID());
  const userName = String(msg.userName || '匿名用户').slice(0, 40);
  peer.user = { userId, userName, color: colorFor(userId) };
  send(peer, { type: 'hello', user: peer.user });
  send(peer, snapshotMessage());
  // 通知其他人我来了（先注册再广播，presence 里包含自己）
  broadcast({ type: 'presence', users: presenceList() }, peer.connId);
}

function handleLock(peer, msg) {
  const nodeId = String(msg.nodeId || '');
  const held = locks.acquire(nodeId, peer.user, peer.connId);
  if (held) {
    send(peer, { type: 'lock_denied', nodeId, holder: sanitizeLock(held) });
  } else {
    broadcast({
      type: 'locked',
      nodeId,
      user: { userId: peer.user.userId, userName: peer.user.userName, color: peer.user.color },
    });
  }
}

function sanitizeLock(lock) {
  return { userId: lock.userId, userName: lock.userName, color: lock.color };
}

function handleUnlock(peer, msg) {
  const nodeId = String(msg.nodeId || '');
  if (locks.release(nodeId, peer.connId)) {
    broadcast({ type: 'unlocked', nodeId });
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

// 保存段落内容：版本号乐观锁 + diff3 三方合并
function handleSave(peer, msg) {
  const nodeId = String(msg.nodeId || '');
  const content = String(msg.content ?? '').slice(0, 100_000);
  const expectedVersion = Number(msg.baseVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    send(peer, { type: 'error', message: '缺少基准版本号' });
    return;
  }

  const node = store.getNode(db, nodeId);
  if (!node || node.deleted) {
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
      // 保存者自己不需要回声（本地已切回只读态，且乐观版本一致）
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
    // 真冲突：拒绝，返回三方原文，由用户在弹窗里裁决
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

  // 自动合并成功：以最新版本为基准落库，note 标记合并来源
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
    // 保存者也需要知道这是合并结果（它的草稿可能还开着）
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
  broadcast({
    type: 'content',
    nodeId,
    version: revision.version,
    content: revision.content,
    author: revision.author,
    authorId: revision.author_id,
    updatedAt: revision.created_at,
  }, exceptConnId);
}

// 回退后继续编辑的保存（diff4 语义）。
//   restoreVersion : 用户载入的旧版本号（共同祖先）
//   content        : 以旧版本为起点编辑后的草稿
//
// 合并视角：base = 旧版本，A = 服务器当前（别人在旧版本之后的演进），
// B = 用户草稿。于是：
//   - 别人与回退草稿不相交的改动 -> 自动保留；
//   - 同一块内容别人改了、草稿又恢复成旧样子 -> 冲突，交用户裁决；
//   - 最终作为一个新版本落库，历史完整可追溯。
function handleRestoreSave(peer, msg) {
  const nodeId = String(msg.nodeId || '');
  const content = String(msg.content ?? '').slice(0, 100_000);
  const restoreVersion = Number(msg.restoreVersion);
  if (!Number.isInteger(restoreVersion) || restoreVersion < 1) {
    send(peer, { type: 'error', message: '缺少回退基准版本号' });
    return;
  }

  const node = store.getNode(db, nodeId);
  if (!node || node.deleted) {
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

  // 已经有人把文档推进到更新版本：做三方合并
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

// ---------- 结构操作（增/删/移动层级）----------

function handleAdd(peer, msg) {
  const parentId = msg.parentId ? String(msg.parentId) : null;
  const afterId = msg.afterId ? String(msg.afterId) : null;
  const newId = crypto.randomUUID();

  const result = store.getDoc(db, store.DEFAULT_DOC);
  // 客户端传 treeRev 做乐观锁
  if (Number(msg.treeRev) !== result.tree_rev) {
    send(peer, { type: 'tree_stale', treeRev: result.tree_rev });
    send(peer, snapshotMessage());
    return;
  }

  // 计算新 pos：同级 afterId 之后（afterId 为空则插到开头）
  const pos = computePosAfter(db, parentId, afterId);
  const added = store.addNode(db, {
    id: newId,
    docId: store.DEFAULT_DOC,
    parentId,
    pos,
    content: String(msg.content || '').slice(0, 100_000) || '新段落',
    userId: peer.user.userId,
    userName: peer.user.userName,
  });
  broadcast({
    type: 'node_added',
    node: added.node,
    treeRev: added.treeRev,
    by: peer.user.userId,
  });
}

function computePosAfter(dbx, parentId, afterId) {
  const siblings = dbx
    .prepare(
      'SELECT id, pos FROM nodes WHERE doc_id = ? AND deleted = 0 AND parent_id IS ? ORDER BY pos',
    )
    .all(store.DEFAULT_DOC, parentId);
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

  if (parentId === nodeId || isDescendant(db, nodeId, parentId)) {
    send(peer, { type: 'error', nodeId, message: '不能把段落移动到自己的子级里' });
    return;
  }
  const pos = computePosForMove(db, parentId, afterId, nodeId);
  const result = store.moveNode(db, { nodeId, parentId, pos, treeRev });
  if (result.status === 'stale') {
    send(peer, { type: 'tree_stale', treeRev: result.treeRev });
    send(peer, snapshotMessage());
    return;
  }
  if (result.status === 'missing') return;
  broadcast({ type: 'node_moved', nodeId, parentId, pos, treeRev: result.treeRev });
}

// 移动时算位置，需排除被移动节点自身
function computePosForMove(dbx, parentId, afterId, movingId) {
  const siblings = dbx
    .prepare(
      'SELECT id, pos FROM nodes WHERE doc_id = ? AND deleted = 0 AND parent_id IS ? ORDER BY pos',
    )
    .all(store.DEFAULT_DOC, parentId)
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
  const result = store.deleteNode(db, { nodeId, treeRev: Number(msg.treeRev) });
  if (result.status === 'stale') {
    send(peer, { type: 'tree_stale', treeRev: result.treeRev });
    send(peer, snapshotMessage());
    return;
  }
  if (result.status !== 'deleted') return;
  // 释放被删除节点及其子树上的所有编辑锁
  for (const id of result.ids) {
    const lock = locks.locks.get(id);
    if (lock) {
      locks.release(id, lock.connId);
    }
  }
  broadcast({ type: 'nodes_deleted', ids: result.ids, treeRev: result.treeRev });
}

// ---------- WebSocket 生命周期 ----------

wss.on('connection', (ws) => {
  const connId = crypto.randomUUID();
  const peer = { connId, ws, user: null };
  peers.set(connId, peer);

  let alive = true;
  ws.on('pong', () => {
    alive = true;
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
    const released = locks.releaseAll(connId);
    for (const nodeId of released) broadcast({ type: 'unlocked', nodeId });
    broadcast({ type: 'presence', users: presenceList() });
  });

  ws.on('error', () => {
    // close 会接管清理
  });
});

// 死连接探测：ping 不回的连接终止（触发 close -> 释放锁）
const pingTimer = setInterval(() => {
  for (const [connId, peer] of peers) {
    if (!peer.alive) {
      peer.ws.terminate();
      continue;
    }
    peer.alive = false;
    try {
      peer.ws.ping();
    } catch {
      peer.ws.terminate();
    }
  }
}, LOCK_TTL);
pingTimer.unref?.();

// TTL 扫描：回收静默锁并广播（持有者连接还在但长期无心跳，例如笔记本休眠）
function sweepAndBroadcast() {
  const expired = locks.sweep();
  for (const nodeId of expired) broadcast({ type: 'unlocked', nodeId, reason: 'ttl' });
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
