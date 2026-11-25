# Trash 插件（DSH 会话回收站）

## 项目是什么

DSH 插件 bundle：给会话加「收进回收站」动作，把历史对话收进独立的「回收站」，左侧栏显示回收站列表，支持恢复 / 彻底删除 / 清空（第 4 期起物理删除）。

- 形态：Host + Client 两半，安装到 desktop profile；公开包名 `d-trash`，仓库 `HLhhh/d-trash`，MIT。
- 方案唯一来源：`PLAN.md`。方案变了原地改 PLAN.md，不新开文件；每期写清目标/范围/做法/验收标准/明确不做什么。

## 技术约定

- **TypeScript**（`strict`、ESM、JSON module），`src/` → `dist/`；`npm run build` / `pnpm build` = `tsc` → Typert 生成 → Client 内联打包。
- **Host**：`src/index.ts`，面向对象——`export default class TrashService`（service class），领域对象用 `interface`/`enum` 建模。
- **Client**：`src/client.ts`，**React 函数组件 + hooks**（DSH 惯例），经 `window.__ModuleLoader__.load` 惰性工厂注册 slot。
- DSH 服务经 `inject` / `ctx.get` 声明；不 `require` DSH 内部 Client 包，不写 DOM 到 `document.body`，样式用 `--dsw-alias-*` theme token，文案走 `locale`。
- UI 文案以 `locale/en.json`、`locale/zh.json` 为唯一源，`src/client-copy.ts` 只复用字典/推导类型；不要另写一份文案。当前隔离 API/build/test 兼容边界为 DSH `0.2.2-rc.2` / `0.2.2-rc.5`，安装版 discovery 为 rc.5；Windows 原生代跑尚待用户完成。
- 涉及 DSH 的 API 事实，先 runtime inspect（`cordis_inspect_query`）或读 `dsh-doc` 技能，不凭记忆。

## 领域不变量（改代码前必读）

1. 回收站状态**只能经 Host `TrashService` 写入**，UI 不得直接改集合。
2. **三态非对称**：可观测回收站 **`trash = marker ∩ archived`**；原生「归档」**不碰** marker 集合。原生取消归档不经过插件锁，所以持久 marker 允许短暂滞留，由 Host `listTrash` 对账清理。`trashSession` 写 marker 前后都校验归档，发现已取消归档则删 marker 并报错。旧的「持久集合始终 trash ⇒ archived」表述**已废弃**（第二轮评审 B1：插件无法约束原生交错写入）；这不授权修改原生行为。
3. 当前「彻底删除 / 清空」均物理删除本地会话日志，不可恢复；第 1–3 期旧逻辑移除实现**已废弃**，因为第 4 期升级了删除语义。普通收进/恢复仍保留日志与原工作区位置。附件、工作区文件、worktree、产物、服务端日志、备份及其它插件快照均保留。
4. 物理删除只经 Host；`stat` 定位并反推 home，不读环境变量 `DSH_HOME`；realpath/dev/ino 校验、backend 兼容写租约（POSIX：既有 `session.lock` 官方 flock；Windows：同名内核信号量，无文件足迹）→ 持久 intent/最终复核 → 整体 rename 到 sessions 根的同设备兄弟暂存 → close → rm，持锁不得 unlink 锁文件；locate 不依赖锁文件，POSIX 取锁仍必须有既有普通文件。Windows rename 的有界重试每次复核门禁，失败保留凭据；不作跨设备 copy 兜底。先删会话日志，再清必要记录；detach 只针对当前含该 session 的工作区并记录实际尝试，失败逐项汇总。失败保留 marker 内的 purge 凭据，下次 purge/empty 恢复。待删除诊断记录可带 `purgePending` 独立于归档展示，不属于普通 trash 交集；不得被 list 对账、restore 或 re-trash 丢弃。无凭据的暂存目录不猜测删除。
5. **不修改**原生归档/置顶按钮与行为，只新增入口。
6. 持久操作日志路径为 stat/source 反推的 `<home>/logs/trash.log`，JSONL 字段 `ts/action/sessionId/stage/result/reason`；best effort，不是 purge 凭据。不得因日志失败改变主操作结果；投影缓存失败仅 warning，索引依赖已有同步，不扩大清理范围。

## 授权边界

`plugin_manager` 安装/启用 bundle、改 profile 状态、物理删除真实会话日志等操作，先向用户确认再执行。回归使用合成临时 home；测试许可不等同于修改 profile 或清理真实会话的许可。

## 交付与流程

- `dist/` 随仓库提交，源码为唯一真源；改源码后重建产物。`CODEX_*.md` 仅本地保留，由 `.gitignore` 排除。
- 包身份优先读取 `package.json` 的 `manifest.name`；Client id 复用由 manifest 生成的 contribution.package；测试链接路径兼容无 scope 名称。peers 使用 caret 区间，开发依赖保持精确；声明区间不扩大已验证的 DSH 版本边界。
- 公开入口为互链 README.md / README_zh.md；许可证与 package.json 一致，版本变更同步 CHANGELOG.md。

- 推远程走 PR，不直接推 main；分支用完即删（沿用工作区规则）。
- 每期做完标「已交付」，被推翻的标「已废弃」并留一句为什么。
- 第 0–4 期及日志已交付；既有真机验收与本轮隔离回归分别记录，不把历史「待重载」当作当前状态，也不声称本轮完成了真机复验。

## 更新日志（CHANGELOG，强制）

**每次改完代码/文档，都要在 `CHANGELOG.md` 与 `CHANGELOG_zh.md` 的 `## [Unreleased]` 下各补一条，中英一一对应。**

- 两个文件是同一份记录的双语版本，结构（`### Fixed` / `### Added` / `### Changed`）与条目顺序必须一致；改了一边必须同步另一边，不允许只写一种语言。
- 条目的「是什么」以用户可见行为开头，再写边界与验证；不要只写「修了 bug」。
- 修改已有条目时两边一起改，不要长期留下一处过时描述。
- 发版时：把 `[Unreleased]` 改名为 `## [x.y.z] - YYYY-MM-DD`、升 `package.json` / `package-lock.json` 版本、`git tag vX.Y.Z`、在 GitHub Releases 贴同一段说明，并在两文件顶部各留一个新的空 `[Unreleased]`。
- 细节技术说明放 `docs/DETAIL.md`；`CHANGELOG` 只写改了什么、影响谁。
