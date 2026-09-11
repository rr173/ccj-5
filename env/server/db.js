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

    -- 公开的改写提议：pending 期间所有人可见，但绝不参与正文投影；
    -- accepted 时在同一个事务里 CAS 到 revisions，原子地完成"收下"。
    CREATE TABLE IF NOT EXISTS suggestions (
      id              TEXT PRIMARY KEY,
      node_id         TEXT NOT NULL,      -- 永远是源节点 id（跟读入口也解析到源）
      base_version    INTEGER NOT NULL,   -- 提议所基于的正文版本
      content         TEXT NOT NULL,
      author_id       TEXT NOT NULL,
      author          TEXT NOT NULL,
      status          TEXT NOT NULL,      -- pending | accepted | withdrawn | superseded
      accepted_rev_id INTEGER,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_suggestions_node
      ON suggestions(node_id, status, created_at);

    -- 整份大纲的 append-only 时间轴：结构（增/移/删/挂跟读）与内容（每次保存）
    -- 共用同一个全局单调 seq，seq 就是"时刻"坐标。任意 seq 可确定性重建
    -- 当时整棵树的层级 + 正文（跟读投影源在同一 seq 的内容），所有人看到
    -- 的必然是同一份重建结果。
    CREATE TABLE IF NOT EXISTS timeline (
      seq         INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id      TEXT NOT NULL,      -- 事件归属文档（内容事件 = 源节点所在文档）
      kind        TEXT NOT NULL,      -- add | mirror_add | move | delete | content
      node_id     TEXT NOT NULL,      -- 主语节点（delete 时是删除起点）
      parent_id   TEXT,               -- add/mirror_add/move：新父级
      pos         TEXT,               -- add/mirror_add/move：新位置
      mirror_of   TEXT,               -- mirror_add：源节点
      deleted_ids TEXT,               -- delete：JSON 数组（整棵子树）
      rev_id      INTEGER,            -- 该时刻生效的 revision（add 时为 v1）
      author      TEXT NOT NULL DEFAULT '',
      author_id   TEXT NOT NULL DEFAULT '',
      note        TEXT NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_timeline_doc ON timeline(doc_id, seq);
    CREATE INDEX IF NOT EXISTS idx_timeline_node ON timeline(node_id, seq);
  `);

  // 旧库迁移：补 mirror_of 列（必须先于该列的索引创建）
  const cols = db.prepare('PRAGMA table_info(nodes)').all();
  if (!cols.some((c) => c.name === 'mirror_of')) {
    db.exec('ALTER TABLE nodes ADD COLUMN mirror_of TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_mirror ON nodes(mirror_of) WHERE mirror_of IS NOT NULL');

  backfillTimeline(db);
  seedIfEmpty(db);
  return db;
}

// 旧库（没有 timeline 的时代）升级：按 created_at 尽力重放一条时间轴。
// 能恢复：每段的创建（含初始正文）与全部内容保存；软删节点补一条迁移时刻的
// delete。恢复不了：历史上的移动轨迹（parent/pos 只能按当前值回填）。
// 启用之后的操作都是精确记录，回看从升级点开始严格准确。
function backfillTimeline(db) {
  const has = db.prepare('SELECT COUNT(*) AS c FROM timeline').get().c > 0;
  if (has) return;
  const hasData =
    db.prepare('SELECT COUNT(*) AS c FROM revisions').get().c > 0 ||
    db.prepare('SELECT COUNT(*) AS c FROM nodes').get().c > 0;
  if (!hasData) return; // 全新库：seed 会自己写事件

  const now = Date.now();
  const ins = db.prepare(
    `INSERT INTO timeline (doc_id, kind, node_id, parent_id, pos, mirror_of, deleted_ids, rev_id, author, author_id, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)`,
  );
  const revOf = db.prepare('SELECT * FROM revisions WHERE node_id = ? AND version = ?');
  const events = [];
  for (const n of db.prepare('SELECT * FROM nodes').all()) {
    const v1 = revOf.get(n.id, 1);
    events.push({
      at: n.created_at, pri: 0,
      run: () => ins.run(
        n.doc_id, n.mirror_of ? 'mirror_add' : 'add', n.id, n.parent_id, n.pos,
        n.mirror_of, null, v1 ? v1.id : null, '系统', '迁移回填', n.created_at,
      ),
    });
  }
  for (const r of db.prepare('SELECT * FROM revisions WHERE version >= 2').all()) {
    events.push({
      at: r.created_at, pri: 1,
      run: () => ins.run(r.doc_id, 'content', r.node_id, null, null, null, null, r.id, r.author, r.note, r.created_at),
    });
  }
  // 软删节点：整棵子树在 nodes 表里各自 deleted=1，逐个补 delete 事件即可
  for (const n of db.prepare('SELECT * FROM nodes WHERE deleted = 1').all()) {
    events.push({
      at: now, pri: 2,
      run: () => ins.run(n.doc_id, 'delete', n.id, null, null, null, JSON.stringify([n.id]), null, '系统', '迁移回填（此前已被删除）', now),
    });
  }
  events.sort((a, b) => a.at - b.at || a.pri - b.pri);
  const tx = db.transaction(() => {
    for (const e of events) e.run();
  });
  tx();
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
      const revId = insRev.run(it.id, DEFAULT_DOC, it.text, now).lastInsertRowid;
      logEvent(db, {
        docId: DEFAULT_DOC, kind: 'add', nodeId: it.id, parentId: it.parent, pos: it.pos,
        revId, author: '系统', authorId: 'system', note: '初始内容', at: now,
      });
    }
  });
  tx(seed);
}

// ---------- 文档 ----------

// 追加一条时间轴事件（必须在调用方的事务里用，与数据写入同生共死）
function logEvent(db, {
  docId, kind, nodeId, parentId = null, pos = null, mirrorOf = null,
  deletedIds = null, revId = null, author = '', authorId = '', note = '', at = null,
}) {
  db.prepare(
    `INSERT INTO timeline (doc_id, kind, node_id, parent_id, pos, mirror_of, deleted_ids, rev_id, author, author_id, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    docId, kind, nodeId, parentId, pos, mirrorOf,
    deletedIds ? JSON.stringify(deletedIds) : null, revId,
    author, authorId, note, at ?? Date.now(),
  );
}

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

// ---------- 改写提议 ----------

function normalizeSuggestion(r) {
  return {
    id: r.id,
    nodeId: r.node_id,
    baseVersion: r.base_version,
    content: r.content,
    authorId: r.author_id,
    author: r.author,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function getSuggestion(db, suggestionId) {
  const row = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(suggestionId);
  return row ? normalizeSuggestion(row) : null;
}

function listPendingSuggestions(db, sourceIds) {
  const ids = [...new Set(sourceIds || [])];
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT * FROM suggestions
       WHERE status = 'pending' AND node_id IN (${placeholders})
       ORDER BY created_at, rowid`,
    )
    .all(...ids)
    .map(normalizeSuggestion);
}

function supersedePendingSuggestions(db, nodeId, exceptSuggestionId = null) {
  const rows = db
    .prepare(
      `SELECT id FROM suggestions
       WHERE node_id = ? AND status = 'pending'
         AND (? IS NULL OR id != ?)`,
    )
    .all(nodeId, exceptSuggestionId, exceptSuggestionId);
  const ids = rows.map((r) => r.id);
  if (ids.length) {
    const now = Date.now();
    const placeholders = ids.map(() => '?').join(',');
    db
      .prepare(`UPDATE suggestions SET status = 'superseded', updated_at = ? WHERE id IN (${placeholders})`)
      .run(now, ...ids);
  }
  return ids;
}

function createSuggestion(db, { id, nodeId, content, baseVersion, userId, userName }) {
  return db.transaction(() => {
    const node = getNode(db, nodeId);
    if (!node || node.deleted || node.mirror_of) return { status: 'missing' };
    const latest = getLatestRevision(db, nodeId);
    if (!latest) return { status: 'missing' };
    if (!Number.isInteger(baseVersion) || baseVersion < 1) return { status: 'bad_base' };
    if (latest.version !== baseVersion) return { status: 'stale', latest: normalizeRevision(latest) };
    if (latest.content === content) return { status: 'noop', latest: normalizeRevision(latest) };

    const now = Date.now();
    db
      .prepare(
        `INSERT INTO suggestions
           (id, node_id, base_version, content, author_id, author, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(id, nodeId, baseVersion, content, userId, userName, now, now);
    return { status: 'created', suggestion: getSuggestion(db, id) };
  })();
}

function withdrawSuggestion(db, { suggestionId, userId }) {
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(suggestionId);
    if (!row) return { status: 'missing' };
    if (row.author_id !== userId) return { status: 'forbidden' };
    if (row.status !== 'pending') return { status: 'not_pending', suggestion: normalizeSuggestion(row) };
    const now = Date.now();
    db.prepare("UPDATE suggestions SET status = 'withdrawn', updated_at = ? WHERE id = ?").run(now, suggestionId);
    return { status: 'withdrawn', suggestion: getSuggestion(db, suggestionId) };
  })();
}

