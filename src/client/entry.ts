/**
 * dsh-scheduled-send — Client 入口（浏览器侧，DSH ModuleLoader 握手）。
 *
 * 两个注册点：
 *   1. `conversation.input.right`（会话作用域）：输入框工具行的「⏰ 定时」标识。
 *      **sessionId 必须由 `inject` 工厂的位置参数取得** —— 框架的 `runInject` 会以
 *      scope key（= sessionId）作为第一个实参调用注册时的 inject 工厂，返回值合并进组件 props
 *      （见 packages/client/ui-renderer/src/client/scoped-slots.tsx 的 `runInject`）。
 *      v0.4.0 曾误把它当作 standard prop 而删掉 inject，导致 sessionId 为空、
 *      创建按钮恒 disabled → 点击静默无反应。v0.4.1 恢复 inject 写法，并在组件内
 *      同时兼容 standard prop 作为兜底。
 *   2. `settings.section`（root 作用域）：设置面板「定时发送」任务管理面板。
 *
 * 注意（v0.1.0 事故教训）：host 端凡 `ctx.xxx` 取用的服务必须声明
 * `export const inject = [...]`（见 src/index.ts）。
 */
import { makeUI, type MainUI } from "./ui.ts";
import { sessionOpenerOf } from "../shared/session-opener.ts";
import { sessionMetaOf } from "../shared/session-meta.ts";

declare global {
  interface Window {
    __ModuleLoader__?: { load: (reg: { id: string; factory: (require: (m: string) => unknown) => unknown }) => void };
  }
}

type RequireFn = (m: string) => unknown;

