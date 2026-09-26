# plan — 定时发送完整功能

## 根因分析（设置面板空白）

**证据链**：
1. `docs/REQUIREMENTS.md` 与源码：`settings.section` 注册在 `entry.ts` 为
   `(props) => { ...; return (ui.SettingsSection)({ ...props, ... }) }`——
   **把组件函数当作普通函数直接调用**，而不是 `React.createElement(ui.SettingsSection, props)`。
2. React 规则：组件必须经 createElement 渲染，其内 `useState/useEffect/useSessions` hooks
   才归属该组件；直接函数调用时 hooks 挂到外层包装组件（每次渲染重新执行、顺序错乱）→ 渲染异常 → 面板空白。
3. 对照：`ScheduledDock`/`InputBadge` 直接传组件引用给 `slots.register`（框架负责 createElement）→ 正常显示。
   **设置面板是唯一"包装函数直接调用"的注册**，与其空白症状吻合。
4. `useSessions` 是 GlobalStandardProps（root 作用域亦有），不是数据缺失根因。

**修复**：`entry.ts` 中 `settings.section` 注册改为 `React.createElement(ui.SettingsSection, { ...props, ... })`
（或等价 `h(ui.SettingsSection, props)`），并保持标准 props（useSessions/openSession 等）透传。

## 技术方案

### Host（已有，保持）
- `Scheduler`（jobs.json / setTimeout / 每会话 3 上限 / maxFireAt）
- `routes`（/api/scheduled-send/*，body 从 req 读）

### Client 改动（本轮聚焦）
1. `entry.ts`
   - `settings.section` 注册：改为组件化渲染（createElement），透传 `useSessions`/`close` 等标准 props；
   - 保留会话作用域插槽（input.right / input.dock）现有正确写发；
   - `sessions`/`slots`/`timer` 已声明 inject（保留）。
2. `ui.ts`（若注册形态修好后仍有空白，才继续查组件内部；预期根因即注册形态）
3. 门禁：`build.mjs` client 断言补 `conversation.input.dock`（已加）、校验 settings.section 注册为**组件**（新增 grep 断言 `createElement` 形态，防止回归到直接调用）

### 测试
- 新增/加强：把「settings.section 注册形态」做成可测断言（静态扫描 `lib/client.js`：
  不允许出现 `(ui.SettingsSection)(` 这类直接调用，必须含 `createElement(ui.SettingsSection` 或 `h(ui.SettingsSection`）。
- 现有：smoke / routes / opener / meta 全保留。

## 风险与对策
| 风险 | 对策 |
|---|---|
| 只修了注册形态但组件内部仍有问题（空白不消失） | 用临时实例 + 控制台诊断逐层排查；spec A3 未被临时实例验证前不声称完成 |
| `useSessions` 在 settings.section 不可用 | 已核实为 GlobalStandardProps；仍保留 fallback（`typeof p.useSessions === 'function'`） |
| 回归到"直接调用组件" | 门禁加入静态断言，禁止该模式 |