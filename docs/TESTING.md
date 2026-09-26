# 测试文档 — dsh-scheduled-send

> 测试分层：**单元测试（离线、纯 Node）→ 产物门禁（构建时）→ 端到端（3082 在线，需重启后）→ 手工 UI 验收**。
> 测试通过后再重启 dsh-dev-web（本插件约定：重启前征求用户同意）。

## 0. 命令速查

```bash
pnpm check             # 全部离线测试：门禁构建 + host/client typecheck + smoke + routes
pnpm test              # 离线单元测试（smoke + routes，无 3082 依赖）
node test/smoke-test.mjs   # 仅 Scheduler 层
node test/routes-test.mjs  # 仅 HTTP 路由层
node test/session-opener-test.mjs  # 仅「打开会话」跳转 helper（this 绑定）
node test/ui-hooks-regression-test.mjs  # React UI hooks 稳定性（#310 防复发，jsdom+ErrorBoundary）
pnpm verify:installed      # 安装布局验证（缺 lib/ / 扁平残留就地拦截）
node scripts/e2e-3082.mjs  # 3082 在线 API 端到端（需重启后）
```

## 1. 单元测试

### 1.1 `test/smoke-test.mjs` — Scheduler 层（9 场景）

纯 Node，直接 `import lib/index.js` 的 `Scheduler`，用临时目录隔离 `jobs.json`。

| # | 场景 | 断言要点 |
|---|---|---|
| 1 | 新建 + 列表 | `add()` 返回 pending 任务、出现在 `list()`、`get(id)` 可取 |
| 2 | fireAt 必须晚于当前 | 过去时间抛 `晚于` |
| 3 | 更新 | 文本/时刻可改 |
| 4 | fire 投递 | mock `sessionController.prompt` 被调用，`mode === "queue"`，内容正确 |
| 5 | fire 失败 → missed | prompt 抛错 → 状态 `missed` + error 记录 |
| 6 | 取消 + 删除 | `cancel` → `cancelled`；`delete` → 从列表移除 |
| 7 | 持久化往返 | 重新 `load()` 后任务仍在（sent 状态保留） |
| 8 | 每会话最多 3 个 | 第 4 个同会话 pending 被拒；不同会话不受影响 |
| 9 | 最晚边界 | `Scheduler.maxFireAt()` = 明天 23:59:59.999；超过被拒 |

### 1.2 `test/routes-test.mjs` — HTTP 路由层（16 项）

用 mock `webServer` 捕获 handler + EventEmitter 模拟 req/res 直接调用 `registerRoutes`。
**每个调用带 2s 超时守卫**——这正是针对 v0.5.0「readBody 误传 res → 永久挂起」根因的回归测试。

| 端点 | 覆盖 |
|---|---|
| `GET /health` | 版本/统计字段 |
| `GET /jobs` | 空表、列表形状 |
| `POST /jobs` 新建 | 缺 sessionId / 缺 text / fireAt 过去 / 超明天结束 均拒绝；正常创建 pending；每会话第 4 个被拒 |
| `POST /jobs` 更新 | **仅 `{id,text}` 可更新**（真实客户端形态，v0.6.0 修复）；空 text 拒绝；无 text 无 fireAt 拒绝 |
| `POST /jobs/fire` | mock prompt 被调用、`mode:queue`、读取更新后的文本 |
| `POST /jobs/cancel` / `delete` | 状态流转 + 移除 |
| 非法 JSON / 不支持方法 | 400 / 405 |

### 1.3 `test/session-opener-test.mjs` — 会话跳转 helper（3 项）

针对 v0.6.0 真实故障「打开会话报 `Cannot read properties of undefined (reading 'manager')`」：
DSH 的 `ISessions.open(id)` 方法体依赖 `this.manager`（`open(){ this.manager.select(id) }`），
若调用方 `const f = svc.open` 再 `f(id)`，`this` 变 undefined 即崩。修复为
`sessionOpenerOf(svc)` 保引用调用（`open.call(svc, id)`）。

| # | 场景 | 断言 |
|---|---|---|
| 1 | 用「方法体依赖 this」的伪服务复现旧姿势 | 解构调用抛 `reading 'manager'`（证明 bug 真实存在） |
| 2 | `sessionOpenerOf` 正常服务 | 跳转函数可调用，`manager.select` 按序收到 id（this 绑定正确） |
| 3 | 降级 | 服务缺失 / 无 open / open 非函数 → 返回 undefined |

> 为什么要有它：此前该 UI 跳转无任何离线测试覆盖（host 单测不涉及客户端服务调用），
> 端到端脚本也只测 API 不测跳转——手工清单已补验。

### 1.3b `test/ui-hooks-regression-test.mjs` — React hooks 稳定性（1 项）

