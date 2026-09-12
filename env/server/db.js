'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { midpoint } = require('./fraction');

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
      excerpt_of TEXT,                       -- 非空 = 摘录段落，正文是摘录时刻冻结的副本（不随源变）
      deleted    INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_nodes_doc ON nodes(doc_id, deleted);

    -- 摘录（excerpt）：把某段在某一时刻的正文抄一份冻在这里。
    -- 与跟读（mirror）相反，摘录不投影源：源之后怎么改，这行字都不变，
    -- 直到有人显式「对齐到原文此刻」——对齐在一个事务里把新冻结副本写入
    -- 新的一行（append-only，每次对齐留痕），并广播同一条 excerpt_aligned，
    -- 所有正在看的人必然看到同一份。
    CREATE TABLE IF NOT EXISTS excerpt_states (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id        TEXT NOT NULL,         -- 摘录节点 id（nodes.excerpt_of 非空）
      doc_id         TEXT NOT NULL,
      content        TEXT NOT NULL,         -- 这次冻结下来的正文
      source_version INTEGER NOT NULL,      -- 冻结时源段落的版本号（CAS 基准/陈旧判定）
      author_id      TEXT NOT NULL DEFAULT '',
      author         TEXT NOT NULL DEFAULT '',
      created_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_excerpt_node ON excerpt_states(node_id, id);

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

    -- 整份大纲的 append-only 时间轴：结构（增/移/删/挂跟读/做摘录）与内容（每次保存）
    -- 共用同一个全局单调 seq，seq 就是"时刻"坐标。任意 seq 可确定性重建
    -- 当时整棵树的层级 + 正文（跟读投影源在同一 seq 的内容；摘录展示它在最近一次
    -- excerpt_add/excerpt_align 时刻冻结的正文），所有人看到的必然是同一份重建结果。
    CREATE TABLE IF NOT EXISTS timeline (
      seq         INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id      TEXT NOT NULL,      -- 事件归属文档（内容事件 = 源节点所在文档）
      kind        TEXT NOT NULL,      -- add | mirror_add | excerpt_add | excerpt_align | move | delete | content
      node_id     TEXT NOT NULL,      -- 主语节点（delete 时是删除起点）
      parent_id   TEXT,               -- add/mirror_add/excerpt_add/move：新父级
      pos         TEXT,               -- add/mirror_add/excerpt_add/move：新位置
      mirror_of   TEXT,               -- mirror_add：源节点
      excerpt_of  TEXT,               -- excerpt_add：源节点
      excerpt_content TEXT,           -- excerpt_add/excerpt_align：该时刻冻结的摘录正文
      excerpt_source_version INTEGER, -- excerpt_add/excerpt_align：冻结所对齐到的源版本
      deleted_ids TEXT,               -- delete：JSON 数组（整棵子树）
      rev_id      INTEGER,            -- 该时刻生效的 revision（add 时为 v1）
      author      TEXT NOT NULL DEFAULT '',
      author_id   TEXT NOT NULL DEFAULT '',
      note        TEXT NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_timeline_doc ON timeline(doc_id, seq);
    CREATE INDEX IF NOT EXISTS idx_timeline_node ON timeline(node_id, seq);

    -- 对外定稿：每次「定出去」追加一行，snapshot 是发布时刻整树（含跟读投影
    -- 后的正文）的冻结副本。定稿一旦写入就不可变；工作稿之后的任何修改都与它
    -- 无关。当前对外版本 = 该文档 pub_seq 最大的一行。
    -- base_seq 是乐观锁（CAS）：并发定稿时只有基于"当前最新定稿"的那一个能成功，
    -- 后来者收到 stale，保证不存在"两边都显示定出去了却对不上"。
    CREATE TABLE IF NOT EXISTS publications (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id      TEXT NOT NULL,
      pub_seq     INTEGER NOT NULL,   -- 该文档内单调的定稿版本号，从 1 开始
      base_seq    INTEGER NOT NULL,   -- 定稿者看到的上一版定稿（0 = 首次定稿）
      timeline_seq INTEGER NOT NULL,  -- 冻结时工作稿对应的全局时刻
      title       TEXT NOT NULL,      -- 定稿时刻的标题（标题不参与回看，这里一并冻结）
      snapshot    TEXT NOT NULL,      -- JSON：{ nodes: [...] }，结构与 snapshot 消息一致
      author_id   TEXT NOT NULL,
      author      TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      UNIQUE(doc_id, pub_seq)
    );
    CREATE INDEX IF NOT EXISTS idx_publications_doc ON publications(doc_id, pub_seq);

    -- 段落留言：锚定在「段落」（nodes.id，含跨文档跟读挂载行），不锚定正文版本——
    -- 正文怎么改、改多少版，留言都原样挂在这段上（revisions 与 comments 互不相干）。
    -- status 的 open/resolved 状态机就是并发收敛点：两条「收掉」在同一事务里串行，
    -- UPDATE ... WHERE status='open' 只有一条会真正生效，后到者只拿到已收事实，
    -- 全员广播同一条 comment_resolved，不可能"两边都显示收了、收的说法却对不上"。
    CREATE TABLE IF NOT EXISTS comments (
      id          TEXT PRIMARY KEY,
      doc_id      TEXT NOT NULL,          -- 留言挂在哪个文档房间（决定广播范围）
      node_id     TEXT NOT NULL,          -- 锚定的段落：普通行或跟读挂载行（各自独立）
      content     TEXT NOT NULL,
      author_id   TEXT NOT NULL,
      author      TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'open',  -- open | resolved
      resolved_content TEXT,              -- 收掉时的说法（resolved 后冻结，全员同一份）
      resolved_by_id  TEXT,
      resolved_by     TEXT,
      created_at  INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_comments_doc ON comments(doc_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_comments_node ON comments(node_id, created_at);

    -- 段落封口：append-only 状态流。每一段"当前是否封着"= 该 node 最新一条事件：
    -- kind='sealed' 即封着（带唯一一份封口理由），kind='unsealed' 即开着。
    -- 封口是 open ⇄ sealed 可反复翻转的状态机，收敛点就在这张表的事务串行上：
    -- 两条几乎同时到达的 seal 在同一 SQLite 事务队列里排队，后到者事务内已能读到
    -- 先到者插入的 sealed，只拿到 already（连同先到者的理由）——调用方只广播
    -- 先到者那一条 sealed，不可能"两边都显示封住，理由却对不上"。
    -- 封的永远是源普通段落（跟读入口在处理器里解析到源，与编辑锁一致）；
    -- 跟读行投影源的封口状态，摘录是冻结副本、不参与封口。
    CREATE TABLE IF NOT EXISTS seal_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id    TEXT NOT NULL,          -- 永远是源普通节点 id
      doc_id     TEXT NOT NULL,          -- 源所在文档（决定时间轴归属/扇出辅助）
      kind       TEXT NOT NULL,          -- sealed | unsealed
      reason     TEXT NOT NULL DEFAULT '',-- sealed：封口理由；unsealed：打开说明（可空）
      author_id  TEXT NOT NULL DEFAULT '',
      author     TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_seal_node ON seal_events(node_id, id);

    -- 可捞名单（回收站）：删除一个普通段落（含整棵子树）时，在同事务追加一批。
    -- "谁还能捞"由这张表唯一决定：删除后广播同一份给整个文档房间（含发起者的
    -- 其他标签页），晚加入者从 snapshot.trash 整份拿到——不是谁自己屏幕上的临时状态。
    -- 一批 = 一次删除（root_id 是被删的起点）；整棵子树随 root 一起回来，不逐段捞。
    -- 捞回（restore）时按 id 的 CAS 在同一事务串行：先到者把整批 deleted=0、
    -- 追加一条 restore 时间轴；后到者事务里读到 active=0，只拿到 already + 先捞者
    -- 那份事实（节点新位置），房间里绝不会有两条 nodes_restored，不可能
    -- "两边都显示捞回来了、位置/内容却对不上"。
    CREATE TABLE IF NOT EXISTS trash_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id      TEXT NOT NULL,         -- 这批归属的文档房间（决定名单广播范围）
      root_id     TEXT NOT NULL,         -- 被删起点（捞回只认 root，子树随它一起）
      ids         TEXT NOT NULL,         -- JSON 数组：整棵子树（删除时的全部 id）
      parent_id   TEXT,                  -- 删掉前 root 的父级（顶层为 NULL）
      pos         TEXT NOT NULL DEFAULT '', -- 删掉前 root 的同级位置
      preview     TEXT NOT NULL DEFAULT '', -- root 删前正文摘要（名单里展示用）
      count       INTEGER NOT NULL DEFAULT 1, -- 这批共多少段（含子树）
      active      INTEGER NOT NULL DEFAULT 1, -- 1=在名单里可捞；0=已捞回（留痕）
      author_id   TEXT NOT NULL DEFAULT '',
      author      TEXT NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL,
      restored_at INTEGER,
      restored_by_id TEXT,
      restored_by    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_trash_doc ON trash_events(doc_id, active, id);
  `);

  // 旧库迁移：补 mirror_of / excerpt_of 列（必须先于该列的索引创建）
  const cols = db.prepare('PRAGMA table_info(nodes)').all();
  if (!cols.some((c) => c.name === 'mirror_of')) {
    db.exec('ALTER TABLE nodes ADD COLUMN mirror_of TEXT');
  }
  if (!cols.some((c) => c.name === 'excerpt_of')) {
    db.exec('ALTER TABLE nodes ADD COLUMN excerpt_of TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_mirror ON nodes(mirror_of) WHERE mirror_of IS NOT NULL');
  db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_excerpt ON nodes(excerpt_of) WHERE excerpt_of IS NOT NULL');

  // 旧库迁移：timeline 补摘录相关列
  const tlCols = db.prepare('PRAGMA table_info(timeline)').all();
  if (!tlCols.some((c) => c.name === 'excerpt_of')) {
    db.exec('ALTER TABLE timeline ADD COLUMN excerpt_of TEXT');
  }
  if (!tlCols.some((c) => c.name === 'excerpt_content')) {
    db.exec('ALTER TABLE timeline ADD COLUMN excerpt_content TEXT');
  }
  if (!tlCols.some((c) => c.name === 'excerpt_source_version')) {
    db.exec('ALTER TABLE timeline ADD COLUMN excerpt_source_version INTEGER');
  }

  backfillTimeline(db);
  backfillTrash(db);
  seedIfEmpty(db);
  return db;
}

// 旧库升级：当前仍处于删除状态的普通段落补进可捞名单。
// 一次 delete 事件对应一批（deleted_ids）；只补"这批现在整体仍删着"的批次，
// 已捞回/已不在的不补。跟读/摘录的摘除（kind=delete 但行是引用行）不进名单。
function backfillTrash(db) {
  const hasTrash = db.prepare('SELECT COUNT(*) AS c FROM trash_events').get().c > 0;
  if (hasTrash) return;
  const deletedRows = db
    .prepare(
      `SELECT t.*, r.content AS revContent
       FROM timeline t
       LEFT JOIN revisions r ON r.id = t.rev_id
       WHERE t.kind = 'delete'
       ORDER BY t.seq`,
    )
    .all();
  if (!deletedRows.length) return;
  const now = Date.now();
  const ins = db.prepare(
    `INSERT INTO trash_events
       (doc_id, root_id, ids, parent_id, pos, preview, count, active,
        author_id, author, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  );
  const nodeStmt = db.prepare('SELECT * FROM nodes WHERE id = ?');
  const revStmt = db.prepare(
    'SELECT content FROM revisions WHERE node_id = ? ORDER BY version DESC LIMIT 1',
  );
  const tx = db.transaction(() => {
    for (const e of deletedRows) {
      let ids;
      try { ids = JSON.parse(e.deleted_ids || '[]'); } catch { ids = []; }
      if (!ids.length) continue;
      const root = nodeStmt.get(e.node_id);
      if (!root || root.mirror_of || root.excerpt_of) continue; // 引用行摘除不可捞
      // 这批整体仍删着才补（root 活着说明它已被历史手段恢复过）
      const allStillDeleted = ids.every((id) => {
        const n = nodeStmt.get(id);
        return n && n.deleted;
      });
      if (!allStillDeleted) continue;
      const rev = revStmt.get(e.node_id);
      ins.run(
        e.doc_id, e.node_id, JSON.stringify(ids),
        root.parent_id, root.pos, clip(rev ? rev.content : '', 80), ids.length,
        e.author_id || '', e.author || '系统', e.created_at || now,
      );
    }
  });
  tx();
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
  );  const revOf = db.prepare('SELECT * FROM revisions WHERE node_id = ? AND version = ?');
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
  excerptOf = null, excerptContent = null, excerptSourceVersion = null,
  deletedIds = null, revId = null, author = '', authorId = '', note = '', at = null,
}) {
  db.prepare(
    `INSERT INTO timeline
       (doc_id, kind, node_id, parent_id, pos, mirror_of, excerpt_of,
        excerpt_content, excerpt_source_version, deleted_ids, rev_id,
        author, author_id, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    docId, kind, nodeId, parentId, pos, mirrorOf, excerptOf,
    excerptContent, excerptSourceVersion,
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

// 当前快照：未删除节点；普通节点带最新 revision，跟读节点投影源节点正文，
// 摘录节点带它自己最近一次冻结的正文（excerpt_states 最新一行），绝不投影源。
function getSnapshot(db, docId) {
  const doc = getDoc(db, docId);
  if (!doc) return null;

  const own = db
    .prepare(
      `SELECT n.id, n.parent_id AS parentId, n.pos, n.mirror_of AS mirrorOf,
              n.excerpt_of AS excerptOf,
              r.version, r.content, r.author, r.author_id AS authorId,
              r.created_at AS updatedAt
       FROM nodes n
       LEFT JOIN revisions r
         ON r.id = (SELECT id FROM revisions WHERE node_id = n.id
                    ORDER BY version DESC LIMIT 1)
       WHERE n.doc_id = ? AND n.deleted = 0 AND n.mirror_of IS NULL AND n.excerpt_of IS NULL
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

  const excerpts = db
    .prepare(
      `SELECT n.id, n.parent_id AS parentId, n.pos, n.excerpt_of AS excerptOf,
              s.content, s.source_version AS sourceVersion,
              s.author, s.author_id AS authorId, s.created_at AS frozenAt
       FROM nodes n
       JOIN excerpt_states s
         ON s.id = (SELECT id FROM excerpt_states WHERE node_id = n.id
                    ORDER BY id DESC LIMIT 1)
       WHERE n.doc_id = ? AND n.deleted = 0 AND n.excerpt_of IS NOT NULL
       ORDER BY n.parent_id, n.pos`,
    )
    .all(docId);

  // 批量解析源节点（源可能在别的文档，也可能已被删除）。
  // 跟读与摘录共用同一份源解析：它们都引用一个普通源节点。
  const refs = [...mirrors.map((m) => m.mirrorOf), ...excerpts.map((e) => e.excerptOf)];
  const sourceIds = [...new Set(refs)];
  let sourceById = new Map();
  if (sourceIds.length) {
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

  for (const e of excerpts) {
    const src = sourceById.get(e.excerptOf);
    const gone = !src || src.deleted;
    const node = {
      id: e.id,
      parentId: e.parentId,
      pos: e.pos,
      kind: 'excerpt',
      excerptOf: e.excerptOf,
      sourceDocId: src ? src.docId : null,
      // 冻结正文永远是摘录自己这一份，源改了也不变
      content: e.content,
      sourceVersion: e.sourceVersion,
      version: e.sourceVersion, // 展示用：这份字抄自源的哪个版本
      author: e.author,
      authorId: e.authorId,
      updatedAt: e.frozenAt,
      frozenAt: e.frozenAt,
      sourceDeleted: gone ? 1 : 0,
    };
    // 源还在：给出源当前版本，客户端据此判定"原文已改 / 已对齐"
    if (!gone) {
      node.currentSourceVersion = src.version;
      node.stale = src.version !== e.sourceVersion ? 1 : 0;
    } else {
      node.currentSourceVersion = null;
      node.stale = 0;
    }
    own.push(node);
  }

  // 当前封着的段：只对本文档可见的源段落（含被跟读挂进来的源）下发。
  // 封的是源：普通行直接带 sealed；跟读行由客户端按 mirrorOf 查这份映射显示同一封口。
  const seals = listCurrentSeals(db, [...visibleSourceIdsOfRows(own)]);
  const sealByNode = new Map(seals.map((s) => [s.nodeId, s]));
  for (const n of own) {
    if (n.kind === 'excerpt') continue; // 摘录是冻结副本，不显示/不参与封口
    const sourceId = n.kind === 'mirror' ? n.mirrorOf : n.id;
    const seal = sealByNode.get(sourceId);
    if (seal) n.seal = seal;
  }

  return { doc, nodes: own, seals };
}

// 快照节点里能看到的全部源 id（普通行自己 + 跟读源；不含摘录源——摘录不投影封口）
function visibleSourceIdsOfRows(rows) {
  const ids = new Set();
  for (const n of rows) {
    if (n.kind === 'mirror') ids.add(n.mirrorOf);
    else if (n.kind !== 'excerpt') ids.add(n.id);
  }
  return [...ids];
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

// 挂了这些源节点「跟读」的（其它）文档 id 列表：只有跟读需要源正文/锁的实时扇出。
// 刻意不含摘录——摘录不投影源，源的 content 绝不进摘录宿主房间（协议层保证
// "摘录这边不会悄悄换成新字"）；摘录只在显式对齐时收到自己那一条冻结结果。
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

// 仅挂了摘录的宿主文档（源删除时给它们发 excerpt 墓碑用）
function excerptHostDocs(db, sourceIds) {
  const ids = Array.isArray(sourceIds) ? sourceIds : [sourceIds];
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT DISTINCT doc_id AS docId FROM nodes
       WHERE deleted = 0 AND excerpt_of IN (${placeholders})`,
    )
    .all(...ids);
  return rows.map((r) => r.docId);
}

function getLatestExcerptState(db, nodeId) {
  return db
    .prepare('SELECT * FROM excerpt_states WHERE node_id = ? ORDER BY id DESC LIMIT 1')
    .get(nodeId);
}

function normalizeExcerptState(row) {
  if (!row) return null;
  return {
    id: row.id,
    nodeId: row.node_id,
    docId: row.doc_id,
    content: row.content,
    sourceVersion: row.source_version,
    authorId: row.author_id,
    author: row.author,
    createdAt: row.created_at,
  };
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
    if (isSealed(db, nodeId)) return { status: 'sealed' };
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
    if (isSealed(db, suggestion.nodeId)) return { status: 'sealed', suggestion };
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
    if (isSealed(db, nodeId)) return { status: 'sealed' };
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

// 做一个摘录节点：把源此刻的正文抄一份冻进 excerpt_states。
// 与跟读相反，摘录不投影源——这行字从此独立，直到显式对齐。
function addExcerptNode(db, { id, docId, parentId, pos, excerptOf, userId = '', userName = '' }) {
  return db.transaction(() => {
    const source = getNode(db, excerptOf);
    if (!source || source.deleted) return { status: 'missing' };
    if (source.mirror_of || source.excerpt_of) return { status: 'bad_source' };
    const srcRev = getLatestRevision(db, excerptOf);
    if (!srcRev) return { status: 'missing' };

    const now = Date.now();
    db.prepare(
      'INSERT INTO nodes (id, doc_id, parent_id, pos, excerpt_of, deleted, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
    ).run(id, docId, parentId, pos, excerptOf, now);
    db.prepare(
      `INSERT INTO excerpt_states (node_id, doc_id, content, source_version, author_id, author, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, docId, srcRev.content, srcRev.version, userId, userName, now);
    logEvent(db, {
      docId, kind: 'excerpt_add', nodeId: id, parentId, pos, excerptOf,
      excerptContent: srcRev.content, excerptSourceVersion: srcRev.version,
      author: userName, authorId: userId, note: `摘录自源 v${srcRev.version}`, at: now,
    });
    bumpTreeRev(db, docId, now);
    const node = getSnapshot(db, docId).nodes.find((n) => n.id === id);
    return { status: 'created', node, treeRev: getDoc(db, docId).tree_rev };
  })();
}

// 把摘录对齐到源此刻的正文。
//
// 并发安全（CAS）：请求必须带 baseSourceVersion——对齐者在确认弹窗里看到、
// 并明确要对齐过去的那个"源当前版本"。事务内与源的真实当前版本比对：
//   - 一致：把源当前正文冻结成 excerpt_states 的新一行（append-only 留痕），
//     返回 aligned；调用方随后广播同一条 excerpt_aligned，全员看到同一份字。
//   - 不一致：说明在 TA 确认期间源又被改过（另一个人几乎同时对齐、或源又被编辑），
//     返回 stale 并带回源此刻真正的版本/正文——绝不允许"两边都显示对齐成功，
//     冻的却不是同一句话"。前端据此让用户看清新原文后重新确认再对齐。
//   - 源已删/摘录已删：missing/gone，冻字保持上一份不动。
// 不改 tree_rev：对齐是内容冻结，不动结构。
function alignExcerpt(db, { nodeId, baseSourceVersion, userId = '', userName = '' }) {
  return db.transaction(() => {
    const node = getNode(db, nodeId);
    if (!node || node.deleted || !node.excerpt_of) return { status: 'missing' };
    const source = getNode(db, node.excerpt_of);
    if (!source || source.deleted) {
      return { status: 'source_gone', frozen: normalizeExcerptState(getLatestExcerptState(db, nodeId)) };
    }
    const srcRev = getLatestRevision(db, node.excerpt_of);
    if (!srcRev) return { status: 'source_gone' };

    if (!Number.isInteger(baseSourceVersion) || baseSourceVersion < 1) {
      return { status: 'bad_base', current: normalizeRevision(srcRev) };
    }
    if (srcRev.version !== baseSourceVersion) {
      // 别人先对齐了 / 源又被改：把此刻真正的原文带回去重确认
      return {
        status: 'stale',
        current: normalizeRevision(srcRev),
        frozen: normalizeExcerptState(getLatestExcerptState(db, nodeId)),
      };
    }

    const frozen = getLatestExcerptState(db, nodeId);
    if (frozen && frozen.content === srcRev.content) {
      // 字已经就是这份（例如源改了又改回原样）：幂等收敛，不新增冻结行
      return {
        status: 'unchanged',
        state: normalizeExcerptState(frozen),
        current: normalizeRevision(srcRev),
      };
    }

    const now = Date.now();
    const info = db
      .prepare(
        `INSERT INTO excerpt_states (node_id, doc_id, content, source_version, author_id, author, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(nodeId, node.doc_id, srcRev.content, srcRev.version, userId, userName, now);
    const state = normalizeExcerptState(
      db.prepare('SELECT * FROM excerpt_states WHERE id = ?').get(info.lastInsertRowid),
    );
    logEvent(db, {
      docId: node.doc_id, kind: 'excerpt_align', nodeId, excerptOf: node.excerpt_of,
      excerptContent: srcRev.content, excerptSourceVersion: srcRev.version,
      author: userName, authorId: userId, note: `摘录对齐到源 v${srcRev.version}`, at: now,
    });
    return { status: 'aligned', state, current: normalizeRevision(srcRev) };
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
    // 封着的普通段不能被移动：封口连层级位置一起冻结。跟读/摘录挂载行是宿主
    // 文档自己的本地结构（移动/移除不改变封着的源），不拦。
    if (!node.mirror_of && !node.excerpt_of && isSealed(db, nodeId)) {
      return { status: 'sealed' };
    }
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
// 普通节点：连带子树；跟读/摘录节点：没有子级（创建时禁止），只移除这一处挂载/摘录，源不受影响。
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
    // 封口连删除一起封：整棵待删子树里只要有封着的普通段，整笔拒绝
    // （不能让"删父级"绕过段落自己的封口）。跟读/摘录挂载行的删除不经过这里的子树拦截。
    const sealedIds = sealedIdsWithin(db, ids);
    if (sealedIds.length) return { status: 'sealed', sealedIds };
    const stmt = db.prepare('UPDATE nodes SET deleted = 1 WHERE id = ?');
    for (const id of ids) stmt.run(id);
    const supersededSuggestionIds = [];
    for (const id of ids) {
      supersededSuggestionIds.push(...supersedePendingSuggestions(db, id));
    }
    logEvent(db, {
      docId: doc.id, kind: 'delete', nodeId, deletedIds: ids,
      author: userName, authorId: userId,
      note: node.mirror_of ? '移除跟读'
        : node.excerpt_of ? '移除摘录'
        : `删除段落（含子树共 ${ids.length} 段）`,
    });

    // 普通段落（含子树）进可捞名单；跟读/摘录只是摘除一处引用，源还在，不用捞。
    let trash = null;
    if (!node.mirror_of && !node.excerpt_of) {
      const rootRev = getLatestRevision(db, nodeId);
      const info = db
        .prepare(
          `INSERT INTO trash_events
             (doc_id, root_id, ids, parent_id, pos, preview, count, active,
              author_id, author, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        )
        .run(
          doc.id, nodeId, JSON.stringify(ids), node.parent_id, node.pos,
          clip(rootRev ? rootRev.content : '', 80), ids.length,
          userId, userName, Date.now(),
        );
      trash = normalizeTrashEvent(db.prepare('SELECT * FROM trash_events WHERE id = ?').get(info.lastInsertRowid));
    }

    bumpTreeRev(db, doc.id);
    return {
      status: 'deleted',
      ids,
      trash,
      treeRev: getDoc(db, doc.id).tree_rev,
      kind: node.mirror_of ? 'mirror' : node.excerpt_of ? 'excerpt' : 'node',
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
    else if (r.kind === 'excerpt_add') summary = '做了一处摘录（冻结当前正文）';
    else if (r.kind === 'excerpt_align') summary = '摘录对齐到原文最新版本';
    else if (r.kind === 'seal') summary = r.note || '封口段落';
    else if (r.kind === 'unseal') summary = r.note || '重新打开段落';
    else if (r.kind === 'move') summary = '移动段落 / 调整层级';
    else if (r.kind === 'restore') {
      summary = `捞回删除的段落（共 ${(JSON.parse(r.deletedIds || '[]')).length} 段）`;
    }
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

  // 1) 结构：全局重放（跟读/摘录源可能在别的大纲，必须一起重放才知道源当时是否存活）
  const structEvents = db
    .prepare(
      `SELECT kind, node_id AS nodeId, doc_id AS docId, parent_id AS parentId, pos,
              mirror_of AS mirrorOf, excerpt_of AS excerptOf,
              excerpt_content AS excerptContent,
              excerpt_source_version AS excerptSourceVersion,
              deleted_ids AS deletedIds
       FROM timeline WHERE kind != 'content' AND seq <= ? ORDER BY seq`,
    )
    .all(at);
  const tree = new Map(); // nodeId -> { docId, parentId, pos, mirrorOf, excerptOf, frozen, frozenVer, deleted }
  for (const e of structEvents) {
    if (e.kind === 'add' || e.kind === 'mirror_add') {
      tree.set(e.nodeId, {
        docId: e.docId, parentId: e.parentId, pos: e.pos,
        mirrorOf: e.mirrorOf, excerptOf: null, deleted: 0,
      });
    } else if (e.kind === 'excerpt_add') {
      tree.set(e.nodeId, {
        docId: e.docId, parentId: e.parentId, pos: e.pos,
        mirrorOf: null, excerptOf: e.excerptOf,
        frozen: e.excerptContent, frozenVer: e.excerptSourceVersion, deleted: 0,
      });
    } else if (e.kind === 'excerpt_align') {
      const n = tree.get(e.nodeId);
      if (n && !n.deleted) {
        n.frozen = e.excerptContent;
        n.frozenVer = e.excerptSourceVersion;
      }
    } else if (e.kind === 'move') {
      const n = tree.get(e.nodeId);
      if (n && !n.deleted) {
        n.parentId = e.parentId;
        n.pos = e.pos;
      }
    } else if (e.kind === 'restore') {
      // 捞回：整批 id 复活；root 放回事件记下的父级（父级已不在则为顶层）。
      // 子级内部的 parent/pos 从没被改过，随 root 一起呈现删除前的样子。
      const root = tree.get(e.nodeId);
      const ids = JSON.parse(e.deletedIds || '[]');
      for (const id of ids) {
        const n = tree.get(id);
        if (n) n.deleted = 0;
      }
      if (root) {
        root.parentId = e.parentId;
        root.pos = e.pos;
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

  // 3.5) 封口状态在 at 时刻的重建：<= at 的 seal/unseal 事件里每段最后一条决定。
  // 结果是 seq 的纯函数，所有人回看同一时刻看到的封口/打开严格一致。
  const sealedAt = new Map(); // nodeId -> { sealed, reason, author, createdAt }
  const sealRowsAt = db
    .prepare(
      `SELECT node_id AS nodeId, kind, note, author, created_at AS createdAt
       FROM timeline
       WHERE kind IN ('seal', 'unseal') AND seq <= ?
       ORDER BY seq`,
    )
    .all(at);
  for (const e of sealRowsAt) {
    if (e.kind === 'seal') {
      sealedAt.set(e.nodeId, { sealed: true, reason: (e.note || '').replace(/^封口：?/, ''), author: e.author, createdAt: e.createdAt });
    } else {
      sealedAt.set(e.nodeId, { sealed: false });
    }
  }

  // 4) 组装该文档在 at 时刻的可见树（格式与实时快照一致）
  const nodes = [];
  const sealInfoAt = (sourceId) => {
    const s = sealedAt.get(sourceId);
    return s && s.sealed ? { sealed: true, reason: s.reason, author: s.author, createdAt: s.createdAt } : null;
  };
  for (const [id, n] of tree) {
    if (n.docId !== docId || n.deleted) continue;
    if (!n.mirrorOf && !n.excerptOf) {
      const c = contentAt.get(id);
      const node = {
        id, parentId: n.parentId, pos: n.pos, kind: 'node',
        version: c ? c.version : 0,
        content: c ? c.content : '',
        author: c ? c.author : '',
        authorId: c ? c.authorId : '',
        updatedAt: c ? c.updatedAt : null,
        aliveNow: aliveNow.has(id) ? 1 : 0,
      };
      const seal = sealInfoAt(id);
      if (seal) node.seal = seal;
      nodes.push(node);
    } else if (n.excerptOf) {
      // 摘录：展示该时刻最近一次冻结的正文，绝不投影源
      const src = tree.get(n.excerptOf);
      const gone = !src || src.deleted;
      const node = {
        id, parentId: n.parentId, pos: n.pos, kind: 'excerpt', excerptOf: n.excerptOf,
        content: n.frozen ?? '',
        sourceVersion: n.frozenVer ?? 0,
        version: n.frozenVer ?? 0,
        sourceDocId: src ? src.docId : null,
        sourceDeleted: gone ? 1 : 0,
        aliveNow: aliveNow.has(id) ? 1 : 0,
        sourceAliveNow: aliveNow.has(n.excerptOf) ? 1 : 0,
      };
      if (!gone) {
        const c = contentAt.get(n.excerptOf);
        node.currentSourceVersion = c ? c.version : 0;
        node.stale = c && c.version !== n.frozenVer ? 1 : 0;
      } else {
        node.currentSourceVersion = null;
        node.stale = 0;
      }
      nodes.push(node);
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
        const seal = sealInfoAt(n.mirrorOf);
        if (seal) node.seal = seal;
      }
      nodes.push(node);
    }
  }
  return { doc, asOf: { seq: at, createdAt: atRow ? atRow.createdAt : null, latestSeq: maxSeq }, nodes };
}

// ---------- 对外定稿（发布）----------
//
// 工作稿（nodes/revisions/timeline）随时在变；"定出去"是把某一时刻的整树
// 冻结成 publications 里一行不可变快照。对外观看者永远只读到当前最新那行，
// 与工作稿之后怎么改完全解耦。
//
// 并发安全靠 CAS：定稿请求必须带它看到的当前定稿序号 basePubSeq（首次为 0）。
// 事务内比对，不一致直接拒绝——两个几乎同时点「定稿」的人里只有一个成功，
// 另一个拿到 stale，看到新定稿后重新确认，不可能"两边都定出去了却对不上"。

function normalizePublication(row) {
  if (!row) return null;
  let snapshot;
  try {
    snapshot = JSON.parse(row.snapshot);
  } catch {
    snapshot = { nodes: [] };
  }
  return {
    id: row.id,
    docId: row.doc_id,
    pubSeq: row.pub_seq,
    baseSeq: row.base_seq,
    timelineSeq: row.timeline_seq,
    title: row.title,
    nodes: Array.isArray(snapshot.nodes) ? snapshot.nodes : [],
    authorId: row.author_id,
    author: row.author,
    createdAt: row.created_at,
  };
}

function getPublicationRow(db, docId, pubSeq) {
  return db
    .prepare('SELECT * FROM publications WHERE doc_id = ? AND pub_seq = ?')
    .get(docId, pubSeq);
}

function getCurrentPublication(db, docId) {
  const row = db
    .prepare('SELECT * FROM publications WHERE doc_id = ? ORDER BY pub_seq DESC LIMIT 1')
    .get(docId);
  return normalizePublication(row);
}

function listPublications(db, docId, limit = 100) {
  return db
    .prepare('SELECT * FROM publications WHERE doc_id = ? ORDER BY pub_seq DESC LIMIT ?')
    .all(docId, limit)
    .map(normalizePublication);
}

// 把发布时刻的整树冻结成对外自包含的行：跟读行直接内嵌当时的投影正文，
// 源文档以后怎么改（甚至删除）都不影响这份定稿。
function freezeSnapshot(db, docId, tlSeq) {
  const snap = getSnapshotAt(db, docId, tlSeq);
  return snap.nodes.map((n) => {
    const row = { id: n.id, parentId: n.parentId, pos: n.pos, kind: n.kind };
    if (n.kind === 'mirror') {
      row.mirrorOf = n.mirrorOf;
      row.sourceDocId = n.sourceDocId || null;
      row.sourceDeleted = n.sourceDeleted ? 1 : 0;
    }
    if (n.kind === 'excerpt') {
      // 摘录在定稿里自包含：冻的是发布时刻这行自己的字，源以后怎么改都与它无关
      row.excerptOf = n.excerptOf;
      row.sourceDocId = n.sourceDocId || null;
      row.sourceDeleted = n.sourceDeleted ? 1 : 0;
      row.sourceVersion = n.sourceVersion;
    }
    if (typeof n.content === 'string') {
      row.content = n.content;
      row.version = n.version;
      row.author = n.author || '';
    }
    return row;
  });
}

function sameFrozenNodes(a, b) {
  if (a.length !== b.length) return false;
  return a.every((n, i) => {
    const m = b[i];
    return n.id === m.id && n.parentId === m.parentId && n.pos === m.pos &&
      n.kind === m.kind && (n.content || '') === (m.content || '') &&
      (n.sourceDeleted || 0) === (m.sourceDeleted || 0) &&
      (n.kind === 'excerpt' ? (n.sourceVersion || 0) === (m.sourceVersion || 0) : true);
  });
}

// 返回 { status: 'published'|'unchanged'|'stale'|'missing', publication? }
function publishDoc(db, { docId, basePubSeq, userId, userName }) {
  return db.transaction(() => {
    const doc = getDoc(db, docId);
    if (!doc) return { status: 'missing' };
    const currentRow = db
      .prepare('SELECT * FROM publications WHERE doc_id = ? ORDER BY pub_seq DESC LIMIT 1')
      .get(docId);
    const currentSeq = currentRow ? currentRow.pub_seq : 0;
    if (!Number.isInteger(basePubSeq) || basePubSeq < 0 || basePubSeq !== currentSeq) {
      return { status: 'stale', current: normalizePublication(currentRow) };
    }

    const tlSeq = latestSeq(db);
    const nodes = freezeSnapshot(db, docId, tlSeq);

    // 内容与上一版定稿逐字相同：不新增版本，两边都收敛到同一版
    if (currentRow) {
      let prev;
      try { prev = JSON.parse(currentRow.snapshot); } catch { prev = { nodes: [] }; }
      if (sameFrozenNodes(prev.nodes || [], nodes) && currentRow.title === doc.title) {
        return { status: 'unchanged', publication: normalizePublication(currentRow) };
      }
    }

    const now = Date.now();
    const info = db
      .prepare(
        `INSERT INTO publications
           (doc_id, pub_seq, base_seq, timeline_seq, title, snapshot, author_id, author, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        docId, currentSeq + 1, currentSeq, tlSeq, doc.title,
        JSON.stringify({ nodes }), userId, userName, now,
      );
    const row = db.prepare('SELECT * FROM publications WHERE id = ?').get(info.lastInsertRowid);
    return { status: 'published', publication: normalizePublication(row) };
  })();
}

// ---------- 段落留言 ----------
//
// 留言锚定段落（nodes.id），与 revisions 完全独立：正文前进多少版本留言都在。
// 留言不进 timeline（它是讨论，不是大纲内容/结构的演进；回看时刻只重建大纲本身）。
// 收掉是一个 open -> resolved 的单行状态机，靠条件 UPDATE 做 CAS：
// 两个几乎同时到达的「收掉」在同一 SQLite 事务队列里串行，只有第一个
// WHERE status='open' 会改到行；后到者读到的已是 resolved（连同先到者的说法），
// 调用方据此只广播先到者那一条 resolved——所有人收到的「已收内容」必然一致。

function normalizeComment(r) {
  if (!r) return null;
  const out = {
    id: r.id,
    docId: r.doc_id,
    nodeId: r.node_id,
    content: r.content,
    authorId: r.author_id,
    author: r.author,
    status: r.status,
    createdAt: r.created_at,
  };
  if (r.status === 'resolved') {
    out.resolvedContent = r.resolved_content;
    out.resolvedBy = r.resolved_by;
    out.resolvedById = r.resolved_by_id;
    out.resolvedAt = r.resolved_at;
  }
  return out;
}

function listCommentsForDoc(db, docId) {
  return db
    .prepare('SELECT * FROM comments WHERE doc_id = ? ORDER BY created_at, rowid')
    .all(docId)
    .map(normalizeComment);
}

function getComment(db, commentId) {
  const row = db.prepare('SELECT * FROM comments WHERE id = ?').get(commentId);
  return normalizeComment(row);
}

function createComment(db, { id, docId, nodeId, content, userId, userName }) {
  return db.transaction(() => {
    const node = getNode(db, nodeId);
    if (!node || node.deleted || node.excerpt_of) return { status: 'invalid_target' };
    if (node.doc_id !== docId) return { status: 'wrong_doc' };
    const now = Date.now();
    db
      .prepare(
        `INSERT INTO comments (id, doc_id, node_id, content, author_id, author, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
      )
      .run(id, docId, nodeId, content, userId, userName, now);
    return { status: 'created', comment: getComment(db, id) };
  })();
}

// 收掉留言：条件 UPDATE 是 CAS。返回：
//  resolved  —— 本次请求收掉的（调用方广播 comment_resolved，说法以返回值为准）
//  already   —— 已被别人先收掉（带回先收那份；调用方只给后来者补发事实，绝不广播第二份）
//  missing   —— 留言不存在
function resolveComment(db, { commentId, content, userId, userName }) {
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM comments WHERE id = ?').get(commentId);
    if (!row) return { status: 'missing' };
    if (row.status === 'resolved') {
      return { status: 'already', comment: normalizeComment(row) };
    }
    const now = Date.now();
    const info = db
      .prepare(
        `UPDATE comments
           SET status = 'resolved', resolved_content = ?, resolved_by_id = ?,
               resolved_by = ?, resolved_at = ?
         WHERE id = ? AND status = 'open'`,
      )
      .run(content, userId, userName, now, commentId);
    if (info.changes === 0) {
      // 竞态兜底：事务排队期间被另一条抢先收掉
      return { status: 'already', comment: getComment(db, commentId) };
    }
    return { status: 'resolved', comment: getComment(db, commentId) };
  })();
}

// ---------- 段落封口（seal）----------
//
// 封口状态是 append-only 流：seal_events 每段最新一行决定"封着/开着"。
// 与留言收掉同一套收敛思路——状态迁移本身就是 CAS：
// - seal 事务里读到"已经封着" -> already（带回先封者的理由），绝不插入第二条、
//   绝不广播第二份 sealed；两个几乎同时到达、理由不同的 seal 天然串行，
//   先到者的理由是全员看到的唯一一份。
// - unseal 同理：只有封着才能打开，重复打开幂等收敛，不产生第二条广播。
// 每次状态翻转同事务追加一条 timeline（seal/unseal），回看时刻能重建当时封口状态。

function normalizeSealEvent(r) {
  if (!r) return null;
  return {
    id: r.id,
    nodeId: r.node_id,
    docId: r.doc_id,
    kind: r.kind,
    sealed: r.kind === 'sealed',
    reason: r.reason || '',
    authorId: r.author_id,
    author: r.author,
    createdAt: r.created_at,
  };
}

function latestSealEvent(db, nodeId) {
  const row = db
    .prepare('SELECT * FROM seal_events WHERE node_id = ? ORDER BY id DESC LIMIT 1')
    .get(nodeId);
  return normalizeSealEvent(row);
}

// 批量取若干源段"当前封着"的封口事件（快照/扇出用）。只返回封着的。
function listCurrentSeals(db, nodeIds) {
  const ids = [...new Set(nodeIds || [])];
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT s.* FROM seal_events s
       JOIN (SELECT node_id, MAX(id) AS max_id FROM seal_events
             WHERE node_id IN (${placeholders}) GROUP BY node_id) m
         ON m.max_id = s.id
       WHERE s.kind = 'sealed'`,
    )
    .all(...ids);
  return rows.map(normalizeSealEvent);
}

// 当前段落是否封着（写路径的硬拦截用）
function isSealed(db, nodeId) {
  const latest = latestSealEvent(db, nodeId);
  return !!(latest && latest.kind === 'sealed');
}

function editableSourceNode(db, nodeId) {
  const node = getNode(db, nodeId);
  if (!node || node.deleted || node.mirror_of || node.excerpt_of) return null;
  return node;
}

function sealNode(db, { nodeId, reason, userId = '', userName = '' }) {
  return db.transaction(() => {
    const node = editableSourceNode(db, nodeId);
    if (!node) return { status: 'invalid' };
    const latest = latestSealEvent(db, nodeId);
    if (latest && latest.kind === 'sealed') {
      return { status: 'already', seal: latest };
    }
    const now = Date.now();
    const info = db
      .prepare(
        `INSERT INTO seal_events (node_id, doc_id, kind, reason, author_id, author, created_at)
         VALUES (?, ?, 'sealed', ?, ?, ?, ?)`,
      )
      .run(nodeId, node.doc_id, reason, userId, userName, now);
    const seal = normalizeSealEvent(db.prepare('SELECT * FROM seal_events WHERE id = ?').get(info.lastInsertRowid));
    logEvent(db, {
      docId: node.doc_id, kind: 'seal', nodeId,
      author: userName, authorId: userId,
      note: reason ? `封口：${reason}` : '封口', at: now,
    });
    return { status: 'sealed', seal };
  })();
}

function unsealNode(db, { nodeId, reason = '', userId = '', userName = '' }) {
  return db.transaction(() => {
    const node = editableSourceNode(db, nodeId);
    if (!node) return { status: 'invalid' };
    const latest = latestSealEvent(db, nodeId);
    if (!latest || latest.kind === 'unsealed') {
      return { status: 'already_open', seal: latest };
    }
    const now = Date.now();
    const info = db
      .prepare(
        `INSERT INTO seal_events (node_id, doc_id, kind, reason, author_id, author, created_at)
         VALUES (?, ?, 'unsealed', ?, ?, ?, ?)`,
      )
      .run(nodeId, node.doc_id, reason, userId, userName, now);
    const seal = normalizeSealEvent(db.prepare('SELECT * FROM seal_events WHERE id = ?').get(info.lastInsertRowid));
    logEvent(db, {
      docId: node.doc_id, kind: 'unseal', nodeId,
      author: userName, authorId: userId,
      note: reason ? `重新打开：${reason}` : '重新打开', at: now,
    });
    return { status: 'unsealed', seal };
  })();
}

// 删除路径用：待删子树里当前封着的段落 id（整笔删除必须事务前/事务内拒绝，
// 不能让"删父级"绕过段落自己的封口）。
function sealedIdsWithin(db, ids) {
  if (!ids.length) return [];
  return listCurrentSeals(db, ids).map((s) => s.nodeId);
}

// ---------- 可捞名单（回收站）与捞回 ----------
//
// 删除是软删：正文 revisions、留言、封口事件全都在，只是 nodes.deleted=1。
// 可捞名单由 trash_events 决定（一批 = 一次删除的整棵子树），全房间共享：
// 删除时广播、快照随带，所有正在看这份大纲的人（含自己的其他标签页）看到
// 同一份名单，不可能"只在删除者屏幕上"。
//
// 捞回是结构操作，走和增/删/移动同一把 tree_rev 乐观锁；除此之外还在同一
// SQLite 事务里做"这批仍可捞"的 CAS（条件 UPDATE ... WHERE active=1）：
// 两人几乎同时捞同一批、手里看到的树版本/名单还不一样时，先到者写入并广播
// 唯一一条 nodes_restored，后到者 changes=0 只拿到 stale + 先捞者那份新位置，
// 绝不可能"两边都显示捞回来了，位置却对不上"。

function normalizeTrashEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    docId: row.doc_id,
    rootId: row.root_id,
    ids: (() => {
      try { return JSON.parse(row.ids || '[]'); } catch { return []; }
    })(),
    parentId: row.parent_id ?? null,
    pos: row.pos || '',
    preview: row.preview || '',
    count: row.count || 1,
    active: row.active ? 1 : 0,
    authorId: row.author_id,
    author: row.author,
    createdAt: row.created_at,
    restoredAt: row.restored_at || null,
    restoredBy: row.restored_by || null,
  };
}

// 文档当前可捞的名单（按删除先后，最近的在前）。
// withContent：名单在快照/广播里下发时附上 root 删前完整原文（确认弹窗直接展示，
// 不必再为每段拉历史）；节点本体的正文以捞回广播里的快照为准。
function listTrash(db, docId, withContent = false) {
  const rows = db
    .prepare('SELECT * FROM trash_events WHERE doc_id = ? AND active = 1 ORDER BY id DESC')
    .all(docId)
    .map(normalizeTrashEvent);
  if (withContent) {
    for (const t of rows) {
      const rev = getLatestRevision(db, t.rootId);
      t.content = rev ? rev.content : '';
      t.version = rev ? rev.version : 0;
    }
  }
  return rows;
}

function getTrashEvent(db, id) {
  const row = db.prepare('SELECT * FROM trash_events WHERE id = ?').get(id);
  return normalizeTrashEvent(row);
}

// 同层最后一个存活位置（顶层 parentId=null 用 IS NULL 匹配）
function lastSiblingPos(db, docId, parentId) {
  const row = db
    .prepare(
      `SELECT pos FROM nodes
       WHERE doc_id = ? AND deleted = 0 AND parent_id IS ?
       ORDER BY pos DESC LIMIT 1`,
    )
    .get(docId, parentId);
  return row ? row.pos : null;
}

// 捞回一批（整棵子树）。
// 返回：
//  restored —— 本次请求捞回的（调用方广播唯一一条 nodes_restored）
//  stale_tree —— tree_rev 过期（随快照纠正）
//  already   —— 已被别人先捞回（带回先捞者那份新位置；绝不广播第二条）
//  missing   —— 名单/文档不存在
function restoreTrash(db, { trashId, treeRev, userId = '', userName = '' }) {
  return db.transaction(() => {
    const batch = db.prepare('SELECT * FROM trash_events WHERE id = ?').get(trashId);
    if (!batch) return { status: 'missing' };
    const doc = getDoc(db, batch.doc_id);
    if (!doc) return { status: 'missing' };
    if (treeRev !== undefined && treeRev !== doc.tree_rev) {
      return { status: 'stale_tree', treeRev: doc.tree_rev };
    }
    if (!batch.active) {
      // 并发输了：先捞者已把这批放回树上。带回先捞者的结果，界面收敛到同一份。
      const root = getNode(db, batch.root_id);
      return {
        status: 'already',
        treeRev: doc.tree_rev,
        rootId: batch.root_id,
        parentId: root && !root.deleted ? root.parent_id : null,
        pos: root && !root.deleted ? root.pos : null,
      };
    }
    let ids;
    try { ids = JSON.parse(batch.ids || '[]'); } catch { ids = []; }
    const idSet = new Set(ids);
    const nodesById = new Map(
      db.prepare('SELECT * FROM nodes WHERE id IN (' + ids.map(() => '?').join(',') + ')')
        .all(...ids)
        .map((n) => [n.id, n]),
    );

    // root 删掉前的父级还在不在：还在就放回原位（整棵子树内部 parent/pos 不动，
    // 自然呈现"拿掉前的位置和原文"）；父级当时也一起被删（子树删除不会发生），
    // 或父级此刻在另一批名单里还没捞回，则放到顶层末尾——等父级那批之后被捞回，
    // 子树仍按 parent 指针重新挂回它下面。
    const oldParent = batch.parent_id ? getNode(db, batch.parent_id) : null;
    const parentAlive = !!oldParent && !oldParent.deleted && !idSet.has(oldParent.id);
    const rootParentId = parentAlive ? batch.parent_id : null;
    if (!parentAlive) {
      const pos = midpoint(lastSiblingPos(db, batch.doc_id, null), null);
      db.prepare('UPDATE nodes SET parent_id = NULL, pos = ? WHERE id = ?').run(pos, batch.root_id);
    } else {
      db.prepare('UPDATE nodes SET parent_id = ?, pos = ? WHERE id = ?')
        .run(batch.parent_id, batch.pos, batch.root_id);
    }
    const restoredRoot = getNode(db, batch.root_id);

    // 整棵子树一起复活（普通行；这批里不会有跟读/摘录挂载行）
    const markAlive = db.prepare('UPDATE nodes SET deleted = 0 WHERE id = ?');
    for (const id of ids) {
      if (nodesById.has(id)) markAlive.run(id);
    }

    // CAS：只有仍 active 的这批能被标成已捞回。两个几乎同时到达的捞回在事务
    // 队列里串行，后到者 changes=0，只会走 already 分支。
    const now = Date.now();
    const info = db
      .prepare(
        `UPDATE trash_events
           SET active = 0, restored_at = ?, restored_by_id = ?, restored_by = ?
         WHERE id = ? AND active = 1`,
      )
      .run(now, userId, userName, trashId);
    if (info.changes === 0) {
      throw new Error('restore CAS lost'); // 事务回滚，由后到者重读 active=0 走 already
    }

    // 顺手把同文档里"root 已不在名单（父级先一步复活）"等异常情况留给重放：
    // 结构事件本身足以重建，这里只追加时间轴。
    logEvent(db, {
      docId: batch.doc_id, kind: 'restore', nodeId: batch.root_id,
      parentId: restoredRoot.parent_id, pos: restoredRoot.pos,
      deletedIds: ids,
      author: userName, authorId: userId,
      note: parentAlive
        ? `捞回删除的段落（含子树共 ${ids.length} 段，放回原位）`
        : `捞回删除的段落（含子树共 ${ids.length} 段，原父级已不在，放到顶层）`,
      at: now,
    });
    bumpTreeRev(db, batch.doc_id, now);

    const treeRevNow = getDoc(db, batch.doc_id).tree_rev;
    return {
      status: 'restored',
      trash: normalizeTrashEvent(db.prepare('SELECT * FROM trash_events WHERE id = ?').get(trashId)),
      ids,
      rootId: batch.root_id,
      parentId: restoredRoot.parent_id,
      pos: restoredRoot.pos,
      treeRev: treeRevNow,
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
  excerptHostDocs,
  getLatestRevision,
  getRevision,
  getRevisionByVersion,
  getHistory,
  getLatestExcerptState,
  getSuggestion,
  listPendingSuggestions,
  createSuggestion,
  withdrawSuggestion,
  acceptSuggestion,
  saveContent,
  addNode,
  addMirrorNode,
  addExcerptNode,
  alignExcerpt,
  moveNode,
  deleteNode,
  latestSeq,
  getTimeline,
  getSnapshotAt,
  getCurrentPublication,
  listPublications,
  publishDoc,
  listCommentsForDoc,
  getComment,
  createComment,
  resolveComment,
  latestSealEvent,
  listCurrentSeals,
  isSealed,
  sealNode,
  unsealNode,
  sealedIdsWithin,
  listTrash,
  getTrashEvent,
  restoreTrash,
};
