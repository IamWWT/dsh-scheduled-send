# dsh-scheduled-send

> ## ⚠️ 已归档（Archived，2026-10-18）
>
> **归档原因**：已经可以使用 **dsh 自动化任务**做更灵活的定时了；如果确实需要「相对固定的会话发送」，仍可使用本插件。
>
> **状态**：本仓为只读归档，不再维护。源码于 2026-10-18 从 `dsh-plugins` 工作区移出、独立成仓，
> 保留完整提交历史，定格在 **0.7.4**。`docs/` 中原本指向 dsh-plugins 工作区的跨仓相对链接保持原样，
> 可能已失效。已装入 profile 的 0.7.4 不受影响，仍可继续使用。

## 一句话定位

DSH 插件：给**排队消息 / 预写内容**设定发送时间（如 18:30），到点由 dsh 常驻 host 进程自动投递进会话排队队列（`mode: queue`，与原生 QueueDock 同通道）——是 dsh 原生排队机制的**薄封装**，只补「定时触发」与「任务管理」两层能力。

## 当前能力清单

**入口与创建**

- 聊天输入框工具行「⏰ 定时」（`conversation.input.right`，与模型标识同行）：点开浮层选 `时 : 分 : 秒` + 今天/明天 → 把**输入框当前草稿**排期，目标会话自动注入，无需填 session id。
- 浮层内不设文本输入框，内容直接取 DSH 输入框当前草稿（`useInput`）；创建后可自动清空输入框（`inputActions.setDraft`），避免误按回车双发。
- **时间规则**：今天只可定当前时刻之后（已过即报错提示改选明天），明天可定 0–24 点；host 端 `Scheduler.maxFireAt()` 封顶，界面实时显示绝对时刻与剩余时间。

**投递与持久化**

- 到点调用 `sessionController.prompt({ mode: "queue" })` 投进会话持久队列（Inbox `next-turn`）；定时器跑在 dsh 常驻 host 进程——web 关闭 / 离开电脑 / 浏览器关闭后仍会触发；dsh 重启后 pending 任务自动补投。
- 任务表落 `<stateDir>/jobs.json`（默认 `$DSH_HOME/profiles/web/scheduled-send/jobs.json`），重启不丢；字段向后兼容，版本升级不迁移。
- **每会话最多 3 个待触发任务**（host `Scheduler.add` 强校验 + client 创建前预检），设置面板有规则说明标签。
- 所有请求带 10 秒超时（AbortController）+ 明确失败文案，绝不无限「创建中…」。

**任务管理**

- 设置 → 左侧「定时发送」（`settings.section`，order 11）：按**待触发 / 已发送 / 失败 / 已撤回**分组，完成态默认折叠，点分组标题展开。
- 每行操作：**放大查看**（弹层看完整内容）/ **打开会话**（`sessions.open(id)` 跳到该会话对话）/ **编辑内容** / **撤回** / **立即发** / **删除**。
- 每行展示完整 sessionId + 会话标题（displayTitle）+ 工作目录 cwd（数据源 = dsh `sessions` 服务的 list 投影；`src/client/entry.ts` 在注册层用 `list.getSnapshot()` 取同步快照传入，组件内不调 hook）；`sessions` 未注入时面板给明确警告而非静默。
- **对话区定时排队**：当前会话有 pending 任务时，输入框上方像原生 QueueDock 一样展示「⏰ 定时排队」，每行含 `HH:MM:SS 发送` + 剩余时间 + 内容预览 + 撤回。
- 配色全走 DSH 主题 token（`--dsw-alias-*` / `--dsw-elevation-panel`），随全局明暗切换。

**边界（明确不做）**

- 不处理图片 / 附件（纯文本：`Scheduler.fire()` 只投 `content: [{ type: "text", text }]`）；不做跨设备 / 多 profile 同步（MVP 只覆盖当前 web profile）；不修改 dsh 排队 / Inbox 机制本身。
- 配置只声明代码实际消费的键：`stateDir`（声明处 = `cordis.patch.yml` 的 bundle insert config，内置缺省 `""` = `$DSH_HOME/profiles/<profile>/scheduled-send`）。
  **旧口径"写在 `$DSH_HOME/settings.yaml`"已失效**（2026-10-13 更正）：该文件已不再被加载——框架迁移时把它改名为 `settings.yaml.imported`（见 `dsh-plugins/docs/管理/CMP-插件开发规范.md` §2.7.1）；本插件未注册设置面板配置卡片，覆盖 `stateDir` 要走 profile 侧配置，编辑 `settings.yaml` 无效。

