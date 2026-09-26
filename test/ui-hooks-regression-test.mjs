/**
 * Client UI hooks 稳定性回归测试（#310 防复发）。
 *
 * 背景：v0.6.2 曾把 `useState(collapsed)` 放在 `if (jobs.length===0) return` 之后，
 * 导致 jobs 为空（首帧）走 3 个 hook、有数据后走 4 个 → React "Rendered more hooks
 * than during the previous render"（错误码 #310）→ 被 SlotErrorBoundary 吞成空白面板。
 *
 * 为什么之前测不出：smoke/routes 是纯 Node 不渲染 React；SSR 每次独立渲染不触发
 * 同一 root 的状态漂移。本测试用 react-dom/client + **ErrorBoundary**（React 捕获
 * 渲染期异常的权威机制，与 act 是否重抛无关）在 jsdom 里渲染同一 JobList 两次
 * （jobs=[] → jobs=[...]），边界捕获到 #310 即失败。
 *
 * 运行：node test/ui-hooks-regression-test.mjs（pnpm test 会一并执行）
 */
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert";

// --- 跨平台路径解析（codemod 注入；不含机器专属绝对路径）---
import { buildFallbackDirs, findPnpmPackage } from "../scripts/paths.mjs";
import { existsSync as __existsSync } from "node:fs";
const __TOOL_DIRS = buildFallbackDirs({ importMetaUrl: import.meta.url, envKeys: ["SS_TOOLS_DIR"] });
const TOOL_ANCHOR = (__TOOL_DIRS[0] || ".") + "/x.js";
function resolveHarness() {
  for (const d of __TOOL_DIRS) {
    const h = d.replace(/[\\/]node_modules$/, "");
    if (__existsSync(h + "/vendor/schemastery")) return h;
  }
  return __TOOL_DIRS[0] || ".";
}


const HARNESS = resolveHarness();
const req = createRequire(join(HARNESS, "x.js"));

// ---- 1. jsdom 环境（react-dom/client 渲染需要 DOM）------------------------
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
  try { globalThis[k] = value; }
  catch {
    try { Object.defineProperty(globalThis, k, { value, configurable: true, writable: true }); }
    catch { /* 只读且不可覆盖时跳过（如 navigator） */ }
  }
}

// ---- 2. 编译 ui.ts（不引入 react，由 makeUI 参数注入）----------------------
// esbuild 由 harness 以 pnpm 安装；动态定位（不写死机器路径/版本）
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

// ---- 3. react + react-dom/client（同一实例）------------------------------
const REACT_DOM_DIR = join(HARNESS, "node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom");
const React = req(join(REACT_DOM_DIR, "../react"));
const createRoot = req(join(REACT_DOM_DIR, "client.js")).createRoot;
const { createElement, act } = React;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ui = makeUI(
  {
    createElement: React.createElement,
    useState: React.useState,
    useEffect: React.useEffect,
  },
  { createPortal: null, portalHost: () => null },
);

const job = {
  id: "job-1",
  sessionId: "sess-1",
  text: "测试任务内容",
  fireAt: Date.now() + 3600_000,
  status: "pending",
  createdAt: Date.now(),
};

// ---- 4. ErrorBoundary 确定性捕获渲染期错误（含 #310）----------------------
const captured = { error: null };
class TestBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError(e) {
    captured.error = String(e?.message ?? e);
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

const root = createRoot(window.document.getElementById("root"));
const renderProps = (jobs) => ({
  jobs,
  onChanged: () => {},
  openSession: () => {},
  sessionMeta: { "sess-1": { title: "会话A", cwd: "/tmp/a" } },
});

// 第一次渲染：jobs=[]（首帧走"暂无定时任务"路径）
await act(async () => {
  root.render(createElement(TestBoundary, null,
    createElement(ui.JobList, renderProps([]))));
});
// 第二次渲染：jobs 有数据（走分组路径）——hooks 数量漂移时边界必捕获 #310
await act(async () => {
  root.render(createElement(TestBoundary, null,
    createElement(ui.JobList, renderProps([job]))));
});

// 卸载清理
try { root.unmount(); } catch { /* 忽略 */ }

assert.equal(
  captured.error,
  null,
  `JobList 两次渲染（空→有）不应触发错误边界，实际捕获: ${captured.error ?? "(无)"}`,
);
console.log("✔ JobList hooks 稳定性回归通过（jobs 空→有两次渲染，无 #310）");