/**
 * 官方 Schedule 服务的适配层。
 *
 * 本插件不再创建自己的定时器表：`ctx.schedule` 负责持久化、重复规则、
 * 冷会话恢复与投递；这里只做四件事：
 *   1. 把官方记录包装成页面用的 TaskView（附加工作区/截止时间/执行结果）；
 *   2. 创建任务前按需在所选工作区建立专属任务会话；
 *   3. 用插件元数据实现官方没有的“截止时间”；
 *   4. 观察官方投递消息与 turn/end，记录执行状态（成功/失败/中断）。
 *
 * 官方记录是权威；元数据丢失时页面仍能列任务，只是少了附加字段。
 */
/**
 * 本插件不 import 上游类型包：插件按布局红线自持依赖，且上游类型路径会随版本漂移。
 * 下面只声明实际调用的结构面，运行时由宿主对象满足。
 */
type SessionId = string;
type WorkspaceId = string;

interface DeliveryReceiptLike {
  scheduledAt: string;
  deliveredAt: string;
  messageId: unknown;
}

interface ScheduleRecordLike {
  id: string;
  kind: string;
  title: string;
  prompt: string;
  scheduledAt: string;
  [key: string]: unknown;
}

interface ScheduleCatalogEntryLike extends ScheduleRecordLike {
  sessionId: SessionId;
  status: "active" | "inactive";
  lastDelivery?: DeliveryReceiptLike;
}

interface ScheduleCreateRequestLike {
  title: string;
  prompt: string;
  at?: string;
  after_seconds?: number;
  every_seconds?: number;
  daily?: { time: string; time_zone: string };
  weekly?: { time: string; time_zone: string; weekdays: number[] };
  cron?: { expression: string; time_zone: string };
}

interface ScheduleUpdateRequestLike {
  sessionId: SessionId;
  id: string;
  expected: ScheduleRecordLike;
  title?: string;
  prompt?: string;
  change?: { kind: "at"; at: string } | { kind: "every"; every_seconds: number }
    | { kind: "daily"; daily: { time: string; time_zone: string } }
    | { kind: "weekly"; weekly: { time: string; time_zone: string; weekdays: number[] } }
    | { kind: "cron"; cron: { expression: string; time_zone: string } };
}

type ScheduleUpdateResultLike =
  | { id: string; updated: boolean; record: ScheduleRecordLike }
  | { id: string; updated: false; code: string; message?: string };

type ScheduleDeleteResultLike = { id: string; deleted: boolean; code?: string };
type ScheduleDeleteInactiveResultLike = { deleted: number };
type ScheduleDeliveryHistoryRequestLike = {
  sessionId: SessionId;
  id: string;
  limit: number;
  before?: string;
};
type ScheduleDeliveryHistoryResultLike =
  | { records: DeliveryReceiptLike[]; nextBefore?: string; earlierRecordsUnavailable?: boolean }
  | { code: string; message?: string };
import { MetaStore, type TaskMeta } from "./meta.ts";
import { ProtectionStore } from "./protection.ts";
import {
  EXECUTION_SUMMARY_MAX,
  MAX_VALIDITY_DAYS,
} from "../shared/constants.ts";
import type {
  DeliveryReceipt,
  ExecutionRecord,
  ExecutionStatus,
  Frequency,
  ModelRef,
  TaskCreateRequest,
  TaskHistoryPage,
  TaskHistoryRequest,
  TaskUpdateRequest,
  TaskView,
} from "../shared/types.ts";

/** 官方服务的最小结构面（避免把插件绑死在上游具体类上）。 */
interface ScheduleServiceLike {
  catalog(): Promise<ScheduleCatalogEntryLike[]>;
  create(sessionId: SessionId, request: ScheduleCreateRequestLike, signal?: AbortSignal): Promise<ScheduleRecordLike>;
  update(request: ScheduleUpdateRequestLike, signal?: AbortSignal): Promise<ScheduleUpdateResultLike>;
  delete(request: { sessionId: SessionId; id: string }, signal?: AbortSignal): Promise<ScheduleDeleteResultLike>;
  deleteInactive(): Promise<ScheduleDeleteInactiveResultLike>;
  history(request: ScheduleDeliveryHistoryRequestLike): Promise<ScheduleDeliveryHistoryResultLike>;
}

interface SessionControllerLike {
  create(request: { workspaceId?: WorkspaceId; sessionId?: SessionId; agentPreset?: string }): Promise<{ sessionId: SessionId; agentPreset?: string }>;
  rename(request: { sessionId: SessionId; title: string }): Promise<unknown>;
  /** 官方公开方法：切换会话模型（与用户在会话里手动切换同链路；会同步更新全局默认模型）。 */
  selectModel?(request: { sessionId: SessionId; provider: string; model: string; reasoningEffort?: string }): Promise<unknown>;
  prompt(
    request: { requestId: string; sessionId: SessionId; mode: "queue" | "steer"; content: Array<{ type: "text"; text: string }> },
    signal: AbortSignal,
  ): Promise<unknown>;
}

interface HostSessionLike {
  id?: string;
  header?: { title?: string; cwd?: string };
}

/** 工作区实体里本插件用到的那两个成员（`@deepseek-ai/dsh-workspace` 公开面）。 */
interface WorkspaceEntityLike {
  attachSession(sessionId: SessionId): Promise<void>;
  detachSession(sessionId: SessionId): Promise<void>;
}

