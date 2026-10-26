# 测试文档 — dsh-scheduled-send

## 当前状态

- 文档性质：操作手册（分层测试与验收操作指南）
- 对应版本：v0.9.5
- 状态：有效（测试面对象 = `ScheduleBridge`（官方 schedule 服务控制面）+ `/tasks` 路由契约）
- 维护者：AI + 用户

> 测试分层：**单元测试（离线、纯 Node，mock 官方服务）→ 产物门禁（构建时）→ 隔离实例真实加载
> （Playwright，独立 home + 3084）→ 端到端 API（活实例，token 鉴权）→ 手工 UI 验收**。
> 测试通过后再重启 dsh-dev-web（本插件约定：重启前征求用户同意）。

## 0. 命令速查

```bash
pnpm check             # 全部离线测试：门禁构建 + host/client typecheck + 下 5 个测试脚本
pnpm test              # 离线单元测试（不含构建门禁/typecheck）
node test/smoke-test.mjs             # ScheduleBridge 层（mock 官方 schedule/sessionController）
node test/routes-test.mjs            # HTTP 路由层（含 401 鉴权回归）
node test/session-opener-test.mjs    # 「打开会话」跳转 helper（this 绑定）
node test/session-meta-test.mjs      # 会话标题派生纯函数
node test/ui-hooks-regression-test.mjs  # TaskPage hooks 稳定性（#310 防复发，jsdom+ErrorBoundary）
pnpm verify:installed  # 安装布局验证（缺 lib/ / 扁平残留就地拦截）
node scripts/e2e-3082.mjs <base> --token <启动token> [--workspace <id>|--session <id>]  # 活实例 API 端到端
```

## 1. 单元测试

### 1.1 `test/smoke-test.mjs` — ScheduleBridge 层

纯 Node，mock 官方 `schedule` 服务（catalog/create/update/delete/deleteInactive）与
`sessionController`（create/rename/prompt），临时目录隔离 `tasks-meta.json`。

| 场景组 | 断言要点 |
|---|---|
| 建任务（选工作区） | `sessionController.create({workspaceId})` + `rename(任务名)` 被调；官方 `create` 收到绑定该会话的请求；meta 落 `workspaceId/sessionTitle/notify/createdAt` |
| 建任务（已有会话） | 不新建会话，直接绑定 `sessionId` |
| 列表 | 官方 `catalog` 行 + meta 合并为 `TaskView`（frequency 还原、下次执行、`lastExecution`）；meta 缺失行走默认值 |
| 更新 | 标题/提示词/频率/`endsAt` 变更 → 官方 `update` 载荷正确 + meta 同步 |
| 立即执行 | `runNow` → 官方投递通道被调 |
| 删除 | 官方删除 + meta 行清掉（`reconcile` 对账一致） |
| 参数校验 | 缺 title/prompt、非法 cron、非法星期 → 明确抛错，不落半坏任务 |
| 有效期到期 | `endsAt` 到点 → 官方任务被 `delete`（分片定时器测试用短时限注入） |

### 1.2 `test/routes-test.mjs` — HTTP 路由层

mock `webServer` 捕获 exact handler + EventEmitter 模拟 req/res 直接调 `registerRoutes`；
每个调用带超时守卫（v0.5.0「readBody 误传 res → 永久挂起」的回归位）。

| 端点 | 覆盖 |
|---|---|
| `GET /health` | `ok/version/active/total`；官方服务缺失 → 503 + error |
| `GET/POST /tasks` | 列表形状；创建载荷透传 bridge；bridge 抛错 → 200 + `ok:false`（人话 error） |
| `POST /tasks/update` | 缺 id → 400；正常 → 更新后 task |
| `POST /tasks/delete` / `delete-inactive` / `run` / `history` | 参数校验 + 成功形状 |
| 方法不支持 | 405 + `ok:false` |
| **鉴权** | mock `connection.requestRejection` 返回 401/403 → 响应码与文案一致，**业务 handler 未被调用**（exact 路由绕过 `/api` 前缀鉴权的回归位） |

