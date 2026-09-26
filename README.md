# dsh-scheduled-send

> DSH 插件：给**排队消息 / 预写内容**设定发送时间（如 18:30），到点由 dsh host 自动投递进会话排队队列；agent 运行中逐步消费、空闲时立即成为下一轮。

## 特性

- **复用 dsh 既有排队机制**：到点调用 `sessionController.prompt({ mode: "queue" })` 投递进会话持久队列（Inbox `next-turn`），与 dsh 原生 QueueDock 同通道，**不重造轮子**。
- **定时器跑在 dsh 常驻 host 进程**：web 关闭 / 离开电脑 / 浏览器关闭后仍会在设定时刻触发；dsh 重启后 pending 任务自动补投。
- **入口（v0.4.0+）**：聊天输入框工具行「⏰ 定时」（`conversation.input.right`，与模型标识同行）。
  点开浮层选 `时:分:秒` + 今天/明天 → 把**输入框当前内容**排期。目标会话自动注入，无需填写 session id。
- **不重复输入**：浮层内没有文本输入框，内容直接取 DSH 输入框的当前草稿（`useInput`）；
  创建后可自动清空输入框（`inputActions.setDraft`），避免误按回车双发。
- **时间规则（v0.5.0）**：绝对时刻 `时 : 分 : 秒` 三段下拉；**今天只可定当前时刻之后**（已过即报错提示改选明天），**明天可定 0–24 点**。
- **创建快速且不卡死（v0.5.0）**：所有请求带 10 秒超时；失败/超时给明确文案，绝不无限"创建中…"。
- **每会话最多 3 个待触发任务（v0.5.0）**：host 强校验 + 创建前预检，设置面板有规则说明标签。
- **放大查看（v0.5.0）**：任务列表每行可「放大查看」完整内容（弹层）。
- **跳到对应会话（v0.5.0 / v0.6.1 修复）**：任务列表每行「打开会话」→ 经 DSH 客户端 `sessions.open(id)` 跳到该会话的对话。
  客户端 `inject` 已声明 `sessions`（v0.6.1 修复）；sessions 未注入时面板有明确警告而非静默。
- **会话信息完整展示（v0.6.1）**：任务列表展示**完整 sessionId** + 会话**标题**（displayTitle）与**工作目录 cwd**
  （数据源 = dsh `useSessions` 投影，实时权威）。
- **主题一致**：全部配色走 DSH 主题 token（`--dsw-alias-*` / `--dsw-elevation-panel`），
  随全局明暗与主题切换，不再有写死的深色块。
- **发送前可撤回 / 可编辑**：pending 任务支持「编辑内容」「撤回」「立即发」；sent/missed/cancelled 可删除。
- **对话区定时排队（v0.6.2）**：当前会话有 pending 定时任务时，输入框上方像原生 QueueDock 一样展示「⏰ 定时排队」；
  每行前置明确发送时刻 `HH:MM:SS 发送` + 剩余时间 + 内容预览 + 撤回。
- **管理面板按状态分组（v0.6.2）**：设置 → 左侧「定时发送」（在「Vision Router / 识图」左边）按待触发/已发送/失败/已撤回分组；
  完成态默认折叠，点击分组标题展开。
- **设置面板内容可见（v0.7.0 修复）**：修复 settings.section 组件直接调用的注册瑕疵（改 createElement），
  面板不再空白；构建门禁内置"组件注册形态"断言防回归。
- **持久化**：任务表落 `<stateDir>/jobs.json`，重启不丢。

## 安装（tgz 唯一方式，带门禁；坏布局在装进 profile 前就被拦）

**一律 tgz 安装，不使用 link 安装**（用户决策 2026-09-23；profile 内全部自研插件已转为 tgz，
`link:` 归零）。每次重打包**必须升版本号**，因为源码改动不再热生效：

