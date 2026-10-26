/**
 * dsh-scheduled-send — 共享类型（Host / Client 双端共用）。
 *
 * 0.8.0 起本插件不再自己维护定时器与 jobs.json：
 * 调度、持久化、重复规则、会话投递全部复用宿主公开服务 `ctx.schedule`
 *（@deepseek-ai/dsh-schedule）。本文件只描述：
 *   - 插件对官方任务记录的视图（附工作区 / 有效期 / 最近执行等插件元数据）；
 *   - 插件自有 HTTP API 的请求/响应；
 *   - 执行状态事件（仅用于本插件列表展示与排障）。
 */

/** 官方 Schedule 的频率种类（含历史 after）。 */
export type Frequency =
  | { kind: "after"; afterSeconds: number }
  | { kind: "once"; at: string }
  | { kind: "every"; seconds: number }
  | { kind: "daily"; time: string; timeZone: string }
  | { kind: "weekly"; time: string; timeZone: string; weekdays: number[] }
  | { kind: "cron"; expression: string; timeZone: string };

/**
 * 一次性任务（只触发一次）：`once`（绝对时刻）/ `after`（延迟一次）。
 * 其余 `every`/`daily`/`weekly`/`cron` 都是周期任务。
 *
 * 用途：会话输入框 dock 只展示一次性任务；周期任务是长期背景调度，
 * 常驻在会话输入框上方会让会话越开越乱（2026-10-26 用户要求）。
 */
export function isOneShotFrequency(frequency: Frequency): boolean {
  return frequency.kind === "once" || frequency.kind === "after";
}

/** 官方任务最近一次收件箱投递回执（不等于模型执行结果）。 */
export interface DeliveryReceipt {
  scheduledAt: string;
  deliveredAt: string;
  messageId: string;
}

/** 本插件观察到的最近一次模型执行结果。 */
export type ExecutionStatus =
  | "success"
  | "failed"
  | "aborted"
  | "blocked"
  | "max-tokens"
  | "interrupted";

export interface ExecutionRecord {
  status: ExecutionStatus;
  at: number;
  durationMs: number;
  summary?: string;
  error?: string;
}

/** 模型路由引用（官方 ModelSelection 的 provider+model 子集；label 仅展示用）。 */
export interface ModelRef {
  provider: string;
  model: string;
  providerName?: string;
  modelName?: string;
}

/** 官方任务 + 插件元数据，供页面列表使用。 */
export interface TaskView {
  /** 官方 ScheduleId。 */
  id: string;
  title: string;
  prompt: string;
  sessionId: string;
  sessionTitle?: string;
  workspaceId?: string;
  frequency: Frequency;
  /** 官方记录里已提交的下一次（或最终）触发时刻，RFC3339 UTC。 */
  scheduledAt: string;
  /** 官方 active/inactive；inactive = 已结束，但记录仍可查看。 */
  status: "active" | "inactive";
  /** 插件元数据：重复任务的截止时刻（epoch ms）；到期后插件删除官方任务。 */
  endsAt?: number;
  /** 插件元数据：是否推送执行状态（当前版本由 notify-alert 全局控制，保留字段供后续）。 */
  notify: boolean;
  /** 插件元数据：建任务会话时指定的 agent preset（现有会话为 undefined，preset 锁定）。 */
  agentPreset?: string;
  /** 插件元数据：任务绑定的模型（应用时刻 = 创建/更新时对目标会话 selectModel）。 */
  model?: ModelRef;
  /** 插件元数据：预置任务（由集成方/脚本创建，页面「预置任务」tab 分组展示）。 */
  builtin?: boolean;
  /** 插件记录的创建时刻（epoch ms）。 */
  createdAt: number;
  lastDelivery?: DeliveryReceipt;
  lastExecution?: ExecutionRecord;
}

/** 新建任务请求。 */
export interface TaskCreateRequest {
  title: string;
  prompt: string;
  frequency: Frequency;
  /** 新任务在哪个工作区创建专属会话；与 sessionId 二选一。 */
  workspaceId?: string;
  /** 沿用现有会话；与 workspaceId 二选一。 */
  sessionId?: string;
  /** 重复任务截止时刻（epoch ms）；缺省 = 长期有效。 */
  endsAt?: number;
  notify?: boolean;
  /** 新会话使用的 agent preset id（仅 workspaceId 路径生效；现有会话 preset 已锁定）。 */
  agentPreset?: string;
  /** 对目标会话应用的模型；缺省 = 不指定（新会话用全局默认，现有会话跟随现状）。 */
  model?: ModelRef;
  /** 标记为插件预置任务（页面「预置任务」tab）；缺省 = 用户自定义。 */
  builtin?: boolean;
}

/** 更新任务请求；所有字段可选，省略保留原值。 */
export interface TaskUpdateRequest {
  id: string;
  title?: string;
  prompt?: string;
  frequency?: Frequency;
  /** null = 清除截止时间（长期有效）；undefined = 保留。 */
  endsAt?: number | null;
  notify?: boolean;
  /** 重新应用模型到绑定会话；null = 仅清插件记录（不回滚会话模型）。 */
  model?: ModelRef | null;
  /** 切换「预置 / 用户自定义」归属。 */
  builtin?: boolean;
}

/** 删除请求。 */
export interface TaskDeleteRequest {
  id: string;
}

/** 立即执行请求。 */
export interface TaskRunRequest {
  id: string;
}

/** 历史投递查询。 */
export interface TaskHistoryRequest {
  sessionId: string;
  id: string;
  limit?: number;
  before?: string;
}

export interface ApiOk<T> {
  ok: true;
  version: string;
  task?: T;
}

export interface ApiErr {
  ok: false;
  error: string;
}

export type ApiResult<T> = ApiOk<T> | ApiErr;

export interface TaskListResponse {
  ok: boolean;
  version: string;
  tasks: TaskView[];
  scheduleService: boolean;
  error?: string;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  scheduleService: boolean;
  active: number;
  total: number;
  error?: string;
}

/** 官方投递历史的一页（原样透传，避免复制上游类型）。 */
export interface TaskHistoryPage {
  records: DeliveryReceipt[];
  nextBefore?: string;
  earlierRecordsUnavailable?: boolean;
}

/** 执行状态事件（Host 内部/日志用；不跨插件发送）。 */
export interface ExecutionEvent {
  tasks: { id: string; title: string }[];
  sessionId: string;
  status: ExecutionStatus;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  summary?: string;
  error?: string;
}
