// src/shared/constants.ts
var MAX_PENDING_PER_SESSION = 3;
var API_TIMEOUT_MS = 1e4;

// src/shared/session-meta.ts
function sessionMetaOf(snap) {
  const out = {};
  const byId = snap?.byId;
  if (!byId) return out;
  for (const [id, row] of Object.entries(byId)) {
    out[id] = {
      title: row?.displayTitle ?? row?.title ?? void 0,
      cwd: row?.cwd ?? void 0
    };
  }
  return out;
}

// src/client/ui.ts
function pad2(n) {
  return String(n).padStart(2, "0");
}
function fmtTime(ms) {
  const d = new Date(ms);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function fmtClock(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function countdown(ms) {
  const diff = ms - Date.now();
  if (diff <= 0) return "\u5DF2\u5230\u70B9";
  const s = Math.floor(diff / 1e3);
  const h = Math.floor(s / 3600);
  const m = Math.floor(s % 3600 / 60);
  const sec = s % 60;
  if (h > 0) return `${h}\u5C0F\u65F6${m}\u5206\u540E`;
  if (m > 0) return `${m}\u5206${sec}\u79D2\u540E`;
  return `${sec}\u79D2\u540E`;
}
function resolveAt(day, hh, mm, ss) {
  const d = /* @__PURE__ */ new Date();
  d.setDate(d.getDate() + day);
  d.setHours(hh, mm, ss, 0);
  return d.getTime();
}
var CSS = `
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
/* \u8F93\u5165\u533A\u6807\u8BC6\uFF08\u4E0E\u6A21\u578B\u6807\u8BC6\u540C\u4E00\u884C\uFF0C\u98CE\u683C\u4E0E\u539F\u751F\u63A7\u4EF6\u4E00\u81F4\uFF09 */
.dss-bchip{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 9px;border-radius:8px;border:0.5px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;cursor:pointer;user-select:none;white-space:nowrap;font-family:inherit}
.dss-bchip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dss-bchip.on{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-hover-accent)}
.dss-bchip:disabled{opacity:.45;cursor:not-allowed}
/* \u6D6E\u5C42\uFF1A\u9075\u5FAA ui-theme \u7ACB\u9762\u89C4\u8303\uFF08\u65E0\u8FB9\u6846 + elevation \u9634\u5F71\uFF09 */
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
/* \u653E\u5927\u67E5\u770B\u5F39\u5C42\uFF08\u6A21\u6001\uFF09 */
.dss-scrim{position:fixed;inset:0;z-index:100002;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;padding:24px}
.dss-modal{max-width:560px;width:100%;max-height:80vh;box-sizing:border-box;overflow:auto;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border:0;border-radius:12px;box-shadow:var(--dsw-elevation-prominent);padding:14px;display:flex;flex-direction:column;gap:10px;font-size:13px}
.dss-modal-body{white-space:pre-wrap;word-break:break-word;line-height:1.6;font-size:13px}
.dss-x{cursor:pointer;font-size:14px;line-height:1;opacity:.7;margin-left:auto;padding:2px 6px;border-radius:6px}
.dss-x:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover)}
.dss-limit-tag{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-state-warn-primary);border:0.5px solid var(--dsw-alias-state-warn-primary);border-radius:999px;padding:1px 8px}
/* \u5BF9\u8BDD\u8F93\u5165\u533A\u5B9A\u65F6\u6392\u961F dock\uFF08\u5BF9\u9F50\u539F\u751F QueueDock \u8BED\u4E49\uFF09 */
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
/* \u4EFB\u52A1\u5217\u8868\u6309\u72B6\u6001\u5206\u7EC4 */
.dss-group{display:flex;flex-direction:column;gap:6px}
.dss-group-head{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:transparent;border:0;border-bottom:0.5px solid var(--dsw-alias-border-l2);padding:6px 2px;cursor:pointer;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.dss-group-head:hover{color:var(--dsw-alias-brand-primary)}
.dss-group-caret{font-size:10px;color:var(--dsw-alias-label-secondary);width:12px}
.dss-group-label{font-weight:600}
.dss-group-tip{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);font-weight:400}
.dss-group-body{display:flex;flex-direction:column;gap:8px;padding-left:2px}
`;
var styleOnce = () => {
  if (typeof document === "undefined" || document.getElementById("dss-style")) return;
  const el = document.createElement("style");
  el.id = "dss-style";
  el.textContent = CSS;
  document.head.appendChild(el);
};
async function api(path, init) {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
  try {
    const r = await fetch(`/api/scheduled-send${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", ...init?.headers ?? {} }
    });
    return r.json();
  } finally {
    window.clearTimeout(timer);
  }
}
function makeUI(React, _ctx) {
  const R = React;
  const { useState, useEffect } = R;
  const h = R.createElement;
  styleOnce();
  const fetchJobs = async () => {
    const r = await api("/jobs");
    if (r?.ok === false) throw new Error(r.error ?? "host \u8FD4\u56DE\u5931\u8D25");
    if (!Array.isArray(r?.jobs)) throw new Error("host \u54CD\u5E94\u7F3A\u5C11 jobs \u5B57\u6BB5\uFF08\u63D2\u4EF6\u53EF\u80FD\u672A\u5B89\u88C5\u6216\u7248\u672C\u4E0D\u5339\u914D\uFF09");
    return r.jobs;
  };
  const fetchHealth = async () => {
    try {
      const r = await api("/health");
      if (r?.ok !== true) return { ok: false, error: r?.error ?? "host \u672A\u5C31\u7EEA" };
      return { ok: true, version: r.version, pending: r.pending };
    } catch (e) {
      return { ok: false, error: String(e.message ?? e) };
    }
  };
  const ClockPicker = (p) => {
    const num = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
    const sel = (val, list, set, label) => h("select", {
      className: "dss-sel",
      value: String(val),
      "aria-label": label,
      onChange: (e) => set(Number(e.target.value))
    }, list.map((n) => h("option", { key: n, value: String(n) }, pad2(n))));
    return h(
      "div",
      { className: "dss-clock" },
      sel(p.hh, num(0, 23), p.setHh, "\u5C0F\u65F6"),
      h("span", { className: "sep" }, ":"),
      sel(p.mm, num(0, 59), p.setMm, "\u5206\u949F"),
      h("span", { className: "sep" }, ":"),
      sel(p.ss, num(0, 59), p.setSs, "\u79D2")
    );
  };
  const InputBadge = (p) => {
    const pp = p;
    const useInputFn = typeof pp.useInput === "function" ? pp.useInput : ((_sel) => void 0);
    const draftRaw = useInputFn((s) => s?.draft ?? "");
    const draft = typeof draftRaw === "string" ? draftRaw : "";
    const sessionId = String(pp.sessionId ?? "").trim();
    const setDraft = pp.inputActions?.setDraft;
    const now = /* @__PURE__ */ new Date();
    const [open, setOpen] = useState(false);
    const [chipEl, setChipEl] = useState(null);
    const [anchor, setAnchor] = useState(null);
    const [day, setDay] = useState(0);
    const [hh, setHh] = useState(now.getHours());
    const [mm, setMm] = useState(now.getMinutes());
    const [ss, setSs] = useState(0);
    const [clearAfter, setClearAfter] = useState(true);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState(null);
    const openPop = () => {
      if (pp.locked) return;
      const base = new Date(Date.now() + 30 * 6e4);
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
          bottom: Math.max(8, window.innerHeight - r.top + 8)
        });
      } else {
        setAnchor({ left: 16, bottom: 96 });
      }
      setOpen(true);
    };
    const fireAt = resolveAt(day, hh, mm, ss);
    const todayPast = day === 0 && fireAt <= Date.now();
    const doCreate = async () => {
      const body = draft.trim();
      if (!sessionId) {
        setNotice({ msg: "\u672A\u53D6\u5230\u5F53\u524D\u4F1A\u8BDD id\u3002\u8BF7\u5237\u65B0\u9875\u9762\u91CD\u8BD5\uFF1B\u4ECD\u5931\u8D25\u8BF7\u628A\u63A7\u5236\u53F0 [scheduled-send] seat \u53D1\u7ED9\u5F00\u53D1\u8005\u3002", kind: "err" });
        return;
      }
      if (!body) {
        setNotice({ msg: "\u8F93\u5165\u6846\u4E3A\u7A7A\uFF1A\u8BF7\u5148\u5728\u8F93\u5165\u6846\u5199\u4E0B\u8981\u5B9A\u65F6\u53D1\u9001\u7684\u5185\u5BB9", kind: "warn" });
        return;
      }
      if (fireAt <= Date.now()) {
        setNotice({ msg: "\u4ECA\u5929\u53EA\u80FD\u8BBE\u7F6E\u5F53\u524D\u65F6\u523B\u4E4B\u540E\u7684\u53D1\u9001\u65F6\u95F4\uFF1B\u8BE5\u65F6\u523B\u5DF2\u8FC7\uFF0C\u8BF7\u6539\u9009\u300C\u660E\u5929\u300D", kind: "err" });
        return;
      }
      try {
        const current = await fetchJobs();
        const pendingCount = current.filter((j) => j.sessionId === sessionId && j.status === "pending").length;
        if (pendingCount >= MAX_PENDING_PER_SESSION) {
          setNotice({ msg: `\u8BE5\u4F1A\u8BDD\u6700\u591A\u53EF\u540C\u65F6\u8BBE\u7F6E ${MAX_PENDING_PER_SESSION} \u4E2A\u5B9A\u65F6\u53D1\u9001\u4EFB\u52A1\uFF08\u5F53\u524D\u5DF2\u6709 ${pendingCount} \u4E2A\u5F85\u89E6\u53D1\uFF09\uFF0C\u8BF7\u5148\u5728\u8BBE\u7F6E\u4E2D\u64A4\u56DE\u6216\u5220\u9664`, kind: "err" });
          return;
        }
      } catch {
      }
      setBusy(true);
      try {
        const r = await api("/jobs", {
          method: "POST",
          body: JSON.stringify({ sessionId, text: body, fireAt, note: `\u53D6\u8F93\u5165\u6846\u8349\u7A3F@${fmtClock(Date.now())}` })
        });
        if (!r.ok) {
          setNotice({ msg: r.error ?? "\u521B\u5EFA\u5931\u8D25", kind: "err" });
        } else {
          if (clearAfter && typeof setDraft === "function") setDraft("");
          setNotice({ msg: `\u5DF2\u5B89\u6392 ${fmtTime(fireAt)} \u53D1\u9001${clearAfter ? "\uFF08\u8F93\u5165\u6846\u5DF2\u6E05\u7A7A\uFF09" : ""}`, kind: "ok" });
          window.setTimeout(() => setOpen(false), 800);
        }
      } catch (e) {
        const err = e;
        setNotice({
          msg: err?.name === "AbortError" ? `\u521B\u5EFA\u8D85\u65F6\uFF1Ahost \u672A\u5728 ${Math.round(API_TIMEOUT_MS / 1e3)} \u79D2\u5185\u54CD\u5E94\u3002\u8BF7\u5230\u300C\u8BBE\u7F6E \u2192 \u5B9A\u65F6\u53D1\u9001\u300D\u67E5\u770B host \u72B6\u6001\u540E\u91CD\u8BD5\u3002` : "\u8BF7\u6C42\u5931\u8D25\uFF1A" + String(err?.message ?? e),
          kind: "err"
        });
      }
      setBusy(false);
    };
    const [, setBeat] = useState(0);
    useEffect(() => {
      if (!open) return;
      const t = window.setInterval(() => setBeat((b) => b + 1), 1e3);
      return () => window.clearInterval(t);
    }, [open]);
    useEffect(() => {
      if (!open) return;
      const onDoc = (e) => {
        const t = e.target;
        if (chipEl && t && chipEl.contains(t)) return;
        const pop2 = typeof document !== "undefined" ? document.getElementById("dss-pop") : null;
        if (pop2 && t && pop2.contains(t)) return;
        setOpen(false);
      };
      const onMove = () => setOpen(false);
      document.addEventListener("mousedown", onDoc);
      window.addEventListener("scroll", onMove, true);
      window.addEventListener("resize", onMove);
      return () => {
        document.removeEventListener("mousedown", onDoc);
        window.removeEventListener("scroll", onMove, true);
        window.removeEventListener("resize", onMove);
      };
    }, [open, chipEl]);
    const pop = open ? h(
      "div",
      { id: "dss-pop", className: "dss-pop", style: anchor ?? { left: 16, bottom: 96 } },
      h(
        "div",
        { className: "dss-pop-title" },
        "\u23F0 \u5B9A\u65F6\u53D1\u9001",
        h("span", { className: "sub" }, sessionId ? "\u76EE\u6807\uFF1A\u5F53\u524D\u4F1A\u8BDD" : "\u65E0\u5F53\u524D\u4F1A\u8BDD")
      ),
      // 时间：时:分:秒 + 今天/明天（今天只可定当前之后，明天 0–24）
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 6 } },
        h("div", { className: "dss-label" }, "\u53D1\u9001\u65F6\u523B\uFF08\u65F6 / \u5206 / \u79D2\uFF09"),
        h(ClockPicker, {
          hh,
          mm,
          ss,
          setHh: (n) => {
            setHh(n);
            setNotice(null);
          },
          setMm: (n) => {
            setMm(n);
            setNotice(null);
          },
          setSs: (n) => {
            setSs(n);
            setNotice(null);
          }
        }),
        h(
          "div",
          { className: "dss-day" },
          h("button", { type: "button", className: "dss-daybtn" + (day === 0 ? " on" : ""), onClick: () => {
            setDay(0);
            setNotice(null);
          } }, "\u4ECA\u5929"),
          h("button", { type: "button", className: "dss-daybtn" + (day === 1 ? " on" : ""), onClick: () => {
            setDay(1);
            setNotice(null);
          } }, "\u660E\u5929"),
          h(
            "span",
            { className: "dss-label", style: { marginLeft: "auto" } },
            `${day === 0 ? "\u4ECA\u5929" : "\u660E\u5929"} ${fmtClock(fireAt)}\uFF08${countdown(fireAt)}\uFF09`
          )
        ),
        todayPast ? h("div", { className: "dss-warn" }, "\u8BE5\u65F6\u523B\u5DF2\u8FC7\uFF1A\u4ECA\u5929\u53EA\u53EF\u5B9A\u5F53\u524D\u65F6\u523B\u4E4B\u540E\u7684\u65F6\u95F4\uFF0C\u8BF7\u6539\u9009\u300C\u660E\u5929\u300D\u3002") : null
      ),
      // 内容：直接取输入框草稿，只读预览
      h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 6 } },
        h("div", { className: "dss-label" }, "\u53D1\u9001\u5185\u5BB9\uFF08\u53D6\u5F53\u524D\u8F93\u5165\u6846\u5185\u5BB9\uFF0C\u65E0\u9700\u91CD\u590D\u586B\u5199\uFF09"),
        draft.trim() ? h("div", { className: "dss-preview" }, draft.trim()) : h("div", { className: "dss-warn" }, "\u8F93\u5165\u6846\u4E3A\u7A7A \u2014\u2014 \u8BF7\u5148\u5728\u8F93\u5165\u6846\u5199\u4E0B\u8981\u53D1\u9001\u7684\u5185\u5BB9\uFF0C\u518D\u56DE\u6765\u5B9A\u65F6\u3002")
      ),
      draft.trim() && typeof setDraft === "function" ? h(
        "label",
        { className: "dss-check" },
        h("input", { type: "checkbox", checked: clearAfter, onChange: (e) => setClearAfter(e.target.checked) }),
        "\u521B\u5EFA\u540E\u6E05\u7A7A\u8F93\u5165\u6846\uFF08\u907F\u514D\u8BEF\u6309\u56DE\u8F66\u7ACB\u5373\u53D1\u9001\uFF09"
      ) : null,
      h(
        "div",
        { className: "dss-actions", style: { justifyContent: "flex-end" } },
        h("button", { className: "dss-btn-ghost", onClick: () => setOpen(false) }, "\u53D6\u6D88"),
        h(
          "button",
          { className: "dss-btn", disabled: busy, onClick: () => void doCreate() },
          busy ? "\u521B\u5EFA\u4E2D\u2026" : "\u521B\u5EFA\u5B9A\u65F6\u53D1\u9001"
        )
      ),
      notice ? h("div", { className: notice.kind === "err" ? "dss-err" : notice.kind === "warn" ? "dss-warn" : "dss-ok" }, notice.msg) : null
    ) : null;
    return h(
      "span",
      { style: { display: "inline-flex", position: "relative" } },
      h("button", {
        type: "button",
        className: "dss-bchip" + (open ? " on" : ""),
        disabled: !!pp.locked,
        ref: (el) => setChipEl(el),
        title: "\u628A\u8F93\u5165\u6846\u91CC\u7684\u5185\u5BB9\u5B9A\u65F6\u53D1\u9001\uFF08\u53EF\u9009\u65F6:\u5206:\u79D2\uFF09",
        onClick: () => open ? setOpen(false) : openPop()
      }, "\u23F0", h("span", null, "\u5B9A\u65F6")),
      pop
    );
  };
  const ScheduledDock = (p) => {
    const pp = p;
    const sessionId = String(pp.sessionId ?? "").trim();
    const [jobs, setJobs] = useState([]);
    const [tick, setTick] = useState(0);
    const refresh = () => {
      void fetchJobs().then(
        (rows) => setJobs(rows),
        () => {
        }
      );
    };
    useEffect(() => {
      if (!sessionId) return;
      refresh();
      const t = window.setInterval(() => {
        setTick((t2) => t2 + 1);
        refresh();
      }, 5e3);
      return () => window.clearInterval(t);
    }, [sessionId]);
    const mine = jobs.filter((j) => j.sessionId === sessionId && j.status === "pending").sort((a, b) => a.fireAt - b.fireAt);
    if (mine.length === 0) return null;
    const cancel = (id) => void api("/jobs/cancel", { method: "POST", body: JSON.stringify({ id }) }).then(refresh);
    return h(
      "div",
      { className: "dss-dock", "data-scheduled-dock": "" },
      h(
        "div",
        { className: "dss-dock-head" },
        h("span", { className: "dss-dock-count" }, `\u23F0 \u5B9A\u65F6\u6392\u961F\uFF08${mine.length}\uFF09`)
      ),
      h(
        "ul",
        { className: "dss-dock-list" },
        mine.map(
          (j) => h(
            "li",
            { key: j.id, className: "dss-dock-row" },
            h(
              "span",
              { className: "dss-dock-time", title: `\u53D1\u9001\u65F6\u523B ${fmtTime(j.fireAt)}` },
              `\u23F0 ${fmtClock(j.fireAt)} \u53D1\u9001`
            ),
            h(
              "span",
              { className: "dss-dock-preview", title: j.text },
              j.text.length > 80 ? j.text.slice(0, 80) + "\u2026" : j.text
            ),
            h("span", { className: "dss-dock-eta" }, countdown(j.fireAt)),
            h(
              "span",
              { className: "dss-dock-actions" },
              h("button", {
                className: "dss-btn-ghost",
                style: { padding: "2px 8px", fontSize: 11 },
                onClick: () => {
                  if (window.confirm(`\u64A4\u56DE\u5B9A\u65F6\u4EFB\u52A1 ${j.id}\uFF1F\u64A4\u56DE\u540E\u4E0D\u518D\u53D1\u9001\u3002`)) cancel(j.id);
                }
              }, "\u64A4\u56DE")
            )
          )
        )
      )
    );
  };
  const JobList = (p) => {
    const metaOf = (id) => p.sessionMeta?.[id] ?? {};
    const [editingId, setEditingId] = useState(null);
    const [editText, setEditText] = useState("");
    const [viewJob, setViewJob] = useState(null);
    const cancel = (id) => void api("/jobs/cancel", { method: "POST", body: JSON.stringify({ id }) }).then(p.onChanged);
    const remove = (id) => void api("/jobs/delete", { method: "POST", body: JSON.stringify({ id }) }).then(p.onChanged);
    const fireNow = (id) => void api("/jobs/fire", { method: "POST", body: JSON.stringify({ id }) }).then(p.onChanged);
    const saveEdit = (id, text) => api("/jobs", { method: "POST", body: JSON.stringify({ id, text }) }).then(() => {
      setEditingId(null);
      p.onChanged();
    }).catch((e) => window.alert("\u4FDD\u5B58\u5931\u8D25\uFF1A" + String(e.message)));
    const btn = (label, onClick) => h("button", { className: "dss-btn-ghost", onClick }, label);
    const jobActions = (j) => {
      const openBtn = typeof p.openSession === "function" ? btn("\u6253\u5F00\u4F1A\u8BDD", () => {
        try {
          p.openSession(j.sessionId);
        } catch (e) {
          window.alert("\u8DF3\u8F6C\u5931\u8D25\uFF1A" + String(e.message));
        }
      }) : btn("\u6253\u5F00\u4F1A\u8BDD", () => window.alert("\u8DF3\u8F6C\u4E0D\u53EF\u7528\uFF1Asessions \u670D\u52A1\u672A\u6CE8\u5165\uFF08\u89C1\u9762\u677F\u9876\u90E8\u63D0\u793A\u4E0E\u63A7\u5236\u53F0 [scheduled-send] sessions \u670D\u52A1\uFF09"));
      if (j.status !== "pending") {
        return h(
          "div",
          { style: { display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" } },
          btn("\u653E\u5927\u67E5\u770B", () => setViewJob(j)),
          openBtn,
          btn("\u5220\u9664", () => {
            if (window.confirm("\u5220\u9664\u8FD9\u6761\u8BB0\u5F55\uFF1F")) remove(j.id);
          })
        );
      }
      if (editingId === j.id) {
        return h(
          "div",
          { style: { display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap", alignItems: "flex-start" } },
          h("textarea", {
            className: "dss-input",
            style: { flex: 1, minWidth: 180, minHeight: 54, resize: "vertical", fontFamily: "inherit" },
            value: editText,
            onChange: (e) => setEditText(e.target.value)
          }),
          btn("\u4FDD\u5B58", () => saveEdit(j.id, editText.trim())),
          btn("\u653E\u5F03", () => setEditingId(null))
        );
      }
      return h(
        "div",
        { style: { display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" } },
        btn("\u653E\u5927\u67E5\u770B", () => setViewJob(j)),
        btn("\u7F16\u8F91\u5185\u5BB9", () => {
          setEditingId(j.id);
          setEditText(j.text);
        }),
        btn("\u7ACB\u5373\u53D1", () => fireNow(j.id)),
        btn("\u64A4\u56DE", () => {
          if (window.confirm(`\u64A4\u56DE\u5B9A\u65F6\u4EFB\u52A1 ${j.id}\uFF1F\u64A4\u56DE\u540E\u4E0D\u518D\u53D1\u9001\u3002`)) cancel(j.id);
        }),
        openBtn
      );
    };
    const modal = viewJob ? h(
      "div",
      { className: "dss-scrim", onClick: () => setViewJob(null) },
      h(
        "div",
        { className: "dss-modal", onClick: (e) => e.stopPropagation() },
        h(
          "div",
          { className: "dss-pop-title" },
          "\u{1F4C4} \u5B9A\u65F6\u53D1\u9001\u5185\u5BB9",
          h("span", { className: "sub" }, `${viewJob.status} \xB7 ${fmtTime(viewJob.fireAt)}`),
          h("span", { className: "dss-x", onClick: () => setViewJob(null), title: "\u5173\u95ED" }, "\u2715")
        ),
        h("div", { className: "dss-modal-body" }, viewJob.text),
        h("div", { className: "dss-note" }, (() => {
          const m = metaOf(viewJob.sessionId);
          const bits = [`\u76EE\u6807\u4F1A\u8BDD\uFF1A${viewJob.sessionId}`];
          if (m.title) bits.push(`\u6807\u9898\uFF1A${m.title}`);
          if (m.cwd) bits.push(`\u76EE\u5F55\uFF1A${m.cwd}`);
          if (viewJob.note) bits.push(`\u5907\u6CE8\uFF1A${viewJob.note}`);
          return bits.join(" \xB7 ");
        })())
      )
    ) : null;
    if (p.jobs.length === 0) return h("div", { className: "dss-empty" }, "\u6682\u65E0\u5B9A\u65F6\u4EFB\u52A1");
    const GROUP_LABEL = {
      pending: "\u5F85\u89E6\u53D1",
      sent: "\u5DF2\u53D1\u9001",
      missed: "\u5931\u8D25",
      cancelled: "\u5DF2\u64A4\u56DE"
    };
    const doneKeys = ["sent", "missed", "cancelled"];
    const [collapsed, setCollapsed] = useState({
      pending: false,
      sent: true,
      missed: true,
      cancelled: true
    });
    const renderJob = (j) => h(
      "div",
      { key: j.id, className: "dss-job" },
      h("span", { className: `dss-badge dss-${j.status}` }, GROUP_LABEL[j.status] ?? j.status),
      h(
        "div",
        { className: "txt" },
        h("div", { className: "preview", title: j.text }, j.text),
        h(
          "div",
          { className: "meta" },
          (() => {
            const m = metaOf(j.sessionId);
            const parts = [];
            if (m.title) parts.push({ key: "t", label: `\u{1F4C4} ${m.title}` });
            if (m.cwd) parts.push({ key: "d", label: `\u{1F4C1} ${m.cwd}` });
            parts.push({ key: "id", label: `\u{1F517} ${j.sessionId}` });
            return parts.map((p2) => h("span", { key: p2.key, title: p2.label }, p2.label));
          })(),
          j.status === "pending" ? h("span", null, `\u8BA1\u5212 ${fmtTime(j.fireAt)} \xB7 ${countdown(j.fireAt)}`) : h("span", null, `\u89E6\u53D1 ${j.firedAt ? fmtTime(j.fireAt) : "\u2014"}` + (j.error ? ` \xB7 ${j.error}` : ""))
        ),
        jobActions(j)
      )
    );
    const groups = [
      { key: "pending", label: "\u5F85\u89E6\u53D1", jobs: p.jobs.filter((j) => j.status === "pending") },
      { key: "sent", label: "\u5DF2\u53D1\u9001", jobs: p.jobs.filter((j) => j.status === "sent") },
      { key: "missed", label: "\u5931\u8D25", jobs: p.jobs.filter((j) => j.status === "missed") },
      { key: "cancelled", label: "\u5DF2\u64A4\u56DE", jobs: p.jobs.filter((j) => j.status === "cancelled") }
    ].map((g) => ({ ...g, jobs: g.jobs.sort((a, b) => a.fireAt - b.fireAt) }));
    const stateTip = (g) => {
      if (g.key === "pending") return countdown(g.jobs[0]?.fireAt ?? Date.now());
      return doneKeys.includes(g.key) ? "\u5DF2\u5B8C\u6210\uFF08\u70B9\u51FB\u5C55\u5F00\uFF09" : "";
    };
    return h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: 10 } },
      groups.filter((g) => g.jobs.length > 0).map(
        (g) => h(
          "div",
          { key: g.key, className: "dss-group" },
          h(
            "button",
            {
              type: "button",
              className: "dss-group-head",
              onClick: () => setCollapsed((prev) => ({ ...prev, [g.key]: !prev[g.key] }))
            },
            h("span", { className: "dss-group-caret" }, collapsed[g.key] ? "\u25B6" : "\u25BC"),
            h("span", { className: "dss-group-label" }, `${GROUP_LABEL[g.key] ?? g.label}\uFF08${g.jobs.length}\uFF09`),
            h("span", { className: "dss-group-tip" }, collapsed[g.key] ? `${stateTip(g)}` : "")
          ),
          !collapsed[g.key] ? h("div", { className: "dss-group-body" }, g.jobs.map(renderJob)) : null
        )
      ),
      modal
    );
  };
  const SettingsSection = (p) => {
    const [jobs, setJobs] = useState([]);
    const [tick, setTick] = useState(0);
    const [loadErr, setLoadErr] = useState(null);
    const [health, setHealth] = useState(null);
    const useSess = typeof p.useSessions === "function" ? p.useSessions : ((_sel) => void 0);
    const sessionsSnap = useSess((s) => s);
    const sessionMeta = sessionMetaOf(sessionsSnap);
    const refresh = () => {
      void fetchJobs().then(
        (rows) => {
          setJobs(rows);
          setLoadErr(null);
        },
        (e) => {
          setLoadErr(String(e.message ?? e));
        }
      );
      void fetchHealth().then(setHealth);
    };
    useEffect(() => {
      refresh();
      const t = window.setInterval(() => {
        setTick(tick + 1);
        refresh();
      }, 5e3);
      return () => window.clearInterval(t);
    }, [tick]);
    return h(
      "div",
      { className: "dss-wrap", style: { padding: "4px 2px" } },
      h(
        "div",
        null,
        h(
          "div",
          { style: { fontSize: 15, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 } },
          "\u23F0 \u5B9A\u65F6\u53D1\u9001",
          h("span", { className: "dss-limit-tag" }, `\u6BCF\u4F1A\u8BDD\u6700\u591A ${MAX_PENDING_PER_SESSION} \u4E2A\u5F85\u89E6\u53D1`)
        ),
        h(
          "div",
          { className: "dss-note" },
          "\u5728\u804A\u5929\u8F93\u5165\u6846\u5199\u597D\u5185\u5BB9 \u2192 \u70B9\u8F93\u5165\u6846\u53F3\u4FA7\u300C\u23F0 \u5B9A\u65F6\u300D\u2192 \u9009\u4ECA\u5929(\u5F53\u524D\u65F6\u523B\u4E4B\u540E)/\u660E\u5929 0\u201324 \u7684\u65F6:\u5206:\u79D2\u5373\u53EF\u3002\u6B64\u5904\u67E5\u770B\u4E0E\u7BA1\u7406\u5168\u90E8\u5B9A\u65F6\u4EFB\u52A1\uFF08\u653E\u5927\u67E5\u770B / \u7F16\u8F91\u5185\u5BB9 / \u64A4\u56DE / \u7ACB\u5373\u53D1 / \u6253\u5F00\u4F1A\u8BDD / \u5220\u9664\uFF09\u3002\u5230\u70B9\u7531 dsh \u540E\u53F0\u4EE5\u6392\u961F\u65B9\u5F0F\u6295\u9012\uFF0C\u79BB\u5F00\u7535\u8111\u4E5F\u4F1A\u51C6\u65F6\u89E6\u53D1\uFF1Bdsh \u91CD\u542F\u540E\u672A\u89E6\u53D1\u4EFB\u52A1\u81EA\u52A8\u8865\u6295\u3002"
        )
      ),
      health ? h(
        "div",
        { className: health.ok ? "dss-note" : "dss-err" },
        health.ok ? `host \u63D2\u4EF6\u5728\u7EBF \xB7 v${health.version ?? "?"} \xB7 \u5F85\u89E6\u53D1 ${health.pending ?? 0} \u6761` : `host \u63D2\u4EF6\u4E0D\u53EF\u8FBE\uFF1A${health.error ?? "\u672A\u77E5\u539F\u56E0"}\uFF08\u5B9A\u65F6\u53D1\u9001\u4F9D\u8D56 host \u8DEF\u7531 /api/scheduled-send/*\uFF0C\u8BF7\u786E\u8BA4\u63D2\u4EF6\u5DF2\u5B89\u88C5\u5E76\u91CD\u542F dsh\uFF09`
      ) : null,
      loadErr ? h("div", { className: "dss-err" }, `\u8BFB\u53D6\u4EFB\u52A1\u5931\u8D25\uFF1A${loadErr}`) : null,
      p.sessionsUnavailable ? h(
        "div",
        { className: "dss-warn" },
        "\u26A0\uFE0F\u300C\u6253\u5F00\u4F1A\u8BDD\u300D\u4E0D\u53EF\u7528\uFF1A\u5BA2\u6237\u7AEF sessions \u670D\u52A1\u672A\u6CE8\u5165\uFF08\u63D2\u4EF6 inject \u672A\u58F0\u660E sessions \u6216\u5BBF\u4E3B\u672A\u63D0\u4F9B\uFF09\u3002\u6309\u94AE\u5C06\u88AB\u9690\u85CF\uFF1B\u8BF7\u786E\u8BA4\u63D2\u4EF6\u4E3A 0.6.1+ \u5E76\u91CD\u542F dsh\u3002\u63A7\u5236\u53F0\u53EF\u770B [scheduled-send] sessions \u670D\u52A1 \u8BCA\u65AD\u3002"
      ) : null,
      h(
        "div",
        null,
        h("div", { className: "dss-label", style: { marginBottom: 8 } }, `\u4EFB\u52A1\u5217\u8868\uFF08${jobs.length}\uFF09`),
        h(JobList, { jobs, onChanged: refresh, openSession: p.openSession, sessionMeta })
      ),
      p.close ? h(
        "div",
        { className: "dss-actions" },
        h("button", { className: "dss-btn-ghost", onClick: p.close }, "\u5173\u95ED\u8BBE\u7F6E\u9762\u677F")
      ) : null
    );
  };
  return { SettingsSection, InputBadge, ScheduledDock };
}
export {
  makeUI
};
