# d-trash（回收站）方案

> **已交付**：第 0–4 期及评审修复、持久化操作日志（2026-11-22）。既有真机验收已通过：第 2 期入口和第 4 期两个会话的物理清理；详见本文验收记录。
> 本次开源整理只改插件项目、运行隔离验证；没有安装/重载 bundle、修改核心/profile、启动 web server 或操作真实会话，不代表本轮完成真机复验。
> 形态：DSH Host + Client bundle；包 `d-trash`，版本 `0.1.0`；插件 id / 服务 / Remote namespace / 面板 id 与 key 均为 `trash`。

本文是唯一方案源。以下描述**当前累计实现**；各期标注职责来源，不要求最终代码保持当期的中间形态。历史逻辑删除方案已废弃，因为第 4 期明确升级为物理删除。

## 背景、目标与已确认决策

给会话新增「收进回收站」入口，复用原生归档隐藏会话，提供全局回收站面板、恢复、彻底删除和清空。

| 决策 | 当前结论 |
| --- | --- |
| 交付与技术 | 插件 bundle，不 fork 核心；TypeScript strict / ESM；Host 为 service class，领域对象用 interface，Client 为 React 函数组件与 hooks |
| 三态非对称 | 普通可观测 `trash = marker ∩ archived`；原生归档不写 marker，原生取消归档后的 stale marker 由 Host 读取对账 |
| 操作 | 收进保留日志；普通恢复取消归档并保留当前成员位置；彻底删除/清空物理删除本地会话日志，不可恢复 |
| 删除中状态 | Host 私有 `purge` 凭据属于待清理诊断；Remote 只给 `purgePending`，独立于普通 trash 交集保留展示 |
| 入口与范围 | 右键菜单 + 行 hover；左侧栏图标打开中央面板；全局跨 workspace，标注当前所属工作区 |
| UI / i18n | 惰性 ModuleLoader 工厂，只从浏览器模块表取 React；locale JSON 为中英文案唯一源；样式用 `--dsw-alias-*` |
| 删除清理面 | 本地会话目录、工作区成员记录、归档集合、marker；尝试清理投影缓存。搜索索引依赖已有同步收敛 |
| 保留范围 | 附件、工作区文件、Git worktree、产物、远端/独立服务端日志、备份及其它插件的扫描快照均保留 |
| 版本与发布 | `d-trash@0.1.0`，MIT，目标仓库 `HLhhh/d-trash`；不用期号充当版本；本轮只整理可公开仓库，不执行发布 |

## 第 0 期：框架、状态模型与架构 — 已交付

### 目标与范围

建立 Host/Client bundle、类型、资源与构建链；明确当前状态协议和版本边界。业务职责分别见第 1–4 期。

### 0.1 技术栈与构建做法

- `src/` → `dist/`：`npm run build` / `pnpm build` = `tsc -p tsconfig.json` → `scripts/generate-typert.mjs` → `scripts/build-client.mjs`。NodeNext、ES2022、strict、声明文件、JSON module 类型检查；不是单独运行 tsc 就完成 Client 构建。
- `TrashService extends TypertRemoteService`，`super(ctx, 'trash', { namespace: 'trash' })`；注入 `typert/storageDomain/workspaceRegistry/sessionPersistence`，五个方法用 `@Remote` 暴露。
- Domain：`storageDomain.open(defineDomain(...))`，懒打开且共享首次请求；打开失败清缓存允许重试；卸载等待已接纳操作后关闭 domain。schema 用 zod，domain version 仍为 1。
- 生成器固定为 `0.2.2-rc.5`，在临时目录读取精确依赖源码；解引用后复制，不改依赖实体/链接。生成 Host 描述、Remote contribution/codecs 与声明；esbuild 将后者和 locale 字典内联到经典 Client 脚本。
- 包导出 `.`、`./client`、`./types`、`./typert`、`./remote`、`./locale/*.json`、`./icon`、manifest、patch；`files` 包含 dist、src、scripts、tsconfig、locale、icon、patch、docs、PLAN、双语 README、LICENSE 和 CHANGELOG。`meta.detail` 指向 `docs/DETAIL.md`。本地目录安装链接 checkout，packed 文件清单另行核验；本轮不安装。
- 运行依赖 zod 4.6.6 与 koffi 3.1.1；Cordis peer ^4.1.0、DSH peers ^0.2.2-rc.2、官方 node-addon-system peer ^0.1.2；开发依赖保持精确版本；不在 Client 运行时 require DSH 内部包。

### 0.2 已核实的 DSH 事实与使用边界

事实来自既有 runtime/source 调研、本轮 `dsh-doc` 指引下只读安装版源码和 discovery；安装版为 **DSH 0.2.2-rc.5**，不是对未来版本的保证。

| 事实 | 本项目采用方式 / 证据位置 |
| --- | --- |
| `sessionPersistence` 是 append-only，无 delete/retention API；官方定义 pruning 为带外 backend maintenance | `SessionPurger` 在文件层维护；官方 persistence / JSONL README |
| archive/pin 在 registry-global 集合，与日志和工作区成员记录分离；归档去置顶并保留原成员位置 | 收进调用 `archiveSession(id, { stopActivity: true })`；恢复 unarchive；`dsh-workspace/src/index.ts` |
| `Workspace.sessionIds` 是同步成员投影，`detachSession` 移除成员；非成员调用原本为 no-op | purge 遍历 registry，但仅对当下含目标 id 的工作区 detach/记录；`dsh-workspace/src/entity.ts` |
| `storageDomain` 提供带 schema 的 domain/global/table；事件不保证跨 Context 可达 | Host `listTrash` 读取对账，不依赖 sibling `domain/changed` 事件 |
| `workspaces.list` 实际为 ClientWorkspaceModel，支持 `replaceArchived/replacePinned`；follow 首帧为 Registry 基线 | `workspace-sync.ts` 做能力检查和只读投影同步；安装版 controller/model/feed 源码 |
| Client 标题来自 Session catalog `byId` | `titleSnapshot` → catalog `title/displayTitle` → id 前 12 字符；不打开/retain Session，不用 header.list 取标题 |
| sidebar owner 按入口 id 导航 keyed main | `sidebar.panellist.id = main.key = trash`；插件不重复调用 layout 导航 |

