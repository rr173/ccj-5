# 协同大纲（Collab Outline）

一个自托管的、多人同时编辑层级大纲的小应用。针对四件事做了明确的设计：

| 需求 | 做法 |
| --- | --- |
| 看出别人正在改哪段 | 段落级**软锁**，编辑者头像+姓名显示在段落上，在线名单实时更新 |
| 关页面/无操作后锁自动消失 | WS `close` 立即释放；心跳续租；服务器 TTL 扫描 + ping 探活兜底；本地 30 秒无输入主动释放 |
| 多人改同段最终必须收敛 | **服务器是唯一事实源**，保存带版本号；过期提交做 token 级 **diff3 三方合并**，不相交改动自动合成一个新版本全员广播；真重叠**拒绝并弹冲突窗**，不存在"各自成功" |
| 按时间回看、回退后继续改 | 每次保存是 append-only `revisions`；回退不是覆盖，而是**载入旧版本当草稿**再走一次合并保存（diff4），别人不相交的改动自动保留 |
| Docker 部署 | 单镜像 + 一个命名卷，`docker compose up -d` |

> 锁只是**协作提示**，不参与正确性。即使绕过锁（或锁刚好过期时两人同时提交），
> 版本号 + 三方合并仍然保证所有人收敛到同一份内容。

---

## 快速开始

### Docker（推荐）

```bash
docker compose up -d --build
# 打开 http://localhost:3000
```

数据放在命名卷 `outline-data`（容器内 `/data/app.db`）。升级时直接重建镜像即可，数据不丢。

可选环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP/WS 监听端口 |
| `DB_FILE` | `/data/app.db`（镜像内） | SQLite 文件路径 |
| `LOCK_TTL_MS` | `30000` | 编辑锁无心跳多久后被服务器回收 |
| `WS_PING_MS` | `25000` | 服务端 WebSocket ping 探活周期（只踢真正死掉的连接，空闲活连接不受影响） |

不用 compose：

```bash
docker build -t collab-outline .
docker run -d -p 3000:3000 -v "$PWD/data:/data" collab-outline
```

### 本地开发

```bash
npm install
npm start                 # http://localhost:3000，SQLite 在 ./data/app.db
```

### 测试

```bash
npm test                  # WebSocket 端到端（16 个场景）
node test/fraction.test.js        # 分数索引：6000 次随机插入顺序不变
node test/merge.test.js           # diff3 固定用例
node test/merge.property.test.js  # 4000 组随机编辑：交换律/无误报冲突
```

端到端覆盖：初始快照、软锁拒绝、关页面立即解锁、空闲 TTL 回收后他人立即接手、
**空闲活连接跨多个 ping 周期不被掐**（回归）、版本保存广播、
过期提交自动合并与收敛、真冲突拒绝与裁决收敛、历史留痕、
回退 diff4 保留他人改动、增/降级/删结构操作、过期树版本拒绝、
断线重连补齐离线期间修改。

---

## 使用说明

- 进入页面输入名字即可（身份随机生成存在 `localStorage`，头像颜色由身份哈希决定）。
- 段落悬浮出现操作条：**编辑 / ＋子级 / ＋同级 / 历史**。
- 编辑中：`Ctrl+Enter` 保存、`Esc` 取消；工具条可升级/降级/上下移动/删除。
- 别人正在编辑的段落会高亮并显示头像，编辑按钮会被服务器拒绝。
- 历史抽屉里每一条 revision 都可以「以此版本继续编辑」：
  旧文本载入编辑器，保存时以该旧版本为共同祖先做四方合并。
- 真冲突时弹出三栏窗口（你的版本 / 对方版本 / 最终内容），可以选边或手工合并后提交。

---

## 架构

```
浏览器 (public/：原生 JS，无构建)
   │  HTTP 静态资源            WebSocket /ws（JSON 消息）
   ▼                                ▼
Express + ws (server/index.js) ── LockManager（内存：软锁/TTL/presence）
   │
   ├── merge.js    token 级 diff3（拉丁按词、CJK 按字）
   ├── fraction.js 分数索引 midpoint（同层排序，无限插入不返工）
   └── db.js       better-sqlite3（同步事务）
                      ├── documents  (tree_rev 结构乐观锁)
                      ├── nodes      (parent_id, pos, deleted 软删)
                      └── revisions  (node_id, version 单调, content, author, note)
```