window.__ModuleLoader__?.load({
  id: "dsh-scheduled-send",
  factory: (require: RequireFn) => {
    const React = require("react") as typeof import("react");
    const ui: MainUI = makeUI(React as never, { createPortal: null, portalHost: () => null });

    /**
     * settings.section 渲染错误边界（v0.7.1）：
     * 组件渲染抛错时，默认会被 SlotErrorBoundary 吞成空节点 → 用户看到"设置面板空白"且无任何线索。
     * 这里包一层，让任何渲染异常**可见**并给出定位线索，同时避免空白。
     */
    type BoundaryProps = { children: unknown };
    type BoundaryState = { error: string | null };
    class SectionErrorBoundary extends React.Component<BoundaryProps, BoundaryState> {
      override state: BoundaryState = { error: null };
      static getDerivedStateFromError(e: unknown): BoundaryState {
        return { error: String((e as Error)?.message ?? e) };
      }
      override componentDidCatch(e: unknown): void {
        console.error("[scheduled-send] settings.section 渲染失败：", e);
      }
      override render(): React.ReactNode {
        if (this.state.error !== null) {
          return React.createElement(
            "div",
            { style: { padding: "12px", color: "var(--dsw-alias-state-error-primary)", fontSize: 12, lineHeight: 1.6 } },
            React.createElement("div", { style: { fontWeight: 600, marginBottom: 4 } },
              "⚠️ 「定时发送」设置面板渲染失败（v0.7.1 起错误可见化）"),
            React.createElement("div", null, this.state.error),
            React.createElement("div", { style: { marginTop: 8, opacity: 0.7 } },
              "请把上方错误信息 + 控制台 [scheduled-send] sessions 服务 诊断发给开发者。"),
          );
        }
        return this.props.children as React.ReactNode;
      }
    }

    type Slots = {
      inject: (key: string, f: () => unknown) => void;
      register: (
        spec: {
          name: string;
          id?: string;
          order?: number;
          label?: () => string;
          inject?: (...args: never[]) => Record<string, unknown>;
        },
        comp: unknown,
      ) => void;
    };

    return {
      name: "scheduled-send",
      inject: ["slots", "timer", "sessions"],
      apply(ctx: { get: (k: string) => unknown }) {
        const slots = ctx.get("slots") as Slots | undefined;
        if (!slots) return;

        // 主入口：输入框工具行「⏰ 定时」。
        // sessionId 由框架按声明注入 inject 工厂（位置参数），返回值成为组件 props。
        slots.inject("conversation.input.right", () =>
          slots.register(
            {
              name: "conversation.input.right",
              id: "scheduled-send",
              order: 0,
              inject: (sessionId: string) => ({ sessionId }),
            },
            ui.InputBadge,
          ));

        // 对话输入区定时排队 dock（与原生 QueueDock 同插槽；order 30 在其后）
        slots.inject("conversation.input.dock", () =>
          slots.register(
            {
              name: "conversation.input.dock",
              id: "scheduled-send-queue",
              order: 30,
              inject: (sessionId: string) => ({ sessionId }),
            },
            ui.ScheduledDock,
          ));

        // 管理入口：设置面板左侧导航「定时发送」（order 11，Vision Router「识图」在 12）。
        // 需要客户端 `sessions` 服务的 open(id) 来实现"点击跳到对应会话"。
        // ⚠️ v0.7.0：settings.section 是唯一"包装函数里【直接调用组件函数】"的注册——React 规定
        // 组件必须经 createElement 渲染（hooks 才归属该组件）；直接 `(ui.SettingsSection)(props)`
        // 会让其内部 useState/useEffect/useSessions 挂到外层包装组件 → 渲染异常 → 设置面板空白。
        // 必须改成 `React.createElement(ui.SettingsSection, props)`（ScheduledDock/InputBadge 传组件
        // 引用由框架 createElement，天然正确；settings 需包一层注 openSession，因此这里显式 createElement）。
        slots.inject("settings.section", () =>
          slots.register(
            { name: "settings.section", id: "scheduled-send", order: 11, label: () => "定时发送" },
            (props: Record<string, unknown>) => {
              // 会话服务：open=跳转；list.getSnapshot()=同步元数据快照（标题/cwd）。
              // 全部经 ctx.get('sessions')（inject 已声明 'sessions'，v0.6.1 修复点）。
              const svc = ctx.get?.("sessions") as
                | { open?: (id: string) => void; list?: { getSnapshot: () => unknown } }
                | undefined;
              const opener = sessionOpenerOf(svc);
              // ⚠️ 元数据不得用「条件 hook」：SettingsSection 内不得 `typeof p.useSessions==='function'
              // ? useSessions(...) : ...`（React hooks 稳定性：跨渲染数量漂移 → "Rendered more hooks"
              // → 被 SlotErrorBoundary 吞成空白）。这里用**同步快照**算好普通对象传入（无 hook）。
              const sessionMeta = (() => {
                try {
                  const snap = svc?.list?.getSnapshot?.() as
                    | { byId?: Record<string, { displayTitle?: string; title?: string; cwd?: string }> }
                    | undefined;
                  return sessionMetaOf(snap);
                } catch { return {} as Record<string, { title?: string; cwd?: string }>; }
              })();
              // 跳转能力诊断：sessions 服务未注入/open 缺失时，设置面板要给出可见提示（禁止静默）
              try {
                console.info("[scheduled-send] sessions 服务", {
                  hasService: !!svc,
                  hasOpen: typeof svc?.open === "function",
                  openerReady: typeof opener === "function",
                  metaCount: Object.keys(sessionMeta).length,
                });
              } catch { /* 诊断失败不影响功能 */ }
              // ✅ 组件化渲染（不得改回直接函数调用）+ 错误边界（渲染异常可见，不再空白）
              return React.createElement(SectionErrorBoundary as never, null,
                React.createElement(ui.SettingsSection as never, {
                  ...props,
                  // ⚠️ 不能用 `const f = svc.open` 再调用：sessions.open 方法体依赖 this.manager
                  //（service.ts `open(){ this.manager.select(id) }`），拆出后再调 this 变 undefined → 报
                  // "Cannot read properties of undefined (reading 'manager')"。必须经箭头函数保引用调用。
                  openSession: opener,
                  // 供设置面板展示"跳转能力不可用"的原因（0.6.1 起）
                  sessionsUnavailable: !svc || typeof svc?.open !== "function",
                  sessionMeta,
                } as never));
            },
          ));
      },
    };
  },
});
