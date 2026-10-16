# dsh-scheduled-send 排障记录

## 当前状态

- 文档性质：操作手册（排障知识库：现象 → 根因 → 修复 → 预防）
- 对应版本：v0.7.4
- 状态：有效（各条根因、修复与速查结论现行有效；条目按当时版本记录，其中 `MAX_SCHEDULE_HOURS = 20`、"今天已过自动顺延"等属**历史口径**，现行时间规则见 `../需求/BRD-业务需求说明书.md` §2.2）
- 维护者：AI + 用户

## 2026-09-10 装包后 3082 崩溃循环（两连击）

现象：装完插件后 `dsh-dev-web.service` 反复 `exit 1` 自动重启；
`pnpm dsh plugin --profile web list` 也长时间卡死（Ctrl+C 才退出）。

### 第一层：pnpm 锁定的旧 tgz（`Cannot find module .../lib/index.js`）

- 插件从扁平布局（`index.js`/`client.js` 在顶层）重构为 `src/ + lib/` 后，
  用**同一版本号 0.1.0、同一文件名**重新 `npm pack` 覆盖了 tgz。
- pnpm 对 `file:` tgz 依赖按 `pnpm-lock.yaml` 里记录的 `integrity`（tgz 的
  sha512）判定是否已安装：lockfile 未变 → 判定"已最新" → **不会重新解压**，
  `node_modules/dsh-scheduled-send/` 里留着旧布局（`package.json` 指向
  `lib/index.js` 但目录里没有 `lib/`）。
- loader 加载 bundle 入口 `lib/index.js` 失败 → 整个 plugin tree 加载失败 →
  web 进程启动即崩。

**修复**：

```bash
# 在 deepseek-harness/ 目录下（dsh-dev 是 pnpm 包装）
DSH_HOME=~/.dsh-dev pnpm dsh plugin --profile web rm dsh-scheduled-send
DSH_HOME=~/.dsh-dev pnpm dsh plugin --profile web add \
  /abs/path/dsh-scheduled-send/dsh-scheduled-send-0.1.0.tgz
systemctl --user restart dsh-dev-web
```

**预防**：

1. 同版本号重新打包后，**必须** `plugin rm` + `plugin add`，不能只 `add`；
2. 或每次重打包都升版本号（0.1.0 → 0.1.1，同步改 tgz 文件名、
   `package.json` 的 `version`、`src/index.ts` 的 `VERSION` 常量）；
3. 验证手段：`pnpm-lock.yaml` 里该包 `integrity` 应等于
   `openssl dgst -sha512 -binary <tgz> | base64 -w0` 的结果。

### 第二层：cordis 未声明 inject（`cannot get property "webServer" without inject`）

修复第一层后重启，仍崩——这次是插件自身 bug：`registerRoutes` 访问
`ctx.webServer`，但 `src/index.ts` 没有声明依赖。cordis 的上下文是 Proxy，
**未注入的属性一律访问即抛错**（`vendor/cordis/src/reflect.ts`），不是返回 undefined。

**修复**：`src/index.ts` 增加（与 dsh-personal-workbench / dsh-troubleshoot-workbench 一致）：

```ts
export const inject = ["webServer"];   // webServer 由 @deepseek-ai/dsh-host-webserver 提供
```

> 注（2026-10-13）：括注中的 `dsh-troubleshoot-workbench` 已于 2026-10-01 退役移除
> （见 [../../../readme.md](../../../readme.md)「已退役」条），`dsh-personal-workbench` 亦非本机 web profile 依赖；
> 该对照只是当时的写法来源，**本插件的判据是下面的"约定"**。

**约定**：本插件 host 端凡是 `ctx.<prop>` 直接取用的服务（目前仅 `webServer`；
`ctx.get(...)` / `ctx.effect` 是 Context 实例方法，无需声明），都必须在
`inject` 数组里登记。新增对其它 ctx 属性的直接访问时同步补声明。

## 日常维护速查

