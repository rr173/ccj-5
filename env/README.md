# 协同大纲（Collab Outline）

一个自托管的、多人同时编辑层级大纲的小应用。针对四件事做了明确的设计：

| 需求 | 做法 |
| --- | --- |
| 看出别人正在改哪段 | 段落级**软锁**，编辑者头像+姓名显示在段落上，在线名单实时更新 |
| 关页面/无操作后锁自动消失 | WS `close` 立即释放；心跳续租；服务器 TTL 扫描 + ping 探活兜底；本地 30 秒无输入主动释放 |
| 多人改同段最终必须收敛 | **服务器是唯一事实源**，保存带版本号；过期提交做 token 级 **diff3 三方合并**，不相交改动自动合成一个新版本全员广播；真重叠**拒绝并弹冲突窗**，不存在"各自成功" |
| 断线后还能继续改 | 离线保存进 **localStorage 队列**（同段自动合并成一条，保留最初基准版本），本地乐观显示+「待同步」徽章，刷新/关页面不丢；重连拿到新快照后**逐条自动回放**（带 `clientTag` 对号回执），不撞的走 diff3 自动合并全员广播；撞上的段落**挂红徽章明示"当前以线上（谁的 v几）为准"**，点徽章弹裁决窗，裁决后全员逐字一致 |
| 按整份来回看时间 | 结构与内容共用一张 append-only `timeline`（全局单调 seq 即"时刻"）：任意时刻可重建**整棵树的层级+正文**；跟读行投影源在**同一时刻**的内容，源这份和跟读这份严格对照，所有人看到同一份 |
| 从旧时刻接着改 | 不是覆盖，而是**另开一条线**：该时刻的正文载入草稿，保存时以旧版本为共同祖先做三方合并（diff4）——现在这条线上别人后来写下、没撞上的改动自动保留；两人从同一时刻接着改，仍走合并/冲突裁决收敛成同一份 |
| 对外定稿 | 工作稿（编辑们实时协同这份）与**对外定稿**（不可变快照）严格分开：外面的人打开 `/published/` 只读页，只看最近一次「定稿」冻结下来的整树内容，工作稿怎么改都不外泄；再点一次定稿，发布在**单个事务**里原子切换并向所有观看者推送同一份新快照；并发定稿靠 `basePubSeq` 乐观锁——两人同时定，只有一个成功，另一个收到 `publish_stale` 重确认，不存在"两边都定出去了却对不上"；没点确认绝不产生新版本，反悔零成本，外面始终停在上一版 |
| 一人讲解、全员同段 | 每份大纲的讲解轮次是服务器内存里的**单一事实源**：同一时刻最多一个讲解者，所有跟读端按同一条 `presentation` 消息锁定并滚动到所指标题；并发开讲只有一人成功，另一人收到 `presentation_denied`。交棒是两阶段 offer：接受前讲解者和位置都不变，讲解者可随时取消，大家仍停在上一轮指着的地方；接受后原子切换 leader，全员再跟新人走同一段 |
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
npm test                  # WebSocket 端到端（16 + 6 + 11 + 7 + 9 + 10 个场景）+ 离线续改端到端 + 单元测试
node test/offline.e2e.test.js             # 离线续改：真实客户端 + 服务器停启 + 重连对齐全流程
node test/presentation.e2e.test.js        # 讲解轮次：唯一讲解者/抢轮/两阶段交棒/取消反悔/断线结束
node test/published.e2e.test.js           # 对外定稿：隔离/冻结/原子切换/并发 CAS/只读边界/跟读冻结
node test/client.smoke.test.js            # jsdom 客户端冒烟：多文档 + 跟读全流程
node test/client.timetravel.smoke.test.js # jsdom 客户端冒烟：整份时间轴回看全流程
node test/fraction.test.js        # 分数索引：6000 次随机插入顺序不变
node test/merge.test.js           # diff3 固定用例
node test/merge.property.test.js  # 4000 组随机编辑：交换律/无误报冲突
```

端到端覆盖：初始快照、软锁拒绝、关页面立即解锁、空闲 TTL 回收后他人立即接手、
**空闲活连接跨多个 ping 周期不被掐**（回归）、版本保存广播、
过期提交自动合并与收敛、真冲突拒绝与裁决收敛、历史留痕、
回退 diff4 保留他人改动、增/降级/删结构操作、过期树版本拒绝、
断线重连补齐离线期间修改、多文档与跟读投影/跨文档锁/源删除墓碑、
**整份时间轴**（事件单调、整树时刻重建、源与跟读同一时刻对照、
两人从同一旧时刻接着改的收敛与裁决、已删段落拒绝接着改、旧库迁移回填）、
**离线续改**（断线保存入本机队列并乐观显示、重连自动回放合并、
跟读同份收敛、同段冲突红徽章"当前以线上为准"与裁决收敛、
clientTag 回执对号、未保存草稿落盘）。

---

## 使用说明

- 进入页面输入名字即可（身份随机生成存在 `localStorage`，头像颜色由身份哈希决定）。
- 段落悬浮出现操作条：**编辑 / ＋子级 / ＋同级 / 挂跟读 / 历史**。
- 编辑中：`Ctrl+Enter` 保存、`Esc` 取消；工具条可升级/降级/上下移动/删除。
- 别人正在编辑的段落会高亮并显示头像，编辑按钮会被服务器拒绝。
- 顶栏「🕘 时间轴」打开**整份时间轴**：每条事件（新增/修改/移动/删除/挂跟读）都是一个可回看的时刻。
  点「回到这一刻」，当前大纲的**层级与正文整体**回到当时（只读）；切到挂了跟读的大纲，
  看到的是**同一时刻**的对照（时刻坐标全局统一，任何人打开都一样）。
- 回看时点段落上的「从此刻继续编辑」：该时刻的正文载入编辑器，保存时与现在的内容三方合并——
  另开一条线往下写，别人在此之后不冲突的改动自动保留，真重叠仍会弹冲突窗。
  当前已被删除的段落会标注「当前已删除」，不能接着改。
- 历史抽屉里每一条 revision 也都可以「以此版本继续编辑」（单段视角的同一机制）。
- 真冲突时弹出三栏窗口（你的版本 / 对方版本 / 最终内容），可以选边或手工合并后提交。
- 断线时点「保存」：改动写入本机离线队列（段落上挂「待同步」徽章，顶栏有计数胶囊），
  刷新/关页面不丢；恢复连接后自动逐条与线上对齐——不撞的自动合并（含跟读行一起更新），
  撞上的挂红徽章「当前以线上为准」，点徽章打开裁决窗选最终内容。
  再点「编辑」会把待同步的改动折进编辑器：**取消编辑不丢已存本机的改动**（原样回到队列），
  只有从没保存过、只在框里敲了一半的草稿才会随取消清掉。
- **断网也能改正文**：离线时点保存，改动先存进本机队列（段落上挂「待同步」黄徽章，
  顶栏出现待同步胶囊），刷新/关页面都不丢；恢复连接后自动逐条与线上对齐——
  没撞上的直接合并进线上（跟读那边同步变成同一份），撞上的段落挂**红徽章
  「当前以线上（谁的 v几）为准」**，点徽章或顶栏胶囊打开裁决窗选最终内容。
  没保存的草稿也随输入落盘，下次打开同一段会提示恢复。
  离线时增/删/移动/挂跟读这类**结构改动不能暂存**（树版本锁无法离线对齐），会明确提示联网后再试。
- **一人讲解，其他人跟读**：段落操作里点「讲解」开始这一轮，讲解者再点别段的「指这里」，所有正在看这份大纲的人都会被拉到同一段并停住，不能各翻各的。
  - 顶栏显示当前讲解者；讲解者可以点「交给某人」发起交棒。
  - **对方接受前，轮次还在讲解者手里、位置也不变**；讲解者点「继续我讲（取消交棒）」即可反悔，大家仍停在上一轮指着的段落。
  - 对方点「接过来讲」后，服务器原子切换讲解者，所有人继续跟着新讲解者；旧讲解者不能再移动位置。
  - 两个人几乎同时抢一轮，服务器只确认一个讲解者，另一个人收到提示并看到当前轮次，不会两边都显示自己在讲。
  - 讲解是临时协作状态，服务重启或讲解者最后一个连接断开后本轮结束；正文和历史不受影响。
- **对外定稿**：顶栏「📢 定稿」把**当前工作稿**冻结成对外版本（确认弹窗里可勾选"定稿后打开对外页"）。
  - 外面的人打开 `http://<站点>/published/?doc=<文档id>`（默认文档可省略参数），是**纯只读页**：
    没有登录、没有任何编辑入口；服务器把这种连接标记为 `viewer`，只推送定稿快照，
    工作稿的正文、结构、锁、改写提议一律不扇出，viewer 发来的写消息也被服务器直接拒绝。
  - 还没定过稿时对外页只显示"尚未定稿"，**不会**把工作稿漏出去。
  - 定稿之后编辑照常改工作稿，对外页纹丝不动；下次定稿时所有开着对外页的人**整树替换**到新版，
    不会出现半新半旧。顶栏胶囊显示当前对外是第几版、谁定的、什么时候。
  - 跟读行在定稿时把当时投影的正文**内嵌冻结**：对外那份自包含，源文档之后怎么改甚至删除都不影响它。
  - 内容与上一版完全相同的定稿不产生新版本（回执 `unchanged`），两个人对着同一份内容重复点也算同一版。

