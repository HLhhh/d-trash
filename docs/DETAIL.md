# d-trash — 第 1–4 期（会话回收站与物理删除）

第 1–4 期已交付。收进保留日志并归档；普通恢复不变；彻底删除与清空现为物理删除本地会话日志、不可恢复。
方案以随包提供的 `PLAN.md` 为准。既有真机入口和第 4 期两个会话的清理验收已通过（用户既有记录）；
本次开源整理仅运行隔离回归，未安装、重载或修改真实 profile，未操作真实会话。

## Host 协议与状态

`TrashService extends TypertRemoteService` 声明 `typert`、`storageDomain`、`workspaceRegistry`、`sessionPersistence`
依赖。在首次请求（含 apply 后后台扫描）时打开并共享 `trash` domain（version 1），打开失败后允许重试；
卸载先等待已接纳操作，再关闭 domain。持久化由宿主 storage backend 负责。

**可观测回收站 `trash = marker ∩ archived`。** marker 表与原生归档集合分别持久化；
原生取消归档不经过插件锁，之后的 marker 允许短暂滞留，由 `listTrash` 对账清理。
第二轮评审 B1 因此废弃了「持久 marker 永远指向已归档会话」的严格不变量。
插件不拦截、不修改原生归档/取消归档/置顶按钮或行为。

| 方法 | 行为 | Host 返回值 |
| --- | --- | --- |
| `trashSession(sessionId)` | 先原生归档（`stopActivity: true`），写 marker 前后均校验归档；发现原生取消归档则删 marker 并抛错 | `Promise<void>` |
| `restoreSession(sessionId)` | 排队项只移除 deferredAt、保留归档/普通 marker；普通项先删 marker 再取消归档，失败且仍归档时才补回 | `Promise<void>` |
| `removeFromTrash(sessionId)` | 门禁后持锁整体迁移、关锁、删除日志，再清归属/归档/marker/投影缓存 | `Promise<boolean>`（成功 true；lock-busy 排队抛 `[D_TRASH_DEFERRED]`，其它错误带阶段） |
| `emptyTrash()` | 全局边界内逐条物理删除，分别汇总删除/排队/失败数与阶段 | `Promise<number>`（全成功返回删除数；纯排队抛 DeferredError，真失败抛 AggregateError） |
| `listTrash()` | 对账普通 stale marker；保留 purge 凭据，返回不含私有路径的记录副本与可选 purgePending/deferred | `Promise<Array<[SessionId, TrashRecord]>>` |

marker 包含 `trashedAt`，schema 保留可选 `workspaceId`、`titleSnapshot`；私有 `deferredAt` 表示锁忙后排队，独立于 purge 凭据。
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
`src/purge.ts` 使用 `src/write-lease.ts` 的 backend 兼容写租约：POSIX 保留官方
`@deepseek-ai/node-addon-system/flock`，以 O_NOFOLLOW 打开既有普通锁文件，不创建/截断/unlink；
Windows 只加载 Koffi 3.1.1，以 `Local\dsh-session-lock-<sha256(resolve(lockPath).toLowerCase())>`
命名的 count-1 内核信号量与 JSONL backend 写者互斥，不需要 `session.lock`，也不加载 POSIX addon。
locate 和审计日志不依赖锁文件；日志存在时，任何平台缺少可靠互斥、匹配 JSONL stat/header/绝对 path 或文件身份时拒绝删除。
安装版 Electron 44.7.0 / Node 24.21.0 直接 import 官方 `src/lease.ts` 实测失败：
`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`，所以使用等价协议，没有运行时 TS 转译兜底。
官方 POSIX lease 的 `open('w')` 会截断但不 unlink；本插件采用更严格的既有文件 open。
从 `stat().location.path` 向上依次得到会话目录、slug、sessions 根、DSH home；
根名必须为 `sessions`，home、根与日志/会话路径必须通过 realpath 校验，限定两层会话目录并禁止 symlink。
不读取环境变量 `DSH_HOME`，缺失或错误值都不影响定位；下文 `$DSH_HOME` 均指反推并校验的 home。
取锁后及 intent 持久化后重复 stat/realpath/dev/ino 校验。原目录名只由 stat 提供，不自行编码推导。

无 purge 凭据时，首次定位严格区分三种结果：

