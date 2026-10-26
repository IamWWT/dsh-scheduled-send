# AGENTS.md — dsh-scheduled-send（插件专属）

工作区级规范见 `../../AGENTS.md`（尤其「自研插件工程规范」一节），本文件只记录**本插件专属**约定。
本插件是**官方 Schedule 服务之上的控制面**。

## 定位（为什么存在）

官方 `ctx.schedule`（`@deepseek-ai/dsh-schedule`）已具备定时、持久化、重复规则、会话投递与错过补投，
但缺 WorkBuddy 式表单、有效期、执行状态与通知。本插件只做**四件官方没做的事**：

1. **管理面**：任务页 + 表单 + 侧栏入口 + 输入框快捷排期；
2. **工作区任务会话**：未指定会话时自动建会话并绑定；
3. **有效期**：`endsAt` 元数据 + 到期删除官方任务；
4. **执行状态观察**：解析 schedule framing + `turn/end` 归因，供 notify-alert 推送。

禁止重写调度语义、持久化、投递通道——一律走 `ctx.schedule`；通知发送代码禁止进本插件
（由 dsh-notify-alert 独立观察会话事件完成，**插件间不建包依赖**，只共享官方事件契约）。

## 本插件专属硬规则（违反 = 出故障）

- **版本五处同步**：`package.json.version` = `src/index.ts` 的 `VERSION` = tgz 文件名 = README/CHANGELOG 提及
  = profile 依赖行。改版本后自检：`grep -rn "0\.x\.y" README.md CHANGELOG.md docs package.json src`。
- **host inject 三件套**：`export const inject = ["webServer", "schedule", "sessionController"]`；
  去掉 `schedule` 则控制面瘫痪。宿主服务方法一律 `method.call(svc, ...)` 保 this，禁止拆出裸函数再调。
- **不 import `@deepseek-ai/*` 类型包**：插件构建解析不到（TS2307）。宿主面用 `bridge.ts` 内的
  本地结构化接口（`ScheduleServiceLike` 等）声明；上游契约变化先核对再改本地声明。
- **路由必须显式过鉴权**：`/api/scheduled-send/*` 以 exact 注册，**绕过** `/api` 前缀的
  `connection.admit`；每条路由入口必须 `rejected(ctx, req, res)`（内部
  `connection.requestRejection({headers})`），漏掉 = 公网无凭据管理任务。
- **schedule framing 解析只认结构化字段**：`user/message.source.kind === 'schedule'` 前提下解析
  `schedule_id_json:` / `reminders_json:`；上游改格式先跑 `test/smoke-test.mjs` 的 framing 用例。
- **有效期定时器分片**：`setTimeout` 上限 ~2^31ms，`armOne` 必须拆段续臂；到期动作 = 删除官方任务，
  不在插件里另建「停用」状态。
- **Host 路由读 body 必须传 req**（`readJsonBody(req)`），绝不传 res（v0.5.0 卡死根因，见 RMP）。
- **客户端活读服务快照**：注册期 `list.getSnapshot()` 可能为空（v0.8.0 实测「没有可用工作区」）；
  凡下拉/列表数据必须经活读器（`getWorkspaces()`）在渲染时读取。`ctx.get('sessions')` 类服务
  要写进 client entry 的 `inject`。
- **产物门禁**：`scripts/build.mjs` 断言 host 导出（`ScheduleBridge`/`VERSION`/`apply`/`inject`/`name`，
  inject 含 `webServer`）与 client 注册（`__ModuleLoader__` / 插件 id / 插槽：`main` 的
  `key: "scheduled-send"`、`sidebar.panellist`、`conversation.input.right`、`conversation.input.dock`、
  `settings.section`；`settings.section` 必须是 `createElement(ui.SettingsSection, …)` 形态）。
- **官方 UI 隐藏口径**：只禁 profile 条目 `ui-schedule`（`disabled: true`），不得动 host `schedule` 服务；
  验收必须断言页面「无自动化任务、有定时任务」。
- **配置键必须被消费**：`cordis.patch.yml` 只声明 `stateDir`；新增配置先实现再声明。
- **安装必须验证**：tgz 安装（升版本）→ `pnpm verify:installed` → 用户同意后重启 →
  `pnpm e2e -- --token <启动token>`；隔离回验用独立 home + 3084，不碰生产。
- **重启 dsh 前必须征求用户同意**；install-to-dsh.sh 不自动重启。

## 开发循环

```bash
pnpm check   # 门禁构建 + host/client typecheck + 五组测试（smoke/routes/opener/meta/hooks）
pnpm e2e     # 对活实例：node scripts/e2e-3082.mjs [base] --token <t> [--workspace <id>]
```

文档随代码更新：需求演进写 `docs/需求/BRD-业务需求说明书.md`，事故/排障写 `docs/管理/RMP-风险管理.md`，
版本变更记 `CHANGELOG.md`，README 只呈现与当前代码行为一致的现况。
