/**
 * dsh-scheduled-send — Host 端定时调度器。
 *
 * 职责：
 *   - 持久化任务表（<stateDir>/jobs.json）；
 *   - 为每个 pending 任务挂一个 host 进程内 setTimeout（dsh host 是常驻进程，
 *     systemd user service 保活，因此"离开电脑后"仍会触发）；
 *   - 进程重启后恢复：pending 且已过期的任务启动时立即补投；
 *   - 触发时调用 ctx.get('sessionController').prompt({ mode: 'queue' }) 把文本
 *     投递进目标会话的持久队列（Inbox next-turn，与 dsh 原生 QueueDock 同通道）：
 *     agent 运行中 → 逐步消费；agent 空闲 → 立即成为下一轮。
 *
 * 不重造轮子：队列语义 / 投递 / 消费全部复用 dsh 原生 Inbox（agent.followup → next-turn）。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ScheduledJob } from "../shared/types.ts";
import { MAX_PENDING_PER_SESSION, MAX_SCHEDULE_DAY_OFFSET } from "../shared/constants.ts";

/** Cordis host 上下文的最小结构面（仅用到 webServer / get / effect）。 */
export interface HostCtx {
  webServer?: { register: (spec: { kind: string; path: string; handler: (req: never, res: never) => Promise<void> }) => () => void };
  get?: (key: string) => unknown;
  effect?: (fn: () => (() => void) | void) => void;
}

export interface SchedulerConfig {
  /** 状态目录（绝对路径，由 index.ts 解析 $DSH_HOME/profiles/<profile>/scheduled-send 后传入）。 */
  stateDir: string;
  /** 插件版本（日志/健康检查展示）。 */
  version?: string;
}

export interface SessionControllerFace {
  prompt?: (
    request: { requestId: string; sessionId: string; mode: "queue" | "steer"; content: Array<{ type: string; text: string }> },
    signal: AbortSignal,
  ) => Promise<unknown>;
}

