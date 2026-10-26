# dsh-scheduled-send 需求记录（Requirements Log）

## 当前状态

- 文档性质：规格（现行需求与实现边界的单一事实源）
- 对应版本：v0.9.5
- 状态：有效（现行需求见 §6–§7；§1–§3 为 0.7.x 形态的历史规格原文，仅作过程留痕；
  版本细节见 `CHANGELOG.md`，事故复盘见 `docs/管理/RMP-风险管理.md`）
- 维护者：AI + 用户

> 本文件是需求演进的**单一事实源**：每轮用户反馈 → 设计决策 → 实现落点 → 验收方式。
> 与 `docs/管理/RMP-风险管理.md`（事故/排障）分工：这里记"要什么、为什么这么实现"。

## 1. 原始需求（v0.1.0）

> 在 dsh web 对话框 agent 正在运行时，排队等候的内容或者初始的内容，可以设置定时发送，
> 比如设定 18:30 分发送，然后离开电脑后，他 18:30 就自动触发发送了。
> 注意结合 dsh 本身的特性，不要重复造轮子。

**设计共识（开工前确认）**

| 决策点 | 选择 |
|---|---|
| 发送对象 | 排队消息 + 初始内容（两者都支持） |
| 调度者 | Host 端（dsh 进程内定时器）——3082 由 systemd 常驻，离开电脑仍触发 |
| UI 入口 | 会话输入区旁的小控件（后续按反馈调整，见 §2.1） |

**"不重复造轮子"的落点**

| 能力 | 复用的 dsh 既有机制 |
|---|---|
| 排队投递与消费 | `sessionController.prompt({ mode: 'queue' })` → 原生 Inbox `next-turn` 持久队列 |
| 队列/会话状态 | 客户端插槽 standard props（`useSessions` / `useInput`） |
| 定时器 | host 进程内 `setTimeout`（dsh 常驻） |
| 持久化 | 插件自管 `<stateDir>/jobs.json` |

> 注（2026-10-13）：上表 `useSessions` 已不再由本插件消费——会话元数据（标题 / cwd）改为
> `entry.ts` 经 `sessions.list.getSnapshot()` 取同步快照（`src/shared/session-meta.ts` 折叠），
> 因为组件内禁止条件调用 hook（见 §2.6）；`useInput` / `inputActions` 仍走插槽 standard props。

---

## 2. 现行需求与规格（历轮反馈沉淀的终态口径）

### 2.1 入口与形态

- **主入口**：`conversation.input.right`（输入框工具行「⏰ 定时」）；会话由插槽注入，不需要用户记 sessionId。
- **管理面板**：`settings.section`（id `scheduled-send`，`order: 11`；Vision Router 为 12，即在其右边），
  列出全部任务，支持 放大查看 / 打开会话 / 撤回 / 编辑内容 / 立即发。

> 注（2026-10-13）：Vision Router（上游 `dsh-vision-router`，settings 段 order 12）**当前未装在本机
> web profile**（`~/.dsh-dev/profiles/web/package.json` 无此依赖），"在其右边"只是 order 11 的原始设计参照；
> order 11 本身仍是本插件的实际注册值（`src/client/entry.ts`）。
- **输入区 dock**：`conversation.input.dock`（`order: 30`，与原生 QueueDock 同插槽），
  在输入区上方展示当前会话的 pending 任务：`⏰ HH:MM:SS 发送 · 剩余时间 · 内容预览`；无 pending 不渲染。
  **只展示一次性任务**（`once` / `after`）——周期任务（`every`/`daily`/`weekly`/`cron`）常驻 dock 会让
  会话越开越乱（用户 2026-10-26 要求），一律只在左侧「定时任务」页管理。
- **时间选择形态**：浮层内竖排列表选择——`时 : 分 : 秒` 三段下拉（0–23 / 0–59 / 0–59）+ 今天 / 明天档位，
  界面实时回显解析出的绝对时刻与剩余时间。

**验收**：输入框工具行有「⏰ 定时」入口；dock 在输入区上方显示前置发送时刻（周期任务不出现）；设置面板可见任务列表与状态分组。

### 2.2 时间规则（现行）

- 一律使用**绝对时刻**（`HH:MM:SS`），不用"N 分钟后"的相对时长。
- **今天**：只可选当前时刻之后；`fireAt <= now` 直接报错"请改选明天"（不再自动顺延）。
- **明天**：0–24 点全时段可选。
- **封顶**：host `Scheduler.maxFireAt()` = 明天 23:59:59.999（`MAX_SCHEDULE_DAY_OFFSET = 1`），
  `add` / `update` 均强校验，"最晚明天"不只靠 UI 守。
- 默认值：打开浮层预置「当前时刻 + 30 分钟」（秒归零），仅作初值，仍以绝对时刻呈现。

