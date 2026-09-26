/**
 * DSH 主目录解析 —— 本仓唯一入口。
 *
 * 纪律：home 目录名只允许在本文件出现一次（DSH_HOME_DIRNAME）。
 * 其它模块一律 import 本文件的 `dshHome()` / `DSH_HOME_DIRNAME`，
 * **禁止再写死 ".dsh*" 字面量**（字面量散落会导致换 home 时改不全）。
 *
 * 优先级：
 *   1. `$DSH_HOME`（显式指定，最优先）
 *   2. `~/${DSH_HOME_DIRNAME}`（默认 `.dsh-dev`；可用 `$DSH_HOME_DIRNAME` 覆盖）
 */
import { join, resolve } from "node:path";
import { homedir } from "node:os";

/** DSH home 的目录名（唯一定义处）。 */
export const DSH_HOME_DIRNAME: string = process.env.DSH_HOME_DIRNAME?.trim() || ".dsh-dev";

/** DSH 主目录的绝对路径。 */
export function dshHome(): string {
  const env = process.env.DSH_HOME?.trim();
  return env ? resolve(env) : join(homedir(), DSH_HOME_DIRNAME);
}