interface BridgeCtx {
  workspaceRegistry?: {
    list(): Array<{id: string; path: string; sessionIds: readonly string[]}>;
    get?: (id: WorkspaceId) => WorkspaceEntityLike | undefined;
    readonly archivedSessionIds: readonly string[];
  };
  schedule: ScheduleServiceLike;
  sessionController: SessionControllerLike;
  sessions?: { get?: (id: SessionId) => HostSessionLike | undefined };
  on: (event: string, listener: (...args: never[]) => void, options?: { global?: boolean }) => () => void;
  logger?: { warn?: (message: string) => void; info?: (message: string) => void };
}

interface PendingExecution {
  turn?: number;
  taskIds: Set<string>;
  startedAt: number;
}

/** 本插件触发的执行状态事件（Host 内部；列表展示与日志用）。 */
export interface ExecutionUpdate {
  taskIds: string[];
  sessionId: string;
  status: ExecutionStatus;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  summary?: string;
  error?: string;
}

export class ScheduleBridge {
  private readonly meta: MetaStore;
  private readonly protection: ProtectionStore;
  private protectionWarnings: string[] = [];
  private resetChain: Promise<unknown> = Promise.resolve();
  private readonly ctx: BridgeCtx;
  private readonly version: string;
  private catalogCache: ScheduleCatalogEntryLike[] = [];
  private readonly validityTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pending = new Map<string, PendingExecution>();
  private readonly currentTurn = new Map<string, number>();
  private readonly turnStartedAt = new Map<string, number>();
  private readonly lastAssistantText = new Map<string, string>();
  private readonly disposers: Array<() => void> = [];
  private refreshChain: Promise<void> = Promise.resolve();
  private stopped = false;
  /** 0.10.7 一次性迁移：把历史遗留的「空白任务会话」退出工作区列表。 */
  private stubSeatsReleased = false;

  constructor(ctx: unknown, stateDir: string, version: string) {
    this.ctx = ctx as BridgeCtx;
    this.meta = new MetaStore(stateDir);
    this.protection = new ProtectionStore(stateDir);
    this.version = version;
  }

  start(): void {
    if (this.stopped) return;
    try {
      const offEvent = this.ctx.on("session/event", ((session: unknown, event: unknown) => {
        this.onSessionEvent(session, event);
      }) as never, { global: true });
      this.disposers.push(offEvent);
    } catch (e) {
      this.ctx.logger?.warn?.(`[dsh-scheduled-send] 无法监听 session/event：${String((e as Error)?.message ?? e)}`);
    }
    try {
      const offChanged = this.ctx.on("schedule/changed", (() => { void this.refresh().catch(()=>{}); }) as never, { global: true });
      this.disposers.push(offChanged);
    } catch {
      // 事件名在旧宿主不存在时不影响主流程（列表仍会轮询刷新）。
    }
    void this.refresh().catch(()=>{});
  }

  stop(): void {
    this.stopped = true;
    for (const off of this.disposers.splice(0)) {
      try { off(); } catch { /* 卸载阶段忽略 */ }
    }
    for (const timer of this.validityTimers.values()) clearTimeout(timer);
    this.validityTimers.clear();
  }

  /** 读官方目录并补全/清理元数据；所有写操作之后都会调用，保证列表一致。 */
  refresh(): Promise<void> {
    const run=this.refreshChain.then(() => this.doRefresh());
    this.refreshChain = run.catch((e: unknown) => {
        this.ctx.logger?.warn?.(`[dsh-scheduled-send] 刷新任务失败：${String((e as Error)?.message ?? e)}`);
      });
    return run;
  }