| 症状 | 处理 |
|---|---|
| 启动崩 `Cannot find module .../lib/index.js` | 旧 tgz 缓存：`plugin rm` + `plugin add`（见上） |
| 启动崩 `cannot get property "webServer" without inject` | `src/index.ts` 补 `export const inject = ["webServer"]`，重建重装 |
| 服务崩溃循环 | `journalctl --user -u dsh-dev-web --no-pager \| grep -iE 'error'` 看真实报错 |
| 临时停掉免打扰 | `systemctl --user stop dsh-dev-web` |

## 2026-09-10 v0.2.0 需求迭代（入口位置 + 时间选择 + 撤回/编辑）

用户反馈与处理：

1. **入口位置**：v0.1.0 的入口在侧栏底部折叠栏（`sidebar.footer.action`），
   用户要求与 Vision Router（「识图」，settings.section order 12）放在一起、在其左边。
   v0.2.0 改为 `settings.section`（id `scheduled-send`，order 11），与 Vision Router
   同款注册机制，出现在设置面板左侧导航「Vision Router」左边。
2. **点击无反应**：v0.1.0 用普通对象 `bus` + 无人订阅的 `notify()` 驱动
   `shell.overlay` 面板，`setBus` 后没有任何 React 重渲染，overlay 永远 `open=false`。
   v0.2.0 改为 settings section：点击导航行即由 dsh 设置面板自身切换内容列，
   面板是 section 的正常渲染产物，不存在"打开开关"问题。
3. **时间选择**：新增快捷预设（15m/30m/1h/2h/6h/12h/20h）+ 自定义
   `datetime-local`；创建时强制校验：必须晚于现在、且 ≤ 20 小时
   （`MAX_SCHEDULE_HOURS = 20`，host 端 `scheduler.add/update` 只校验"晚于现在"，
   20h 上限由 client 表单强制——若需要 host 侧也卡死，可在 `add/update` 加
   `fireAt - now <= MAX_SCHEDULE_MS` 校验，当前版本未加）。
4. **撤回 / 编辑**：pending 任务行内提供「编辑内容」（内联 textarea 保存回写，
   走 `POST /jobs` 的 update 分支）、「撤回」（`POST /jobs/cancel`，状态 → cancelled，
   摘除定时器）、「立即发」（`POST /jobs/fire`）。

## 2026-09-10 v0.1.0 事故：装完即崩（两层根因）

（前文已记录：pnpm 旧 tgz integrity 锁 + host 端漏 `export const inject = ["webServer"]`。）
教训：
- 同版本号重打包必须 `plugin rm` + `add`，或直接升版本号；
- host 端凡 `ctx.xxx` 直接取用的服务必须声明进 `export const inject = [...]`。

## 2026-09-10 v0.4.0 三项修正

用户反馈三条，均已落地（设计决策详见 `../需求/BRD-业务需求说明书.md`）：

1. **配色与 DSH 主题不一致（浅色主题下浮层是黑块）**
   - 根因：CSS 写死深色（`background:#1d2126`、`#3b82f6`、`#888` 等字面色值），不随主题切换。
   - 修复：全部改用主题 token；浮层按 ui-theme 立面规范改为 `border:0` +
     `box-shadow: var(--dsw-elevation-panel)`；主按钮改用
     `--dsw-alias-button-primary-fill/-hover` + `--dsw-alias-label-primary-foreground`。
   - 自检方法：`grep -nE '#[0-9a-fA-F]{3,6}' src/client/ui.ts` 应只剩注释里的说明文字；
     产物 `lib/client.js` 不应出现 `1d2126|3b82f6|22c55e|ef4444`。

2. **时间要有"时分秒"，不是"N 分钟后"**
   - 修复：`时 : 分 : 秒` 三段下拉（0–23 / 0–59 / 0–59）+ 今天/明天档位；
     以绝对时刻回显，并显示剩余时间；"今天已过"自动顺延到明天且明确提示；
     仍保留 20 小时上限校验。

