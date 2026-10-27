# dsh-scheduled-send

DSH 定时任务插件：给**提示词**设定发送计划（单次 / 每天 / 每周 / 固定间隔 / Cron），
到点由宿主**官方 Schedule 服务**投递进目标会话（常驻 host 进程，页面关闭仍触发）。
本插件不重写调度，只补官方没有的四件事——**管理表单、有效期、执行状态观察、通知联动**，
并让「定时任务」页取代官方「自动化任务」入口。

现行版本 **0.10.9**（任务页新增**跨轮转的运行历史**：每次投递落在哪个会话 + 该次执行结果，
per-run 轮转、重启、任务 id 变化都不丢）；生产 `~/.dsh-dev/profiles/web` 现为 0.10.7（**未重启**，
3082 仍跑 0.10.6 的模块图；官方 `ui-schedule` 已在 profile patch 中 `disabled`），
0.10.8/0.10.9 待用户同意后统一安装重启；版本历史见 [CHANGELOG.md](CHANGELOG.md)。

## 效果预览

侧栏「定时任务」入口（官方品牌区与收起按钮落位自 0.10.2 起由 `dsh-ui-shell` 集中接管）：

![侧栏入口](docs/images/sidebar.png)

任务管理页（统计、待执行/已结束分组、行内操作）：

![任务列表](docs/images/task-list.png)

WorkBuddy 式创建表单（频率 / 有效期 / 目标会话 / Agent 模式 / 执行模型 / 通知）：

![创建表单](docs/images/create-dialog.png)

## 功能

**入口与管理**

- 侧栏「定时任务」独立页：**自定义任务 / 预置任务 tab 切换**（预置 = 插件或脚本以
  `builtin=true` 创建的默认任务，如工作台四报）、待执行/已结束分组、统计徽章（下次执行、
  host 与官方 Schedule 状态）、一键清理已结束任务（`deleteInactive`）。
- 创建/编辑弹窗字段：任务名称、提示词、频率（单次/每天/每周/固定间隔/Cron，时区默认本地）、
  有效期（长期有效 / 截止时刻）、**发送到**（新建任务会话 ⟂ 现有会话）、**Agent 模式**（preset，
  仅新会话可选——现有会话首轮后锁定，只读展示）、**执行模型**、**每次执行新建会话**开关、
  执行完成推送开关。
- 会话模式：`固定会话`（一直追加到同一个会话）⟂ `每次新建会话`（per-run）。周期任务每次触发后
  自动轮转到一个新会话（命名「任务名 · 日期 时间」），历史各在自己的会话里；`builtin` 的
  日报/周报/月报/年报缺省即开启。列表显示模式徽章 + 「本次执行会话 / 下次目标会话」，
  per-run 另给「打开上次会话」。
- 聊天输入框工具行「⏰ 定时」：把当前草稿一键排成一次性任务；输入框上方 dock **只展示本会话的一次性（未触发/未投递完成）任务**——周期任务（每天/每周/间隔/Cron）常驻 dock 会让会话越开越乱，一律只在左侧「定时任务」页查看与编辑。
- 每行操作：编辑 / 立即执行（官方 `runNow` 投递）/ 打开会话 / 删除；展示最近执行结果与投递回执。
- **运行历史**（0.10.9）：每行展开「运行历史（N）」列出按时间倒序的每次运行——本地时间、
  状态（投递成功 / 执行成功 / 执行失败 / 中断）、会话标题与「打开会话」、耗时与摘要或错误，
  手动执行单独标注。记录按**稳定任务键**聚合，per-run 轮转（官方删旧建新、`history()` 清空）
  后仍连续；每任务最多 200 条，超出丢最旧并在页面说明已截断。`fixed` 任务另可一键查看官方投递历史。

**调度与投递（全部复用官方）**

