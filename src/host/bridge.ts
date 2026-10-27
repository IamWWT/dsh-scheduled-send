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
import { MetaStore, newTaskKey, type TaskMeta } from "./meta.ts";
import { ProtectionStore, recurring } from "./protection.ts";
import {
  EXECUTION_SUMMARY_MAX,
  MAX_VALIDITY_DAYS,
  RUN_HISTORY_LIMIT,
  RUN_HISTORY_PAGE,
} from "../shared/constants.ts";
import { perRunSessionTitle, sessionModeFor } from "../shared/types.ts";
import type {
  DeliveryReceipt,
  ExecutionRecord,
  ExecutionStatus,
  Frequency,
  ModelRef,
  RunHistoryEntry,
  RunHistoryPage,
  RunHistoryRequest,
  SessionMode,
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

/** 同一次投递最多尝试轮转几次（失败后保持原会话，等下一次投递再试）。 */
const MAX_ROTATE_ATTEMPTS = 2;

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
  /** per-run 轮转的重入闸门（同一任务同时只允许一个轮转）。 */
  private readonly rotating = new Set<string>();
  /**
   * 轮转后的 id 映射（旧 → 新）。官方任务 id 是服务端分配的，轮转必然换 id；
   * 页面拿着旧 id 点「编辑/删除/立即执行」时据此跟随到当前任务（不跨重启，够用）。
   */
  private readonly rotatedTo = new Map<string, string>();
  /**
   * 暂无归属的运行结果缓冲（0.10.9）。
   *
   * 投递记录是**刷新**时从官方回执里读出来的（异步），而 `turn/end` 是会话事件（同步）。
   * 模型快速失败时（隔离 home 无凭据：30–130ms）执行结果可能早于投递记录落地，
   * 这时先缓冲，等下一次投递记录写进来再吸附——否则那条记录永远停在「投递成功」。
   * 只覆盖本进程内的错位；跨重启的错位仍只告警（历史以投递为准，不凭空建条目）。
   */
  private readonly orphanExecutions: Array<{ sessionId: string; execution: ExecutionRecord }> = [];
  /**
   * 手动「立即执行」在跑的会话（会话 → 待填写的运行记录）。
   *
   * 定时投递有官方 framing（`source.kind='schedule'` + `schedule_id_json`）可以归因，
   * 手动执行走的是普通 `prompt`，没有 framing；只能按「这个会话里刚发起的那个请求」记录，
   * 下一个没有 framing 的 `turn/end` 就归给它。同一会话以最后一次手动执行为准。
   */
  private readonly manualPending = new Map<string, { taskKey: string; at: number; title?: string }>();
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
    // 对账时刻必须取在**第一次读官方目录之前**：本次刷新读到快照之后并发写进来的元数据
    // （新建任务、轮转新任务）不在快照里，但也不是「官方已删」——按写入时刻保留。
    // 0.10.9 实测：取在读取之后会把 `create()` 刚写的 builtin/sessionMode 判成过期行删掉。
    const snapshotAt = Date.now();
    let entries = await this.ctx.schedule.catalog();
    // A persisted pause is an intent to disarm. Finish it after an interrupted
    // process before exposing the paused row; never run a second scheduler.
    for(const baseline of this.protection.data.defaults){
      if(!baseline.pausedTask)continue;
      if(this.protection.data.moves[baseline.taskId]){
        const task=baseline.pausedTask,workspaceId=this.workspaceFor(task);
        if(!workspaceId)throw new Error(`「${task.title}」恢复任务的工作区不可用，配置已保留`);
        const resumed=await this.createOfficial(this.requestOf(task,workspaceId),baseline.taskId);
        this.carryTaskKey(resumed.id, task.taskKey);
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
        this.carryTaskKey(restored.id, task.taskKey);
        this.protection.rebind(task.id,restored.id);
      }catch(error){
        const warning=`周期任务「${task.title}」归档迁移失败，配置已保留：${String((error as Error)?.message??error)}`;
        this.protectionWarnings.push(warning);this.ctx.logger?.warn?.(warning);
      }
    }
    entries=await this.ctx.schedule.catalog();
    // 0.10.9：投递一落地就把「哪次投递进了哪个会话」记进运行历史。
    // 必须在轮转**之前**做——轮转后任务指向新会话、旧官方行已删，投递回执与接收会话就丢了。
    this.recordDeliveries(entries);
    // 0.10.8 per-run：先收尾崩溃留下的半截交换，再对「已投递但还没轮转」的任务轮转。
    // 顺序不能反：半截交换未收尾时同一任务会再轮转一次，造成重复任务、同一提示词投两次。
    if (await this.completePendingSwaps(entries)) entries = await this.ctx.schedule.catalog();
    if (await this.rotatePerRun(entries)) entries = await this.ctx.schedule.catalog();
    this.catalogCache = entries;
    const ids = new Set(entries.map(entry => entry.id));
    this.meta.reconcile(ids, this.keptMetaIds(), snapshotAt);
    let changed = false;
    for (const entry of entries) {
      const before = this.meta.get(entry.id);
      const meta = this.meta.ensure(entry.id, { title: entry.title });
      if (before === undefined || before.title !== entry.title) changed = true;
      else if (meta.title !== entry.title) {
        meta.title = entry.title;
        changed = true;
      }
      // 0.9.5 之前建的元数据没有稳定任务键：补一个（运行历史按它聚合，轮转继承）。
      if (meta.taskKey === undefined || meta.taskKey === "") {
        meta.taskKey = newTaskKey();
        changed = true;
      }
    }
    if (changed) this.meta.flush();
    // 运行历史只跟随还活着的任务键：任务被删除/清理已结束后不再留着无主的记录。
    this.meta.pruneHistories(this.liveTaskKeys());
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
    // 会话模式在创建时归一一次（单次任务固定 fixed；builtin 采集类默认 per-run）。
    const sessionMode = sessionModeFor(input);
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
      // 0.10.9：稳定任务键在创建时分配一次，此后轮转/迁移都继承（运行历史按它聚合）。
      taskKey: newTaskKey(),
      ...(target.workspaceId === undefined ? {} : { workspaceId: target.workspaceId }),
      ...(target.sessionTitle === undefined ? {} : { sessionTitle: target.sessionTitle }),
      ...(endsAt === undefined ? {} : { endsAt }),
      ...(input.agentPreset === undefined || input.agentPreset === "" ? {} : { agentPreset: input.agentPreset }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.builtin === true ? { builtin: true } : {}),
      sessionMode,
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
    if (input.sessionMode !== undefined) {
      const mode: SessionMode = input.sessionMode;
      if (mode === "per-run") {
        // 单次任务没有「下一次执行」，轮转无意义：报错而不是静默降级。
        if (!isRecurringRecord(entry)) throw new Error("单次任务不支持「每次执行新建会话」");
        currentMeta.sessionMode = "per-run";
      } else currentMeta.sessionMode = "fixed";
      // 改模式本身不触发轮转：per-run 从下一次投递之后开始换会话，fixed 立即停在当前会话。
      delete currentMeta.rotateError;
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
    const updated = this.catalogCache.find(x => x.id === entry.id) ?? this.catalogCache.find(x => x.id === this.rotatedTo.get(entry.id));
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
    this.protection.forget(entry.id);
    this.meta.remove(entry.id);
    if (entry.id !== id) {
      this.protection.forget(id);
      this.meta.remove(id);
    }
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
          this.carryTaskKey(entry.id, task.taskKey);
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
      this.carryTaskKey(entry.id, task.taskKey);
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
    return {title:task.title,prompt:task.prompt,frequency:task.frequency,...(workspaceId?{workspaceId}:{}),notify:task.notify,...(task.endsAt!==undefined?{endsAt:task.endsAt}:{}),...(task.agentPreset?{agentPreset:task.agentPreset}:{}),...(task.model?{model:task.model}:{}),...(task.builtin?{builtin:true}:{}),sessionMode:task.sessionMode??'fixed'};
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
    const requestId = `scheduled-send-${Date.now().toString(36)}-${entry.id.slice(-6)}`;
    await this.ctx.sessionController.prompt({
      requestId,
      sessionId: entry.sessionId,
      mode: "queue",
      content: [{ type: "text", text: entry.prompt }],
    }, new AbortController().signal);
    // 0.10.9：手动「立即执行」也是一次运行，同样进历史（幂等键 = manual:<requestId>）。
    // 必须在轮转之前写：轮转后 meta 换到新任务、会话也换了。
    const meta = this.meta.ensure(entry.id, { title: entry.title });
    if (meta.taskKey === undefined || meta.taskKey === "") meta.taskKey = newTaskKey();
    const manualKey = meta.taskKey;
    const manualRecord: RunHistoryEntry = {
      at: Date.now(),
      sessionId: String(entry.sessionId),
      ...(meta.sessionTitle === undefined ? {} : { sessionTitle: meta.sessionTitle }),
      messageId: `manual:${requestId}`,
      reason: "manual-run",
    };
    const appendedManual = this.appendRunSafe(`记录「${entry.title}」的手动执行历史`, manualKey, manualRecord);
    if (appendedManual) {
      // 手动执行没有官方 framing：登记下这次请求，等这个会话的下一个 turn/end 归因。
      this.manualPending.set(String(entry.sessionId), {
        taskKey: manualKey,
        at: manualRecord.at,
        ...(meta.title === undefined ? {} : { title: meta.title }),
      });
    }
    // per-run：手动执行也是一次「用掉了这个会话」，同样轮转（否则下一次定时投递会追加到手动那次的会话里）。
    // 手动执行没有官方投递回执，用 requestId 当幂等键。轮转失败不影响已投递的消息，只记录可见提示。
    if (this.meta.get(entry.id)?.sessionMode !== "per-run" || !isRecurringRecord(entry)) return;
    if (this.rotating.has(entry.id)) return;
    this.rotating.add(entry.id);
    try {
      await this.rotateOne(entry, `manual:${requestId}`);
      await this.refresh();
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      this.meta.set(entry.id, { rotateError: { at: Date.now(), message } });
      this.ctx.logger?.warn?.(`[dsh-scheduled-send] 「${entry.title}」手动执行后新建会话失败：${message}`);
    } finally {
      this.rotating.delete(entry.id);
    }
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

  /**
   * 插件自持的运行历史（0.10.9）：跨 per-run 轮转、跨重启、跨官方任务 id 变化的等价记录。
   *
   * 官方 `history()` 在轮转后会随旧任务一起消失，所以页面主视图用这份；`fixed` 任务想看
   * 官方原始回执仍可走 `history()`（未删减，两者并存不冲突）。
   */
  async runHistory(request: RunHistoryRequest): Promise<RunHistoryPage> {
    const entry = await this.findEntry(request.id);
    if (entry === undefined) throw new Error(`任务 ${request.id} 不存在`);
    const meta = this.meta.ensure(entry.id, { title: entry.title });
    const taskKey = meta.taskKey ?? this.taskKeyOf(entry.id);
    const history = this.meta.historyOf(taskKey);
    const limit = Math.min(RUN_HISTORY_LIMIT, Math.max(1, Math.trunc(request.limit ?? RUN_HISTORY_PAGE)));
    return {
      entries: history.entries.slice(0, limit),
      dropped: history.dropped,
      limit: RUN_HISTORY_LIMIT,
      total: history.entries.length,
    };
  }

  /** 当前 catalog 快照（页面/诊断用）。 */
  snapshot(): TaskView[] {
    return this.catalogCache.map(entry => this.toView(entry));
  }

  private async findEntry(id: string): Promise<ScheduleCatalogEntryLike | undefined> {
    await this.refresh();
    const direct = this.catalogCache.find(entry => entry.id === id);
    if (direct !== undefined) return direct;
    // 页面手里的 id 可能已被 per-run 轮转换掉（官方任务 id 由服务端分配）。
    const rotated = this.rotatedTo.get(id);
    return rotated === undefined ? undefined : this.catalogCache.find(entry => entry.id === rotated);
  }

  /** 记下轮转关系的 id 迁移（只保留最近若干条，避免长期运行无限增长）。 */
  private rememberRotation(oldId: string, newId: string): void {
    this.rotatedTo.set(oldId, newId);
    while (this.rotatedTo.size > 200) {
      const oldest = this.rotatedTo.keys().next();
      if (oldest.done === true) break;
      this.rotatedTo.delete(oldest.value);
    }
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
    // per-run：任务会话名带上建立时刻，一眼能分清「哪天的那个会话」（0.10.8）。
    const sessionTitle = sessionModeFor(input) === "per-run"
      ? perRunSessionTitle(title, Date.now())
      : title;
    try {
      await this.ctx.sessionController.rename({ sessionId: created.sessionId, title: sessionTitle });
    } catch (e) {
      this.ctx.logger?.warn?.(`[dsh-scheduled-send] 任务会话命名失败（不影响调度）：${String((e as Error)?.message ?? e)}`);
    }
    // 建完就命名、却没有一轮对话 ⇒ 这是宿主的「空白会话」。必须立刻退出工作区成员席位，
    // 否则它会被 web 端「新会话」当成可复用空白会话抢走（详见 releaseSeat 注释）。
    await this.releaseSeat(created.sessionId, input.workspaceId);
    return {
      sessionId: created.sessionId,
      workspaceId: input.workspaceId,
      sessionTitle,
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
   * per-run 轮转走的会话（meta.lastRunSessionId）在出现真实轮次后挂回工作区。
   * 与 reclaimSeat 同口径：只挂回、不建；找不到工作区就跳过。
   */
  private async reclaimRotatedSeat(sessionId: SessionId): Promise<void> {
    const registry = this.ctx.workspaceRegistry;
    if (registry?.get === undefined) return;
    for (const id of this.meta.ids()) {
      const meta = this.meta.get(id);
      if (meta === undefined) continue;
      if (meta.lastRunSessionId !== sessionId && meta.runSessionIds?.includes(sessionId) !== true) continue;
      const entry = this.catalogCache.find(x => x.id === id);
      const workspaceId = meta.workspaceId ?? (entry === undefined ? undefined : this.workspaceFor(this.toView(entry)));
      if (workspaceId === undefined) continue;
      const workspace = registry.get(workspaceId as WorkspaceId);
      if (workspace === undefined) continue;
      try {
        await workspace.attachSession(sessionId);
      } catch (e) {
        this.ctx.logger?.warn?.(`[dsh-scheduled-send] 执行过的轮转会话挂回工作区失败（不影响调度）：${String((e as Error)?.message ?? e)}`);
      }
      return;
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

  /**
   * per-run（0.10.8）：每次投递完成后把任务重指到一个新会话。
   *
   * 官方 Schedule 的任务行只存一个 `sessionId`，且公开 `update` **不能改绑定**
   *（`ScheduleUpdateRequest` 只有 title/prompt/change，`expected` 里带 sessionId 只作身份校验；
   * 见 `deepseek-harness/packages/schedule/schedule/src/types.ts:424` 与 `update.ts`）。
   * 所以「重指」只能等价为「删旧建新」：轮转时建新会话 → 建新任务 → 删旧任务。
   *
   * 幂等：判据是官方 `lastDelivery.messageId`，已轮转过的那条记在 meta.rotatedFrom；
   * 同一个 messageId 绝不轮转第二次（刷新由 UI 轮询/schedule/changed 反复触发，必须幂等）。
   */
  private async rotatePerRun(entries: readonly ScheduleCatalogEntryLike[]): Promise<boolean> {
    let changed = false;
    for (const entry of entries) {
      if (this.stopped) return changed;
      if (entry.status !== "active") continue;
      // 一次性任务投递后即 inactive，没有「下一次」，不轮转。
      if (!isRecurringRecord(entry)) continue;
      if (this.meta.get(entry.id)?.sessionMode !== "per-run") continue;
      const delivery = entry.lastDelivery;
      if (delivery === undefined) continue;
      const messageId = String(delivery.messageId ?? "");
      if (messageId === "") continue;
      if (this.meta.get(entry.id)?.rotatedFrom === messageId) continue;
      // 刷新很频繁：同一次投递最多试 MAX_ROTATE_ATTEMPTS 次，避免失败时每 5 秒重建会话。
      const attempts = this.meta.get(entry.id)?.rotateAttempts;
      const tried = attempts?.messageId === messageId ? attempts.count : 0;
      if (tried >= MAX_ROTATE_ATTEMPTS) continue;
      if (this.rotating.has(entry.id)) continue;
      this.rotating.add(entry.id);
      try {
        await this.rotateOne(entry, messageId);
        changed = true;
      } catch (error) {
        const message = String((error as Error)?.message ?? error);
        // 失败必须可见：任务留在原会话继续按周期执行，页面显示原因，不静默。
        this.meta.set(entry.id, {
          rotateError: { at: Date.now(), message },
          rotateAttempts: { messageId, count: tried + 1 },
        });
        // 失败必须留痕：页面显示 rotateError，journal 里也要能查到（logger 在部分宿主组合里不存在）。
        console.warn(`[dsh-scheduled-send] 「${entry.title}」新建会话失败，任务保持原会话（第 ${tried + 1} 次）：${message}`);
      } finally {
        this.rotating.delete(entry.id);
      }
    }
    return changed;
  }

  /** 单个任务的轮转：新会话 → 新官方任务 → 删旧官方任务（先建后删 = 失败也不丢任务）。 */
  private async rotateOne(entry: ScheduleCatalogEntryLike, messageId: string): Promise<void> {
    const view = this.toView(entry);
    const workspaceId = this.workspaceFor(view);
    if (workspaceId === undefined) throw new Error("找不到任务所在工作区，无法新建会话");
    const oldSessionId = String(entry.sessionId);
    const newSession = await this.ctx.sessionController.create({
      workspaceId: workspaceId as WorkspaceId,
      ...(view.agentPreset === undefined || view.agentPreset === "" ? {} : { agentPreset: view.agentPreset }),
    });
    const newSessionId = newSession.sessionId;
    const newTitle = perRunSessionTitle(entry.title, Date.now());
    try {
      await this.ctx.sessionController.rename({ sessionId: newSessionId, title: newTitle });
    } catch (e) {
      this.ctx.logger?.warn?.(`[dsh-scheduled-send] 轮转会话命名失败（不影响调度）：${String((e as Error)?.message ?? e)}`);
    }
    // 与首次建会话一致：新会话立即退席，避免被 web「新会话」当成可复用空白会话。
    await this.releaseSeat(newSessionId, workspaceId);
    if (view.model !== undefined) await this.applyModel(newSessionId, view.model);
    // 半截交换标记：进程若在下面两步之间退出，下次刷新据此删掉旧任务（见 completePendingSwaps）。
    this.meta.set(entry.id, { pendingSwap: { newSessionId: String(newSessionId), messageId, at: Date.now() } });
    let created: ScheduleRecordLike;
    try {
      created = await this.ctx.schedule.create(
        newSessionId,
        toCreateRequest(frequencyOf(entry), entry.title, entry.prompt),
      );
    } catch (error) {
      this.meta.set(entry.id, { pendingSwap: undefined });
      throw new Error(`新建官方任务失败（原任务未改动）：${String((error as Error)?.message ?? error)}`);
    }
    this.meta.set(created.id, this.carriedMeta(entry, {
      sessionTitle: newTitle,
      lastRunSessionId: oldSessionId,
      lastRunSessionTitle: view.sessionTitle,
      rotatedFrom: messageId,
    }));
    try {
      const deletion = await this.ctx.schedule.delete({ sessionId: oldSessionId as SessionId, id: entry.id });
      if (deletion.deleted !== true) throw new Error(deletion.code ?? "未知原因");
    } catch (error) {
      // 删旧失败 → 回滚新增的那条，任务回到「原会话 + 原配置」，不留重复任务。
      try {
        await this.ctx.schedule.delete({ sessionId: newSessionId, id: created.id });
      } catch { /* 回滚失败也要继续报告 */ }
      this.meta.remove(created.id);
      this.meta.set(entry.id, { pendingSwap: undefined });
      throw new Error(`切换任务会话失败，已保留原任务：${String((error as Error)?.message ?? error)}`);
    }
    const next = this.meta.get(created.id);
    if (next !== undefined) next.pendingSwap = undefined;
    this.meta.remove(entry.id);
    // 任务身份变了：预置基线/周期快照必须跟着改，否则「恢复默认」「归档迁移」认不到它。
    this.protection.rebind(entry.id, created.id);
    this.rememberRotation(entry.id, created.id);
    console.log(`[dsh-scheduled-send] 「${entry.title}」已轮转到新会话：${newTitle}（上一次执行会话 ${oldSessionId}）`);
  }

  /**
   * 收尾崩溃留下的半截交换：meta.pendingSwap 存在 = 上次「建新任务 → 删旧任务」没走完。
   * 新任务已在官方表里就删旧任务；新任务不在（说明只写到了标记）就清标记，等下次投递重试。
   */
  private async completePendingSwaps(entries: readonly ScheduleCatalogEntryLike[]): Promise<boolean> {
    let changed = false;
    for (const entry of entries) {
      const meta = this.meta.get(entry.id);
      const pending = meta?.pendingSwap;
      if (meta === undefined || pending === undefined || this.rotating.has(entry.id)) continue;
      const next = entries.find(x => String(x.sessionId) === pending.newSessionId && x.title === entry.title);
      if (next === undefined) {
        this.meta.set(entry.id, { pendingSwap: undefined });
        continue;
      }
      this.rotating.add(entry.id);
      try {
        const deletion = await this.ctx.schedule.delete({ sessionId: entry.sessionId as SessionId, id: entry.id });
        if (deletion.deleted !== true) continue;
        this.meta.set(next.id, {
          ...this.carriedMeta(entry, {
            sessionTitle: meta.sessionTitle,
            lastRunSessionId: String(entry.sessionId),
            lastRunSessionTitle: meta.lastRunSessionTitle,
            rotatedFrom: pending.messageId,
          }),
          pendingSwap: undefined,
        });
        this.meta.remove(entry.id);
        this.protection.rebind(entry.id, next.id);
        this.rememberRotation(entry.id, next.id);
        this.ctx.logger?.info?.(`[dsh-scheduled-send] 收尾未完成的会话轮转：「${entry.title}」`);
        changed = true;
      } catch (error) {
        this.ctx.logger?.warn?.(`[dsh-scheduled-send] 收尾会话轮转失败（下次重试）：${String((error as Error)?.message ?? error)}`);
      } finally {
        this.rotating.delete(entry.id);
      }
    }
    return changed;
  }

  /** 轮转后新任务继承的插件元数据（官方侧 title/prompt/规则由 create 重建）。 */
  private carriedMeta(entry: ScheduleCatalogEntryLike, patch: Partial<TaskMeta>): Partial<TaskMeta> {
    const prev = this.meta.get(entry.id) ?? this.meta.ensure(entry.id, { title: entry.title });
    return {
      notify: prev.notify,
      createdAt: prev.createdAt,
      title: entry.title,
      // 0.10.9：稳定任务键随轮转继承——运行历史、暂停/恢复、归档迁移都靠它认出「还是那个任务」。
      taskKey: prev.taskKey ?? newTaskKey(),
      ...(prev.workspaceId === undefined ? {} : { workspaceId: prev.workspaceId }),
      ...(prev.endsAt === undefined ? {} : { endsAt: prev.endsAt }),
      ...(prev.agentPreset === undefined ? {} : { agentPreset: prev.agentPreset }),
      ...(prev.model === undefined ? {} : { model: prev.model }),
      ...(prev.builtin === true ? { builtin: true } : {}),
      ...(prev.lastExecution === undefined ? {} : { lastExecution: prev.lastExecution }),
      sessionMode: "per-run",
      lastRunAt: Date.now(),
      runSessionIds: this.nextRunSessionIds(prev.runSessionIds, patch.lastRunSessionId),
      ...patch,
    };
  }

  /** per-run 执行过的会话列表（新的在前，去重，最多 20 条）。 */
  private nextRunSessionIds(prev: readonly string[] | undefined, latest: string | undefined): string[] {
    const ids = latest === undefined ? [...(prev ?? [])] : [latest, ...(prev ?? []).filter(x => x !== latest)];
    return ids.slice(0, 20);
  }

  /**
   * 把官方投递回执记进运行历史（0.10.9）。
   *
   * 判据只有结构化字段 `lastDelivery`；`messageId` 是幂等键——刷新很频繁（UI 5s 轮询 +
   * `schedule/changed`），同一条投递绝不能写第二遍。写失败只告警，不影响投递/轮转。
   */
  private recordDeliveries(entries: readonly ScheduleCatalogEntryLike[]): void {
    for (const entry of entries) {
      const delivery = entry.lastDelivery;
      if (delivery === undefined) continue;
      const messageId = String(delivery.messageId ?? "");
      if (messageId === "") continue;
      const meta = this.meta.ensure(entry.id, { title: entry.title });
      if (meta.taskKey === undefined || meta.taskKey === "") meta.taskKey = newTaskKey();
      const deliveredAt = Date.parse(delivery.deliveredAt);
      const record: RunHistoryEntry = {
        at: Number.isFinite(deliveredAt) ? deliveredAt : Date.now(),
        sessionId: String(entry.sessionId),
        ...(meta.sessionTitle === undefined ? {} : { sessionTitle: meta.sessionTitle }),
        messageId,
        reason: "scheduled",
      };
      const taskKey = meta.taskKey;
      const appended = this.appendRunSafe(`记录「${entry.title}」的投递历史`, taskKey, record);
      // 执行结果早于投递记录落地（模型快速失败）→ 现在补吸附。
      if (appended) this.drainOrphanExecution(taskKey, String(entry.sessionId), record.at);
    }
  }

  /** 运行历史写盘/校验失败的统一兜底：如实写 console 与宿主 logger，绝不冒泡到投递链路。 */
  private safeHistory(action: string, fn: () => unknown): void {
    try {
      fn();
    } catch (e) {
      const message = `[dsh-scheduled-send] ${action}失败（不影响投递与调度）：${String((e as Error)?.message ?? e)}`;
      console.warn(message);
      this.ctx.logger?.warn?.(message);
    }
  }

  /** `appendRun` 的兜底包装：写失败只告警，返回是否真的新增了一条。 */
  private appendRunSafe(action: string, taskKey: string, record: RunHistoryEntry): boolean {
    try {
      return this.meta.appendRun(taskKey, record);
    } catch (e) {
      const message = `[dsh-scheduled-send] ${action}失败（不影响投递与调度）：${String((e as Error)?.message ?? e)}`;
      console.warn(message);
      this.ctx.logger?.warn?.(message);
      return false;
    }
  }

  /** 把「先到一步」的执行结果留到对应投递记录写进来时再用（10 分钟内有效，最多 20 条）。 */
  private bufferOrphanExecution(sessionId: string, execution: ExecutionRecord): void {
    const cutoff = Date.now() - 10 * 60_000;
    for (let i = this.orphanExecutions.length - 1; i >= 0; i -= 1) {
      if (this.orphanExecutions[i].execution.at < cutoff) this.orphanExecutions.splice(i, 1);
    }
    this.orphanExecutions.push({ sessionId, execution });
    while (this.orphanExecutions.length > 20) this.orphanExecutions.shift();
  }

  /**
   * 投递记录刚写进来时，把同会话里「比它更晚结束」的缓冲执行结果吸附上去。
   * 比它更早结束的结果属于更早的某次投递（其记录没写成功），不能张冠李戴。
   */
  private drainOrphanExecution(taskKey: string, sessionId: string, deliveredAt: number): void {
    for (let i = 0; i < this.orphanExecutions.length; i += 1) {
      const item = this.orphanExecutions[i];
      if (item.sessionId !== sessionId || item.execution.at < deliveredAt) continue;
      this.safeHistory(`补写「${sessionId}」的执行结果`, () => {
        if (this.meta.attachExecution(taskKey, sessionId, item.execution)) this.orphanExecutions.splice(i, 1);
      });
      return;
    }
  }

  /**
   * 暂停/恢复、归档迁移、恢复默认会重建官方任务（新 id）；稳定任务键要跟着走，
   * 否则运行历史会被当成「另一个任务」而断开。`key` 缺失 = 老快照，保持新分配的键。
   */
  private carryTaskKey(newId: string, key: string | undefined): void {
    if (key === undefined || key === "") return;
    if (this.meta.get(newId)?.taskKey === key) return;
    this.safeHistory(`恢复「${newId}」的任务身份`, () => this.meta.set(newId, { taskKey: key }));
  }

  /** 还活着的任务键（元数据行 + 暂停中的预置任务快照）——决定运行历史保留范围。 */
  private liveTaskKeys(): ReadonlySet<string> {
    const keys = new Set<string>();
    for (const id of this.meta.ids()) {
      const key = this.meta.get(id)?.taskKey;
      if (key !== undefined && key !== "") keys.add(key);
    }
    for (const baseline of this.protection.data.defaults) {
      const key = baseline.pausedTask?.taskKey;
      if (key !== undefined && key !== "") keys.add(key);
    }
    return keys;
  }

  /**
   * 把「已被轮转删掉的旧官方 id」归一到当前仍存在的那条元数据 id。
   * 找不到就原样返回（调用方据此新建一行，行为与 0.10.8 一致）。
   */
  private metaIdFor(id: string): string {
    let cursor = id;
    for (let hops = 0; hops < 20; hops += 1) {
      if (this.meta.get(cursor) !== undefined) return cursor;
      const next = this.rotatedTo.get(cursor);
      if (next === undefined) return cursor;
      cursor = next;
    }
    return cursor;
  }

  /**
   * 由官方任务 id 反查稳定任务键（跨轮转：页面/事件里拿到的可能是已被删掉的旧 id）。
   * 只认内存里的轮转映射，不跨重启——重启后事件里的 id 就是当前任务 id。
   */
  private taskKeyOf(id: string): string | undefined {
    let cursor: string | undefined = id;
    for (let hops = 0; cursor !== undefined && hops < 20; hops += 1) {
      const key = this.meta.get(cursor)?.taskKey;
      if (key !== undefined && key !== "") return key;
      cursor = this.rotatedTo.get(cursor);
    }
    return undefined;
  }

  /** 官方行已不存在但仍需保留的元数据 id（轮转失败/半截交换）。 */
  private keptMetaIds(): ReadonlySet<string> {
    const keep = new Set<string>();
    for (const id of this.meta.ids()) {
      const meta = this.meta.get(id);
      if (meta?.pendingSwap !== undefined || meta?.rotateError !== undefined) keep.add(id);
    }
    return keep;
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
    const history = this.meta.historyOf(meta.taskKey);
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
      sessionMode: meta.sessionMode === "per-run" ? "per-run" : "fixed",
      ...(meta.lastRunSessionId === undefined ? {} : { lastRunSessionId: meta.lastRunSessionId }),
      ...(meta.lastRunSessionTitle === undefined ? {} : { lastRunSessionTitle: meta.lastRunSessionTitle }),
      ...(meta.lastRunAt === undefined ? {} : { lastRunAt: meta.lastRunAt }),
      ...(meta.rotateError === undefined ? {} : { rotateError: meta.rotateError }),
      ...(entry.lastDelivery === undefined ? {} : { lastDelivery: receiptOf(entry.lastDelivery) }),
      ...(meta.lastExecution === undefined ? {} : { lastExecution: meta.lastExecution }),
      ...(meta.taskKey === undefined ? {} : { taskKey: meta.taskKey }),
      runCount: history.entries.length,
      ...(history.dropped > 0 ? { historyTruncated: true } : {}),
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
      // per-run 轮转走的那个会话（本次执行所在）同样要挂回，否则用户在工作区列表里看不到
      // 每天那个会话，只能靠任务页跳转（0.10.8）。
      void this.reclaimRotatedSeat(sessionId);
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
    if (pending === undefined) {
      // 没有 schedule framing：可能是「立即执行」发起的那个请求（0.10.9 起手动执行也进历史）。
      this.finishManualRun(sessionId, data);
      return;
    }
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
      // 0.10.9：轮转掉的旧 id 已经不在元数据里，`set()` 会为它新建一行（新任务键）——
      // 那样任务键与历史就都对不上了。先按轮转映射把 id 归一到**当前**那一行再写。
      const metaId = this.metaIdFor(id);
      // 任务键必须在写 lastExecution **之前**解析：set() 若建了新行就拿到新键了。
      const taskKey = this.meta.get(metaId)?.taskKey ?? this.taskKeyOf(id);
      const meta = this.meta.set(metaId, { lastExecution: record });
      titles.push(meta.title ?? this.catalogCache.find(x => x.id === metaId)?.title ?? metaId);
      // 跑完的这一轮吸附到对应的运行历史条目（按会话 + FIFO；per-run 轮转后旧 id
      // 已从元数据里删掉，靠 rotatedTo 映射找回同一个任务键）。
      this.safeHistory(`记录「${meta.title ?? id}」的执行结果`, () => {
        if (this.meta.attachExecution(taskKey, sessionId, record)) return;
        // 没有对应的投递记录：正常情况是投递记录还没被刷新读到（先缓冲，写进来时再吸附）；
        // 进程在投递与执行之间重启则可能一直匹配不上 —— 不凭空新建条目（历史以「投递」为准，
        // lastExecution 仍有完整结果），只如实留痕。
        this.bufferOrphanExecution(sessionId, record);
        console.warn(`[dsh-scheduled-send] 执行结果暂无对应运行记录（会话 ${sessionId}），已缓冲待投递记录落地：${meta.title ?? id}`);
      });
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

  /**
   * 手动执行的结果归因：把这一轮的 `turn/end` 写进对应那条 `manual-run` 记录。
   *
   * 判据：会话里有登记过的手动请求，且这轮不是 schedule framing 触发的（调用方已确认）。
   * 找不到可填写的记录就只留痕——历史以「投递/触发」为准，不凭空新建。
   */
  private finishManualRun(sessionId: string, data: Record<string, unknown>): void {
    const manual = this.manualPending.get(sessionId);
    if (manual === undefined) return;
    // 10 分钟还没等到这一轮结束（模型卡住/被用户接管）：作废，避免把后来的轮次张冠李戴。
    if (Date.now() - manual.at > 10 * 60_000) {
      this.manualPending.delete(sessionId);
      return;
    }
    const reason = data.reason as { kind?: unknown; error?: { message?: unknown; code?: unknown } } | undefined;
    const status = statusOf(reason?.kind);
    if (status === undefined) return;
    this.manualPending.delete(sessionId);
    const endedAt = Date.now();
    const startedAt = this.turnStartedAt.get(sessionId) ?? manual.at;
    const summary = truncateText(this.lastAssistantText.get(sessionId) ?? "", EXECUTION_SUMMARY_MAX);
    const errorText = stringOrUndefined(reason?.error?.message) ?? stringOrUndefined(reason?.error?.code);
    const record: ExecutionRecord = {
      status,
      at: endedAt,
      durationMs: Math.max(0, endedAt - startedAt),
      ...(summary === "" ? {} : { summary }),
      ...(errorText === undefined ? {} : { error: errorText }),
    };
    const label = manual.title ?? sessionId;
    this.safeHistory(`记录「${label}」的手动执行结果`, () => {
      if (this.meta.attachExecution(manual.taskKey, sessionId, record)) return;
      this.bufferOrphanExecution(sessionId, record);
      console.warn(`[dsh-scheduled-send] 手动执行结果暂无对应运行记录（会话 ${sessionId}），已缓冲：${label}`);
    });
    this.lastAssistantText.delete(sessionId);
    this.turnStartedAt.delete(sessionId);
    this.currentTurn.delete(sessionId);
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

/** 官方记录 → 是否周期任务（recurring 接受 {frequency}，这里给一个记录级封装）。 */
function isRecurringRecord(record: Pick<ScheduleRecordLike, "kind"> & Record<string, unknown>): boolean {
  return recurring({ frequency: frequencyOf(record) });
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