### 0.3 状态模型与操作协议

令 `M` 为 marker 表的 id 集合，`A` 为原生归档集合。普通可观测回收站为 `M ∩ A`；UI 同样按归档投影过滤普通条目。`P` 为带私有 purge 凭据的诊断记录，单独保留并允许重试删除；`P` 不用于扩大普通 trash 定义。

```text
正常 ──原生归档──→ 已归档（不写 marker）
正常/已归档 ──收进：archive → 校验 → put marker → 校验──→ 普通回收站
普通回收站 ──恢复：delete marker → unarchive──→ 正常（现有成员位置保留）
普通回收站 ──物理删除──→ purge 凭据/待清理诊断 ──日志及必要记录清理──→ 移除
原生取消归档：普通条目即时退出交集，持久 stale marker 由 listTrash 惰性清理
```

```text
domain: name="trash", version=1; table: "trash"; key: SessionId
stored: { trashedAt: number, workspaceId?: string, titleSnapshot?: string, purge?: PurgeIntent }
PurgeIntent: { source: string, target: string, dev: string, ino: string,
               deleting: boolean, logsDeleted: boolean }
Remote TrashRecord: { trashedAt, workspaceId?, titleSnapshot?, purgePending?: boolean }
```

正常收进只写 `trashedAt`；可选历史 metadata 仍兼容，工作区显示不依赖 `workspaceId`。Host 不把私有路径发到 Client。

| 方法 | 当前做法与返回值 |
| --- | --- |
| `trashSession(id)` | 拒绝已有 purge 凭据；先归档，写 marker 前后校验 A；交错取消归档时删 marker 并抛错；`Promise<void>` |
| `restoreSession(id)` | 拒绝已有 purge 凭据；先删 marker，再 unarchive；失败且仍归档才补回旧记录；`Promise<void>` |
| `removeFromTrash(id)` | 先恢复全部已有凭据，再处理指定条目；普通条目必须有 marker 且仍归档；首次 stat 明确 undefined 时只清幽灵记录；成功 true；purge 阶段失败带阶段，依赖失败保留原错 |
| `emptyTrash()` | 先恢复全部凭据，再遍历 marker ids（含待清理诊断）；普通 stale marker 仍受归档门禁；全部成功返回删除数，部分失败继续其它项并抛含成功/失败数及阶段的 AggregateError |
| `listTrash()` | 全局边界内循环删除不带 purge 且已不归档的 stale marker；返回记录副本，带凭据者只增加 `purgePending`；不写操作日志 |

这些操作不是跨服务事务。归档拒绝不新增 marker，即便归档已提交也保守保留；put 失败只在原先未归档且确认没有 marker 时撤销归档；不可读/unknown-state 不做危险撤销。操作和补偿都失败时 AggregateError 保留原错与补偿错误、原始 cause。

同 session 的收进/恢复及补偿串行；list/remove/empty/dispose 的全局边界等待此前插件操作，并阻止后来的操作越过。原生 unarchive 不经过插件锁，写后检查之后仍可能交错，所以持久 marker 允许短暂滞留。

### 0.4 架构

```text
Host: TrashService（唯一 marker 写入者、五个 Remote、session 队列/全局边界）
 ├─ storageDomain: marker + purge receipt
 ├─ workspaceRegistry: archive/unarchive + 所属工作区 detach
 ├─ SessionPurger: stat/realpath/dev/ino → backend 兼容写租约 → rename → close → rm / recovery / cache
 └─ OperationLog: stat/source 定位 home → logs/trash.log（best effort）
                     ↑ Typert positional methods / named wire args
Client: ModuleLoader 惰性 React 工厂（$mount 后 ctx.get('remote.trash')）
 ├─ 菜单 / hover / sidebar icon / main panel
 ├─ TrashStore: 共享列表、读基线重放、单 Client 发起序号与 empty 边界
 ├─ WorkspaceSync: follow 首帧 → archive/pin 投影（无第二次业务写入）
 └─ client-copy: locale JSON 字典 → locale.register / bind
```

### 0.5 UI 扩展点

| Slot | 身份 / order | 用途 |
| --- | --- | --- |
| `sidebar.workspaces.session.menu.item` | `trash-menu` / 350 | 原生 Archive 前的收进项 |
| `sidebar.workspaces.session.row.action` | `trash-action` / 50 | hover 垃圾桶、Tooltip、aria-label；原生 Archive 100 / Pin 200 前 |
| `sidebar.panellist` | `trash` / 40 | label thunk 跟随 locale；sidebar owner 导航 |
| `main` | key=`trash` | 全局面板、恢复/物理删除/清空、内联确认、空/加载/错误态 |

### 0.6 文件结构

```text
d-trash/
├── README.md / README_zh.md / LICENSE / CHANGELOG.md
├── PLAN.md / AGENTS.md          # 唯一方案 / 工程与领域约束
├── package.json / package-lock.json / tsconfig.json
├── cordis.patch.yml            # insert id=trash, name=d-trash
├── src/
│   ├── index.ts                # TrashService、domain、补偿/队列/Remote、purge 编排
│   ├── purge.ts                # SessionPurger、路径/身份门禁、跨平台租约、暂存/恢复/删除
│   ├── write-lease.ts / fs-retry.ts # POSIX flock / Windows 同名信号量、路径校验/有界重试
│   ├── operation-log.ts        # JSONL 记录与 O_APPEND 队列、降级 logger
│   ├── types.ts                # 公开 TrashRecord（不含 purge 路径）
│   ├── client.ts               # 惰性 React 工厂、slots、共享调用层
│   ├── client-store.ts         # TrashStore 投影、写票据、读基线合并
│   ├── workspace-sync.ts       # Workspace 只读首帧刷新与迟到投影对账
│   └── client-copy.ts          # 复用 locale JSON，推导 CopyKey
├── locale/en.json / zh.json     # meta + UI 文案唯一源
├── icon.svg / docs/DETAIL.md
├── scripts/
│   ├── generate-typert.mjs / build-client.mjs
│   ├── smoke.mjs / host-regressions.mjs / client-panel-regressions.mjs
│   ├── client-harness.cjs / legacy-purge-seam.cjs / generator-regressions.mjs
│   ├── discovery.cjs / workspace-evidence.cjs / review2fix-regressions.cjs
│   ├── phase4-fixture.mjs / phase4-regressions.mjs / phase4-child.mjs
│   ├── operation-log-regressions.mjs
│   └── profile-boot.cjs        # 历史只读 profile 诊断入口，非默认套件；本轮不运行
├── dist/                       # 生成 JS / declarations / Typert artifacts，随仓库提交
└── CODEX_*.md                  # 本地简报与审查证据，gitignore 排除，不随仓库/包分发
```

