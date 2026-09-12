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
| 把一段话抄一份挂到别处（**摘录**） | 摘录是**冻结副本**：做摘录那一刻把源段正文连同源版本号复制进自己的 `excerpt_states`，源之后怎么改，摘录的字纹丝不动；源每保存一版，所有挂着这段摘录的人立刻收到一条**不带正文**的版本标记，徽章马上从「与原文一致」翻成「原文已改到 v几」（不必重新打开），**绝不会悄悄换成新字**。更新只能靠显式「对齐到原文」：对齐在**单个事务**里冻结新正文，全员收到同一条 `excerpt_aligned`（所有人看到同一份）；并发对齐靠 `baseSourceVersion` 乐观锁——两人几乎同时对齐、各自认定的原文还对不上时，只有基于"源当前版本"的请求成功，另一个收到 `excerpt_align_stale` 并带回此刻真正的原文，重确认后才能成功，不存在"两边都提示成功却冻着不同的字"。不点确认绝不发请求，取消/关弹窗零成本，摘录始终停在上一版冻字 |
| 在一段上留言 | 留言存在服务器、锚定**段落本身**（`nodeId`，跟读挂载行各自独立），与正文版本完全脱钩：这段后来改字、三方合并怎么走，留言都原样挂着。新增/收掉都广播给整个文档房间，**所有正在看这份的人（含自己的其他标签页）以同一条消息为唯一事实**，不做本地乐观显示。收掉是 open→resolved 的**单事务 CAS**（条件 `UPDATE … WHERE status='open'`）：两人几乎同时用不同说法收同一条，只有先到者写入并广播一条 `comment_resolved`，后到者收到 `comment_resolve_stale` 与先收那份说法并收敛过去，不会两边都显示已收、内容却对不上。收留言有确认弹窗，**没点确认绝不发请求**，取消/关窗零成本，留言在所有人那里保持上一份开着的样子 |
| 把拿掉的段落捞回来 | 删除普通段落（含整棵子树）不只是软删：同事务把这批写进全员共享的**可捞名单**（`trash_events`），删除后广播一条 `trash_update`，晚加入者从 `snapshot.trash` 整份拿到——当时看着这份的人（含自己的其他标签页）看到的是**同一份名单**，不是只在删除者屏幕上。捞回在**单个事务**里复活整棵子树（原文 revisions、留言、封口都还在），`nodes_restored` 一条广播带回**拿掉前的位置**（按当前存活同级重新夹在删前两邻居之间，顶层段落不会被误甩到末尾；同分数槽被占用时贴着占用者落位）与**原文快照**，全员逐字一致；挂在别处的**跟读**同步收到 `source_restored`、撤除墓碑重新投影，**摘录**只解除"源已删除"墓碑（冻字仍不自动换，需显式对齐）。并发捞同一批靠 `tree_rev` 乐观锁 + 批次 `active=1` 的 CAS：两人几乎同时捞、手里认定的树还不一样时，只有先到者那条 `nodes_restored` 被广播，后到者收到 `tree_stale`/`restore_stale` 并随整份快照收敛到先捞者放回的位置，不会两边都显示捞回、位置却对不上。**没点「确认捞回」绝不发请求**，取消/关弹窗零成本，树在所有人那里保持上一份已拿掉的样子。跟读/摘录挂载行的"移除"只是摘引用，源还在，不进名单 |
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
npm test                  # WebSocket 端到端（16 + 6 + 11 + 11 + 8 + 11 + 7 + 9 + 10 个场景）+ 离线续改端到端 + 单元测试
node test/offline.e2e.test.js             # 离线续改：真实客户端 + 服务器停启 + 重连对齐全流程
node test/excerpt.e2e.test.js             # 摘录：冻结/源改不跟随/陈旧徽章/对齐广播一致/CAS 并发/源删除墓碑/时间轴
node test/comments.e2e.test.js            # 段落留言：全员可见/改字不丢/收掉广播一致/并发 CAS 收敛/取消反悔/边界
node test/trash.e2e.test.js               # 捞回：全员同一份名单/原位原文回来/夹在原邻居之间（含撞槽）/跟读一起回/并发 CAS/取消反悔/留言随回/时间轴
node test/seals.e2e.test.js               # 段落封口：全员同一条/写路径硬拦/删父级拦截/并发理由 CAS/取消反悔/跟读投影/时间轴
node test/trash.e2e.test.js               # 捞回：全员同一份名单/原位原文回来/夹在原邻居之间（含撞槽）/跟读一起回/并发 CAS/取消反悔/留言随回/时间轴
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
- 段落悬浮出现操作条：**编辑 / 提改写 / 做摘录 / ＋子级 / ＋同级 / 挂跟读 / 讲解 / 历史**。
- 顶栏「♻ 捞回」打开**可捞名单**：删除的普通段落（含整棵子树）在这里全员可见，可连原文带位置整批捞回。
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
- **一人讲解，其他人跟读**：段落操作里点「讲解」开始这一轮，讲解者再点别段的「指这里」，所有正在看这份大纲的人都会被拉到同一段并停住，不能各翻各的。  - 顶栏显示当前讲解者；讲解者可以点「交给某人」发起交棒。
  - **对方接受前，轮次还在讲解者手里、位置也不变**；讲解者点「继续我讲（取消交棒）」即可反悔，大家仍停在上一轮指着的段落。
  - 对方点「接过来讲」后，服务器原子切换讲解者，所有人继续跟着新讲解者；旧讲解者不能再移动位置。
  - 两个人几乎同时抢一轮，服务器只确认一个讲解者，另一个人收到提示并看到当前轮次，不会两边都显示自己在讲。
  - 讲解是临时协作状态，服务重启或讲解者最后一个连接断开后本轮结束；正文和历史不受影响。