---

## 架构

```
浏览器 (public/：原生 JS，无构建)
   │  HTTP 静态资源            WebSocket /ws（JSON 消息）
   ▼                                ▼
Express + ws (server/index.js) ── LockManager（内存：软锁/TTL/presence）
   │                         └─ presentations（内存：文档级唯一讲解者/所指标题/交棒 offer）
   │
   ├── merge.js    token 级 diff3（拉丁按词、CJK 按字）
   ├── fraction.js 分数索引 midpoint（同层排序，无限插入不返工）
   └── db.js       better-sqlite3（同步事务）
                      ├── documents  (tree_rev 结构乐观锁)
                      ├── nodes      (parent_id, pos, deleted 软删)
                      ├── revisions  (node_id, version 单调, content, author, note)
                      ├── timeline   (全局 seq 时刻：结构+内容事件，整树可重建)
                      └── publications (pub_seq 定稿版本, base_seq CAS, timeline_seq, snapshot 冻结 JSON)
```

### 收敛协议要点

- 每个段落有独立单调 `version`；保存消息必须带 `baseVersion`。
- `baseVersion === 当前版本`：直接追加 revision，广播 `content`。
- `baseVersion < 当前版本`：
  - `merge3(base版本, 你的草稿, 当前版本)`；
  - 无重叠 → 合并结果作为新版本落库（note 记录"自动合并"），广播给所有人；
  - 有重叠 → 返回 `conflict`，原封不动保留服务器内容，等用户裁决后用 `resolve` 提交。
