# dsh-scheduled-send 需求记录（Requirements Log）

> 本文件是需求演进的**单一事实源**：每轮用户反馈 → 设计决策 → 实现落点 → 验收方式。
> 与 `TROUBLESHOOTING.md`（事故/排障）分工：这里记"要什么、为什么这么实现"。

## 原始需求（v0.1.0）

> 在 dsh web 对话框 agent 正在运行时，排队等候的内容或者初始的内容，可以设置定时发送，
> 比如设定 18:30 分发送，然后离开电脑后，他 18:30 就自动触发发送了。
> 注意结合 dsh 本身的特性，不要重复造轮子。

**设计共识（开工前确认）**

| 决策点 | 选择 |
|---|---|
| 发送对象 | 排队消息 + 初始内容（两者都支持） |
| 调度者 | Host 端（dsh 进程内定时器）——3082 由 systemd 常驻，离开电脑仍触发 |
| UI 入口 | 会话输入区旁的小控件（后续按反馈调整，见下） |

**"不重复造轮子"的落点**

| 能力 | 复用的 dsh 既有机制 |
|---|---|
| 排队投递与消费 | `sessionController.prompt({ mode: 'queue' })` → 原生 Inbox `next-turn` 持久队列 |
| 队列/会话状态 | 客户端插槽 standard props（`useSessions` / `useInput`） |
| 定时器 | host 进程内 `setTimeout`（dsh 常驻） |
| 持久化 | 插件自管 `<stateDir>/jobs.json` |

---

## v0.2.0 — 入口位置与可撤回编辑

| # | 反馈 | 决策 / 实现 |
|---|---|---|
| 1 | 入口在左侧折叠栏，要和 Vision Router「识图」在一起、在其左边 | 改注册 `settings.section`，`order: 11`（Vision Router 为 12） |
| 2 | 点击定时发送没反应 | 旧版用普通对象 bus 驱动 `shell.overlay` 的 `open`，无订阅者 → 永不重渲染。改为 section 机制，由设置面板自身切换内容列 |
| 3 | 应给出时间选择 | 加 15m/30m/1h/2h/6h/12h/20h 快捷 + 自定义 `datetime-local` |
| 4 | 发送前可撤回、可编辑内容 | pending 任务行内提供 编辑内容 / 撤回 / 立即发 |
| 5 | 最多定时 20 小时 | `MAX_SCHEDULE_HOURS = 20`，创建时校验 |

---

## v0.3.0 — 入口进入输入区（由协作 AI 实施）

| # | 反馈 | 决策 / 实现 |
|---|---|---|
| 1 | "谁会记 sessionid 去设置面板里操作" | 加 `conversation.input.right` 主入口（输入框工具行「⏰ 定时」），会话由插槽注入；设置面板 section 退化为管理面板 |
| 2 | 时间维度要能上下拉选 | 浮层内竖排列表选择 |

---

## v0.4.0 — 主题一致性 / 时分秒 / 不再自带输入框（本轮，三条反馈）

### 1. 黑色和 dsh 主题不搭配，色调要同全局一致

**问题**：旧版 CSS 写死深色（`.dss-pop{background:#1d2126}`、`#3b82f6`、字号色 `#888` 等），
在浅色主题下表现为突兀的黑块，不随全局主题/明暗切换。

**决策**：一律改用 DSH 主题 token，禁止字面色值。

| 用途 | 采用的 token |
|---|---|
| 浮层/面板底色 | `--dsw-alias-bg-overlay` |
| 卡片/嵌套面 | `--dsw-alias-bg-layer-1` / `--dsw-alias-bg-layer-2` |
| 主/次文字 | `--dsw-alias-label-primary` / `--dsw-alias-label-secondary` |
| 中性描边 | `--dsw-alias-border-l2`（`0.5px`，遵守 ui-theme 发丝线规范） |
| 主按钮 | `--dsw-alias-button-primary-fill` / `-hover`，文字 `--dsw-alias-label-primary-foreground` |
| 悬停/选中 | `--dsw-alias-interactive-bg-hover` / `-hover-accent` |
| 强调色 | `--dsw-alias-brand-primary` |
| 状态色 | `--dsw-alias-state-{success,error,warn}-primary` |
| 浮层立面 | `box-shadow: var(--dsw-elevation-panel)`，且 `border: 0`（遵守 ui-theme 立面规范：立面阴影不与中性描边并用） |

