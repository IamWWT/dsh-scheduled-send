## 0.10.6 — 2026-10-27 默认模型配置恢复

- 恢复默认时清除基线之外新增的任务模型覆盖；新增回归验证。
- 包含 0.10.5 的公开会话导航和归档保护、暂停/恢复能力。

## 0.10.5 — 2026-10-27 真实宿主导航修复

- 任务的「打开会话」迁到当前公开 `uiWorkspace.openSession`；旧 `sessions.open` 已不存在，不再静默隐藏按钮。
- 包含 0.10.4 周期任务归档保护、默认恢复与预置暂停/恢复。

## 0.10.4 — 2026-10-27 周期任务归档保护、暂停与默认恢复

- 核实官方 `workspace/session-stop` 会删除关联任务；周期配置快照识别已归档来源，通过公开服务迁到新任务会话，避免任务永久消失。一次性任务、显式删除、截止到期维持原语义。
- 预置基线持久化，任务页加入恢复默认配置预览与确认；先备份，只重置/补齐预置项并保留暂停状态。
- 预置任务以暂停/恢复替代删除；暂停状态跨重启，恢复不重复创建，已有模型执行继续完成。
- 保留 0.10.3 的 `sessions` 注入修复，增加公开 `workspaceRegistry` 依赖；所有新增端点保持鉴权。

## 0.10.3 — 2026-10-26 修复「现有会话」创建路径

用户报告（生产）：定时任务表单选「现有会话」保存必报
`cannot get property "sessions" without inject`。

- 根因：`host/bridge.ts` 解析「现有会话」目标时读取 `ctx.sessions`，
  但 `src/index.ts` 的 `export const inject` 未声明 `sessions`——违反本仓铁律 6
  （Host 侧 `ctx.*` 取用的服务必须 inject 声明），宿主拒绝向该 Context 提供该服务，
  属性访问即抛错。`?.` 可选链拦不住：错误发生在属性 getter 上，不在调用上。
  「发送到→现有会话」自引入该路径起 100% 不可用（API 与 UI 同因）。
- 修复：`inject` 补 `"sessions"`（一行）；行为无其他变化。
- 验证口径：安装重启后对活实例 `POST /api/scheduled-send/tasks`
  带 `sessionId` 应返回任务对象（旧版返回 `ok:false` + 上述报错）。

## 0.10.2 — 2026-10-26 官方壳层 UI 移交 dsh-ui-shell

用户要求：把「改官方 UI」的那部分从本插件摘出去，集中到一个 UI 插件管理。

- 移除 `sidebar.brand.name` / `sidebar.brand.mark` 两处注册与 `BrandHidden` / `BrandShift` 组件、
  `.dss-logo-shift` / `[data-dss-brand]` 样式：品牌区隐藏与「收起侧栏」按钮落位改由
  **`dsh-ui-shell` 0.1.0** 接管（同一 single 插槽只应有一个占位者，避免多插件抢注）。
- 本插件此后只注册自己的业务插槽：`sidebar.panellist`（定时任务页）、`main`、
  `conversation.input.right`（⏰ 定时）、`conversation.input.dock`（一次性任务 dock）、
  `settings.section`。
- 行为不变：外观与 0.10.1 一致，差异只在归属。

## 0.10.1 — 2026-10-26 输入框 dock 只展示一次性任务

用户反馈（生产）：新开一个对话框，顶部的「定时任务（1）」就跟着出现（月报任务），
周期任务常驻会话输入框上方，任务一多后续会话就乱。

- 根因：dock 过滤只按 `sessionId + status=active`，不看频率；月报任务的投递会话恰好是
  用户新开的那个会话，于是周期任务被渲染出来。
- 新增共享判定 `isOneShotFrequency()`（`once` / `after` 为一次性；`every`/`daily`/`weekly`/`cron`
  为周期）；dock 过滤改为 `sessionId + active + 一次性`，周期任务不再进入 dock，统一在
  「定时任务」页管理。