  private async doRefresh(): Promise<void> {
    if (this.stopped) return;
    let entries = await this.ctx.schedule.catalog();
    // A persisted pause is an intent to disarm. Finish it after an interrupted
    // process before exposing the paused row; never run a second scheduler.
    for(const baseline of this.protection.data.defaults){
      if(!baseline.pausedTask)continue;
      if(this.protection.data.moves[baseline.taskId]){
        const task=baseline.pausedTask,workspaceId=this.workspaceFor(task);
        if(!workspaceId)throw new Error(`「${task.title}」恢复任务的工作区不可用，配置已保留`);
        const resumed=await this.createOfficial(this.requestOf(task,workspaceId),baseline.taskId);
        delete baseline.pausedTask;
        this.protection.rebind(baseline.taskId,resumed.id);
        continue;
      }
      const armed=entries.find(x=>x.id===baseline.taskId);
      if(armed)await this.ctx.schedule.delete({sessionId:armed.sessionId,id:armed.id});
      this.protection.forget(baseline.taskId);
    }
    entries=await this.ctx.schedule.catalog();
    const idsBefore = new Set(entries.map(x=>x.id));
    const archived = new Set(this.ctx.workspaceRegistry?.archivedSessionIds ?? []);
    this.protectionWarnings=[];
    for(const task of Object.values(this.protection.data.recurring)) {
      if(idsBefore.has(task.id))continue;
      if(task.endsAt!==undefined && task.endsAt<=Date.now()){this.protection.forget(task.id);continue;}
      if(!archived.has(task.sessionId)){this.protection.forget(task.id);continue;}
      try {
        const workspaceId=this.workspaceFor(task);
        if(!workspaceId)throw new Error('原工作区不可用，请恢复工作区后重试');
        const restored=await this.createOfficial(this.requestOf(task,workspaceId),task.id);
        this.meta.set(restored.id,{createdAt:task.createdAt,...(task.lastExecution?{lastExecution:task.lastExecution}:{})});
        this.protection.rebind(task.id,restored.id);
      }catch(error){
        const warning=`周期任务「${task.title}」归档迁移失败，配置已保留：${String((error as Error)?.message??error)}`;
        this.protectionWarnings.push(warning);this.ctx.logger?.warn?.(warning);
      }
    }
    entries=await this.ctx.schedule.catalog();
    this.catalogCache = entries;
    const ids = new Set(entries.map(entry => entry.id));
    this.meta.reconcile(ids);
    let changed = false;
    for (const entry of entries) {
      const before = this.meta.get(entry.id);
      const meta = this.meta.ensure(entry.id, { title: entry.title });
      if (before === undefined || before.title !== entry.title) changed = true;
      else if (meta.title !== entry.title) {
        meta.title = entry.title;
        changed = true;
      }
    }
    if (changed) this.meta.flush();
    if (!this.stubSeatsReleased) {
      // 宿主启动时的 workspace bootstrap 会把「按 cwd 归属但不在名单里」的会话重新挂回工作区，
      // 所以迁移必须在 bootstrap 之后（本插件 inject 了 workspaceRegistry，apply 晚于它 init）跑一次。
      this.stubSeatsReleased = true;
      await this.releaseStubSeats(entries);
    }
    this.protection.capture(entries.map(entry=>{
      const view=this.toView(entry),workspaceId=this.workspaceFor(view);
      return {...view,...(workspaceId?{workspaceId}:{})};
    }));
    this.armValidity();
  }

  async list(): Promise<TaskView[]> {
    await this.refresh();
    return [...this.catalogCache.map(entry => this.toView(entry)),...this.protection.data.defaults.flatMap(x=>x.pausedTask?[{...x.pausedTask,id:x.taskId,status:'paused' as const}]:[])];
  }

  async health(): Promise<{ scheduleService: boolean; active: number; total: number }> {
    try {
      await this.refresh();
      return {
        scheduleService: true,
        active: this.catalogCache.filter(entry => entry.status === "active").length,
        total: this.catalogCache.length,
      };
    } catch {
      return { scheduleService: false, active: 0, total: 0 };
    }
  }

  async create(input: TaskCreateRequest): Promise<TaskView> {
    const entry=await this.createOfficial(input);
    await this.refresh();
    return this.toView(this.catalogCache.find(x=>x.id===entry.id)??entry);
  }

  private async createOfficial(input: TaskCreateRequest,moveFrom?:string): Promise<ScheduleCatalogEntryLike> {
    const title = input.title.trim();
    const prompt = input.prompt.trim();
    if (title === "") throw new Error("任务名称不能为空");
    if (prompt === "") throw new Error("提示词不能为空");
    if (input.workspaceId !== undefined && input.sessionId !== undefined) {
      throw new Error("workspaceId 与 sessionId 只能选一个");
    }
    const endsAt = normalizeEndsAt(input.endsAt, input.frequency);
    const pending=moveFrom?this.protection.data.moves[moveFrom]:undefined;
    const reuse=pending && !this.ctx.workspaceRegistry?.archivedSessionIds.includes(pending);
    const target = reuse?{sessionId:pending,workspaceId:input.workspaceId,sessionTitle:title}:await this.resolveTarget(input);
    if(moveFrom){this.protection.data.moves[moveFrom]=target.sessionId;this.protection.save();}
    if (input.model !== undefined) await this.applyModel(target.sessionId, input.model);
    // A recovery may have committed its official row just before a crash.
    // The persisted dedicated target makes retry adoption unambiguous.
    const committed=moveFrom?(await this.ctx.schedule.catalog()).find(x=>x.sessionId===target.sessionId && x.title===title && x.prompt===prompt):undefined;
    const record = committed??await this.ctx.schedule.create(target.sessionId, toCreateRequest(input.frequency, title, prompt));
    this.meta.set(record.id, {
      notify: input.notify !== false,
      createdAt: Date.now(),
      title: record.title,
      ...(target.workspaceId === undefined ? {} : { workspaceId: target.workspaceId }),
      ...(target.sessionTitle === undefined ? {} : { sessionTitle: target.sessionTitle }),
      ...(endsAt === undefined ? {} : { endsAt }),
      ...(input.agentPreset === undefined || input.agentPreset === "" ? {} : { agentPreset: input.agentPreset }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.builtin === true ? { builtin: true } : {}),
    });
    return {
      ...record,
      sessionId: target.sessionId,
      status: "active",
    } as ScheduleCatalogEntryLike;
  }

