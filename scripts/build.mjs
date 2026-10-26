/**
 * dsh-scheduled-send 构建脚本：
 *   Host   → lib/index.js（Node ESM；node:* 与 @deepseek-ai/* external）
 *   Client → lib/client.js（浏览器 IIFE，经 window.__ModuleLoader__ 注册）
 * 用法：node scripts/build.mjs [--no-typecheck]
 *
 * v0.6.0 增加「产物门禁」：构建完成后必须通过
 *   - 顶层布局卫生（禁止旧扁平布局/错误软链残留，否则污染 link 安装）
 *   - lib/ 双产物存在且可被实际加载（host 动态 import 断言导出；client 检查 ModuleLoader 注册）
 * 任一不过 → 构建失败（exit 1）。目的：根因防复发——缺 lib/ 的坏目录在装进
 * profile 之前就被拦下，而不是装完才在 loader 启动时 ERR_MODULE_NOT_FOUND。
 */
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { buildFallbackDirs, findTsc, findTypeRoots } from "./paths.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
// 跨平台工具目录解析：env 覆盖 → 同级 harness → DSH home profile（无机器专属绝对路径）
const FALLBACK_DIRS = buildFallbackDirs({
  importMetaUrl: import.meta.url,
  envKeys: ["PWB_TOOLS_DIR"],
});

function loadTool(name) {
  const anchors = [
    here + "/x.js",
    root + "/x.js",
    ...FALLBACK_DIRS.map((d) => (d.endsWith("node_modules") ? d + "/x.js" : d + "/node_modules/x.js")),
  ];
  for (const a of anchors) {
    try { return createRequire(a)(name); } catch { /* 下一个锚点 */ }
  }
  if (name === "esbuild") {
    for (const d of FALLBACK_DIRS) {
      const pnpm = d.replace(/node_modules$/, "") + "node_modules/.pnpm";
      if (!existsSync(pnpm)) continue;
      for (const dir of readdirSync(pnpm).filter((x) => x.startsWith("esbuild@")).sort().reverse()) {
        const p = `${pnpm}/${dir}/node_modules/esbuild`;
        try { return createRequire(p + "/x.js")(p); } catch { /* 下一版本 */ }
      }
    }
  }
  throw new Error(`找不到 ${name}（可设 PWB_TOOLS_DIR 指向含 esbuild/typescript 的 node_modules）`);
}

const fail = (msg) => {
  console.error(`[gate] ✗ ${msg}`);
  process.exit(1);
};

/** 顶层布局卫生：源码目录不允许出现会污染安装的残留；node_modules 必须自持且为真目录。 */
function checkLayoutHygiene() {
  const forbidden = [
    { path: root + "/index.ts", why: "顶层 index.ts（旧扁平布局残留；正确位置是 src/index.ts）" },
    { path: root + "/client.js", why: "顶层 client.js（旧扁平布局残留；正确位置是 lib/）" },
    { path: root + "/build.mjs", why: "顶层 build.mjs（旧扁平布局残留；正确位置是 scripts/）" },
    { path: root + "/client", why: "顶层 client/ 目录残留（旧扁平布局）" },
    { path: root + "/host", why: "顶层 host/ 目录残留（旧扁平布局）" },
    // 2026-09-23：本插件改为 tgz 安装 + 自持依赖（不再 link 安装、不再借外部 node_modules）。
    // 保留对“借外部依赖”的禁止：软链 node_modules / node_modules_types 都视为违规。
    { path: root + "/node_modules_types", why: "旧做法：借外部 @types 目录（本插件依赖已自持，禁止再指向别的插件/profile）" },
  ];
  const bad = forbidden.filter((f) => existsSync(f.path));
  for (const f of bad) {
    let kind = "文件/目录";
    try { if (statSync(f.path).isSymbolicLink()) kind = "软链"; } catch { /* 忽略 */ }
    console.error(`[gate] ✗ 顶层布局卫生：发现${kind} ${f.path}`);
    console.error(`      ${f.why}`);
  }
  // node_modules 允许存在（构建期本地依赖），但**禁止软链**——软链意味着依赖别的插件目录。
  // 允许 tsconfig 指向 profile/harness 提供的**平台侧**依赖（react/@types 本由运行时提供）；
  // 禁止的是「插件之间相互依赖」（曾把 @types 指到另一个插件目录，该插件改名后本插件 check 与安装脚本双双失效）。
  const nm = root + "/node_modules";
  if (existsSync(nm)) {
    let isLink = false;
    try { isLink = statSync(nm).isSymbolicLink(); } catch { /* 忽略 */ }
    if (isLink) {
      bad.push({ path: nm, why: "node_modules 是软链（插件之间不得相互依赖，也不要 link 到别的插件目录）" });
      console.error(`[gate] ✗ node_modules 是软链 → ${readlinkSync(nm)}`);
      console.error("      插件之间必须独立：不要指向其他插件目录；平台侧依赖（@deepseek-ai/*、react 类型）走 profile/harness 即可。");
    }
  }
  if (bad.length > 0) {
    console.error("[gate] 请先清理后再构建。");
    process.exit(1);
  }
  console.log("[gate] 顶层布局卫生 ✔（无旧扁平布局；依赖自持、无外部软链）");
}

