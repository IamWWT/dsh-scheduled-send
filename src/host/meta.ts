/**
 * 插件自有元数据（与官方 Schedule 任务行分开存）。
 *
 * 官方记录只保存 title/prompt/规则/会话绑定/投递回执；本插件额外需要：
 *   - endsAt：重复任务的截止时刻（官方没有该字段）；
 *   - notify：是否推送执行状态（当前版本保留，通知由 notify-alert 全局控制）；
 *   - workspaceId / sessionTitle：页面展示与追踪；
 *   - lastExecution：最近一次模型执行结果（官方只记录“投递”，不记录执行）。
 *
 * 元数据是**附属信息**：官方任务行才是权威。读不到/写失败时页面仍可显示官方任务，
 * 只是少了截止时间/执行结果。写入使用临时文件 + rename，避免半截 JSON。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExecutionRecord, ModelRef } from "../shared/types.ts";

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
    };
    this.data.tasks[id] = created;
    return created;
  }

  flush(): void {
    this.save();
  }

  set(id: string, patch: Partial<TaskMeta>): TaskMeta {
    const current = this.ensure(id);
    const next: TaskMeta = {
      ...current,
      ...patch,
      notify: patch.notify ?? current.notify,
    };
    this.data.tasks[id] = next;
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

  /** 删除官方任务表里已经不存在的元数据（官方 delete/deleteInactive 后）。 */
  reconcile(existingIds: ReadonlySet<string>): void {
    let changed = false;
    for (const id of Object.keys(this.data.tasks)) {
      if (!existingIds.has(id)) {
        delete this.data.tasks[id];
        changed = true;
      }
    }
    if (changed) this.save();
  }
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