  async update(input: TaskUpdateRequest): Promise<TaskView> {
    const entry = await this.findEntry(input.id);
    if (entry === undefined) throw new Error(`任务 ${input.id} 不存在`);
    if (entry.status !== "active") throw new Error("已结束的任务不可编辑");
    const currentMeta = this.meta.ensure(entry.id, { title: entry.title });
    const title = input.title?.trim();
    const prompt = input.prompt?.trim();
    if (title !== undefined && title === "") throw new Error("任务名称不能为空");
    if (prompt !== undefined && prompt === "") throw new Error("提示词不能为空");
    const change = input.frequency === undefined
      ? undefined
      : toTimingChange(input.frequency);
    if (title !== undefined || prompt !== undefined || change !== undefined) {
      const request: ScheduleUpdateRequestLike = {
        sessionId: entry.sessionId,
        id: entry.id,
        expected: recordOf(entry),
        ...(title === undefined ? {} : { title }),
        ...(prompt === undefined ? {} : { prompt }),
        ...(change === undefined ? {} : { change }),
      };
      const result = await this.ctx.schedule.update(request);
      if (!("record" in result)) {
        const code = (result as { code?: string }).code ?? "更新失败";
        throw new Error(`官方 Schedule 拒绝更新：${code}`);
      }
    }
    if (input.endsAt !== undefined) {
      currentMeta.endsAt = input.endsAt === null ? undefined : normalizeEndsAt(input.endsAt, frequencyOf(entry));
      if (input.endsAt === null) delete currentMeta.endsAt;
    }
    if (input.notify !== undefined) currentMeta.notify = input.notify;
    if (input.builtin !== undefined) {
      if (input.builtin) currentMeta.builtin = true;
      else delete currentMeta.builtin;
    }
    if (input.model !== undefined) {
      if (input.model === null) delete currentMeta.model;
      else {
        await this.applyModel(entry.sessionId as SessionId, input.model);
        currentMeta.model = input.model;
      }
    }
    currentMeta.title = (title ?? entry.title);
    this.meta.flush();
    await this.refresh();
    const updated = this.catalogCache.find(x => x.id === entry.id);
    return this.toView(updated ?? entry);
  }

  async delete(id: string): Promise<void> {
    const paused=this.protection.data.defaults.find(x=>x.taskId===id&&x.pausedTask);
    if(paused){delete paused.pausedTask;this.protection.save();}
    const entry = await this.findEntry(id);
    if (entry === undefined) {
      this.meta.remove(id);
      this.protection.forget(id);
      return;
    }
    await this.ctx.schedule.delete({ sessionId: entry.sessionId, id: entry.id });
    this.protection.forget(id);
    this.meta.remove(id);
    await this.refresh();
  }

  defaults(): {defaults: Array<{key:string; title:string; taskId:string; definition:TaskCreateRequest}>; warnings:string[]} {
    return {defaults:this.protection.data.defaults.map(x=>({key:x.key,title:x.task.title,taskId:x.taskId,definition:this.requestOf(x.task,this.workspaceFor(x.task))})),warnings:[...this.protectionWarnings]};
  }

  restoreDefaults(): Promise<{restored:number}> {
    const run=this.resetChain.then(async()=>{
      await this.refresh();
      if(this.protection.data.defaults.length===0)throw new Error('尚未登记预置基线，请先由集成方创建 builtin 任务');
      this.protection.backup(this.catalogCache.map(x=>this.toView(x)));
      let restored=0;
      for(const baseline of this.protection.data.defaults){
        const task=baseline.task,existing=this.catalogCache.find(x=>x.id===baseline.taskId);
        if(baseline.pausedTask){
          baseline.pausedTask={...task,id:baseline.taskId,status:'paused'};this.protection.save();
        }else if(existing?.status==='active'){
          await this.update({id:existing.id,title:task.title,prompt:task.prompt,frequency:task.frequency,endsAt:task.endsAt??null,notify:task.notify,builtin:true,model:task.model??null});
        }else{
          const workspaceId=this.workspaceFor(task);
          if(!workspaceId)throw new Error(`「${task.title}」原工作区不可用`);
          const entry=await this.createOfficial(this.requestOf(task,workspaceId),baseline.taskId);
          this.protection.rebind(baseline.taskId,entry.id);
          await this.refresh();
        }
        restored++;
      }
      return{restored};
    });
    this.resetChain=run.catch(()=>{});return run;
  }

  async pause(id: string): Promise<void> {
    await this.refresh();
    const baseline=this.protection.data.defaults.find(x=>x.taskId===id);
    if(!baseline)throw new Error('仅预置任务支持暂停');
    if(baseline.pausedTask)return;
    const entry=this.catalogCache.find(x=>x.id===id);
    if(!entry)throw new Error('任务已不存在，请先恢复默认配置');
    const snapshot=this.toView(entry);
    baseline.pausedTask={...snapshot,...(this.workspaceFor(snapshot)?{workspaceId:this.workspaceFor(snapshot)}:{})};
    this.protection.forget(id);this.protection.save();
    await this.ctx.schedule.delete({sessionId:entry.sessionId,id});
    await this.refresh();
  }

  resume(id: string): Promise<void> {
    const run=this.resetChain.then(async()=>{
      const baseline=this.protection.data.defaults.find(x=>x.taskId===id);
      if(!baseline?.pausedTask)return;
      const task=baseline.pausedTask,workspaceId=this.workspaceFor(task);
      if(!workspaceId)throw new Error('原工作区不可用，任务仍保持暂停');
      const entry=await this.createOfficial(this.requestOf(task,workspaceId),id);
      delete baseline.pausedTask;
      this.protection.rebind(id,entry.id);
      await this.refresh();
    });
    this.resetChain=run.catch(()=>{});return run;
  }

