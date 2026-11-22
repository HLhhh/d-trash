# d-trash — 第 1–4 期（会话回收站与物理删除）

第 1–4 期已交付。收进保留日志并归档；普通恢复不变；彻底删除与清空现为物理删除本地会话日志、不可恢复。
方案以随包提供的 `PLAN.md` 为准。既有真机入口和第 4 期两个会话的清理验收已通过（用户既有记录）；
本次开源整理仅运行隔离回归，未安装、重载或修改真实 profile，未操作真实会话。

## Host 协议与状态

`TrashService extends TypertRemoteService` 声明 `typert`、`storageDomain`、`workspaceRegistry`、`sessionPersistence`
依赖。首次调用时打开并共享 `trash` domain（version 1），打开失败后允许重试；
卸载先等待已接纳操作，再关闭 domain。持久化由宿主 storage backend 负责。

**可观测回收站 `trash = marker ∩ archived`。** marker 表与原生归档集合分别持久化；
原生取消归档不经过插件锁，之后的 marker 允许短暂滞留，由 `listTrash` 对账清理。
第二轮评审 B1 因此废弃了「持久 marker 永远指向已归档会话」的严格不变量。
插件不拦截、不修改原生归档/取消归档/置顶按钮或行为。

| 方法 | 行为 | Host 返回值 |
| --- | --- | --- |
| `trashSession(sessionId)` | 先原生归档（`stopActivity: true`），写 marker 前后均校验归档；发现原生取消归档则删 marker 并抛错 | `Promise<void>` |
| `restoreSession(sessionId)` | 先删 marker，再取消原生归档；失败且仍归档时才补回原记录 | `Promise<void>` |
| `removeFromTrash(sessionId)` | 门禁后持锁整体迁移、关锁、删除日志，再清归属/归档/marker/投影缓存 | `Promise<boolean>`（成功 true；门禁或阶段失败抛错） |
| `emptyTrash()` | 全局边界内逐条物理删除，部分失败保留失败 marker 并汇总阶段 | `Promise<number>`（成功数；部分失败抛 AggregateError） |
| `listTrash()` | 对账普通 stale marker；保留 purge 凭据，返回不含私有路径的记录副本与可选 purgePending | `Promise<Array<[SessionId, TrashRecord]>>` |

marker 包含 `trashedAt`，schema 保留可选 `workspaceId`、`titleSnapshot`。
正常收进不写这两个可选字段；工作区显示由 Client 的当前 Workspace 快照派生。
原生归档不会反向写 marker。

同一 session 的完整操作及补偿串行；`listTrash/emptyTrash` 的全局边界等待此前任务，
并阻止后来的插件写入越过。这个锁只协调 TrashService，不能锁住原生写入。
收进写后校验之后再发生的原生取消归档仍通过后续读取清理。

这些操作不是跨服务事务。归档拒绝时不新增 marker，即使归档已提交也保守保留；
marker 写入失败时，仅在原先未归档且确认没有 marker 时撤销归档；
未知提交状态/不可读 domain 不触发危险撤销。恢复若已取消归档但后续报错，不补回 active marker。
操作和补偿都失败时抛 `AggregateError`，保留两项错误与原始 cause；后续读取可重试清理。

## 物理删除与失败恢复

官方把 session pruning 定义为带外 backend maintenance，持久化 seam 无 delete API。
`src/purge.ts` 通过安装版官方 `@deepseek-ai/node-addon-system/flock` 获取独占锁；
缺失原生支持、锁文件、匹配的 JSONL stat/header/绝对 path 时拒绝。
从 `stat().location.path` 向上依次得到会话目录、slug、sessions 根、DSH home；
根名必须为 `sessions`，home、根与日志/会话路径必须通过 realpath 校验，限定两层会话目录并禁止 symlink。
不读取环境变量 `DSH_HOME`，缺失或错误值都不影响定位；下文 `$DSH_HOME` 均指反推并校验的 home。
取锁后及 intent 持久化后重复 stat/realpath/dev/ino 校验。原目录名只由 stat 提供，不自行编码推导。

执行顺序是 flock → 复核 → marker 保存 purge intent → 最后复核 → 整体 rename 到
`$DSH_HOME/sessions.trash-purge-staging/<encoded-id>-<uuid>` → close 释放锁 →
递归 rm 暂存 → detach 当前包含该 session 的各工作区 → unarchive → 删 marker → 尝试删除投影缓存。
逐工作区检查成员并汇总实际 detach 失败；不调用非成员工作区，不产生其 no-op 日志。
重试时重新读取成员投影，已完成 detach 的工作区跳过；零归属会话仍正常完成其余清理。
暂存是 sessions 根的兄弟目录，与 source 的 dev 必须相同；从不在持锁期间 unlink `session.lock`。
旧根内点目录暂存方案已废弃：JSONL 把根下每个目录当 project、其每个子目录当 session，
不会过滤点目录。兄弟暂存处于发现树外，rename 后即使崩溃残留也不会被 list 重新发现。
正常收进与恢复顺序沿用原协议；已有 purge 凭据时拒绝恢复或重新收进，防止丢凭据。