- **做摘录（把一段话抄一份挂到别处）**：段落操作里点「做摘录」，选择挂到哪份大纲（可以是另一份，也可以是本大纲的别处）。
  - 摘录与**跟读相反**：它是做摘录那一刻的**冻结副本**。源段落之后再怎么改，摘录显示的仍是抄下来那一刻的字，**不会自动更新**。
  - 源往前走了版本，摘录行上会挂出徽章「⚠ 原文已改到 v几，这行还停在摘录时的 v几」，并配左侧色条，一眼看得出两边已经不是同一句话；徽章或「⇪ 对齐到原文」可发起对齐。
  - 对齐必须在确认弹窗里**左右对照**（左=摘录当前冻字，右=原文此刻）点「确认对齐」后才发出请求：服务器把原文此刻的正文冻成新一份，所有正在看的人立刻收到**同一条** `excerpt_aligned`，逐字一致。
  - 你确认期间原文又被改了：后到的对齐请求被乐观锁拦下（`excerpt_align_stale`），弹窗自动换成**此刻真正的原文**请你再看一眼，冻字保持不变——两个人几乎同时对齐、手里认定的原文对不上时，**不可能两边都显示对齐成功却冻着不同的字**。
  - 取消、点遮罩关闭、甚至点了之后反悔：只要没点「确认对齐」，就不会发任何请求，摘录始终是上一版冻着的字。
  - 源段落被删除：摘录**保留最后一次冻结的正文**（那是摘那一刻真实存在的字），但标注「源段落已删除」、不能再对齐；移除摘录只删这份副本，源和别处的摘录都不受影响。
  - 摘录只读：不能直接编辑、加锁、提改写、在其下加子级（要改用「去源大纲」），也不能再被摘录。做摘录与每次对齐都进时间轴，整份回看时摘录展示它在那个时刻冻住的字。
