/**
 * dsh-scheduled-send — Client UI（h 函数式，不依赖 JSX runtime）。
 *
 * v0.5.0 变更（对应最新一轮需求）：
 *   1. 创建不再可能"卡死"：`api()` 带 10s 超时（AbortController）；失败/超时给出明确文案。
 *   2. 时间规则严格化：今天只可定"当前时刻之后"（已过 → 报错并提示改选明天，不再静默顺延）；
 *      明天可定 0–24 点（00:00:00–23:59:59）。
 *   3. 每个会话最多 3 个待触发任务：创建前客户端先行校验 + host 端强校验
 *      （scheduler.add 拒绝第 4 个），设置面板写明规则。
 *   4. 设置面板任务列表：新增「放大查看」（全内容弹层）与「打开会话」
 *      （经客户端 sessions 服务 open(id) 跳到对应工作区会话）。
 *
 * 复用 dsh 能力（不重造轮子）：
 *   - 排队投递：host `sessionController.prompt({mode:'queue'})` → 原生 Inbox next-turn
 *     （与 dsh 原生 QueueDock 同通道；本项目只加"定时触发"这一层）。
 *   - 插槽 standard props：`sessionId` / `useInput`(draft) / `inputActions`(setDraft)。
 */
import type { ScheduledJob } from "../shared/types.ts";
import { MAX_PENDING_PER_SESSION, API_TIMEOUT_MS } from "../shared/constants.ts";
import { sessionMetaOf, type SessionMetaRow } from "../shared/session-meta.ts";

interface Ctx {
  createPortal: ((n: unknown, c: Element) => unknown) | null;
  portalHost: () => Element | null;
}