marker 的可选私有 `purge` 存 source/target/dev/ino/deleting/logsDeleted；Remote 只返回
`purgePending`。普通 trash 交集不变，已开始删除的诊断记录不随原生取消归档而消失。
日志与必要记录清理完成前保留 marker，`listTrash` 不惰性删除这些凭据。
每次 purge/empty 先恢复全部已记录暂存；日志已迁移/删除时，从原 stat 写入凭据的 `source` 反推并校验 home 和 sessions 根。
要求 `dirname(target)` 严格等于该 home 的兄弟暂存，复核身份和锁后关闭锁再 rm；
旧根内暂存凭据或其它非法 target 保留诊断，不自动迁移、删除或撤销凭据；
部分 rm 删除锁后凭 durable deleting 阶段继续重试。无凭据、路径不可靠或 source 被重建时拒绝猜测。
未发生 rename 的 intent 可安全撤销；已删除日志而记录失败可直接重试记录清理。
投影清理接收 `deleteStaged` 返回的已验证 home，不重新从环境变量取路径。
原生写入与插件不是一个事务；全局插件边界覆盖恢复/删除/清空，不能阻止原生取消归档或重建路径。

失败用 `Physical deletion [stage] (id): reason` 报告，结构化日志包含 sessionId/stage/result/reason。
`emptyTrash` 尝试全部条目，失败汇总成功数与阶段。Client 对失败也重读列表和只读 Workspace 投影，
显示部分成功和可重试的诊断条目。投影缓存失败只记录警告，此时 marker 可能已清除，不保证后续 purge 自动重试缓存。搜索索引依赖下一次稳定搜索观测时的现有同步收敛；已检查的 query API 没有公开 rescan，不调用私有 `_reconcile` 或直接编辑 SQLite。
附件、工作区文件、worktree、产物、服务端日志、备份及其它插件扫描快照均保留；不承诺安全擦除或搜索立即消失。
仅覆盖 POSIX JSONL 与进程崩溃，不声称断电事务；有 pending 凭据时不要降级旧版插件。

## 持久化操作日志

Host 将操作记录追加到 **`$DSH_HOME/logs/trash.log`**（UTF-8 JSONL，一行一个 JSON）。
这里的 home 由 `src/purge.ts` 共用的 stat 路径/realpath 校验反推，**不读取环境变量**。
每个 Host 实例首次定位后缓存该 home，在 purge 移走 source 前预先定位；重启后可从已打开 marker 内
原 stat 写入的 `purge.source` 重新推导。目标会话不存在或清空列表为空时，尝试其它 marker 凭据，
再由 `sessionPersistence.list()` 获取候选 id 并重新 `stat` 校验，不从 id 拼原目录。
若没有任何可靠 stat/凭据（例如全新空 home 的首次调用），无法安全确定日志路径，此次降级到 logger。

目录不存在则以 **0700** 创建；日志文件以 **0600** 创建并在每次打开后收紧到 0600。
已有 logs 目录的权限保持原样；home/logs 的 symlink、日志 symlink 与非普通文件拒绝写入。
文件始终以 `O_APPEND` 打开，不截断；同进程所有实例共用按路径串行队列。
**轮转未启用，大小阈值无（不限制单文件大小）**；插件不会改写或清空历史记录。

每行固定包含 `ts`（ISO）、`action`、`sessionId`、`stage`、`result`、`reason`。
成功且无原因时 `reason: null`，清空汇总 `sessionId: null`。

| action | stage / result |
| --- | --- |
| `trashSession` / `restoreSession` | 每次调用一条 `complete`，成功 `ok`，失败 `failed` 并保留原因 |
| `removeFromTrash` | purge 阶段 + 一条 `complete` 结果，包括门禁/依赖失败 |
| `emptyTrash` | 每条会话的 purge 阶段与 `complete`，以及一条 `summary`；原因包含成功/失败数，空列表也有汇总 |
| `recovery` | 每条待恢复凭据的阶段与 `recovery` 结果；成功 `deleted` / `unmoved`，失败 `failed` |