- 回归：`test/ui-hooks-regression-test.mjs` 补 dock 用例（同一会话下周期任务不渲染、
  一次性任务渲染）——不靠人工看图。

## 0.10.0 — 2026-10-26 预置任务 / 自定义任务分组

用户需求：页面区分「插件默认定时任务」（如工作台四报：日报/周报/月报/年报）与用户自建任务，
tab 切换展示。

- 元数据/契约新增 `builtin` 标记：`TaskCreateRequest.builtin`（脚本/集成方创建时声明；
  UI 新建恒为用户任务）、`TaskUpdateRequest.builtin`（切换归属）、`TaskView.builtin`（列表透出）。
- 任务页头部新增 tab：「自定义任务（n）/ 预置任务（n）」；统计徽章、待执行/已结束分组、
  清理已结束均作用于当前 tab；预置 tab 空态给出 builtin=true 创建口径说明。

## 0.9.5 — 2026-10-26 收起按钮与新会话按钮并排（不重叠）

用户反馈（生产）：收起按钮叠在「新会话」按钮右端，两个框重叠难看。

- 新会话按钮经 `.dss-logo-shift + button` 让出右端 40px；收起按钮绝对定位落进该空档
  （`top:calc(100% + 9px); right:0`，与其垂直居中对齐）——两按钮矩形不相交。
- 隔离 3084 + 生产 3082 Playwright 断言：对齐、不重叠、折叠轨道标识可见、点击可展开、console 零报错。

## 0.9.4 — 2026-10-26 折叠轨道恢复「展开侧栏」可见标识

用户反馈（生产）：侧栏折叠后顶部展开按钮没有可见标识（悬停才有），不友好。

- 根因：轨道展开按钮的 railMark 与品牌区共用 `sidebar.brand.mark` 插槽，0.9.2 把 mark 注册成空
  实现时一并清掉了它。
- mark 插槽改渲染面板线条图标（`data-dss-brand="mark"`），CSS 按容器区分：默认隐藏（展开态品牌区），
  `[class*="railMark"]` 内显示（折叠轨道）；悬停换官方 panelIcon 的行为不受影响。

## 0.9.3 — 2026-10-26 收起按钮并入「新会话」行

用户反馈：品牌区移除后顶行空着，「收起侧栏」按钮应放到「新会话」旁边。

- 官方对收起按钮/新会话行**没有插槽**，实现为：`sidebar.brand.name` 注册 `BrandShift` 组件，
  挂载 effect 用自身 DOM 位置 `closest('div[data-window-drag]')` 找到 logoRow 打标记类
  `dss-logo-shift`（卸载即摘除），纯 CSS 压扁顶行（60→14px）并把收起按钮绝对定位到新会话行右端。
- **不搬 DOM 节点**（手动移动会被宿主折叠动画重渲染吞掉）；`:has([data-dss-brand])` 排除品牌按钮，
  macOS 顶栏布局（收起按钮不在 logoRow）自动不命中、不移位。

## 0.9.2 — 2026-10-26 品牌区整块移除

用户反馈：0.9.0 的「收缩成一行」不算去掉，要求彻底移除左上角 DSH 构建标识。

- `sidebar.brand.name` / `sidebar.brand.mark` 注册空实现（`BrandHidden`），「DSH · 本地构建」与
  版本徽标整块不再占纵向空间；外层品牌按钮（点击=新会话）由官方容器保留，功能无损失。
- 构建门禁新增 `sidebar.brand.name|mark` 插槽断言；桌面版装了 ui-brand-official 时让位（catch 跳过）。

## 0.9.1 — 2026-10-26 弹窗高度修复

用户反馈（生产）：「添加定时任务」弹窗在常见视口下过高，底部「取消/创建任务」被屏幕裁掉。

- `.dss-modal` 改 `max-height:calc(100vh - 48px)` + `overflow:hidden`；
  表单容器加 `dss-modal-form`（`flex:1;min-height:0;overflow:auto`）——**表单区内部滚动**；
  `.dss-modal .dss-actions` 改 `position:sticky;bottom:0`（带背景）——**按钮恒可见**。