  private workspaceFor(task: Pick<TaskView,'workspaceId'|'sessionId'>): string|undefined {
    const registry=this.ctx.workspaceRegistry;
    if(!registry)return task.workspaceId;
    const rows=registry.list();
    if(task.workspaceId && rows.some(x=>x.id===task.workspaceId))return task.workspaceId;
    return rows.find(x=>x.sessionIds.includes(task.sessionId))?.id;
  }

  private requestOf(task: TaskView, workspaceId?:string): TaskCreateRequest {
    return {title:task.title,prompt:task.prompt,frequency:task.frequency,...(workspaceId?{workspaceId}:{}),notify:task.notify,...(task.endsAt!==undefined?{endsAt:task.endsAt}:{}),...(task.agentPreset?{agentPreset:task.agentPreset}:{}),...(task.model?{model:task.model}:{}),...(task.builtin?{builtin:true}:{})};
  }

  async deleteInactive(): Promise<number> {
    const result = await this.ctx.schedule.deleteInactive();
    await this.refresh();
    return result.deleted;
  }

  /** 立即执行：走官方队列（mode:queue），不创建新的 Schedule 记录。 */
  async runNow(id: string): Promise<void> {
    const entry = await this.findEntry(id);
    if (entry === undefined) throw new Error(`任务 ${id} 不存在`);
    if (entry.status !== "active") throw new Error("已结束的任务不可执行");
    await this.ctx.sessionController.prompt({
      requestId: `scheduled-send-${Date.now().toString(36)}-${entry.id.slice(-6)}`,
      sessionId: entry.sessionId,
      mode: "queue",
      content: [{ type: "text", text: entry.prompt }],
    }, new AbortController().signal);
  }

  async history(request: TaskHistoryRequest): Promise<TaskHistoryPage> {
    const limit = Math.min(100, Math.max(1, Math.trunc(request.limit ?? 20)));
    const result = await this.ctx.schedule.history({
      sessionId: request.sessionId as SessionId,
      id: request.id,
      limit,
      ...(request.before === undefined ? {} : { before: request.before as never }),
    });
    if ("records" in result) {
      return {
        records: result.records.map(receiptOf),
        ...(result.nextBefore === undefined ? {} : { nextBefore: String(result.nextBefore) }),
        ...(result.earlierRecordsUnavailable === undefined ? {} : { earlierRecordsUnavailable: result.earlierRecordsUnavailable }),
      };
    }
    throw new Error((result as { message?: string }).message ?? "读取投递历史失败");
  }

  /** 当前 catalog 快照（页面/诊断用）。 */
  snapshot(): TaskView[] {
    return this.catalogCache.map(entry => this.toView(entry));
  }

  private async findEntry(id: string): Promise<ScheduleCatalogEntryLike | undefined> {
    await this.refresh();
    return this.catalogCache.find(entry => entry.id === id);
  }

  private async resolveTarget(input: TaskCreateRequest): Promise<{
    sessionId: SessionId;
    workspaceId?: string;
    sessionTitle?: string;
  }> {
    if (input.sessionId !== undefined && input.sessionId !== "") {
      const sessionId = input.sessionId as SessionId;
      const existing = this.ctx.sessions?.get?.(sessionId);
      if (existing === undefined && this.ctx.sessions?.get !== undefined) {
        throw new Error(`会话 ${input.sessionId} 不存在`);
      }
      return { sessionId, sessionTitle: existing?.header?.title };
    }
    if (input.workspaceId === undefined || input.workspaceId === "") {
      throw new Error("请选择工作区，或指定一个现有会话");
    }
    const created = await this.ctx.sessionController.create({
      workspaceId: input.workspaceId as WorkspaceId,
      ...(input.agentPreset === undefined || input.agentPreset === "" ? {} : { agentPreset: input.agentPreset }),
    });
    const title = input.title.trim();
    try {
      await this.ctx.sessionController.rename({ sessionId: created.sessionId, title });
    } catch (e) {
      this.ctx.logger?.warn?.(`[dsh-scheduled-send] 任务会话命名失败（不影响调度）：${String((e as Error)?.message ?? e)}`);
    }
    // 建完就命名、却没有一轮对话 ⇒ 这是宿主的「空白会话」。必须立刻退出工作区成员席位，
    // 否则它会被 web 端「新会话」当成可复用空白会话抢走（详见 releaseSeat 注释）。
    await this.releaseSeat(created.sessionId, input.workspaceId);
    return {
      sessionId: created.sessionId,
      workspaceId: input.workspaceId,
      sessionTitle: title,
    };
  }

