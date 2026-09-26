/**
 * dsh-scheduled-send — Host 入口（Node 侧）。
 *
 * 职责：
 *   - 解析状态目录（$DSH_HOME/profiles/<profile>/scheduled-send，config.stateDir 可覆盖）；
 *   - 构造并恢复 Scheduler（jobs.json 持久化 + 重启补投）；
 *   - 把 host 上下文挂给 Scheduler（fire 时取 sessionController）；
 *   - 注册 /api/scheduled-send/* 路由。
 *
 * 不重造轮子：到点投递走 dsh 原生 sessionController.prompt({mode:'queue'})，
 * 复用 Inbox next-turn 持久队列（agent 运行中排队消费 / 空闲即下一轮）。
 */
import { Scheduler, type HostCtx } from "./host/scheduler.ts";
import { registerRoutes } from "./host/routes.ts";
import { dshHome } from "./shared/dsh-home.ts";

export const name = "scheduled-send";

/**
 * Cordis 依赖注入声明：访问 ctx.webServer 前必须声明，否则代理抛
 * "cannot get property 'webServer' without inject"（webServer 由
 * @deepseek-ai/dsh-host-webserver 提供，仅 web profile 存在）。
 */
export const inject = ["webServer"];

/** 与 package.json 同步。 */
export const VERSION = "0.7.3";

export { Scheduler, type HostCtx } from "./host/scheduler.ts";
export type { SchedulerConfig, SessionControllerFace } from "./host/scheduler.ts";
export { registerRoutes } from "./host/routes.ts";
export { sessionOpenerOf } from "./shared/session-opener.ts";
export { sessionMetaOf } from "./shared/session-meta.ts";

export interface PluginConfig {
  /** 状态目录；"" = $DSH_HOME/profiles/<profile>/scheduled-send。 */
  stateDir?: string;
}

function resolveStateDir(configured: string | undefined): string {
  const home = dshHome();
  if (configured && configured.trim()) {
    const p = configured.trim();
    if (p.startsWith("/")) return p;
    return `${home.replace(/\/+$/, "")}/${p.replace(/^\/+/, "")}`;
  }
  const profile = process.env.DSH_PROFILE || "web";
  return `${home}/profiles/${profile}/scheduled-send`;
}

export function apply(ctx: unknown, config: Partial<PluginConfig> = {}): void {
  const c = ctx as HostCtx;
  const stateDir = resolveStateDir(config.stateDir);
  const scheduler = new Scheduler({ stateDir, version: VERSION });
  scheduler.attach(c);
  scheduler.resumeAll(c);
  if (c.effect) {
    c.effect(() => {
      registerRoutes(c, scheduler, VERSION);
      return () => scheduler.stop();
    });
  } else {
    // 无 effect（如单元环境）：直接注册，跳过清理钩子
    registerRoutes(c, scheduler, VERSION);
  }
}