- 提示词 textarea 默认高度 120→88px，减少滚动需求。
- 隔离实例复验（1440×960）：弹窗完整含按钮一屏出镜，截图 `screenshots/03-create-dialog.png`。

## 0.9.0 — 2026-10-26 事件形状修复 + 目标会话/preset/模型

**修复（生产实测定位）**：`session/event` 的 `user/message` 载荷把 `content/source` 直接挂在
`data` 下（`assistant/message` 才有 `data.message`）；0.8.x 按 `data.message` 解析导致执行状态
全链路静默（`lastExecution` 不写、notify 不推）。`bridge.ts` 改读 `data.message ?? data`；
smoke-test 新增真实形状回归用例（turn/start→schedule 投递→assistant→turn/end →
ExecutionUpdate + meta 写回）——此链路此前无离线覆盖，是漏检根因。

**新增（用户需求：WorkBuddy 式表单补齐三项控制）**

- **发送到**：`新建任务会话`（选工作区，行为同前）/ `现有会话`（会话下拉，来自
  `sessions.list.getSnapshot()` 活读，含标题与当前 preset 展示）。
- **Agent 模式（preset）**：仅新会话可选（官方 `SessionCreateRequest.agentPreset` 创建时一步绑定；
  现有会话 preset 首轮后锁定，表单只读展示）。清单数据源 `remote.agentPresets.list`（8s 超时 +
  失败降级"留空用默认"）。
- **执行模型**：下拉数据源 `remote.session.modelCatalog`（10s 超时）；保存时经公开方法
  `sessionController.selectModel` 应用到绑定会话（与手动切换同链路，**会同步更新全局默认模型**，
  表单已注明）；模型不可用即创建失败，不建半坏任务。meta 记 `model {provider,model,label}`，
  列表行展示模型徽章；编辑可换模型，`model:null` 仅清记录不回滚。
- 类型面：`ModelRef`、`TaskCreateRequest.agentPreset/model`、`TaskUpdateRequest.model`、
  `TaskView.agentPreset/model`；`SessionControllerLike` 补 `agentPreset?` 与 `selectModel?`。
- client `inject` 增 `remote.agentPresets`、`remote.session`。
- **品牌区收缩**（用户反馈：左上角「DSH 本地构建 + 版本徽标」两行占纵向空间）：注册 single 插槽
  `sidebar.brand.name` 为一行紧凑文字（官方外层「点击=新会话」保留）；已有占位者（如桌面版
  `ui-brand-official`）时让位跳过。`sidebar.brand.name` 进产物门禁。

## 0.8.1 — 2026-10-26 隔离实测修复

- **工作区下拉实时化**：注册时静态快照在启动早期为空 → 「没有可用工作区」。改为 `entry.ts`
  提供 `getWorkspaces()` 活读器（每次渲染 `ctx.get("workspaces")?.list.getSnapshot()`），
  `TaskModal` 用活读器取目标工作区列表。
- **验证收口**：Playwright（3084 隔离实例）确认侧栏「定时任务」出现、官方「自动化任务」隐藏、
  建表单条任务成功、console 零报错；`scripts/e2e-3082.mjs` 重写为新 `/tasks` 契约
  （token→cookie 原生鉴权、create/list/update/delete 探针），对隔离实例全通过。
- 删除旧自建调度器残留 `src/host/scheduler.ts`（0.7.x 形态退役）。

## 0.8.0 — 2026-10-26 复活重构：调度整体复用官方 Schedule 服务

需求（用户）：像 WorkBuddy 一样按「名称/提示词/频率/有效期/工作区/通知」定时执行提示词，
并把执行状态经 dsh-notify-alert 推到微信；官方「自动化任务」UI 不再展示，日常用本插件。

- **引擎替换**：删除自建定时器/队列表，任务真身 = 官方 `ctx.schedule`
  （`at/after/every/daily/weekly/cron`，`catalog/create/update/delete/deleteInactive/history`），
  持久化、重启恢复、错过补投、会话投递全部复用官方实现；插件只做控制面。