**验收**：源码与产物中不再出现字面色值；切换明暗主题时浮层/按钮配色随之变化。

### 2. 定时可选时分秒，不是"多少分钟后"

**问题**：旧版以"N 分钟后"表达计划时刻，用户要的是绝对钟点。

**决策**：改为**绝对时刻**选择——`时 : 分 : 秒` 三段下拉（0–23 / 0–59 / 0–59），
配 今天 / 明天 两个日期档位；界面实时回显解析出的绝对时刻与剩余时间。

- 默认值：打开浮层时预置为「当前时刻 + 30 分钟」（秒归零），仅作初值，仍以绝对时刻呈现。
- 迟于今天的时刻自动顺延：选「今天」但该时刻已过 → 顺延到明天同一时刻，并在界面上**明确提示**。
- 上限校验：`fireAt - now <= 20h`，超出即拒绝并提示。

**验收**：可选择任意 `HH:MM:SS`；超出 20 小时被拒绝；"今天已过"有明确顺延提示。

### 3. 不需要额外文本输入框，dsh 本身就有

**问题**：浮层内自带 textarea，与 DSH 原生输入框重复。

**决策**：内容**直接取 DSH 输入框当前草稿**，浮层内不再提供输入控件，只做只读预览。

复用会话作用域插槽的 standard props（`conversation.input.right` 已声明）：

| 用途 | 机制（源码位置） |
|---|---|
| 读草稿 | `useInput` ← 会话绑定 `hooks: { input: shell.state }`（`InputState.draft`） |
| 清空输入框 | `inputActions.setDraft('')` ← 会话绑定 `props: { inputActions: shell.actions }` |
| 目标会话 | `sessionId` ← 会话作用域稳定属性 |

- 草稿为空时：按钮禁用 + 明确提示"请先在输入框写下内容"。
- 创建成功后默认清空输入框（可取消勾选），避免误按回车造成"立即发送 + 定时发送"双发。

**验收**：浮层内无任何文本输入控件；`useInput` 草稿能被正确带入并显示为只读预览；
创建后输入框按勾选状态清空。

---

## 当前实现边界（有意不做）

- 不支持图片/附件（与 dsh-personal-workbench 的 `session-prompt` 兜底通道一致，纯文本）。
- 不做跨设备/多 profile 同步（MVP 只覆盖当前 web profile）。
- 不修改 dsh 排队/Inbox 机制本身（完全复用既有投递路径）。
- 设置面板内的"编辑 pending 任务内容"仍用本地 textarea——该内容存于任务记录而非 DSH 输入框，
  没有可复用的原生输入源，属必要 UI。

## 协作约定（务必遵守）

- **重启 dsh 前必须先征得用户同意**（`systemctl --user restart dsh-dev-web` 不擅自执行）。
- 同版本号重新打包后，安装必须 `plugin rm` + `plugin add`；更稳的做法是每次升版本号。
- host 端凡 `ctx.xxx` 取用的服务，必须声明 `export const inject = [...]`。

---

## v0.4.1 — 修复「点创建无反应」（回归修复）

| # | 反馈 | 根因 | 修复 |
|---|---|---|---|
| 1 | 位置对了，但点「创建定时发送」毫无反应；设置里没条目，输入框也没清空 | v0.4.0 误把 `sessionId` 当 standard prop，删掉了 v0.3.0 正确的 `inject: (sessionId) => ({ sessionId })`，导致 sessionId 为空、按钮恒 `disabled`，点击被静默吞掉 | 恢复 `inject` 写法（并保留 standard prop 兜底）；创建按钮只由 `busy` 禁用；补齐可见反馈与诊断 |

**随之确立的 UI 准则**：不允许存在"点了没反应"的路径。前置条件不满足时必须
① 点击后给出明确文案，或 ② 输出控制台诊断；不得仅靠 `disabled` 静默屏蔽。

**新增可观测性**：

- 浮层打开时输出 `[scheduled-send] seat` 诊断（sessionId / useInput / inputActions / setDraft / draftLength）。
- 设置面板显示 host 健康状态（`/health`）：在线版本 + 待触发数，或不可达原因。
- `GET /jobs` 失败显式报错，不再静默显示"暂无任务"。

