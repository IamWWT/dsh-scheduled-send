# spec — 定时发送完整功能（含设置面板空白修复）

- **状态**：**已确认（2026-09-11，用户批准）**
- **版本**：0.1（对应插件 v0.7.0）
- **日期**：2026-09-11
- **确认记录**：2026-09-11 用户确认——D1 修复注册形态+门禁；D2 dock=当前会话；D3 完成态全折叠

## 1. 背景与目标

用户在多次迭代后反馈核心痛点：**需求不能一次做完，每次补一块漏一块**。当前最新一轮：
对话框上方已有「⏰ 定时」与「定时排队」dock（正常），但**设置面板「定时发送」内容空白**。
用户要求：目标明确写进需求文件，按 SDD 完整开发测试。

本次目标：**一次收敛**——所有已提需求全部可用且经过测试，设置面板空白根因修复。

## 2. 范围

### 吸收/复用（不重造轮子）
- 排队投递：`sessionController.prompt({mode:'queue'})` → 原生 Inbox `next-turn`
- 排队展示：原生 `conversation.input.dock` 插槽（与 QueueDock 同语义）
- 会话元数据：`useSessions` 投影（GlobalStandardProps，root/session 均可）
- 跳转：`sessions.open(id)`（客户端服务，须 inject 声明）
- 管理入口：`settings.section`（root 作用域）

### 自研范围
1. Host 调度器（Scheduler）+ `/api/scheduled-send/*` 路由 + `jobs.json` 持久化
2. Client：输入区 ⏰ 浮层（时:分:秒 + 今天/明天）、对话区定时排队 dock、设置面板任务管理
3. 工程：产物门禁、安装验证、单测（scheduler/routes/opener/meta）、e2e 脚本

### 非目标
- 跨设备/多 profile 同步；图片/附件投递；多会话聚合 dock；模型自动选择

## 3. 形态与交互

| 入口 | 位置 | 功能 |
|---|---|---|
| ⏰ 定时 | `conversation.input.right`（order 0） | 浮层选时:分:秒+今天/明天 → 创建（内容=输入框草稿） |
| 定时排队 dock | `conversation.input.dock`（order 30） | 当前会话 pending 任务，前置发送时刻，可撤回 |
| 设置面板 | `settings.section`（order 11） | 全部任务按状态分组管理，完成态默认折叠 |

数据流：client → `/api/scheduled-send/*`（host）→ Scheduler（setTimeout）→ 到点 `prompt({mode:'queue'})`。

## 4. 验收标准（含本次必须修复项）

| # | 验收项 | 验证实例 |
|---|---|---|
| A1 | 输入框旁出现「⏰ 定时」；浮层选时间创建成功（今天只可当前之后、明天 0–24、≤3 个/会话、≤10s 超时） | 临时实例 |
| A2 | 创建后对话区上方出现「定时排队」dock，每行**前置发送时刻 HH:MM:SS** + 剩余时间 + 预览 + 撤回 | 临时实例 |
| A3 | **设置面板「定时发送」内容可见**（非空白）：任务按 待触发/已发送/失败/已撤回 分组，完成态默认折叠、可展开；host 在线状态显示 | 临时实例 |
| A4 | 「打开会话」能跳转到目标会话（sessions.open 经 inject 注入） | 临时实例 |
| A5 | 任务列表展示完整 sessionId + 标题 + cwd | 临时实例 |
| A6 | 单测全绿：`pnpm check`（smoke/routes/opener/meta）；e2e 脚本可跑 | 离线 |
| A7 | 安装产物门禁：`verify-installed` 通过 | 离线 |
| A8 | 到点自动投递（mode:queue），重启补投 | 3082（用户验收） |

## 5. 迁移与运维
- 安装：`pnpm install:dev`（link，不自动重启）；重启前征得用户同意
- 回滚：`plugin rm` + 旧版 link/tgz
- 验证窗口：临时实例先行 → 3082 由用户确认后重启

## 6. 待确认决策点

| # | 决策点 | 候选 | 推荐 |
|---|---|---|---|
| D1 | 设置面板空白修复方式 | ① 修注册形态（createElement）② 换插槽 ③ 增加错误边界提示 | ① ✅：`(ui.SettingsSection)(props)` 直接调用 → `React.createElement(ui.SettingsSection, props)`；门禁禁止该模式 |
| D2 | dock 是否跨会话聚合 | 当前会话 only / 全部会话 | 当前会话 only ✅（与原生 dock 语义一致），跨会话归设置面板 |
| D3 | 完成态折叠默认 | 全折叠 / 仅 sent 折叠 | 全折叠 ✅（用户明确"已经完成的默认折叠"） |

## 7. 依赖与风险
- 依赖 dsh：sessionController / webServer / conversation.input.dock / settings.section / sessions / useSessions
- 风险：settings.section 为 root 作用域，`useSessions` 走 GlobalStandardProps（已核实可用）；
  组件注册形态是当前空白主因（已取证：直接调用 vs createElement）
- 兼容：Vision Router order 12；与其他插件无冲突（本插件 order 11）
