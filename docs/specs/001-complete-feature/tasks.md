# tasks — 定时发送完整功能

## 当前状态

- 文档性质：历史记录（001 的任务清单）
- 对应版本：v0.7.4（任务对应实现版本 v0.7.0）
- 状态：历史记录，结论按当时口径（T1–T4 已执行；T5 为用户 3082 验收项，本文件未回填结果）
- 维护者：AI + 用户

任务粒度 = 一次逻辑改动，每任务三要素：改动文件 / done 定义 / 如何验证。
按序执行，每项完成即 `pnpm check`。

## T1 修复 `settings.section` 注册形态（设置面板空白根因）

- **改动文件**：`src/client/entry.ts`
- **done**：`settings.section` 注册不再直接调用 `(ui.SettingsSection)(props)`，改为
  通过 `React.createElement(ui.SettingsSection, props)`（或等价 `h`）渲染；标准 props（useSessions/
  close/openSession/sessionsUnavailable）透传不变；会话作用域插槽（input.right / input.dock）不动。
- **验证**：
  - `pnpm build` 产物门禁新增断言：`lib/client.js` 不得含 `(ui.SettingsSection)(` 直接调用模式；
    必须含组件化渲染（`createElement(ui.SettingsSection` 或对 ScheduledDock 的引用形态）；
  - `pnpm check` 全绿（smoke/routes/opener/meta + typecheck）。

## T2 构建门禁加"组件注册形态"回归断言

- **改动文件**：`scripts/build.mjs`
- **done**：client 断言新增两条：
  ① 含 `conversation.input.dock`（v0.6.2 已加）；
  ② 不允许 `(ui.SettingsSection)(` 直接调用模式（防回归到本次根因）。
- **验证**：故意把 entry 改回直接调用 → `pnpm build` 应失败（exit 1）；改回组件化 → 通过。

## T3 需求与文档同步（README / REQUIREMENTS / TESTING）

- **改动文件**：`README.md`、`docs/REQUIREMENTS.md`、`docs/TESTING.md`、`CHANGELOG.md`
- **done**：记录 v0.7.0：设置面板空白根因（组件直接调用）与修复；手工验收清单补
  「设置面板内容可见」验证步骤；版本四处同步（package/VERSION/tgz/README）。
- **验证**：`grep -rn "0.7.0" README.md docs package.json src` 四处一致。

## T4 打包与安装验证（不重启 dsh）

- **改动文件**：`dsh-scheduled-send-0.7.0.tgz`（重打包）
- **done**：`pnpm check` 全绿；`verify-installed` 对真实 link 目录通过。
- **验证**：`node scripts/verify-installed.mjs`。

## T5（用户验收，不在本次自动执行）3082 验证

- 用户重启 dsh 后：设置面板「定时发送」内容可见（A3）、dock 前置时刻（A2）、打开会话跳转（A4）、
  完整 id+标题+cwd（A5）、到点投递（A8）。