---

## v0.5.0 — 创建卡死 + 时间规则 + 任务管理与跳转 + 每会话 3 个上限（一次到位）

| # | 反馈 | 根因 / 决策 | 实现 |
|---|---|---|---|
| 1 | 点「创建定时发送」一直"创建中…"，几分钟无果，刷新后任务消失 | **host POST 处理器把 res 传给 readBody → promise 永不 resolve → 请求永久挂起**（从 v0.1.0 起的隐藏 bug，详见 TROUBLESHOOTING） | `routes.ts` 改读请求对象；客户端 `api()` 统一 10s 超时（AbortController）；失败/超时给明确文案 |
| 2 | 定时逻辑：今天只能定当前时刻之后；明天才能定 0–24 点 | 去掉 v0.4.x 的"今天已过自动顺延到明天"（易困惑） | 今天：`fireAt <= now` 直接报错"请改选明天"；明天：0–24 全时段可选 |
| 3 | 设置里要看到所有定时任务，并能点击跳到对应工作区会话 | 复用客户端 `sessions.open(id)`（ui-conversation 的 `workspaceNavigation.openSession`） | JobList 每行加「打开会话」按钮；另加「放大查看」全内容弹层 |
| 4 | 一个对话最多 3 个定时发送任务，并在设置说明 | host 强校验 + client 预检 | `MAX_PENDING_PER_SESSION=3`（shared/constants.ts）；`Scheduler.add` 拒绝第 4 个；设置面板加"每会话最多 3 个待触发"标签并写明规则 |

**设计确认**：本插件"正是"dsh 原生排队机制的薄封装——到点用
`sessionController.prompt({ mode: 'queue' })` 进 Inbox `next-turn`，与原生 QueueDock 同一通道；
原生只缺「定时触发」和「放大查看」这两层，插件只补这两层（+任务管理面板），不重造排队语义。

---

## v0.6.0 — 工程硬化：吸收各插件精华 + 代码/文档一致性审查

无新功能需求；本轮是工程性收尾（吸收 dsh-personal-workbench / trading / troubleshoot /
audio-transcriber 的实战经验，消除"反复弄坏"根因与文档失真）：

| # | 项 | 内容 |
|---|---|---|
| 1 | 安装根因防复发 | 构建产物门禁（`scripts/build.mjs`：顶层卫生 + host 可加载断言 + client 注册断言）、安装后验证器（`scripts/verify-installed.mjs`）、一键 link 安装脚本（`scripts/install-to-dsh.sh`，不自动重启）。见 `docs/TROUBLESHOOTING.md` 复盘 |
| 2 | 死配置清理 | 移除 `cordis.patch.yml` 中从未被代码消费的 `markMissed`/`refreshMs`（纸面配置会误导用户）；`cordis.patch.yml` 只声明 `stateDir` |
| 3 | 死常量补消费 | `MAX_SCHEDULE_DAY_OFFSET` 此前声明但无人用；host 新增 `Scheduler.maxFireAt()`（= 明天 23:59:59.999）并在 `add`/`update` 校验"最晚明天"，使"明天 0–24 点"边界由 host 强校验（不只靠 UI 守） |
| 4 | 文档一致性 | README 修正 3 处失真（"上限 20 小时"旧文案 → 今天/明天规则；配置段列出未实现键 → 只留 stateDir；目录结构过时 → 同步当前文件树）；故障排查补当前行为（host 在线检测、3 个上限、missed 语义）；「不重造轮子」表更新为 useInput/inject 机制 |
| 5 | 工程规范沉淀 | 工作区根 `AGENTS.md` 新增「自研插件工程规范」；本插件新增 `AGENTS.md`（专属硬规则）+ `CHANGELOG.md` |

---

## v0.6.1 — 会话信息展示 + 打开会话修复（inject 声明）

用户反馈三项：

1. **sessionId 看不全**：任务列表旧实现只显示前 8 位。修复：完整展示 sessionId（`🔗 <id>`，悬停全文）。
2. **展示工作目录与标题**：新增会话**标题**（displayTitle 优先，回退 title）与**工作目录 cwd**。
   数据源不用插件自存快照，而是 dsh `useSessions` 投影（SessionSummary: id/displayTitle/title/cwd），
   更权威、实时；`shared/session-meta.ts` 纯函数派生查询表 + `test/session-meta-test.mjs`（4 项）。