- **新表单与页面**（WorkBuddy 式）：`TaskModal`（名称/提示词/频率 5 种/有效期/工作区/通知勾选/
  展示性「允许完全访问」说明）；主页面 `TaskPage`（统计 + active 列表 + 已结束折叠 + 一键清理）；
  侧栏入口 `sidebar.panellist: scheduled-send`（「定时任务」）；输入框快捷一次性排期
  （`conversation.input.right` + `dock`）。
- **工作区任务会话**：`create` 未指定 sessionId 时自动
  `sessionController.create({workspaceId})` + `rename(任务名)`，任务绑定新会话。
- **有效期**：`endsAt` 落插件元数据 `tasks-meta.json`（`MetaStore`，原子写 + 对账 `reconcile`），
  到期分片定时器（>2^31ms 拆段）自动删官方任务。
- **执行状态观察**：`session/event` 上解析官方 schedule framing
  （`[SCHEDULE REMINDER]` / `[SCHEDULE REMINDER BATCH]` 的 `schedule_id_json`/`reminders_json`），
  `turn/end.reason.kind` → `success/failed/aborted/blocked/max-tokens/interrupted`（forked 不通知），
  写回 meta 并暴露 `ExecutionUpdate`；通知发送由 dsh-notify-alert ≥0.9.0 独立观察同组事件完成，
  **无插件间依赖**。
- **鉴权补齐**：`/api/scheduled-send/*` exact 路由绕过 `/api` 前缀鉴权，每条路由显式
  `connection.requestRejection({headers})`（401/403 JSON）。
- **类型解耦**：不 import `@deepseek-ai/*`（构建解析不到，TS2307）；`bridge.ts` 以本地结构化
  接口（`ScheduleServiceLike` 等）声明宿主面。
- 路由新契约：`GET/POST /tasks`、`POST /tasks/update|delete|delete-inactive|run|history`；
  旧 `/jobs*` 全部退役。测试重写（smoke/routes/ui-hooks 对 `ScheduleBridge`/`TaskPage`）。
- 官方 UI 隐藏口径：profile patch `- id: ui-schedule` + `disabled: true`（host `schedule` 服务不受影响）。

> 归档与复活：2026-10-18 曾以 0.7.4 归档至 public 仓 `IamWWT/dsh-scheduled-send`；
> 2026-10-26 解除 archived，回到 `dsh-plugins/` 目录继续维护（该目录始终是独立 git 仓库）。

## 0.7.4 — 2026-09-25

改进插件页面布局、窄容器适配与键盘焦点；具体范围和验证见 `docs/需求/BRD-20260925-experience.md` 与 `docs/管理/PP-20260925-experience-计划.md`（原 `docs/specs/20260925-experience/` 目录已不存在）。

版本策略：安装一律走 **tgz**（`pnpm check` → `npm pack` → `dsh-dev plugin --profile web add <tgz>`，
重打包必须升版本号；**不使用 link 安装**），每次发布新版本**必须**同步
`package.json.version` / `src/index.ts` VERSION / tgz 文件名 / 文档提及（四处一致）。

> 仓库：本插件是 `IamWWT/dsh-plugins`（private monorepo）的子包——全部自研代码的唯一仓库。

## 0.7.3 — 2026-09-24 跨平台构建：`pnpm check` 在 Windows / Ubuntu 都真正可跑

v0.7.3 之前 `pnpm check` 在干净克隆上**必然失败**，且失败点有三处，互相掩盖：

1. **门禁报「lib/index.js 无法加载」**：`await import(hostFile)` 传的是裸盘符路径
   （`D:\...`），Windows 上 ESM loader 判为协议 `d:`，抛
   `ERR_UNSUPPORTED_ESM_URL_SCHEME`。→ 改用 `pathToFileURL(hostFile).href`。
