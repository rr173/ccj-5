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
      mirror_of  TEXT,                       -- 非空 = 跟读段落，正文永远投影自该源节点
      deleted    INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_nodes_doc ON nodes(doc_id, deleted);
    CREATE INDEX IF NOT EXISTS idx_nodes_mirror ON nodes(mirror_of) WHERE mirror_of IS NOT NULL;

    -- 段落级 append-only 历史。当前内容 = 该 node 最新一条 revision。
    -- 跟读（mirror）节点自身没有 revision：它的内容是源节点 revision 的投影。
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

  // 旧库迁移：补 mirror_of 列
  const cols = db.prepare('PRAGMA table_info(nodes)').all();
  if (!cols.some((c) => c.name === 'mirror_of')) {
    db.exec('ALTER TABLE nodes ADD COLUMN mirror_of TEXT');
  }

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

// ---------- 文档 ----------

function listDocuments(db) {
  return db
    .prepare('SELECT id, title, tree_rev AS treeRev, updated_at AS updatedAt FROM documents ORDER BY created_at')
    .all();
}

function getDoc(db, docId) {
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(docId);
}

function createDocument(db, { id, title }) {
  const now = Date.now();
  db.prepare(
    'INSERT INTO documents (id, title, tree_rev, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
  ).run(id, title, now, now);
  return getDoc(db, id);
}

// ---------- 读取 ----------

// 当前快照：未删除节点；普通节点带最新 revision，跟读节点投影源节点正文。
function getSnapshot(db, docId) {
  const doc = getDoc(db, docId);
  if (!doc) return null;

  const own = db
    .prepare(
      `SELECT n.id, n.parent_id AS parentId, n.pos, n.mirror_of AS mirrorOf,
              r.version, r.content, r.author, r.author_id AS authorId,
              r.created_at AS updatedAt
       FROM nodes n
       LEFT JOIN revisions r
         ON r.id = (SELECT id FROM revisions WHERE node_id = n.id
                    ORDER BY version DESC LIMIT 1)
       WHERE n.doc_id = ? AND n.deleted = 0 AND n.mirror_of IS NULL
       ORDER BY n.parent_id, n.pos`,
    )
    .all(docId);
  for (const n of own) n.kind = 'node';

  const mirrors = db
    .prepare(
      `SELECT id, parent_id AS parentId, pos, mirror_of AS mirrorOf
       FROM nodes WHERE doc_id = ? AND deleted = 0 AND mirror_of IS NOT NULL
       ORDER BY parent_id, pos`,
    )
    .all(docId);

  // 批量解析源节点（源可能在别的文档，也可能已被删除）
  let sourceById = new Map();
  if (mirrors.length) {
    const sourceIds = [...new Set(mirrors.map((m) => m.mirrorOf))];
    const placeholders = sourceIds.map(() => '?').join(',');
    const sourceRows = db
      .prepare(
        `SELECT n.id, n.doc_id AS docId, n.deleted,
                r.version, r.content, r.author, r.author_id AS authorId,
                r.created_at AS updatedAt
         FROM nodes n
         LEFT JOIN revisions r
           ON r.id = (SELECT id FROM revisions WHERE node_id = n.id
                      ORDER BY version DESC LIMIT 1)
         WHERE n.id IN (${placeholders})`,
      )
      .all(...sourceIds);
    sourceById = new Map(sourceRows.map((r) => [r.id, r]));
  }

  for (const m of mirrors) {
    const src = sourceById.get(m.mirrorOf);
    const gone = !src || src.deleted;
    const node = {
      id: m.id,
      parentId: m.parentId,
      pos: m.pos,
      kind: 'mirror',
      mirrorOf: m.mirrorOf,
      sourceDocId: src ? src.docId : null,
      // 源没了：绝不用旧正文假装还在，显式墓碑状态
      sourceDeleted: gone ? 1 : 0,
    };
    if (!gone) {
      node.version = src.version;
      node.content = src.content;
      node.author = src.author;
      node.authorId = src.authorId;
      node.updatedAt = src.updatedAt;
    }
    own.push(node);
  }

  return { doc, nodes: own };
}

function getNode(db, nodeId) {
  return db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
}

// 跟读解析到最终源（禁止"跟读的跟读"：创建时直接落到最终源；这里做防御性解链）
function resolveSource(db, nodeId) {
  let cur = getNode(db, nodeId);
  const seen = new Set();
  while (cur && cur.mirror_of && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = getNode(db, cur.mirror_of);
  }
  return cur && !cur.mirror_of ? cur : null;
}

// 挂了这些源节点跟读的（其它）文档 id 列表
function mirrorHostDocs(db, sourceIds) {
  const ids = Array.isArray(sourceIds) ? sourceIds : [sourceIds];
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT DISTINCT doc_id AS docId FROM nodes
       WHERE deleted = 0 AND mirror_of IN (${placeholders})`,
    )
    .all(...ids);
  return rows.map((r) => r.docId);
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
    if (!node || node.deleted || node.mirror_of) return { status: 'missing' };
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
    bumpTreeRev(db, docId, now);
    const node = getSnapshot(db, docId).nodes.find((n) => n.id === id);
    return { node, treeRev: getDoc(db, docId).tree_rev };
  })();
}

// 挂一个跟读节点（自身无正文、无 revision）
function addMirrorNode(db, { id, docId, parentId, pos, mirrorOf }) {
  return db.transaction(() => {
    const now = Date.now();
    db.prepare(
      'INSERT INTO nodes (id, doc_id, parent_id, pos, mirror_of, deleted, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
    ).run(id, docId, parentId, pos, mirrorOf, now);
    bumpTreeRev(db, docId, now);
    const node = getSnapshot(db, docId).nodes.find((n) => n.id === id);
    return { node, treeRev: getDoc(db, docId).tree_rev };
  })();
}

function bumpTreeRev(db, docId, now = Date.now()) {
  db.prepare('UPDATE documents SET tree_rev = tree_rev + 1, updated_at = ? WHERE id = ?').run(
    now,
    docId,
  );
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

// 软删除节点及其所有后代。
// 普通节点：连带子树；跟读节点：没有子级（创建时禁止），只移除这一处挂载，源不受影响。
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
    bumpTreeRev(db, doc.id);
    return {
      status: 'deleted',
      ids,
      treeRev: getDoc(db, doc.id).tree_rev,
      kind: node.mirror_of ? 'mirror' : 'node',
    };
  })();
}

module.exports = {
  DEFAULT_DOC,
  init,
  listDocuments,
  getDoc,
  createDocument,
  getSnapshot,
  getNode,
  resolveSource,
  mirrorHostDocs,
  getLatestRevision,
  getRevision,
  getRevisionByVersion,
  getHistory,
  saveContent,
  addNode,
  addMirrorNode,
  moveNode,
  deleteNode,
};