3. **「打开会话」仍旧失败**：上一轮只修了 this 绑定，但**根因是 client `inject` 漏声明 `sessions`**——
   harness 内 ui-workspace / ui-reference 都是 `inject: [..., 'sessions', ...]` 才能用
   `ctx.get('sessions')` 拿到绑定的服务（未声明拿不到/代理报错）。补 `inject: ["slots","timer","sessions"]`。
   同时增加可观测性：sessions 未注入时面板顶部黄色警告 + 控制台诊断 + 按钮点击有明确文案（不再静默消失）。

**防再犯**：客户端插件凡 `ctx.get('sessions')` 必须把 `'sessions'` 写进插件级 `inject`；
涉及宿主服务方法调用一律 `method.call(svc, ...)` 保 this。

---

## v0.6.2 — 输入区定时排队 dock + 设置任务按状态分组

用户反馈（最初需求回归）：

1. **对话框加入排队展示**：像 dsh 原生排队队列（QueueDock）一样，在输入区上方展示
   当前会话的 pending 定时任务，**排队前写明几点发送**。
   实现：注册 `conversation.input.dock`（同原生插槽，order 30）；每行
   `⏰ HH:MM:SS 发送 · 剩余时间 · 内容预览 · 撤回`；空则不渲染。
2. **设置按状态分组 + 已完成默认折叠**：待触发/已发送/失败/已撤回 四组；
   完成态默认折叠（点击展开），pending 默认展开。

---

## v0.7.0 — 设置面板空白根因修复 + 按 SDD 完整收敛

用户反馈："对话框上面有定时功能了，但设置里面的定时设置东西都不见了；为什么反复出现这种情况，
需求不能完全做完？目标明确在需求文件里面，按 SDD 开发测试。"

**根因**（已取证 + 临时改回可复现）：
`entry.ts` 的 `settings.section` 注册把 `SettingsSection` 组件**直接函数调用**
（`(ui.SettingsSection)(props)`），违反 React「组件必须经 createElement 渲染」规则 →
组件内 hooks 归属错乱 → 设置面板渲染异常/空白。dock（`ScheduledDock`）直接传组件引用，
由框架 createElement 渲染，因此正常——设置面板是唯一错误形态，症状吻合。

**修复**：
1. `entry.ts` settings.section 改 `React.createElement(ui.SettingsSection, props)`（保留
   useSessions/close/openSession/sessionsUnavailable 透传）。
2. `build.mjs` 门禁加组件注册形态断言（防回归，已实测拦截）。

**SDD 产物**：`docs/specs/001-complete-feature/`（spec.md 验收 A1–A8 / plan.md 根因 / tasks.md T1–T5）。
用户确认决策：D1=修复注册形态+门禁；D2=dock 当前会话。

**验收（spec A1–A8）**：A1 ⏰ 创建、A2 dock 前置时刻、A3 设置面板内容可见+分组折叠、
A4 打开会话跳转、A5 完整 id+标题+cwd、A6 单测全绿、A7 安装验证、A8 到点投递（3082 用户验收）。

---

## v0.7.1 — 设置面板空白二次根因：条件 hook + 错误可见化（SDD 收敛补刀）

用户复报「设置面板仍空白」。v0.7.0 修了「组件直接函数调用」，仍空白 → 二次取证：

**根因**：`SettingsSection` 内部 `typeof p.useSessions === "function" ? useSessions : fallback`
**条件调用 hook**。React 要求 hooks 跨渲染数量恒定；standard props 注入时序变化导致
首帧 4 hook / 后续 5 hook → `Rendered more hooks` 崩溃 → 框架 SlotErrorBoundary 吞成空节点。

**修复**：
1. 条件 hook → 无条件 `useState`（数量恒定）；标题/cwd 改 entry 同步快照传入（无 hook）。
2. `settings.section` 包 `SectionErrorBoundary`：渲染异常**可见**（错误信息 + console.error），
   不再空白无线索；`[scheduled-send] sessions 服务` 诊断含 metaCount。