## 安装

一律 **tgz 安装**，不使用 link：

```bash
cd dsh-plugins/dsh-scheduled-send
pnpm check && npm pack        # 门禁构建 + 冒烟 + 打包 → dsh-scheduled-send-0.7.4.tgz

cd ../../deepseek-harness
DSH_HOME=~/.dsh-dev pnpm dsh plugin --profile web add \
  /home/wwt/Downloads/aigc/proj/deepseek/dsh-plugins/dsh-scheduled-send/dsh-scheduled-send-0.7.4.tgz
```

- 装完核对 `~/.dsh-dev/profiles/web/node_modules/dsh-scheduled-send/lib` 真实存在；`pnpm verify:installed` 做同一检查。
- **重打包必须升版本号**（四处同步，见 [AGENTS.md](AGENTS.md)）：pnpm 对 `file:` tgz 按 lockfile integrity 判「已最新」并缓存解压产物，同版本重打包会残留缺 `lib/` 的旧布局（症状：启动即 `Cannot find module '.../lib/index.js'`）。对策：升版本号，或先 `plugin rm dsh-scheduled-send` 再 `add`，装完必跑 `pnpm verify:installed`。
- 重启 3082 **需用户同意**：`systemctl --user restart dsh-dev-web`；windows-lite 托盘退出后重开桌面应用。
  （端口拓扑：3082 是 `dsh-web-relay` 的纯 TCP 转发口，dsh 本体在 `127.0.0.1:3083`（`dsh-dev-web`）——
  重载插件只需重启 `dsh-dev-web`，relay 不必重启。）
- `pnpm install:dev`（= `bash scripts/install-to-dsh.sh`）当前仍是**源码目录 link 安装**流程（构建门禁→冒烟→rm 旧→link→安装后验证，不自动重启），与 tgz 纪律不一致；脚本改造前请按上方 tgz 命令安装。

## 构建与验证

`package.json` scripts：`build` / `build:full` / `check` / `typecheck` / `test` / `pack` / `verify:installed` / `install:dev` / `e2e`，以及按层拆分的 `test:smoke` / `test:routes` / `test:opener` / `test:meta` / `test:hooks`。

```bash
pnpm check              # 门禁构建 + host/client typecheck + 五组测试（smoke/routes/opener/meta/hooks）
pnpm typecheck          # tsc --noEmit（host + client）
pnpm verify:installed   # 安装后验证（缺 lib/ / 扁平残留就地拦截）
pnpm e2e                # = node scripts/e2e-3082.mjs：3082 在线 API 端到端（重启后跑，幂等，不碰真实会话）
```

**三道「防坏安装」门禁**（构建期自动执行）：

| # | 门禁 | 何时触发 | 说明 |
|---|---|---|---|
| 1 | 顶层布局卫生 | `pnpm build` | 源码目录出现顶层 `index.ts`/`client.js`/`build.mjs`/`client/`/`host/` 或 `node_modules` 软链 → 构建直接失败（会污染装进 profile 的目录布局） |
| 2 | 产物可加载 | `pnpm build` | `lib/` 双产物存在且非空；host 动态 import 断言导出 `Scheduler/VERSION/apply/inject/name` 且 `inject` 含 `webServer`；client 检查 `__ModuleLoader__` / 插件 id / 关键插槽 |
| 3 | 安装后验证 | `pnpm verify:installed` | 对真实安装目录检查 `package.json.main` 指向的文件存在可加载、无扁平残留 |

- 类型检查跨平台：`scripts/paths.mjs` 依次探测 `env → 同级 deepseek-harness → <DSH_HOME>/profiles/node_modules → <DSH_HOME>/profiles/<profile>/node_modules` 收集 `@types`（并补探 pnpm 虚拟 store），由 `scripts/build.mjs` 以 `--typeRoots` 注入 tsc，经 `process.execPath` 启动。**干净克隆即可 `pnpm check`**，无需先 `pnpm install`（本插件按布局红线不往版本库放 `node_modules`）。
- 升级 dsh 或新增同 profile 插件后：`pnpm check` + `pnpm verify:installed` + `node scripts/e2e-3082.mjs`，再按 [docs/测试/FTR-测试指南.md](docs/测试/FTR-测试指南.md) 手工清单验收。