### 0.7 当前约束与风险

1. **原生 UI 选项**：trash 仍在原生归档集合；「显示已归档 / 全部对话」模式仍能显示它，默认隐藏已归档时隐藏。不改原生按钮或过滤规则。
2. **版本边界**：Workspace facade 类型只承诺读/订阅，实际 model 的 replace 能力已按安装版核实并运行时检查；升级 DSH 需重验。布局导航、Remote、storage 路由已解决，见附录。
3. **并发边界**：插件队列不约束原生/其它进程；Workspace 跨通道帧可能瞬时闪烁，最终按只读权威基线收敛。写票据只覆盖同一 Client bundle，不是 Host revision 或跨 Client 协议。
4. **物理删除范围**：已有日志仅 JSONL 且有可靠 stat/身份和 backend 兼容互斥。首次 stat 明确 undefined 且 marker/归档门禁成立时只清幽灵记录；stat 抛错或 snapshot 不可靠仍拒绝。POSIX 要求既有普通锁文件与官方 flock；Windows 同名信号量不要求锁文件。原生支持缺失或身份不可靠均拒绝。macOS 已隔离验证，Windows 待用户原生代跑。
5. **崩溃/升级**：覆盖进程崩溃，未增加断电级目录 fsync 事务。unknown-state 可隔离 domain，需重启读取凭据；pending 时不要降级旧版。非法或无凭据暂存不猜测删除。
6. **派生数据**：投影删除失败为 warning，marker 可能已清掉，后续 purge 不保证自动重试缓存；索引依赖下一次稳定搜索观测的已有同步，不保证即时消失，不手改 SQLite。不额外清理其它插件快照。
7. **日志**：best effort、固定 4 MiB 阈值与三份归档（下一次追加前轮转，约 16 MiB，非硬上限）；无可靠 stat/source 或磁盘失败时降级 logger，不能当业务凭据或承诺每条必落盘。
8. **原生重建**：写租约只证明当前写者排他（POSIX inode / Windows 同名信号量），不能禁止 rename 后原生重建 source；恢复/记录清理发现替代 source 会拒绝，不承诺跨进程维护事务。成员检查同样不锁住原生归属变动。
9. **已加载会话**：已加载/已 enter 的会话因 DSH 占用官方写租约而拒绝删除；官方无供插件使用的公开卸载/close API。请切换离开到其它会话或重启 DSH 后再试；切换可能仍保留加载和租约，若仍占用请重启。绝不因锁占用而盲删或释放其它服务的句柄。

### 验收标准与结果

构建、schema/codecs、注入与生命周期、slot 配对、生成器依赖不污染、packed 运行资源完整；默认两套测试均隔离通过。历史一致性收口输出保留在本地 `CODEX_CONSISTENCY.md`，不随仓库分发；本轮结果见下方开源整理记录。

### 明确不做什么

不改 DSH 核心、profile、原生行为；不运行安装/启用操作或 web server；本次不做真实会话测试。不是跨进程事务、发布或新 backend 支持。

## 第 1 期：Host 回收站状态 — 已交付

### 目标

Host 独占 marker 写入，提供收进、普通恢复、读取对账及可靠失败补偿。

### 范围

domain 生命周期、状态 schema、收进/恢复/list 协议和队列。五个最终 Remote 方法保留；删除实现由第 4 期接管。**旧逻辑移除已废弃**，不能用它描述当前彻底删除。

### 做法

按 0.3 的顺序归档/写入/校验及删除 marker/取消归档/必要补偿；同 session 串行、读取全局边界；普通 stale marker 循环对账，purge 凭据保留；domain 打开失败可重试。

### 验收标准

收进归档并新增 marker；原生归档不新增 marker；取消归档后 list 清理普通 marker；恢复保留日志/当前成员位置。pre/post commit、补偿失败、unknown-state、并发、首次 open/卸载回归通过。第 1 期历史验收不代表仍保留逻辑删除分支。

### 明确不做什么

本期不负责 UI；不改原生归档/置顶，不承诺连续的跨服务持久 `marker ⇒ archived`。

## 第 2 期：收进入口与 Remote 集成 — 已交付

### 目标

菜单和 hover 触发 Host 收进，按原生归档视图规则隐藏会话。

### 范围

两个行入口、五个方法的 Remote 生成/挂载、locale/theme、Tooltip/订阅清理；与第 3 期共享写入层。

### 做法

按 0.5 注入 slot；先 `$mount(contribution)` 再 `ctx.get('remote.trash')`，不预先 inject 自己的 namespace。直接调用为 `trash.trashSession(sessionId)`，Gateway 再编码 wire `args: { sessionId }`；检查 `RemoteResult.ok`。成功向共享 store 发布，再只读刷新 Workspace；失败保留原错并重读投影。Tooltip 延迟 500ms，Escape 同步取消 timer，资源随组件卸载清理。

### 验收标准

入口存在、顺序正确，点击后归档与 marker 生效；中英切换、重复点击、Remote/transport 失败及卸载清理通过。既有真机入口验收已通过；「全部对话」仍显示归档项是已核实的原生选项效果。