  /**
   * 让任务会话退出工作区成员席位（工作区列表里不再出现，web「新会话」也不再选中它）。
   *
   * 为什么必须这么做（2026-10-28 生产实证）：宿主 web 的「新会话」会把该工作区
   * **第一个空白会话**交给 `session.create` 复用 —— 见 deepseek-harness
   * `packages/client/ui-workspace/src/client/navigation.ts:243`（`createInWorkspace`）
   * 与 `packages/api/session-controller/src/agent.ts:399`（`reuseLive`：`isBlank` 即可复用）。
   * 插件为任务新建的会话恰好同时满足「成员 + 没有 turn/start」，又已被 rename 钉住标题
   * ⇒ 用户每点一次「新会话」，拿到的是叫「月报-月度总结」的任务会话。
   * 空白度是宿主内部状态，插件无法清除；能动的只有成员席位，所以退席。
   */
  private async releaseSeat(sessionId: SessionId, workspaceId?: string): Promise<void> {
    const registry = this.ctx.workspaceRegistry;
    if (registry?.get === undefined || workspaceId === undefined || workspaceId === "") return;
    const workspace = registry.get(workspaceId as WorkspaceId);
    if (workspace === undefined) return;
    try {
      await workspace.detachSession(sessionId);
    } catch (e) {
      this.ctx.logger?.warn?.(`[dsh-scheduled-send] 任务会话退出工作区列表失败（不影响调度）：${String((e as Error)?.message ?? e)}`);
    }
  }

  /**
   * 任务会话被真正使用过之后挂回工作区：此时它已有真实轮次（不再空白），
   * 不可能被「新会话」复用，用户也能像以前一样在列表里点开看历史。
   */
  private async reclaimSeat(sessionId: SessionId, taskId: string): Promise<void> {
    const registry = this.ctx.workspaceRegistry;
    if (registry?.get === undefined) return;
    const entry = this.catalogCache.find(x => x.id === taskId);
    if (entry === undefined || entry.sessionId !== sessionId) return;
    const workspaceId = this.workspaceFor(this.toView(entry));
    if (workspaceId === undefined) return;
    const workspace = registry.get(workspaceId as WorkspaceId);
    if (workspace === undefined) return;
    try {
      await workspace.attachSession(sessionId);
    } catch (e) {
      this.ctx.logger?.warn?.(`[dsh-scheduled-send] 任务会话挂回工作区失败（不影响调度）：${String((e as Error)?.message ?? e)}`);
    }
  }

  /**
   * 一次性迁移（0.10.7）：旧版本建的任务会话仍是工作区里的空白成员，继续会被
   * 「新会话」抢走。只处理「插件建过（meta 有 sessionTitle）且从未投递过」的会话；
   * 已投递的会话有真实轮次，既不会被复用，也不该被摘掉。
   */
  private async releaseStubSeats(entries: readonly ScheduleCatalogEntryLike[]): Promise<void> {
    for (const entry of entries) {
      const meta = this.meta.get(entry.id);
      if (meta?.sessionTitle === undefined) continue;
      if (entry.lastDelivery !== undefined || meta.lastExecution !== undefined) continue;
      await this.releaseSeat(entry.sessionId, this.workspaceFor(this.toView(entry)));
    }
  }

  /** 对目标会话应用模型；官方语义 = 同时更新全局默认模型（与手动切换一致）。失败即抛出，不建半坏任务。 */
  private async applyModel(sessionId: SessionId, model: ModelRef): Promise<void> {
    if (this.ctx.sessionController.selectModel === undefined) {
      throw new Error("宿主不支持指定模型（sessionController.selectModel 不可用）");
    }
    try {
      await this.ctx.sessionController.selectModel({ sessionId, provider: model.provider, model: model.model });
    } catch (e) {
      throw new Error(`设置模型 ${model.provider}/${model.model} 失败：${String((e as Error)?.message ?? e)}`);
    }
  }

  private toView(entry: ScheduleCatalogEntryLike): TaskView {
    const meta = this.meta.ensure(entry.id, { title: entry.title });
    return {
      id: entry.id,
      title: entry.title,
      prompt: entry.prompt,
      sessionId: String(entry.sessionId),
      ...(meta.sessionTitle === undefined ? {} : { sessionTitle: meta.sessionTitle }),
      ...(meta.workspaceId === undefined ? {} : { workspaceId: meta.workspaceId }),
      frequency: frequencyOf(entry),
      scheduledAt: entry.scheduledAt,
      status: entry.status,
      ...(meta.endsAt === undefined ? {} : { endsAt: meta.endsAt }),
      notify: meta.notify,
      ...(meta.agentPreset === undefined ? {} : { agentPreset: meta.agentPreset }),
      ...(meta.model === undefined ? {} : { model: meta.model }),
      ...(meta.builtin === true ? { builtin: true } : {}),
      createdAt: meta.createdAt,
      ...(entry.lastDelivery === undefined ? {} : { lastDelivery: receiptOf(entry.lastDelivery) }),
      ...(meta.lastExecution === undefined ? {} : { lastExecution: meta.lastExecution }),
    };
  }

  /** 截止时间只对重复任务生效；到期后删除官方任务（官方没有 pause/end 字段）。 */
  private armValidity(): void {
    for (const timer of this.validityTimers.values()) clearTimeout(timer);
    this.validityTimers.clear();
    for (const entry of this.catalogCache) {
      if (entry.status !== "active") continue;
      const meta = this.meta.get(entry.id);
      if (meta?.endsAt === undefined) continue;
      const remaining = meta.endsAt - Date.now();
      if (remaining <= 0) {
        void this.expire(entry);
        continue;
      }
      this.armOne(entry.id, remaining);
    }
  }