- 任务真身 = 官方 `ctx.schedule.create`（`at/after/every/daily/weekly/cron`），持久化在官方
  `storages/schedule.json`：重启自动恢复、错过自动补投，投递走原生 `user/message`
  （`source.kind='schedule'` framing）——插件不自建定时器、不重写队列语义。
- 新会话路径：`sessionController.create`（preset 在创建请求一步绑定 `agentPreset`）+ `rename`
  自动建任务会话；模型经公开方法 `sessionController.selectModel` 在保存时应用
  （与手动切换同链路，**会同步更新全局默认模型**，表单已注明；模型不可用即创建失败，不建半坏任务）。
- 有效期：`endsAt` 存插件 meta，到期（分片定时器）自动删除官方任务。
- 插件元数据 `<stateDir>/tasks-meta.json`（默认 `$DSH_HOME/profiles/<profile>/scheduled-send`）与
  官方任务表**对账式**合并：官方行为主，meta 缺失走默认，官方已删的行由 `reconcile` 清掉。

**执行状态与通知**

- 监听 `session/event`：`user/message(source=schedule)` 解析任务 id → 同轮 `assistant/message`
  留存摘要 → `turn/end` 按 `reason.kind` 归为 `success/failed/aborted/blocked/max-tokens/interrupted`，
  写回 meta 并刷新列表。
- 通知不落本插件：dsh-notify-alert ≥0.9.0 独立观察同一组官方事件，识别定时轮次后推送
  微信（企微 webhook / WxPusher）。两端只靠**官方事件契约**解耦，不建包依赖。
  全链路（定时投递→模型执行→手机收到推送）已在生产实测通过。

**侧栏品牌区处理**

- 经公开插槽 `sidebar.brand.name` / `sidebar.brand.mark` 注册替换实现：移除「DSH · 本地构建」标识；
  折叠轨道的展开按钮保留可见图标。
- 「收起侧栏」按钮无官方插槽，采用挂载标记类 + 纯 CSS 并入「新会话」行右端（不搬 DOM 节点，
  折叠/展开由官方逻辑原样驱动）；桌面版装了 ui-brand-official 时自动让位。

**安全边界**

- 路由 `/api/scheduled-send/*` exact 注册**绕过** `/api` 前缀鉴权，每条路由显式过
  `connection.requestRejection({headers})`：未登录 401、来源不信任 403；凭据 = 原生 `dsh-auth-*` cookie。
- 不修改上游；只消费公开扩展点（`ctx.schedule`、`sessionController`、`webServer.register`、
  `session/event`、`schedule/changed`、插槽）。
- 明确不做：图片/附件投递、跨设备同步、插件间包依赖；更细的多渠道路由归 notify-alert 设置。

## 隐藏官方「自动化任务」UI

官方调度服务保留、客户端 UI 禁用——profile patch（Ubuntu = `~/.dsh-dev/profiles/web/cordis.patch.yml`）：

```yaml
- id: ui-schedule
  disabled: true
```

只禁 `ui-schedule` 这一个 client 条目；host `schedule` 服务不受影响，官方任务照跑。

## 安装

一律 **tgz 安装**（不用 link）；与 dsh-notify-alert ≥0.9.0 同装才有执行状态推送：

```bash
pnpm check && npm pack        # 门禁构建 + 八组测试 + 打包 → dsh-scheduled-send-0.10.9.tgz

# Ubuntu 源码版（CLI 不在 PATH；脚本默认 DSH_HOME=~/.dsh-dev、profile=web）
DSH_CLI=<cli 绝对路径> ops/linux/install-plugin.sh \
  dsh-plugins/dsh-scheduled-send/dsh-scheduled-send-0.10.9.tgz --apply

# Windows 桌面版
"<安装目录>/resources/runtime/cli/bin/dsh.cmd" plugin --profile desktop add <tgz 绝对路径>
```

- 装完核对 `profiles/web/node_modules/dsh-scheduled-send/lib` 真实存在（`pnpm verify:installed`）。
- **重打包必须升版本号**（五处同步，见 [AGENTS.md](AGENTS.md)）；同版本重打包会被 pnpm 按
  integrity 判「已最新」，残留旧解压产物 → 启动即 `ERR_MODULE_NOT_FOUND`。