- `stat(id) === undefined`：按 persistence 契约确认日志已不存在；在 stat 前后检查 marker 存在且仍归档，跳过锁、intent、rename、rm，只走 detach 当前所属工作区 → unarchive → 删 marker → 尝试清投影缓存。成功返回 `true`，empty 计成功一项；以 `logs-absent/ok` 写明「stat 返回 undefined、日志已不存在、只清记录」，不伪造 `logs-deleted`。
- 返回 snapshot 但 header.id 不匹配、非 JSONL、路径非绝对或 location 缺失：仍在 gate 拒绝，保留记录与日志；可靠 snapshot 对应的文件系统校验失败（包括 ENOENT）也不等同于 stat 返回 undefined。
- stat 抛错：保留错误与 cause，在 gate 拒绝，绝不把 I/O 故障或抛出的 ENOENT 转为「已删除」。取锁后/intent 后复核时的 undefined 仍拒绝，不切换幽灵分支。

该分支处理客户端陈旧列表将已成功物理删除的 id 再次收进造成的幽灵记录。已有 purge 凭据优先执行原恢复协议，非法凭据不能借 undefined 绕过校验。幽灵记录不生成虚构 source/target 或删除凭据；detach 等必要记录清理失败仍按实际阶段报告，普通 marker 仍遵守归档交集/对账规则。可重试时再次执行 stat 与归档门禁，不承诺幽灵清理的跨服务事务。
Host 缓存由 stat/source 校验过的 home，供后续幽灵记录的投影清理复用；重启后可从其它可靠会话/凭据定位。清投影仍重新校验 canonical home/cache 路径；没有可靠 home 时仅 `projection/warning`，不从环境变量或 session id 猜路径，日志依既有规则降级 logger。

执行顺序是写租约 → 复核 → marker 保存 purge intent → 最后复核 → 整体 rename 到
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
有凭据的投影清理接收 `deleteStaged` 返回的已验证 home；幽灵分支使用上述已验证 home，均不从环境变量取路径。
原生写入与插件不是一个事务；全局插件边界覆盖恢复/删除/清空，不能阻止原生取消归档或重建路径。

失败用 `Physical deletion [stage] (id): reason` 报告，结构化日志包含 sessionId/stage/result/reason。
取写租约遇到占用时，Host `PurgeError.code` 为 `D_TRASH_SESSION_LOCK_BUSY`，消息以精确前缀
`[D_TRASH_SESSION_LOCK_BUSY] ` 开头。Host 仅对无 purge、仍归档的 lock-busy 持久排队，返回 `[D_TRASH_DEFERRED] ` 确认；底层阶段、id、busy 原因与 cause 保留。其它阶段的 EBUSY 不排队，排队写入失败报告 deferred 阶段真失败。
Client 精确识别排队前缀并显示中英「已排队」status，关闭确认框；不模糊匹配 busy/lock 文本。混合 empty 的真失败仍报错，消息分别含 deleted/failed/queued 数，AggregateError.errors 只含真失败；纯排队使用 DeferredError，全成功返回删除数。
`emptyTrash` 尝试全部条目，失败汇总成功数与阶段。Client 对失败也重读列表和只读 Workspace 投影，
显示部分成功和可重试的诊断条目。投影缓存失败只记录警告，此时 marker 可能已清除，不保证后续 purge 自动重试缓存。搜索索引依赖下一次稳定搜索观测时的现有同步收敛；已检查的 query API 没有公开 rescan，不调用私有 `_reconcile` 或直接编辑 SQLite。
附件、工作区文件、worktree、产物、服务端日志、备份及其它插件扫描快照均保留；不承诺安全擦除或搜索立即消失。
仅覆盖 JSONL 与进程崩溃，不声称断电事务；有 pending 凭据时不要降级旧版插件。

## 排队与启动自动删除（方案 A）

已加载/已 enter 的会话可能长期由 DSH 持有官方写租约；用户既有真机调查显示 `session.lock` 存在写句柄，官方没有供插件释放其它所有者句柄的公开 unload/close API。
旧的「重启后只能手动再删」方案已废弃。remove/empty 在初次 move 的 lock 阶段 busy 后，只写 marker 的 `deferredAt`（重复 busy 保留首次时间），
不动会话日志/归档/工作区归属、不写 purge 凭据；Remote 列表仅暴露 `deferred: true`，仍属于普通 marker ∩ archived，原生取消归档后的 stale marker 仍由 list 对账。

