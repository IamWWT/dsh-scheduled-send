/**
 * Client UI hooks 稳定性回归测试（#310 防复发）。
 *
 * 0.8.0 起主页面是 TaskPage（列表空 → 有数据）。本测试用 jsdom + ErrorBoundary
 * 在同一 root 渲染两次，确保 hooks 数量不随数据变化；同时验证空态与任务行都能渲染。
 *
 * 运行：node test/ui-hooks-regression-test.mjs
 */
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert";
import { buildFallbackDirs, findPnpmPackage } from "../scripts/paths.mjs";
import { existsSync as __existsSync } from "node:fs";

const __TOOL_DIRS = buildFallbackDirs({ importMetaUrl: import.meta.url, envKeys: ["SS_TOOLS_DIR"] });
function resolveHarness() {
  for (const d of __TOOL_DIRS) {
    const h = d.replace(/[\\/]node_modules$/, "");
    if (__existsSync(h + "/vendor/schemastery")) return h;
  }
  return __TOOL_DIRS[0] || ".";
}
const HARNESS = resolveHarness();
const req = createRequire(join(HARNESS, "x.js"));

const { JSDOM } = req("jsdom");
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
for (const k of [
  "navigator", "Node", "HTMLElement", "Element", "Event", "CustomEvent",
  "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
]) {
  const value = window[k];
  if (value === undefined) continue;
  try { globalThis[k] = value; } catch {
    try { Object.defineProperty(globalThis, k, { value, configurable: true, writable: true }); } catch { /* 跳过 */ }
  }
}

const esbuild = req(findPnpmPackage("esbuild", __TOOL_DIRS) || "esbuild");
const work = mkdtempSync(join(tmpdir(), "dss-hooks-"));
const outfile = join(work, "ui.mjs");
await esbuild.build({
  entryPoints: [join(process.cwd(), "src/client/ui.ts")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  logLevel: "silent",
});
const { makeUI } = await import(pathToFileURL(outfile).href + "?t=" + Date.now());

const REACT_DOM_DIR = join(HARNESS, "node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom");
const React = req(join(REACT_DOM_DIR, "../react"));
const createRoot = req(join(REACT_DOM_DIR, "client.js")).createRoot;
const { createElement, act } = React;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ui = makeUI(
  { createElement: React.createElement, useState: React.useState, useEffect: React.useEffect },
  { createPortal: null, portalHost: () => null },
);

const task = {
  id: "schedule-1",
  title: "测试任务",
  prompt: "检查构建",
  sessionId: "sess-1",
  sessionTitle: "会话A",
  frequency: { kind: "every", seconds: 3600 },
  scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
  status: "active",
  notify: true,
  createdAt: Date.now(),
  lastExecution: { status: "success", at: Date.now(), durationMs: 1234, summary: "ok" },
};

let currentTasks = [];
globalThis.fetch = async (url) => {
  const path = String(url);
  if (path.includes("/health")) {
    return { status: 200, json: async () => ({ ok: true, version: "test", scheduleService: true, active: currentTasks.length, total: currentTasks.length }) };
  }
  return { status: 200, json: async () => ({ ok: true, version: "test", tasks: currentTasks, scheduleService: true }) };
};

const captured = { error: null };
class TestBoundary extends React.Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError(e) { captured.error = String(e?.message ?? e); return { failed: true }; }
  render() { return this.state.failed ? null : this.props.children; }
}

const root = createRoot(window.document.getElementById("root"));
const props = {
  openSession: () => {},
  sessionMeta: { "sess-1": { title: "会话A", cwd: "/tmp/a" } },
  workspaces: [{ workspaceId: "ws-1", title: "工作区", path: "/tmp/a" }],
};

// 捕获 TaskPage 的 5s 轮询回调；不真的等 5 秒。
let poll = null;
Object.defineProperty(window, "setInterval", { configurable: true, writable: true, value: (fn) => { poll = fn; return 1; } });
Object.defineProperty(window, "clearInterval", { configurable: true, writable: true, value: () => {} });
currentTasks = [];
await act(async () => {
  root.render(createElement(TestBoundary, null, createElement(ui.TaskPage, props)));
});
currentTasks = [task];
await act(async () => {
  root.render(createElement(TestBoundary, null, createElement(ui.TaskPage, props)));
});
if (typeof poll === "function") {
  await act(async () => { poll(); await new Promise(r => setTimeout(r, 50)); });
}

assert.equal(captured.error, null, `TaskPage 两次渲染（空→有）不应触发错误边界：${captured.error ?? "(无)"}`);
assert.ok(window.document.body.textContent.includes("测试任务"), "任务行应渲染出标题");

try { root.unmount(); } catch { /* 忽略 */ }

console.log("✔ TaskPage hooks 稳定性回归通过（空→有两次渲染，无 #310）");

// ── 0.10.1：输入框 dock 只展示一次性任务（周期任务常驻 dock 会让会话越开越乱） ──
// 每次挂载一个全新 root：ScheduledDock 的 useEffect 依赖 [sessionId]，同 root 重渲染不会重新拉取。
async function mountDock(tasks) {
  currentTasks = tasks;
  const host = window.document.createElement("div");
  window.document.body.appendChild(host);
  const dockRoot = createRoot(host);
  await act(async () => {
    dockRoot.render(createElement(ui.ScheduledDock, { sessionId: "sess-dock" }));
    await new Promise(r => setTimeout(r, 50));
  });
  return { host, dockRoot };
}

const periodicTask = {
  ...task,
  id: "schedule-periodic",
  title: "月报-月度总结",
  sessionId: "sess-dock",
  frequency: { kind: "cron", expression: "0 18 30 * *", timeZone: "Asia/Shanghai" },
};
const onceTask = {
  ...task,
  id: "schedule-once",
  title: "一次性提醒",
  sessionId: "sess-dock",
  frequency: { kind: "once", at: new Date(Date.now() + 600_000).toISOString() },
};

{
  const { host, dockRoot } = await mountDock([periodicTask]);
  assert.equal(host.querySelector("[data-scheduled-dock]"), null,
    "周期任务（cron）不得渲染到输入框 dock");
  assert.ok(!host.textContent.includes("月报-月度总结"), "周期任务标题不得出现在 dock");
  try { dockRoot.unmount(); } catch { /* 忽略 */ }
}

{
  const { host, dockRoot } = await mountDock([periodicTask, onceTask]);
  const dock = host.querySelector("[data-scheduled-dock]");
  assert.ok(dock !== null, "一次性任务（once）应渲染到输入框 dock");
  assert.ok(dock.textContent.includes("一次性提醒"), "dock 应展示一次性任务标题");
  assert.ok(!dock.textContent.includes("月报-月度总结"), "dock 不得混入周期任务");
  try { dockRoot.unmount(); } catch { /* 忽略 */ }
}

console.log("✔ 输入框 dock 过滤回归通过（一次性上 dock / 周期任务不上 dock）");