### 明确不做什么

不替换原生入口，不在 hover 提供恢复，不调用第二次 archive/unarchive 来同步视图。

## 第 3 期：全局回收站面板与 Client 投影 — 已交付

### 目标

左侧栏入口打开中央面板，所有入口与已挂载面板共享实时列表和操作状态。

### 范围

倒序列表、标题/当前工作区/时间、恢复、彻底删除、清空、内联确认和错误/空/加载态。删除按钮现在调用第 4 期物理删除协议。

### 做法

- id/key 固定 `trash`，由 sidebar owner 导航。列表用 Host `listTrash` 基线；读取 token、revision 和已接受变化重放，避免迟到基线覆盖新状态。
- 每个写入发起时由 TrashStore 分配共享递增票据；session 最新序号与 empty 全局边界共同判旧。旧响应不 upsert/remove/clear，转为重拉 Host；迟到 empty 不能清掉后来的收进。
- WorkspaceSync 读取 `remote.workspace.follow(signal)` 的第一个 baseline，只安装变化的 archive/pin 集合，然后关闭流；操作/投影变化使在途基线失效，迟到 follow 触发再读。显式失败报 UI，后台失败在后续帧/动作/刷新重试。
- 标题和工作区按 0.2；普通条目渲染时再与归档投影求交集；purgePending 独立保留、禁用恢复并提示重试。UI 不直接写 marker。
- 删除/清空均先内联确认、支持 Cancel/Escape，明确物理删除与不可恢复；失败后重读两个投影以反映部分提交，不掩盖原错误。

### 验收标准

slot 配对、实时联动、多面板、倒序响应与 empty 边界、无/迟到 follow、标题与归属变化、确认与双语错误/卸载回归通过。恢复保留日志，彻底删除/清空删除日志并清理必要记录；部分失败展示可重试诊断。既有第 4 期真机从面板删除验收通过；本次无新增 GUI 验收。

### 明确不做什么

不提供跨 Client 全局序号、多机同步、内部 toast 或操作日志页面；不保证跨通道瞬时无闪烁。

## 第 4 期：物理删除、恢复与操作日志 — 已交付

### 目标与范围

彻底删除/清空物理删除本地会话日志，再清成员、归档、marker，尝试清投影缓存；持久凭据支持崩溃后重试，操作阶段可在本地日志查看。普通收进/恢复协议及保留范围不变。

### 做法：定位、门禁和固定顺序

1. `stat(id)` 有 snapshot 时必须匹配 header.id、JSONL kind 和绝对日志路径；向上反推 `<home>/sessions/<slug>/<session-dir>`。要求根名 `sessions`、两层结构、canonical home/root/source/log 和真实文件/目录；拒绝 symlink/不可靠路径。无 purge 凭据的首次 stat 明确返回 undefined，且 stat 前后 marker/归档门禁成立时，跳过日志删除，只清必要记录并记 `logs-absent`；stat 抛错（包括 I/O/ENOENT）、不可靠 snapshot 或后续取锁复核 undefined 仍拒绝。不自行推导 cwd slug 或原会话目录编码，**不读环境变量 DSH_HOME**。下文 `<home>` 均为 stat/source 反推且校验的 home。
2. 初次删除要求 marker 且仍归档；POSIX 以 `O_RDWR | O_NOFOLLOW` 打开既有普通 `session.lock`，官方 `tryLockExclusive` 独占、不创建/截断。Windows 使用 backend 同名内核信号量，不依赖锁文件或 POSIX addon。locate 只依赖 stat/路径/身份。取锁后复核 stat、realpath、目录和租约、归档门禁。
3. 建立同设备兄弟目录 `<home>/sessions.trash-purge-staging`，拒绝 symlink/跨设备；持锁先把 source/target/dev/ino/deleting/logsDeleted 保存进 marker，失败不迁移；然后再次校验 stat/realpath/inode 和门禁。
4. **写租约 → 复核 → 持久 intent → 最后复核 → 整体 rename → close → rm 暂存 → detach 含目标 id 的各工作区 → unarchive → 删 marker → 尝试清投影缓存**。暂存名 `<encodeURIComponent(id)>-<uuid>` 只用于新 target。持锁不得 unlink 锁文件；POSIX close 关闭被 rename 的同一 inode；Windows 释放原路径信号量，暂存恢复同时检查 source/target 信号量，再释放后删除。
5. detach 逐所属工作区尝试并汇总失败；不调用/记录非成员 no-op。有日志的必要记录清理失败保留凭据；成功后清 marker，投影失败仅 warning。投影清理显式使用 deleteStaged 返回的已验证 home，幽灵分支复用已校验的 stat/source home（或其它可靠会话定位）；无可靠 home 时 warning，日志降级 logger，不回到环境变量。

### 做法：凭据与恢复

每次 remove/empty 在全局边界内先扫描所有 marker 凭据；不在启动或 list 时自动物理清理。恢复失败逐条记录，继续其它条目；当前目标删除仍按自身结果返回。

- `deleteStaged` 从原 stat 保存的 source 反推 home/root；target 必须是该 home 的兄弟暂存直接子项，id 前缀匹配，dev/ino/canonical 路径匹配。source 已被重建/替换时拒绝。
- 原 source 原 inode 尚在且 target 不存在：视为未迁移，recovery 撤销 intent；随后仍需初次删除的归档门禁。
- target 原 inode 尚在：检查/取得其既有锁后关闭，先持久化 `deleting` 再 rm；部分 rm 已删除锁时只凭已有 deleting 凭据继续。
- source/target 都不存在：只有 deleting 或 logsDeleted 凭据才承认删除已开始/完成；否则拒绝猜测。日志清理后持久化 logsDeleted，保留 marker，目标的显式删除才继续清必要记录。
- 非法 target（含旧 sessions 根内暂存）保留诊断，不自动迁移/删除；无凭据的陌生目录不扫描删除。带 purge 时 restore/re-trash 拒绝，list 不对账丢弃，Remote 仅展示 purgePending。

