#!/usr/bin/env node
/**
 * dsh-plugins 共享工具路径解析（跨平台：Windows / Linux / macOS）。
 *
 * 背景：构建/测试脚本需要在「插件仓库不放 node_modules」的前提下，找到
 * esbuild / typescript / @deepseek-ai 系列包所在的位置。早期实现把作者本机
 * 绝对路径硬编码进脚本，导致换一台机器（如 Windows）必然失败。
 *
 * 本模块按固定优先级探测，任一命中即用，**不含任何机器专属绝对路径**：
 *   1. 环境变量显式覆盖（最高优先，便于 CI / 特殊布局）
 *      - DSH_PROFILE_NODE_MODULES     : 直接指定某个 profile 的 node_modules
 *      - DSH_HARNESS_ROOT             : harness 仓库根目录
 *      - DSH_LEGACY_NODE_MODULES      : 额外候选目录（多值用 path.delimiter 分隔）
 *      - <插件专属变量>                : 见 opts.envKeys（保持既有约定）
 *   2. 同级目录相对探测：从插件目录向上逐级查找兄弟目录 deepseek-harness
 *      （dsh-plugins/<plugin> 与 deepseek-harness 同级 —— 各机器都成立）
 *   3. DSH home 下的 profile node_modules
 *      （用运行时 HOME + DSH_HOME；home 目录名默认 .dsh-dev，可用 DSH_HOME_DIRS 覆盖）
 *
 * 用法：
 *   import { buildFallbackDirs, findTool, findTsc } from "./paths.mjs";
 *   const dirs = buildFallbackDirs({ importMetaUrl: import.meta.url, envKeys: ["SUD_TOOLS_DIR"] });
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

/** 插件仓库根目录：调用方位于 <root>/scripts|test/xxx.mjs。 */
export function pluginRoot(importMetaUrl) {
  return resolve(dirname(fileURLToPath(importMetaUrl)), "..");
}

/**
 * DSH home 的候选目录名 —— 唯一定义处。
 * 现行约定只有 `.dsh-dev`（历史 `.dsh` 已废弃，不再默认探测）；
 * 个别机器确需其它命名时用 `DSH_HOME_DIRS` 覆盖（逗号/分号分隔，按顺序探测）。
 */
export const DSH_HOME_DIRS = (() => {
  const override = (process.env.DSH_HOME_DIRS || "")
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return override.length ? override : [".dsh-dev"];
})();

/**
 * 依次探测候选 node_modules 目录，返回**实际存在**的目录列表（保持优先级顺序）。
 * @param {object} opts
 * @param {string} [opts.importMetaUrl] 调用方 import.meta.url（用于定位同级 harness）
 * @param {string[]} [opts.envKeys] 插件专属环境变量名（值可为 node_modules 或 harness 根）
 */
