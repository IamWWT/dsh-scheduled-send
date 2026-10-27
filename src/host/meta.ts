/**
 * 插件自有元数据（与官方 Schedule 任务行分开存）。
 *
 * 官方记录只保存 title/prompt/规则/会话绑定/投递回执；本插件额外需要：
 *   - endsAt：重复任务的截止时刻（官方没有该字段）；
 *   - notify：是否推送执行状态（当前版本保留，通知由 notify-alert 全局控制）；
 *   - workspaceId / sessionTitle：页面展示与追踪；
 *   - lastExecution：最近一次模型执行结果（官方只记录“投递”，不记录执行）；
 *   - sessionMode / lastRunSessionId / rotatedFrom / pendingSwap：per-run（每次执行新建会话）
 *     的轮转状态，其中 rotatedFrom 是**幂等键**（同一次投递只轮转一次），
 *     pendingSwap 用于进程在「建新任务 → 删旧任务」之间退出时的自愈；
 *   - taskKey + histories（0.10.9）：每个任务一条**稳定业务身份**与最近 200 次
 *     「投递 + 执行」记录。官方任务 id 会被 per-run 轮转换掉，所以运行历史按 taskKey
 *     存（轮转时继承），不按官方 id 存。
 *
 * 元数据是**附属信息**：官方任务行才是权威。读不到/写失败时页面仍可显示官方任务，
 * 只是少了截止时间/执行结果。写入使用临时文件 + rename，避免半截 JSON。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { RUN_HISTORY_LIMIT } from "../shared/constants.ts";
import type { ExecutionRecord, ModelRef, RunHistoryEntry, RunReason, SessionMode } from "../shared/types.ts";

/**
 * 半截交换标记（0.10.8 per-run 轮转的崩溃自愈用）。
 *
 * 轮转顺序是「建新任务 → 删旧任务」——先建后删保证失败时任务仍在。
 * 若进程在这两步之间退出，官方任务表里会同时留下新旧两条；标记记下新会话，
 * 下次刷新据此把旧任务删掉，避免同一条提示词投两次。
 */
export interface PendingSwap {
  /** 新任务绑定的会话。 */
  newSessionId: string;
  /** 触发本次轮转的投递 messageId（继承给新任务，避免重复轮转）。 */
  messageId: string;
  at: number;
}

export interface TaskMeta {
  notify: boolean;
  /**
   * 稳定业务身份（0.10.9）：per-run 轮转时继承给新任务，运行历史按它聚合。
   *
   * 官方 task id 由服务端分配、轮转必变，不能当聚合键；`taskKey` 一旦分配就不再变。
   */
  taskKey?: string;
  endsAt?: number;
  workspaceId?: string;
  sessionTitle?: string;
  /** 官方任务标题的快照，官方删除后仍可读（可选）。 */
  title?: string;
  /** 新任务会话使用的 agent preset（现有会话不写：preset 首轮后锁定）。 */
  agentPreset?: string;
  /** 任务绑定的模型（创建/更新时已对目标会话执行 selectModel）。 */
  model?: ModelRef;
  /** 插件预置任务（页面「预置任务」tab 分组）。 */
  builtin?: boolean;
  /** 会话模式；缺省 = fixed（兼容 0.10.7 及更早的元数据）。 */
  sessionMode?: SessionMode;
  /** per-run：上一次执行（已投递）所在会话，`sessionTitle` 则是下次目标会话的标题。 */
  lastRunSessionId?: string;
  lastRunSessionTitle?: string;
  lastRunAt?: number;
  /**
   * per-run：最近若干次执行用过的会话（新的在前，上限 20）。
   * 用于「执行过的会话在 turn/start 后挂回工作区」——只留 lastRunSessionId 一个槽位时，
   * 两次投递挨得很近（turn/start 晚于第二次轮转）会让前一个会话永远挂不回去。
   */
  runSessionIds?: string[];
  /** per-run：已完成轮转的那次投递 messageId（幂等键，禁止重复轮转）。 */
  rotatedFrom?: string;
  /** per-run：轮转失败原因（任务已保留在原会话）。 */
  rotateError?: { at: number; message: string };
  /**
   * per-run：对某一次投递的重试计数。刷新很频繁（UI 轮询 + schedule/changed），
   * 没有上限就会每 5 秒重建一次会话；同一次投递最多试 2 次，之后等下一次投递再试。
   */
  rotateAttempts?: { messageId: string; count: number };
  /** 轮转中的半截交换标记（崩溃自愈）。 */
  pendingSwap?: PendingSwap;
  createdAt: number;
  lastExecution?: ExecutionRecord;
}