  private armOne(id: string, remaining: number): void {
    const chunk = Math.min(remaining, 2_147_000_000);
    const timer = setTimeout(() => {
      this.validityTimers.delete(id);
      const left = (this.meta.get(id)?.endsAt ?? 0) - Date.now();
      if (left > 0) {
        this.armOne(id, left);
        return;
      }
      const entry = this.catalogCache.find(x => x.id === id);
      if (entry !== undefined && entry.status === "active") void this.expire(entry);
    }, chunk);
    timer.unref?.();
    this.validityTimers.set(id, timer);
  }

  private async expire(entry: ScheduleCatalogEntryLike): Promise<void> {
    try {
      await this.ctx.schedule.delete({ sessionId: entry.sessionId, id: entry.id });
      this.meta.remove(entry.id);
      this.ctx.logger?.info?.(`[dsh-scheduled-send] 到期结束：${entry.title}`);
      await this.refresh();
    } catch (e) {
      this.ctx.logger?.warn?.(`[dsh-scheduled-send] 到期删除失败（下次启动重试）：${String((e as Error)?.message ?? e)}`);
    }
  }

  /**
   * 观察官方投递 → 找到对应的模型轮次 → 在 turn/end 记录执行结果。
   *
   * 判据只读结构化事件：`user/message.source.kind === 'schedule'` 证明这轮由
   * 定时任务触发；任务 id 从官方 framing 里读取；不解析模型输出做业务判断。
   */
  private onSessionEvent(session: unknown, event: unknown): void {
    const sessionId = String((session as { id?: unknown } | undefined)?.id ?? "");
    if (sessionId === "") return;
    const e = event as { type?: unknown; data?: unknown } | undefined;
    const type = typeof e?.type === "string" ? e.type : "";
    const data = (e?.data ?? {}) as Record<string, unknown>;
    if (type === "turn/start") {
      const turn = numberOrUndefined(data.turn);
      if (turn !== undefined) {
        this.currentTurn.set(sessionId, turn);
        this.turnStartedAt.set(sessionId, Date.now());
        this.lastAssistantText.delete(sessionId);
      }
      // 会话已经有了真实轮次 ⇒ 不再是「空白会话」，可以挂回工作区（见 releaseSeat）。
      // 只在这一步挂回，避免「投递已排队但 turn 还没开始」的空窗期把它重新变成可复用空白会话。
      for (const entry of this.catalogCache) {
        if (entry.sessionId === sessionId) void this.reclaimSeat(sessionId, entry.id);
      }
      return;
    }
    if (type === "user/message") {
      // 上游事件载荷差异（2026-10-26 生产会话日志实证）：`user/message` 的
      // content/source 直接挂在 data 下；`assistant/message` 才有 data.message 包裹。
      const message = (data.message ?? data) as { content?: unknown; source?: { kind?: unknown } } | undefined;
      if (message?.source?.kind !== "schedule") return;
      const text = textOf(message.content);
      const ids = parseScheduleIds(text);
      if (ids.length === 0) return;
      const existing = this.pending.get(sessionId);
      const pending: PendingExecution = existing ?? {
        turn: this.currentTurn.get(sessionId),
        taskIds: new Set<string>(),
        startedAt: this.turnStartedAt.get(sessionId) ?? Date.now(),
      };
      for (const id of ids) pending.taskIds.add(id);
      this.pending.set(sessionId, pending);
      return;
    }
    if (type === "assistant/message") {
      const message = data.message as { content?: unknown } | undefined;
      const text = textOf(message?.content);
      if (text !== "") this.lastAssistantText.set(sessionId, text);
      return;
    }
    if (type !== "turn/end") return;
    const pending = this.pending.get(sessionId);
    if (pending === undefined) return;
    const turn = numberOrUndefined(data.turn);
    if (pending.turn !== undefined && turn !== undefined && pending.turn !== turn) return;
    this.pending.delete(sessionId);
    const reason = data.reason as { kind?: unknown; error?: { message?: unknown; code?: unknown } } | undefined;
    const status = statusOf(reason?.kind);
    if (status === undefined) return;
    const endedAt = Date.now();
    const summary = truncateText(this.lastAssistantText.get(sessionId) ?? "", EXECUTION_SUMMARY_MAX);
    const errorText = stringOrUndefined(reason?.error?.message) ?? stringOrUndefined(reason?.error?.code);
    const record: ExecutionRecord = {
      status,
      at: endedAt,
      durationMs: Math.max(0, endedAt - pending.startedAt),
      ...(summary === "" ? {} : { summary }),
      ...(errorText === undefined ? {} : { error: errorText }),
    };
    const titles: string[] = [];
    for (const id of pending.taskIds) {
      const meta = this.meta.set(id, { lastExecution: record });
      titles.push(meta.title ?? this.catalogCache.find(x => x.id === id)?.title ?? id);
    }
    const payload: ExecutionUpdate = {
      taskIds: [...pending.taskIds],
      sessionId,
      status,
      startedAt: pending.startedAt,
      endedAt,
      durationMs: record.durationMs,
      ...(summary === "" ? {} : { summary }),
      ...(errorText === undefined ? {} : { error: errorText }),
    };
    this.lastAssistantText.delete(sessionId);
    this.turnStartedAt.delete(sessionId);
    this.currentTurn.delete(sessionId);
    try {
      this.onExecution?.(payload);
    } catch { /* 观察者不得影响会话主流程 */ }
    console.log(`[dsh-scheduled-send] 执行${status === "success" ? "完成" : "结束"}：${titles.join("、") || sessionId}`);
  }