Cordis class-plugin `[Service.init]` 在构造/apply 后投递 0ms unref timer 并立即返回。Host 取所有排队项快照，
逐项进入插件全局边界并重读 marker，调用原 `purgeSession`，完整保留 stat/realpath/dev/ino、官方写租约、intent/最终复核/rename/close/rm 门禁。
成功后正常清日志/成员/归档/marker、尝试清投影；仍 busy 则保留到下次启动，本 Host 不轮询追锁；可手动再次彻底删除。
服务/domain 或尚未开始删除的其它阶段失败按实际阶段记录，后台按 1/2/4/…/30 秒退避重试；扫描异常不会拒绝初始化。
卸载取消 timer，等待已接纳的维护操作后关 domain；依赖撤回时保守保留状态。此机制不保证抢在原生加载前完成，更不会强制删当前忙会话。

真正写 purge intent 时移除 deferredAt；已有 purge 凭据不参与排队扫描，继续只由显式 purge/empty 恢复，不改变原校验语义。
启动中其它阶段失败一旦留下 purge 凭据，就由既有恢复协议处理；list/restore/re-trash 不能丢凭据。
面板显示「待删除（重启 DSH 后自动完成）」/“Pending deletion (automatically completes after restarting DSH)”。
排队项点「恢复」只取消 deferredAt，保留普通 marker、归档、日志和归属；再次恢复走普通取消归档。删除按钮保留手动重试。

绝不绕过写锁、不 unlink 活锁文件、不夺锁、不调用私有卸载接口。本轮只使用合成临时 home，未修改核心/profile 或操作真实会话；既有真机调查不作为本轮 GUI 复验。

## 持久化操作日志

Host 将操作记录追加到 **`$DSH_HOME/logs/trash.log`**（UTF-8 JSONL，一行一个 JSON）。
这里的 home 由 `src/purge.ts` 共用的 stat 路径/realpath 校验反推，**不读取环境变量**。
每个 Host 实例首次定位后缓存该 home，在 purge 移走 source 前预先定位；重启后可从已打开 marker 内
原 stat 写入的 `purge.source` 重新推导。目标会话不存在或清空列表为空时，尝试其它 marker 凭据，
再由 `sessionPersistence.list()` 获取候选 id 并重新 `stat` 校验，不从 id 拼原目录。
若没有任何可靠 stat/凭据（例如全新空 home 的首次调用），无法安全确定日志路径，此次降级到 logger。

POSIX 目录不存在则以 **0700** 创建；日志文件以 **0600** 创建并在每次打开后收紧到 0600。Windows 不承诺 POSIX mode 位等价于 ACL。
已有 logs 目录的权限保持原样；home/logs 的 symlink、日志 symlink 与非普通文件拒绝写入。
文件始终以 `O_APPEND` 打开，不截断；同进程所有实例共用按路径串行队列。
轮转策略固定为 `src/operation-log.ts` 的 **`MAX_BYTES = 4 * 1024 * 1024`（4 MiB）、`KEEP = 3`**，不读取环境变量。
每次追加前在同一按路径队列内检查：当前文件**严格大于** 4 MiB 时，先删除最旧的 `trash.log.3`，
再逆序 `trash.log.2 → .3`、`.1 → .2`、`trash.log → .1`，最后新建 0600 的 `trash.log`，先写轮转记录再写业务记录。
刚好 4 MiB 不轮转；使其超限的完整一行保留在原文件，下一次追加才触发。最多保留活动文件加三份归档，
约 16 MiB 历史，**不是硬容量上限**：单条大记录、并发旧句柄和失败会使文件超限。
除了 KEEP 明确淘汰的最旧一份，轮转只改名，不截断、复制或重写已有行；保留窗口内每行仍可在活动文件或 `.1`–`.3` 找到。