- **段落留言**：段落悬浮操作里点「💬 留言」打开这段的留言面板（Enter 发送、Shift+Enter 换行）。
  - 留言挂在**段落**上而不是某一版正文上：这段以后怎么改字，留言都在，不会跟着正文一起没。
  - 发出后所有正在看这份大纲的人立刻看到同一条（你自己的其他标签页也以广播为准），行上挂「💬 N 条未收留言」徽章。
  - 点留言卡片上的「收掉这条」会先弹确认窗，可附一句"收掉时说"（可留空）；确认后全员看到**同一份已收**。
    你确认期间已被别人先收掉，弹窗自动关闭并显示**先收者那份说法**，绝不会两边都收了、内容却对不上。
    取消或关掉弹窗什么都不会发生，留言仍是上一份开着的样子。
  - 跟读行上的留言挂在这一处挂载行上（跨文档各自独立）；摘录是冻结副本，不能在上面留言（可去源段落）。
    离线时不能留言（入口会提示联网），避免"自己屏幕显示发了、其实谁都没收到"。
- **捞回拿掉的段落**：删除普通段落（含它下面整棵子树）后，顶栏「♻ 捞回」名单里全员（含你自己的其他标签页）
  都看得到这一批；晚到的人打开文档也从快照里拿到同一份，不是只在删除者屏幕上。
  - 点一批上的「捞回」先弹确认窗，里面是**拿掉前的原文**与这批包含的段数；确认后整批在**单个事务**里复活，
    所有正在看这份大纲的人立刻看到同一份结果：段回到**删前那两个邻居之间**（顶层段也一样，不会被甩到大纲最底下；
    删除期间别人正好占了同一个位置槽，也贴着占用者落回原间隙），**原文一字不差**，子段、留言、封口状态随段一起回来。
  - 以前**挂出去跟着读**的地方也一起回来：墓碑撤除，重新投影同一份原文；摘录行只解除"源已删除"标记，
    冻字仍不自动换（要更新照旧点「对齐到原文」）。
  - 你确认期间别人已先捞回：弹窗自动关闭并随整份快照收敛到**先捞者放回的位置**，
    绝不会两边都显示捞回来、位置却对不上（并发请求在服务器事务里串行，后到者只拿到 stale）。
  - 取消、点遮罩关闭：只要没点「确认捞回」就不发任何请求，树在所有人那里保持上一份"已拿掉"的样子。
  - 跟读/摘录挂载行的「移除」只是摘掉这一处引用，源段落本来就还在，不进可捞名单。
- **段落封口（🔒 硬冻结）**：段落悬浮操作里点「🔒 封口」，写一句**封口理由**并确认后，所有正在看这份大纲
  （含挂了这段**跟读**的其它大纲）的人立刻看到同一份已封：行首锁标记 + 红色封条 + 理由徽章。
  - 封住后这段的**正文、改写提议、移动、删除全部硬锁**，谁都不能再把新字写进去（"删父级带走它"也整笔拒绝，不能绕过封口）；
    讨论（留言）、挂跟读、做摘录、在其下加子级不受影响。服务器是唯一事实源，前端禁用只是提示，绕过前端同样被拒。
  - 两个人几乎同时用**不同理由**封同一段：SQLite 事务串行裁决，只有先到者那条 `sealed` 被广播，
    后到者收到 `seal_stale` 并自动收敛到**先封者那条理由**——不可能两边都显示封住、理由却对不上。
  - 任何人都可以点行上的「🔓 重新打开」（可附一句打开说明，会留在时间轴），确认后全员看到同一份已打开，段落立即恢复可改。
  - **反悔零成本**：打开封口弹窗/取消/点遮罩都不发任何请求，这段仍是上一份开着、能改的样子；只有点「确认封口」才发请求。
  - 封口与打开都进时间轴（`seal`/`unseal`），整份回看时能重建"那一刻这段是封着还是开着、理由是什么"。
  - 跟读行投影源段落的封口（源封跟读封、源开跟读开）；摘录本身就是冻结副本，不参与封口。封口不进离线队列，离线时入口直接拦下。