  /** 供 index.ts 接日志/诊断；不参与通知送达。 */
  onExecution?: (update: ExecutionUpdate) => void;

  get versionString(): string {
    return this.version;
  }
}

function toCreateRequest(frequency: Frequency, title: string, prompt: string): ScheduleCreateRequestLike {
  const base: ScheduleCreateRequestLike = { title, prompt };
  switch (frequency.kind) {
    case "once": return { ...base, at: frequency.at };
    case "after": return { ...base, after_seconds: frequency.afterSeconds };
    case "every": return { ...base, every_seconds: frequency.seconds };
    case "daily": return { ...base, daily: { time: frequency.time, time_zone: frequency.timeZone } };
    case "weekly": return { ...base, weekly: { time: frequency.time, time_zone: frequency.timeZone, weekdays: frequency.weekdays } };
    case "cron": return { ...base, cron: { expression: frequency.expression, time_zone: frequency.timeZone } };
  }
}

function toTimingChange(frequency: Frequency): NonNullable<ScheduleUpdateRequestLike["change"]> {
  switch (frequency.kind) {
    case "once": return { kind: "at", at: frequency.at };
    case "every": return { kind: "every", every_seconds: frequency.seconds };
    case "daily": return { kind: "daily", daily: { time: frequency.time, time_zone: frequency.timeZone } };
    case "weekly": return { kind: "weekly", weekly: { time: frequency.time, time_zone: frequency.timeZone, weekdays: frequency.weekdays } };
    case "cron": return { kind: "cron", cron: { expression: frequency.expression, time_zone: frequency.timeZone } };
    case "after": throw new Error("官方 Schedule 不支持把任务更新为相对延迟；请选择绝对时刻");
  }
}

function frequencyOf(record: Pick<ScheduleRecordLike, "kind"> & Record<string, unknown>): Frequency {
  switch (record.kind) {
    case "after": return { kind: "after", afterSeconds: Number(record.afterSeconds ?? 0) };
    case "at": return { kind: "once", at: String(record.scheduledAt ?? "") };
    case "every": return { kind: "every", seconds: Number(record.everySeconds ?? 60) };
    case "daily": return { kind: "daily", time: String(record.time ?? "00:00:00"), timeZone: String(record.timeZone ?? "UTC") };
    case "weekly": return {
      kind: "weekly",
      time: String(record.time ?? "00:00:00"),
      timeZone: String(record.timeZone ?? "UTC"),
      weekdays: Array.isArray(record.weekdays) ? record.weekdays.map(Number) : [1],
    };
    case "cron": return { kind: "cron", expression: String(record.expression ?? "0 0 * * *"), timeZone: String(record.timeZone ?? "UTC") };
    default: return { kind: "once", at: String(record.scheduledAt ?? "") };
  }
}

function recordOf(entry: ScheduleCatalogEntryLike): ScheduleRecordLike {
  const { sessionId: _sessionId, status: _status, lastDelivery: _lastDelivery, ...record } = entry;
  return record as ScheduleRecordLike;
}

function receiptOf(receipt: { scheduledAt: string; deliveredAt: string; messageId: unknown }): DeliveryReceipt {
  return {
    scheduledAt: receipt.scheduledAt,
    deliveredAt: receipt.deliveredAt,
    messageId: String(receipt.messageId),
  };
}

function normalizeEndsAt(value: number | undefined, frequency: Frequency): number | undefined {
  if (value === undefined || frequency.kind === "once" || frequency.kind === "after") return undefined;
  if (!Number.isFinite(value)) throw new Error("截止时间必须是毫秒时间戳");
  const now = Date.now();
  if (value <= now) throw new Error("截止时间必须晚于当前时间");
  if (value > now + MAX_VALIDITY_DAYS * 86_400_000) throw new Error("截止时间过远（最多 10 年）");
  return Math.floor(value);
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map(block => (block as { type?: unknown; text?: unknown } | undefined)?.type === "text"
      ? String((block as { text?: unknown }).text ?? "")
      : "")
    .filter(Boolean)
    .join("\n");
}

function parseScheduleIds(text: string): string[] {
  const ids = new Set<string>();
  const one = /^schedule_id_json:\s*(.+)$/m.exec(text);
  if (one?.[1] !== undefined) {
    try {
      const value: unknown = JSON.parse(one[1]);
      if (typeof value === "string" && value !== "") ids.add(value);
    } catch { /* 非本插件 framing，忽略 */ }
  }
  const batch = /^reminders_json:\s*(.+)$/m.exec(text);
  if (batch?.[1] !== undefined) {
    try {
      const value: unknown = JSON.parse(batch[1]);
      if (Array.isArray(value)) {
        for (const item of value) {
          const id = (item as { schedule_id?: unknown } | undefined)?.schedule_id;
          if (typeof id === "string" && id !== "") ids.add(id);
        }
      }
    } catch { /* 忽略 */ }
  }
  return [...ids];
}

function statusOf(kind: unknown): ExecutionStatus | undefined {
  switch (kind) {
    case undefined:
    case "completed":
    case "success": return "success";
    case "error": return "failed";
    case "aborted": return "aborted";
    case "blocked": return "blocked";
    case "max-tokens": return "max-tokens";
    case "interrupted": return "interrupted";
    default: return undefined;
  }
}

function truncateText(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