### 做法：持久化操作日志

`src/operation-log.ts` 将 UTF-8 JSONL 追加到 **`<home>/logs/trash.log`**；AsyncLocalStorage 区分 action。每行字段保持 **`ts/action/sessionId/stage/result/reason`**；ts 为 ISO，成功无原因 `reason: null`，empty 汇总 `sessionId: null`。

| action | 记录 |
| --- | --- |
| trashSession / restoreSession | 每次调用一条 complete，ok/failed |
| removeFromTrash | purge 阶段 + complete，包括门禁失败 |
| emptyTrash | 逐条 purge 阶段 + complete；一条 summary 含成功/失败数，零条也记录 |
| recovery | 每个凭据的阶段与 recovery 结果（deleted/unmoved/failed） |

成功阶段覆盖 `gate/locked/recheck/intent/renamed/unlocked/logs-deleted/delete-staged/detach/unarchive/marker/projection`，幽灵记录独立使用 `logs-absent/ok` 并注明 stat undefined、日志已不存在、只清记录；detach 按实际尝试的所属工作区记，零归属不产生 detach 行。阶段失败按实际位置记录，projection 为 warning；已有字段与路径不变，日志行数不固定。
`unlocked/ok` 仅在已取得租约且 release 成功后写入；取锁失败无 locked/unlocked，lock-busy 顺序为 gate/ok → lock/failed → complete/failed。

操作前预定位并缓存 home；source 移走后复用已打开 marker 的 source；否则用目标 stat、其它 marker 或 persistence.list 候选再 stat。无可靠凭据/stat 时降级 logger，不猜路径。新目录 0700，日志文件 0600 且每次打开收紧，现有 logs 目录权限不改；拒绝 home/logs symlink、文件 symlink/非普通文件；O_APPEND、不截断，同进程按路径共享串行队列。每条等待追加完成，失败降级 ctx.logger.info（带原记录及 logError）；降级也失败则吞掉，后续可重试，不改变主操作结果。固定常量 MAX_BYTES=4 MiB、KEEP=3，超过阈值后在下一次追加前删除 .3、逆序改名并新建 0600 活动文件；轮转自身写 log-rotate 记录，失败只降级 logger，原业务结果不变。跨进程旧句柄可继续写轮转文件使 .1 偏大，不承诺跨进程强一致或 fsync，日志不充当业务提交凭据。详见下方日志轮转交付章节。

### 验收标准与结果

- `npm run build`、`npm test`、`npm run test:discovery` 通过。本次 **37 个**真实文件系统场景（原 34 + 3 个 detach 边界）、**21 个**持久日志场景，分别在 Node 与安装版 Electron 执行；discovery 另核验真实 WorkspaceEntity 的定向 detach。
- 新建合成临时 home，真实官方 flock/rename/rm、外部进程锁竞争、SIGKILL 恢复、两层真实发现规则、无/错 DSH_HOME、层级/symlink 门禁、非法/无凭据暂存保留、partial rm、记录失败、empty 部分成功、普通 restore 均覆盖。检查 Host report 落盘、rename 记录在 SIGKILL 后保留；不以旧协议 seam 代替文件系统证据。
- 日志套件覆盖字段、权限、逐阶段失败/warning、empty/recovery、失败降级及队列恢复、多个实例和两个子进程并发追加；280 条并发追加不丢行。
- **既有真机验收已通过**（2026-11-22，来自既有用户记录，本轮未重做）：两个会话的目录、marker、工作区成员/归档、投影缓存均清除，暂存为空；既有 18 行日志全 ok，顺序符合持锁 rename → close → rm。另一插件扫描快照按要求保留。未发现文件索引不能证明必用 :memory:，搜索即时收敛仍不作承诺。

### 明确不做什么

不新增物理删除对象或绕过门禁；不清附件、workspace/worktree/产物、服务端日志、备份和其它插件快照；不安全擦除、不手改 SQLite/调用私有 reconcile、不承诺即时搜索消失。第 4 期未新增 Windows（后续平台兼容章节已扩展）；不新增其它 backend、跨进程事务或断电级恢复；不自动清理无凭据残留。本次不安装、不改 profile/核心、不启动服务、不操作真实会话。

## 附录：原开放点处理与待确认项

| 原开放点 | 状态与结论 |
| --- | --- |
| 原生归档视图 | **已解决**：trash 进入归档集合；原生「显示已归档」模式仍显示，默认隐藏模式隐藏；不改原生行为 |
| 自定义 MainPanelId / layout.selectPanel | **已解决**：以 sidebar id 与 keyed main 的 `trash` 配对由 owner 导航；不用自有渲染兜底或重复 selectPanel |
| Host Remote 注册/生成 | **已解决**：TypertRemoteService + @Remote + 生成描述；Client $mount 后 ctx.get，位置参数 → named wire |
| storage backend 路由 | **已解决（当前安装/验收版本）**：隔离 DomainFacility 回归与既有真机 marker 写入/清理证据；不是无 backend 的兜底承诺 |
| sidebar 与 main 联动 | **已解决**：四个 slot 注册与 id/key 配对已通过 discovery，既有面板删除验收通过 |
| TS / Client external | **已解决**：tsc + Typert + esbuild；经典脚本内联 codecs/字典，只有工厂中的 React 从浏览器模块表获取，不设置 dsh.client.external |

**待确认（未实施的行为扩展，不阻塞当前交付）**：若后续需要搜索立即收敛/显式 rescan、其它持久化 backend、跨 Client revision、断电级 fsync 或无凭据残留管理，需先确认范围与官方能力，再修改方案和代码。本次未将任何一项视为授权。

## 变更记录（压缩保留关键决策）

全部为 2026-11-22：