```bash
cd dsh-plugins/dsh-scheduled-send
pnpm check && npm pack                              # 门禁构建 + 冒烟 + 打包
dsh-dev plugin --profile web add "$PWD/dsh-scheduled-send-<版本>.tgz"
systemctl --user restart dsh-dev-web                 # 你自己确认后再重启
```

日常迭代：改源码 → **升版本号（四处同步，见 AGENTS.md）** → `pnpm check` → `npm pack`
→ `plugin add <tgz>` → 重启 → 刷新 3082。

`pnpm install:dev`（= `bash scripts/install-to-dsh.sh`）当前仍是**源码目录 link 安装**流程
（构建门禁→冒烟→rm 旧→link→安装后验证，不自动重启），与该 tgz 纪律不一致——**本轮文档审计
发现，交维护者改造为 tgz 流程**；在脚本改造完成前，请按上方 tgz 命令安装。

> 为什么不用 link：link 安装让"磁盘新/进程旧"、依赖借外部目录（曾软链到已改名的
> `dsh-personal-workbench`，导致 check 与一键安装脚本双双失效）等耦合问题难以察觉。

### 三道"防坏安装"门禁（为什么会反复弄坏的根治）

| # | 门禁 | 何时触发 | 说明 |
|---|---|---|---|
| 1 | 顶层布局卫生 | `pnpm build` | 源码目录出现顶层 `index.ts`/`client.js`/`build.mjs`/`client/`/`host/` 或 `node_modules` 软链 → 构建直接失败（这些会污染安装进 profile 的目录布局） |
| 2 | 产物可加载 | `pnpm build` | lib/ 双产物存在且非空；host 动态 import 断言导出 `Scheduler/VERSION/apply/inject/name` 且 `inject` 含 `webServer`；client 检查 `__ModuleLoader__`/插件 id/关键插槽 |
| 3 | 安装后验证 | `pnpm verify:installed`（`install:dev` 自动执行） | 对真实安装目录（默认 `~/.dsh-dev/profiles/web/node_modules/dsh-scheduled-send`）检查 package.json.main 指向的文件存在可加载、无扁平残留 |

### 开发期类型检查（跨平台，Windows / Ubuntu 同一套）

本插件按布局红线**不往版本库放 `node_modules`**，因此 `tsconfig` 里的相对
`typeRoots: ["./node_modules/@types"]` 永远解析不到（Windows 上会直接报
`TS2688: Cannot find type definition file for 'node'`）。机制改为：

1. `scripts/paths.mjs` 的 `buildFallbackDirs()` 依次探测
   `env → 同级 deepseek-harness → <DSH_HOME>/profiles/node_modules（hoisted 农场）
   → <DSH_HOME>/profiles/<profile>/node_modules`；
2. `findTypeRoots()` 在以上目录里收集 `@types`，**并补探 pnpm 虚拟 store**
   （`<dir>/node_modules/.pnpm/@types+<pkg>@<ver>/node_modules/@types`）——
   harness/profile 只把 `node`/`jsdom` 等少数 `@types` 提升到 `<dir>/@types`，
   `react`、`react-dom` 只存在于 store 里，不补探就会报 `TS2307: Cannot find module 'react'`；
3. `scripts/build.mjs` 把收集到的目录用 `--typeRoots` 注入 tsc，并经
   `process.execPath` 启动（`findTsc` 返回的是无扩展名的 `typescript/bin/tsc`，
   Windows 没有 shebang，直接 spawn 会 ENOENT）。

> 结论：**干净克隆即可 `pnpm check`**，无需先 `pnpm install`，也不再借别的插件的 `@types`
> （旧做法 `node_modules_types` 已被门禁 1 明文禁止）。

### tgz 安装的缓存陷阱（重要）

pnpm 对 `file:` tgz 依赖按 lockfile 记录的 integrity 判定"是否已最新"，且解压
产物缓存在 pnpm store。**同路径重新打包（哪怕升了版本号）后 `rm` + `add`
仍可能复用 store 里的旧解压产物**——node_modules 混着新旧文件、缺 `lib/`，
典型症状：

