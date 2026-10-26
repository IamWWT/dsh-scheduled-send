/**
 * dsh-scheduled-send — Client 入口（浏览器侧，DSH ModuleLoader 握手）。
 *
 * 注册点：
 *   1. `conversation.input.right`：输入框「⏰ 定时」快捷入口（取当前草稿，一次性）；
 *   2. `conversation.input.dock`：当前会话的待执行任务 dock；
 *   3. `main` + `sidebar.panellist`：左侧「定时任务」主页（WorkBuddy 式表单/列表）；
 *   4. `settings.section`：设置内入口（复用同一页面，保持旧入口可用）。
 *
 * 官方 `ui-schedule` 由 profile patch 禁用；本插件是唯一的调度 UI，
 * 但调度/持久化/投递仍由宿主 `ctx.schedule` 完成。
 */
import { makeUI, type MainUI, type WorkspaceRow, type SessionRow, type PresetRow, type ModelOption } from "./ui.ts";
import { sessionOpenerOf } from "../shared/session-opener.ts";
import { sessionMetaOf } from "../shared/session-meta.ts";

/** remote 调用统一超时（下拉数据源；失败给明确文案，不静默）。 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms);
    p.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}

/** RemoteResult 解包：{ok:true, value} → value；失败抛错。 */
function unwrapRemote(value: unknown): unknown {
  const r = value as { ok?: boolean; value?: unknown; error?: unknown } | null | undefined;
  if (r === null || r === undefined) throw new Error("远端返回为空");
  if (r.ok === false) throw new Error(String((r.error as { message?: unknown })?.message ?? r.error ?? "远端调用失败"));
  return "value" in r ? r.value : r;
}

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

    type BoundaryProps = { children: unknown };
    type BoundaryState = { error: string | null };
    class SectionErrorBoundary extends React.Component<BoundaryProps, BoundaryState> {
      override state: BoundaryState = { error: null };
      static getDerivedStateFromError(e: unknown): BoundaryState {
        return { error: String((e as Error)?.message ?? e) };
      }
      override componentDidCatch(e: unknown): void {
        console.error("[scheduled-send] 页面渲染失败：", e);
      }
      override render(): React.ReactNode {
        if (this.state.error !== null) {
          return React.createElement(
            "div",
            { style: { padding: 12, color: "var(--dsw-alias-state-error-primary)", fontSize: 12, lineHeight: 1.6 } },
            React.createElement("div", { style: { fontWeight: 600, marginBottom: 4 } }, "⚠️「定时任务」页面渲染失败"),
            React.createElement("div", null, this.state.error),
            React.createElement("div", { style: { marginTop: 8, opacity: 0.7 } }, "请把错误信息发给开发者；官方任务数据不受影响。"),
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
          key?: string;
          order?: number;
          label?: () => string;
          inject?: (...args: never[]) => Record<string, unknown>;
        },
        comp: unknown,
      ) => void;
    };

    return {
      name: "scheduled-send",
      inject: ["slots", "timer", "sessions", "workspaces", "remote.agentPresets", "remote.session"],
      apply(ctx: { get: (k: string) => unknown }) {
        const slots = ctx.get("slots") as Slots | undefined;
        if (!slots) return;

        const sessionsSvc = ctx.get("sessions") as
          | { open?: (id: string) => void; list?: { getSnapshot: () => unknown } }
          | undefined;
        const opener = sessionOpenerOf(sessionsSvc);
        const sessionMeta = (() => {
          try {
            const snap = sessionsSvc?.list?.getSnapshot?.() as
              | { byId?: Record<string, { displayTitle?: string; title?: string; cwd?: string }> }
              | undefined;
            return sessionMetaOf(snap);
          } catch {
            return {};
          }
        })();
        const readWorkspaces = (): WorkspaceRow[] => {
          try {
            const svc = ctx.get("workspaces") as
              | { list?: { getSnapshot: () => { items?: WorkspaceRow[] } } }
              | undefined;
            const snap = svc?.list?.getSnapshot?.();
            return Array.isArray(snap?.items)
              ? snap.items.map(item => ({ workspaceId: String(item.workspaceId), title: String(item.title), path: String(item.path) }))
              : [];
          } catch {
            return [];
          }
        };
        const readSessions = (): SessionRow[] => {
          try {
            const snap = sessionsSvc?.list?.getSnapshot?.() as
              | { byId?: Record<string, {
                  id?: string;
                  displayTitle?: string;
                  title?: string;
                  workspaceId?: string;
                  projectionValues?: { agentPreset?: unknown };
                }> }
              | undefined;
            const rows: SessionRow[] = [];
            for (const [id, entry] of Object.entries(snap?.byId ?? {})) {
              const presetRaw = entry?.projectionValues?.agentPreset as { id?: string; name?: string } | string | undefined;
              const preset = typeof presetRaw === "string"
                ? presetRaw
                : presetRaw?.name ?? presetRaw?.id;
              rows.push({
                sessionId: id,
                title: String(entry?.displayTitle ?? entry?.title ?? ""),
                ...(typeof entry?.workspaceId === "string" ? { workspaceId: entry.workspaceId } : {}),
                ...(typeof preset === "string" && preset !== "" ? { agentPreset: preset } : {}),
              });
            }
            return rows;
          } catch {
            return [];
          }
        };
        const fetchPresets = async (): Promise<PresetRow[]> => {
          const remote = ctx.get("remote.agentPresets") as { list?: () => Promise<unknown> } | undefined;
          if (remote?.list === undefined) throw new Error("宿主未提供 agentPresets 远端");
          const value = unwrapRemote(await withTimeout(remote.list(), 8000, "加载模式清单")) as
            { presets?: Array<{ id?: unknown; name?: unknown }> };
          return (value?.presets ?? [])
            .filter(x => typeof x.id === "string" && x.id !== "")
            .map(x => ({ id: String(x.id), name: String(x.name ?? x.id) }));
        };
        const fetchModels = async (): Promise<ModelOption[]> => {
          const remote = ctx.get("remote.session") as { modelCatalog?: () => Promise<unknown> } | undefined;
          if (remote?.modelCatalog === undefined) throw new Error("宿主未提供 session.modelCatalog 远端");
          const catalog = unwrapRemote(await withTimeout(remote.modelCatalog(), 10000, "加载模型清单")) as
            { groups?: Array<{ id?: unknown; name?: unknown; models?: Array<{ id?: unknown; name?: unknown }> }> };
          const out: ModelOption[] = [];
          for (const g of catalog?.groups ?? []) {
            for (const m of g?.models ?? []) {
              if (typeof g.id !== "string" || typeof m.id !== "string") continue;
              out.push({
                provider: g.id,
                model: m.id,
                providerName: String(g.name ?? g.id),
                modelName: String(m.name ?? m.id),
              });
            }
          }
          return out;
        };
        const injected = {
          ...(opener === undefined ? {} : { openSession: opener }),
          sessionMeta,
          getWorkspaces: readWorkspaces,
          getSessions: readSessions,
          fetchPresets,
          fetchModels,
        };

        // 左侧主导航：与官方「自动化任务」同位置；官方 ui-schedule 在 profile 层禁用。
        slots.inject("main", () =>
          slots.register(
            { name: "main", key: "scheduled-send", inject: () => injected },
            (props: Record<string, unknown>) => React.createElement(
              SectionErrorBoundary as never,
              null,
              React.createElement(ui.TaskPage as never, { ...props, ...injected } as never),
            ),
          ));
        slots.inject("sidebar.panellist", () =>
          slots.register(
            { name: "sidebar.panellist", id: "scheduled-send", order: 10, label: () => "定时任务" },
            ui.PanelIcon,
          ));

        // 移除官方品牌区（logo + 两行「本地构建/版本徽标」→ 空实现，整块不再占空间），
        // 并把「收起侧栏」按钮移位到「新会话」行右端（BrandShift 的挂载 effect 打标记类）。
        // single 插槽同优先级重复注册会抛错：桌面版若装了 ui-brand-official，让位并保持静默降级。
        const hideBrand = (slotName: string, component: () => unknown) => {
          slots.inject(slotName, () => {
            try {
              slots.register({ name: slotName }, component);
            } catch (e) {
              console.info(`[scheduled-send] ${slotName} 已有占位者，跳过隐藏：`, String((e as Error)?.message ?? e));
            }
          });
        };
        hideBrand("sidebar.brand.name", ui.BrandShift);
        hideBrand("sidebar.brand.mark", ui.BrandHidden);

        // 输入框工具行「⏰ 定时」：快速把当前草稿排成一次性任务。
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

        // 当前会话待执行任务 dock。
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

        // 设置内入口：复用同一页面，保持旧路径可用。
        slots.inject("settings.section", () =>
          slots.register(
            { name: "settings.section", id: "scheduled-send", order: 11, label: () => "定时任务" },
            (props: Record<string, unknown>) => React.createElement(
              SectionErrorBoundary as never,
              null,
              React.createElement(ui.SettingsSection as never, { ...props, ...injected } as never),
            ),
          ));
      },
    };
  },
});