- **第 0–3 期已交付**：Host class/domain、五个 Remote、菜单/hover、sidebar/main、确认和双语。Client 挂载前访问/预先 inject 自己的 remote namespace **已废弃**：会死锁或触发 Cordis 注入错误；统一 $mount 后 ctx.get。第 2 期真机入口验收通过。
- **评审修复已交付**：精确补偿、session 队列/全局边界、domain open 重试/卸载、生成器解引用复制、Tooltip Escape。严格持久 `marker ⇒ archived` **已废弃**：原生取消归档绕过插件锁；改可观测交集、前后校验和读取对账。
- **Client 同步修复已交付**：共享 store/写票据/empty 边界、只读 Workspace 基线、迟到帧对账、当前工作区显示。unary archive/unarchive echo **已废弃**：第二次业务写会覆盖后来的操作。侧栏「全部对话」仍显示归档是原生选项，非插件 bug。
- **第 4 期已交付**：旧逻辑移除 **已废弃**，升级为物理删除；官方 flock + intent/rename/close/rm、凭据恢复、必要记录与投影清理。额外猜测 sessions/controller 保留态门禁 **已废弃**：采用已确定的官方持久写锁机制，不猜私有运行态。
- **第 4 期定位/暂存修复已交付**：sessions 根内暂存 **已废弃**：点目录仍被发现，改同设备兄弟暂存；环境变量定位 **已废弃**：Host 不保证有 DSH_HOME，改 stat/source 反推。非法旧凭据保留诊断。
- **持久操作日志已交付**：仅 stdout **已废弃**：桌面 stdout 不落盘；改 stat/source 定位的 logs/trash.log，best effort O_APPEND。第 4 期既有真机两个会话清理及操作日志验收通过，保留其它插件快照。
- **一致性收口已交付**：统一累计实现状态、模型、架构/文件结构、各期与附录；仅定向 detach、locale 单源、死分支/元数据清理。build/test/discovery 隔离通过；未安装、未改核心/profile、未操作真实会话。细目见 `CODEX_CONSISTENCY.md`；历史 CODEX 报告只作当时证据。

## 开源仓库整理 — 已交付（2026-11-22）

### 目标与范围

将已交付插件整理为可公开的 `HLhhh/d-trash` 仓库；当前包名为 `d-trash`，版本保持 0.1.0。只调整包身份、分发元数据、测试夹具与文档，不改变状态、物理删除、日志或授权边界。

### 做法

- 包 manifest、patch、lockfile 同步身份；Client id 复用由 manifest 生成的 contribution.package；自引用测试及 discovery/profile 夹具读取 manifest.name，链接路径不再假定 scope。
- 声明 MIT、repository/homepage/bugs/keywords 和 Node `^22.19.0 || >=24.0.0`，删除 private；peers 使用上述 caret 区间，开发依赖保持精确。区间不是新增真机兼容性承诺。
- `dist/` 随仓库交付，源码仍是唯一真源；移除 dist 忽略，忽略本地 `CODEX_*.md`；files 白名单包含构建资源与公开文档。
- 新增互链的中英文 README、MIT LICENSE（HLhhh 2026）与 Keep a Changelog 格式的 CHANGELOG；保留 DETAIL。

### 验收标准与结果

`npm run build`、`npm test`、`npm run test:discovery` 和 `npm pack --dry-run --json` 全部退出 0。Node 26.10.0 / npm 11.19.1 完成构建和默认回归；安装版 Electron 44.7.0（Node 24.21.0、DSH 0.2.2-rc.5）完成隔离 discovery，确认当时的模块身份、五个 Remote 与四个 slot（历史包身份见 CODEX_OPENSOURCE.md）。37 个真实文件系统场景和 21 个日志场景在 Node / Electron 各通过一次。打包清单共 57 个文件，运行资源、源码、脚本、双语 README/LICENSE/CHANGELOG 完整，本地 CODEX 报告和 node_modules 未分发。profile-boot 仅语法检查，未执行。详细输出保留于本地 CODEX_OPENSOURCE.md。

### 明确不做什么

不 git init/add/commit/push，不发布 npm 或创建镜像，不调用 plugin_manager、不安装/启用/重载 bundle、不改 profile/核心、不操作真实会话。没有本轮真机复验；npm 发布、裸包名所有权与安装版迁移另行处理。

## 包身份最终定名 — 已交付（2026-11-22）

### 目标与范围

公开包身份统一为 `d-trash@0.1.0`，仓库为 `HLhhh/d-trash`。此前候选命名已废弃，因为用户最终确认使用全小写带连字符的 `d-trash`。版本不变；只更新分发身份、展示标题、文档与对应回归。

### 做法

- 同步 package.json 的 name/repository/homepage/bugs、lockfile 两处根 name、patch 的 name、双语 locale meta.title；README 安装命令与所有当前包身份说明保持一致。
- 从 manifest 重建 dist，Host Typert package、Remote contribution.package 和 Client 注册 id 均为 `d-trash`；生成器的临时源码目录仍为 trash，无需改内部路径。
- 保留 domain/table `trash`、domain version 1、Host 服务/typert namespace、五个 Remote 方法和 `trash/*` 路径、patch id、slot id、main key、locale namespace 与 `trash.log`。Host/Client 业务源码未改。
- smoke 显式断言包身份与内部标识；discovery 使用安装版 DomainFacility 和 JsonStorageBackend，在合成临时 home 预置 version 1 的 `trash.json`，验证读取、关闭重开、恢复写回及 purge 凭据保留。

### 验收标准与结果

`npm run build`、`npm test`、安装版 Electron 的 `npm run test:discovery`、`npm pack --dry-run --json` 均通过。pack 使用临时 npm cache，避免默认缓存目录的权限问题。domain 仍为 `trash`，旧 marker 元数据与待删除凭据兼容；不会新建 `d-trash.json`。当前公开文件和生成产物无旧候选名残留，历史 CODEX 记录仅作当时证据；本轮细节见本地 `CODEX_DTRASH.md`。

### 明确不做什么

不改内部 id 或存储 schema，不迁移/读取真实 marker，不执行真实会话删除；不 commit/push、不调用 plugin_manager、不改 profile、不发布 npm。本轮为隔离回归，没有重新执行真机验收。


