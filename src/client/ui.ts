/**
 * dsh-scheduled-send — Client UI（h 函数式，不依赖 JSX runtime）。
 *
 * 0.8.0：调度引擎改用宿主官方 `ctx.schedule`；本文件只负责 WorkBuddy 式表单、
 * 任务列表与输入区快捷入口。页面/表单/列表全部使用 DSH 主题 token。
 */
import type { Frequency, TaskView } from "../shared/types.ts";
import { API_TIMEOUT_MS, REFRESH_MS } from "../shared/constants.ts";
import { sessionMetaOf, type SessionMetaRow } from "../shared/session-meta.ts";

interface Ctx {
  createPortal: ((n: unknown, c: Element) => unknown) | null;
  portalHost: () => Element | null;
}

type H = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => unknown;

export interface WorkspaceRow {
  workspaceId: string;
  title: string;
  path: string;
}

/** 「选择现有会话」下拉行；agentPreset 来自会话投影，仅展示（首轮后锁定）。 */
export interface SessionRow {
  sessionId: string;
  title: string;
  workspaceId?: string;
  agentPreset?: string;
}

export interface PresetRow {
  id: string;
  name: string;
}

export interface ModelOption {
  provider: string;
  model: string;
  providerName: string;
  modelName: string;
}

export interface PageInjected {
  openSession?: (id: string) => void;
  sessionMeta?: Record<string, SessionMetaRow>;
  /** 注册时快照（兜底）；优先用 getWorkspaces 实时读取。 */
  workspaces?: WorkspaceRow[];
  /** 每次渲染读取工作区服务快照（服务可能晚于插件注册才就绪）。 */
  getWorkspaces?: () => WorkspaceRow[];
  /** 每次渲染读取会话快照（「发送到现有会话」选择器）。 */
  getSessions?: () => SessionRow[];
  /** 拉取 agent preset 清单（remote.agentPresets.list；带超时）。 */
  fetchPresets?: () => Promise<PresetRow[]>;
  /** 拉取模型目录（remote.session.modelCatalog；带超时）。 */
  fetchModels?: () => Promise<ModelOption[]>;
}

interface ApiTaskResponse {
  ok: boolean;
  version?: string;
  task?: TaskView;
  error?: string;
}

interface ApiTasksResponse {
  ok: boolean;
  version?: string;
  tasks?: TaskView[];
  scheduleService?: boolean;
  error?: string;
}

interface ApiHealthResponse {
  ok: boolean;
  version?: string;
  scheduleService?: boolean;
  active?: number;
  total?: number;
  error?: string;
}

const TIME_ZONE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
  } catch {
    return "Asia/Shanghai";
  }
})();

const WEEKDAYS: ReadonlyArray<readonly [number, string]> = [
  [1, "一"], [2, "二"], [3, "三"], [4, "四"], [5, "五"], [6, "六"], [7, "日"],
];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtDateTime(iso: string | number): string {
  const ms = typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(ms)) return String(iso);
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtClock(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function dateInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function timeInput(ms: number, withSeconds = false): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}${withSeconds ? `:${pad2(d.getSeconds())}` : ""}`;
}

function localEpoch(date: string, time: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm, ss = 0] = time.split(":").map(Number);
  if (![y, m, d, hh, mm, ss].every(Number.isFinite)) return NaN;
  return new Date(y, m - 1, d, hh, mm, ss, 0).getTime();
}

function countdown(iso: string): string {
  const diff = Date.parse(iso) - Date.now();
  if (!Number.isFinite(diff)) return "—";
  if (diff <= 0) return "即将执行";
  const s = Math.floor(diff / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}天${h}小时`;
  if (h > 0) return `${h}小时${m}分`;
  if (m > 0) return `${m}分`;
  return `${s}秒`;
}

function frequencyLabel(f: Frequency): string {
  switch (f.kind) {
    case "once": return `单次 · ${fmtDateTime(f.at)}`;
    case "after": return `${f.afterSeconds} 秒后（一次性）`;
    case "every": {
      const s = f.seconds;
      if (s % 86400 === 0) return `每 ${s / 86400} 天`;
      if (s % 3600 === 0) return `每 ${s / 3600} 小时`;
      if (s % 60 === 0) return `每 ${s / 60} 分钟`;
      return `每 ${s} 秒`;
    }
    case "daily": return `每天 ${f.time.slice(0, 5)}（${f.timeZone}）`;
    case "weekly": {
      const names = f.weekdays.map(d => WEEKDAYS.find(([n]) => n === d)?.[1] ?? String(d)).join("、");
      return `每周 ${names} ${f.time.slice(0, 5)}（${f.timeZone}）`;
    }
    case "cron": return `Cron · ${f.expression}（${f.timeZone}）`;
  }
}

function statusLabel(status: string | undefined): string {
  switch (status) {
    case "success": return "成功";
    case "failed": return "失败";
    case "aborted": return "中断";
    case "blocked": return "阻塞";
    case "max-tokens": return "输出上限";
    case "interrupted": return "异常收尾";
    default: return "未执行";
  }
}