3. **不要自带的文本输入框（DSH 本身就有）**
   - 修复：内容直接取 DSH 输入框草稿。`conversation.input.right` 槽位的 standard props 提供
     `useInput`（← 会话绑定 `hooks:{input: shell.state}`，取 `InputState.draft`）、
     `inputActions`（← `props:{inputActions: shell.actions}`，用于 `setDraft`）与 `sessionId`。
     浮层只做只读预览；草稿为空时禁用创建并提示。创建后默认清空输入框（可取消勾选），
     避免"回车立即发 + 定时发"双发。
   - 注意：`entry.ts` 里**不要**再写 `register({... inject: (sessionId) => ({sessionId}) })`——
     这些是 standard props，不是 owner inject face（旧写法属误用）。

### 本轮吸取的通用教训

- 插件 CSS 一律用 `--dsw-alias-*`，不要写字面色值（浅色主题必崩）。
- 会话相关的数据（会话 id、输入草稿、输入动作）优先走插槽 standard props，
  不要自己造输入框或让用户填 session id。
- 时间类交互用绝对时刻，相对时长（"N 分钟后"）语义弱且易误解。

## 2026-09-10 v0.4.1 「点创建定时发送毫无反应」

**现象**：输入框旁「⏰ 定时」位置正确、浮层也能打开，但点「创建定时发送」后
没有任何反馈——设置面板无新条目、输入框内容也没被清空。

**根因（v0.4.0 引入的回归）**：`sessionId` 取不到，导致创建按钮恒为 `disabled`，
点击事件根本不触发，因此完全静默。

- 错误认知：以为 `sessionId` 是会话作用域的 **standard prop**。
- 事实：`sessionId` 是框架调用注册时 `inject` 工厂的**第一个位置参数**
  （`packages/client/ui-renderer/src/client/scoped-slots.tsx` 的 `runInject`：
  `if (binding !== undefined) args.push(binding.key)`，即以 scope key 作实参），
  工厂的返回值才合并进组件 props。
  类型侧同样写死：`InjectParams` —— "strict session slots receive a definite
  framework-resolved `sessionId`"；`ComposedProps` 里并没有 `sessionId`。
- 于是 v0.4.0 把 v0.3.0 正确的 `inject: (sessionId) => ({ sessionId })` 删掉后，
  `props.sessionId` 为 `undefined` → `disabled` 恒真 → 点击无任何反应。

**修复**：

1. `entry.ts` 恢复 `inject: (sessionId: string) => ({ sessionId })`；
   组件内仍保留 standard prop 兜底（`String(pp.sessionId ?? "")`）。
2. **消除"静默失败"这一类问题**：
   - 创建按钮只由 `busy` 决定禁用，缺 sessionId / 空草稿等一律在点击后给出**明确文案**，
     不再用 disabled 静默吞掉点击；
   - 打开浮层时 `console.info("[scheduled-send] seat", {...})` 输出座位诊断
     （sessionId / useInput / inputActions / setDraft / draftLength / locked）；
   - 设置面板新增 **host 健康探测**（调 `/health`）：显示
     `host 插件在线 · v0.4.1 · 待触发 N 条`，或明确的"不可达 + 原因"，
     避免 host 路由挂掉时只显示"暂无任务"造成误判；
   - `GET /jobs` 失败不再 `catch(() => {})` 吞掉，而是显示"读取任务失败：…"。

**通用教训**：

- 会话作用域插槽里，`sessionId` 走 `inject(sessionId)` 位置参数；
  而同作用域的 `useInput` / `inputActions` 等才走 standard props（hooks 前缀 `use*`）。
  两者机制不同，不能互相替代。
- **凡是会让用户"点了没反应"的 UI，都要么给出可见反馈，要么输出诊断**；
  用 `disabled` 掩盖前置条件缺失是最糟的失败模式。

## 2026-09-10 v0.5.0 「点击创建后一直卡在『创建中…』」

**现象**：输入框填入内容 → 定时 → 点「创建定时发送」→ 一直显示"创建中…"，等几分钟无果；
刷新后任务消失，设置面板也没有条目。

**根因（从 v0.1.0 起就存在、从未真正走通过的 HTTP 创建路径）**：
`host/routes.ts` 里所有 POST 处理器把**响应对象 res 传给了 readBody**（`await readBody(resx)`）。
`readBody` 监听 `data`/`end` 事件——响应对象不会为请求体发这些事件，于是 promise **永不 resolve**，
处理器永不返回 → 客户端 fetch 无限挂起 → UI 一直"创建中…"（刷新后任务自然不存在）。