### 1.3 `test/session-opener-test.mjs` — 会话跳转 helper（3 项）

「打开会话」必须保 `this` 引用调用（`open.call(svc, id)`）；DSH `ISessions.open` 方法体依赖
`this.manager`，解构裸调即崩（v0.6.0/v0.6.1 真实故障）。伪服务复现旧姿势 → `sessionOpenerOf` 正常
→ 服务缺失降级返回 undefined。

### 1.3b `test/ui-hooks-regression-test.mjs` — TaskPage hooks 稳定性

react-dom/client + jsdom + ErrorBoundary：同一 root 渲染 `TaskPage` 两次（空列表 → 有任务），
mock `fetch` 与 `window.setInterval`（`Object.defineProperty` 先装再渲染，捕获 poll 后在 `act` 内驱动）。
hooks 数量漂移（#310）→ ErrorBoundary 捕获即失败。断言任务标题渲染出镜。

### 1.3c `test/session-meta-test.mjs` — 会话元数据派生

`shared/session-meta.ts` 纯函数：`byId` 投影折叠为 `sessionId -> {title, cwd}` 查询表；
displayTitle 优先、回退 title、缺字段不抛、空投影返回 `{}`。组件内禁止条件 hook，故由 entry 层取快照后传入。

### 1.3d notify-alert 侧配对测试（跨插件契约）

执行状态通知的行为覆盖在 **dsh-notify-alert `test/unit.test.mjs`**（0.9.0 块）：
framing 解析（单条/批量）、`turn/end` reason → 状态映射（含 forked 不通知）、
`scheduleExecSuccess=false` 静默且不回落普通 turn-end、`scheduleExec=false` 回落、
zh/en 文案与合并键。两插件契约改动必须两侧同时跑。

### 1.4 产物门禁（`scripts/build.mjs` 内）

- 顶层布局卫生：无 `index.ts`/`client.js`/`build.mjs`/`client/`/`host/` 残留、无 `node_modules` 软链；
- `lib/index.js` 可动态 import，导出 `ScheduleBridge`/`Scheduler`/`VERSION`/`apply`/`inject`/`name`，
  `inject` 含 `webServer`；
- `lib/client.js` 含 `__ModuleLoader__`、插件 id、`sidebar.panellist`、`key: "scheduled-send"`（main 插槽）、
  `conversation.input.right`、`conversation.input.dock`、`settings.section`；
- `settings.section` 必须以 `createElement(ui.SettingsSection, …)` 形态注册（v0.7.0 回归项）。

## 2. 隔离实例真实加载（0.8.1 已执行，2026-10-26）

- 环境：`ops/validation/dsh-scheduled-send-0.8.0/home`（独立 DSH_HOME + profile web，
  bundle 依赖 notify-alert 0.9.0 + scheduled-send 0.8.1；profile patch 含 `- id: ui-schedule` + `disabled: true`），
  端口 3084，系统 Chrome + Playwright。
- 脚本：`ops/validation/dsh-scheduled-send-0.8.0/verify-ui.cjs`。
- 断言（实测全真）：侧栏出现「定时任务」；**官方「自动化任务」不出现**；「添加定时任务」弹窗可填可交；
  创建后列表出现「验证任务/待执行」；console 零报错；清理临时任务。
- 证据：同目录 `screenshots/01-main.png`…`04-task-created.png`、`web.log`（token URL）。

## 3. 端到端测试

### 3.1 API 端到端 `scripts/e2e-3082.mjs`（自动化，活实例）

**前置**：dsh 已重启并加载当前版本；从启动日志取 `?token=`。

```
node scripts/e2e-3082.mjs http://127.0.0.1:3082 --token <t> --workspace <id>
```

流程：token 页面登录兑换 `dsh-auth-*` cookie → health（**校验服务版本 == package.json**）→
tasks 列表 → 创建「次日 03:07 单次」探针任务（notify 关）→ 确认 active 列表 → update 改名 →
delete → 列表恢复。只操作临时任务、不调 run、不投递真实消息，幂等可重复。
（2026-10-26 已对 3084 隔离实例跑通全步骤。）