2. **tsconfig 解析不到类型**：
   - `tsconfig.json` 写死 `typeRoots: ["./node_modules/@types"]`，而本插件按布局红线
     不放 `node_modules` ⇒ 恒报 `TS2688: Cannot find type definition file for 'node'`。→ 删除该字段，
     由 `scripts/build.mjs` 注入 `--typeRoots`。
   - `tsconfig.client.json` 的 `types: []` 关掉了全部自动类型包含，而它的 `include`
     覆盖 `src/shared/**`，其中 `dsh-home.ts` 用到 `node:path`/`node:os`/`process`
     ⇒ `TS2591` ×4。→ 改为 `types: ["node"]`。
   - 客户端 `require("react") as typeof import("react")` 需要 `@types/react`，而
     harness/profile 只把少数 `@types` 提升到 `<dir>/@types`（实测只有 node/jsdom 等），
     react 只存在于 pnpm store ⇒ `TS2307: Cannot find module 'react'`。→ `findTypeRoots()`
     补探 `<dir>/node_modules/.pnpm/@types+<pkg>@<ver>/node_modules/@types`（按包名去重，
     不引入同名包的第二份来源）。
3. **tsc 启动方式不跨平台**：`findTsc()` 返回 `typescript/bin/tsc`（无扩展名的 JS 文件，
   靠 shebang 执行），旧代码直接 `spawnSync(tsPath, ...)` ⇒ Windows 上 ENOENT。
   → 改为 `spawnSync(process.execPath, [tsPath, ...])`，并在失败时打印 `r.error`。

**文档同步**：README 原写「react 类型经 `paths` 映射到 pwb（个人工作台）的 `@types`」——
该做法（`node_modules_types` 借外部 @types）已被门禁 1 明文禁止，属失效描述；改为记录
现行「平台侧 @types + pnpm store 补探」机制（新增「开发期类型检查（跨平台）」一节）。

> 验证：`node scripts/build.mjs --no-typecheck` 门禁全过；两个 tsconfig 直跑 tsc 均 0 错误；
> smoke / routes 16 / session-opener 3 / session-meta 4 / ui-hooks 回归 全绿。

## 0.7.2 — 2026-09-13 设置面板空白最终根因：#310 hooks 顺序 + 可测化回归

用户贴出 v0.7.1 错误边界捕获的错误码 **#310（Rendered more hooks than during the previous render）**。

**真正根因（第三层，前两轮都未命中）**：v0.6.2 给 JobList 加「分组折叠」时，
把 `useState(collapsed)` 写在了 `if (p.jobs.length === 0) return` **之后**——
- 首次渲染 jobs=[]（fetch 未返回）→ 只执行 3 个 hook → 提前 return；
- 数据到达 jobs 非空 → 执行 4 个 hook → **hooks 数量跨渲染漂移 → React #310**；
- #310 被框架 SlotErrorBoundary 吞成空节点 = 「设置面板空白」（v0.7.0 修的 createElement
  与 v0.7.1 修的 SettingsSection 条件 hook 都是必要但非充分的修复）。

**修复**：JobList 全部 hooks（editingId/editText/viewJob/collapsed）移到组件顶层、
任何条件 return 之前（空态 return 改为在 hooks 之后）。

**可测化（为什么之前测不出）**：smoke/routes 不渲染 React；SSR 每次独立渲染不触发
同一 root 的状态漂移。新增 `test/ui-hooks-regression-test.mjs`：react-dom/client + jsdom
+ **ErrorBoundary** 渲染同一 JobList 两次（jobs=[] → jobs=[...]），边界捕获 #310 即失败。
已实测：构造 bug 形态 → 测试退出 1（捕获 "Rendered more hooks"）；修复形态 → 退出 0。

**防再犯铁律**：客户端组件内**所有 hooks 必须位于组件顶层、任何条件 return 之前**；
UI 行为差异（渲染/折叠）用三元/子组件实现，不用提前 return 绕过 hooks。
## 0.7.1 — 2026-09-13 设置面板空白二次根因：条件 hook + 错误可见化

用户复报「设置面板仍空白」。v0.7.0 修复了「组件直接函数调用」但仍空白，二次取证：