- 重启生效 **需用户同意**：Ubuntu `systemctl --user restart dsh-dev-web`；
  Windows 托盘退出后重开桌面应用。

## 构建与验证

```bash
pnpm check              # 门禁构建 + host/client typecheck + 八组测试（smoke/per-run/routes/opener/meta/run-history/hooks/archive）
pnpm typecheck          # tsc --noEmit（host + client）
pnpm verify:installed   # 安装后验证（缺 lib/ / 扁平残留就地拦截）
pnpm e2e                # 端到端 API：node scripts/e2e-3082.mjs [base] --token <启动token>
                        # 探针任务「次日 03:07 单次」→ list/update/delete，不投递真实消息
```

- **三道防坏安装门禁**（构建期自动执行）：顶层布局卫生 / 产物可加载（host 导出断言 +
  client `__ModuleLoader__`、插件 id、插槽断言：`main key=scheduled-send`、`sidebar.panellist`、
  `conversation.input.right|dock`、`settings.section`、`sidebar.brand.name|mark`）/ 安装后验证。
- 不 import `@deepseek-ai/*` 类型包（构建解析不到）：宿主面用本地结构化接口声明
  （`bridge.ts` 的 `ScheduleServiceLike` 等）。
- 隔离实测：独立 home + 3084 端口实例，Playwright 断言（品牌移除、收起按钮并入新会话行且
  不重叠、折叠轨道展开标识可见、建表单条任务、console 零报错），脚本与截图在管理根
  `ops/validation/dsh-scheduled-send-0.8.0/`。

## 环境支持矩阵

| 环境 | 支持度 | 验证状态 |
|---|---|---|
| `ubuntu-4090`（源码构建，127.0.0.1:3082 + CF Tunnel 公网） | 全量 | 生产 `~/.dsh-dev/profiles/web` 已装 0.10.7 但**未重启**（3082 仍跑 0.10.6 模块图）；0.9.5 时的 API e2e、Playwright UI、真实定时任务执行 + 微信推送全链路已通过；**0.10.8/0.10.9 只在隔离 home（`ops/validation/sched-per-run-20261028` 3088 / `ops/validation/sched-history-20261028` 3089）做过真跑验证，未装生产** |
| `windows-lite`（官方桌面版 profile `desktop`） | 全量 | **未在 Windows 实测**。调度跑在桌面 host 进程内，「离开电脑仍触发」前提是 dsh 进程保持运行；装完须**托盘退出后重开**才生效 |

- 数据层：官方 `storages/schedule.json`（任务真身）+ `<stateDir>/tasks-meta.json`（插件元数据），
  不依赖 MySQL/SQLite；无 Python / 本地模型依赖。
- 兼容基线：Node `^22.19.0 || >=24.0.0`；host 产物 target es2022；
  要求 deepseek-harness ≥ 0.2.1-rc.x 且官方 `schedule` 服务可用
  （依赖 `ctx.schedule.catalog/create/update/delete/deleteInactive`、
  `sessionController.create/rename/prompt/selectModel`、`session/event` 的 schedule framing、
  插槽 `sidebar.panellist` / `main(key)` / `conversation.input.right|dock` / `settings.section` /
  `sidebar.brand.name|mark`）。

## 文档索引