轮转使用临时目录 `logs/trash.log.rotate` 的排他创建避免协作进程同时移动并覆盖归档，追加不持有这个 guard。
竞争时最多等待约 480 ms 后降级 logger；不抢占 guard。进程在轮转中崩溃可能留下 guard，后续超限追加仍会重试并降级，
需在确认所有写者均已停止后人工移除残留 guard；不自动猜测它是否失效。这不是跨进程强一致或崩溃原子轮转。
另一个实例若已持有旧文件句柄，rename 后仍可能把完整行写进已轮转文件，**不因 rename 丢行，但 `.1` 会偏大**；
继续轮转后文件序号还会变化，最终仍受 KEEP 淘汰。轮转中失败可留下已完成的改名，不做危险回滚。
活动文件与所有待轮转路径均拒绝 symlink/非普通文件；归档路径会在任何改名或淘汰前全部检查。

每行固定包含 `ts`（ISO）、`action`、`sessionId`、`stage`、`result`、`reason`。
成功且无原因时 `reason: null`，清空汇总 `sessionId: null`。

| action | stage / result |
| --- | --- |
| `trashSession` / `restoreSession` | 每次调用一条 `complete`，成功 `ok`，失败 `failed` 并保留原因 |
| `removeFromTrash` | purge 阶段 + 一条 `complete` 结果，包括门禁/依赖失败 |
| `emptyTrash` | 每条会话的 purge 阶段与 `complete`，以及一条 `summary`；原因包含删除/失败/排队数，空列表也有汇总 |
| `startup` | 每个排队条目的 purge 阶段与 complete（ok/deferred/failed）；扫描依赖失败为 scan/failed |
| `recovery` | 每条待恢复凭据的阶段与 `recovery` 结果；成功 `deleted` / `unmoved`，失败 `failed` |
| `log-rotate` | 成功 `complete/ok`；`reason` 含文件序号、保留范围、实际淘汰文件或 none 和阈值；失败按实际步骤（含序号）降级 logger |

purge 成功阶段覆盖 `gate/locked/recheck/intent/renamed/unlocked/logs-deleted/delete-staged/detach/unarchive/marker/projection`，幽灵记录使用独立的 `logs-absent`；
工作区 detach 每次实际尝试各记一条，不为非成员或零归属伪造 detach 行；日志行数不固定。
`unlocked/ok` 仅在真正取得租约且 `release()` 成功后写入；取锁失败不产生 `locked` 或 `unlocked` 行。
lock-busy 排队路径为 `gate/ok → lock/failed → deferred/ok → complete/deferred`，deferred 的 reason 含 busy 原因；排队写入失败则 `deferred/failed → complete/failed`，正常成功的 `renamed → unlocked → logs-deleted` 顺序不变。
失败按实际阶段记录，缓存清理失败为 `projection/warning`。
每条追加尝试都会等待完成；rename 事件在测试 SIGKILL 前已写出。日志不是业务提交凭据，
也没有断电级 fsync 保证。任意定位、轮转、创建、打开、追加、关闭失败均不改变主操作结果，
只降级 `ctx.logger.info`，携带原记录与 `logError`；降级 logger 自身抛错也会吞掉，后续记录仍可重试。轮转失败时轮转记录与原业务记录分别降级；不把业务成功改为失败，也不替换原业务异常。磁盘失败仍不承诺每条落盘。
Client 不展示操作日志，`listTrash` 读取/对账不额外写操作记录。

将下面路径替换为 stat 反推的实际 home，即可直接查看（无需桌面 stdout）：

```sh
tail -F '/实际的 DSH home/logs/trash.log'
grep -h '"result":"failed"' '/实际的 DSH home/logs/trash.log' '/实际的 DSH home/logs/trash.log.'[123]
grep -h '"action":"log-rotate"' '/实际的 DSH home/logs/trash.log' '/实际的 DSH home/logs/trash.log.'[123]
cat '/实际的 DSH home/logs/trash.log.3' '/实际的 DSH home/logs/trash.log.2' '/实际的 DSH home/logs/trash.log.1' '/实际的 DSH home/logs/trash.log'
```

`tail -F` 按文件名跟随轮转；归档尚未生成时，grep/cat 对不存在路径会提示错误。旧句柄迟到行可能使按文件序号拼接的结果不严格按时间排序。

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
排队条目显示 deferred 文案，恢复只取消排队；普通条目每次渲染再与 `archivedSessionIds` 求交集；带 `purgePending` 的待清理记录独立保留、禁用恢复并提示重试。UI 过滤只改投影，不写 Host marker 表。

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