**历史口径（已被取代，勿再引用）**：v0.2.0–v0.4.x 用快捷时长（15m…20h）+ `MAX_SCHEDULE_HOURS = 20` 上限，
且"今天已过"自动顺延到明天。该常量与顺延逻辑自 v0.5.0 起废弃（现存常量只有 `MAX_PENDING_PER_SESSION` /
`MAX_SCHEDULE_DAY_OFFSET`）。

**验收**：可选择任意 `HH:MM:SS`；"今天已过"报错并提示改选明天；晚于明天 23:59:59.999 的时刻被 host 拒绝。

### 2.3 主题与配色（v0.4.0 起）

一律使用 DSH 主题 token，禁止字面色值：

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
| 浮层立面 | `box-shadow: var(--dsw-elevation-panel)`，且 `border: 0`（立面阴影不与中性描边并用） |

**验收**：源码与产物中不再出现字面色值；切换明暗主题时浮层/按钮配色随之变化。

### 2.4 内容取用：复用 DSH 输入框草稿

浮层内**不自带文本输入控件**，内容直接取 DSH 输入框当前草稿，只做只读预览：

| 用途 | 机制（源码位置） |
|---|---|
| 读草稿 | `useInput` ← 会话绑定 `hooks: { input: shell.state }`（`InputState.draft`） |
| 清空输入框 | `inputActions.setDraft('')` ← 会话绑定 `props: { inputActions: shell.actions }` |
| 目标会话 | `sessionId` ← 会话作用域插槽注册时的 **`inject(sessionId)` 位置参数**（不是 standard prop） |

- 草稿为空时：按钮禁用 + 明确提示"请先在输入框写下内容"。
- 创建成功后默认清空输入框（可取消勾选），避免误按回车造成"立即发送 + 定时发送"双发。
- 例外：设置面板内的"编辑 pending 任务内容"仍用本地 textarea——该内容存于任务记录而非 DSH 输入框，
  没有可复用的原生输入源，属必要 UI。

**验收**：浮层内无任何文本输入控件；`useInput` 草稿能被正确带入并显示为只读预览；创建后输入框按勾选状态清空。

### 2.5 任务管理与上限

- 每会话最多 **3** 个待触发任务（`MAX_PENDING_PER_SESSION = 3`）：host `Scheduler.add` 强校验（第 4 个拒绝）
  + client 预检 + 设置面板写明规则。
- 设置面板按状态分组：待触发 / 已发送 / 失败 / 已撤回；完成态默认折叠（点击展开），pending 默认展开。
- pending 行内操作：编辑内容 / 撤回 / 立即发 / 打开会话 / 放大查看。

**设计确认（薄封装）**：本插件"正是"dsh 原生排队机制的薄封装——到点用
`sessionController.prompt({ mode: 'queue' })` 进 Inbox `next-turn`，与原生 QueueDock 同一通道；
原生只缺「定时触发」和「放大查看」两层，插件只补这两层（+ 任务管理面板），不重造排队语义。

### 2.6 UI 与实现准则（长期有效）

- **不允许存在"点了没反应"的路径**：前置条件不满足时必须 ① 点击后给出明确文案，或 ② 输出控制台诊断；
  不得仅靠 `disabled` 静默屏蔽。
- 客户端组件内**禁止条件调用 hook**（`typeof x === 'function' ? x(...) : ...` 也属于）；
  需要 standard hooks 数据时在组件顶层无条件调用，或由 entry 同步快照算好传入。
- `settings.section` 必须以 `React.createElement(ui.SettingsSection, props)` 注册（组件必须经 createElement 渲染）；
  构建门禁对"组件注册形态"做回归断言。三次「设置面板空白」的根因链见 `docs/管理/RMP-风险管理.md`。
- 凡 `ctx.get('sessions')`，必须把 `'sessions'` 写进客户端插件级 `inject`（`["slots","timer","sessions"]`）；
  宿主服务方法调用一律 `method.call(svc, ...)` 保 this。
- host 路由读 body 必须传 `req`（`readBody(req)` / `readJsonBody(hreq)`），绝不传 `res`；
  客户端所有异步请求带 10s 超时（AbortController）+ 明确失败文案。

---

## 3. 当前实现边界（有意不做）

- 不支持图片/附件（与 dsh-personal-workbench 的 `session-prompt` 兜底通道一致，纯文本）。
- 不做跨设备/多 profile 同步（MVP 只覆盖当前 web profile）。
- 不修改 dsh 排队/Inbox 机制本身（完全复用既有投递路径）。
- 设置面板内的"编辑 pending 任务内容"仍用本地 textarea（见 §2.4 例外）。

## 4. 协作约定（务必遵守）