- **对外定稿**：顶栏「📢 定稿」把**当前工作稿**冻结成对外版本（确认弹窗里可勾选"定稿后打开对外页"）。  - 外面的人打开 `http://<站点>/published/?doc=<文档id>`（默认文档可省略参数），是**纯只读页**：
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
                      ├── nodes      (parent_id, pos, deleted 软删, mirror_of 跟读, excerpt_of 摘录)
                      ├── revisions  (node_id, version 单调, content, author, note)
                      ├── excerpt_states (摘录的 append-only 冻结副本：content + source_version)
                      ├── timeline   (全局 seq 时刻：结构+内容事件，含 excerpt_add/excerpt_align/restore，整树可重建)
                      ├── comments   (段落留言：锚定 node_id 的 open/resolved 状态机，收掉靠条件 UPDATE CAS)
                      ├── trash_events(可捞名单：删除批次 active 状态，捞回靠 tree_rev + active=1 CAS)
                      ├── seal_events(段落封口：append-only sealed/unsealed 流，最新一条决定封/开，事务串行 CAS)
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
  全局单调 `seq` 是内容和结构共用的时刻坐标。`snapshot_at` 按 seq 重放结构事件
  （add/mirror_add/excerpt_add/excerpt_align/move/delete/restore）、
  取每段当时生效的 revision，重建结果是 seq 的**纯函数**——不依赖请求人、
  不依赖请求时机，天然"大家看到的一样"。跟读行投影源节点在同一 seq 的内容，
  源这份和跟读这份用同一个 seq 即可严格对照。

### 摘录协议要点（与跟读对照）

- **跟读投影、摘录冻结**：跟读节点没有自己的正文，快照里始终投影源当前 revision；
  摘录节点在创建时把源此刻正文复制成 `excerpt_states` 第一行，快照展示自己这一份。
- **源正文消息不扇出到摘录房间：字不带走，版本号要带走**：`audienceDocIds` 只含源文档与
  跟读宿主，源的 `content`（带正文）从不发给摘录宿主；但每次源正文定稿，`broadcastContent`
  会另外给摘录宿主发一条**不含正文**的 `excerpt_source_changed {sourceId, version}`
  （收下改写提议的路径也一样）。只盯着摘录行、没打开源大纲的人据此立刻把「✓ 与原文一致」
  翻成「⚠ 原文已改到 v几」，不必等重新打开或拉快照；摘录冻着的字仍然一个字不变。
  这条消息刻意不带新正文，协议层保证"看得出两边已不是同一句，但摘录不会悄悄换成新字"。
- **对齐是 CAS**：`excerpt_align` 必须带 `baseSourceVersion`（确认弹窗里看到、
  明确要对齐过去的源版本）。事务内与源当前版本比对：一致才追加冻结行并广播；
  不一致回 `excerpt_align_stale`（附此刻真正的原文）。Node 单线程顺序处理消息 +
  SQLite 事务，两个几乎同时到达的对齐请求天然串行化，后到且基准过期者只拿到 stale。
- **对齐是 append-only**：每次成功对齐向 `excerpt_states` 追加一行并写时间轴事件
  `excerpt_align`（创建是 `excerpt_add`）。任意 seq 重建整树时，摘录取该 seq
  之前最近一次冻结行——回看结果是 seq 的纯函数，所有人一致。
- **对齐不改 tree_rev**：它只换摘录冻结正文，不动层级；做摘录本身是结构操作，走 tree_rev。
- **显式动作、反悔零成本**：打开/关闭确认弹窗都不产生任何写入；只有确认才发请求。
- **源被删**：摘录保留最后冻字但收到 `excerpt_source_deleted` 立墓碑，再对齐收到
  `excerpt_align_gone`。移除摘录只是软删这一个引用行，源和别处引用都不受影响。

### 段落留言协议要点

- **锚定段落、不锚定版本**：留言外键是 `node_id`（普通行或跟读挂载行），与 `revisions`
  没有任何耦合；正文保存、三方合并、回退接着改都不碰留言，"这段后来改了字，留言还在"
  是数据模型天然保证的，不是 UI 层保留。跟读挂载行上的讨论挂在挂载行自己身上，
  跨文档各自独立；摘录行是冻结副本，服务器直接拒绝在上面留言。