| 文件 | 一句话 |
|---|---|
| [docs/images/](docs/images/) | 效果截图（README 用，隔离实例生成） |
| [docs/README.md](docs/README.md) | 文档体系总览与阅读路径 |
| [docs/FILE_INDEX.md](docs/FILE_INDEX.md) | 全插件文档索引（每份一行） |
| [docs/glossary.md](docs/glossary.md) | 本插件术语表 |
| [docs/需求/BRD-业务需求说明书.md](docs/需求/BRD-业务需求说明书.md) | 需求记录（每轮反馈 → 设计决策 → 实现落点） |
| [docs/需求/BRD-001-complete-feature.md](docs/需求/BRD-001-complete-feature.md) 等 SDD 三件套 | 首发/体验期历史记录（0.7.x 形态，非现行规格） |
| [docs/测试/FTR-测试指南.md](docs/测试/FTR-测试指南.md) | 测试文档：单元 / 产物门禁 / e2e / 手工验收清单 |
| [docs/管理/PP-20261028-每次执行新建会话.md](docs/管理/PP-20261028-每次执行新建会话.md) | 0.10.8 per-run 轮转设计与验收（含官方契约核对） |
| [docs/管理/PP-20261028-跨轮转投递历史.md](docs/管理/PP-20261028-跨轮转投递历史.md) | 0.10.9 运行历史聚合视图（稳定任务键 / 上限 / 幂等 / 隔离验收） |
| [docs/管理/RMP-风险管理.md](docs/管理/RMP-风险管理.md) | 事故与排障记录 |
| [docs/history/归档-20261013.md](docs/history/归档-20261013.md) | 历史归档（过期叙述原文，非现行手册） |
| [AGENTS.md](AGENTS.md) | 本插件专属硬规则（inject、鉴权、门禁、版本同步） |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更记录 |

## 附：仓库与共用目录

代码真源 = **独立仓 `IamWWT/dsh-scheduled-send`（public，活跃）**；当前 checkout 物理位于
monorepo 目录 `dsh-plugins/dsh-scheduled-send/` 下，但**仍是独立 git 仓库**（不作为
`dsh-plugins`/管理根的 gitlink，不进 monorepo 的版本同步范围）。
遵循 [DeepSeek 共用目录约定](../../dsh-agent-presets/docs/DIRECTORY-LAYOUT.md)，管理根统一写作 `<DEEPSEEK_ROOT>`；
Bash/systemd 命令只适用于 `ubuntu-4090`。

## 任务会话与工作区成员席位（0.10.7）

任务会话是「专属会话」，不是工作区里的一份空壳。插件建完会话、命名之后立刻用公开的
`workspace.detachSession` 让它退出工作区成员席位：它不出现在工作区列表，也不会被 web 端
「新会话」选中复用。

原因（2026-10-28 生产实证）：宿主的「新会话」会把该工作区**第一个空白会话**交给
`session.create` 复用（判据只有「没有 turn/start + 属于该工作区 + 未归档」）。任务会话恰好
两样都占，又已被 rename 钉住任务标题 —— 用户点一次「新会话」，拿到的是叫「月报-月度总结」
的任务会话，这就是「新会话名被写成任务标题」的根因。空白度是宿主内部状态，插件清不掉，
能动的只有成员席位。

任务第一次真实投递（官方 schedule framing）或用户点「立即执行」后，插件把会话挂回工作区：
此时它已有真实轮次，不可能再被复用，用户照旧能点开看历史。升级后首次启动会做一次迁移，
把旧版本留下的「空白任务会话」也退出列表（只处理插件建过且从未投递过的会话）。

## 跨轮转的投递/执行历史（0.10.9）

per-run 轮转 = 删旧官方任务建新任务，于是官方 `history()` 对新任务是空的：用户看不到上一轮
投递进了哪个会话、那次执行是成功还是失败。0.10.9 让插件自持一份等价记录。

- **稳定任务键**：元数据里给每个任务分配 `taskKey`（`tasks-meta.json` 的 `taskKey` 字段），
  轮转、暂停/恢复、归档迁移、恢复默认都继承它。运行历史按 `taskKey` 存（`tasks-meta.json`
  的 `histories` 段），所以**跨轮转、跨重启、跨官方任务 id 变化**都连续。
- **记录什么**：`at`（投递时刻，本地时区展示）、`sessionId` / `sessionTitle`（这次投递落在哪个
  会话）、`messageId`（官方投递回执；手动执行 = `manual:<requestId>`）、`reason`
  （`scheduled` / `manual-run`）、`execution { status, durationMs, summary, error }`（该次执行结果，
  `turn/end` 归因后吸附到对应条目）。