interface MetaFile {
  version: 1;
  tasks: Record<string, TaskMeta>;
  /**
   * 每任务运行历史（0.10.9）：键 = `TaskMeta.taskKey`，不随官方任务 id 轮转。
   * 保持 `version: 1` 是刻意的——旧版（0.10.8 及更早）读元数据时只认 version 并忽略多余键，
   * 降级不会因为多了这个字段就把整份元数据判成损坏。
   */
  histories?: Record<string, RunHistoryRecord>;
}

/** 单个任务的运行历史容器。 */
export interface RunHistoryRecord {
  /** 时间倒序（新的在前）。 */
  entries: RunHistoryEntry[];
  /** 超上限被丢弃的条数（页面用来提示「已截断」）。 */
  dropped: number;
}

/** 分配一个稳定任务键（一次分配，轮转继承）。 */
export function newTaskKey(): string {
  return `tk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class MetaStore {
  private readonly file: string;
  private data: MetaFile = { version: 1, tasks: {}, histories: {} };
  /**
   * 每个 id 最近一次被写入的时刻（内存态，不落盘）。
   *
   * 用途：`reconcile` 只能删除「快照读的时候就已经不在官方表里」的元数据。
   * 刷新与创建/编辑是并发的：官方 `catalog()` 读到快照之后、`reconcile` 执行之前，
   * 另一个路径可能刚建好任务并写了元数据；若不看写入时刻，就会把这条元数据删掉
   * （0.10.8 实测：`bridge.start()` 的刷新把紧接着 `create()` 写的 builtin/sessionMode 抹掉）。
   */
  private readonly touched = new Map<string, number>();

  constructor(stateDir: string) {
    this.file = `${stateDir}/tasks-meta.json`;
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const raw = JSON.parse(readFileSync(this.file, "utf-8")) as Partial<MetaFile>;
      if (raw.version !== 1 || typeof raw.tasks !== "object" || raw.tasks === null) return;
      const tasks: Record<string, TaskMeta> = {};
      let assignedKey = false;
      for (const [id, value] of Object.entries(raw.tasks)) {
        if (typeof value !== "object" || value === null) continue;
        const v = value as Partial<TaskMeta>;
        const taskKey = typeof v.taskKey === "string" && v.taskKey !== "" ? v.taskKey : newTaskKey();
        if (typeof v.taskKey !== "string" || v.taskKey === "") assignedKey = true;
        tasks[id] = {
          notify: v.notify !== false,
          taskKey,
          ...(typeof v.endsAt === "number" && Number.isFinite(v.endsAt) ? { endsAt: v.endsAt } : {}),
          ...(typeof v.workspaceId === "string" && v.workspaceId !== "" ? { workspaceId: v.workspaceId } : {}),
          ...(typeof v.sessionTitle === "string" && v.sessionTitle !== "" ? { sessionTitle: v.sessionTitle } : {}),
          ...(typeof v.title === "string" && v.title !== "" ? { title: v.title } : {}),
          ...(typeof v.agentPreset === "string" && v.agentPreset !== "" ? { agentPreset: v.agentPreset } : {}),
          ...(isModelRef(v.model) ? { model: v.model } : {}),
          ...(v.builtin === true ? { builtin: true } : {}),
          ...(v.sessionMode === "per-run" ? { sessionMode: "per-run" as const } : v.sessionMode === "fixed" ? { sessionMode: "fixed" as const } : {}),
          ...(typeof v.lastRunSessionId === "string" && v.lastRunSessionId !== "" ? { lastRunSessionId: v.lastRunSessionId } : {}),
          ...(typeof v.lastRunSessionTitle === "string" && v.lastRunSessionTitle !== "" ? { lastRunSessionTitle: v.lastRunSessionTitle } : {}),
          ...(typeof v.lastRunAt === "number" && Number.isFinite(v.lastRunAt) ? { lastRunAt: v.lastRunAt } : {}),
          ...(typeof v.rotatedFrom === "string" && v.rotatedFrom !== "" ? { rotatedFrom: v.rotatedFrom } : {}),
          ...(Array.isArray(v.runSessionIds)
            ? { runSessionIds: v.runSessionIds.filter((x): x is string => typeof x === "string" && x !== "").slice(0, 20) }
            : {}),
          ...(isRotateError(v.rotateError) ? { rotateError: v.rotateError } : {}),
          ...(isRotateAttempts(v.rotateAttempts) ? { rotateAttempts: v.rotateAttempts } : {}),
          ...(isPendingSwap(v.pendingSwap) ? { pendingSwap: v.pendingSwap } : {}),
          createdAt: typeof v.createdAt === "number" && Number.isFinite(v.createdAt) ? v.createdAt : Date.now(),
          ...(isExecutionRecord(v.lastExecution) ? { lastExecution: v.lastExecution } : {}),
        };
      }
      // 运行历史：逐条按结构校验后再收（损坏的单条丢弃，不连坐整份文件）。
      const histories: Record<string, RunHistoryRecord> = {};
      if (typeof raw.histories === "object" && raw.histories !== null) {
        for (const [key, value] of Object.entries(raw.histories)) {
          if (typeof key !== "string" || key === "") continue;
          const v = value as Partial<RunHistoryRecord> | undefined;
          const entries = Array.isArray(v?.entries)
            ? v.entries.filter(isRunHistoryEntry).sort((a, b) => b.at - a.at).slice(0, RUN_HISTORY_LIMIT)
            : [];
          const dropped = typeof v?.dropped === "number" && Number.isFinite(v.dropped) && v.dropped > 0
            ? Math.floor(v.dropped)
            : 0;
          if (entries.length > 0 || dropped > 0) histories[key] = { entries, dropped };
        }
      }
      this.data = { version: 1, tasks, histories };
      // 老元数据（0.10.8 及更早）没有 taskKey：升级后首次启动补一次并落盘（只补不删）。
      if (assignedKey) this.save();
    } catch {
      // 损坏的元数据不阻断插件：官方任务仍可用，页面退化为无附加信息。
      this.data = { version: 1, tasks: {}, histories: {} };
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf-8");
      renameSync(tmp, this.file);
    } catch (e) {
      console.warn(`[dsh-scheduled-send] 元数据写入失败：${String((e as Error)?.message ?? e)}`);
    }
  }

  get(id: string): TaskMeta | undefined {
    return this.data.tasks[id];
  }

  /** 只补内存中的缺省项；批量 reconcile 后由调用方 flush() 一次落盘。 */
  ensure(id: string, defaults: Partial<TaskMeta> = {}): TaskMeta {
    const existing = this.data.tasks[id];
    if (existing !== undefined) return existing;
    const created: TaskMeta = {
      notify: defaults.notify !== false,
      taskKey: defaults.taskKey ?? newTaskKey(),
      createdAt: defaults.createdAt ?? Date.now(),
      ...(defaults.endsAt === undefined ? {} : { endsAt: defaults.endsAt }),
      ...(defaults.workspaceId === undefined ? {} : { workspaceId: defaults.workspaceId }),
      ...(defaults.sessionTitle === undefined ? {} : { sessionTitle: defaults.sessionTitle }),
      ...(defaults.title === undefined ? {} : { title: defaults.title }),
      ...(defaults.agentPreset === undefined ? {} : { agentPreset: defaults.agentPreset }),
      ...(defaults.model === undefined ? {} : { model: defaults.model }),
      ...(defaults.builtin !== true ? {} : { builtin: true }),
      ...(defaults.sessionMode === undefined ? {} : { sessionMode: defaults.sessionMode }),
      ...(defaults.lastRunSessionId === undefined ? {} : { lastRunSessionId: defaults.lastRunSessionId }),
      ...(defaults.lastRunSessionTitle === undefined ? {} : { lastRunSessionTitle: defaults.lastRunSessionTitle }),
      ...(defaults.lastRunAt === undefined ? {} : { lastRunAt: defaults.lastRunAt }),
      ...(defaults.runSessionIds === undefined ? {} : { runSessionIds: defaults.runSessionIds }),
      ...(defaults.rotatedFrom === undefined ? {} : { rotatedFrom: defaults.rotatedFrom }),
      ...(defaults.rotateError === undefined ? {} : { rotateError: defaults.rotateError }),
      ...(defaults.rotateAttempts === undefined ? {} : { rotateAttempts: defaults.rotateAttempts }),
      ...(defaults.pendingSwap === undefined ? {} : { pendingSwap: defaults.pendingSwap }),
    };
    this.data.tasks[id] = created;
    this.touched.set(id, Date.now());
    return created;
  }

  flush(): void {
    this.save();
  }

  /** 局部更新并落盘；`patch` 里显式 `undefined` 表示**删除**该键（如清除 pendingSwap）。 */
  set(id: string, patch: Partial<TaskMeta>): TaskMeta {
    const current = this.ensure(id);
    const next: TaskMeta = {
      ...current,
      ...patch,
      notify: patch.notify ?? current.notify,
    };
    for (const key of Object.keys(patch) as Array<keyof TaskMeta>) {
      if (patch[key] === undefined) delete next[key];
    }
    this.data.tasks[id] = next;
    this.touched.set(id, Date.now());
    this.save();
    return next;
  }

  remove(id: string): void {
    if (this.data.tasks[id] === undefined) return;
    delete this.data.tasks[id];
    this.save();
  }

  ids(): string[] {
    return Object.keys(this.data.tasks);
  }

  /**
   * 取某个任务键的运行历史（新的在前）。返回浅拷贝，调用方改数组不会污染存储。
   */
  historyOf(taskKey: string | undefined): RunHistoryRecord {
    if (taskKey === undefined) return { entries: [], dropped: 0 };
    const record = this.data.histories?.[taskKey];
    if (record === undefined) return { entries: [], dropped: 0 };
    return { entries: [...record.entries], dropped: record.dropped };
  }

  /**
   * 追加一条运行记录并落盘。返回 `false` = 按 `messageId` 判定为重复（幂等，不写第二遍）。
   *
   * 上限：超过 `RUN_HISTORY_LIMIT` 丢最旧的那条，并把丢弃数累加进 `dropped`（页面提示「已截断」）。
   */
  appendRun(taskKey: string, entry: RunHistoryEntry): boolean {
    const histories = this.data.histories ?? {};
    this.data.histories = histories;
    const record = histories[taskKey] ?? { entries: [], dropped: 0 };
    if (record.entries.some(x => x.messageId === entry.messageId)) return false;
    record.entries.unshift(entry);
    if (record.entries.length > RUN_HISTORY_LIMIT) {
      record.dropped += record.entries.length - RUN_HISTORY_LIMIT;
      record.entries.length = RUN_HISTORY_LIMIT;
    }
    histories[taskKey] = record;
    this.save();
    return true;
  }

  /**
   * 把执行结果吸附到对应运行记录上（按会话 + FIFO：同会话里最早那条还没结果的就是这轮）。
   *
   * 只更新、不新建：历史条目由「投递」驱动（官方回执 / 手动执行），执行事件晚到。
   * 找不到对应条目 = 这条执行不属于本插件记录的某次投递（例如插件重启前投递的），返回 false。
   */
  attachExecution(taskKey: string | undefined, sessionId: string, execution: ExecutionRecord): boolean {
    if (taskKey === undefined) return false;
    const record = this.data.histories?.[taskKey];
    if (record === undefined) return false;
    for (let i = record.entries.length - 1; i >= 0; i -= 1) {
      const item = record.entries[i];
      if (item.sessionId !== sessionId || item.execution !== undefined) continue;
      record.entries[i] = { ...item, execution };
      this.save();
      return true;
    }
    return false;
  }

  /** 丢弃已经没有任何任务行的运行历史（任务被删除/清理已结束后）。 */
  pruneHistories(liveKeys: ReadonlySet<string>): void {
    const histories = this.data.histories;
    if (histories === undefined) return;
    let changed = false;
    for (const key of Object.keys(histories)) {
      if (liveKeys.has(key)) continue;
      delete histories[key];
      changed = true;
    }
    if (changed) this.save();
  }

  /**
   * 删除官方任务表里已经不存在的元数据（官方 delete/deleteInactive 后）。
   *
   * `keep`：即使官方行已不存在也要留的 id（per-run 轮转失败时任务行已删，
   * 但配置快照要留着给页面报错与恢复）。
   * `snapshotAt`：官方 catalog 快照的取样时刻。比它更新的写入必须保留——
   * 那是并发路径（创建/轮转）刚写进去的元数据，快照里当然看不到。
   */
  reconcile(existingIds: ReadonlySet<string>, keep?: ReadonlySet<string>, snapshotAt?: number): void {
    let changed = false;
    for (const id of Object.keys(this.data.tasks)) {
      if (existingIds.has(id)) continue;
      if (keep?.has(id) === true) continue;
      if (snapshotAt !== undefined && (this.touched.get(id) ?? 0) >= snapshotAt) continue;
      delete this.data.tasks[id];
      changed = true;
    }
    if (changed) this.save();
  }
}

function isRunHistoryEntry(value: unknown): value is RunHistoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<RunHistoryEntry>;
  if (typeof v.at !== "number" || !Number.isFinite(v.at)) return false;
  if (typeof v.sessionId !== "string" || v.sessionId === "") return false;
  if (typeof v.messageId !== "string" || v.messageId === "") return false;
  const reason: RunReason | undefined = v.reason === "scheduled" ? "scheduled" : v.reason === "manual-run" ? "manual-run" : undefined;
  if (reason === undefined) return false;
  if (v.sessionTitle !== undefined && typeof v.sessionTitle !== "string") return false;
  if (v.execution !== undefined && !isExecutionRecord(v.execution)) return false;
  return true;
}

function isRotateError(value: unknown): value is { at: number; message: string } {  if (typeof value !== "object" || value === null) return false;
  const v = value as { at?: unknown; message?: unknown };
  return typeof v.at === "number" && Number.isFinite(v.at) && typeof v.message === "string" && v.message !== "";
}

function isRotateAttempts(value: unknown): value is { messageId: string; count: number } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { messageId?: unknown; count?: unknown };
  return typeof v.messageId === "string" && typeof v.count === "number" && Number.isFinite(v.count);
}

function isPendingSwap(value: unknown): value is PendingSwap {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { newSessionId?: unknown; messageId?: unknown; at?: unknown };
  return typeof v.newSessionId === "string" && v.newSessionId !== ""
    && typeof v.messageId === "string"
    && typeof v.at === "number" && Number.isFinite(v.at);
}

function isExecutionRecord(value: unknown): value is ExecutionRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<ExecutionRecord>;
  return typeof v.status === "string"
    && typeof v.at === "number"
    && typeof v.durationMs === "number";
}

function isModelRef(value: unknown): value is ModelRef {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<ModelRef>;
  return typeof v.provider === "string" && v.provider !== ""
    && typeof v.model === "string" && v.model !== "";
}