- **服务器唯一事实源、无乐观显示**：`comment_add` 落库后广播一条 `comment_added`
  给整个文档房间（含发起者自己的所有标签页），界面只以广播为准插入卡片——
  不可能"只有自己屏幕上有"。晚加入/重连者从 `snapshot.comments` 拿整份。
- **收掉是单行状态机 CAS**：`comments.status` open→resolved，SQL 是
  `UPDATE … SET status='resolved', resolved_content=? WHERE id=? AND status='open'`。
  Node 单线程顺序处理消息 + SQLite 事务，两条几乎同时到达、说法不同的收掉请求天然串行：
  先到者 `changes=1`，广播**唯一一条** `comment_resolved`（全房间逐字一致，
  resolvedContent 就此冻结）；后到者 `changes=0`，只收到个人回执
  `comment_resolve_stale`（带回先收者那份），**绝不广播第二份 resolved**——
  不存在"两边都显示已经收掉，内容却对不上"。
- **显式动作、反悔零成本**：打开收留言确认弹窗、在里面打字都不产生请求；
  只有点「确认收掉」才发 `comment_resolve`。取消/点遮罩关闭，留言在所有人那里
  仍是上一份开着的样子。已收留言不提供"重开"（收掉是终态），但卡片与说法留痕。
- **留言是讨论，不是大纲内容**：不进 `timeline`（时刻回看只重建大纲本身）、
  不进对外定稿快照（viewer 连接不能留言，也收不到）；段落被删除时随行一起从视图消失。
- **离线不能留言**：讨论类数据没有"本地队列/合并"管线，离线时留言入口直接拦下并提示
  联网后再试，避免出现"我这边显示发了、其实谁都没收到"的假状态。

### 段落封口协议要点

- **append-only 状态流**：`seal_events(node_id, kind: sealed|unsealed, reason, author)`，
  一段"当前封着/开着"= 该 node 最新一条事件。每次状态翻转同事务写一条时间轴
  （`seal`/`unseal`），回看任意 seq 时重放 <= seq 的封口事件即可重建当时状态，
  结果是 seq 的纯函数，所有人一致。
- **封的是源普通段落**：跟读入口（mirror）在处理器里 `resolveEditable` 解析到源，
  跟读行投影同一份封口（快照节点带 `seal`、增量扇出到 `audienceDocIds` 的全部宿主）；
  摘录（excerpt）本身就是冻结副本，不能封也不显示封口。
- **并发封口只可能一个理由赢**：两个几乎同时到达的 `seal` 在 SQLite 事务队列里串行，
  后到者事务内已能读到先到者插入的 `sealed`，只返回 `already`（调用方发 `seal_stale`
  并带回先封者整条事实），房间里只广播先到者那一条 `sealed`——与留言收掉、定稿 CAS
  同一套机制，杜绝"两边都显示封住、理由却对不上"。`unseal` 同理（`already_open` 幂等，
  回 `unseal_stale`，不广播第二条）。
- **唯一事实是房间广播（含发起者的其他标签页），不另发个人 ack**：客户端不做乐观封口。
- **硬边界在服务器事务里**：`saveContent` / `acceptSuggestion` / `createSuggestion` /
  `moveNode` / `deleteNode` 全部检查封口状态；删除是整棵子树检查（`sealedIdsWithin`），
  含封段则整笔 `sealed` 拒绝，不能用"删父级"绕过。`lock` 占用在封段上也不发放；
  封口成功后原子释放该段现存软锁并广播 `unlocked(reason=sealed)`，正开着编辑器的人
  收到广播即收起编辑会话。
- **显式动作、反悔零成本**：封口理由必填；打开/取消/点遮罩不产生任何写入，
  只有在确认弹窗点「确认封口」才发 `seal`。离线不封口（讨论/状态类操作同一条规则）。

### 捞回（回收站）协议要点