针对 v0.7.2 真实故障 #310「Rendered more hooks」：JobList 的 `useState(collapsed)`
曾位于 `if (jobs.length===0) return` 之后，jobs 空/有切换导致 hooks 数量漂移 →
渲染崩溃 → 设置面板空白。测试用 react-dom/client + jsdom + ErrorBoundary 渲染同一
JobList 两次（jobs=[] → 有数据），边界捕获 #310 即失败。已实测 bug 形态退出 1、
修复形态退出 0。

> 为什么单测/SSR 测不出：单测不渲染 React；SSR 每次独立渲染，不触发同一 root
> 的状态漂移。只有"同一 root 两次渲染"能复现。

### 1.4 产物门禁（`scripts/build.mjs` 内）

构建后自动断言（失败即构建失败，进不了安装环节）：

- 顶层布局卫生：无 `index.ts`/`client.js`/`build.mjs`/`client/`/`host/` 残留、无 `node_modules` 软链；
- `lib/index.js` 可动态 import，导出 `Scheduler/VERSION/apply/inject/name`，`inject` 含 `webServer`；
- `lib/client.js` 含 `__ModuleLoader__`、插件 id、`conversation.input.right`、`settings.section`。

## 2. 端到端测试

### 2.1 API 端到端 `scripts/e2e-3082.mjs`（自动化）

**前置**：用户已重启 dsh-dev-web 且加载当前版本；服务在 127.0.0.1:3082。

```
node scripts/e2e-3082.mjs
```

流程：health（**校验服务版本 == package.json 版本**，防"装错版本还以为生效"）→ jobs 列表 →
创建一条临时 pending 任务 → 确认出现在列表 → cancel → delete → 清理后列表恢复。
只操作临时任务、不 fire、不触碰真实会话消息，幂等可重复运行。

### 2.2 手工 UI 验收清单（重启后）

| # | 步骤 | 期望 |
|---|---|---|
| 1 | 打开 3082，会话页输入框工具行 | 出现「⏰ 定时」标识，与模型标识同行（Vision Router 左侧） |
| 2 | 输入框写内容 → 点 ⏰ | 浮层出现；内容预览为输入框草稿（无额外输入框） |
| 3 | 选「今天」+ 已过时刻 | 提示"今天只能定当前时刻之后"，创建被拒 |
| 4 | 选「今天」+ 未来时刻（或「明天」0–24） | 可创建；成功后输入框按勾选清空；任务秒级创建不卡"创建中" |
| 5 | 同一会话创建 4 个待触发任务 | 第 4 个被拒（每会话最多 3 个） |
| 6 | 设置 → 定时发送 | **面板内容可见（v0.7.0/v0.7.1 回归项）**；若仍异常应看到**错误信息而非空白**（SectionErrorBoundary）；按 待触发/已发送/失败/已撤回 分组；完成态默认折叠（点标题展开）；host 在线状态为绿 |
| 6a | 输入区定时排队 | 创建 pending 任务后输入区上方出现「⏰ 定时排队」dock：**前置 HH:MM:SS 发送** + 剩余时间 + 预览 + 撤回；空则不显示 |
| 7 | 点某任务「放大查看」 | 全文弹层可读 |
| 8 | 点某任务「打开会话」 | 跳到该任务目标会话的对话列表（若报 `reading 'manager'` 说明用了旧 bundle，重启并确认版本） |
| 9 | 「编辑内容」改后保存 | 列表文本更新（回归：v0.6.0 修复的 {id,text} 校验） |
| 10 | 「撤回」后回列表 | 状态变 cancelled，不再发送 |
| 11 | 到点验证 | 目标会话 QueueDock 出现该消息（若 agent 运行则排队等待消费） |
| 12 | 重启 dsh 后未触发任务 | 仍 pending，到点自动补投（可查看 `jobs.json`） |

## 3. 已知盲区 / 说明

- **真实定时触发**（等待到点投递、agent 消费、重启补投）无法在纯离线单测覆盖——依赖真实
  `sessionController` 与 agent 循环，由手工清单 11/12 验收；host 端 `fire` 逻辑已由单测 mock 覆盖。
- **Client UI 交互**（React 渲染、浮层定位、点击外部关闭）依赖浏览器，不在 Node 测试范围，
  由手工清单 2–10 覆盖；`pnpm check` 保证 client 产物可构建、门禁可加载。
- **每会话 3 个上限**在 host（add 强校验）与 client（预检）双层；单测覆盖 host 层，
  手工清单 5 覆盖 UI 提示。
- 端到端脚本只覆盖 API 面，不覆盖真实会话消息投递（有意避免污染用户会话）。

## 4. 故障排查指引

- 单测红 → 改代码后先 `pnpm check` 全绿再谈安装。
- e2e 版本不匹配 → 服务加载的是旧 bundle：确认插件为 link 安装且已重启，
  运行 `pnpm verify:installed` 看安装目录版本。
- e2e 连不上 → 先看设置 → 定时发送 的 host 在线状态；`journalctl --user -u dsh-dev-web` 查崩溃。