## Windows 与 DSH rc.2 兼容 — 已交付实现及 macOS 隔离验收（2026-11-23）

### 目标与范围

支持 Windows JSONL 删除并兼容 DSH 0.2.2-rc.2 / rc.5；不改变 d-trash 包身份、trash 内部 id、domain version 1、
Host 独占状态、先日志后记录、失败凭据和保留范围。Windows 原生验收待用户代跑，不计为本轮真机通过。

### 做法

- **POSIX-only 硬拒绝已废弃**：官方 JSONL 的 Windows 写者使用内核信号量。安装版 Electron 44.7.0 / Node 24.21.0
  直接 import 官方 lease.ts 报 ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING，因此实现同名、同签名、同等待/释放语义的 Koffi 租约；
  POSIX 保留官方 flock 与既有 O_NOFOLLOW 文件检查，不使用私有目录锁。官方 open('w') 是截断而非 unlink，本插件不采用该创建/截断行为。
- locate 不依赖锁文件，Windows no-file lease；canonical realpath/lstat 与非零 ino、同设备、intent、最终复核仍强制。
  Windows rename 最多 5 次重试且每次重做全部门禁；rm 有界重试并校验暂存。冲突目标不覆盖、EXDEV 不复制，失败凭据保留。
- Windows 同名信号量不随 rename 移动，恢复时同时检查原 source 和 target。Local 命名空间仅同 Windows 登录会话；
  kernel 对象在最后句柄关闭时销毁，无过期抢锁。仍不保证释放后无 source 重建或跨服务事务；与官方写者协议一致。
- npm pack 获取两版 17 个官方包，对全部 authored sources 比较。Host/persist/domain/Typert、model/feed、catalog、gateway、layout/slots 一致；
  Workspace UI 的 picker factory 与 Sidebar session.action 为 rc.5 新增，不改变本插件四个 slot。
  DSH peers 改 ^0.2.2-rc.2，开发版本继续精确 rc.5；Client 检查读/订阅/replace/follow，缺能力明确拒绝。
- 默认测试不需要 DSH；路径/子进程/junction 支持 Windows。POSIX-only 测试明确 SKIP，新建 Windows 原生用例；
  discovery 由 Node runner 启动 Electron，无安装版变量输出明确 SKIP，有变量时任何失败返回非零。

### 验收标准与结果

macOS build/test/discovery/pack 通过；完整默认 smoke、37 个文件系统场景、21 个日志场景，以及平台 4 项通过/6 项 Windows-only 跳过。
两版真实 peers 分别在临时树完成 tsc/Typert/Client/full smoke 与 feed/model、官方 lease 双向互斥；生成的 Typert 产物相同。
安装版 rc.5 discovery 在 Electron 44 / Node 24 通过；未做 rc.2 Desktop GUI 或本轮真实会话复验。
Windows 自检命令和预期通过/跳过数见 docs/DETAIL.md 的 Windows self-check；调研、包摘要与本轮输出见本地 CODEX_PLATFORM.md。

### 明确不做什么

不改核心/profile、不 install_bundle、不安装/启用插件、不操作真实会话、不发布或推送。不引入其它 backend、私有锁兜底、
超时夺锁或跨设备 copy。Windows 原生结果由用户代跑提供；已有真机记录不作为本轮 Windows/rc.2 GUI 证明。


## 审计日志大小轮转与保留 — 已交付（2026-11-23）

### 目标与范围

为 stat/source 反推 home 的 `logs/trash.log` 增加大小轮转和有限保留。此前「不轮转、无限增长」方案已废弃，因为用户明确要求限制审计历史。
只修改日志实现、既有日志回归、构建产物与文档；包身份、内部 id、物理删除语义及门禁不变。

### 做法

- `src/operation-log.ts` 固定并导出 `MAX_BYTES = 4 * 1024 * 1024`、`KEEP = 3`，不依赖环境变量。
  在现有按路径串行队列内，每次追加前检查活动文件；严格超限时删除 `.3`，逆序 `.2 → .3`、`.1 → .2`、活动 → `.1`，新建 0600 活动文件。
  超限的整行先留在原文件，下一次追加才轮转；最多活动文件加三份归档，约 16 MiB，但大行、失败和跨进程旧句柄可超限。
- 沿用六字段 JSONL；`log-rotate/complete/ok` 记录文件序号、保留范围、实际淘汰项与阈值；失败按实际步骤（含序号）记录到降级 logger，原业务记录单独降级。
  轮转及新建失败不改变成功结果或原异常，logger 也失败时吞掉；后续调用继续尝试。无 fsync/每条必落盘承诺，日志仍不是 purge 凭据。
- 活动和全部归档路径先拒绝 symlink/非普通文件；O_APPEND、单次 write 写完整记录，不截断已有行。
  除 KEEP 明确淘汰的最旧一份，其余轮转行保持原内容；不是跨进程强一致或崩溃原子事务。
- 短时排他创建 `trash.log.rotate` 目录协调协作进程，避免同时轮转覆盖归档；追加不持有 guard。
  忙时最多等待约 480 ms 后降级，不抢占；崩溃可能残留 guard，需确认所有写者停止后人工移除，插件不会猜测失效。
  其它实例旧句柄仍可继续写到已轮转文件，不因 rename 丢行但 `.1` 可能偏大；后续仍按 KEEP 淘汰。
  轮转中失败可能保留部分改名，不危险回滚；重试仍执行相同安全门禁。

### 验收标准与结果

29 个日志场景（原 21 + 8）使用合成临时 home：精确 4 MiB 阈值、下一次追加轮转、三份归档与最旧淘汰、逐行核对完整 JSONL、
归档 symlink 拒绝、轮转/新建失败不改变业务结果与重试、guard 忙降级、四实例加两个子进程并发轮转的 280 条逐行核对、旧句柄跨进程迟到写入 `.1`。
本轮 `npm run build`、`npm test`、安装版 rc.5 Electron 的 `npm run test:discovery`、`npm pack --dry-run` 全部退出 0。Node 与 Electron 各通过 29 项日志回归（0 跳过）和 37 项文件系统回归；平台套件各 4 项通过、6 项 Windows-only 跳过。pack 含 67 个文件且无 CODEX 报告。执行证据保存在本地 `CODEX_LOGROTATE.md`；不将历史真机验收当作本轮复验。