- 合并满足交换律（A 先来还是 B 先来，最终文本一致），算法层有随机属性测试守护。
- **离线回放复用同一条合并管线**：断线时的保存存进本机 `localStorage` 队列
  （同一段落只留最新正文 + 最初基准版本），重连收到新快照后按序回放，
  每条带客户端生成的 `clientTag`；服务器在 `saved`/`merge_notice`/`conflict`/`error`
  回执里原样透传，客户端据此把回执对号到具体离线改动——
  离线回放的回执绝不会误关正在进行的交互式编辑会话。
  冲突的离线改动留在队列里（`status: conflict`），行内红徽章与顶栏胶囊
  都明示"当前以线上版本为准"，裁决走正常 `resolve`，全员广播收敛。
- 结构操作（增/移/删）用文档级 `tree_rev` 乐观锁；过期操作被拒绝，
  服务器紧接着下发一份完整快照纠正客户端。
- 整份时间轴：每次内容保存与结构变更都追加一条 `timeline` 事件（同事务），
  全局单调 `seq` 是内容和结构共用的时刻坐标。`snapshot_at` 按 seq 重放结构事件、
  取每段当时生效的 revision，重建结果是 seq 的**纯函数**——不依赖请求人、
  不依赖请求时机，天然"大家看到的一样"。跟读行投影源节点在同一 seq 的内容，
  源这份和跟读这份用同一个 seq 即可严格对照。