function executionTone(status: string | undefined): string {
  if (status === "success") return "dss-ok";
  if (status === "failed" || status === "interrupted") return "dss-err";
  if (status === undefined) return "dss-muted";
  return "dss-warn";
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
  try {
    const r = await fetch(`/api/scheduled-send${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    if (r.status === 401 || r.status === 403) {
      throw new Error("页面登录已过期：请刷新页面或重新用带 token 的链接打开");
    }
    const json = await r.json() as T;
    return json;
  } finally {
    window.clearTimeout(timer);
  }
}

async function fetchTasks(): Promise<{ tasks: TaskView[]; scheduleService: boolean; version?: string }> {
  const r = await api<ApiTasksResponse>("/tasks");
  if (!r.ok || !Array.isArray(r.tasks)) throw new Error(r.error ?? "读取任务失败（host 未安装或版本不匹配）");
  return { tasks: r.tasks, scheduleService: r.scheduleService !== false, version: r.version };
}

async function fetchHealth(): Promise<ApiHealthResponse> {
  try {
    return await api<ApiHealthResponse>("/health");
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

const CSS = `
.dss-page{display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary);font-size:13px;padding:24px;max-width:1120px;margin:0 auto;width:100%;box-sizing:border-box;line-height:1.6}
.dss-page.dss-embedded{padding:4px 2px}
.dss-top{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}
.dss-title{font-size:20px;font-weight:650;letter-spacing:.01em}
.dss-sub{font-size:12px;color:var(--dsw-alias-label-secondary);max-width:720px}
.dss-top-actions{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap}
.dss-btn{padding:7px 14px;border-radius:8px;border:0.5px solid transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-size:13px;cursor:pointer;font-family:inherit;min-height:34px}
.dss-btn:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dss-btn:disabled{opacity:.5;cursor:not-allowed}
.dss-btn-ghost{padding:5px 10px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer;font-family:inherit;min-height:30px}
.dss-btn-ghost:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dss-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dss-note{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6}
.dss-err{font-size:12px;color:var(--dsw-alias-state-error-primary);white-space:pre-wrap}
.dss-warn{font-size:12px;color:var(--dsw-alias-state-warn-primary);white-space:pre-wrap}
.dss-ok{font-size:12px;color:var(--dsw-alias-state-success-primary)}
.dss-muted{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dss-summary{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.dss-stat{border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:999px;padding:3px 10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dss-stat b{color:var(--dsw-alias-label-primary);font-weight:600}
.dss-list{display:flex;flex-direction:column;gap:8px}
.dss-card{display:flex;gap:12px;padding:14px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);align-items:flex-start}
.dss-card-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:5px}
.dss-card-title{font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dss-card-prompt{font-size:12px;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap}
.dss-card-meta{font-size:11px;color:var(--dsw-alias-label-secondary);display:flex;gap:10px;flex-wrap:wrap}
.dss-card-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;max-width:300px}
.dss-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:1px 8px;border-radius:999px;border:0.5px solid;white-space:nowrap}
.dss-badge-active{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dss-badge-ended{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2)}
.dss-badge-schedule{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.dss-badge-fail{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dss-badge-warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.dss-empty{border:0.5px dashed var(--dsw-alias-border-l2);border-radius:12px;padding:28px 16px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px}
.dss-group-head{display:flex;align-items:center;gap:8px;padding:8px 2px;border:0;border-bottom:0.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;width:100%;text-align:left}
.dss-group-head:hover{color:var(--dsw-alias-brand-primary)}
.dss-input,.dss-sel,.dss-textarea{box-sizing:border-box;width:100%;background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;font-size:13px;color:var(--dsw-alias-label-primary);font-family:inherit;min-height:36px}
.dss-textarea{min-height:88px;resize:vertical;line-height:1.6}
.dss-form{display:flex;flex-direction:column;gap:14px}
.dss-modal-form{flex:1;min-height:0;overflow:auto;padding-right:2px}
.dss-modal .dss-actions{position:sticky;bottom:0;background:var(--dsw-alias-bg-overlay);padding:10px 0 2px}
.dss-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.dss-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.dss-field>label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dss-inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dss-inline>.dss-input,.dss-inline>.dss-sel{width:auto;flex:1;min-width:110px}
.dss-check{display:flex;gap:8px;align-items:flex-start;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;line-height:1.5}
.dss-check input{margin-top:2px}
.dss-actions{display:flex;gap:8px;justify-content:flex-end;align-items:center;flex-wrap:wrap}
.dss-scrim{position:fixed;inset:0;z-index:100002;background:var(--dsw-alias-bg-mask-2);display:flex;align-items:center;justify-content:center;padding:24px}
.dss-modal{width:min(760px,100%);max-height:calc(100vh - 48px);overflow:hidden;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border-radius:14px;box-shadow:var(--dsw-elevation-prominent);padding:20px;display:flex;flex-direction:column;gap:14px;box-sizing:border-box}
.dss-modal-head{display:flex;align-items:flex-start;gap:10px}
.dss-modal-title{font-size:16px;font-weight:650}
.dss-x{margin-left:auto;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:18px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:6px}
.dss-x:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
/* 侧栏品牌区移除后（dss-logo-shift 由 BrandShift 挂载时打在 logoRow 上）：
   顶行压扁；新会话按钮让出右端 40px，官方收起按钮绝对定位落进这块空档
   （top 100% + 行距 4 + (38-28)/2 = 9，与按钮垂直居中对齐，互不重叠）。 */
.dss-logo-shift{position:relative;height:14px!important;padding:0!important;margin-bottom:4px!important;overflow:visible!important}
.dss-logo-shift + button{margin-right:40px!important}
.dss-logo-shift>button:last-of-type:not(:has([data-dss-brand])){position:absolute;top:calc(100% + 9px);right:0;z-index:5}
/* 品牌 mark 插槽双用途：展开态品牌区隐藏；折叠轨道（railMark）内显示为展开标识。 */
[data-dss-brand="mark"]{display:none}
[class*="railMark"] [data-dss-brand="mark"]{display:block;color:var(--dsw-alias-label-secondary)}
.dss-bchip{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 9px;border-radius:8px;border:0.5px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;cursor:pointer;user-select:none;white-space:nowrap;font-family:inherit}
.dss-bchip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dss-bchip.on{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-hover-accent)}
.dss-bchip:disabled{opacity:.45;cursor:not-allowed}
.dss-pop{position:fixed;z-index:1000;width:320px;box-sizing:border-box;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border-radius:12px;box-shadow:var(--dsw-elevation-panel);padding:14px;display:flex;flex-direction:column;gap:10px;font-size:13px}
.dss-pop-title{font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px}
.dss-pop-title .sub{font-size:11px;font-weight:400;color:var(--dsw-alias-label-secondary);margin-left:auto}
.dss-preview{border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:8px 10px;font-size:12px;color:var(--dsw-alias-label-secondary);max-height:100px;overflow:auto;white-space:pre-wrap}
.dss-dock{width:100%;box-sizing:border-box;border:0.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:6px 10px;display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dsw-alias-label-primary)}
.dss-dock-head{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600}
.dss-dock-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.dss-dock-row{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-2)}
.dss-dock-time{flex:none;font-weight:600;color:var(--dsw-alias-brand-primary);font-size:12px;white-space:nowrap}
.dss-dock-preview{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dss-dock-eta{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}
.dss-panel-icon{display:block;color:currentColor}
@media (max-width:720px){.dss-page{padding:14px}.dss-grid{grid-template-columns:1fr}.dss-card{flex-direction:column}.dss-card-actions{justify-content:flex-start;max-width:none}.dss-modal{padding:16px}}
`;

const styleOnce = (): void => {
  if (typeof document === "undefined" || document.getElementById("dss-style")) return;
  const el = document.createElement("style");
  el.id = "dss-style";
  el.textContent = CSS;
  document.head.appendChild(el);
};

export function makeUI(React: unknown, _ctx: Ctx) {
  const R = React as {
    useState: <T>(v: T | (() => T)) => [T, (v: T | ((prev: T) => T)) => void];
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => void;
    useRef: <T>(v: T) => { current: T };
    createElement: H;
  };
  const { useState, useEffect, useRef } = R;
  const h = R.createElement;
  styleOnce();

  /**
   * 移除官方侧栏品牌区：注册进 `sidebar.brand.name` / `sidebar.brand.mark`（single 插槽，
   * 替换「本地构建+版本徽标」回退为空实现，整块不再占纵向空间）。
   * 外层品牌按钮（点击=新会话）由官方容器保留，但侧栏本就有「新会话」按钮，功能不损失。
   */
  /**
   * `sidebar.brand.mark` 同时被两处复用：展开态品牌区（要隐藏）与折叠轨道里
   * 展开按钮的 railMark（要保留可见标识）。这里统一渲染一个面板图标，
   * 由 CSS 控制：默认不显示，仅 railMark 容器内显示（见 [data-dss-brand="mark"] 规则）。
   */
  const BrandHidden: (p?: { size?: number }) => unknown = (p) =>
    h("svg", {
      "data-dss-brand": "mark",
      width: p?.size ?? 20,
      height: p?.size ?? 20,
      viewBox: "0 0 24 24",
      fill: "none",
      "aria-hidden": "true",
    },
      h("rect", { x: 3, y: 4, width: 18, height: 16, rx: 3, stroke: "currentColor", strokeWidth: 1.8 }),
      h("path", { d: "M9.5 4v16", stroke: "currentColor", strokeWidth: 1.8 }),
    );

  /**
   * 品牌区移除后，把顶行（logoRow）压扁，并将官方「收起侧栏」按钮叠到「新会话」行右端。
   * 官方没有该按钮或新会话行的插槽，这里只借品牌插槽的挂载生命周期打一个标记类，
   * 纯 CSS 完成移位（DOM 移动会被宿主折叠动画的重渲染吞掉）。
   * 定位锚点：品牌 span 所在 logoRow（div[data-window-drag]）；行内最后一个按钮且不含
   * 品牌 span 的即收起按钮（macOS 顶栏布局下收起按钮不在本行 → 找不到，不移位）。
   */
  const BrandShift: () => unknown = () => {
    const ref = useRef<HTMLElement | null>(null);
    useEffect(() => {
      const span = ref.current ?? document.querySelector<HTMLElement>("[data-dss-brand=name]");
      if (span === null || span === undefined) return;
      const row = span.closest("div[data-window-drag]");
      if (row === null) return;
      let toggle: Element | null = null;
      try {
        toggle = row.querySelector("button:last-of-type:not(:has([data-dss-brand]))");
      } catch {
        // 不支持 :has 的宿主浏览器：不移位，仅隐藏品牌。
        return;
      }
      if (toggle === null) return;
      row.classList.add("dss-logo-shift");
      return () => { row.classList.remove("dss-logo-shift"); };
    }, []);
    return h("span", { "data-dss-brand": "name", ref, "aria-hidden": "true", style: { display: "none" } });
  };

  const PanelIcon: (p: { size?: number; active?: boolean }) => unknown = (p) => {
    const size = p.size ?? 16;
    return h("svg", {
      className: "dss-panel-icon",
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      "aria-hidden": "true",
    },
      h("circle", { cx: 12, cy: 12, r: 9, stroke: "currentColor", strokeWidth: 1.6 }),
      h("path", { d: "M12 7v5l3 2", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" }),
    );
  };

  const Badge: (p: { tone: string; children: unknown }) => unknown = (p) =>
    h("span", { className: `dss-badge ${p.tone}` }, p.children);

  const TaskModal: (p: {
    task: TaskView | null;
    workspaces: WorkspaceRow[];
    getSessions?: () => SessionRow[];
    fetchPresets?: () => Promise<PresetRow[]>;
    fetchModels?: () => Promise<ModelOption[]>;
    onClose: () => void;
    onSaved: () => void;
  }) => unknown = (p) => {
    const editing = p.task !== null;
    const initialMs = p.task === null ? Date.now() + 30 * 60000 : Date.parse(p.task.scheduledAt);
    const baseMs = Number.isFinite(initialMs) ? initialMs : Date.now() + 30 * 60000;
    const initialFreq = p.task?.frequency;
    const initialKind = initialFreq === undefined || initialFreq.kind === "after" ? "once" : initialFreq.kind;
    const [title, setTitle] = useState(p.task?.title ?? "");
    const [prompt, setPrompt] = useState(p.task?.prompt ?? "");
    const [kind, setKind] = useState<string>(initialKind);
    const [onceDate, setOnceDate] = useState(dateInput(baseMs));
    const [onceTime, setOnceTime] = useState(timeInput(baseMs, true));
    const [dailyTime, setDailyTime] = useState(initialFreq?.kind === "daily" ? initialFreq.time.slice(0, 5) : timeInput(baseMs).slice(0, 5));
    const [weeklyTime, setWeeklyTime] = useState(initialFreq?.kind === "weekly" ? initialFreq.time.slice(0, 5) : timeInput(baseMs).slice(0, 5));
    const [weekdays, setWeekdays] = useState<number[]>(initialFreq?.kind === "weekly" ? initialFreq.weekdays : [new Date().getDay() === 0 ? 7 : new Date().getDay()]);
    const [everyValue, setEveryValue] = useState(initialFreq?.kind === "every" ? String(Math.max(1, Math.round(initialFreq.seconds / 60))) : "30");
    const [everyUnit, setEveryUnit] = useState("minute");
    const [cron, setCron] = useState(initialFreq?.kind === "cron" ? initialFreq.expression : "0 9 * * *");
    const [validity, setValidity] = useState(p.task?.endsAt === undefined ? "forever" : "until");
    const [endsDate, setEndsDate] = useState(p.task?.endsAt === undefined ? dateInput(Date.now() + 30 * 86400000) : dateInput(p.task.endsAt));
    const [endsTime, setEndsTime] = useState(p.task?.endsAt === undefined ? "23:59" : timeInput(p.task.endsAt));
    const [workspaceId, setWorkspaceId] = useState<string>(p.workspaces[0]?.workspaceId ?? "");
    const [notify, setNotify] = useState(p.task?.notify !== false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // 目标模式：新建专属任务会话 / 发送到现有会话；编辑时固定为现有绑定不可改。
    // 弹窗每次打开都重新挂载（TaskPage 条件渲染），初始态取自 p.task 即可。
    const [targetMode, setTargetMode] = useState<"new" | "existing">(p.task !== null ? "existing" : "new");
    const [sessionId, setSessionId] = useState<string>(p.task?.sessionId ?? "");
    const [presetId, setPresetId] = useState<string>(p.task?.agentPreset ?? "");
    const [modelKey, setModelKey] = useState<string>(
      p.task?.model === undefined ? "" : `${p.task.model.provider}|${p.task.model.model}`,
    );
    const [presets, setPresets] = useState<{ loading: boolean; list: PresetRow[]; error: string | null }>({ loading: false, list: [], error: null });
    const [models, setModels] = useState<{ loading: boolean; list: ModelOption[]; error: string | null }>({ loading: false, list: [], error: null });

    useEffect(() => {
      let cancelled = false;
      if (p.fetchPresets !== undefined) {
        setPresets(s => ({ ...s, loading: true }));
        p.fetchPresets().then(
          list => { if (!cancelled) setPresets({ loading: false, list, error: null }); },
          (e: unknown) => { if (!cancelled) setPresets({ loading: false, list: [], error: String((e as Error)?.message ?? e) }); },
        );
      }
      if (p.fetchModels !== undefined) {
        setModels(s => ({ ...s, loading: true }));
        p.fetchModels().then(
          list => { if (!cancelled) setModels({ loading: false, list, error: null }); },
          (e: unknown) => { if (!cancelled) setModels({ loading: false, list: [], error: String((e as Error)?.message ?? e) }); },
        );
      }
      return () => { cancelled = true; };
    }, []);

    const toggleWeekday = (day: number): void => {
      setWeekdays(prev => prev.includes(day) ? prev.filter(x => x !== day) : [...prev, day].sort((a, b) => a - b));
    };

    const buildFrequency = (): Frequency => {
      if (kind === "once") {
        const at = localEpoch(onceDate, onceTime);
        if (!Number.isFinite(at) || at <= Date.now()) throw new Error("单次执行时间必须晚于当前时间");
        return { kind: "once", at: new Date(at).toISOString() };
      }
      if (kind === "daily") return { kind: "daily", time: `${dailyTime}:00`, timeZone: TIME_ZONE };
      if (kind === "weekly") {
        if (weekdays.length === 0) throw new Error("每周任务至少选择一天");
        return { kind: "weekly", time: `${weeklyTime}:00`, timeZone: TIME_ZONE, weekdays };
      }
      if (kind === "every") {
        const n = Number(everyValue);
        if (!Number.isFinite(n) || n <= 0) throw new Error("间隔必须是正数");
        const seconds = Math.max(60, Math.round(n * (everyUnit === "hour" ? 3600 : everyUnit === "day" ? 86400 : 60)));
        return { kind: "every", seconds };
      }
      if (kind === "cron") {
        const expression = cron.trim();
        if (expression === "") throw new Error("Cron 表达式不能为空");
        return { kind: "cron", expression, timeZone: TIME_ZONE };
      }
      throw new Error("未知的执行频率");
    };

    const submit = async (): Promise<void> => {
      setError(null);
      const cleanTitle = title.trim();
      const cleanPrompt = prompt.trim();
      if (cleanTitle === "") { setError("请填写任务名称"); return; }
      if (cleanPrompt === "") { setError("请填写提示词"); return; }
      if (!editing && targetMode === "new" && workspaceId === "") { setError("请选择工作区"); return; }
      if (!editing && targetMode === "existing" && sessionId === "") { setError("请选择现有会话"); return; }
      const modelOpt = modelKey === "" ? undefined : models.list.find(m => `${m.provider}|${m.model}` === modelKey);
      if (modelKey !== "" && modelOpt === undefined) { setError("模型清单未加载完成，请稍候或重新打开弹窗"); return; }
      let frequency: Frequency;
      try { frequency = buildFrequency(); } catch (e) { setError(String((e as Error).message)); return; }
      let endsAt: number | undefined;
      if (validity === "until" && (frequency.kind === "daily" || frequency.kind === "weekly" || frequency.kind === "every" || frequency.kind === "cron")) {
        const at = localEpoch(endsDate, endsTime);
        if (!Number.isFinite(at) || at <= Date.now()) { setError("截止时间必须晚于当前时间"); return; }
        endsAt = at;
      }
      const model = modelOpt === undefined ? undefined : {
        provider: modelOpt.provider,
        model: modelOpt.model,
        providerName: modelOpt.providerName,
        modelName: modelOpt.modelName,
      };
      setBusy(true);
      try {
        if (editing) {
          const r = await api<ApiTaskResponse>("/tasks/update", {
            method: "POST",
            body: JSON.stringify({
              id: p.task!.id,
              title: cleanTitle,
              prompt: cleanPrompt,
              frequency,
              endsAt: endsAt ?? null,
              notify,
              ...(model !== undefined || p.task?.model !== undefined ? { model: model ?? null } : {}),
            }),
          });
          if (!r.ok) throw new Error(r.error ?? "保存失败");
        } else {
          const r = await api<ApiTaskResponse>("/tasks", {
            method: "POST",
            body: JSON.stringify({
              title: cleanTitle,
              prompt: cleanPrompt,
              frequency,
              ...(targetMode === "new"
                ? { workspaceId, ...(presetId === "" ? {} : { agentPreset: presetId }) }
                : { sessionId }),
              ...(endsAt === undefined ? {} : { endsAt }),
              ...(model === undefined ? {} : { model }),
              notify,
            }),
          });
          if (!r.ok) throw new Error(r.error ?? "创建失败");
        }
        p.onSaved();
        p.onClose();
      } catch (e) {
        setError(String((e as Error)?.message ?? e));
      } finally {
        setBusy(false);
      }
    };

    const sessionRows = p.getSessions?.() ?? [];
    const modelSelect = h("select", { className: "dss-sel", value: modelKey, onChange: (e: { target: { value: string } }) => setModelKey(e.target.value) },
      h("option", { value: "" }, "不指定（跟随会话现状 / 全局默认）"),
      models.list.map(m => h("option", { key: `${m.provider}|${m.model}`, value: `${m.provider}|${m.model}` }, `${m.providerName} · ${m.modelName}`)));

    return h("div", { className: "dss-scrim", onClick: (e: { target: unknown; currentTarget: unknown }) => { if (e.target === e.currentTarget) p.onClose(); } },
      h("div", { className: "dss-modal", role: "dialog", "aria-modal": "true" },
        h("div", { className: "dss-modal-head" },
          h("div", null,
            h("div", { className: "dss-modal-title" }, editing ? "编辑定时任务" : "添加定时任务"),
            h("div", { className: "dss-note" }, "到点由 DSH 官方 Schedule 把提示词投递到任务会话；页面关闭也会执行。")),
          h("button", { type: "button", className: "dss-x", "aria-label": "关闭", onClick: p.onClose }, "✕")),

        h("div", { className: "dss-form dss-modal-form" },
          h("div", { className: "dss-field" },
            h("label", null, "名称"),
            h("input", { className: "dss-input", value: title, maxLength: 120, placeholder: "例如：每日代码审查", onChange: (e: { target: { value: string } }) => setTitle(e.target.value) })),
          h("div", { className: "dss-field" },
            h("label", null, "提示词"),
            h("textarea", { className: "dss-textarea", value: prompt, placeholder: "到点后发送给 agent 的完整提示词", onChange: (e: { target: { value: string } }) => setPrompt(e.target.value) })),
          h("div", { className: "dss-grid" },
            h("div", { className: "dss-field" },
              h("label", null, "执行频率"),
              h("select", { className: "dss-sel", value: kind, onChange: (e: { target: { value: string } }) => setKind(e.target.value) },
                h("option", { value: "once" }, "单次"),
                h("option", { value: "daily" }, "每天"),
                h("option", { value: "weekly" }, "每周"),
                h("option", { value: "every" }, "固定间隔"),
                h("option", { value: "cron" }, "Cron 表达式"))),
            h("div", { className: "dss-field" },
              h("label", null, "有效期"),
              h("select", { className: "dss-sel", value: validity, onChange: (e: { target: { value: string } }) => setValidity(e.target.value) },
                h("option", { value: "forever" }, "长期有效"),
                h("option", { value: "until" }, "截止到指定时间")))),
          kind === "once"
            ? h("div", { className: "dss-inline" },
                h("input", { type: "date", className: "dss-input", value: onceDate, onChange: (e: { target: { value: string } }) => setOnceDate(e.target.value) }),
                h("input", { type: "time", step: "1", className: "dss-input", value: onceTime, onChange: (e: { target: { value: string } }) => setOnceTime(e.target.value) }))
            : null,
          kind === "daily"
            ? h("div", { className: "dss-inline" },
                h("input", { type: "time", className: "dss-input", value: dailyTime, onChange: (e: { target: { value: string } }) => setDailyTime(e.target.value) }),
                h("span", { className: "dss-muted" }, `每天 · ${TIME_ZONE}`))
            : null,
          kind === "weekly"
            ? h("div", { className: "dss-form" },
                h("div", { className: "dss-inline" },
                  h("input", { type: "time", className: "dss-input", value: weeklyTime, onChange: (e: { target: { value: string } }) => setWeeklyTime(e.target.value) }),
                  h("span", { className: "dss-muted" }, `每周 · ${TIME_ZONE}`)),
                h("div", { className: "dss-inline" },
                  WEEKDAYS.map(([day, name]) => h("button", {
                    key: day,
                    type: "button",
                    className: "dss-btn-ghost" + (weekdays.includes(day) ? " dss-day-on" : ""),
                    style: weekdays.includes(day) ? { color: "var(--dsw-alias-brand-primary)", borderColor: "var(--dsw-alias-brand-primary)" } : undefined,
                    onClick: () => toggleWeekday(day),
                  }, name))))
            : null,
          kind === "every"
            ? h("div", { className: "dss-inline" },
                h("input", { type: "number", min: 1, className: "dss-input", value: everyValue, onChange: (e: { target: { value: string } }) => setEveryValue(e.target.value) }),
                h("select", { className: "dss-sel", value: everyUnit, onChange: (e: { target: { value: string } }) => setEveryUnit(e.target.value) },
                  h("option", { value: "minute" }, "分钟"),
                  h("option", { value: "hour" }, "小时"),
                  h("option", { value: "day" }, "天")),
                h("span", { className: "dss-muted" }, "最小间隔 1 分钟"))
            : null,
          kind === "cron"
            ? h("div", { className: "dss-field" },
                h("label", null, `Cron 表达式（5 字段，${TIME_ZONE}）`),
                h("input", { className: "dss-input", value: cron, placeholder: "0 9 * * 1-5", onChange: (e: { target: { value: string } }) => setCron(e.target.value) }))
            : null,
          validity === "until" && kind !== "once"
            ? h("div", { className: "dss-inline" },
                h("span", { className: "dss-muted" }, "截止"),
                h("input", { type: "date", className: "dss-input", value: endsDate, onChange: (e: { target: { value: string } }) => setEndsDate(e.target.value) }),
                h("input", { type: "time", className: "dss-input", value: endsTime, onChange: (e: { target: { value: string } }) => setEndsTime(e.target.value) }),
                h("span", { className: "dss-muted" }, "到期后本插件会删除官方任务"))
            : null,
          editing
            ? h("div", { className: "dss-field" },
                h("label", null, "任务会话"),
                h("div", { className: "dss-note" },
                  `${p.task!.sessionTitle ?? "（无标题）"} · ${p.task!.sessionId}`,
                  p.task!.agentPreset !== undefined ? h("span", { className: "dss-muted" }, ` · preset：${p.task!.agentPreset}`) : null))
            : h("div", { className: "dss-form" },
                h("div", { className: "dss-field" },
                  h("label", null, "发送到"),
                  h("div", { className: "dss-inline" },
                    h("button", { type: "button", className: "dss-btn-ghost" + (targetMode === "new" ? " dss-day-on" : ""), style: targetMode === "new" ? { color: "var(--dsw-alias-brand-primary)", borderColor: "var(--dsw-alias-brand-primary)" } : undefined, onClick: () => setTargetMode("new") }, "新建任务会话"),
                    h("button", { type: "button", className: "dss-btn-ghost" + (targetMode === "existing" ? " dss-day-on" : ""), style: targetMode === "existing" ? { color: "var(--dsw-alias-brand-primary)", borderColor: "var(--dsw-alias-brand-primary)" } : undefined, onClick: () => setTargetMode("existing") }, "现有会话"))),
                targetMode === "new"
                  ? h("div", { className: "dss-grid" },
                      h("div", { className: "dss-field" },
                        h("label", null, "工作区（会在其中创建专属任务会话）"),
                        p.workspaces.length === 0
                          ? h("div", { className: "dss-warn" }, "没有可用工作区：请先在左侧新建/打开一个工作区")
                          : h("select", { className: "dss-sel", value: workspaceId, onChange: (e: { target: { value: string } }) => setWorkspaceId(e.target.value) },
                              p.workspaces.map(w => h("option", { key: w.workspaceId, value: w.workspaceId }, w.title)))),
                      h("div", { className: "dss-field" },
                        h("label", null, "Agent 模式（preset，新会话专用）"),
                        presets.loading
                          ? h("div", { className: "dss-muted" }, "模式清单加载中…")
                          : presets.error !== null
                            ? h("div", { className: "dss-warn" }, `模式清单加载失败：${presets.error}（可留空用默认）`)
                            : h("select", { className: "dss-sel", value: presetId, onChange: (e: { target: { value: string } }) => setPresetId(e.target.value) },
                                h("option", { value: "" }, "不指定（系统默认模式）"),
                                presets.list.map(x => h("option", { key: x.id, value: x.id }, x.name)))))
                  : h("div", { className: "dss-field" },
                      h("label", null, "选择会话"),
                      sessionRows.length === 0
                        ? h("div", { className: "dss-warn" }, "没有可选会话：请先打开一个会话")
                        : h("select", { className: "dss-sel", value: sessionId, onChange: (e: { target: { value: string } }) => setSessionId(e.target.value) },
                            h("option", { value: "" }, "（请选择）"),
                            sessionRows.slice(0, 200).map(s => h("option", { key: s.sessionId, value: s.sessionId },
                              `${s.title !== "" ? s.title : s.sessionId.slice(0, 16)}${s.agentPreset !== undefined ? ` · ${s.agentPreset}` : ""}`))),
                      h("div", { className: "dss-note" }, "现有会话的 agent 模式已固定（首轮后锁定），任务沿用该会话现状。"))),
          h("div", { className: "dss-field" },
            h("label", null, "执行模型"),
            models.loading
              ? h("div", { className: "dss-muted" }, "模型清单加载中…")
              : models.error !== null
                ? h("div", { className: "dss-warn" }, `模型清单加载失败：${models.error}（可留空用默认）`)
                : modelSelect,
            h("div", { className: "dss-note" }, "指定后在保存时应用到任务会话；与在会话里手动切换模型同链路，会同步更新全局默认模型。部分模型无工具/推理能力，请选择可执行的模型。")),
          h("label", { className: "dss-check" },
            h("input", { type: "checkbox", checked: notify, onChange: (e: { target: { checked: boolean } }) => setNotify(e.target.checked) }),
            h("span", null, "执行完成后推送状态（由 dsh-notify-alert 发送到已配置的企业微信 / WxPusher）")),
          h("div", { className: "dss-note" },
            "权限跟随任务会话，不在本表单里单独切换；需要完全访问时在任务会话中输入 /permission 修改。"),
          error !== null ? h("div", { className: "dss-err" }, error) : null,
          h("div", { className: "dss-actions" },
            h("button", { type: "button", className: "dss-btn-ghost", onClick: p.onClose }, "取消"),
            h("button", { type: "button", className: "dss-btn", disabled: busy, onClick: () => void submit() }, busy ? "保存中…" : editing ? "保存修改" : "创建任务"),
          ),
        ),
      ),
    );
  };

  const TaskRow: (p: {
    task: TaskView;
    onEdit: () => void;
    onRefresh: () => void;
    openSession?: (id: string) => void;
  }) => unknown = (p) => {
    const t = p.task;
    const active = t.status === "active";
    const last = t.lastExecution;
    const tone = !active ? "dss-badge-ended" : "dss-badge-active";
    const remove = (): void => {
      if (!window.confirm(`删除任务「${t.title}」？官方任务记录和投递历史会一起删除。`)) return;
      void api("/tasks/delete", { method: "POST", body: JSON.stringify({ id: t.id }) })
        .then(() => p.onRefresh())
        .catch(e => window.alert("删除失败：" + String((e as Error).message)));
    };
    const run = (): void => {
      void api("/tasks/run", { method: "POST", body: JSON.stringify({ id: t.id }) })
        .then(() => p.onRefresh())
        .catch(e => window.alert("立即执行失败：" + String((e as Error).message)));
    };
    return h("div", { className: "dss-card" },
      h("div", { className: "dss-card-main" },
        h("div", { className: "dss-card-title" },
          t.title,
          h("span", { className: `dss-badge ${tone}` }, active ? "待执行" : "已结束"),
          last !== undefined
            ? h("span", { className: `dss-badge ${executionTone(last.status)}` }, `最近：${statusLabel(last.status)}`)
            : h("span", { className: "dss-badge dss-badge-ended" }, "尚未执行")),
        h("div", { className: "dss-card-prompt", title: t.prompt }, t.prompt),
        h("div", { className: "dss-card-meta" },
          h("span", null, frequencyLabel(t.frequency)),
          h("span", null, active ? `下次 ${fmtDateTime(t.scheduledAt)} · ${countdown(t.scheduledAt)}` : `已结束`),
          t.endsAt !== undefined ? h("span", null, `截止 ${fmtDateTime(t.endsAt)}`) : null,
          h("span", { title: t.sessionId }, `会话 ${t.sessionTitle ?? t.sessionId.slice(0, 12)}`),
          t.model !== undefined ? h("span", { title: `${t.model.provider}/${t.model.model}` }, `模型 ${t.model.modelName ?? t.model.model}`) : null,
          t.lastDelivery !== undefined ? h("span", null, `最近投递 ${fmtDateTime(t.lastDelivery.deliveredAt)}`) : null),
        last !== undefined
          ? h("div", { className: "dss-note" },
              `${statusLabel(last.status)} · ${fmtDateTime(last.at)} · ${(last.durationMs / 1000).toFixed(1)}s`,
              last.error !== undefined ? ` · ${last.error}` : "",
              last.summary !== undefined ? h("div", { style: { marginTop: 2 } }, last.summary) : null)
          : null),
      h("div", { className: "dss-card-actions" },
        active ? h("button", { type: "button", className: "dss-btn-ghost", onClick: p.onEdit }, "编辑") : null,
        active ? h("button", { type: "button", className: "dss-btn-ghost", onClick: run }, "立即执行") : null,
        p.openSession !== undefined
          ? h("button", { type: "button", className: "dss-btn-ghost", onClick: () => { try { p.openSession?.(t.sessionId); } catch (e) { window.alert("打开会话失败：" + String((e as Error).message)); } } }, "打开会话")
          : null,
        h("button", { type: "button", className: "dss-btn-ghost dss-btn-danger", onClick: remove }, "删除")));
  };

  const TaskPage: (p: PageInjected & { embedded?: boolean }) => unknown = (p) => {
    const [tasks, setTasks] = useState<TaskView[]>([]);
    const [health, setHealth] = useState<ApiHealthResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [modal, setModal] = useState<{ task: TaskView | null } | null>(null);
    const [showEnded, setShowEnded] = useState(false);

    const refresh = (): void => {
      void fetchTasks().then(
        r => { setTasks(r.tasks); setLoadError(null); setLoading(false); },
        (e: unknown) => { setLoadError(String((e as Error)?.message ?? e)); setLoading(false); },
      );
      void fetchHealth().then(setHealth);
    };

    useEffect(() => {
      refresh();
      const timer = window.setInterval(refresh, REFRESH_MS);
      return () => window.clearInterval(timer);
    }, []);

    const workspaceRows = p.getWorkspaces?.() ?? p.workspaces ?? [];
    const active = tasks.filter(t => t.status === "active").sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
    const ended = tasks.filter(t => t.status !== "active");
    const next = active[0];

    return h("div", { className: "dss-page" + (p.embedded ? " dss-embedded" : "") },
      h("div", { className: "dss-top" },
        h("div", null,
          h("div", { className: "dss-title" }, "定时任务"),
          h("div", { className: "dss-sub" }, "复用 DSH 官方 Schedule 调度：到点把提示词投递到任务会话，页面关闭也会执行。任务结束后可查看最近执行状态。")),
        h("div", { className: "dss-top-actions" },
          h("button", { type: "button", className: "dss-btn", onClick: () => setModal({ task: null }) }, "＋ 添加定时任务"),
          ended.length > 0
            ? h("button", {
                type: "button",
                className: "dss-btn-ghost",
                onClick: () => {
                  if (!window.confirm(`清理全部 ${ended.length} 条已结束任务？官方记录和投递历史会一起删除。`)) return;
                  void api("/tasks/delete-inactive", { method: "POST", body: "{}" }).then(refresh).catch(e => window.alert("清理失败：" + String((e as Error).message)));
                },
              }, "清理已结束")
            : null)),
      h("div", { className: "dss-summary" },
        h("span", { className: "dss-stat" }, "待执行 ", h("b", null, String(active.length))),
        h("span", { className: "dss-stat" }, "已结束 ", h("b", null, String(ended.length))),
        next !== undefined ? h("span", { className: "dss-stat" }, "下一次 ", h("b", null, `${fmtDateTime(next.scheduledAt)}（${countdown(next.scheduledAt)}）`)) : null,
        health !== null
          ? h("span", { className: health.ok ? "dss-stat" : "dss-stat dss-err" },
              health.ok ? `host v${health.version ?? "?"} · 官方 Schedule 在线` : `host 不可达：${health.error ?? "未知原因"}`)
          : null),
      loadError !== null
        ? h("div", { className: "dss-err" }, `读取任务失败：${loadError}`)
        : null,
      loading && tasks.length === 0
        ? h("div", { className: "dss-empty" }, "读取中…")
        : null,
      h("div", { className: "dss-list" },
        active.length === 0 && !loading
          ? h("div", { className: "dss-empty" }, "还没有待执行任务。点右上角「＋ 添加定时任务」，或直接在输入框写好提示词后点「⏰ 定时」。")
          : active.map(t => h(TaskRow, {
              key: t.id,
              task: t,
              onEdit: () => setModal({ task: t }),
              onRefresh: refresh,
              ...(p.openSession === undefined ? {} : { openSession: p.openSession }),
            }))),
      ended.length > 0
        ? h("div", null,
            h("button", { type: "button", className: "dss-group-head", onClick: () => setShowEnded(v => !v) },
              h("span", null, showEnded ? "▼" : "▶"),
              h("span", null, `已结束（${ended.length}）`),
              h("span", { className: "dss-muted", style: { marginLeft: "auto" } }, showEnded ? "" : "点击展开")),
            showEnded
              ? h("div", { className: "dss-list", style: { marginTop: 8 } },
                  ended.map(t => h(TaskRow, {
                    key: t.id,
                    task: t,
                    onEdit: () => setModal({ task: t }),
                    onRefresh: refresh,
                    ...(p.openSession === undefined ? {} : { openSession: p.openSession }),
                  })))
              : null)
        : null,
      modal !== null
        ? h(TaskModal, {
            task: modal.task,
            workspaces: workspaceRows,
            ...(p.getSessions === undefined ? {} : { getSessions: p.getSessions }),
            ...(p.fetchPresets === undefined ? {} : { fetchPresets: p.fetchPresets }),
            ...(p.fetchModels === undefined ? {} : { fetchModels: p.fetchModels }),
            onClose: () => setModal(null),
            onSaved: refresh,
          })
        : null);
  };

  const SettingsSection: (p: PageInjected & { close?: () => void }) => unknown = (p) =>
    h("div", { className: "dss-wrap", style: { padding: "4px 2px" } },
      h("div", { className: "dss-note", style: { marginBottom: 10 } },
        "完整表单与任务列表已移到左侧「定时任务」页面；这里保留设置入口，方便从设置里直接查看状态。"),
      h(TaskPage, { ...p, embedded: true }));

  const InputBadge: (p: Record<string, unknown>) => unknown = (p) => {
    const pp = p as {
      sessionId?: string;
      locked?: boolean;
      useInput?: (sel: (s: { draft?: string }) => unknown) => unknown;
      inputActions?: { setDraft?: (text: string) => void };
    };
    const useInputFn = typeof pp.useInput === "function" ? pp.useInput : ((_sel: (s: { draft?: string }) => unknown): unknown => undefined);
    const draftRaw = useInputFn(s => s?.draft ?? "");
    const draft = typeof draftRaw === "string" ? draftRaw : "";
    const sessionId = String(pp.sessionId ?? "").trim();
    const setDraft = pp.inputActions?.setDraft;
    const [open, setOpen] = useState(false);
    const [chipEl, setChipEl] = useState<HTMLElement | null>(null);
    const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);
    const [fireAt, setFireAt] = useState<number>(Date.now() + 30 * 60000);
    const [clearAfter, setClearAfter] = useState(true);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<{ msg: string; kind?: "ok" | "err" | "warn" } | null>(null);

    const openPop = (): void => {
      if (pp.locked) return;
      const base = Date.now() + 30 * 60000;
      setFireAt(base);
      setNotice(null);
      const el = chipEl;
      if (el !== null) {
        const r = el.getBoundingClientRect();
        setAnchor({
          left: Math.max(8, Math.min(r.left - 60, window.innerWidth - 328)),
          bottom: Math.max(8, window.innerHeight - r.top + 8),
        });
      } else setAnchor({ left: 16, bottom: 96 });
      setOpen(true);
    };

    useEffect(() => {
      if (!open) return;
      const onDoc = (e: MouseEvent): void => {
        const target = e.target as Node | null;
        if (chipEl !== null && target !== null && chipEl.contains(target)) return;
        const pop = document.getElementById("dss-pop");
        if (pop !== null && target !== null && pop.contains(target)) return;
        setOpen(false);
      };
      document.addEventListener("mousedown", onDoc);
      return () => document.removeEventListener("mousedown", onDoc);
    }, [open, chipEl]);

    const create = async (): Promise<void> => {
      const body = draft.trim();
      if (sessionId === "") { setNotice({ msg: "未取到当前会话 id，请刷新页面", kind: "err" }); return; }
      if (body === "") { setNotice({ msg: "输入框为空：请先写下要定时发送的内容", kind: "warn" }); return; }
      if (fireAt <= Date.now()) { setNotice({ msg: "执行时间必须晚于当前时间", kind: "err" }); return; }
      const firstLine = body.split(/\r?\n/u).find(line => line.trim() !== "")?.trim() ?? "定时任务";
      setBusy(true);
      try {
        const r = await api<ApiTaskResponse>("/tasks", {
          method: "POST",
          body: JSON.stringify({
            title: firstLine.length > 40 ? `${firstLine.slice(0, 39)}…` : firstLine,
            prompt: body,
            sessionId,
            frequency: { kind: "once", at: new Date(fireAt).toISOString() },
            notify: true,
          }),
        });
        if (!r.ok) throw new Error(r.error ?? "创建失败");
        if (clearAfter && typeof setDraft === "function") setDraft("");
        setNotice({ msg: `已安排 ${fmtTime(fireAt)} 执行${clearAfter ? "（输入框已清空）" : ""}`, kind: "ok" });
        window.setTimeout(() => setOpen(false), 900);
      } catch (e) {
        setNotice({ msg: String((e as Error)?.message ?? e), kind: "err" });
      } finally {
        setBusy(false);
      }
    };

    const pop = open
      ? h("div", { id: "dss-pop", className: "dss-pop", style: anchor ?? { left: 16, bottom: 96 } },
          h("div", { className: "dss-pop-title" }, "⏰ 定时执行", h("span", { className: "sub" }, sessionId === "" ? "无当前会话" : "目标：当前会话")),
          h("div", { className: "dss-field" },
            h("label", null, "执行时间"),
            h("input", {
              type: "datetime-local",
              className: "dss-input",
              value: `${dateInput(fireAt)}T${timeInput(fireAt, true)}`,
              onChange: (e: { target: { value: string } }) => {
                const ms = Date.parse(e.target.value);
                if (Number.isFinite(ms)) setFireAt(ms);
              },
            }),
            h("div", { className: "dss-muted" }, countdown(new Date(fireAt).toISOString()))),
          h("div", { className: "dss-field" },
            h("label", null, "内容（取输入框当前草稿）"),
            bodyPreview(draft, h)),
          draft.trim() !== "" && typeof setDraft === "function"
            ? h("label", { className: "dss-check" },
                h("input", { type: "checkbox", checked: clearAfter, onChange: (e: { target: { checked: boolean } }) => setClearAfter(e.target.checked) }),
                "创建后清空输入框（避免误按回车立即发送）")
            : null,
          notice !== null ? h("div", { className: notice.kind === "err" ? "dss-err" : notice.kind === "warn" ? "dss-warn" : "dss-ok" }, notice.msg) : null,
          h("div", { className: "dss-actions" },
            h("button", { type: "button", className: "dss-btn-ghost", onClick: () => setOpen(false) }, "取消"),
            h("button", { type: "button", className: "dss-btn", disabled: busy || draft.trim() === "", onClick: () => void create() }, busy ? "创建中…" : "创建定时任务")))
      : null;

    return h("span", { style: { display: "inline-flex", position: "relative" } },
      h("button", {
        type: "button",
        className: "dss-bchip" + (open ? " on" : ""),
        disabled: !!pp.locked,
        ref: (el: HTMLElement | null) => setChipEl(el),
        title: "把输入框内容定时投递到当前会话",
        onClick: () => open ? setOpen(false) : openPop(),
      }, "⏰", h("span", null, "定时")),
      pop);
  };

  const ScheduledDock: (p: { sessionId?: string }) => unknown = (p) => {
    const sessionId = String(p.sessionId ?? "").trim();
    const [tasks, setTasks] = useState<TaskView[]>([]);
    const [tick, setTick] = useState(0);

    const refresh = (): void => {
      void fetchTasks().then(r => setTasks(r.tasks), () => { /* dock 静默 */ });
    };
    useEffect(() => {
      if (sessionId === "") return;
      refresh();
      const timer = window.setInterval(() => { setTick(t => t + 1); refresh(); }, REFRESH_MS);
      return () => window.clearInterval(timer);
    }, [sessionId]);

    const mine = tasks
      .filter(t => t.sessionId === sessionId && t.status === "active")
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))
      .slice(0, 4);
    if (mine.length === 0) return null;

    return h("div", { className: "dss-dock", "data-scheduled-dock": "" },
      h("div", { className: "dss-dock-head" }, `⏰ 定时任务（${mine.length}）`),
      h("ul", { className: "dss-dock-list" },
        mine.map(t => h("li", { key: t.id, className: "dss-dock-row" },
          h("span", { className: "dss-dock-time" }, fmtClock(Date.parse(t.scheduledAt))),
          h("span", { className: "dss-dock-preview", title: t.title }, t.title),
          h("span", { className: "dss-dock-eta" }, countdown(t.scheduledAt))))));
  };

  return { TaskPage, SettingsSection, InputBadge, ScheduledDock, PanelIcon, BrandHidden, BrandShift };
}

function bodyPreview(draft: string, h: H): unknown {
  const text = draft.trim();
  if (text === "") return h("div", { className: "dss-warn" }, "输入框为空 —— 请先在输入框写下要发送的内容");
  return h("div", { className: "dss-preview" }, text.length > 500 ? `${text.slice(0, 500)}…` : text);
}

export type MainUI = ReturnType<typeof makeUI>;
