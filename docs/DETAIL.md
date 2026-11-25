# d-trash — 会话回收站、系统回收站与提炼（第 5.3 期）

第 1–4 期及 5.2 / 5.3 已交付（5.3 为隔离验收）。收进保留日志并归档；普通恢复不变；单条移出与清空均将日志目录移入系统回收站，可在系统层面恢复。第 4 期「staging→rm、不可恢复」终态**已废弃**。
方案以随包提供的 `PLAN.md` 为准。既有真机入口和第 4 期两个会话的清理验收已通过（用户既有记录）；
本次开源整理仅运行隔离回归，未安装、重载或修改真实 profile，未操作真实会话。

## Host 协议与状态

`TrashService extends TypertRemoteService` 声明 `typert`、`storageDomain`、`workspaceRegistry`、`sessionPersistence`
依赖。在首次请求（含 apply 后后台扫描）时打开并共享 `trash` domain（version 1），打开失败后允许重试；
卸载先取消提炼及 timer，等待已接纳操作收敛，再关闭 domain。持久化由宿主 storage backend 负责。

**可观测回收站 `trash = marker ∩ archived`。** marker 表与原生归档集合分别持久化；
原生取消归档不经过插件锁，之后的 marker 允许短暂滞留，由 `listTrash` 对账清理。
第二轮评审 B1 因此废弃了「持久 marker 永远指向已归档会话」的严格不变量。
插件不拦截、不修改原生归档/取消归档/置顶按钮或行为。

| 方法 | 行为 | Host 返回值 |
| --- | --- | --- |
| `trashSession(sessionId)` | 先原生归档（`stopActivity: true`），写 marker 前后均校验归档；发现原生取消归档则删 marker 并抛错 | `Promise<void>` |
| `restoreSession(sessionId)` | 排队项只移除 deferredAt、保留归档/普通 marker；普通项先删 marker 再取消归档，失败且仍归档时才补回 | `Promise<void>` |
| `removeFromTrash(sessionId)` | 门禁后持锁整体移入系统回收站、确认源不在、关锁，再清归属/归档/marker/投影缓存 | `Promise<boolean>`（成功 true；lock-busy 排队抛 `[D_TRASH_DEFERRED]`，其它错误带阶段） |
| `emptyTrash()` | 全局边界内逐条移入系统回收站，分别汇总删除/排队/失败数与阶段 | `Promise<number>`（全成功返回删除数；纯排队抛 DeferredError，真失败抛 AggregateError） |
| `listDistillAgents()` | 读取宿主非 broken preset 的 id/name，并提供明确手动导出项 | `Promise<DistillAgentPreset[]>` |
| `distillSession(sessionId, agentPresetId)` | 只读源会话；独立任务执行/手动提示词导出，按 id 串行 | `Promise<DistillResult>`（path/summary/mode） |
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

## 移入系统回收站与失败恢复

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

- `stat(id) === undefined`：按 persistence 契约确认日志已不存在；在 stat 前后检查 marker 存在且仍归档，跳过锁、intent、rename、rm，只走 detach 当前所属工作区 → unarchive → 删 marker → 尝试清投影缓存。成功返回 `true`，empty 计成功一项；以 `logs-absent/ok` 写明「stat 返回 undefined、日志已不存在、只清记录」，不伪造 `moved-to-trash`。
- 返回 snapshot 但 header.id 不匹配、非 JSONL、路径非绝对或 location 缺失：仍在 gate 拒绝，保留记录与日志；可靠 snapshot 对应的文件系统校验失败（包括 ENOENT）也不等同于 stat 返回 undefined。
- stat 抛错：保留错误与 cause，在 gate 拒绝，绝不把 I/O 故障或抛出的 ENOENT 转为「已删除」。取锁后/intent 后复核时的 undefined 仍拒绝，不切换幽灵分支。

该分支处理客户端陈旧列表将已移走日志的 id 再次收进造成的幽灵记录。已有 purge 凭据优先执行原恢复协议，非法凭据不能借 undefined 绕过校验。幽灵记录不生成虚构 source/target 或删除凭据；detach 等必要记录清理失败仍按实际阶段报告，普通 marker 仍遵守归档交集/对账规则。可重试时再次执行 stat 与归档门禁，不承诺幽灵清理的跨服务事务。
Host 缓存由 stat/source 校验过的 home，供后续幽灵记录的投影清理复用；重启后可从其它可靠会话/凭据定位。清投影仍重新校验 canonical home/cache 路径；没有可靠 home 时仅 `projection/warning`，不从环境变量或 session id 猜路径，日志依既有规则降级 logger。