/** 产物门禁：lib/ 双产物存在、非空、可被真实加载。 */
async function verifyArtifacts() {
  const hostFile = root + "/lib/index.js";
  const clientFile = root + "/lib/client.js";
  for (const f of [hostFile, clientFile]) {
    if (!existsSync(f)) fail(`缺少构建产物 ${f}（旧布局？请完整重建）`);
    if (statSync(f).size <= 0) fail(`构建产物为空 ${f}`);
  }

  // host：动态 import，断言关键导出真实存在（loader 加载的就是这个入口）。
  try {
    // 必须包成 file:// URL：Windows 上裸绝对路径（`D:\...`）会被 ESM loader 判为协议 `d:`，
    // 抛 ERR_UNSUPPORTED_ESM_URL_SCHEME（门禁报「lib/index.js 无法加载」）。
    const m = await import(pathToFileURL(hostFile).href + "?gate=" + Date.now());
    const need = ["Scheduler", "VERSION", "apply", "inject", "name"];
    for (const k of need) {
      if (!(k in m)) fail(`lib/index.js 缺少导出 ${k}`);
    }
    if (!Array.isArray(m.inject) || !m.inject.includes("webServer")) {
      fail(`lib/index.js 的 inject 应为 ["webServer"]（cordis 依赖声明），实际 ${JSON.stringify(m.inject)}`);
    }
  } catch (e) {
    fail(`lib/index.js 无法加载：${String(e)}`);
  }

  // client：检查 ModuleLoader 注册与插件 id。
  const clientSrc = readFileSync(clientFile, "utf-8");
  if (!clientSrc.includes("__ModuleLoader__")) fail("lib/client.js 未注册 window.__ModuleLoader__");
  if (!clientSrc.includes("dsh-scheduled-send")) fail("lib/client.js 未包含插件 id dsh-scheduled-send");
  if (!clientSrc.includes("conversation.input.right")) fail("lib/client.js 未注册 conversation.input.right 插槽");
  if (!clientSrc.includes("conversation.input.dock")) fail("lib/client.js 未注册 conversation.input.dock 插槽（定时排队）");
  if (!clientSrc.includes("settings.section")) fail("lib/client.js 未注册 settings.section 插槽");
  if (!clientSrc.includes("sidebar.panellist")) fail("lib/client.js 未注册 sidebar.panellist 插槽（左侧定时任务入口）");
  if (!clientSrc.includes("sidebar.brand.name")) fail("lib/client.js 未注册 sidebar.brand.name（品牌区隐藏）");
  if (!clientSrc.includes("sidebar.brand.mark")) fail("lib/client.js 未注册 sidebar.brand.mark（品牌区隐藏）");
  if (!clientSrc.includes('key: "scheduled-send"') && !clientSrc.includes("key:\"scheduled-send\"")) {
    fail("lib/client.js 未注册 main 页面 key=scheduled-send");
  }
  // 组件注册形态不变式（v0.7.0 防回归）：SettingsSection 必须经 createElement 渲染，
  // 禁止 "(ui.SettingsSection)(props)" 直接函数调用（曾致设置面板空白，见 docs/specs/001/plan.md）。
  if (!clientSrc.includes("createElement(ui.SettingsSection") || clientSrc.includes("SettingsSection)(")) {
    fail("lib/client.js 的 settings.section 注册形态非法：必须 createElement(ui.SettingsSection, ...)，禁止直接函数调用");
  }
  console.log("[gate] 产物可加载 ✔（host 导出齐全 + client 注册齐全）");
}

const noTypecheck = process.argv.includes("--no-typecheck");
checkLayoutHygiene();

const esbuild = loadTool("esbuild");

await Promise.all([
  esbuild.build({
    entryPoints: [root + "/src/index.ts"],
    outfile: root + "/lib/index.js",
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    external: ["node:*", "@deepseek-ai/*"],
    logLevel: "warning",
  }),
  esbuild.build({
    entryPoints: [root + "/src/client/entry.ts"],
    outfile: root + "/lib/client.js",
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    logLevel: "warning",
  }),
]);
console.log("[build] lib/index.js + lib/client.js 已生成");

await verifyArtifacts();

if (!noTypecheck) {
  const tsPath = (() => {
    try {
      const pkg = require.resolve("typescript/package.json", { paths: [root] });
      return pkg.replace(/(^|\/)package\.json$/, "/bin/tsc");
    } catch {
      // 回退到共享解析器（env → 同级 harness → DSH home profile）
      return findTsc(root, FALLBACK_DIRS);
    }
  })();
  if (!tsPath) {
    console.error("[typecheck] 找不到 tsc；请设置 PWB_TOOLS_DIR 或 DSH_HARNESS_ROOT");
    process.exit(1);
  }
  // 插件按布局红线不放 node_modules，故 tsconfig 里的相对 typeRoots 解析不到；
  // 由解析器找出实际存在 @types 的目录（含 pnpm store），用 --typeRoots 注入（跨平台）。
  const typeRoots = findTypeRoots(root, FALLBACK_DIRS);
  for (const cfg of ["tsconfig.json", "tsconfig.client.json"]) {
    const args = ["-p", root + "/" + cfg, "--noEmit"];
    if (typeRoots.length > 0) args.push("--typeRoots", typeRoots.join(","));
    // 必须经 process.execPath 启动：findTsc 返回的是 .../typescript/bin/tsc（无扩展名的
    // JS 文件，靠 shebang 执行）。Windows 没有 shebang，直接 spawn 会 ENOENT。
    const r = spawnSync(process.execPath, [tsPath, ...args], { encoding: "utf-8" });
    if (r.status !== 0) {
      console.error(`[typecheck] ${cfg} 失败（exit ${r.status}）`);
      if (r.error) console.error(`  spawn: ${r.error.code} ${r.error.message}`);
      if (r.stdout) console.error(r.stdout);
      if (r.stderr) console.error(r.stderr);
      process.exit(1);
    }
    console.log(`[typecheck] ${cfg} 通过（0 错误）`);
  }
}
console.log("[build] 完成（门禁全部通过）");