type H = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => unknown;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 完整时刻：MM-DD HH:mm:ss。 */
function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 只显示时钟：HH:mm:ss。 */
function fmtClock(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function countdown(ms: number): string {
  const diff = ms - Date.now();
  if (diff <= 0) return "已到点";
  const s = Math.floor(diff / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}小时${m}分后`;
  if (m > 0) return `${m}分${sec}秒后`;
  return `${sec}秒后`;
}

/** 由「天偏移 + 时分秒」解析为绝对时刻（本地时区）。day 0=今天 1=明天。 */
function resolveAt(day: number, hh: number, mm: number, ss: number): number {
  const d = new Date();
  d.setDate(d.getDate() + day);
  d.setHours(hh, mm, ss, 0);
  return d.getTime();
}

/** 全部样式走 DSH 主题 token；仅结构/间距为字面量。 */
const CSS = `
.dss-wrap{display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);font-size:13px}
.dss-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dss-note{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.5}
.dss-sel,.dss-input{box-sizing:border-box;background:var(--dsw-alias-bg-layer-2);border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 8px;font-size:13px;color:var(--dsw-alias-label-primary);font-family:inherit}
.dss-sel{cursor:pointer}
.dss-input{width:100%}
.dss-form{display:flex;flex-direction:column;gap:10px}
.dss-actions{display:flex;gap:8px;justify-content:flex-end;align-items:center;flex-wrap:wrap}
.dss-btn{padding:6px 14px;border-radius:8px;border:0.5px solid transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-size:13px;cursor:pointer}
.dss-btn:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dss-btn:disabled{opacity:.5;cursor:not-allowed}
.dss-btn-ghost{padding:5px 10px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}
.dss-btn-ghost:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dss-badge{font-size:11px;padding:1px 7px;border-radius:999px;border:0.5px solid}
.dss-pending{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dss-sent{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.dss-missed{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dss-cancelled{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2)}
.dss-job{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.dss-job .txt{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.dss-job .preview{font-size:13px;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dss-job .meta{font-size:11px;color:var(--dsw-alias-label-secondary);display:flex;gap:8px;flex-wrap:wrap}
.dss-empty{color:var(--dsw-alias-label-secondary);text-align:center;padding:18px 0;font-size:13px}
/* 输入区标识（与模型标识同一行，风格与原生控件一致） */
.dss-bchip{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 9px;border-radius:8px;border:0.5px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;cursor:pointer;user-select:none;white-space:nowrap;font-family:inherit}
.dss-bchip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dss-bchip.on{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-hover-accent)}
.dss-bchip:disabled{opacity:.45;cursor:not-allowed}
/* 浮层：遵循 ui-theme 立面规范（无边框 + elevation 阴影） */
.dss-pop{position:fixed;z-index:1000;width:300px;box-sizing:border-box;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border:0;border-radius:12px;box-shadow:var(--dsw-elevation-panel);padding:12px;display:flex;flex-direction:column;gap:10px;font-size:13px}
.dss-pop-title{font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-primary)}
.dss-pop-title .sub{font-size:11px;font-weight:400;color:var(--dsw-alias-label-secondary);margin-left:auto}
.dss-clock{display:flex;align-items:center;gap:4px}
.dss-clock .sep{color:var(--dsw-alias-label-secondary);font-size:14px}
.dss-clock .dss-sel{width:62px;text-align:center}
.dss-day{display:flex;gap:6px;align-items:center}
.dss-daybtn{padding:4px 10px;border-radius:6px;border:0.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}
.dss-daybtn.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dss-daybtn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dss-preview{border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:8px 10px;font-size:12px;color:var(--dsw-alias-label-secondary);max-height:96px;overflow-y:auto;white-space:pre-wrap;word-break:break-word}
.dss-warn{font-size:12px;color:var(--dsw-alias-state-warn-primary)}
.dss-err{font-size:12px;color:var(--dsw-alias-state-error-primary)}
.dss-ok{font-size:12px;color:var(--dsw-alias-state-success-primary)}
.dss-check{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}
/* 放大查看弹层（模态） */
.dss-scrim{position:fixed;inset:0;z-index:100002;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;padding:24px}
.dss-modal{max-width:560px;width:100%;max-height:80vh;box-sizing:border-box;overflow:auto;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border:0;border-radius:12px;box-shadow:var(--dsw-elevation-prominent);padding:14px;display:flex;flex-direction:column;gap:10px;font-size:13px}
.dss-modal-body{white-space:pre-wrap;word-break:break-word;line-height:1.6;font-size:13px}
.dss-x{cursor:pointer;font-size:14px;line-height:1;opacity:.7;margin-left:auto;padding:2px 6px;border-radius:6px}
.dss-x:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover)}
.dss-limit-tag{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-state-warn-primary);border:0.5px solid var(--dsw-alias-state-warn-primary);border-radius:999px;padding:1px 8px}
/* 对话输入区定时排队 dock（对齐原生 QueueDock 语义） */
.dss-dock{width:100%;box-sizing:border-box;border:0.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:6px 10px;display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dsw-alias-label-primary)}
.dss-dock-head{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600}
.dss-dock-count{display:inline-flex;align-items:center;gap:4px}
.dss-dock-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.dss-dock-row{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-2)}
.dss-dock-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dss-dock-time{flex:none;font-weight:600;color:var(--dsw-alias-brand-primary);font-size:12px;white-space:nowrap}
.dss-dock-preview{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary)}
.dss-dock-eta{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}
.dss-dock-actions{flex:none;display:inline-flex;gap:4px}
/* 任务列表按状态分组 */
.dss-group{display:flex;flex-direction:column;gap:6px}
.dss-group-head{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:transparent;border:0;border-bottom:0.5px solid var(--dsw-alias-border-l2);padding:6px 2px;cursor:pointer;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.dss-group-head:hover{color:var(--dsw-alias-brand-primary)}
.dss-group-caret{font-size:10px;color:var(--dsw-alias-label-secondary);width:12px}
.dss-group-label{font-weight:600}
.dss-group-tip{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);font-weight:400}
.dss-group-body{display:flex;flex-direction:column;gap:8px;padding-left:2px}

/* Responsive, keyboard-accessible workspace surfaces. */

.dss-wrap {min-width:0; line-height:1.6;}
.dss-wrap * {box-sizing:border-box;}
.dss-label,.dss-note {font-size:12px;}
.dss-sel,.dss-input {max-width:100%; min-width:0; min-height:36px;}
.dss-btn,.dss-btn-ghost {min-height:34px;}
.dss-wrap :is(button,input,select,textarea):focus-visible {outline:2px solid var(--dsw-alias-link); outline-offset:2px;}
.dss-group-head {padding:10px 2px; flex-wrap:wrap;}

`;

const styleOnce = (): void => {
  if (typeof document === "undefined" || document.getElementById("dss-style")) return;
  const el = document.createElement("style");
  el.id = "dss-style";
  el.textContent = CSS;
  document.head.appendChild(el);
};

/** 统一请求：带超时（AbortController），绝不无限挂起。 */
async function api(path: string, init?: RequestInit): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
  try {
    const r = await fetch(`/api/scheduled-send${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    return r.json();
  } finally {
    window.clearTimeout(timer);
  }
}