- 对照：dsh-personal-workbench 的 `readBody(req as never)` 读的一直是**请求对象**。
- 为什么之前没暴露：v0.1.0 加载即崩；v0.2.0–v0.3.0 创建入口在设置面板但从未真正 POST 成功过；
  v0.4.0 按钮被 disabled 吞掉点击；v0.4.1 按钮可点后，POST 一挂到底，问题才第一次可见。

**修复**：

1. `routes.ts`：全部 `readBody` 改读请求对象（`req`）；抽出 `readJsonBody` 统一解析。
2. 客户端 `api()`：统一加 10 秒超时（AbortController），**任何请求都不可能无限挂起**；
   超时给出明确文案（"host 未在 10 秒内响应，请到设置→定时发送查看 host 状态"）。
3. 客户端创建流程：失败/超时均有可见错误，不再有"点了没下文"。

**通用教训**：

- Node http 处理器的 body 必须从 **req** 读；把 res 传给"读 body"的辅助函数是最容易埋的永久挂起。
- 凡是会向用户显示"进行中"状态的异步操作，必须带超时，绝不能让它无限期转圈。

## 2026-09-11 v0.6.0 「为何反复弄坏 3082？」根因复盘与防复发

**复现过程（两次）**：装完插件 → loader 启动 `ERR_MODULE_NOT_FOUND .../lib/index.js` →
systemd 反复重启 → 死循环。

**根本原因（两层叠加，每次都一样）**：