3. createElement 注册形态（v0.7.0）与门禁断言保留。

**防再犯铁律**：客户端组件内**禁止条件调用 hook**（`typeof x === 'function' ? x(...) : ...` 也属于）；
凡需 standard hooks 数据，在组件顶层无条件调用或由 entry 同步快照算好传入。

---

## v0.7.2 — 设置面板空白最终根因：#310 hooks 顺序（SDD 收敛闭环）

用户提供 v0.7.1 错误边界的捕获码 #310（Rendered more hooks than during the previous render）。

**根因链（三层，前两轮修复必要但未命中最终点）**：
1. v0.7.0 修「组件直接函数调用」（必要）；
2. v0.7.1 修「SettingsSection 条件 hook」（必要）；
3. **最终**：v0.6.2 的 JobList「分组折叠」把 `useState(collapsed)` 放在
   `if (jobs.length===0) return` **之后** → jobs 空/有之间 hooks 数量漂移 → #310 →
   SlotErrorBoundary 吞成空白。

**修复**：JobList 全部 hooks 移到组件顶层（空态 return 在 hooks 之后）。

**可测化**：新增 `test/ui-hooks-regression-test.mjs`（react-dom/client + jsdom +
ErrorBoundary，渲染 jobs=[]→有数据两次）。已用 bug 形态验证能捕获 #310（退出 1）。

**验收**：spec A3「设置面板内容可见」在临时实例验证通过前不声称完成。

---

## v0.7.3 — 跨平台构建：`pnpm check` 在 Windows / Ubuntu 都真正可跑

**背景**：v0.7.3 之前 `pnpm check` 在干净克隆上**必然失败**，三个失败点互相掩盖
（前一个失败导致后面根本没跑到，所以只看到第一个）。

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | 门禁报 `lib/index.js 无法加载` | `await import(hostFile)` 传裸盘符路径（`D:\...`），Windows 上 ESM loader 判为协议 `d:` → `ERR_UNSUPPORTED_ESM_URL_SCHEME` | 改 `pathToFileURL(hostFile).href`（`scripts/build.mjs`、`scripts/verify-installed.mjs`、`test/ui-hooks-regression-test.mjs`） |
| 2a | `TS2688: Cannot find type definition file for 'node'` | `tsconfig.json` 写死 `typeRoots: ["./node_modules/@types"]`，而本插件按布局红线不放 `node_modules` | 删除该字段，由 `scripts/build.mjs` 注入 `--typeRoots` |
| 2b | `TS2591` ×4（`node:path`/`node:os`/`process`） | `tsconfig.client.json` 的 `types: []` 关掉全部自动类型包含，而它的 `include` 覆盖 `src/shared/**`，其中新增的 `dsh-home.ts` 是 Node-only | 改 `types: ["node"]` |
| 2c | `TS2307: Cannot find module 'react'` | 客户端 `require("react") as typeof import("react")` 需要 `@types/react`，但 harness/profile 只把少数 `@types` 提升到 `<dir>/@types`，react 仅存在于 pnpm store | `scripts/paths.mjs` 的 `findTypeRoots()` 补探 `<dir>/node_modules/.pnpm/@types+<pkg>@<ver>/node_modules/@types`（按包名去重） |
| 3 | tsc 启动 ENOENT | `findTsc()` 返回 `typescript/bin/tsc`（无扩展名的 JS 文件，靠 shebang），旧代码直接 `spawnSync(tsPath, ...)` | 改 `spawnSync(process.execPath, [tsPath, ...])`，失败时打印 `r.error` |

**文档同步**：README 原写「react 类型经 `paths` 映射到 pwb（个人工作台）的 `@types`」——
该做法（`node_modules_types` 借外部 @types）已被门禁 1 明文禁止，属失效描述；
改为记录现行「平台侧 @types + pnpm store 补探」机制，并新增
「开发期类型检查（跨平台）」一节。

**验收**：`node scripts/build.mjs --no-typecheck` 门禁全过；两个 tsconfig 直跑 tsc 均 0 错误；
smoke / routes 16 / session-opener 3 / session-meta 4 / ui-hooks 回归 全绿。
（沙箱内 `spawnSync` 会返回 `EBUSY`/`exit null`，故类型检查用直跑 tsc 复核。）