- **删除是软删 + 留批次**：删除普通段落（含整棵子树）在同一事务里把节点标 `deleted=1`
  并向 `trash_events` 追加一批（root_id/ids JSON/删前 parent_id+pos/root 摘要）。
  跟读/摘录挂载行的删除只是摘除引用，源还在，不留批次。删除后除 `nodes_deleted` 外
  再广播一条 `trash_update`（整份名单），快照 `snapshot.trash` 整份随带——
  所有正在看这份的人（含自己的其他标签页、晚加入者）拿到同一份可捞名单。
- **捞回是结构操作，双 CAS**：请求带 `treeRev`（看到的树版本）和批次 id；事务内
  1) 校验 tree_rev 未过期；2) 条件 `UPDATE trash_events SET active=0 … WHERE id=? AND active=1`。
  两个几乎同时到达的捞回在 SQLite 事务队列里串行：先到者整批复活、写 `restore`
  时间轴、tree_rev+1 并广播唯一一条 `nodes_restored`；后到者 tree_rev 过期收
  `tree_stale`（后随整份快照）或批次已非 active 收 `restore_stale`（服务器同样
  补发快照），**绝不广播第二条 nodes_restored**——不可能两边都显示捞回、位置却对不上。
- **位置回到删前的邻居之间，不是追加到末尾**：顶层段落的 `parent_id` 本来就是 NULL，
  不能把"没有父级"当成"父级没了"。捞回时在当前存活同级中找出夹着旧 pos 的前后两条，
  用分数索引在二者之间取新 pos；旧 pos 槽若在删除期间被新段占用（同一间隙 midpoint
  会生成相同分数），贴着占用者取内侧，仍然落回原间隙且不撞键。删前父级此刻还在
  另一批名单里没捞回时，这批先**挂起**（`pending`：批次从名单移除、不写时间轴、
  tree_rev 不动，节点仍保持删除状态），等父级那批被捞回时由同一事务级联复活，
  全员只收到父级那一条 `nodes_restored`（含连带回来的整棵子树）——不会出现
  "孩子复活成顶层孤儿、父级还在名单里"的中间状态。
- **一条广播带回原文**：`nodes_restored.nodes` 是复活整批的当前快照（含版本/封口），
  客户端无需再拉整树；锚定这些段落的留言（comments 表与正文版本无关）随消息带回。
  跨文档挂了跟读的宿主收 `source_restored`：跟读墓碑撤除并重新投影源当前正文；
  摘录宿主只撤"源已删除"墓碑与刷新源当前版本，**冻字不自动换**（要更新仍走显式对齐）。
- **显式动作、反悔零成本**：打开确认弹窗/取消/点遮罩都不发 `restore`；
  只有点「确认捞回」才发，树在所有人那里保持上一份"已拿掉"的样子。
