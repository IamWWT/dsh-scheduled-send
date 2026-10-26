/**
 * dsh-scheduled-send — Host 入口（Node 侧）。
 *
 * 0.8.0 起不再自己实现定时器/任务表：调度器 = 宿主公开服务 `ctx.schedule`
 *（@deepseek-ai/dsh-schedule）。本插件负责：
 *   - WorkBuddy 式任务表单 / 任务列表（HTTP API + client UI）；
 *   - 在所选工作区创建专属任务会话；
 *   - 官方没有的“截止时间”（到期删除官方任务）；
 *   - 观察官方投递 + turn/end，记录执行结果供页面展示。
 *
 * 不重造轮子：投递、重复规则、持久化、冷会话恢复全部由官方 Schedule 负责。
 */
import { ScheduleBridge, type ExecutionUpdate } from "./host/bridge.ts";
import { registerRoutes } from "./host/routes.ts";
import { dshHome } from "./shared/dsh-home.ts";

export const name = "scheduled-send";

/**
 * Cordis 依赖注入声明：官方 Schedule 服务与 Session 控制面是硬依赖；
 * webServer 用于本插件 HTTP 路由。connection 由路由惰性解析（旧宿主可能没有）。
 */
export const inject = ["webServer", "schedule", "sessionController"];

/** 与 package.json 同步。 */
export const VERSION = "0.10.2";

export { ScheduleBridge, type ExecutionUpdate } from "./host/bridge.ts";
export type { TaskMeta } from "./host/meta.ts";
export { registerRoutes } from "./host/routes.ts";
export { sessionOpenerOf } from "./shared/session-opener.ts";
export { sessionMetaOf } from "./shared/session-meta.ts";

/** 兼容旧导入名（0.7.x 的测试/文档曾用 Scheduler）。 */
export { ScheduleBridge as Scheduler } from "./host/bridge.ts";

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
  const stateDir = resolveStateDir(config.stateDir);
  const bridge = new ScheduleBridge(ctx, stateDir, VERSION);
  bridge.onExecution = (update: ExecutionUpdate) => {
    const label = update.taskIds.length > 0 ? update.taskIds.join(",") : update.sessionId;
    console.log(`[dsh-scheduled-send] execution ${update.status} ${label} ${update.durationMs}ms`);
  };
  bridge.start();
  const host = ctx as { effect?: (fn: () => () => void) => void };
  if (typeof host.effect === "function") {
    host.effect(() => {
      registerRoutes(ctx, bridge, VERSION);
      return () => bridge.stop();
    });
  } else {
    registerRoutes(ctx, bridge, VERSION);
  }
}