## 环境支持矩阵

| 环境 | 支持度 | 验证状态 |
|---|---|---|
| `ubuntu-4090`（源码构建 + systemd 3082） | 全量 | **host 侧 0.7.4 已加载并响应**（2026-10-13 实测 `/api/scheduled-send/health` → `{"ok":true,"version":"0.7.4",…}`）；入口 / dock / 设置面板与到点投递的**人工验收未记录 → 未验证** |
| `windows-lite`（官方桌面版 profile `desktop`，无 systemd） | 全量 | **未在 Windows 实测**（本机无法验证）。差异仅在**进程管理**——无 systemd，定时器跑在 dsh host 进程内，「离开电脑仍触发」的前提是 dsh 进程保持运行；**未验证** |

- 数据层：不依赖 MySQL/SQLite，状态落 `<stateDir>/jobs.json`（DSH_HOME 内），两环境行为一致；无 Python / 本地模型依赖。
- 兼容基线：Node `^22.19.0 || >=24.0.0`（与 deepseek-harness `engines` 一致）；host 产物 target es2022；浏览器需支持 ES2022 / `fetch` / `AbortController`；要求当前 deepseek-harness 基线（依赖 `sessionController.prompt({mode:'queue'})`、插槽 `conversation.input.right` / `conversation.input.dock` / `settings.section`、客户端服务 `sessions.open(id)`、host 服务 `webServer`）。

## 文档索引

| 文件 | 一句话 |
|---|---|
| [docs/README.md](docs/README.md) | 文档体系总览与阅读路径 |
| [docs/FILE_INDEX.md](docs/FILE_INDEX.md) | 全插件文档索引（每份一行） |
| [docs/glossary.md](docs/glossary.md) | 本插件术语表 |
| [docs/需求/BRD-业务需求说明书.md](docs/需求/BRD-业务需求说明书.md) | 需求记录（每轮反馈 → 设计决策 → 实现落点） |
| [docs/需求/BRD-001-complete-feature.md](docs/需求/BRD-001-complete-feature.md) + [docs/管理/PP-001-complete-feature-计划.md](docs/管理/PP-001-complete-feature-计划.md) / [任务](docs/管理/PP-001-complete-feature-任务.md) | 首发完整功能规格（SDD 三件套，历史记录） |
| [docs/需求/BRD-20260925-experience.md](docs/需求/BRD-20260925-experience.md) + [docs/管理/PP-20260925-experience-计划.md](docs/管理/PP-20260925-experience-计划.md) / [任务](docs/管理/PP-20260925-experience-任务.md) | 布局 / 窄容器适配与键盘焦点优化规格（历史记录） |
| [docs/测试/FTR-测试指南.md](docs/测试/FTR-测试指南.md) | 测试文档：单元 / 产物门禁 / 端到端 / 手工验收清单 |
| [docs/管理/RMP-风险管理.md](docs/管理/RMP-风险管理.md) | 事故与排障记录 |
| [docs/history/归档-20261013.md](docs/history/归档-20261013.md) | 历史归档（被删除的过期叙述原文，非现行手册） |
| [AGENTS.md](AGENTS.md) | 本插件专属硬规则（插槽、inject、创建流程三保险、门禁） |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更记录 |

## 版本号

**0.7.4**（`package.json.version` = `src/index.ts` 的 `VERSION` = tgz 文件名 `dsh-scheduled-send-0.7.4.tgz`）

## 附：仓库与共用目录

唯一代码仓库 = `IamWWT/dsh-plugins`（private monorepo），本插件目录 `dsh-plugins/dsh-scheduled-send/`；分支 `main`（集成）/ `ubuntu`（agent 开发）/ `windows`（用户）。遵循 [DeepSeek 共用目录约定](../../dsh-agent-presets/docs/DIRECTORY-LAYOUT.md)，管理根统一写作 `<DEEPSEEK_ROOT>`（`.../deepseek/`）；Bash/systemd 命令只适用于 `ubuntu-4090`。
