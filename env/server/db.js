'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DEFAULT_DOC = 'default';

function init(dbFile) {
  if (dbFile !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbFile)), { recursive: true });
  }
  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      tree_rev   INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS nodes (
      id         TEXT PRIMARY KEY,
      doc_id     TEXT NOT NULL REFERENCES documents(id),
      parent_id  TEXT,
      pos        TEXT NOT NULL DEFAULT '',
      deleted    INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_nodes_doc ON nodes(doc_id, deleted);

    -- 段落级 append-only 历史。当前内容 = 该 node 最新一条 revision。
    CREATE TABLE IF NOT EXISTS revisions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id    TEXT NOT NULL,
      doc_id     TEXT NOT NULL,
      version    INTEGER NOT NULL,   -- 该 node 的单调版本号，从 1 开始
      content    TEXT NOT NULL,
      author_id  TEXT NOT NULL,
      author     TEXT NOT NULL,
      note       TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      UNIQUE(node_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_rev_node ON revisions(node_id, version);
  `);

  seedIfEmpty(db);
  return db;
}

function seedIfEmpty(db) {
  const row = db.prepare('SELECT COUNT(*) AS c FROM documents').get();
  if (row.c > 0) return;

  const now = Date.now();
  db.prepare(
    'INSERT INTO documents (id, title, tree_rev, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
  ).run(DEFAULT_DOC, '团队共享大纲', now, now);

  const seed = [
    { id: 'n1', parent: null, pos: '1', text: '项目目标：多人同时维护这份大纲' },
    { id: 'n2', parent: 'n1', pos: '1', text: '实时看到谁正在编辑哪一段' },
    { id: 'n3', parent: 'n1', pos: '2', text: '关掉页面后占用自动释放' },
    { id: 'n4', parent: null, pos: '2', text: '本周计划' },
    { id: 'n5', parent: 'n4', pos: '1', text: '点「编辑」开始改这一段，Ctrl+Enter 保存' },
  ];
  const insNode = db.prepare(
    'INSERT INTO nodes (id, doc_id, parent_id, pos, deleted, created_at) VALUES (?, ?, ?, ?, 0, ?)',
  );
  const insRev = db.prepare(
    `INSERT INTO revisions (node_id, doc_id, version, content, author_id, author, note, created_at)
     VALUES (?, ?, 1, ?, 'system', '系统', '初始内容', ?)`,
  );
  const tx = db.transaction((items) => {
    for (const it of items) {
      insNode.run(it.id, DEFAULT_DOC, it.parent, it.pos, now);
      insRev.run(it.id, DEFAULT_DOC, it.text, now);
    }
  });
  tx(seed);
}

// ---------- 读取 ----------

function getDoc(db, docId) {
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(docId);
}

// 当前快照：未删除节点 + 每条节点最新 revision
function getSnapshot(db, docId) {
  const doc = getDoc(db, docId);
  if (!doc) return null;
  const nodes = db
    .prepare(
      `SELECT n.id, n.parent_id AS parentId, n.pos, n.deleted,
              r.version, r.content, r.author, r.author_id AS authorId,
              r.created_at AS updatedAt
       FROM nodes n
       LEFT JOIN revisions r
         ON r.id = (SELECT id FROM revisions WHERE node_id = n.id
                    ORDER BY version DESC LIMIT 1)
       WHERE n.doc_id = ? AND n.deleted = 0
       ORDER BY n.parent_id, n.pos`,
    )
    .all(docId);
  return { doc, nodes };
}

function getNode(db, nodeId) {
  return db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
}

function getLatestRevision(db, nodeId) {
  return db
    .prepare('SELECT * FROM revisions WHERE node_id = ? ORDER BY version DESC LIMIT 1')
    .get(nodeId);
}

function getRevision(db, nodeId, revId) {
  return db
    .prepare('SELECT * FROM revisions WHERE id = ? AND node_id = ?')
    .get(revId, nodeId);
}

function getRevisionByVersion(db, nodeId, version) {
  return db
    .prepare('SELECT * FROM revisions WHERE node_id = ? AND version = ?')
    .get(nodeId, version);
}

function getHistory(db, nodeId, limit = 100) {
  return db
    .prepare(
      `SELECT id, version, content, author, author_id AS authorId, note, created_at AS createdAt
       FROM revisions WHERE node_id = ? ORDER BY version DESC LIMIT ?`,
    )
    .all(nodeId, limit);
}

// ---------- 写入（均在事务内完成）----------

// 追加一条 revision；expectedVersion 是编辑所基于的版本。
// 返回 { status: 'saved'|'stale', revision?, latest? }
function saveContent(db, { nodeId, content, expectedVersion, userId, userName, note }) {
  return db.transaction(() => {
    const node = getNode(db, nodeId);
    if (!node || node.deleted) return { status: 'missing' };
    const latest = getLatestRevision(db, nodeId);
    if (!latest) return { status: 'missing' };

    if (latest.version !== expectedVersion) {
      return { status: 'stale', latest };
    }
    if (latest.content === content) {
      return { status: 'noop', latest };
    }
    const version = latest.version + 1;
    const now = Date.now();
    const info = db
      .prepare(
        `INSERT INTO revisions (node_id, doc_id, version, content, author_id, author, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(nodeId, node.doc_id, version, content, userId, userName, note || '', now);
    const revision = getRevision(db, nodeId, info.lastInsertRowid);
    return { status: 'saved', revision };
  })();
}