### 收敛协议要点

- 每个段落有独立单调 `version`；保存消息必须带 `baseVersion`。
- `baseVersion === 当前版本`：直接追加 revision，广播 `content`。
- `baseVersion < 当前版本`：
  - `merge3(base版本, 你的草稿, 当前版本)`；
  - 无重叠 → 合并结果作为新版本落库（note 记录"自动合并"），广播给所有人；
  - 有重叠 → 返回 `conflict`，原封不动保留服务器内容，等用户裁决后用 `resolve` 提交。
- 合并满足交换律（A 先来还是 B 先来，最终文本一致），算法层有随机属性测试守护。
- 结构操作（增/移/删）用文档级 `tree_rev` 乐观锁；过期操作被拒绝，
  服务器紧接着下发一份完整快照纠正客户端。

### 占用状态生命周期

关键语义：**没操作只会让出"占用"，不会断开连接、不会关闭编辑器、不会丢草稿。**

1. 点「编辑」→ 向服务器申请锁；成功后他人段落上出现头像+"正在编辑"。
2. 编辑期内每 8 秒发 `heartbeat` 续租。
3. 连续 30 秒没有键盘输入：客户端**只发 unlock 让出占用**，编辑器原样保留；
   别人立刻能改这段。你一旦继续输入，自动重新申请锁；若已被别人接手，
   你仍可输入，保存时按版本号走三方合并（必要时弹冲突窗）。
4. 服务器侧 TTL（默认 30 秒）是第二道保险：页面挂后台、定时器被浏览器节流等
   情况下心跳停了，5 秒内被 sweep 回收并广播 `unlocked(reason=ttl)`。
5. 保存/取消 → `unlock`。关闭/刷新页面：`beforeunload` 尽力发一次解锁，
   WS `close` 兜底释放该连接全部锁。
6. WebSocket ping 探活（默认 25 秒）**只终止真正死掉的 TCP 连接**；
   此外客户端每 20 秒发一次应用层心跳，防止反向代理因"连接空闲"掐线。
   因此开着页面发呆不会掉线。

### WebSocket 消息

客户端 → 服务器：

```
hello {userId, userName}
lock {nodeId}            unlock {nodeId}
heartbeat {nodeId?}
save {nodeId, content, baseVersion}
restore_save {nodeId, content, restoreVersion}   # 历史回退后保存（diff4）
resolve {nodeId, content, keep}                  # 冲突裁决
history {nodeId}
add {parentId, afterId, content, treeRev}
move {nodeId, parentId, afterId, treeRev}
delete {nodeId, treeRev}
```

服务器 → 客户端：

```
hello {user}
snapshot {title, treeRev, nodes[], locks[], users[]}
presence {users[]}
locked {nodeId, user}                  # 别人拿到锁（不会回发给持有者本人）
lock_acquired {nodeId, reacquired}     # 你拿到/重新拿到锁
unlocked {nodeId, reason?}             # 你持有的锁没了（TTL 等）；或别人的锁释放
lock_denied {nodeId, holder}
content {nodeId, version, content, author, ...}
saved {nodeId, revision}
merge_notice {nodeId, revision, message}
conflict {nodeId, reason, base?, local, remote, current}
history {nodeId, items[]}
node_added {node, treeRev}
node_moved {nodeId, parentId, pos, treeRev}
nodes_deleted {ids[], treeRev}
tree_stale {treeRev}（后随 snapshot）
heartbeat_ack {ok}
error {message}
```

---

## 语义边界（刻意的设计选择）

- **同一点插入不同内容算冲突**：两人都在同一句的同一个 token 间隙插入，
  机器无法判断谁该在前，交给用户。这与 `git merge-file` 的保守策略一致。
- **回退不是"覆盖回旧版"**：历史版本只读；回退产生一条**新版本**。
  如果回退点之后别人恰好改过你要恢复的那一块文本，同样会弹冲突窗——
  这正是"不能无故抹掉别人改动"的代价：宁可多问一次，绝不静默覆盖。
- **删除段落是软删（带子树）**：历史 revisions 仍在数据库；当前版本不提供回收站 UI。
- 单文档、单实例部署。SQLite 配合单 Node 进程足够支撑小团队；
  要横向扩展需要把锁状态和广播搬到 Redis/PostgreSQL LISTEN，不在当前范围。