- **进时间轴**：每批捞回追加一条 `restore` 事件（含新 parent/pos 与 ids），
  `snapshot_at` 重放时整批复活、root 定位到事件里的位置；结果是 seq 的纯函数。

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
restore {trashId, treeRev}                                 # 捞回一批删除（整棵子树回到删前邻居之间；tree_rev+批次 CAS）
add_mirror {sourceId, docId, parentId, afterId, treeRev}   # 挂跟读：正文永远投影源
add_excerpt {sourceId, docId, parentId, afterId, treeRev}  # 做摘录：冻一份源此刻的正文
excerpt_align {nodeId, baseSourceVersion}                  # 把摘录对齐到原文此刻（CAS）
comment_add {nodeId, commentId, content}                   # 段落留言：落服务器后全员广播
comment_resolve {commentId, content}                       # 收掉留言（CAS：先到者说法为准；确认后才发）
seal {nodeId, reason}                                      # 封口（理由必填；确认弹窗点确认才发；事务串行 CAS）
unseal {nodeId, reason?}                                   # 重新打开（说明可空；已开着则幂等 stale）
```

`clientTag` 是离线回放队列给保存贴的回执标签（可省）；
`saved` / `merge_notice` / `conflict` / `error` 回执会原样带回。

服务器 → 客户端：

```
hello {user}
snapshot {docId, title, treeRev, nodes[], locks[], presentation|null, users[], suggestions[], comments[], seals[], trash[], published?}
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
mirror_added {node, treeRev}
excerpt_added {docId, node, treeRev, by}                 # 新摘录（node 含冻结正文/源版本/stale）
excerpt_source_changed {sourceId, version}              # 源前进了一版：摘录立刻翻「原文已改」徽章（刻意不带正文）
excerpt_aligned {docId, nodeId, excerptOf, content, sourceVersion, currentSourceVersion, frozenAt, by}  # 对齐后全员同一份冻字
excerpt_align_ack {nodeId, sourceVersion, unchanged?}    # 只回发起者：解除忙碌态（内容以广播为准）
excerpt_align_stale {nodeId, current{version,content,...}, frozen, message}  # 并发输了：看新原文重确认，冻字不变
excerpt_align_gone {nodeId, message}                     # 源已删除：无法对齐，冻字保留
excerpt_source_deleted {sourceIds[]}                     # 源被删：摘录保留冻字、立墓碑
comment_added {comment}                                  # 新留言（全房间同一条；comment 含 id/nodeId/content/author/status...）
comment_resolved {comment}                               # 留言被收掉：全员同一份已收（含 resolvedContent/resolvedBy/resolvedAt）
comment_resolve_stale {comment, message}                 # 并发收掉输了：只回后来者，带回先收那份，不再广播
sealed {nodeId, docId, reason, by, createdAt, seal}      # 段落封口：源文档+全部跟读宿主同一条（含发起者其他标签页）
unsealed {nodeId, docId, reason, by, createdAt, seal}    # 重新打开：全员同一份已打开
seal_stale {nodeId, seal, message}                       # 并发封口输了：只回后来者，带回先封者理由，不广播第二条
unseal_stale {nodeId, message}                           # 并发/重复打开：已经开着，收敛到同一份
seal_denied {nodeId, seal?, message, clientTag?}         # 对封着的段做写操作（保存/改写/移动/删除/占锁）被服务器硬拦
node_moved {nodeId, parentId, pos, treeRev}
nodes_deleted {ids[], treeRev}
trash_update {docId, trash[]}                            # 可捞名单整份替换（删除/捞回后；全员同一条）
nodes_restored {docId, trashId, ids[], rootId, parentId, pos, nodes[], comments[], trash[], treeRev, by}  # 整批复活：原位+原文快照
source_restored {sourceIds[], contents[], sourceVersions[], treeRev}  # 跨文档跟读/摘录：源回来了，跟读撤墓碑重投影
restore_stale {docId, trashId, rootId?, reason, message} # 并发捞回输了：只回后来者，收敛到先捞者那份，不广播第二条
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
- **摘录是冻结副本，不是跟读的变体**：做摘录那一刻复制正文与源版本，源的实时 `content`
  从不扇出到摘录宿主；摘录只有"陈旧标记"和"显式对齐"两种与源的关系，没有"自动跟随"。
  这样"挂到别处的那段话"是一句有据可查、可逐字对照的引文，而不是会被远端悄悄改掉的活视图。
- **摘录对齐只可能一个赢**：两人对齐时各自把"我看到并确认的源版本"带上，
  与源当前版本不符的请求在同一事务里被拒为 `excerpt_align_stale`，冻字维持上一版，
  直到他看清新原文重新确认；不存在"两边都成功却冻着不同的字"。
- **摘录源被删除时保留冻字、禁止对齐**：删掉的是"与源的关联"，不是已抄下来的那句话；
  对外定稿时摘录也按自己的冻结正文自包含序列化。
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
- **删除段落是软删（带子树）**：历史 revisions、留言、封口事件仍在数据库；删掉的普通段落
  （含整棵子树）会进全员可见的**可捞名单**（顶栏「♻ 捞回」），任何人确认后整批连原文、
  留言、跟读处一起回到删前的邻居之间；跟读/摘录挂载行的删除只是摘引用、不进名单。
- 单文档、单实例部署。SQLite 配合单 Node 进程足够支撑小团队；
  要横向扩展需要把锁状态和广播搬到 Redis/PostgreSQL LISTEN，不在当前范围。