此能力依据安装版 rc.5 以及 npm pack 获取的 DSH **0.2.2-rc.2 / rc.5** 源码：`WorkspaceController.list = model`，
`ClientWorkspaceModel.replaceArchived/replacePinned`，以及 `WorkspaceFeed.baseline/follow`。
服务 facade 的 `WorkspaceSource` 类型只承诺读取/订阅，本插件对实际 model 方法做能力检查；
没有从内部 Client 包运行时 require，也没有改 DSH 核心。升级 DSH 后需重新核实这个版本边界。

## 构建和验证

`npm run build`（或 `pnpm build`）依次运行 TypeScript、Typert 生成器和 Client 打包。
生成器在临时目录读取精确版本依赖源码，不修改依赖或链接。

新增 13 项 `deferred-regressions.mjs`（Node 与 discovery 均执行）覆盖真实锁排队/时间与 inode 保留、重启完成/仍忙、恢复取消、非 lock EBUSY、purge 凭据优先、empty 混合汇总、排队落盘失败、真实 Cordis init、stat/domain 就绪重试及卸载。Client 另验证双语行/status、精确前缀、RemoteResult/transport 与取消排队保留行。

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

另外 29 个持久化日志场景在 `npm test` 和 discovery 中各运行一次：成功/失败 JSONL、权限、
全部 purge 成功阶段及逐阶段失败、empty 逐条/汇总、无 source 的 recovery 成败、写入与降级 logger 同时失败、
队列失败后重试、symlink 拒绝、无可靠 home 降级，以及跨 Host 操作/多个 logger 实例/两个子进程并发追加。
新增 8 项使用实际 4 MiB 阈值验证边界与下一次追加轮转、KEEP 淘汰、逐行完整保留、归档 symlink 拒绝、
轮转失败与建新文件失败不改变业务结果及重试、guard 忙时降级、两个子进程加四实例并发轮转逐行核对，以及跨进程旧句柄迟到写入 `.1`。
全部 37 个文件系统场景也逐条核对 Host report 已落盘，SIGKILL 回归额外核对 `renamed` 记录仍在磁盘。

公开包身份为 `d-trash@0.1.0`，MIT，目标仓库 `HLhhh/d-trash`；版本不对应期号。locale 的 `meta.detail` 指向此文档，packed 文件包含 PLAN、
docs、双语 README、LICENSE、CHANGELOG、locale、icon、patch 和运行产物；`dist/` 随仓库提交，`CODEX_*.md` 仅本地保留。
Cordis peer 为 `^4.1.0`，DSH peers 为 `^0.2.2-rc.2`，node-addon-system peer 为 `^0.1.2`；开发依赖保持精确，
Node 要求 `^22.19.0 || >=24.0.0`。这些声明区间不代表后续 DSH 版本已验证。Client id 复用 manifest 生成的 contribution.package；测试和夹具读取 manifest.name。
安装和使用见 [English README](../README.md) / [中文 README](../README_zh.md)。`profile-boot.cjs` 是历史只读真实 profile 诊断入口，不在默认测试链；
本次只同步其包身份并做语法检查，不运行真实 profile boot。开源整理的隔离验收结果见 [PLAN](../PLAN.md)；详细输出保留于本地 CODEX 报告，不随仓库或包分发。


## 平台与版本兼容 — 2026-11-23

rc.2/rc.5 的 persistence stat/list/location、JSONL lease/win32、WorkspaceRegistry archive/unarchive/归档集合、
Workspace.sessionIds/detachSession、storage-domain defineDomain/domainTable/Domain.table、Typert Remote 和生成协议，
以及 ClientWorkspaceModel、WorkspaceFeed、Session catalog 源码均一致。两版的真实 npm 包分别完成隔离 tsc、
Typert、Client 打包、完整 smoke、原生 lease 互斥及 feed/model 探针；其它传递依赖复用开发树，非完整旧版 Desktop。
rc.5 仅在 Workspace UI 新增 picker factory、Sidebar 新增 sidebar.session.action 等 UI；本插件四个 slot 契约无变。
Client 运行时显式检查 model 的读/订阅/replace 方法及 remote.follow；缺少能力直接失败，不发起第二次归档业务写作为兜底。
rc.5 安装版 Electron discovery 通过；本轮没有 rc.2 Desktop GUI、Windows 或真实会话验收。

