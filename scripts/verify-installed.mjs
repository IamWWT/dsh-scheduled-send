/**
 * dsh-scheduled-send — 安装后验证器（纯 Node）。
 *
 * 用法：node scripts/verify-installed.mjs [<已安装路径>]
 * 缺省路径：$DSH_HOME/profiles/web/node_modules/dsh-scheduled-send
 *
 * 目的（根因防复发）：把"坏安装目录缺 lib/ → loader 启动 ERR_MODULE_NOT_FOUND"
 * 这件事在**安装完成时**就地拦截，而不是等 systemd 反复崩溃后才发现。
 *
 * 校验项：
 *   1. package.json.main 指向的 lib/index.js 存在且非空；
 *   2. lib/client.js 存在且非空；
 *   3. 动态 import 安装路径的 lib/index.js，断言导出 Scheduler/VERSION/apply/inject/name，
 *      且 inject 含 "webServer"；
 *   4. lib/client.js 含 __ModuleLoader__ 与插件 id；
 *   5. 顶层布局卫生：不允许顶层 index.ts/client.js/build.mjs/client//host/（旧扁平布局残留）。
 */
import { existsSync, readFileSync, statSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function installedPathArg() {
  if (process.argv.length > 2) return resolve(process.argv[2]);
  const home = process.env.DSH_HOME || join(process.env.HOME || "", ".dsh");
  return join(home, "profiles", "web", "node_modules", "dsh-scheduled-send");
}

const fail = (msg) => {
  console.error(`[verify-installed] ✗ ${msg}`);
  process.exit(1);
};

async function main() {
  const target = installedPathArg();
  if (!existsSync(target)) fail(`安装路径不存在：${target}`);

  // 0) 是否为符号链接（link 安装期望如此；tgz 安装也允许是目录，但必须布局完整）
  let linkTarget = "";
  try {
    if (statSync(target).isSymbolicLink()) {
      linkTarget = readlinkSync(target);
    }
  } catch { /* 非链接则按目录处理 */ }

  // 1) package.json.main
  const pkgFile = join(target, "package.json");
  if (!existsSync(pkgFile)) fail(`${pkgFile} 不存在（不是合法包目录）`);
  const pkg = JSON.parse(readFileSync(pkgFile, "utf-8"));
  const relMain = pkg.main ?? "./lib/index.js";
  const hostFile = join(target, relMain.replace(/^\.\//, ""));
  const clientFile = join(target, "lib", "client.js");
  if (!existsSync(hostFile)) fail(`package.json.main 指向 ${relMain}，但文件不存在（典型坏安装：缺 lib/）`);
  if (statSync(hostFile).size <= 0) fail(`lib/index.js 为空文件`);
  if (!existsSync(clientFile) || statSync(clientFile).size <= 0) fail(`lib/client.js 缺失或为空`);

  // 2) host 入口可真实加载
  try {
    const m = await import(pathToFileURL(hostFile).href + "?v=" + Date.now());
    for (const k of ["Scheduler", "VERSION", "apply", "inject", "name"]) {
      if (!(k in m)) fail(`lib/index.js 缺少导出 ${k}`);
    }
    if (!Array.isArray(m.inject) || !m.inject.includes("webServer")) {
      fail(`inject 应为 ["webServer"]，实际 ${JSON.stringify(m.inject)}`);
    }
  } catch (e) {
    fail(`lib/index.js 加载失败：${String(e)}`);
  }

  // 3) client 注册
  const clientSrc = readFileSync(clientFile, "utf-8");
  if (!clientSrc.includes("__ModuleLoader__")) fail("lib/client.js 未注册 __ModuleLoader__");
  if (!clientSrc.includes("dsh-scheduled-send")) fail("lib/client.js 未包含插件 id");

  // 4) 顶层卫生（防旧扁平布局混入安装目录）
  for (const stray of ["index.ts", "client.js", "build.mjs", "client", "host"]) {
    if (existsSync(join(target, stray))) fail(`安装目录存在旧扁平布局残留：${stray}`);
  }
  if (existsSync(join(target, "node_modules"))) {
    const maybeLink = (() => { try { return statSync(join(target, "node_modules")).isSymbolicLink(); } catch { return false; } })();
    if (maybeLink) fail("安装目录存在 node_modules 软链（会遮蔽 profile 依赖），请移除");
  }

  console.log(`[verify-installed] ✔ 安装布局有效：${target}${linkTarget ? `（link → ${linkTarget}）` : ""}`);
  console.log(`[verify-installed]   package: ${pkg.name}@${pkg.version} · main=OK · client=OK · 顶层卫生=OK`);
}

await main();