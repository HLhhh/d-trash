# 变更记录

本项目所有值得记录的改动都写在这里。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

[English](./CHANGELOG.md)

## [Unreleased]

### Added

- 回收站每行现在显示紧凑的等宽会话 ID，悬停可查看全文并支持一键复制。剪贴板失败时显示可读原因，并在只读输入框中选中完整 ID 供手动复制。Client 回归覆盖中英反馈、完整 ID（含 `im-link:` ID）、降级、定时确认与卸载清理；Host API 与删除行为保持不变。

- 回收站每行可按次选择 agent，将只读会话提炼为 Markdown，行内显示进度、重试和可选中的文件路径。输出目录可配置（默认源 cwd/d-trash-distill）；缺少执行服务时提供明确标识的手动提示词导出。rc.5 隔离探针及双语回归覆盖源状态保留、与源写锁共存、并发和取消；真实模型/preset 及 GUI 验收仍待进行。

### Changed

- 会话现在可移入 macOS 废纸篓 / Windows 回收站，清空也逐条移入，可在系统层面恢复。同卷原生移动保留安全门禁、可重试的源路径 intent 与旧 staging 凭据恢复；其它平台和跨卷明确拒绝，不 copy 或删除兜底。macOS 不调用 Finder 自动化，不保证「放回原处」元数据。中英 UI 与文档同步；隔离回归覆盖失败、崩溃、占用排队、旧凭据和批量汇总。真实系统回收站 GUI 验收仍待进行。

- 文档：历史第 4 期 Windows GUI 删除流程记为维护者真机验证（2026-11-25，安装、侧栏入口、收进回收站、恢复、彻底删除、清空均在原生 Windows 上可用）。6 项 Windows 专属原生回归用例与 rc.2 桌面 GUI 仍未运行，兼容性表、方案与项目说明已写明这条界线。

- 变更记录改为双语：`CHANGELOG.md`（English）与 `CHANGELOG_zh.md`（简体中文）作为同一份记录维护，结构与条目顺序一一对应。任何改动都必须在两个文件的 `[Unreleased]` 下各补一条；发版清单（升版本、打 tag、建 GitHub Release）已写进 `AGENTS.md`。

## [0.2.0] - 2026-11-25

Windows 支持、DSH 长期加载会话的排队删除、审计日志轮转、Client 清理通知（解决删除后又出现在「未分组」），
以及 DSH 0.2.2-rc.2 兼容。

### 修复

- 物理删除与幽灵记录清理成功后，在删 marker 之后 best-effort 发出公开的 `api-session/removed(sessionId)` 事件，清掉仍驻留在 Client catalog 中的陈旧行——否则它会在「未分组」重新出现。删除失败、排队、仅恢复暂存日志都不发；监听器抛错只记 `removed/warning`，不改变删除结果与清空成功数。新增 14 项合成临时 home 边界回归，以及安装版 rc.5 的 Host Gateway → Client 事件泵/catalog → Workspace 侧栏树复现（送达前该行仍在，送达后消失）。通知仍是不重放的 best effort。
- 锁忙错误带固定前缀 `[D_TRASH_SESSION_LOCK_BUSY] `；下面的排队删除取代了早先「手动重启重试、把 busy 计为失败」的做法。审计中的 `unlocked` 只在真正取到租约且成功释放后才记录，并补了真实租约/审计回归与精确前缀的 Client 回归。
- 删除/清空现在能清理「marker 还在、日志已不存在」的幽灵记录：首次 `stat` 明确返回 `undefined` 且 marker/归档门禁成立时，跳过日志删除、记 `logs-absent`、detach 当前归属、取消归档、删 marker、用已校验的 home 尝试清投影缓存。`stat` 抛错（含 I/O 故障）、快照不可靠、后续持锁复核才发现缺失，仍然拒绝清理。既有 purge 凭据的校验与恢复保持不变。新增幽灵记录、拒绝、交错与恢复回归（Node 与安装版 Electron）。

### 新增

- 锁忙会话的排队删除：marker 上私有 `deferredAt`、固定前缀 `[D_TRASH_DEFERRED] ` 的排队确认、中英双语「待删除」状态，以及「恢复」只取消排队并保留普通回收站状态。Host 启动时的后台维护会带着既有门禁与写租约重试；仍忙则保留到下次启动，服务未就绪按退避重试，purge 凭据与排队彼此独立。审计新增 `deferred` 与 `startup`；清空区分为已删除、失败、排队三个数。
- 审计日志按大小轮转：固定 4 MiB / 保留三份、写轮转记录、文件安全校验、失败仅降级 logger。
- Windows 写互斥：经 Koffi 3.1.1 使用与 JSONL backend 同名的内核信号量，不要求 `session.lock` 文件。
- Windows 共享冲突有界重试：每次重试都复核身份与归档门禁并保留可重试凭据；另加平台测试的明确跳过项与跨平台 discovery 启动器。
- rc.2 / rc.5 的打包 API 与隔离构建/测试兼容矩阵、官方租约互通探针，以及 Windows 自检说明。

### 变更

- DSH peer 下限改为 `^0.2.2-rc.2`；开发依赖仍锁 rc.5。不声称 rc.2 桌面 GUI 或 Windows 原生验收。
- 定位与审计日志不再依赖锁文件；POSIX 删除仍要求既有的官方 flock inode，Windows 从不加载该 addon。

## [0.1.0] - 2026-11-22

### 新增

- Host 侧回收站 marker、原生归档集成、恢复、读取对账与操作串行化（第 1 期）。
- 会话右键菜单与 hover 动作、生成的 Typert Remote 集成、中英双语 UI（第 2 期）。
- 全局侧栏/面板入口、所属工作区显示、共享 Client 状态、刷新与内联删除确认（第 3 期）。
- 本地 JSONL 会话日志物理删除与清空回收站：官方 flock、同设备 rename 暂存、持久化凭据、崩溃恢复与可重试的部分失败（第 4 期）。
- best-effort 的持久 JSONL 审计日志，含操作阶段与失败原因。
- Host/Client、文件系统、恢复、审计日志与安装版运行时 discovery 的隔离回归。
- MIT 许可、双语安装与使用文档、公开仓库元数据，以及随仓库分发的 `dist/` 构建产物。

### 变更

- 用 `d-trash` 取代本地占位包名；Client 注册与测试夹具改为从 manifest 或生成的 contribution 推导包身份。
- 改用 caret peer 区间，同时保持开发依赖精确锁定；DSH 0.2.2-rc.5 仍是已验证边界。

0.1.0 记录已交付的功能与仓库准备；npm 发布与公开 Release 是另外的步骤。0.2.0 是第一个带 tag 的公开发布。