/** 调度器：任务表 + 触发器管理。 */
export class Scheduler {
  private jobs: ScheduledJob[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly stateFile: string;
  private readonly version: string;

  constructor(cfg: SchedulerConfig) {
    this.stateFile = `${cfg.stateDir}/jobs.json`;
    this.version = cfg.version ?? "0.1.0";
    this.load();
  }

  /** 从磁盘恢复任务表（不存在则空表）。 */
  load(): void {
    try {
      if (existsSync(this.stateFile)) {
        const raw = JSON.parse(readFileSync(this.stateFile, "utf-8")) as { jobs?: ScheduledJob[] };
        this.jobs = raw.jobs ?? [];
      } else {
        this.jobs = [];
      }
    } catch {
      this.jobs = [];
    }
  }

  save(): void {
    mkdirSync(dirname(this.stateFile), { recursive: true });
    writeFileSync(this.stateFile, JSON.stringify({ version: 1, jobs: this.jobs }, null, 2), "utf-8");
  }

  list(): readonly ScheduledJob[] {
    return this.jobs;
  }

  get(id: string): ScheduledJob | undefined {
    return this.jobs.find(j => j.id === id);
  }

  /** 业务允许的最晚触发时刻：明天 23:59:59.999（消费 MAX_SCHEDULE_DAY_OFFSET=1）。 */
  static maxFireAt(now: number = Date.now()): number {
    const d = new Date(now);
    d.setDate(d.getDate() + MAX_SCHEDULE_DAY_OFFSET);
    d.setHours(23, 59, 59, 999);
    return d.getTime();
  }

  /** 新建任务（fireAt 必须晚于当前时间、不晚于明天结束；每会话 pending 数受 MAX_PENDING_PER_SESSION 限制）。 */
  add(input: {
    id?: string;
    sessionId: string;
    sessionTitle?: string;
    text: string;
    fireAt: number;
    note?: string;
  }): ScheduledJob {
    if (!Number.isFinite(input.fireAt) || input.fireAt <= Date.now()) {
      throw new Error("fireAt 必须晚于当前时间");
    }
    if (input.fireAt > Scheduler.maxFireAt()) {
      throw new Error(`最晚只能定到明天 23:59:59（当前超出限制）`);
    }
    const pendingForSession = this.jobs.filter(
      j => j.sessionId === input.sessionId && j.status === "pending",
    ).length;
    if (pendingForSession >= MAX_PENDING_PER_SESSION) {
      throw new Error(
        `该会话最多可同时设置 ${MAX_PENDING_PER_SESSION} 个定时发送任务（当前已有 ${pendingForSession} 个待触发），请先在设置中撤回或删除后再创建`,
      );
    }
    const job: ScheduledJob = {
      id: input.id ?? "job-" + randomUUID().slice(0, 8),
      sessionId: input.sessionId,
      sessionTitle: input.sessionTitle,
      text: input.text,
      fireAt: Math.floor(input.fireAt),
      status: "pending",
      createdAt: Date.now(),
      note: input.note,
    };
    this.jobs.push(job);
    this.save();
    this.arm(job);
    return job;
  }

  /** 更新 pending 任务（文本 / 触发时刻 / 备注 / 标题快照）；已触发任务不可改。 */
  update(id: string, patch: { text?: string; fireAt?: number; note?: string; sessionTitle?: string }): ScheduledJob {
    const job = this.get(id);
    if (!job) throw new Error(`任务 ${id} 不存在`);
    if (job.status !== "pending") throw new Error(`任务 ${id} 状态为 ${job.status}，不可修改`);
    if (patch.text !== undefined) job.text = patch.text;
    if (patch.sessionTitle !== undefined) job.sessionTitle = patch.sessionTitle;
    if (patch.note !== undefined) job.note = patch.note;
    if (patch.fireAt !== undefined) {
      if (patch.fireAt <= Date.now()) throw new Error("fireAt 必须晚于当前时间");
      if (patch.fireAt > Scheduler.maxFireAt()) throw new Error(`最晚只能定到明天 23:59:59（当前超出限制）`);
      job.fireAt = Math.floor(patch.fireAt);
    }
    this.save();
    this.disarm(id);
    this.arm(job);
    return job;
  }

  /** 取消（幂等）：pending → cancelled 并摘除定时器。 */
  cancel(id: string): boolean {
    const job = this.get(id);
    if (!job) return false;
    if (job.status === "pending") {
      job.status = "cancelled";
      this.disarm(id);
      this.save();
      return true;
    }
    return false;
  }

  /** 从任务表移除任意任务（pending 先摘定时器）。 */
  delete(id: string): boolean {
    const i = this.jobs.findIndex(j => j.id === id);
    if (i === -1) return false;
    if (this.jobs[i].status === "pending") this.disarm(id);
    this.jobs.splice(i, 1);
    this.save();
    return true;
  }

  /** 进程重启后恢复：pending 任务补挂定时器；已过期的立即补投。 */
  resumeAll(ctx: HostCtx | undefined): void {
    for (const job of [...this.jobs]) {
      if (job.status !== "pending") continue;
      if (job.fireAt <= Date.now()) {
        void this.fire(job.id, ctx);
      } else {
        this.arm(job);
      }
    }
  }

  /** 停止一切定时器（进程退出/卸载）。 */
  stop(): void {
    for (const id of [...this.timers.keys()]) this.disarm(id);
  }

  /** 为 pending 任务挂 setTimeout（幂等）。 */
  private arm(job: ScheduledJob): void {
    if (job.status !== "pending") return;
    if (this.timers.has(job.id)) return;
    const delay = Math.max(0, job.fireAt - Date.now());
    const t = setTimeout(() => {
      this.timers.delete(job.id);
      void this.fire(job.id, this.ctx);
    }, delay);
    // 不让未触发的任务挂住进程退出
    const tAny = t as unknown as { unref?: () => void };
    tAny.unref?.();
    this.timers.set(job.id, t);
  }

  /** 摘除并清除一个任务的定时器。 */
  private disarm(id: string): void {
    const t = this.timers.get(id);
    if (t) {
      clearTimeout(t);
      this.timers.delete(id);
    }
  }

  /** host 上下文（由 index.ts 在 apply 时注入；fire 用它取 sessionController）。 */
  private ctx: HostCtx | undefined;

  attach(ctx: HostCtx | undefined): void {
    this.ctx = ctx;
  }

  /**
   * 触发一个任务：以 mode:'queue' 投递进目标会话持久队列。
   * 复用 dsh 原生排队：agent 运行中 → 排队等逐步消费；空闲 → 立即成为下一轮。
   */
  async fire(jobId: string, ctx?: HostCtx): Promise<void> {
    const job = this.get(jobId);
    if (!job || job.status !== "pending") return;
    job.firedAt = Date.now();
    const sc = (ctx ?? this.ctx)?.get?.("sessionController") as SessionControllerFace | undefined;
    try {
      if (!sc || typeof sc.prompt !== "function") {
        throw new Error("host 未提供 sessionController.prompt");
      }
      const requestId = "sends-" + Date.now().toString(36) + "-" + job.id.slice(-4);
      await sc.prompt(
        {
          requestId,
          sessionId: job.sessionId,
          mode: "queue",
          content: [{ type: "text", text: job.text }],
        },
        new AbortController().signal,
      );
      job.status = "sent";
    } catch (e) {
      job.status = "missed";
      job.error = String((e as Error)?.message ?? e);
    }
    this.save();
  }
}