purge 成功阶段覆盖 `gate/locked/recheck/intent/renamed/unlocked/logs-deleted/delete-staged/detach/unarchive/marker/projection`；
工作区 detach 每次实际尝试各记一条，不为非成员或零归属伪造 detach 行；日志行数不固定。
失败按实际阶段记录，缓存清理失败为 `projection/warning`。
每条追加尝试都会等待完成；rename 事件在测试 SIGKILL 前已写出。日志不是业务提交凭据，
也没有断电级 fsync 保证。任意定位、创建、打开、追加、关闭失败均不改变主操作结果，
只降级 `ctx.logger.info`，携带原记录与 `logError`；降级 logger 自身抛错也会吞掉，后续记录仍可重试。
Client 不展示操作日志，`listTrash` 读取/对账不额外写操作记录。

将下面路径替换为 stat 反推的实际 home，即可直接查看（无需桌面 stdout）：

```sh
tail -f '/实际的 DSH home/logs/trash.log'
cat '/实际的 DSH home/logs/trash.log'
```

## Client 入口、面板与共享投影

惰性 ModuleLoader 工厂仅从浏览器模块表获取 React，Remote contribution/codecs 在构建时内联。

| Slot | 身份 | order | 用途 |
| --- | --- | --- | --- |
| `sidebar.workspaces.session.menu.item` | id=`trash-menu` | 350 | 收进菜单项 |
| `sidebar.workspaces.session.row.action` | id=`trash-action` | 50 | hover 垃圾桶、Tooltip、aria-label |
| `sidebar.panellist` | id=`trash` | 40 | 回收站图标，label 为读取当前 locale 的 thunk |
| `main` | key=`trash` | — | 全局列表、恢复、物理删除、清空、内联确认、空/加载/错误态 |

入口 id 与 main key 配对，由 sidebar owner 导航。菜单项位于原生 Archive 之前，
hover 的 50 位于原生 Archive 100/Pin 200 之前，不替换内置条目。
文案以 `locale/en.json`、`locale/zh.json` 为唯一源，`client-copy.ts` 直接复用并推导类型，构建时内联；
移除未使用的 `trash.title` 别名，保留 `meta.title` 和 UI `panelTitle`。样式用 `--dsw-alias-*` token；字典、订阅、读取流和 Tooltip 资源随生命周期清理。

Client 先 `await ctx.remote.$mount(contribution)`，再 `ctx.get('remote.trash')` 取 namespace。
不要在挂载前 inject 自己的 `remote.trash`（会等不到 apply），也不要通过未声明的
`ctx.remote.trash` 属性访问（Cordis 会拒绝）。生成方法直接调用采用位置参数，如
`trash.trashSession(sessionId)`；Gateway 再编码为 wire `args: { sessionId }`。
五个方法返回 `RemoteResult<T>`，UI 显式检查 `ok`。

菜单、hover 与所有面板共用 `trashStore` 和同一写入层：发起时登记递增序号，
响应在 Client 包装为携带原票据的结果。每 session 的最新序号与 empty 的全局边界共同判旧；
旧响应不执行 upsert/remove/clear，而是重拉 Host `listTrash`。迟到 empty 也不能清除后来收进的条目。
这是单个 Client bundle 内的操作顺序，不是 Host 提交 revision 或跨 Client 同步协议。
读取仍有请求 token、基线和期间已接受变更的重放保护。

列表按收进时间倒序，标题按 `titleSnapshot` → Session catalog title/displayTitle → 短 id 兜底。
所属工作区按 `useWorkspaces().items[].sessionIds` 查当前 `title`，重命名或归属改变随快照更新；
无归属显示「无所属工作区 / No workspace」，不拿历史 `workspaceId` 当显示名。
普通条目每次渲染再与 `archivedSessionIds` 求交集；带 `purgePending` 的待清理记录独立保留、禁用恢复并提示重试。UI 过滤只改投影，不写 Host marker 表。

## Workspace 同步边界

第二轮评审废弃 `uiWorkspace.archiveSession` unary echo：它会再次写 Host，迟到时能覆盖已经成功的恢复。
现在收进、恢复、删除、清空和面板读取统一使用**只读**路径：

1. `remote.workspace.follow(signal)` 读取新流的首个 `baseline`，其归档/置顶集合直接取自 Registry。
2. 在 `workspaces.list` 上调用已核实的 model `replaceArchived/replacePinned`，仅安装变化的集合。
3. 中止并关闭该读取流。新操作或投影变化会使在途基线失效，旧基线丢弃后重读。
4. 订阅 model；迟到的原生 follow 若再次改变归档/置顶投影，就重新读取权威基线修正。