### 3.2 手工 UI 验收清单（生产重启后）

| # | 步骤 | 期望 |
|---|---|---|
| 1 | 打开 web UI | 侧栏有「定时任务」；**无**「自动化任务」；会话头部/回合卡不再出现官方日程标记 |
| 2 | 「添加定时任务」 | 弹窗六要素齐全：名称/提示词/频率/有效期/工作区/通知；「允许完全访问」为展示文案 |
| 3 | 频率逐种试 | 单次/每天/每周/固定间隔/Cron 各有非法值即时提示（cron 空、星期未选等） |
| 4 | 选工作区创建 | 该工作区出现以任务名命名的新会话；列表行显示会话链接 |
| 5 | 行操作 | 编辑（改频率生效）/ 立即执行（目标会话收到投递）/ 打开会话 / 删除（meta 同步清） |
| 6 | 有效期 | 设一个近未来 `endsAt` → 到期后任务从官方列表消失、进入「已结束」折叠区 |
| 7 | 输入框「⏰ 定时」 | 当前草稿建一次性任务；dock 行显示待触发预览 |
| 8 | 通知联动 | 装 notify-alert ≥0.9.0 且渠道配好：任务执行完成后微信收到「定时任务完成/失败」推送（含任务名/耗时/结果摘要）；同轮**不再**重复发普通「回合结束」 |
| 9 | 鉴权 | 未登录直接 `curl /api/scheduled-send/tasks` → 401 JSON；公网域名同样 |
| 10 | 重启恢复 | 任务表与 meta 不丢；错过时刻由官方补投 |

## 4. 已知盲区 / 说明

- **真实模型执行 + 微信送达**整链未在真机跑通（各段有单测与隔离 UI 证据；生产安装后按 §3.2 #8 人工验收）。
- Client 交互（弹窗定位、明暗主题）依赖浏览器，由隔离 Playwright 与手工清单覆盖。
- Windows 桌面版**未实测**：两端只共用源码，安装/重启路径不同（托盘退出重开）。
- e2e 有意不调 `run`，避免向真实会话投递。

## 5. 故障排查指引

- 单测红 → 先 `pnpm check` 全绿再谈安装。
- e2e 401 → token 过期（重启换新）或未按 `--token` 传入；确认 `dsh-auth-*` cookie 已收集（脚本会打印）。
- e2e 版本不匹配 → 服务加载旧 bundle：升版本重打 tgz、`plugin add`、重启、`pnpm verify:installed`。
- 页面没有「定时任务」→ 看 profile 是否装了本包、`ui-schedule` 禁用是否误把 host `schedule` 条目也关了
  （health 503 = 宿主服务缺失）。
- 列表有任务但徽章不动 → `session/event` 未达（观察者异常会 console.warn，`journalctl --user -u dsh-dev-web` 查）。

## 6. 0.9.x 增量覆盖（2026-10-26）

- **smoke-test 场景 5b/5c**：真实事件形状（`user/message` 直挂 `data`）执行链路回归；
  `agentPreset` 创建绑定、`selectModel` 应用与失败即建失败、`model:null` 只清记录。
- **verify-ui.cjs（隔离 3084）**：品牌移除（无「本地构建」）、收起按钮与新会话行
  **垂直居中对齐且矩形不相交**、表单三字段（发送到/Agent 模式/执行模型）、建任成功、console 零报错。
- **verify-rail.cjs（隔离 3084 + 生产 3082）**：折叠后轨道 `[data-dss-brand="mark"]` 可见
  （父容器 class 含 `railMark`）、点「打开侧边栏」可恢复展开。
- **生产验收**：真实定时任务执行 + 微信推送全链路（见 BRD §7）；截图证据
  `ops/validation/dsh-scheduled-send-0.8.0/screenshots{,-prod}/`。