```
Cannot find module '.../node_modules/dsh-scheduled-send/lib/index.js'
```

对策（按可靠度排序）：

1. **每次重打包都升版本号**（同步改 tgz 文件名、`package.json` 的 `version`、
   `src/index.ts` 的 `VERSION` 常量）——tgz 安装下这是唯一手段；
2. 或先 `dsh-dev plugin --profile web rm dsh-scheduled-send` 再 `add`，强制重新解压；
3. 装完**必须验证**：`pnpm verify:installed`（或对照门禁 3 的手工检查）。

## 使用

1. 在聊天输入框里写下要发送的内容（就用 DSH 原生输入框，插件不另设输入位）。
2. 点输入框工具行的 **⏰ 定时** 标识。
3. 在弹出的浮层里选 **时 : 分 : 秒** 与 **今天 / 明天**（今天只可定当前时刻之后，明天可定 0–24 点；界面实时显示绝对时刻与剩余时间）。
4. 点「创建定时发送」——内容即被排期，默认同时清空输入框以免误发（每个会话最多 3 个待触发任务，超出会被拒绝）。
5. 到点由 host 自动以 `mode: queue` 投递；期间可在 设置 → 定时发送 里「放大查看 / 打开会话 / 编辑内容 / 撤回 / 立即发 / 删除」。

## 不重造轮子说明

| 能力 | 复用 |
|---|---|
| 排队投递 / 队列消费 | dsh 原生 `sessionController.prompt({mode:'queue'})` + Inbox `next-turn` 持久队列 |
| 会话作用域数据 | 插槽 standard props：`useInput`（读输入框草稿）/ `inputActions`（setDraft）；`sessionId` 走注册时 `inject` 工厂位置参数（framework-resolved） |
| 入口/管理面板 | 输入框工具行 `conversation.input.right`（主入口）+ 设置面板 `settings.section`（管理，与 Vision Router 同机制） |
| 定时器 | host 进程内 `setTimeout`（dsh 由 systemd 常驻，比浏览器定时器可靠） |
| 持久化 | 插件自管 `<stateDir>/jobs.json`（与 dsh-personal-workbench 的 `state.json` 同模式） |

## 不做的事

- 不处理图片 / 附件（与 dsh-personal-workbench 的 `session-prompt` 兜底通道一致，纯文本）。
- 不做跨设备 / 多 profile 同步（MVP 只覆盖当前 web profile）。
- 不修改 dsh 排队 / Inbox 机制本身（完全复用既有投递路径）。

## 配置（`~/.dsh-dev/settings.yaml` 可选）

```yaml
scheduled-send:
  stateDir: ""          # 留空 = $DSH_HOME/profiles/web/scheduled-send
```

> 只声明代码实际消费的键。历史上曾有 `markMissed`/`refreshMs` 两个"纸面上有、代码未实现"的键，
> 配置无效且误导，v0.6.0 起已移除——新增配置必须先实现再声明（见 `cordis.patch.yml` 头部注释）。

## 目录结构