执行顺序：写租约 → 复核 → marker 保存 `moving: true / source / dev / ino` → 最终复核归档+marker、路径与租约 → 整体移入系统回收站 → 确认源目录不存在 → close 释放租约 → detach 当前所属工作区 → unarchive → 删 marker → best-effort removed 通知 → 尝试清投影缓存。
不在持锁期间 unlink 活锁文件；先确认日志已随目录离开，才清记录。detach 逐工作区检查当前成员关系并汇总实际失败，不调用无关工作区；重试跳过已完成的归属。旧 staging→close→递归 rm 流程**已废弃**，没有直接删除旁路。

### 平台机制

- **macOS**：校验用户 home 和 `~/.Trash` 的 canonical 路径及目录身份、比较 dev，直接 `renamex_np(RENAME_EXCL)` 到 `~/.Trash/d-trash-<uuid>`。RENAME_EXCL 原子拒绝任何已有目标，包括空目录。使用 POSIX 文件系统接口，不调用 Finder、osascript、Apple Events 或权限申请接口；访问被拒绝就报错，不引导或触发 Finder 自动化授权。不给「放回原处 / Put Back」元数据保证，恢复时可能需要手动移回原路径。SDK `sys/stdio.h` 的 RENAME_EXCL 为 `0x4`；本轮 ABI 测试只在注入的临时用户 home 下创建 `.Trash`，不访问真实用户废纸篓。
- **Windows**：Koffi 调用 `SHFileOperationW(FO_DELETE)`，固定 `FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT`，不调用 DeleteFile/rm。只传一条双 NUL 结尾 UTF-16 绝对路径，拒绝 UNC、通配符、嵌入 NUL、MAX_PATH 及挂载别名。先经 GetVolumePathNameW/GetDriveTypeW 确认固定本地卷、校验同卷 `$Recycle.Bin`，SHQueryRecycleBinW 成功后才调用 Shell；返回码非零或 `fAnyOperationsAborted` 均报错，保留 Shell 错误码及可读原因，不对该 API 使用 GetLastError。Win32 struct 按 shellapi.h pack(1)，Win64 自然对齐。系统负责回收站来源信息；恢复保留期限和回收站策略由 Windows 决定，5.2 Windows 真机验收尚未进行。
- **其它平台/跨卷**：明确拒绝。macOS 不改走其它卷的 `.Trashes`，Windows 不改走另一盘的 bin；不 copy、不直接删除、不降级绕过租约。Windows sharing 类错误最多重试 5 次，每次重新检查 stat、身份、租约和归档+marker 门禁；EXDEV 不重试。