1. **pnpm `file:` tgz 的 store 缓存陷阱（首次）**
   - `main: ./lib/index.js`，但 pnpm 按 `pnpm-lock.yaml` 的 `integrity` 判定"已是最新"，
     不重新解压 → node_modules 里留着**旧布局、缺 lib/** 的解压产物 → loader 加载即崩。
2. **源码目录被混入旧扁平布局（第二次）**
   - 10:40–11:21 之间插件曾被改成「顶层散文件 + client/ host/ shared/ 无 lib/」的扁平布局，
     又带错误 `node_modules -> dsh-personal-workbench/node_modules` 软链；
     此时 profile 从 tgz 换 link，link 直指源码目录 → 坏布局直接暴露给 loader。
   - 同源问题：`tsconfig.client.json` 曾在 build 期 require `react` 导致 typecheck 失败，
     有人为"修复"加了整目录 node_modules 软链，制造了运行时遮蔽隐患（后已改为 paths 映射 @types 的方式）。

**根治（v0.6.0 起，全部内置为门禁，不再靠人记）**：

| 层 | 措施 | 位置 |
|---|---|---|
| 构建时 | **顶层布局卫生检查**：发现顶层 index.ts/client.js/build.mjs/client//host/ 或 node_modules 软链 → 构建报错 | `scripts/build.mjs` |
| 构建后 | **产物门禁**：lib/*.js 存在非空；host 动态 import 断言导出 Scheduler/VERSION/apply/inject/name 且 inject 含 webServer；client 检查 __ModuleLoader__ + 插件 id + 关键插槽 | `scripts/build.mjs` |
| 安装后 | **安装后验证器**：package.json.main 指向的文件必须存在可加载；client.js 存在；顶层无扁平残留/错误软链 | `scripts/verify-installed.mjs`（`pnpm verify:installed`） |
| 部署 | **一键安装脚本**：构建门禁→冒烟→rm 旧→安装→安装后验证，失败即停；**不自动重启** | `scripts/install-to-dsh.sh`（`pnpm install:dev`） |
| 策略 | 安装一律走 **tgz**（`pnpm check` → `npm pack` → `plugin add <tgz>`，重打包必须升版本号）；**不使用 link 安装** | 见 README |

**判断 API 是否"装对"的速查**：

```bash
ls -la ~/.dsh-dev/profiles/web/node_modules/dsh-scheduled-send   # 应为含 lib/ 的目录（tgz 安装）
node scripts/verify-installed.mjs                                  # 就地验证，ERROR 即拦
```

## 2026-09-11 v0.6.0 「打开会话」报 Cannot read properties of undefined (reading 'manager')

**现象**：设置 → 定时发送 → 任务行点「打开会话」→ 弹窗"跳转失败：Cannot read
properties of undefined (reading 'manager')"。

**根因**：客户端 `entry.ts` 用了 `const openSession = svc?.open; ... openSession(id)`——
把 `ISessions.open` **方法从对象上解构**再调用。DSH 实现 `open(id){ this.manager.select(id) }`
依赖 `this`（service.ts 第 270 行起）；解构后 `this` 变 `undefined` → `this.manager` 报错。

**修复（防再犯）**：

1. 新增 `src/shared/session-opener.ts` 的 `sessionOpenerOf(svc)`：保引用调用 `open.call(svc, id)`，
   `entry.ts` 一律经它构造跳转函数；
2. 新增 `test/session-opener-test.mjs`：用「方法体依赖 this.manager」的伪服务
   复现旧 bug（解构调用必抛 reading 'manager'）+ 验证 helper 修复 + 降级分支；
3. 教训固化：**凡调用宿主服务对象的方法，绝不先拆出来再调**（this 绑定会丢）；
   涉及 `this` 依赖的调用一律 `svc.method(id)` 或 `method.call(svc, id)`。

## 2026-09-11 v0.6.1「打开会话」仍未生效 — 二次根因

**现象**：上一轮修复 this 绑定后，设置面板点「打开会话」依旧无法跳转。

**根因（真凶在前一轮修复之下）**：client 插件 `inject` 只写了
`["slots","timer"]`，漏了 `'sessions'`。在 deepseek-harness 的 cordis client 体系中，
`ctx.get('sessions')` 只有在插件 `inject` 声明了 `'sessions'` 时才能拿到**绑定的服务实例**
（对照 `packages/client/ui-workspace`、`ui-reference` 的 `inject` 均含 `'sessions'`）。
未声明时拿到的并非可用服务 → `sessionOpenerOf` 返回 undefined → 按钮缺失/无效果。

**修复**：`inject: ["slots","timer","sessions"]`；并加可观测性：面板顶部警告 +
`console.info("[scheduled-send] sessions 服务", {hasService, hasOpen, openerReady})`。

**防再犯（三层）**：① client 插件用某客户端服务，必在 `inject` 声明；② 方法调用保 this
（`method.call(svc,...)`，见 v0.6.0 记录）；③ 服务缺失必须有可见提示，禁止按钮静默消失。

---

## 历史沿革（要点）

- **2026-09-10（v0.1.0）**：装包即崩两连击——pnpm 按 lockfile integrity 不重解压的旧 tgz 缓存，
  叠加 host 端漏 `export const inject = ["webServer"]`。
- **2026-09-10（v0.2.0–v0.4.0）**：入口位置 / 时间选择 / 撤回编辑的需求迭代；
  主题 token 化、绝对时刻时分秒、去掉自带输入框三项修正，并沉淀"CSS 只用 `--dsw-alias-*`""会话数据走插槽 standard props""时间用绝对时刻"三条通用教训。
- **2026-09-10（v0.4.1–v0.5.0）**：两次"点击无反馈"类故障——`sessionId` 机制误判致创建按钮恒 `disabled`；
  host `readBody(res)` 致 POST 永久挂起（自 v0.1.0 起隐藏）。确立"不给静默失败、异步必带超时"。
- **2026-09-11（v0.6.0）**：3082 崩溃循环根因复盘，落地构建布局卫生检查、产物门禁、安装后验证器与一键安装脚本；
  同期修「打开会话」`this` 绑定丢失（方法解构调用）。
- **2026-09-11（v0.6.1）**：「打开会话」二次根因——client 插件 `inject` 漏 `'sessions'`；补三层防再犯。

> 后续 v0.7.0–v0.7.2「设置面板空白」三层根因链（组件直接函数调用 → 条件 hook → JobList hooks 顺序漂移）
> 的过程流水记在 `CHANGELOG.md` 与 `../需求/BRD-业务需求说明书.md` §2.6 / §5，本文件不再复述。

