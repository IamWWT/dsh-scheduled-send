# AGENTS.md — dsh-scheduled-send（插件专属）

工作区级规范见 `../../AGENTS.md`（尤其「自研插件工程规范」一节），本文件只记录**本插件专属**约定。

## 定位（为什么存在）

dsh 原生排队机制（`sessionController.prompt({mode:'queue'})` → Inbox `next-turn`，QueueDock 同通道）
本身够用，本插件只是它的**薄封装**，只补两层缺失能力：
1. **定时触发**：到点才投递进队列（原生是"立刻排队"）；
2. **任务管理**：设置面板列全部任务 + 放大查看 / 打开会话 / 撤回 / 编辑 / 立即发。

禁止把排队语义、持久化、消费逻辑在插件里重写——一律走原生 Inbox。

## 本插件专属硬规则（违反 = 出故障）

- **版本四处同步**：`package.json.version` = `src/index.ts` 的 `VERSION` = tgz 文件名 = README 提及。
  改版本后自检：`grep -rn "0\.x\.y" README.md docs package.json src`
- **入口插槽**：主入口 `conversation.input.right`（输入框 ⏰ 定时）；管理面板 `settings.section`（order 11，
  Vision Router 在 12，保证在其左边）。**`sessionId` 必须由注册时 `inject(sessionId)` 位置参数注入**
  （v0.4.0 曾误删导致按钮 disabled → 点击无反应，见 `docs/管理/RMP-风险管理.md`）。
- **客户端服务注入**：凡 `ctx.get('sessions')` 必须把 `'sessions'` 写进插件级 `inject`
  （`inject: ["slots","timer","sessions"]`；v0.6.0/v0.6.1「打开会话」两次故障根因，见 `docs/管理/RMP-风险管理.md`）。
  宿主服务方法调用一律 `method.call(svc,...)` 保 this，禁止 `const f = svc.method` 拆出再调。
- **创建流程三保险**：① 客户端 10s 超时（AbortController）绝不无限"创建中"；② 每会话最多 3 个待触发
  （host `Scheduler.add` 强校验 + client 预检）；③ 今天只可定当前时刻之后，明天 0–24 点，host 端
  `Scheduler.maxFireAt()` 封顶（明天 23:59:59）。
- **Host 路由读 body 必须传 req**（`readBody(req)` 或 `readJsonBody(hreq)`），绝不传 res
  （v0.5.0 卡死根因，见 `docs/管理/RMP-风险管理.md`）。
- **配置键必须被消费**：`cordis.patch.yml` 只声明 `stateDir`；新增配置先实现再声明
  （曾有过 markMissed/refreshMs 纸面配置，已删）。
- **产物门禁**：`scripts/build.mjs` 构建后断言 host 导出齐全（Scheduler/VERSION/apply/inject/name，
  inject 含 webServer）与 client 注册（__ModuleLoader__/插件 id/两个插槽）。
- **安装必须验证**：`pnpm install:dev`（link 安装 + verify-installed）或至少 `pnpm verify:installed`。
- **重启 dsh 前必须征求用户同意**；install-to-dsh.sh 不自动重启。

## 开发循环

```bash
pnpm check              # 门禁构建 + host/client typecheck + 冒烟测试
pnpm install:dev        # 一键 link 安装 + 安装后验证（不自动重启）
pnpm verify:installed   # 单独跑安装后验证
```

文档随代码更新：需求演进写 `docs/需求/BRD-业务需求说明书.md`，事故/排障写 `docs/管理/RMP-风险管理.md`，
版本变更记 `CHANGELOG.md`，README 只呈现与当前代码行为一致的现况。