```
dsh-scheduled-send/
├── cordis.patch.yml      # dsh bundle patch（声明配置；只含代码实际消费的键）
├── package.json
├── tsconfig.json         # host（Node ESM）
├── tsconfig.client.json  # client（浏览器 IIFE；react 类型由平台侧 @types 提供，见「开发期类型检查」）
├── scripts/
│   ├── build.mjs         # esbuild 双产物 + 产物门禁（顶层卫生 / 可加载断言）+ tsc
│   ├── typecheck.mjs     # tsc --noEmit（host + client）
│   ├── verify-installed.mjs   # 安装后验证器（缺 lib/ / 扁平残留就地拦截）
│   ├── install-to-dsh.sh      # 一键安装（构建门禁→冒烟→rm 旧→安装→验证；不自动重启）
│   └── e2e-3082.mjs          # 3082 在线 API 端到端（重启后运行；幂等，不碰真实会话）
├── src/
│   ├── index.ts          # host 入口（inject=["webServer"] + 注册路由 + 启动 scheduler）
│   ├── host/
│   │   ├── scheduler.ts  # 任务表 + 定时器 + 投递（每会话 3 个上限；持久化 jobs.json）
│   │   └── routes.ts     # /api/scheduled-send/* HTTP 路由（body 从 req 读，v0.5.0 修复）
│   ├── client/
│   │   ├── entry.ts      # ModuleLoader 握手 + input.right + input.dock + settings.section
│   │   └── ui.ts         # ⏰ 输入区标识 + 浮层（时:分:秒/今天·明天）+ 设置面板（放大查看/打开会话/撤回/编辑/立即发）
│   └── shared/
│       ├── constants.ts  # MAX_PENDING_PER_SESSION=3 / API_TIMEOUT_MS=10s
│       └── types.ts      # 双端共享 wire 类型
├── test/
│   ├── smoke-test.mjs      # Scheduler 层单元测试（9 场景）
│   └── routes-test.mjs     # HTTP 路由层单元测试（16 项；含 readBody 挂起守卫）
├── lib/                  # 构建产物（.gitignore）
└── docs/                 # REQUIREMENTS（需求）+ TROUBLESHOOTING（排障）+ TESTING（测试）· AGENTS/CHANGELOG
```

## 环境支持矩阵（强制）

对照行为基准：[`../docs/ENV-COMPATIBILITY.md`](../docs/ENV-COMPATIBILITY.md) §3。

| 环境 | ubuntu-4090 | windows-lite | 备注 |
|---|---|---|---|
| `dsh-scheduled-send` | 全量 | 全量（纯前端 / 轻后端） | 无 Python / 本地模型 / 数据库依赖；持久化是 `jobs.json` 文件 |

- **ubuntu-4090**：源码树 + systemd（3082），本插件入口、dock、设置面板与到点投递全量可用。
- **windows-lite**：源码树 + `dsh-dev` 方式（手动启动，无 systemd）。功能全量可用；
  差异仅在**进程管理**——Windows 无 systemd，定时器跑在 dsh host 进程内，
  所以「离开电脑仍触发」的前提是 **dsh 进程保持运行**（关掉 dsh 则不会触发，
  与 ubuntu 上停掉 `dsh-dev-web` 语义相同）。
- **数据层**：本插件不依赖 MySQL/SQLite，状态落在 `<stateDir>/jobs.json`（DSH_HOME 内），
  两环境行为一致。

## 文档索引

- [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) —— 需求记录（每轮反馈 → 设计决策 → 实现落点）
- [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) —— 事故与排障记录
- [`docs/TESTING.md`](docs/TESTING.md) —— **测试文档**（单元 / 产物门禁 / 端到端 / 手工验收清单）
- [`CHANGELOG.md`](CHANGELOG.md) —— 版本变更记录
- [`AGENTS.md`](AGENTS.md) —— 本插件开发约定（工作区规范见 `../AGENTS.md`）


## 版本适配（兼容性矩阵）

