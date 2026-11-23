# d-trash

[English](./README.md) · [技术细节](./docs/DETAIL.md) · [变更记录](./CHANGELOG.md)

GitHub 主仓 · [Gitee 镜像](https://gitee.com/huang-lin-java/d-trash)

为 DeepSeek Harness（DSH）提供独立的会话回收站，支持恢复与永久删除本地会话日志。

## 解决什么问题

历史会话越来越多，侧栏难以整理。原生归档可以隐藏会话，但没有独立的回收站。`d-trash` 提供集中查看、恢复或删除本地日志的入口。

## 功能

- **收进回收站**：从会话右键菜单或悬停按钮收进，保留日志和工作区成员位置。
- **恢复**：取消归档，保留当前工作区位置。
- **彻底删除**：确认后物理删除本地会话日志并清理必要记录，不可恢复。
- **占用时排队**：重启 DSH 后自动重试删除；恢复可取消排队。
- **清空回收站**：跨工作区逐条删除，汇总区分已删除、已排队与失败数。
- **审计日志**：以本地 JSONL 记录操作、阶段和失败原因。

全局面板按收进时间倒序显示标题与当前所属工作区，界面支持中英文。

## 安装

支持 DSH **0.2.2-rc.2 与 rc.5**、Node **`^22.19.0 || >=24.0.0`**。仓库包含已构建的 `dist/`。

使用本地 checkout：

```sh
git clone https://github.com/HLhhh/d-trash.git
cd d-trash
npm install
```

可直接使用随仓库提交的 `dist/`。修改源码或需要重新生成产物时，安装前执行一次 `npm install && npm run build`。

打开 DSH **Plugins → Add plugin**，填写 checkout 的绝对目录路径（在 checkout 中运行 `pwd` 获取）。GitHub 仓库公开后，也可填写 git 规格 **`github:HLhhh/d-trash`**。

Agent 可使用 **`plugin_manager` → `install_bundle`**，将 `target` 设为同一绝对目录或 git 规格。选择目标 profile，并按管理器返回的结果启用或重启。安装会影响该 profile 的所有会话。

这些说明不假定已发布 npm 包；确认本项目拥有 npm 裸名并完成发布前，请勿直接从 registry 安装 `d-trash`。

## 使用

| 入口 | 操作 |
| --- | --- |
| 会话右键菜单 → 收进回收站 | 归档并写入回收站标记 |
| 会话行悬停 → 垃圾桶按钮 | 收进回收站 |
| 左侧栏 → 回收站 | 打开全局回收站面板 |
| 面板 → 恢复 | 返回普通会话列表 |
| 面板 → 彻底删除 | 确认后永久删除该会话的本地日志 |
| 面板 → 清空回收站 | 确认后永久删除全部回收站会话 |
| 面板 → 刷新 | 重读列表和工作区投影 |

删除使用内联确认，可按取消或 Escape 退出。排队条目显示「待删除（重启 DSH 后自动完成）」；点恢复只取消排队，仍保留在回收站，日志、归档和工作区归属不变，再次恢复则按普通流程取消归档。已开始物理删除、带 purge 凭据的条目禁用恢复，应重试删除以完成清理。

## 工作原理

回收站状态只由 Host 服务写入。普通可观测回收站为 **`marker ∩ archived`**：原生归档不会创建 marker；原生取消归档后会话立即退出交集，Host 下次读取时清理滞留 marker。原生归档、置顶行为不变。

物理删除先校验 JSONL 路径和文件系统身份。Host 使用与 backend 兼容的写租约：POSIX 对既有 `session.lock` 使用官方 `flock`，Windows 经 Koffi 获取同名内核信号量，持久化删除 intent，复核身份，将整个会话目录 rename 到 `sessions` 旁的同设备暂存目录，关闭锁后再删除暂存。之后清理工作区成员、归档和 marker，并尝试清理投影缓存。失败保留持久凭据，下次删除或清空时重试；待清理诊断独立于普通回收站交集展示。

客户端陈旧列表可能把已删除的会话再次收进回收站。首次 `stat` 明确返回 `undefined` 时，只有 marker 存在且仍归档才允许清理幽灵记录：跳过日志删除，依次 detach 当前所属工作区、取消归档、删 marker、尝试清投影；删除成功返回 `true`，清空计为成功，并记录 `logs-absent` 阶段及原因。`stat` 抛错（含 I/O 故障）、header.id 不符、非 JSONL、相对路径或缺失 location 仍拒绝清理。已有 purge 凭据始终按原协议校验、恢复。投影清理复用已校验的 stat/source home 或其它可靠会话的 home；无可靠 home 时只记 warning，审计日志降级 Host logger，不猜路径。

完整协议和恢复边界见 [DETAIL.md](./docs/DETAIL.md) 与 [PLAN.md](./PLAN.md)。

## 兼容性

| 组件 | 要求 / 已验证边界 |
| --- | --- |
| DSH | 已完成 **0.2.2-rc.2 / rc.5** 隔离 API、构建、回归矩阵；peer `^0.2.2-rc.2`；安装版 discovery 为 rc.5 |
| Cordis | peer `^4.1.0` |
| 原生文件系统支持 | POSIX：`@deepseek-ai/node-addon-system` peer `^0.1.2`；Windows：运行依赖 `koffi` 3.1.1 |
| Node.js | `^22.19.0 || >=24.0.0` |
| Host 平台 | macOS 隔离回归通过；已实现 Windows，原生 Windows 验收待用户代跑 |
| 会话 backend | 物理删除仅支持 JSONL；POSIX 要求既有锁文件，Windows 无锁文件要求；路径、身份不可靠或原生互斥不可用时明确拒绝 |

本轮未做 rc.2 Desktop GUI 或 Windows 真机验收。[Windows 自检命令](./docs/DETAIL.md#windows-self-check) 只使用合成临时 home。

peer 区间允许兼容更新，不代表后续 DSH 版本已验收。升级后应复核 Client 工作区投影和原生锁。

## 已知限制

- 已加载/已 enter 的会话可能长期由 DSH 持有写租约。删除/清空遇到 lock-busy 会先排队，保留日志、归档和工作区归属；重启 DSH 后 Host 自动重试，若仍 busy 则保留到下次启动，也可手动再次彻底删除。启动扫描在后台执行，服务未就绪时退避重试，其它错误按阶段报告。官方无公开卸载/close API；插件不释放其它所有者的句柄，不绕过租约、不 unlink 活锁文件、不夺锁。
- 保留附件、工作区文件、Git worktree、产物、服务端日志、备份及其它插件快照。
- 不承诺安全擦除；搜索结果依赖 DSH 既有同步收敛，不保证立即消失；投影缓存清理失败只记 warning。
- 回收站会话仍属于归档集合，原生「显示已归档 / 全部对话」视图仍可显示。
- 操作不是跨服务或跨进程事务。凭据支持进程崩溃后恢复，不保证断电级目录 `fsync`；无凭据的陌生暂存目录保留。
- 审计日志为 best effort：超过 4 MiB 后在下一次追加前轮转，保留三份归档（`trash.log.1`–`.3`），约 16 MiB 历史但可能超限；缺少日志不能证明操作没有发生。

## 审计日志

路径为 **`<home>/logs/trash.log`**，通常是 **`~/.dsh/logs/trash.log`**。Host 从 persistence stat/source 路径反推并校验 home，不读取 `DSH_HOME` 环境变量；自定义 home 时，下列命令应使用对应路径。

每行 JSONL 固定包含 **`ts`**、**`action`**、**`sessionId`**、**`stage`**、**`result`**、**`reason`**。`ts` 为 ISO 时间；无原因时 `reason: null`，清空汇总使用 `sessionId: null`。action 包括 `trashSession`、`restoreSession`、`removeFromTrash`、`emptyTrash`、`recovery`、`startup` 和 `log-rotate`。排队记 `deferred/ok`，清空汇总区分已删除、失败和排队数；稳定 wire 前缀 `[D_TRASH_DEFERRED] ` 在界面展示为「已排队」状态。

```sh
tail -F ~/.dsh/logs/trash.log
grep -h '"result":"failed"' ~/.dsh/logs/trash.log ~/.dsh/logs/trash.log.[123]
grep -h '"action":"recovery"' ~/.dsh/logs/trash.log ~/.dsh/logs/trash.log.[123]
```

固定常量为 `MAX_BYTES = 4 * 1024 * 1024`、`KEEP = 3`，不读取环境配置。轮转在同进程共享的按路径队列内完成，删除 `.3` 后逆序移动归档，新建 0600 活动文件（POSIX），并以 `log-rotate` 记录序号及结果。仅按策略淘汰最旧一份，其余行只改名保留，不截断。

这不是跨进程强一致：其它实例已持有的旧句柄可继续将完整行写入轮转文件，使 `.1` 偏大。短时 `trash.log.rotate` 目录协调协作进程的轮转；guard 忙或崩溃残留时有界等待后降级 logger，不自动抢占。恢复与并发边界见 [DETAIL.md](./docs/DETAIL.md)。归档尚未生成时，glob 命令可能提示文件不存在。

日志失败降级到 Host logger，不改变主操作结果。该文件用于诊断，不是物理删除的业务凭据存储。

## License

[MIT](./LICENSE) · Copyright (c) 2026 HLhhh。