原生依据：[Microsoft SHFileOperationW](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shfileoperationw)、[SHFILEOPSTRUCTW](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/ns-shellapi-shfileopstructw)、[官方 shellapi.h](https://github.com/microsoft/win32metadata/blob/main/generation/WinSDK/RecompiledIdlHeaders/um/shellapi.h)。FOF_ALLOWUNDO 为系统恢复路径，插件无法感知用户或系统何时清空回收站，不提供“不可恢复”承诺。

### intent / 崩溃恢复 / 旧凭据

新 intent 的 `moving: true` 表示“已开始移动”，并非系统已接收；目标名称由系统或实现分配，不入持久 schema，不依赖目标身份。
恢复先校验原 source 的 home/根路径：

- 源仍在：必须仍为同一 canonical 普通目录、dev/ino 相符；撤销未迁移 intent，重新调用时走完整归档+marker 门禁和写租约。移动失败保留凭据，list/restore/re-trash 不能丢弃；原生取消归档后仍拒绝重新移动。
- 源不在：视为已移走，继续记录清理；不要求定位或枚举系统回收站目标。即便原调用移动后、确认/审计前崩溃也按此恢复。用户已清空系统回收站也不阻塞清记录。
- 源被替换、路径不可靠或观察 I/O 错误：保留凭据诊断，拒绝猜测。intent 尚未写入就失败，不移动源。

旧 `target/dev/ino/deleting/logsDeleted` 凭据仍只接受同 home 的 `sessions.trash-purge-staging/<encoded-id>-…` 直属路径；旧根内暂存或任意其它目标保留诊断。原 source 存在且身份匹配、target 不在时撤销 intent；source 不在且 target 身份匹配时，持原路径 Windows 信号量和暂存目录写租约，把剩余目录移入系统回收站。先持久 `moving: true`，移动后 target 不在可幂等继续；旧 deleting 允许兼容部分 rm 已丢失锁文件的情况，仍不 unlink 活锁。旧 target 已不存在仅在 deleting/logsDeleted/moving 有证据时继续清记录。无凭据的目录不扫不移不删。
凭据仍用 domain version 1 的可选 purge 联合 schema，公开列表只暴露 purgePending，不泄漏私有路径。已有凭据不得降级旧插件。新旧凭据的投影清理复用已校验 source home；幽灵分支沿用前述可靠 home 规则。原生操作与插件并非跨进程事务，移动与 marker commit 之间允许进程中断；不保证断电级 fsync。

失败用 `Move to system trash [stage] (id): reason` 报告，结构化日志包含 sessionId/stage/result/reason。
取写租约遇到占用时，Host `PurgeError.code` 为 `D_TRASH_SESSION_LOCK_BUSY`，消息以精确前缀
`[D_TRASH_SESSION_LOCK_BUSY] ` 开头。Host 仅对无 purge、仍归档的 lock-busy 持久排队，返回 `[D_TRASH_DEFERRED] ` 确认；底层阶段、id、busy 原因与 cause 保留。其它阶段的 EBUSY 不排队，排队写入失败报告 deferred 阶段真失败。
Client 精确识别排队前缀并显示中英「已排队」status，关闭确认框；不模糊匹配 busy/lock 文本。混合 empty 的真失败仍报错，消息分别含 deleted/failed/queued 数（deleted 沿用计数名，表示已移走或幽灵清理成功，不代表物理销毁），AggregateError.errors 只含真失败；纯排队使用 DeferredError，全成功返回删除数。
`emptyTrash` 尝试全部条目，失败汇总成功数与阶段。Client 对失败也重读列表和只读 Workspace 投影，
显示部分成功和可重试的诊断条目。投影缓存失败只记录警告，此时 marker 可能已清除，不保证后续 purge 自动重试缓存。搜索索引依赖下一次稳定搜索观测时的现有同步收敛；已检查的 query API 没有公开 rescan，不调用私有 `_reconcile` 或直接编辑 SQLite。
附件、工作区文件、worktree、产物、服务端日志、备份及其它插件扫描快照均保留；系统回收站恢复不会自动补回已清理的 registry/marker，插件不提供恢复导入功能，不承诺搜索立即消失。
仅覆盖 JSONL 与进程崩溃，不声称断电事务；有 pending 凭据时不要降级旧版插件。

## 删除完成后移除 Client 目录行

已验证安装版 DSH **0.2.2-rc.5** 的公开 `api-session/removed(sessionId)` 通道：
`dsh-api-remotes` 的 allowlist/ctx.on → Host Gateway 的 `$events` emit 帧 → Client Gateway 的事件泵/$on →
Session Controller 的 ClientSessions/SessionManager → catalog 的 ids/byId → Workspace 侧栏分组。
`session-wire-event.ts` 属于日志事件校验，并不消费这个目录通知。

侧栏按 catalog 行与工作区成员求差集，把无归属的可见会话放入「未分组 / Ungrouped」。
删除后仅清工作区/归档/marker 和磁盘缓存，不能移除仍驻留在 Client catalog 中的行；取消归档会让它重新可见。
Host 现在在移入系统回收站或幽灵清理成功、**删 marker 之后** best-effort 发出 removed，再尝试清投影缓存。
成功记 `removed/ok`；emit 的同步异常仅记 `removed/warning`，不改变删除结果、empty 成功数或 complete/ok。
这不是 Host registry 卸载操作；没有调用私有接口或直接修改 Client catalog。

失败、排队、普通恢复/读取/收进及仅恢复暂存日志但尚未清 marker 的路径不发；稍后实际完成删除才发。
`removed/ok` 表示本地 emit 正常返回，不是 Client 收讫。较早的 Host 监听器抛错可能阻止后续转发；
单向通知在断线后不重放，重连时官方 Client catalog 的全量读取负责修复。事件不会禁止原生后续 re-add/重建，
也不销毁所有驻留对象；subagent lineage 保留语义仍归官方 manager。不保证跨通道瞬时无闪烁或搜索立即收敛。

`reappear-evidence.cjs` 运行安装版真实 API Remotes/Gateway、Client 事件泵、ClientSessions/SessionManager、
Workspace model 和侧栏 deriveGroups：物理/幽灵删除后暂停通知，断言 ids 与未分组仍有目标；送达后 ids/byId 与分组行消失、订阅通知。
另验证失败/真实锁排队无通知、catalog 保留。仅缺失的通用 browser snapshot/notify 工具与进程内 JSON carrier 是 seam，
不是自造会话 catalog；源码通过 ASAR 只读、内存转译，不改依赖或核心。14 项 Host 边界回归由 Node 与 discovery 共用。
这不是 React renderer、真实 profile GUI 或 Windows 原生验收；新增链路证据限安装版 rc.5。详见 [PLAN](../PLAN.md) 交付小节。

## 排队与启动自动删除（方案 A）

已加载/已 enter 的会话可能长期由 DSH 持有官方写租约；用户既有真机调查显示 `session.lock` 存在写句柄，官方没有供插件释放其它所有者句柄的公开 unload/close API。
旧的「重启后只能手动再删」方案已废弃。remove/empty 在初次 move 的 lock 阶段 busy 后，只写 marker 的 `deferredAt`（重复 busy 保留首次时间），
不动会话日志/归档/工作区归属、不写 purge 凭据；Remote 列表仅暴露 `deferred: true`，仍属于普通 marker ∩ archived，原生取消归档后的 stale marker 仍由 list 对账。

Cordis class-plugin `[Service.init]` 在构造/apply 后投递 0ms unref timer 并立即返回。Host 取所有排队项快照，
逐项进入插件全局边界并重读 marker，调用原 `purgeSession`，完整保留 stat/realpath/dev/ino、官方写租约、intent/最终复核/移入系统回收站/close 门禁。
成功后正常清成员/归档/marker、尝试清投影；仍 busy 则保留到下次启动，本 Host 不轮询追锁；可手动再次彻底删除。
服务/domain 或尚未开始删除的其它阶段失败按实际阶段记录，后台按 1/2/4/…/30 秒退避重试；扫描异常不会拒绝初始化。
卸载取消 timer，等待已接纳的维护操作后关 domain；依赖撤回时保守保留状态。此机制不保证抢在原生加载前完成，更不会强制删当前忙会话。

真正写 purge intent 时移除 deferredAt；已有 purge 凭据不参与排队扫描，继续只由显式 purge/empty 恢复，不改变原校验语义。
启动中其它阶段失败一旦留下 purge 凭据，就由既有恢复协议处理；list/restore/re-trash 不能丢凭据。
面板显示「待移入系统回收站（重启 DSH 后自动重试）」/“Pending move to system trash (automatically retries after restarting DSH)”。
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
| `recovery` | 每条待恢复凭据的阶段与 `recovery` 结果；兼容结果名 `deleted` 现表示日志已移走或旧凭据确认已不在、`unmoved` 表示未移动，失败 `failed` |
| `distill` | `started/ok` → `completed/ok` 或 `failed/failed`；失败原因含 gate/read/path/agent/write，手动提示词完成的 reason 为 prompt；不记录正文或模型凭据 |
| `log-rotate` | 成功 `complete/ok`；`reason` 含文件序号、保留范围、实际淘汰文件或 none 和阈值；失败按实际步骤（含序号）降级 logger |

purge 成功阶段覆盖 `gate/locked/recheck/intent/moved-to-trash/unlocked/detach/unarchive/marker/removed/projection`，幽灵记录使用独立的 `logs-absent`；
工作区 detach 每次实际尝试各记一条，不为非成员或零归属伪造 detach 行；日志行数不固定。
`unlocked/ok` 仅在真正取得租约且 `release()` 成功后写入；取锁失败不产生 `locked` 或 `unlocked` 行。
lock-busy 排队路径为 `gate/ok → lock/failed → deferred/ok → complete/deferred`，deferred 的 reason 含 busy 原因；排队写入失败则 `deferred/failed → complete/failed`，正常成功为 `moved-to-trash → unlocked → detach（如有）`。旧 `renamed / logs-deleted / delete-staged` 审计阶段**已废弃**，仅历史日志保留。
失败按实际阶段记录，缓存清理失败为 `projection/warning`。
每条追加尝试都会等待完成；moved-to-trash 事件在测试 SIGKILL 前已写出。日志不是业务提交凭据，
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
| `main` | key=`trash` | — | 全局列表、恢复、移入系统回收站、清空、内联确认、空/加载/错误态 |

入口 id 与 main key 配对，由 sidebar owner 导航。菜单项位于原生 Archive 之前，
hover 的 50 位于原生 Archive 100/Pin 200 之前，不替换内置条目。
文案以 `locale/en.json`、`locale/zh.json` 为唯一源，`client-copy.ts` 直接复用并推导类型，构建时内联；
移除未使用的 `trash.title` 别名，保留 `meta.title` 和 UI `panelTitle`。样式用 `--dsw-alias-*` token；字典、订阅、读取流和 Tooltip 资源随生命周期清理。

Client 先 `await ctx.remote.$mount(contribution)`，再 `ctx.get('remote.trash')` 取 namespace。
不要在挂载前 inject 自己的 `remote.trash`（会等不到 apply），也不要通过未声明的
`ctx.remote.trash` 属性访问（Cordis 会拒绝）。生成方法直接调用采用位置参数，如
`trash.trashSession(sessionId)`；Gateway 再编码为 wire `args: { sessionId }`。
七个方法返回 `RemoteResult<T>`，UI 显式检查 `ok`。

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
以及合成临时 home 上的真实写租约及临时目录 move、外部锁竞争、SIGKILL 后恢复、失败重试和 restore 回归。
`npm run test:discovery` 需设置 `DSH_NODE_EXECUTABLE` 为安装版 Electron 可执行文件的绝对路径，
`DSH_INSTALL_DIR` 为安装版 `@deepseek-ai/dsh` 包目录；使用安装版 Electron，覆盖 resolver、Loader、Gateway 注入与实际 slot RPC，
并运行真实 Registry、DomainFacility、WorkspaceFeed、ClientWorkspaceModel 的隔离交错复现。
旧协议/UI回归明确使用 `legacy-purge-seam.cjs` 隔离文件 I/O；第 4 期文件系统套件已适配 5.2，不替换原生写租约；注入的 SystemTrash 将源 rename 到临时模拟回收站，替换 persistence stat 的合成元数据、工作区服务与故障时机，Domain 使用真实 facility 与临时文件介质。新增 14 项 system-trash 专项覆盖新旧凭据、跨卷拒绝、源替换、空成功、移动前后中断和清空混合汇总；其中 macOS 原生 rename 仅使用注入的临时用户 home。
同一套 37 个文件系统场景（原 34 + 定向 detach/无归属/多归属失败重试 3 项）也由 discovery 在安装版 Electron 下执行；
另以安装版 WorkspaceEntity 核对只清实际成员的持久记录。夹具默认删除环境变量 `DSH_HOME`；
覆盖无变量时移走日志和清投影、错误变量不重定向删除/恢复/投影，以及层级过深/过浅和各级 symlink 拒绝。
SIGKILL 回归按真实两层目录枚举规则验证重启前后残留不可发现、其它会话仍可见；
另有点目录正向对照、非法 intent/recovery 拒绝及无凭据暂存保留断言。trash transport 不直接修改 Client 归档集合。
这不等同于真实 React renderer 或真实 profile GUI 验收。

另外 29 个持久化日志场景在 `npm test` 和 discovery 中各运行一次：成功/失败 JSONL、权限、
全部 purge 成功阶段及逐阶段失败、empty 逐条/汇总、无 source 的 recovery 成败、写入与降级 logger 同时失败、
队列失败后重试、symlink 拒绝、无可靠 home 降级，以及跨 Host 操作/多个 logger 实例/两个子进程并发追加。
新增 8 项使用实际 4 MiB 阈值验证边界与下一次追加轮转、KEEP 淘汰、逐行完整保留、归档 symlink 拒绝、
轮转失败与建新文件失败不改变业务结果及重试、guard 忙时降级、两个子进程加四实例并发轮转逐行核对，以及跨进程旧句柄迟到写入 `.1`。
全部 37 个文件系统场景也逐条核对 Host report 已落盘，SIGKILL 回归额外核对 `moved-to-trash` 记录仍在磁盘。

公开包身份为 `d-trash@0.2.0`，MIT，目标仓库 `HLhhh/d-trash`；版本不对应期号。locale 的 `meta.detail` 指向此文档，packed 文件包含 PLAN、
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
canonical path、租约与归档+marker 门禁；macOS 排他移动不覆盖目标，Windows 系统分配目标；不跨卷复制。系统移动有界重试，旧暂存凭据复核身份后也只移动；
耗尽重试保留 intent/deleting，供下次 purge/empty 恢复。Windows 使用 realpath/lstat 与非零 ino 验证，
不依赖 O_NOFOLLOW 支持；POSIX 继续使用 O_NOFOLLOW。盘符/路径大小写可比对，junction/symlink 仍拒绝。

测试通过数和 SKIP 分开输出。Windows 跳过原 POSIX symlink/O_NOFOLLOW、缺锁拒绝、SIGKILL 场景和 mode 位断言，
另跑无锁文件、命名信号量竞争/大小写、终止进程释放、junction 拒绝、注入移动的 sharing 重试及审计用例。
macOS 跳过明确要求 Windows 的 6 项，不把注入错误的策略单元测试当作 Windows 原生验收。维护者已于 2026-11-25 在原生 Windows 的 DSH 桌面 GUI 验证通过第 4 期删除全流程（安装、侧栏入口、收进、恢复、彻底删除、清空）；该历史验收不覆盖 5.2 系统回收站；这 6 项原生用例和 5.2 Windows Shell 真机验收仍待执行。

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
npm pack --dry-run --json --cache "$env:TEMP\d-trash-p52-npm-cache"
if ($LASTEXITCODE -ne 0) { throw 'pack failed' }
```

预期 build 输出 Typert / Client generated/bundled；npm test 的平台、system-trash、phase4、日志、幽灵记录、排队、重新显示、Host/Client/生成器套件均输出 PASS，退出码 0。仅平台不适用的 POSIX/macOS 用例可带明确原因 SKIP；5.2 Windows 原生专属用例本轮未执行，不把预计数量当作真机结果。
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
不能只有 SKIP。pack 应列出 d-trash、dist/write-lease.js、dist/fs-retry.js、dist/system-trash.js 与所需资源，无 CODEX 报告。
失败时回传两份 platform 日志、命令退出码、node --version、npm --version、Windows 版本与 CPU 架构；
不要回传真实会话内容。保留失败原文；不跳过锁竞争/路径门禁来获得绿色结果。

<a id="p52-manual-acceptance"></a>
## 5.2 系统回收站真机验证步骤（尚未执行）

本轮只运行临时目录隔离回归，未写真实 `~/.Trash` / Windows 回收站、未安装插件、未改 profile、未碰真实会话。历史第 4 期 Windows GUI 验收不覆盖本次语义。以下操作由维护者在明确授权的测试环境手动完成，使用新建的无价值会话，保留原 source 路径；不要用日常真实会话试验。

macOS：

1. 在专用测试环境启用构建后的 bundle，创建两个仅含测试文本的会话，收进插件回收站；确认普通恢复仍保留日志及归属。
2. 对一个未占用的测试会话点「移入系统回收站」，确认说明包含系统恢复；应全程没有 TCC/Finder 自动化授权弹窗。操作若被权限拒绝，应保留源及 purgePending，不通过 Finder/osascript 重试。
3. 核对原 `sessions` 下目录消失，系统废纸篓出现 `d-trash-<uuid>` 目录，内含全部日志代际与 `session.lock`；原生归档、所属工作区、marker 与磁盘投影记录均已清理。审计为 moved-to-trash→unlocked→detach（如有）→unarchive→marker→removed→projection→complete，无旧三阶段。
4. 系统废纸篓不保证「放回原处」；可用系统操作将目录手动移回所记原 source 路径，验证内容仍在。系统恢复不自动补回被清的归档/工作区/marker，重新发现依赖 DSH 现有机制。
5. 加载另一个测试会话持锁后清空，确认 busy 排队不移动；重启 DSH 后按原队列规则重试。对多个无锁测试条目清空，检查逐项移动及成功/排队/失败汇总。可在专用测试卷放置合成 home，与用户废纸篓不同卷时应明确拒绝、源完整；不为验证创建或删除日常会话。

Windows：

1. 在专用测试用户/测试环境运行 build/test/discovery（见 Windows self-check）；仅经另行授权启用 bundle，创建两个测试会话，记下原目录。确保源在固定本地卷且该卷回收站可用，记录系统回收站策略和可用容量。
2. 单条「移入系统回收站」后核对原目录消失，系统回收站显示目录与原始位置信息；无确认/错误/进度弹窗。用系统「还原」验证内容回到原 source。插件已清记录不会自动补回。
3. 测试同名目录的两条会话（不同 project），检查系统能区分并各自还原，不要求或推算 `$R…` 的实际目标名。测试含中文/空格路径；超长路径、UNC、可移动盘及挂载别名应拒绝并保留源。
4. 打开一个测试会话制造真实 backend 信号量占用，确认排队及下次启动重试；另用短暂 deny-delete 句柄确认有界重试、每次复核门禁，耗尽后保留凭据，再次操作可完成。
5. 批量清空确认分项结果；在隔离程序内模拟 Shell 返回非零/aborted，源在则重新过门禁，源不在则仅清记录。不要用真实业务目录进行断电/强杀测试。旧 staging/崩溃协议继续由合成临时 home 回归验证。

回传 OS/CPU、Node/Electron/DSH 版本、退出码、系统回收站可见性/还原结果、是否出现授权/UI、审计阶段与原因即可；不回传会话正文。不要把仅 SKIP 的 discovery 或历史 GUI 验收写成 5.2 真机通过。


## 提炼（5.3）

每行点「提炼」，从 Host 重新读取可用 agent preset，选择后开始。运行中显示行内状态，失败可再次选择重试；成功显示摘要与「显示文件路径」，完整路径在只读输入框中选中，复制到编辑器/文件管理器打开。未找到可靠的通用打开文件 API，因此不伪造文件打开 Remote，也不声称点击后已打开。已有 purge 凭据的待清理条目禁用提炼。提炼调用绕过 Client marker/归档写投影层，不额外刷新/修改它们。

### 调研依据与执行机制

安装版 **DSH 0.2.2-rc.5 / Electron 44.7.0 / Node 24.21.0**，从已验证 ASAR 安装锚点读取官方 `src/`：

- `dsh-agent/index.ts` 的 `AgentRegistry.create` 和 `CreateAgentOptions` / `AgentHandle`；`dsh-agent-loop/index.ts` 的 createAgent 初始化一个新 Session 并持有自己的存储写句柄。`dsh-agent/runtime-types.ts` 的 send/whenIdle/cancel/dispose 公共契约。`whenIdle` 只表示静止，因此另核对本任务 `turn/end.reason.kind === completed`，error/aborted/max-tokens/missing 不能当成功。
- `dsh-api-session-controller/agent.ts` 的 resolveAgent/resumeObserved 可能走 `agents.resume`；`commands.ts` 的 create 可能复用 blank 会话/附加工作区，故都不用于源会话。`dsh-subagent/child-agent.ts` 与 manager.ts 的同进程新 child 使用 `agents.create` + `agentPresets.mount`，需 parent/lineage/manager 生命周期，本插件不把源会话恢复为 parent。
- `dsh-agent-preset-registry/index.ts` 公开 list/mount；非 broken 行的 id/name，name 缺失回落 id。内置 preset 的本地化名称属于宿主字典，当前选择器保留宿主发布名/id，不复制其字典。列表另含插件明确标识的 `__manual__` 提示词导出项，不冒充宿主 agent。
- `dsh-api-session-controller/agent.ts` 的 agentOptions 从公开 `agentDefaultModel.currentSelection()` 读取模型；`dsh-agent-loop/agent.ts` 在缺 provider/model 时拒绝运行。preset 是组合，不保证提供模型。提炼在任务开始时取 DSH 默认 provider/model/effort 快照，所选 preset 提供 Agent 组合；不发起真实模型测试，不硬编码路由。
- `dsh-session-persistence/handle.ts` 的 read access 不占写所有权；`dsh-session-persistence-jsonl/index.ts` 的 open 在 read 分支返回，进入 claimWrite/acquireLease 前已结束；只读打开不发布历史迁移。`dsh-session/index.ts` 的静态 create 构建 detached Session，deriveMessages 还原当前可见消息表面（包括 compaction/replacement），不伪造完整未压缩历史。

`distill-evidence.cjs` 通过安装版实际 JSONL 创建合成日志，持有原写句柄时调用生产 reader，验证转录与源日志字节不变；运行真实 ToolService scoped restrict/guard，拒绝当前任务并保持 Host 其它 scope 不变；真实 Registry、roster/default-model service 通过注入 factory / preset mount 跑生产执行适配器。factory 和 mount 是明确的测试 seam，**不是实际模型调用或真实 preset Loader 端到端验证**。本机无 Inspect 工具，未读取真实 profile roster，未运行模型；源码证据/探针界限见本地报告。

### 只读与结果协议

`@Remote distillSession(sessionId,agentPresetId)` 在 Host 同 sessionId 队列内核对 marker ∩ archived，无 purge 凭据；不调用 listTrash 对账。生产 reader 打开 read handle，在 finally close；把 `Session.create(id,events,header,inheritedEventCount).deriveMessages()` 的 role/content 序列化为 JSON，不附带 provider replay state，不额外读附件或工作区文件。标题取日志最新 session/title 的 title，缺失用完整 id。源 cwd/创建时间取 immutable header，输出 home 保护沿用已验证 stat 路径；不能校验 JSONL home 时 read 阶段拒绝，不猜路径。当前转录上限 2 百万字符（实际模型上下文可能更小），超限不截断，错误可诊断。

执行器用随机新 sessionId 创建任务，在 scoped setup 内挂载选择的 preset。restrict 空 allow 隐藏全局工具，最终 guard 拒绝所有工具执行（包括 preset 的 scoped 工具）；这是可信宿主插件环境中的限制，不是对恶意插件源码的沙箱。发送一条独立 prompt，不将源会话作为 fork seed，不赋予 parent 或工作区成员归属。等待 idle + completed 后读取最后非空 assistant 文本，严格解析 JSON `{type,body}`；type 为 experience / operations / skill-draft / requirements，body 非空 Markdown，提示词要求摘要、决策/证据、可复用步骤、边界和未决问题。不能保证模型内容正确，需要用户检查。

输出为 Markdown，包括 Session ID、Title、Session time、Generated at、Agent preset、Mode、Distillation type 与正文。默认 `<源 cwd>/d-trash-distill/<YYYY-MM-DD>-<清洗后短id>-distill.md`（UTC 日期）；同名时追加 UUID，`wx` 排他创建，避免重试或另一 Host 覆盖已有文件。目录 0700/文件 0600（Windows 不承诺 ACL 等价），写失败清理本次新建的残缺产物，不删除任何源日志。崩溃不保证原子落盘，可能留下部分产物，重试另写新文件。

| Config | 类型 / 默认值 | 行为 |
| --- | --- | --- |
| `distillDir` | string / `""` | 空串使用源会话 cwd 下 d-trash-distill；非空须绝对目录；缺源 cwd 则必须配置。拒绝非 canonical/symlink 路径与 DSH persistence home 内的目录；不改 profile 默认值 |

这是 schemastery 导出的 Host Config（class static Config 同源）；依赖已存在的 schemastery 3.19.0 被声明为直接运行依赖，不加新的 Agent 包运行依赖。Agent 可选能力通过已实证的窄公开类型桥和 `ctx.get` 查询，缺服务时不阻断普通回收站。

若 Agent / preset / default-model 服务不可用，选择器仍可「导出提示词（手动）」；Agent 执行失败也可由用户重新选择该项。文件 mode=prompt/type=prompt，明确尚未运行模型，含源转录与可自行发送的提示词；UI 不显示「提炼完成」。未采用直接 ctx.llm 补全：它不等于所选 agent，且容易悄悄丢弃 preset 语义。重试不自动切换模型或降级。

### 并发、卸载与审计

同 sessionId 复用 Host forSession 串行，不同 session 可并发；purge/empty/list 的既有全局边界等待提炼，提炼也等待先前全局边界，源不会在插件提炼中被插件移走。原生归档交错仍不受插件锁控制，插件不补写状态。独立任务会话由宿主正常存储，持有它自己的租约，结束 dispose owned handle；任务日志可能在宿主会话目录可见，由宿主保留，不自动删除，不承诺无新会话目录。**源会话绝不 resume、enter 或获取写租约。**

任务执行五分钟超时，卸载主动 abort 并拒绝后续任务；取消/超时即停止等待不合作的执行器，已创建 Agent cancel+dispose，迟到创建也 dispose，生产 read 在 finally 关闭。标准 provider 负责自身最终收敛；不承诺能强制结束不合作的第三方插件。纯文件 I/O 和审计沿用有界正常收敛，未实现磁盘故障的硬终止。不是持久任务队列，退出后需手动重试，期间产出的宿主任务日志保留。

错误消息 `Distill [gate|read|path|agent|write] (sessionId): reason`；读取失败重读，agent 失败可换 preset，路径失败可配置重试。JSONL 审计新增 action=distill：started/ok 后 completed/ok 或 failed/failed，失败原因携带阶段；手动导出 completed 的 reason=prompt，正常为 agent。审计仅追加 `<home>/logs/trash.log`，不记录正文/提示词，不改变业务结果；该操作日志的变化不属于源会话日志哈希不变约束。

<a id="p53-manual-acceptance"></a>
### 5.3 真机验收（尚未执行）

仅在维护者另行授权的专用测试 profile 中启用 bundle，创建无价值测试会话并收进回收站。记录 marker/归档/工作区归属、源日志哈希及源锁持有情况。分别在中英文界面选择实际 preset，确认使用 DSH 默认模型、任务有独立 id、不会 resume 源；完成后打开显示路径核对文件字段/类型/正文，检查源状态与哈希不变、无源锁新增占用。实际任务会话日志由宿主保留。

再验证坏路由/读取失败的阶段提示、换 preset 重试、同会话重复请求/两会话并发、长任务卸载取消；选择手动导出应只生成提示词且不调用模型。检查 distill 审计阶段、无正文。缺 cwd 时配置绝对 distillDir，检查重名保留、非法输出路径拒绝与待清理条目禁用。完成后回报平台/DSH 版本和结果，不回传会话正文。本轮没有安装/改 profile、没有运行模型、没有 GUI 或 Windows 真机复验；5.2 的待验收状态不变。
