版本策略：开发期以源码 link 安装为主（`pnpm install:dev`），每次发布新版本**必须**同步
`package.json.version` / `src/index.ts` VERSION / tgz 文件名 / 文档提及（四处一致）。

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
- **按 SDD 完整闭环**：`docs/specs/001-complete-feature/`（spec/plan/tasks）冻结完整需求与验收
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

