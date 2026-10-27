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
 *     pendingSwap 用于进程在「建新任务 → 删旧任务」之间退出时的自愈。
 *
 * 元数据是**附属信息**：官方任务行才是权威。读不到/写失败时页面仍可显示官方任务，
 * 只是少了截止时间/执行结果。写入使用临时文件 + rename，避免半截 JSON。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExecutionRecord, ModelRef, SessionMode } from "../shared/types.ts";

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
}

export class MetaStore {
  private readonly file: string;
  private data: MetaFile = { version: 1, tasks: {} };
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
      for (const [id, value] of Object.entries(raw.tasks)) {
        if (typeof value !== "object" || value === null) continue;
        const v = value as Partial<TaskMeta>;
        tasks[id] = {
          notify: v.notify !== false,
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
      this.data = { version: 1, tasks };
    } catch {
      // 损坏的元数据不阻断插件：官方任务仍可用，页面退化为无附加信息。
      this.data = { version: 1, tasks: {} };
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

function isRotateError(value: unknown): value is { at: number; message: string } {
  if (typeof value !== "object" || value === null) return false;
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