export function buildFallbackDirs(opts = {}) {
  const out = [];
  const push = (p) => {
    if (typeof p !== "string" || p.length === 0) return;
    // harness 根目录 → 追加 node_modules
    const nm = /node_modules[\\/]?$/.test(p) ? p.replace(/[\\/]+$/, "") : join(p, "node_modules");
    if (!out.includes(nm) && existsSync(nm)) out.push(nm);
  };

  // 1) 环境变量显式覆盖
  push(process.env.DSH_PROFILE_NODE_MODULES);
  push(process.env.DSH_HARNESS_ROOT);
  for (const k of opts.envKeys ?? []) push(process.env[k]);
  // 额外候选（可多值），替代旧的硬编码历史回退路径
  const legacy = process.env.DSH_LEGACY_NODE_MODULES;
  if (legacy) for (const p of legacy.split(delimiter)) push(p);

  // 2) 同级/上级 harness 相对探测
  //    常见布局：<parent>/deepseek-harness 与 <parent>/dsh-plugins/<plugin> 同级，
  //    故从插件目录向上逐级查找名为 deepseek-harness 的兄弟目录。
  if (opts.importMetaUrl) {
    const root = pluginRoot(opts.importMetaUrl);
    let dir = root;
    for (let i = 0; i < 4; i += 1) {
      const candidate = join(dir, "deepseek-harness");
      if (existsSync(candidate)) {
        push(candidate);
        break;
      }
      const up = resolve(dir, "..");
      if (up === dir) break;
      dir = up;
    }
    if (process.env.DSH_HARNESS_DIR) push(process.env.DSH_HARNESS_DIR);
  }

  // 3) DSH home 下的 profile node_modules
  //    显式 DSH_HOME 优先；随后按候选目录名探测（.dsh-dev 是现行约定）。
  const homes = [];
  if (process.env.DSH_HOME) {
    const h = process.env.DSH_HOME.replace(/^~(?=[\\/]|$)/, homedir());
    homes.push(h);
  }
  for (const name of DSH_HOME_DIRS) homes.push(join(homedir(), name));
  for (const home of homes) {
    try {
      const profiles = join(home, "profiles");
      if (!existsSync(profiles)) continue;
      // 3a) profile 层 hoisted 农场：DSH 把 @deepseek-ai/* 提到 <home>/profiles/node_modules
      //     （符号链接指向 harness CLI 的依赖）。**必须排在 <profile>/node_modules 之前**，
      //     否则解析会先命中「有 @deepseek-ai 目录但不含目标包」的位置而失败
      //     （实测：minesweeper 构建门禁因 @deepseek-ai/schemastery 解析不到而报「无法加载」）。
      const hoisted = join(profiles, "node_modules");
      if (existsSync(hoisted) && !out.includes(hoisted)) out.push(hoisted);
      // 3b) 各 profile 自己的 node_modules
      for (const name of readdirSync(profiles)) {
        const nm = join(profiles, name, "node_modules");
        if (existsSync(nm) && !out.includes(nm)) out.push(nm);
      }
    } catch {
      /* 忽略 HOME 异常 */
    }
  }

  return out;
}

/** 在候选目录中解析一个 CommonJS 工具模块（如 esbuild / typescript）。 */
export function findTool(name, dirs) {
  for (const d of dirs) {
    try {
      return createRequire(join(d, "x.js"))(name);
    } catch {
      /* 下一个候选 */
    }
  }
  return undefined;
}

/** esbuild 专用：候选目录缺失时，深入 harness 的 pnpm store 逐个版本尝试。 */
export function findEsbuild(dirs) {
  const direct = findTool("esbuild", dirs);
  if (direct) return direct;
  for (const d of dirs) {
    const pnpm = d.replace(/node_modules[\\/]?$/, "").replace(/[\\/]+$/, "") + "/node_modules/.pnpm";
    if (!existsSync(pnpm)) continue;
    const cands = readdirSync(pnpm)
      .filter((x) => x.startsWith("esbuild@"))
      .sort()
      .reverse();
    for (const dir of cands) {
      const p = `${pnpm}/${dir}/node_modules/esbuild`;
      try {
        return createRequire(p + "/x.js")(p);
      } catch {
        /* 下一个版本 */
      }
    }
  }
  return undefined;
}

/**
 * 在候选目录的 pnpm store（node_modules/.pnpm）里定位一个包的实际目录。
 *
 * 用途：测试脚本需要直接 require 某个被 harness 以 pnpm 安装的包
 * （playwright / react / jsdom 等），但包只存在于 harness 的 .pnpm 里，
 * 且目录名带版本与哈希后缀（如 react-dom@18.3.1_react@18.3.1）。
 * 这里按包名前缀匹配、取版本最高的一个，避免写死具体版本。
 *
 * @param {string} name 包名（如 "playwright"、"react"、"@types/node"）
 * @param {string[]} dirs 候选 node_modules 目录（buildFallbackDirs 的返回值）
 * @returns {string|undefined} 包目录绝对路径
 */
