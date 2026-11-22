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
- **清空回收站**：跨工作区逐条删除，失败条目保留以便重试。
- **审计日志**：以本地 JSONL 记录操作、阶段和失败原因。

全局面板按收进时间倒序显示标题与当前所属工作区，界面支持中英文。

## 安装

需要 DSH **0.2.2-rc.5**、Node **`^22.19.0 || >=24.0.0`**。仓库包含已构建的 `dist/`。

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

删除使用内联确认，可按取消或 Escape 退出。已进入待清理状态的条目不能恢复或重新收进，应重试删除以完成已记录的清理。

## 工作原理

回收站状态只由 Host 服务写入。普通可观测回收站为 **`marker ∩ archived`**：原生归档不会创建 marker；原生取消归档后会话立即退出交集，Host 下次读取时清理滞留 marker。原生归档、置顶行为不变。

物理删除先校验 JSONL 路径和文件系统身份。Host 对既有 `session.lock` 使用官方独占 `flock`，持久化删除 intent，复核身份，将整个会话目录 rename 到 `sessions` 旁的同设备暂存目录，关闭锁后再删除暂存。之后清理工作区成员、归档和 marker，并尝试清理投影缓存。失败保留持久凭据，下次删除或清空时重试；待清理诊断独立于普通回收站交集展示。

完整协议和恢复边界见 [DETAIL.md](./docs/DETAIL.md) 与 [PLAN.md](./PLAN.md)。

## 兼容性

| 组件 | 要求 / 已验证边界 |
| --- | --- |
| DSH | 已验证 **0.2.2-rc.5**；DSH peer 声明为 `^0.2.2-rc.5` |
| Cordis | peer `^4.1.0` |
| 原生文件系统支持 | `@deepseek-ai/node-addon-system` peer `^0.1.2` |
| Node.js | `^22.19.0 || >=24.0.0` |
| Host 平台 | 已验证 macOS；删除要求 POSIX 与官方原生 flock 支持；不支持 Windows |
| 会话 backend | 物理删除仅支持 JSONL；缺锁或路径、身份不可靠时拒绝 |

peer 区间允许兼容更新，不代表后续 DSH 版本已验收。升级后应复核 Client 工作区投影和原生锁。

## 已知限制

- 保留附件、工作区文件、Git worktree、产物、服务端日志、备份及其它插件快照。
- 不承诺安全擦除；搜索结果依赖 DSH 既有同步收敛，不保证立即消失；投影缓存清理失败只记 warning。
- 回收站会话仍属于归档集合，原生「显示已归档 / 全部对话」视图仍可显示。
- 操作不是跨服务或跨进程事务。凭据支持进程崩溃后恢复，不保证断电级目录 `fsync`；无凭据的陌生暂存目录保留。
- 审计日志为 best effort，无轮转、大小阈值和保留策略；缺少日志不能证明操作没有发生。

## 审计日志

路径为 **`<home>/logs/trash.log`**，通常是 **`~/.dsh/logs/trash.log`**。Host 从 persistence stat/source 路径反推并校验 home，不读取 `DSH_HOME` 环境变量；自定义 home 时，下列命令应使用对应路径。

每行 JSONL 固定包含 **`ts`**、**`action`**、**`sessionId`**、**`stage`**、**`result`**、**`reason`**。`ts` 为 ISO 时间；无原因时 `reason: null`，清空汇总使用 `sessionId: null`。action 包括 `trashSession`、`restoreSession`、`removeFromTrash`、`emptyTrash` 和 `recovery`。

```sh
tail -f ~/.dsh/logs/trash.log
grep '"result":"failed"' ~/.dsh/logs/trash.log
grep '"action":"recovery"' ~/.dsh/logs/trash.log
```

日志失败降级到 Host logger，不改变主操作结果。该文件用于诊断，不是物理删除的业务凭据存储。

## License

[MIT](./LICENSE) · Copyright (c) 2026 HLhhh。