Windows 的信号量与 backend 的命名、FFI 签名、0 超时、释放顺序相同；不使用插件私有目录锁。
暂存恢复同时检查原路径和暂存路径的信号量，因为 rename 不会改变内核对象名。
命名信号量在同一个 Windows 登录会话（Local namespace）内互斥，崩溃后最后一个句柄关闭才销毁，
没有超时抢锁；与官方相同，不提供跨登录会话的排他，也不能阻止释放后原生重建 source。
POSIX 的 inode 锁随 rename 移动，Windows 的路径名锁留在原路径；因此两者的命名模型不同，
但对各平台 backend 写者的排他协议相同，不宣称跨进程维护事务。

Windows rename 对 EBUSY/EPERM/EACCES/ENOTEMPTY 最多 5 次，每次重试重新验证 stat、dev/ino、
canonical path、租约、归档门禁和 target 不存在；不覆盖冲突目标，不跨卷复制。rm 有界重试并复核暂存身份；
耗尽重试保留 intent/deleting，供下次 purge/empty 恢复。Windows 使用 realpath/lstat 与非零 ino 验证，
不依赖 O_NOFOLLOW 支持；POSIX 继续使用 O_NOFOLLOW。盘符/路径大小写可比对，junction/symlink 仍拒绝。

测试通过数和 SKIP 分开输出。Windows 跳过原 POSIX symlink/O_NOFOLLOW、缺锁拒绝、SIGKILL 场景和 mode 位断言，
另跑无锁文件、命名信号量竞争/大小写、终止进程释放、junction 拒绝、rename/rm 重试及审计用例。
macOS 跳过明确要求 Windows 的 6 项，不把注入错误的策略单元测试当作 Windows 原生验收。

<a id="windows-self-check"></a>
## Windows self-check

在 checkout 中使用 PowerShell，Node 需满足 package.json engines。命令只运行合成临时 home，
不需要安装插件、不操作真实会话。npm ci 仅安装本项目依赖。

```powershell
npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'build failed' }
npm test 2>&1 | Tee-Object platform-test.log
if ($LASTEXITCODE -ne 0) { throw 'tests failed; return platform-test.log' }
npm run test:discovery 2>&1 | Tee-Object platform-discovery.log
if ($LASTEXITCODE -ne 0) { throw 'discovery failed; return platform-discovery.log' }
npm pack --dry-run --json
if ($LASTEXITCODE -ne 0) { throw 'pack failed' }
```

预期 build 输出 Typert / Client generated/bundled；npm test 输出平台 10 passed/0 skipped、phase4 27 passed/10 skipped、
日志 27 passed/3 skipped（每个 SKIP 带 POSIX 原因），幽灵记录 18 passed/0 skipped、排队 13 passed/0 skipped，其余 Host/Client/生成器通过，退出码 0。
无安装版变量时 discovery 明确输出 SKIP，不算 discovery 通过。若已安装 DSH，可仅设置以下两个路径再运行；
runner 负责 ELECTRON_RUN_AS_NODE、等待 GUI 子系统 Electron 退出和转发输出，无需修改 profile：

```powershell
$env:DSH_NODE_EXECUTABLE = 'C:\实际安装路径\DeepSeek Harness.exe'
$env:DSH_INSTALL_DIR = 'C:\实际安装路径\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh'
npm run test:discovery 2>&1 | Tee-Object platform-discovery.log
if ($LASTEXITCODE -ne 0) { throw 'discovery failed' }
```

有效 discovery 应输出 runtime 中的 electron/node/dsh、official-lease-import 的明确结果，
official-lease-mutual-exclusion 的 bothDirections/reacquire=true、四个 slot/Gateway 证据和最终 PASS，
不能只有 SKIP。pack 应列出 d-trash、dist/write-lease.js、dist/fs-retry.js 与所需资源，无 CODEX 报告。
失败时回传两份 platform 日志、命令退出码、node --version、npm --version、Windows 版本与 CPU 架构；
不要回传真实会话内容。保留失败原文；不跳过锁竞争/路径门禁来获得绿色结果。