// 收下提议：CAS 条件 = 提议仍是 pending，且正文当前版本仍是它所基于的版本。
// 插入 revision 与把同段其它 pending 置为 superseded 在同一事务，杜绝两边都回执成功。
function acceptSuggestion(db, { suggestionId, userId, userName }) {
  return db.transaction(() => {
    const srow = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(suggestionId);
    if (!srow) return { status: 'missing' };
    const suggestion = normalizeSuggestion(srow);
    const node = getNode(db, suggestion.nodeId);
    if (!node || node.deleted || node.mirror_of) return { status: 'missing', suggestion };
    if (suggestion.status === 'accepted' || suggestion.status === 'withdrawn') {
      return { status: 'not_pending', suggestion };
    }

    const latest = getLatestRevision(db, suggestion.nodeId);
    if (!latest) return { status: 'missing', suggestion };
    if (suggestion.status === 'superseded' || latest.version !== suggestion.baseVersion) {
      const now = Date.now();
      db.prepare("UPDATE suggestions SET status = 'superseded', updated_at = ? WHERE id = ? AND status = 'pending'").run(now, suggestionId);
      return {
        status: 'stale',
        suggestion: getSuggestion(db, suggestionId),
        latest: normalizeRevision(latest),
        supersededIds: [suggestionId],
      };
    }
    if (latest.content === suggestion.content) {
      db
        .prepare('UPDATE suggestions SET status = ?, accepted_rev_id = ?, updated_at = ? WHERE id = ?')
        .run('accepted', latest.id, Date.now(), suggestionId);
      return { status: 'noop', revision: normalizeRevision(latest), suggestion: getSuggestion(db, suggestionId) };
    }

    const now = Date.now();
    const info = db
      .prepare(
        `INSERT INTO revisions (node_id, doc_id, version, content, author_id, author, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        suggestion.nodeId,
        node.doc_id,
        latest.version + 1,
        suggestion.content,
        suggestion.authorId,
        suggestion.author,
        `改写提议被 ${userName} 收下`,
        now,
      );
    const revision = getRevision(db, suggestion.nodeId, info.lastInsertRowid);
    db
      .prepare('UPDATE suggestions SET status = ?, accepted_rev_id = ?, updated_at = ? WHERE id = ?')
      .run('accepted', revision.id, now, suggestionId);
    const supersededIds = supersedePendingSuggestions(db, suggestion.nodeId, suggestionId);
    logEvent(db, {
      docId: node.doc_id,
      kind: 'content',
      nodeId: suggestion.nodeId,
      revId: revision.id,
      author: suggestion.author,
      authorId: suggestion.authorId,
      note: `改写提议被 ${userName} 收下`,
      at: now,
    });
    return { status: 'saved', revision, suggestion: getSuggestion(db, suggestionId), supersededIds };
  })();
}

function normalizeRevision(r) {
  return {
    id: r.id,
    node_id: r.node_id,
    doc_id: r.doc_id,
    version: r.version,
    content: r.content,
    author_id: r.author_id,
    author: r.author,
    note: r.note,
    created_at: r.created_at,
  };
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
    const supersededSuggestionIds = supersedePendingSuggestions(db, nodeId);
    logEvent(db, {
      docId: node.doc_id, kind: 'content', nodeId, revId: revision.id,
      author: userName, authorId: userId, note: note || '', at: now,
    });
    return { status: 'saved', revision, supersededSuggestionIds };
  })();
}

function addNode(db, { id, docId, parentId, pos, content, userId, userName }) {
  return db.transaction(() => {
    const now = Date.now();
    db.prepare(
      'INSERT INTO nodes (id, doc_id, parent_id, pos, deleted, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    ).run(id, docId, parentId, pos, now);
    const revId = db.prepare(
      `INSERT INTO revisions (node_id, doc_id, version, content, author_id, author, note, created_at)
       VALUES (?, ?, 1, ?, ?, ?, '新建段落', ?)`,
    ).run(id, docId, content || '', userId, userName, now).lastInsertRowid;
    logEvent(db, {
      docId, kind: 'add', nodeId: id, parentId, pos, revId,
      author: userName, authorId: userId, note: '新建段落', at: now,
    });
    bumpTreeRev(db, docId, now);
    const node = getSnapshot(db, docId).nodes.find((n) => n.id === id);
    return { node, treeRev: getDoc(db, docId).tree_rev };
  })();
}

// 挂一个跟读节点（自身无正文、无 revision）
function addMirrorNode(db, { id, docId, parentId, pos, mirrorOf, userId = '', userName = '' }) {
  return db.transaction(() => {
    const now = Date.now();
    db.prepare(
      'INSERT INTO nodes (id, doc_id, parent_id, pos, mirror_of, deleted, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
    ).run(id, docId, parentId, pos, mirrorOf, now);
    logEvent(db, {
      docId, kind: 'mirror_add', nodeId: id, parentId, pos, mirrorOf,
      author: userName, authorId: userId, note: '挂载跟读', at: now,
    });
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

function moveNode(db, { nodeId, parentId, pos, treeRev, userId = '', userName = '' }) {
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
    const now = Date.now();
    db.prepare('UPDATE documents SET tree_rev = ?, updated_at = ? WHERE id = ?').run(
      rev,
      now,
      doc.id,
    );
    logEvent(db, {
      docId: doc.id, kind: 'move', nodeId, parentId, pos,
      author: userName, authorId: userId, note: '移动/调整层级', at: now,
    });
    return { status: 'moved', treeRev: rev };
  })();
}

// 软删除节点及其所有后代。
// 普通节点：连带子树；跟读节点：没有子级（创建时禁止），只移除这一处挂载，源不受影响。
function deleteNode(db, { nodeId, treeRev, userId = '', userName = '' }) {
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
    const supersededSuggestionIds = [];
    for (const id of ids) {
      supersededSuggestionIds.push(...supersedePendingSuggestions(db, id));
    }
    logEvent(db, {
      docId: doc.id, kind: 'delete', nodeId, deletedIds: ids,
      author: userName, authorId: userId,
      note: node.mirror_of ? '移除跟读' : `删除段落（含子树共 ${ids.length} 段）`,
    });
    bumpTreeRev(db, doc.id);
    return {
      status: 'deleted',
      ids,
      treeRev: getDoc(db, doc.id).tree_rev,
      kind: node.mirror_of ? 'mirror' : 'node',
      supersededSuggestions: supersededSuggestionIds.map((id) => getSuggestion(db, id)),
    };
  })();
}

// ---------- 整份时间轴：时刻列表与历史快照 ----------

function latestSeq(db) {
  return db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM timeline').get().s;
}

function clip(text, n = 24) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// 全局事件流（倒序）。时刻坐标 seq 跨文档统一：跟读宿主文档与源文档
// 用同一把时间尺，"回到时刻 S" 在两份大纲里指向严格同一状态。
function getTimeline(db, limit = 300) {
  const rows = db
    .prepare(
      `SELECT t.seq, t.doc_id AS docId, d.title AS docTitle, t.kind, t.node_id AS nodeId,
              t.deleted_ids AS deletedIds, t.author, t.note, t.created_at AS createdAt,
              r.content AS revContent
       FROM timeline t
       LEFT JOIN documents d ON d.id = t.doc_id
       LEFT JOIN revisions r ON r.id = t.rev_id
       ORDER BY t.seq DESC LIMIT ?`,
    )
    .all(limit);
  return rows.map((r) => {
    let summary;
    if (r.kind === 'add') summary = `新增段落「${clip(r.revContent)}」`;
    else if (r.kind === 'content') summary = `修改段落「${clip(r.revContent)}」`;
    else if (r.kind === 'mirror_add') summary = '挂载跟读';
    else if (r.kind === 'move') summary = '移动段落 / 调整层级';
    else if (r.kind === 'delete') {
      summary = `删除段落（共 ${(JSON.parse(r.deletedIds || '[]')).length} 段）`;
    } else summary = r.kind;
    return {
      seq: r.seq, docId: r.docId, docTitle: r.docTitle || '', kind: r.kind,
      nodeId: r.nodeId, summary, author: r.author, note: r.note, createdAt: r.createdAt,
    };
  });
}

// 把整份大纲重建到时刻 seq：结构按事件重放，内容取每段当时生效的 revision；
// 跟读行投影源节点在同一 seq 的内容（seq 全局单调，跨文档严格同一时刻）。
// 结果是 seq 的纯函数：任何人、任何时候请求，拿到的都是同一份。
function getSnapshotAt(db, docId, seq) {
  const doc = getDoc(db, docId);
  if (!doc) return null;
  const maxSeq = latestSeq(db);
  const at = Math.max(0, Math.min(Number(seq) || 0, maxSeq));
  const atRow = at > 0
    ? db.prepare('SELECT created_at AS createdAt FROM timeline WHERE seq = ?').get(at)
    : null;

  // 1) 结构：全局重放（跟读源可能在别的大纲，必须一起重放才知道源当时是否存活）
  const structEvents = db
    .prepare(
      `SELECT kind, node_id AS nodeId, doc_id AS docId, parent_id AS parentId, pos,
              mirror_of AS mirrorOf, deleted_ids AS deletedIds
       FROM timeline WHERE kind != 'content' AND seq <= ? ORDER BY seq`,
    )
    .all(at);
  const tree = new Map(); // nodeId -> { docId, parentId, pos, mirrorOf, deleted }
  for (const e of structEvents) {
    if (e.kind === 'add' || e.kind === 'mirror_add') {
      tree.set(e.nodeId, {
        docId: e.docId, parentId: e.parentId, pos: e.pos, mirrorOf: e.mirrorOf, deleted: 0,
      });
    } else if (e.kind === 'move') {
      const n = tree.get(e.nodeId);
      if (n && !n.deleted) {
        n.parentId = e.parentId;
        n.pos = e.pos;
      }
    } else if (e.kind === 'delete') {
      for (const id of JSON.parse(e.deletedIds || '[]')) {
        const n = tree.get(id);
        if (n) n.deleted = 1;
      }
    }
  }

  // 2) 内容：每个节点在 at 时刻生效的 revision（一次批量查询）
  const contentRows = db
    .prepare(
      `SELECT t.node_id AS nodeId, r.version, r.content, r.author,
              r.author_id AS authorId, r.created_at AS updatedAt
       FROM timeline t
       JOIN (SELECT node_id, MAX(seq) AS ms FROM timeline
             WHERE rev_id IS NOT NULL AND seq <= ? GROUP BY node_id) latest
         ON latest.node_id = t.node_id AND latest.ms = t.seq
       JOIN revisions r ON r.id = t.rev_id`,
    )
    .all(at);
  const contentAt = new Map(contentRows.map((r) => [r.nodeId, r]));

  // 3) 当前存活状态：前端用它把"此刻已被删"的段落的「接着改」按钮置灰
  const aliveNow = new Set(
    db.prepare('SELECT id FROM nodes WHERE deleted = 0').all().map((r) => r.id),
  );

  // 4) 组装该文档在 at 时刻的可见树（格式与实时快照一致）
  const nodes = [];
  for (const [id, n] of tree) {
    if (n.docId !== docId || n.deleted) continue;
    if (!n.mirrorOf) {
      const c = contentAt.get(id);
      nodes.push({
        id, parentId: n.parentId, pos: n.pos, kind: 'node',
        version: c ? c.version : 0,
        content: c ? c.content : '',
        author: c ? c.author : '',
        authorId: c ? c.authorId : '',
        updatedAt: c ? c.updatedAt : null,
        aliveNow: aliveNow.has(id) ? 1 : 0,
      });
    } else {
      const src = tree.get(n.mirrorOf);
      const gone = !src || src.deleted;
      const node = {
        id, parentId: n.parentId, pos: n.pos, kind: 'mirror', mirrorOf: n.mirrorOf,
        sourceDocId: src ? src.docId : null,
        sourceDeleted: gone ? 1 : 0,
        aliveNow: aliveNow.has(id) ? 1 : 0,
        sourceAliveNow: aliveNow.has(n.mirrorOf) ? 1 : 0,
      };
      if (!gone) {
        const c = contentAt.get(n.mirrorOf);
        if (c) {
          node.version = c.version;
          node.content = c.content;
          node.author = c.author;
          node.authorId = c.authorId;
          node.updatedAt = c.updatedAt;
        }
      }
      nodes.push(node);
    }
  }
  return { doc, asOf: { seq: at, createdAt: atRow ? atRow.createdAt : null, latestSeq: maxSeq }, nodes };
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
  getSuggestion,
  listPendingSuggestions,
  createSuggestion,
  withdrawSuggestion,
  acceptSuggestion,
  saveContent,
  addNode,
  addMirrorNode,
  moveNode,
  deleteNode,
  latestSeq,
  getTimeline,
  getSnapshotAt,
};