### 明确不做什么

不改 DSH 核心/profile、不 install_bundle、不操作真实会话、不发布或推送；不改包身份与物理删除语义。
不承诺跨进程强一致、硬容量上限或断电事务，不自动清理崩溃残留 guard，不扩大已验证的平台/DSH 版本边界。

## 已删除会话的幽灵记录清理 — 已交付（2026-11-23）

### 目标与范围

修复已物理删除的会话被客户端陈旧列表再次收进后，marker/归档存在而磁盘无日志、再次删除被 gate 拒绝的问题。只调整 Host 首次定位分支及共用记录清理；删除对象、包身份、普通收进/恢复和已有 purge 凭据协议不变。

### 做法

- `locate` 仅把 `stat === undefined` 作为不存在，不吞 stat 抛错、不把无效 snapshot 或文件系统校验错误转成不存在。首次 move 返回 `logs-absent` 前再次检查 marker/归档；后续 locked/intent 复核的 undefined 仍拒绝。
- 幽灵分支跳过日志锁/intent/rename/rm，写 `logs-absent/ok` 及原因，共用 detach 当前所属工作区 → unarchive → 删 marker → 清投影。成功返回 true，empty 计成功；不存在的目录不生成虚构凭据，必要记录失败按实际阶段报告，普通 marker 仍遵守归档对账规则。
- stat/source 校验的 home 在 Host 内缓存复用；重启后可从其它可靠会话/凭据定位投影 home。没有可靠 home 时投影仅 warning、日志降级 logger，不读环境变量或猜会话路径。
- 已有 purge 凭据仍优先校验和恢复；即便 stat 不存在/抛错，也不绕过凭据校验，不自动删除未知暂存。

### 验收标准与结果

新增 `scripts/ghost-regressions.mjs`，接入默认 smoke 和安装版 discovery，18 项在 Node 26.10.0 与 Electron 44.7.0 / Node 24.21.0 / DSH rc.5 各通过一次，均无跳过。覆盖无目录幽灵清理、成功删除后陈旧 re-trash、empty 计数、EIO/抛出的 ENOENT 原错拒绝且磁盘/marker 不变、不可靠 snapshot、marker/归档及交错门禁、取锁后与 intent 后缺失仍拒绝、合法凭据在 stat 抛错时恢复、非法凭据不能走幽灵分支，以及重启 home 定位/无证据降级。

`npm run build`、`npm test`、`npm run test:discovery`、`npm pack --dry-run --json --cache /tmp/d-trash-ghost-npm-cache` 全部退出 0。默认 cache 的首次 pack 因 EPERM 失败，改临时 cache 后通过，未修改用户 cache 权限。Node/Electron 均保留原 37 项文件系统、29 项日志回归；平台各 4 通过、6 项 Windows-only 跳过。discovery 核验官方租约双向互斥、五个 Remote 与四个 slot。打包含新回归脚本且无 CODEX 报告；完整证据见本地 `CODEX_GHOST.md`。

### 明确不做什么

不改 DSH 核心/profile、不 install_bundle、不碰真实会话、不发布或推送；不改包身份、物理删除语义或保留范围，不扩大平台/DSH 验收边界。本轮为合成临时 home 回归，不声称真机 GUI 复验；Windows 原生验收仍待用户代跑。

## 已加载会话的 lock-busy 提示与审计 — 已交付（2026-11-23）

### 目标与范围

用户真机调查确认 DSH 以写句柄持有已加载/已 enter 会话的 `session.lock`，官方无公开卸载 API；拒绝删除属于正确的平台约束。
本次只补可操作的双语提示、稳定错误标记与租约审计条件，更新已知限制、测试和 dist；包身份与删除门禁不变。

### 做法

- Host 的 lock-busy `PurgeError.code` 固定为 `D_TRASH_SESSION_LOCK_BUSY`，消息精确以 `[D_TRASH_SESSION_LOCK_BUSY] ` 开头，保留原阶段、id、原因及 cause。清空遇到此类失败时，汇总也带相同前缀，成功/失败数与逐项错误不丢失。
- Client 仅对删除/清空的此前缀加 locale 中的中英建议：先切换离开到其它会话或重启 DSH 后再试；切换可能仍保留加载/租约，若仍失败请重启。完整底层错误继续显示，不模糊匹配 lock/busy；跨 JS realm 的异常读取字符串 message。
- `unlocked/ok` 显式以已取得租约且 release 成功为条件；取锁失败不写 locked/unlocked。当前工作区原实现已将 finally 放在取得租约后，本次把条件显式化并加落盘回归，不能据此认定真机旧日志来自当前源码。正常路径顺序不变。

### 验收标准与结果

`npm run build`、`npm test`、安装版 rc.5 Electron 的 `npm run test:discovery` 退出 0。Client 覆盖删除/清空、RemoteResult/跨 realm 抛错、即时切换中英文、保留细节/重试和三类非精确标记拒绝识别；真实租约测试覆盖单条/部分清空标记、cause、数据不变、失败无 unlocked 及成功完整顺序。
Node 与 Electron 各通过 30 项日志场景（原 29 + 1，0 跳过）、37 项文件系统与 18 项幽灵记录；平台各 4 项通过、6 项 Windows-only 明确跳过。`npm pack --dry-run` 打包检查结果与命令证据见本地 `CODEX_BUSY.md`，该文件不随包分发。

### 明确不做什么

绝不因锁占用而盲删、unlink 锁文件、强制夺锁或调用私有卸载接口；不改变原生加载/归档行为，不改核心/profile、不 install_bundle、不操作真实会话、不发布或推送。本轮为合成临时 home 回归，用户的真机调查和既有验收单独保留，不声称本轮完成真机复验；Windows 原生仍待用户代跑。