function addNode(db, { id, docId, parentId, pos, content, userId, userName }) {
  return db.transaction(() => {
    const now = Date.now();
    db.prepare(
      'INSERT INTO nodes (id, doc_id, parent_id, pos, deleted, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    ).run(id, docId, parentId, pos, now);
    db.prepare(
      `INSERT INTO revisions (node_id, doc_id, version, content, author_id, author, note, created_at)
       VALUES (?, ?, 1, ?, ?, ?, '新建段落', ?)`,
    ).run(id, docId, content || '', userId, userName, now);
    db.prepare(
      'UPDATE documents SET tree_rev = tree_rev + 1, updated_at = ? WHERE id = ?',
    ).run(now, docId);
    const doc = getDoc(db, docId);
    const node = getSnapshot(db, docId).nodes.find((n) => n.id === id);
    return { node, treeRev: doc.tree_rev };
  })();
}

function moveNode(db, { nodeId, parentId, pos, treeRev }) {
  return db.transaction(() => {
    const node = getNode(db, nodeId);
    if (!node) return { status: 'missing' };
    const doc = getDoc(db, node.doc_id);
    // treeRev 为乐观锁：基于过期树结构的操作拒绝
    if (treeRev !== undefined && treeRev !== doc.tree_rev) {
      return { status: 'stale', treeRev: doc.tree_rev };
    }
    db.prepare('UPDATE nodes SET parent_id = ?, pos = ? WHERE id = ?').run(
      parentId,
      pos,
      nodeId,
    );
    const rev = doc.tree_rev + 1;
    db.prepare('UPDATE documents SET tree_rev = ?, updated_at = ? WHERE id = ?').run(
      rev,
      Date.now(),
      doc.id,
    );
    return { status: 'moved', treeRev: rev };
  })();
}

// 软删除节点及其所有后代
function deleteNode(db, { nodeId, treeRev }) {
  return db.transaction(() => {
    const node = getNode(db, nodeId);
    if (!node) return { status: 'missing' };
    const doc = getDoc(db, node.doc_id);
    if (treeRev !== undefined && treeRev !== doc.tree_rev) {
      return { status: 'stale', treeRev: doc.tree_rev };
    }
    const all = db.prepare('SELECT id, parent_id AS parentId FROM nodes WHERE doc_id = ? AND deleted = 0').all(doc.id);
    const byParent = new Map();
    for (const n of all) {
      if (!byParent.has(n.parentId)) byParent.set(n.parentId, []);
      byParent.get(n.parentId).push(n.id);
    }
    const ids = [];
    const stack = [nodeId];
    while (stack.length) {
      const id = stack.pop();
      ids.push(id);
      for (const child of byParent.get(id) || []) stack.push(child);
    }
    const stmt = db.prepare('UPDATE nodes SET deleted = 1 WHERE id = ?');
    for (const id of ids) stmt.run(id);
    const rev = doc.tree_rev + 1;
    db.prepare('UPDATE documents SET tree_rev = ?, updated_at = ? WHERE id = ?').run(
      rev,
      Date.now(),
      doc.id,
    );
    return { status: 'deleted', ids, treeRev: rev };
  })();
}

module.exports = {
  DEFAULT_DOC,
  init,
  getDoc,
  getSnapshot,
  getNode,
  getLatestRevision,
  getRevision,
  getRevisionByVersion,
  getHistory,
  saveContent,
  addNode,
  moveNode,
  deleteNode,
};