- **重启 dsh 前必须先征得用户同意**（`systemctl --user restart dsh-dev-web` 不擅自执行）。
- 同版本号重新打包后，安装必须 `plugin rm` + `plugin add`；更稳的做法是每次升版本号。
- host 端凡 `ctx.xxx` 取用的服务，必须声明 `export const inject = [...]`。

> **口径不一致（如实保留，未收敛）**：工作区与插件 AGENTS.md（2026-09-23 起）要求**安装一律 tgz、不用 link**，
> 但本仓 `package.json` 的 `pnpm install:dev` 仍指向 `scripts/install-to-dsh.sh`
> （**源码 link 安装** + `verify-installed`），与"全部 tgz"纪律不符——**尚未改写为 tgz 流程**。
> 当前口径：正式安装走 `pnpm check` → `npm pack` → `dsh plugin --profile web add <tgz>`（重打包必升版本号）；
> `install:dev` 仅为历史遗留的本地便利入口，不代表现行安装纪律。

## 5. 历史沿革（要点）

- **v0.1.0–v0.3.0**：确立 Host 定时器 + 原生 Inbox 投递的薄封装形态；入口从侧栏折叠栏 → `settings.section`（order 11）
  → 输入框 `conversation.input.right`；补齐撤回 / 编辑 / 立即发与竖排时间选择。
- **v0.4.0–v0.4.1**：三条反馈（主题 token 化、绝对时刻时分秒、去掉自带输入框）落地；
  随后"点创建无反应"回归（误删 `inject(sessionId)`），确立"不允许静默失败"准则。
- **v0.5.0**：修复自 v0.1.0 起隐藏的 host `readBody(res)` 永久挂起（创建卡死）；
  改为今天报错 / 明天全时段可选的规则；新增任务列表、打开会话跳转与每会话 3 个上限。
- **v0.6.0–v0.6.2**：工程硬化（构建产物门禁、安装后验证器、死配置清理、文档一致性）；
  会话标题 + cwd 展示；`sessions` 漏声明与 this 绑定两起"打开会话"故障修复；输入区 dock 与设置按状态分组。
- **v0.7.0–v0.7.3**：设置面板空白三层根因（组件直接函数调用 → 条件 hook → JobList hooks 顺序）逐一修复并补回归测试；
  跨平台 `pnpm check` 修复（ESM 盘符路径、typeRoots、tsc 启动方式）。
- **v0.7.4**：页面布局 / 窄容器适配 / 键盘焦点体验优化（范围与验证见 `docs/需求/` + `docs/管理/` 下同 id 文件）；
  本次 docs 终态化（需求流水压为本节，事故细节见 `docs/管理/RMP-风险管理.md`）。

---

## 6. 2026-10-26 复活与重构（v0.8.0 / v0.8.1，现行规格）

### 6.1 原始需求（用户原话要点）

> 我之前的这个插件我归位到正式插件目录了：dsh-scheduled-send/，github 那边应该是 public archived 状态，
> 我要重新开启它，增加新的功能：现在是定时发到某个会话，我希望我能像 WorkBuddy 这个页面一样实现
> **提示词定时**功能（名称 / 提示词 / 频率 / 有效期 / 工作区 / 允许完全访问 / 通知），
> 并能**联动 notify 自动将任务执行状态发送到我控制的微信**或什么里面。
> 如果能复用官方（自动化任务）的这个插件功能也是好的；官方的这个功能，不需要实际展示在页面，
> 平时用我上面的这个插件。

**设计共识（开工前确认的默认值）**

| 决策点 | 选择 |
|---|---|
| 任务执行场所 | 在选定工作区**创建专用任务会话**（也可绑定已有会话） |
| 通知范围 | 所有定时任务默认通知（表单留每任务开关） |
| 「允许完全访问」 | **展示性说明**——实际权限由会话侧审批体系决定，插件不伪造 |
| 调度引擎 | **复用官方 `ctx.schedule`**（0.2.1-rc 起 durable host 任务，含错过补投） |
| 官方 UI | profile 禁用条目 `ui-schedule`；host `schedule` 服务保留 |
| 通知实现 | 归 dsh-notify-alert ≥0.9.0，独立观察会话事件；**插件间不建包依赖** |

### 6.2 设计决策与落点