因此不会为了同步视图再次调用业务 archive/unarchive；无增量 follow 时两个方向也能更新，
迟到帧最终按权威读取收敛。原生 UI 对 Workspace snapshot 的订阅负责隐藏归档及清理当前视图。
不保证不同通道间瞬间无闪烁。显式刷新失败向调用 UI 报错；后台刷新失败在下一帧、动作或手动刷新重试。
只读首帧仍需要可用的 Workspace follow endpoint 及读取权限。

此能力依据安装版 DSH **0.2.2-rc.5** 源码：`WorkspaceController.list = model`，
`ClientWorkspaceModel.replaceArchived/replacePinned`，以及 `WorkspaceFeed.baseline/follow`。
服务 facade 的 `WorkspaceSource` 类型只承诺读取/订阅，本插件对实际 model 方法做能力检查；
没有从内部 Client 包运行时 require，也没有改 DSH 核心。升级 DSH 后需重新核实这个版本边界。

## 构建和验证

`npm run build`（或 `pnpm build`）依次运行 TypeScript、Typert 生成器和 Client 打包。
生成器在临时目录读取精确版本依赖源码，不修改依赖或链接。

`npm test` 覆盖 Host 操作/补偿/串行化、Remote codecs、共享面板、响应倒序、文案及资源清理，
以及合成临时 home 上的真实 flock/rename/rm、外部锁竞争、SIGKILL 后恢复、失败重试和 restore 回归。
`npm run test:discovery` 需设置 `DSH_NODE_EXECUTABLE` 为安装版 Electron 可执行文件的绝对路径，
`DSH_INSTALL_DIR` 为安装版 `@deepseek-ai/dsh` 包目录；使用安装版 Electron，覆盖 resolver、Loader、Gateway 注入与实际 slot RPC，
并运行真实 Registry、DomainFacility、WorkspaceFeed、ClientWorkspaceModel 的隔离交错复现。
旧协议/UI回归明确使用 `legacy-purge-seam.cjs` 隔离文件 I/O；第 4 期文件系统套件不替换锁/rename/rm，
只替换 persistence stat 的合成元数据、工作区服务与故障时机，Domain 使用真实 facility 与临时文件介质。
同一套 37 个文件系统场景（原 34 + 定向 detach/无归属/多归属失败重试 3 项）也由 discovery 在安装版 Electron 下执行；
另以安装版 WorkspaceEntity 核对只清实际成员的持久记录。夹具默认删除环境变量 `DSH_HOME`；
覆盖无变量时删除日志和投影、错误变量不重定向删除/恢复/投影，以及层级过深/过浅和各级 symlink 拒绝。
SIGKILL 回归按真实两层目录枚举规则验证重启前后残留不可发现、其它会话仍可见；
另有点目录正向对照、非法 intent/recovery 拒绝及无凭据暂存保留断言。trash transport 不直接修改 Client 归档集合。
这不等同于真实 React renderer 或真实 profile GUI 验收。

另外 21 个持久化日志场景在 `npm test` 和 discovery 中各运行一次：成功/失败 JSONL、权限、
全部 purge 成功阶段及逐阶段失败、empty 逐条/汇总、无 source 的 recovery 成败、写入与降级 logger 同时失败、
队列失败后重试、symlink 拒绝、无可靠 home 降级，以及跨 Host 操作/多个 logger 实例/两个子进程并发追加。
全部 37 个文件系统场景也逐条核对 Host report 已落盘，SIGKILL 回归额外核对 `renamed` 记录仍在磁盘。

公开包身份为 `d-trash@0.1.0`，MIT，目标仓库 `HLhhh/d-trash`；版本不对应期号。locale 的 `meta.detail` 指向此文档，packed 文件包含 PLAN、
docs、双语 README、LICENSE、CHANGELOG、locale、icon、patch 和运行产物；`dist/` 随仓库提交，`CODEX_*.md` 仅本地保留。
Cordis peer 为 `^4.1.0`，DSH peers 为 `^0.2.2-rc.5`，node-addon-system peer 为 `^0.1.2`；开发依赖保持精确，
Node 要求 `^22.19.0 || >=24.0.0`。这些声明区间不代表后续 DSH 版本已验证。Client id 复用 manifest 生成的 contribution.package；测试和夹具读取 manifest.name。
安装和使用见 [English README](../README.md) / [中文 README](../README_zh.md)。`profile-boot.cjs` 是历史只读真实 profile 诊断入口，不在默认测试链；
本次只同步其包身份并做语法检查，不运行真实 profile boot。开源整理的隔离验收结果见 [PLAN](../PLAN.md)；详细输出保留于本地 CODEX 报告，不随仓库或包分发。