/** 会话作用域插槽注入的标准 props（仅列出本插件用到的部分）。 */
interface SessionSeatProps {
  sessionId?: string;
  locked?: boolean;
  useInput?: (sel: (s: InputStateLike) => unknown) => unknown;
  inputActions?: { setDraft?: (text: string) => void };
}

interface InputStateLike {
  draft?: string;
}

export function makeUI(React: unknown, _ctx: Ctx) {
  const R = React as {
    useState: <T>(v: T) => [T, (v: T | ((prev: T) => T)) => void];
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => void;
    createElement: H;
  };
  const { useState, useEffect } = R;
  const h = R.createElement;
  styleOnce();

  /** 拉取任务列表；失败时抛出（由调用方显式呈现，绝不静默吞掉）。 */
  const fetchJobs = async (): Promise<ScheduledJob[]> => {
    const r = (await api("/jobs")) as { ok?: boolean; jobs?: ScheduledJob[]; error?: string };
    if (r?.ok === false) throw new Error(r.error ?? "host 返回失败");
    if (!Array.isArray(r?.jobs)) throw new Error("host 响应缺少 jobs 字段（插件可能未安装或版本不匹配）");
    return r.jobs;
  };

  /** host 健康探测：区分"没有任务"与"host 路由不可达"。 */
  const fetchHealth = async (): Promise<{ ok: boolean; version?: string; pending?: number; error?: string }> => {
    try {
      const r = (await api("/health")) as { ok?: boolean; version?: string; pending?: number; error?: string };
      if (r?.ok !== true) return { ok: false, error: r?.error ?? "host 未就绪" };
      return { ok: true, version: r.version, pending: r.pending };
    } catch (e) {
      return { ok: false, error: String((e as Error).message ?? e) };
    }
  };

  // ---------------------------------------------------------------------
  // 时:分:秒 选择器（受控）
  // ---------------------------------------------------------------------
  const ClockPicker: (p: {
    hh: number; mm: number; ss: number;
    setHh: (n: number) => void; setMm: (n: number) => void; setSs: (n: number) => void;
  }) => unknown = (p) => {
    const num = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
    const sel = (val: number, list: number[], set: (n: number) => void, label: string) =>
      h("select", {
        className: "dss-sel",
        value: String(val),
        "aria-label": label,
        onChange: (e: { target: { value: string } }) => set(Number(e.target.value)),
      }, list.map(n => h("option", { key: n, value: String(n) }, pad2(n))));
    return h("div", { className: "dss-clock" },
      sel(p.hh, num(0, 23), p.setHh, "小时"),
      h("span", { className: "sep" }, ":"),
      sel(p.mm, num(0, 59), p.setMm, "分钟"),
      h("span", { className: "sep" }, ":"),
      sel(p.ss, num(0, 59), p.setSs, "秒"),
    );
  };

  // ---------------------------------------------------------------------
  // 输入区标识 + 定时浮层（主入口）
  // ---------------------------------------------------------------------
  const InputBadge: (p: Record<string, unknown>) => unknown = (p) => {
    const pp = p as SessionSeatProps;

    // 内容来源 = DSH 输入框当前草稿（不额外提供文本输入框）。
    const useInputFn = typeof pp.useInput === "function"
      ? pp.useInput
      : ((_sel: (s: InputStateLike) => unknown): unknown => undefined);
    const draftRaw = useInputFn((s: InputStateLike) => s?.draft ?? "");
    const draft = typeof draftRaw === "string" ? draftRaw : "";
    // sessionId 由注册时的 inject 工厂位置参数注入（主路径），standard prop 兜底。
    const sessionId = String(pp.sessionId ?? "").trim();
    const setDraft = pp.inputActions?.setDraft;

    const now = new Date();
    const [open, setOpen] = useState(false);
    const [chipEl, setChipEl] = useState<HTMLElement | null>(null);
    const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);
    const [day, setDay] = useState(0); // 0=今天 1=明天
    const [hh, setHh] = useState(now.getHours());
    const [mm, setMm] = useState(now.getMinutes());
    const [ss, setSs] = useState(0);
    const [clearAfter, setClearAfter] = useState(true);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<{ msg: string; kind?: "ok" | "err" | "warn" } | null>(null);

    /** 打开浮层：把时分秒预置为"当前时刻 + 30 分钟"，并贴合标识定位到其上方。 */
    const openPop = (): void => {
      if (pp.locked) return;
      const base = new Date(Date.now() + 30 * 60000);
      setHh(base.getHours());
      setMm(base.getMinutes());
      setSs(0);
      setDay(0);
      setNotice(null);
      const el = chipEl;
      if (el && typeof window !== "undefined") {
        const r = el.getBoundingClientRect();
        setAnchor({
          left: Math.max(8, Math.min(r.left - 60, window.innerWidth - 308)),
          bottom: Math.max(8, window.innerHeight - r.top + 8),
        });
      } else {
        setAnchor({ left: 16, bottom: 96 });
      }
      setOpen(true);
    };

    // 时间规则：今天只可定"当前时刻之后"；明天可定 0–24 点。
    const fireAt = resolveAt(day, hh, mm, ss);
    const todayPast = day === 0 && fireAt <= Date.now();

    const doCreate = async (): Promise<void> => {
      const body = draft.trim();
      if (!sessionId) {
        setNotice({ msg: "未取到当前会话 id。请刷新页面重试；仍失败请把控制台 [scheduled-send] seat 发给开发者。", kind: "err" });
        return;
      }
      if (!body) { setNotice({ msg: "输入框为空：请先在输入框写下要定时发送的内容", kind: "warn" }); return; }
      if (fireAt <= Date.now()) {
        setNotice({ msg: "今天只能设置当前时刻之后的发送时间；该时刻已过，请改选「明天」", kind: "err" });
        return;
      }
      // 每会话上限预检（host 端同样强校验，这里先行给出友好提示）
      try {
        const current = await fetchJobs();
        const pendingCount = current.filter(j => j.sessionId === sessionId && j.status === "pending").length;
        if (pendingCount >= MAX_PENDING_PER_SESSION) {
          setNotice({ msg: `该会话最多可同时设置 ${MAX_PENDING_PER_SESSION} 个定时发送任务（当前已有 ${pendingCount} 个待触发），请先在设置中撤回或删除`, kind: "err" });
          return;
        }
      } catch { /* host 不可达时由下方 POST 的报错兜底 */ }
      setBusy(true);
      try {
        const r = (await api("/jobs", {
          method: "POST",
          body: JSON.stringify({ sessionId, text: body, fireAt, note: `取输入框草稿@${fmtClock(Date.now())}` }),
        })) as { ok: boolean; error?: string };
        if (!r.ok) {
          setNotice({ msg: r.error ?? "创建失败", kind: "err" });
        } else {
          if (clearAfter && typeof setDraft === "function") setDraft("");
          setNotice({ msg: `已安排 ${fmtTime(fireAt)} 发送${clearAfter ? "（输入框已清空）" : ""}`, kind: "ok" });
          window.setTimeout(() => setOpen(false), 800);
        }
      } catch (e) {
        const err = e as Error;
        setNotice({
          msg: err?.name === "AbortError"
            ? `创建超时：host 未在 ${Math.round(API_TIMEOUT_MS / 1000)} 秒内响应。请到「设置 → 定时发送」查看 host 状态后重试。`
            : "请求失败：" + String(err?.message ?? e),
          kind: "err",
        });
      }
      setBusy(false);
    };

    // 浮层打开时每秒心跳一次：让"还有多久"倒计时持续走动
    const [, setBeat] = useState(0);
    useEffect(() => {
      if (!open) return;
      const t = window.setInterval(() => setBeat(b => b + 1), 1000);
      return () => window.clearInterval(t);
    }, [open]);

    // 点击外部 / 滚动 / 缩放即关闭浮层
    useEffect(() => {
      if (!open) return;
      const onDoc = (e: MouseEvent): void => {
        const t = e.target as Node | null;
        if (chipEl && t && chipEl.contains(t)) return;
        const pop = typeof document !== "undefined" ? document.getElementById("dss-pop") : null;
        if (pop && t && pop.contains(t)) return;
        setOpen(false);
      };
      const onMove = (): void => setOpen(false);
      document.addEventListener("mousedown", onDoc);
      window.addEventListener("scroll", onMove, true);
      window.addEventListener("resize", onMove);
      return () => {
        document.removeEventListener("mousedown", onDoc);
        window.removeEventListener("scroll", onMove, true);
        window.removeEventListener("resize", onMove);
      };
    }, [open, chipEl]);

    const pop = open
      ? h("div", { id: "dss-pop", className: "dss-pop", style: anchor ?? { left: 16, bottom: 96 } },
          h("div", { className: "dss-pop-title" }, "⏰ 定时发送",
            h("span", { className: "sub" }, sessionId ? "目标：当前会话" : "无当前会话")),

          // 时间：时:分:秒 + 今天/明天（今天只可定当前之后，明天 0–24）
          h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
            h("div", { className: "dss-label" }, "发送时刻（时 / 分 / 秒）"),
            h(ClockPicker, {
              hh, mm, ss,
              setHh: (n: number) => { setHh(n); setNotice(null); },
              setMm: (n: number) => { setMm(n); setNotice(null); },
              setSs: (n: number) => { setSs(n); setNotice(null); },
            }),
            h("div", { className: "dss-day" },
              h("button", { type: "button", className: "dss-daybtn" + (day === 0 ? " on" : ""), onClick: () => { setDay(0); setNotice(null); } }, "今天"),
              h("button", { type: "button", className: "dss-daybtn" + (day === 1 ? " on" : ""), onClick: () => { setDay(1); setNotice(null); } }, "明天"),
              h("span", { className: "dss-label", style: { marginLeft: "auto" } },
                `${day === 0 ? "今天" : "明天"} ${fmtClock(fireAt)}（${countdown(fireAt)}）`),
            ),
            todayPast
              ? h("div", { className: "dss-warn" }, "该时刻已过：今天只可定当前时刻之后的时间，请改选「明天」。")
              : null,
          ),

          // 内容：直接取输入框草稿，只读预览
          h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
            h("div", { className: "dss-label" }, "发送内容（取当前输入框内容，无需重复填写）"),
            draft.trim()
              ? h("div", { className: "dss-preview" }, draft.trim())
              : h("div", { className: "dss-warn" }, "输入框为空 —— 请先在输入框写下要发送的内容，再回来定时。"),
          ),

          draft.trim() && typeof setDraft === "function"
            ? h("label", { className: "dss-check" },
                h("input", { type: "checkbox", checked: clearAfter, onChange: (e: { target: { checked: boolean } }) => setClearAfter(e.target.checked) }),
                "创建后清空输入框（避免误按回车立即发送）")
            : null,

          h("div", { className: "dss-actions", style: { justifyContent: "flex-end" } },
            h("button", { className: "dss-btn-ghost", onClick: () => setOpen(false) }, "取消"),
            h("button", { className: "dss-btn", disabled: busy, onClick: () => void doCreate() },
              busy ? "创建中…" : "创建定时发送")),

          notice
            ? h("div", { className: notice.kind === "err" ? "dss-err" : notice.kind === "warn" ? "dss-warn" : "dss-ok" }, notice.msg)
            : null,
        )
      : null;

    return h("span", { style: { display: "inline-flex", position: "relative" } },
      h("button", {
        type: "button",
        className: "dss-bchip" + (open ? " on" : ""),
        disabled: !!pp.locked,
        ref: (el: HTMLElement | null) => setChipEl(el),
        title: "把输入框里的内容定时发送（可选时:分:秒）",
        onClick: () => (open ? setOpen(false) : openPop()),
      }, "⏰", h("span", null, "定时")),
      pop,
    );
  };

  // ---------------------------------------------------------------------
  // 对话输入区「定时任务排队」dock（conversation.input.dock；样式对齐原生 QueueDock）
  // 展示当前会话的 pending 定时任务：每行前置「几点发送」，空则不渲染。
  // ---------------------------------------------------------------------
  const ScheduledDock: (p: Record<string, unknown>) => unknown = (p) => {
    const pp = p as { sessionId?: string };
    const sessionId = String(pp.sessionId ?? "").trim();
    const [jobs, setJobs] = useState<ScheduledJob[]>([]);
    const [tick, setTick] = useState(0);

    const refresh = (): void => {
      void fetchJobs().then(
        (rows) => setJobs(rows),
        () => { /* 静默：host 不可达时 dock 不显示也不打扰 */ },
      );
    };
    useEffect(() => {
      if (!sessionId) return;
      refresh();
      const t = window.setInterval(() => { setTick(t => t + 1); refresh(); }, 5000);
      return () => window.clearInterval(t);
    }, [sessionId]);

    // 仅当前会话的 pending 任务，按发送时刻排序
    const mine = jobs
      .filter(j => j.sessionId === sessionId && j.status === "pending")
      .sort((a, b) => a.fireAt - b.fireAt);
    if (mine.length === 0) return null;

    const cancel = (id: string) => void api("/jobs/cancel", { method: "POST", body: JSON.stringify({ id }) }).then(refresh);

    return h("div", { className: "dss-dock", "data-scheduled-dock": "" },
      h("div", { className: "dss-dock-head" },
        h("span", { className: "dss-dock-count" }, `⏰ 定时排队（${mine.length}）`)),
      h("ul", { className: "dss-dock-list" },
        mine.map(j =>
          h("li", { key: j.id, className: "dss-dock-row" },
            h("span", { className: "dss-dock-time", title: `发送时刻 ${fmtTime(j.fireAt)}` },
              `⏰ ${fmtClock(j.fireAt)} 发送`),
            h("span", { className: "dss-dock-preview", title: j.text },
              j.text.length > 80 ? j.text.slice(0, 80) + "…" : j.text),
            h("span", { className: "dss-dock-eta" }, countdown(j.fireAt)),
            h("span", { className: "dss-dock-actions" },
              h("button", {
                className: "dss-btn-ghost", style: { padding: "2px 8px", fontSize: 11 },
                onClick: () => { if (window.confirm(`撤回定时任务 ${j.id}？撤回后不再发送。`)) cancel(j.id); },
              }, "撤回"),
            ),
          ),
        ),
      ),
    );
  };

  // ---------------------------------------------------------------------
  // 任务列表（管理：放大查看 / 编辑 / 撤回 / 立即发 / 删除 / 打开会话）
  // ---------------------------------------------------------------------
  const JobList: (p: {
    jobs: ScheduledJob[];
    onChanged: () => void;
    openSession?: (id: string) => void;
    sessionMeta?: Record<string, SessionMetaRow>;
  }) => unknown = (p) => {
    const metaOf = (id: string): SessionMetaRow => p.sessionMeta?.[id] ?? {};
    // ⚠️ React hooks 必须全部在组件顶层、任何条件 return 之前（v0.7.2 修复 #310）：
    // v0.6.2 曾把 collapsed 的 useState 放在 `if (jobs.length===0) return` 之后——
    // 首帧 jobs=[] 只走 3 个 hook，数据到达后走 4 个 → "Rendered more hooks" 崩溃，
    // 被错误边界（v0.7.1）暴露为 #310。hooks 顺序固定：editingId, editText, viewJob, collapsed。
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editText, setEditText] = useState("");
    const [viewJob, setViewJob] = useState<ScheduledJob | null>(null);
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>({
      pending: false,
      sent: true,
      missed: true,
      cancelled: true,
    });

    const cancel = (id: string) => void api("/jobs/cancel", { method: "POST", body: JSON.stringify({ id }) }).then(p.onChanged);
    const remove = (id: string) => void api("/jobs/delete", { method: "POST", body: JSON.stringify({ id }) }).then(p.onChanged);
    const fireNow = (id: string) => void api("/jobs/fire", { method: "POST", body: JSON.stringify({ id }) }).then(p.onChanged);
    const saveEdit = (id: string, text: string) =>
      api("/jobs", { method: "POST", body: JSON.stringify({ id, text }) })
        .then(() => { setEditingId(null); p.onChanged(); })
        .catch(e => window.alert("保存失败：" + String((e as Error).message)));

    const btn = (label: string, onClick: () => void) =>
      h("button", { className: "dss-btn-ghost", onClick }, label);

    const jobActions = (j: ScheduledJob): unknown => {
      const openBtn = typeof p.openSession === "function"
        ? btn("打开会话", () => { try { (p.openSession as (id: string) => void)(j.sessionId); } catch (e) { window.alert("跳转失败：" + String((e as Error).message)); } })
        : btn("打开会话", () => window.alert("跳转不可用：sessions 服务未注入（见面板顶部提示与控制台 [scheduled-send] sessions 服务）"));
      if (j.status !== "pending") {
        return h("div", { style: { display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" } },
          btn("放大查看", () => setViewJob(j)),
          openBtn,
          btn("删除", () => { if (window.confirm("删除这条记录？")) remove(j.id); }));
      }
      if (editingId === j.id) {
        return h("div", { style: { display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap", alignItems: "flex-start" } },
          h("textarea", {
            className: "dss-input",
            style: { flex: 1, minWidth: 180, minHeight: 54, resize: "vertical", fontFamily: "inherit" },
            value: editText,
            onChange: (e: { target: { value: string } }) => setEditText(e.target.value),
          }),
          btn("保存", () => saveEdit(j.id, editText.trim())),
          btn("放弃", () => setEditingId(null)));
      }
      return h("div", { style: { display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" } },
        btn("放大查看", () => setViewJob(j)),
        btn("编辑内容", () => { setEditingId(j.id); setEditText(j.text); }),
        btn("立即发", () => fireNow(j.id)),
        btn("撤回", () => { if (window.confirm(`撤回定时任务 ${j.id}？撤回后不再发送。`)) cancel(j.id); }),
        openBtn);
    };

    // 放大查看弹层：完整内容（模态）
    const modal = viewJob
      ? h("div", { className: "dss-scrim", onClick: () => setViewJob(null) },
          h("div", { className: "dss-modal", onClick: (e: { stopPropagation: () => void }) => e.stopPropagation() },
            h("div", { className: "dss-pop-title" }, "📄 定时发送内容",
              h("span", { className: "sub" }, `${viewJob.status} · ${fmtTime(viewJob.fireAt)}`),
              h("span", { className: "dss-x", onClick: () => setViewJob(null), title: "关闭" }, "✕")),
            h("div", { className: "dss-modal-body" }, viewJob.text),
            h("div", { className: "dss-note" }, (() => {
              const m = metaOf(viewJob.sessionId);
              const bits = [`目标会话：${viewJob.sessionId}`];
              if (m.title) bits.push(`标题：${m.title}`);
              if (m.cwd) bits.push(`目录：${m.cwd}`);
              if (viewJob.note) bits.push(`备注：${viewJob.note}`);
              return bits.join(" · ");
            })())))
      : null;

    if (p.jobs.length === 0) return h("div", { className: "dss-empty" }, "暂无定时任务");
    // 注意：上面的空态 return 在全部 hooks 之后（hooks 已在组件顶层执行完），合法。

    // 按状态分组：待触发 / 已发送 / 失败 / 已撤回；已完成(sent/missed/cancelled)默认折叠
    const GROUP_LABEL: Record<string, string> = {
      pending: "待触发",
      sent: "已发送",
      missed: "失败",
      cancelled: "已撤回",
    };
    const doneKeys = ["sent", "missed", "cancelled"];

    const renderJob = (j: ScheduledJob): unknown =>
      h("div", { key: j.id, className: "dss-job" },
        h("span", { className: `dss-badge dss-${j.status}` }, GROUP_LABEL[j.status] ?? j.status),
        h("div", { className: "txt" },
          h("div", { className: "preview", title: j.text }, j.text),
          h("div", { className: "meta" },
            (() => {
              const m = metaOf(j.sessionId);
              const parts = [];
              if (m.title) parts.push({ key: "t", label: `📄 ${m.title}` });
              if (m.cwd) parts.push({ key: "d", label: `📁 ${m.cwd}` });
              parts.push({ key: "id", label: `🔗 ${j.sessionId}` });
              return parts.map(p2 => h("span", { key: p2.key, title: p2.label }, p2.label));
            })(),
            j.status === "pending"
              ? h("span", null, `计划 ${fmtTime(j.fireAt)} · ${countdown(j.fireAt)}`)
              : h("span", null, `触发 ${j.firedAt ? fmtTime(j.fireAt) : "—"}` + (j.error ? ` · ${j.error}` : "")),
          ),
          jobActions(j),
        ),
      );

    const groups: { key: string; label: string; jobs: ScheduledJob[] }[] = [
      { key: "pending", label: "待触发", jobs: p.jobs.filter(j => j.status === "pending") },
      { key: "sent", label: "已发送", jobs: p.jobs.filter(j => j.status === "sent") },
      { key: "missed", label: "失败", jobs: p.jobs.filter(j => j.status === "missed") },
      { key: "cancelled", label: "已撤回", jobs: p.jobs.filter(j => j.status === "cancelled") },
    ].map(g => ({ ...g, jobs: g.jobs.sort((a, b) => a.fireAt - b.fireAt) }));

    const stateTip = (g: { key: string; label: string; jobs: ScheduledJob[] }): string => {
      if (g.key === "pending") return countdown(g.jobs[0]?.fireAt ?? Date.now());
      return doneKeys.includes(g.key)
        ? "已完成（点击展开）"
        : "";
    };

    return h("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
      groups.filter(g => g.jobs.length > 0).map(g =>
        h("div", { key: g.key, className: "dss-group" },
          h("button", {
            type: "button",
            className: "dss-group-head",
            onClick: () => setCollapsed(prev => ({ ...prev, [g.key]: !prev[g.key] })),
          },
            h("span", { className: "dss-group-caret" }, collapsed[g.key] ? "▶" : "▼"),
            h("span", { className: "dss-group-label" }, `${GROUP_LABEL[g.key] ?? g.label}（${g.jobs.length}）`),
            h("span", { className: "dss-group-tip" }, collapsed[g.key] ? `${stateTip(g)}` : ""),
          ),
          !collapsed[g.key]
            ? h("div", { className: "dss-group-body" }, g.jobs.map(renderJob))
            : null,
        ),
      ),
      modal,
    );
  };

  // ---------------------------------------------------------------------
  // 设置面板 section：任务管理（新建已收敛到输入区浮层）
  // ---------------------------------------------------------------------
  const SettingsSection: (p: {
    close?: () => void;
    openSession?: (id: string) => void;
    useSessions?: (sel: (s: unknown) => unknown) => unknown;
    sessionsUnavailable?: boolean;
    sessionMeta?: Record<string, SessionMetaRow>;
  }) => unknown = (p) => {
    const [jobs, setJobs] = useState<ScheduledJob[]>([]);
    const [tick, setTick] = useState(0);
    const [loadErr, setLoadErr] = useState<string | null>(null);
    const [health, setHealth] = useState<{ ok: boolean; version?: string; pending?: number; error?: string } | null>(null);

    // 会话元数据（标题/cwd）来自 DSH useSessions 投影。
    // ⚠️ hooks 稳定性（v0.7.1 修复）：不可按 `typeof p.useSessions` 条件决定是否调用 hook——
    // standard props 就绪时序变化会让 hooks 数量跨渲染漂移 → "Rendered more hooks" → 被 SlotErrorBoundary
    // 吞成空白面板。这里改用无条件 useState（hook 数量恒定）+ 数据层容错：
    //  - p.sessionMeta 存在（由 entry 用 useSessions 在稳定 hook 层算出）→ 用之；
    //  - 缺失 → 空表降级（仍能显示任务列表，只是没有标题/cwd 列）。
    const [, setMetaTick] = useState(0);
    void setMetaTick;
    const sessionMeta = p.sessionMeta ?? ({} as Record<string, SessionMetaRow>);

    const refresh = (): void => {
      void fetchJobs().then(
        (rows) => { setJobs(rows); setLoadErr(null); },
        (e: unknown) => { setLoadErr(String((e as Error).message ?? e)); },
      );
      void fetchHealth().then(setHealth);
    };

    useEffect(() => {
      refresh();
      const t = window.setInterval(() => { setTick(tick + 1); refresh(); }, 5000);
      return () => window.clearInterval(t);
    }, [tick]);

    return h("div", { className: "dss-wrap", style: { padding: "4px 2px" } },
      h("div", null,
        h("div", { style: { fontSize: 15, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 } }, "⏰ 定时发送",
          h("span", { className: "dss-limit-tag" }, `每会话最多 ${MAX_PENDING_PER_SESSION} 个待触发`)),
        h("div", { className: "dss-note" },
          "在聊天输入框写好内容 → 点输入框右侧「⏰ 定时」→ 选今天(当前时刻之后)/明天 0–24 的时:分:秒即可。此处查看与管理全部定时任务（放大查看 / 编辑内容 / 撤回 / 立即发 / 打开会话 / 删除）。到点由 dsh 后台以排队方式投递，离开电脑也会准时触发；dsh 重启后未触发任务自动补投。"),
      ),
      health
        ? h("div", { className: health.ok ? "dss-note" : "dss-err" },
            health.ok
              ? `host 插件在线 · v${health.version ?? "?"} · 待触发 ${health.pending ?? 0} 条`
              : `host 插件不可达：${health.error ?? "未知原因"}（定时发送依赖 host 路由 /api/scheduled-send/*，请确认插件已安装并重启 dsh）`)
        : null,
      loadErr ? h("div", { className: "dss-err" }, `读取任务失败：${loadErr}`) : null,
      p.sessionsUnavailable
        ? h("div", { className: "dss-warn" },
            "⚠️「打开会话」不可用：客户端 sessions 服务未注入（插件 inject 未声明 sessions 或宿主未提供）。按钮将被隐藏；请确认插件为 0.6.1+ 并重启 dsh。控制台可看 [scheduled-send] sessions 服务 诊断。")
        : null,
      h("div", null,
        h("div", { className: "dss-label", style: { marginBottom: 8 } }, `任务列表（${jobs.length}）`),
        h(JobList, { jobs, onChanged: refresh, openSession: p.openSession, sessionMeta }),
      ),
      p.close ? h("div", { className: "dss-actions" },
        h("button", { className: "dss-btn-ghost", onClick: p.close }, "关闭设置面板"),
      ) : null,
    );
  };

  return { SettingsSection, InputBadge, ScheduledDock, JobList };
}

export type MainUI = ReturnType<typeof makeUI>;