| 维度 | 要求 | 说明 / 适配项 |
|---|---|---|
| **DSH / deepseek-harness** | 当前开发基线：2026-09 的 deepseek-harness 源码（本机 checkout，`pnpm dsh`） | 依赖以下 dsh 既有能力，升级 dsh 前需验证：<br>① Host `sessionController.prompt({mode:'queue'})`（api/session-controller，排队投递）；<br>② Client 插槽 `conversation.input.right`（会话作用域）与 `settings.section`（root 作用域）—— 两者缺一插件仍加载但对应入口消失；<br>③ Client 服务 `sessions.open(id)`（跳转会话；**插件 `inject` 必须声明 `sessions`**，见 v0.6.1）；<br>④ Host 服务 `webServer`（须在 `inject` 声明）。<br>**升级 dsh 后自检**：`node scripts/e2e-3082.mjs`（版本校验）+ 手工清单见 `docs/TESTING.md` |
| **Node.js** | `^22.19.0 || >=24.0.0`（与 deepseek-harness 的 engines 一致） | host 产物 target es2022；构建脚本依赖 Node >= 18 的 `fetch`/`AbortController`（Node 22 起内置） |
| **浏览器（Client）** | 现代浏览器（支持 ES2022、`fetch`、`AbortController`、`datetime-local`） | client 产物为浏览器 IIFE，经 `window.__ModuleLoader__` 注册 |
| **dsh profile** | `~/.dsh-dev/profiles/web`（3082 dev web，systemd user service 常驻） | 定时器跑在 host 进程；换 profile 需重新安装 |
| **同 profile 其他插件** | 与 `dsh-vision-router`（settings.section order 12）并存；本插件取 order 11（在其左边） | 与 `dsh-personal-workbench` 无运行时依赖，也**不再借它的 `@types`**（见下条）；仅同 profile 并存 |
| **数据/持久化** | `<stateDir>/jobs.json`（默认 `$DSH_HOME/profiles/web/scheduled-send/jobs.json`） | 格式由 `ScheduledJob`（shared/types.ts）定义；版本升级不迁移（字段向后兼容） |

> **升级 dsh 或新增同 profile 插件后**，先跑 `pnpm check`（离线单测）+ `pnpm verify:installed`（安装布局）
> + `node scripts/e2e-3082.mjs`（在线 API），再按 `docs/TESTING.md` 手工清单验收。

## 故障排查

- **任务到点未触发**：检查 dsh 是否在运行（`systemctl --user status dsh-dev-web`）；`<stateDir>/jobs.json` 里该任务 `status` 应为 `sent`（或 `missed` + `error`）。
- **创建时提示 host 不可达 / 超时**：到设置 → 定时发送 看「host 插件在线 · v…」是否为绿；红则说明 host 侧未加载，检查 `journalctl --user -u dsh-dev-web`。
- **任务创建被拒"最多 3 个"**：每个会话最多 3 个待触发任务，先在设置里撤回/删除。
- **提示"今天只能定当前时刻之后"**：今天已过该时刻，改选「明天」（明天可定 0–24 点）。
- **投递失败记 `missed` + error**：多为会话已删除或 `sessionController` 暂时不可用，任务不会重投——可重新创建。
- **设置面板里看不到"定时发送"入口**：确认插件已安装（tgz）且 dsh 已重启；DevTools → Console 过滤 `scheduled-send`。
- **启动即崩 `Cannot find module '.../dsh-scheduled-send/lib/index.js'`**：pnpm store 缓存了旧 tgz 解压产物（见上方"缓存陷阱"）；升版本号重打包，或先 `plugin rm` 再 `add`（`pnpm install:dev` 自带安装后验证）。
- **启动即崩 `cannot get property "webServer" without inject`**：`src/index.ts` 缺少 `export const inject = ["webServer"]` 声明（cordis 上下文代理对未声明属性直接抛错）。
- 完整排障记录：`docs/TROUBLESHOOTING.md`。
<!-- deepseek-shared-layout -->

## Windows / Ubuntu 共用目录

本项目遵循 [DeepSeek 共用目录约定](../dsh-agent-presets/docs/DIRECTORY-LAYOUT.md)。管理根统一写作 `<DEEPSEEK_ROOT>`（`.../deepseek/`），历史部署记录不能视为当前机器状态；Bash/systemd 命令只适用于对应环境（systemd 仅 `ubuntu-4090`；`windows-lite` 手动启动 dsh），配置文件中的路径须在本机解析。

## 仓库归属

本插件是 **`IamWWT/dsh-plugins`（private monorepo）** 的子包 —— 该 monorepo 是全部自研代码的
唯一仓库；工作区根 `deepseek/` 只含 `deepseek-harness/`（上游，只读）+ `dsh-plugins/`（本仓）。
分支模型：`main`（集成）/ `ubuntu`（agent 开发）/ `windows`（用户）。