**根因（第二层）**：`SettingsSection` 内部按
`typeof p.useSessions === "function" ? p.useSessions : fallback` 条件调用 hook。
React 要求 hooks 数量/顺序跨渲染**恒定**；standard props（useSessions）注入时序变化会让
首帧 4 个 hook、后续 5 个 → `Rendered more hooks than during the previous render` →
渲染崩溃 → 被框架 SlotErrorBoundary 吞成**空节点**（用户看到的就是"空白"，无任何报错线索）。

**修复（三层）**：
1. **消除条件 hook**：`SettingsSection` 不再按 typeof 决定是否调 hook，改用无条件 `useState`
   保证 hook 数量恒定；会话元数据（标题/cwd）改为 entry 层经 `sessions.list.getSnapshot()`
   **同步快照**算好普通对象传入（无 hook）。
2. **错误可见化**：`settings.section` 外层包 `SectionErrorBoundary`——若仍渲染抛错，
   显示确切错误信息 + console.error（不再被吞成空白），并把 `[scheduled-send] sessions 服务`
   诊断（hasService/hasOpen/metaCount）输出到控制台。
3. **注册形态保持**：createElement 渲染（v0.7.0）+ 门禁防直接调用（保留）。

## 0.7.0 — 2026-09-11 设置面板空白根因修复 + SDD 完整闭环

- **修复设置面板「定时发送」内容空白（本轮核心）**：根因是 `entry.ts` 中 `settings.section`
  注册把 `SettingsSection` 组件**当普通函数直接调用**（`(ui.SettingsSection)(props)`），而非
  `React.createElement`——React 规定组件必须经 createElement 渲染，直接调用会让组件内部
  hooks（useState/useEffect/useSessions）归属错乱，渲染异常 → 面板空白。
  对照：dock/⏰ 标识直接传组件引用（框架 createElement）因此正常，设置面板是唯一错误形态。
- **构建门禁防回归**：`build.mjs` 新增组件注册形态断言——禁止 `SettingsSection)(` 直接调用、
  必须 `createElement(ui.SettingsSection`；已实测改回直接调用 → 构建失败。
- **按 SDD 完整闭环**：`docs/需求/BRD-001-complete-feature.md` 与 `docs/管理/PP-001-complete-feature-计划.md`／`-任务.md`（原 `docs/specs/001-complete-feature/` 目录已不存在）冻结完整需求与验收
  标准（A1–A8），经用户确认后实现；dock 范围确认=当前会话。
## 0.6.2 — 2026-09-11

- **对话输入区定时排队 dock**（`conversation.input.dock`，order 30，原生 QueueDock 之后）：
  当前会话的 pending 定时任务以原生排队样式展示，**每行前置「⏰ HH:MM:SS 发送」** + 剩余时间 + 内容预览 + 撤回；
  空则不渲染（与原生 QueueDock 语义一致）。
- **设置面板任务按状态分组**：待触发 / 已发送 / 失败 / 已撤回 四组；
  完成态（sent/missed/cancelled）**默认折叠**，点标题行展开（款式 ▶/▼），pending 默认展开。
- 构建门禁新增校验 `conversation.input.dock` 插槽注册。

## 0.6.1 — 2026-09-11

- **修复「打开会话」仍失败**：client `inject` 漏声明 `sessions`（harness 中 ui-workspace/ui-reference
  均在 inject 显式声明 `'sessions'` 才能 `ctx.get('sessions')` 拿到绑定的服务）；已补
  `inject: ["slots","timer","sessions"]`。
- **任务列表信息增强**：完整展示 sessionId，并新增会话**标题**（displayTitle/title）与**工作目录 cwd**
  （数据源 = dsh `useSessions` 投影，`shared/session-meta.ts` 纯函数派生，可单测）。
- **跳转可观测性**：sessions 服务未注入时，设置面板显示「⚠️ 打开会话不可用」提示 + 控制台
  `[scheduled-send] sessions 服务` 诊断；「打开会话」按钮不再静默消失（缺失时点击有明确文案）。
- 新增 `test/session-meta-test.mjs`（4 项）。