- **幂等**：按 `messageId` 去重——刷新很频繁（UI 5s 轮询 + `schedule/changed`），
  同一次投递绝不写两条；轮转前后也只在轮转**之前**记一次（记的是接收投递的那个会话）。
- **上限**：每任务 200 条（`RUN_HISTORY_LIMIT`），超出丢最旧并累加 `dropped`，页面显示「已截断」。
- **失败不连坐**：写元数据失败只进 console/journal（`元数据写入失败：…`），投递与轮转照常完成。
- 接口：`POST /api/scheduled-send/tasks/run-history {id, limit?}` → `{entries, dropped, limit, total}`
  （倒序，默认 50 条）；列表接口只在 `TaskView` 里报 `runCount` / `historyTruncated`，
  不把 200 条塞进轮询响应。

设计与验收见 [跨轮转投递历史](docs/管理/PP-20261028-跨轮转投递历史.md)。

## 每次执行新建会话（0.10.8）

官方 Schedule 的任务行只存一个 `sessionId`，且公开 `update` **不能改绑定**
（`ScheduleUpdateRequest` 只有 title/prompt/时间规则，sessionId 只作身份校验）。所以「每次新建会话」
由本插件在一次投递之后做一次轮转：新建会话 → 命名「任务名 · 本地日期时间」→ 立即退席 →
建新官方任务 → 删旧官方任务。判据是官方投递回执的 `messageId`（幂等，同一次投递只轮转一次），
触发器是 `schedule/changed`（页面关闭也生效）+ 「立即执行」。

- **先建后删**：删旧失败就回滚新增的那条，任务回到原会话，不留重复；进程若在两步之间退出，
  下次刷新按 `pendingSwap` 标记收尾。
- **失败不静默**：保留原任务继续按原周期执行，页面显示 `rotateError`；同一次投递最多重试 2 次
  （刷新很频繁，避免每 5 秒重建会话）。
- **执行过的会话挂回工作区**（`turn/start` 之后），未执行的新会话保持退席，不会被「新会话」抢走。
- 代价：轮转后官方投递历史随旧任务行清空（`history()` 对新任务为空；0.10.9 起插件在元数据里
  自持等价记录，见上一节）；`every` 的下一跳按「轮转时刻 + 间隔」重算（几十毫秒级偏差），
  `daily/weekly/cron` 无漂移。

设计与证据见 [每次执行新建会话](docs/管理/PP-20261028-每次执行新建会话.md)。

## 周期任务与预置恢复（0.10.6）

周期任务不随投递会话归档消失。插件保存配置快照，官方归档停止原任务后，在原工作区创建新任务会话并交给官方 Schedule 重新排期。一次性任务保留官方归档停止行为；用户显式删除、截止到期不会自动复活。迁移改变官方任务 id，原投递历史留在原会话；不补投归档期间错过的执行。

预置任务页提供「暂停任务 / 恢复任务」，没有删除按钮。暂停不丢配置、不触发后续排期，不中断已经开始的模型执行；恢复后按周期重新排期。「恢复默认配置」先预览确认，仅更新或补齐预置任务，保留暂停状态，不影响自定义任务。基线为新版本首次接管时登记的配置，之后编辑不覆盖它。

插件状态目录新增 `task-protection.json`（周期配置、预置基线、暂停与迁移意图）及 `reset-backups/`（恢复前配置备份）。它们只保存在本机，不提交会话/提示词。调度、时间计算和投递仍全部走官方服务；插件不自建调度器。原工作区失效时保留配置并在列表提示错误，修复工作区后重试。

实现与验收见 [归档保护任务](docs/管理/PP-20261026-归档保护与默认恢复.md)。Ubuntu 隔离和生产结果以任务记录为准，Windows 未实测。