### 讲解轮次协议要点

- 状态只保存在服务器内存：`presentations: docId -> { leader, nodeId, offer }`，
  快照给晚加入者，增量用 `presentation` 广播。
- `presentation_start` 只在当前无讲解者时成功；Node.js 单线程顺序处理两条 WS 消息，
  并发开讲天然串行化，后到者只会收到 `presentation_denied` 和当前状态。
- 讲解者用 `presentation_point` 换段；非讲解者的换段请求被拒绝。
- `presentation_handoff` 只写入待决 `offer`，**不替换 leader、不替换 nodeId**。
  目标用 `presentation_accept` 后才在同一次请求里原子改 leader；在此之前讲解者或目标
  都可以 `presentation_cancel_handoff`，取消后所有人看到的仍是上一轮的讲解者和位置。
- 讲解者最后一个连接断开，或所指段落被删除，服务器清掉本轮并广播 `active:false`。
- 前端在跟读状态下拦截 wheel/keyboard/touch/scroll 造成的翻页，并立即把视口拉回
  服务器指定的 nodeId，避免 UI 上短暂"各翻各的"。

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
hello {userId, userName, role:'viewer', docId}  # 对外定稿页：只读观看者，只进 view 房间
lock {nodeId}            unlock {nodeId}
presentation_start {docId, nodeId}
presentation_point {docId, nodeId}      # 只有当前讲解者可移动所指标题
presentation_handoff {docId,targetUserId}
presentation_cancel_handoff {docId}
presentation_accept {docId}
presentation_stop {docId}
heartbeat {nodeId?}
save {nodeId, content, baseVersion, clientTag?}
restore_save {nodeId, content, restoreVersion, clientTag?}   # 从旧版本/旧时刻接着改（diff4 另开一条线）
resolve {nodeId, content, keep, clientTag?}                  # 冲突裁决
history {nodeId}
timeline                                         # 拉整份时间轴（全局事件流）
snapshot_at {docId, seq}                         # 把某份大纲重建到时刻 seq
publish {docId, basePubSeq}                      # 把当前工作稿定为对外新版（CAS：basePubSeq=看到的当前定稿序号，首次为 0）
open_published {docId}                           # 观看者：进入对外定稿房间（只读）
leave_published {docId}
add {parentId, afterId, content, treeRev}
move {nodeId, parentId, afterId, treeRev}
delete {nodeId, treeRev}
```

`clientTag` 是离线回放队列给保存贴的回执标签（可省）；
`saved` / `merge_notice` / `conflict` / `error` 回执会原样带回。

服务器 → 客户端：

```
hello {user}
snapshot {docId, title, treeRev, nodes[], locks[], presentation|null, users[], published?}
presentation {docId, active, leader, nodeId, offer|null}   # 讲解轮次变化（active=false=本轮结束）
presentation_denied {docId, leader, nodeId, message}
published_state {docId, pubSeq, title, nodes|null, by?, createdAt?}  # 观看者初始；nodes=null=从未定稿
published_changed {docId, pubSeq, timelineSeq, title, nodes[], by, createdAt}  # 定稿原子切换：编辑者+观看者都收
published_ack {docId, pubSeq, unchanged?}    # 定稿成功回执（只回发布者本人；其他人收 published_changed）
publish_stale {docId, current{pubSeq,...}}   # 并发定稿输了：基准过期，确认后基于新版重试
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
timeline {latestSeq, items[]}                    # items: {seq, kind, summary, author, docTitle, createdAt}
snapshot_at {docId, title, asOf{seq, createdAt, latestSeq}, nodes[]}
node_added {node, treeRev}
node_moved {nodeId, parentId, pos, treeRev}
nodes_deleted {ids[], treeRev}
tree_stale {treeRev}（后随 snapshot）
heartbeat_ack {ok}
error {message}
```

---

## 语义边界（刻意的设计选择）

- **定稿是整树快照，不是视图开关**：每次定稿把当时的层级、正文（含跟读投影）序列化成
  一行不可变 JSON 存进 `publications`。工作稿之后的增删改与已定稿的内容互不影响；
  "外面"永远只读当前最大 `pub_seq` 那一行，不存在中间状态。
- **并发定稿只可能一个赢**：`publish` 必须带 `basePubSeq`（客户端看到的当前定稿序号），
  与文档当前值不一致的请求在同一 SQLite 事务里被拒为 `publish_stale`。
  输的人先看到新版、再决定要不要基于新版重新定稿——与段落保存的乐观锁同一思路，
  从机制上杜绝"两边都显示定出去了却对不上"。
- **定稿是显式动作**：打开确认弹窗不等于定稿，只有点了「确认定稿」才发请求；
  取消/关弹窗什么都不发生，外面看到的还是上一版。
- **只读边界在服务器**：`role:'viewer'` 的连接被放进独立的 `view:<docId>` 房间，
  工作稿消息从不扇出到该房间；任何写/锁消息在消息分发入口直接拒绝。
  前端没有编辑入口只是体验，不是安全依赖。
- **对外页不暴露未发布内容**：从未定稿时 `published_state.nodes = null`，页面显示空状态；
  不会为了"别让页面空着"而回退展示工作稿。
- **跟读在定稿时按当时投影冻结**：对外快照自包含，源段落之后被改/被删都不改变已定稿内容。
- **定稿不进 timeline**：timeline 只描述工作稿的演进；定稿是工作稿在某时刻的"出口事件"，
  用自己的 `publications` 表与 `pub_seq` 序号，回看时刻坐标（全局 seq）保持单一含义。
- **离线暂存只覆盖段落正文**：增/删/移动/挂跟读这类结构改动依赖文档级 `tree_rev`
  乐观锁，离线时无法安全暂存，客户端会明确拦下并提示联网后再试；
  正文编辑则自动落本机队列，联网后对齐。
- **离线队列是本机级的**：`localStorage` 按浏览器隔离，换设备/换浏览器看不到
  另一台机器上未同步的离线改动——没同步前那些改动本来就还没上线。
- **离线期间看到的"别人也在改"可能滞后**：断线时本地乐观显示的是自己的改动，
  重连后先被服务器快照校正为线上真相，再逐条回放对齐；冲突段落
  在裁决前一律以线上版本为准，不存在"两边都显示成功却对不上"。
- **同一点插入不同内容算冲突**：两人都在同一句的同一个 token 间隙插入，
  机器无法判断谁该在前，交给用户。这与 `git merge-file` 的保守策略一致。
- **回退/接着改不是"覆盖回旧版"**：历史版本只读；从旧时刻接着改产生一条**新版本**
  （历史里注明来源版本）。如果旧时刻之后别人恰好改过你要恢复的那一块文本，
  同样会弹冲突窗——这正是"不能无故抹掉别人改动"的代价：宁可多问一次，绝不静默覆盖。
- **回看是整份只读**：回看模式下不能增/移/删段落（结构没有"从旧时刻分叉"的说法），
  只能对单段「从此刻继续编辑」；当前已删除的段落不能接着改（历史仍可查）。
- **时刻坐标是全局 seq 而不是墙钟时间**：同一毫秒内的多个事件也有严格先后；
  跨文档（源与跟读宿主）用同一坐标对照，不存在时区/时钟偏移问题。
- **大纲标题不参与回看**：标题没有历史，回看的只是层级与正文。
- **旧库迁移是尽力而为**：升级前的数据按 `created_at` 回填时间轴
  （创建/内容保存/软删可恢复；历史上的移动轨迹不可考，按当前层级回填）。
  升级之后的每个操作都精确记录。
- **删除段落是软删（带子树）**：历史 revisions 仍在数据库；当前版本不提供回收站 UI。
- 单文档、单实例部署。SQLite 配合单 Node 进程足够支撑小团队；
  要横向扩展需要把锁状态和广播搬到 Redis/PostgreSQL LISTEN，不在当前范围。