export function findPnpmPackage(name, dirs) {
  // pnpm store 里目录名的转义规则：@scope/name → @scope+name
  const escaped = name.replace(/\//g, "+");
  for (const d of dirs) {
    const store = d.replace(/node_modules[\\/]?$/, "").replace(/[\\/]+$/, "") + "/node_modules/.pnpm";
    if (!existsSync(store)) continue;
    const hit = readdirSync(store)
      .filter((x) => x === escaped || x.startsWith(escaped + "@"))
      .sort()
      .reverse()[0];
    if (!hit) continue;
    const p = `${store}/${hit}/node_modules/${name}`;
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** 定位 tsc 入口文件（返回绝对路径字符串，找不到返回 ""）。 */
export function findTsc(root, dirs) {
  const local = join(root, "node_modules", "typescript", "bin", "tsc");
  if (existsSync(local)) return local;
  for (const d of dirs) {
    const p = join(d, "typescript", "bin", "tsc");
    if (existsSync(p)) return p;
    const pnpm = d.replace(/node_modules[\\/]?$/, "").replace(/[\\/]+$/, "") + "/node_modules/.pnpm";
    if (!existsSync(pnpm)) continue;
    for (const dir of readdirSync(pnpm).filter((x) => x.startsWith("typescript@")).sort().reverse()) {
      const t = `${pnpm}/${dir}/node_modules/typescript/bin/tsc`;
      if (existsSync(t)) return t;
    }
  }
  return "";
}

/**
 * 收集可用的 @types 根目录（供 tsc --typeRoots）。
 * 插件按布局红线不放 node_modules，故 tsconfig 里
 * "typeRoots: ["./node_modules/@types"] 会解析失败；此处把候选目录里
 * 实际存在 @types 的 node_modules 全部返回，由调用方注入 --typeRoots。
 *
 * 除 <dir>/@types 外还会补探 pnpm 虚拟 store（<dir>/node_modules/.pnpm/@types+<pkg>@<ver>）：
 * harness / profile 层只把部分 @types 提升到 <dir>/@types（实测只有 node/jsdom 等），
 * react、react-dom 这类只存在于 store 中。不补探 store，客户端 typecheck 就会报
 * TS2307「Cannot find module 'react'」——「react 类型由平台侧提供」的约定会落空。
 */
export function findTypeRoots(root, dirs) {
  const out = [];
  const seen = new Set(); // 已有来源的 @types 包名（防同名包被加载两份 → Duplicate identifier）
  const add = (p) => {
    if (!existsSync(p) || out.includes(p)) return;
    out.push(p);
    try {
      for (const n of readdirSync(p)) seen.add(n);
    } catch {
      /* 忽略 */
    }
  };

  // 1) 插件自带（本机做过 pnpm install 时才有）
  add(join(root, "node_modules", "@types"));

  for (const d of dirs) {
    // 2) 平台/兄弟目录直接暴露的 @types
    add(join(d, "@types"));

    // 3) pnpm 虚拟 store：<dir>/node_modules/.pnpm/@types+<pkg>@<ver>/node_modules/@types
    //    每个 @types+* 目录只含一个包，故仅在「该包尚无来源」时加入，不会引入重复。
    const pnpm = d.replace(/node_modules[\\/]?$/, "").replace(/[\\/]+$/, "") + "/node_modules/.pnpm";
    if (!existsSync(pnpm)) continue;
    let entries = [];
    try {
      entries = readdirSync(pnpm);
    } catch {
      continue;
    }
    for (const name of entries.slice().sort()) {
      if (!name.startsWith("@types+")) continue;
      const t = join(pnpm, name, "node_modules", "@types");
      if (!existsSync(t)) continue;
      let names = [];
      try {
        names = readdirSync(t);
      } catch {
        continue;
      }
      if (names.some((n) => seen.has(n))) continue;
      add(t);
    }
  }
  return out;
}