| 能力 | 实现落点 | 关键取舍 |
|---|---|---|
| 定时/持久/重复/投递 | `ctx.schedule.catalog/create/update/delete/deleteInactive/history` | 不自建定时器；旧 `Scheduler`/`jobs.json` 删除 |
| 频率表单 | `shared/types.ts` `Frequency` 判别联合（once/after/every/daily/weekly/cron） | 人话回显 + 下次执行计算放 host `frequencyOf` |
| 有效期 `endsAt` | 插件元数据 `<stateDir>/tasks-meta.json`（`MetaStore`） | 官方无 end date → 只在插件侧记；到期分片定时器删官方任务 |
| 工作区任务会话 | `sessionController.create({workspaceId})` + `rename(任务名)` | 会话名跟随任务名；删除任务不删会话（用户数据保守） |
| 执行状态 | `session/event`：`user/message(source=schedule)` 解析 framing → 同轮 `turn/end.reason.kind` 归因 | `forked` 不通知；meta 记 `lastExecution` 供列表徽章 |
| 通知推送 | notify-alert 观察者识别同组事件 → 合并器 → 企微/WxPusher | 两插件只共享**官方事件契约**，无代码耦合 |
| 官方 UI 隐藏 | `- id: ui-schedule` + `disabled: true`（profile patch） | 验收断言「有定时任务、无自动化任务」 |
| 路由安全 | 每条 `/api/scheduled-send/*` 先 `connection.requestRejection({headers})` | exact 路由绕过 `/api` 前缀鉴权，不补 = 公网裸奔 |

### 6.3 验收方式（0.8.1 已执行）

- `pnpm check` 五组测试全绿（smoke=ScheduleBridge+mock 官方服务；routes=含 401；hooks=TaskPage 空→有渲染）。
- 隔离实例（独立 home + 3084）：Playwright 断言侧栏「定时任务」存在、官方「自动化任务」不存在、
  表单建任成功、console 零报错；证据 `ops/validation/dsh-scheduled-send-0.8.0/screenshots/`。
- `node scripts/e2e-3082.mjs <base> --token <t> --workspace <id>`：token→cookie 鉴权、
  health/list/create/update/delete 全通过（探针任务次日 03:07，建后即删，不投递真实消息）。
- **未实测**：真实模型执行一轮定时任务并经微信收到状态推送（链路各段有单测，端到端待生产安装后人工验收）；
  Windows 桌面端未验证。

### 6.4 需求流水（本轮）

1. 0.8.0 重构完成后 typecheck 失败：`@deepseek-ai/*` 类型包插件解析不到（TS2307）→
   确立「本地结构化接口声明宿主面」规则（`ScheduleServiceLike` 等）。
2. 隔离实例「没有可用工作区」：注册期静态快照为空 → `getWorkspaces()` 活读器（v0.8.1 修复）。
3. Playwright 误报 `createdOk:false`：断言文本撞车 → 改断「验证任务 + 待执行」共存（测试侧修正，非产品缺陷）。

## 7. 2026-10-26 生产验收后的迭代轮（v0.9.0–v0.9.5，现行规格）

每轮 = 用户反馈 → 决策 → 实现落点；版本细节见 CHANGELOG。

1. **v0.9.0 执行状态静默失效**（用户：手机端没收到推送）。生产会话日志实证
   `user/message` 的 `content/source` 直接挂在 `data` 下（`assistant/message` 才有 `data.message`），
   0.8.x 解析形状错误 → `data.message ?? data` 双形状兼容；smoke-test 补真实形状回归用例。
   同轮补表单三项：**发送到**（新建任务会话/现有会话）、**Agent 模式**（preset 仅新会话可绑，
   现有会话首轮后锁定只读展示）、**执行模型**（公开 `selectModel`，表单注明会同步全局默认模型；
   不可用即创建失败）。数据源 `remote.agentPresets.list` / `remote.session.modelCatalog`（超时+降级）。
2. **v0.9.1 弹窗过高按钮被裁**：modal 内部滚动 + sticky actions，按钮恒可见。
3. **v0.9.2 品牌标识整块移除**（用户：收缩不算去掉）：`sidebar.brand.name/mark` 注册空实现。
4. **v0.9.3 收起按钮并入「新会话」行**：该按钮无官方插槽 → 品牌组件挂载 effect 打标记类 +
   纯 CSS 移位（不搬 DOM 节点，避免宿主重渲染冲突；macOS 顶栏布局自动不命中）。
5. **v0.9.4 折叠轨道展开标识恢复**（用户：折叠后没有可见标识）：mark 插槽双用途，
   CSS 按 `railMark` 容器区分显示。
6. **v0.9.5 两按钮并排不重叠**（用户：重叠难看）：新会话按钮让出右端 40px，收起按钮落进空档。

**生产端到端验收（2026-10-26，3082）**：真实定时任务投递 → 模型执行 → `lastExecution=success`
→ notify-alert 合并推送 → 用户手机收到「Scheduled Task Finished」，全链路实测通过；
UI 断言（品牌移除、按钮并排、折叠标识、重开）见 `ops/validation/dsh-scheduled-send-0.8.0/`
verify-ui / verify-rail 脚本与截图。
