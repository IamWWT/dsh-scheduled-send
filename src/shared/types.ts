/**
 * dsh-scheduled-send — 共享类型（Host / Client 双端共用）。
 *
 * 领域模型：一条"定时发送任务"= 一段文本 + 目标会话 + 触发时刻。
 * 到点后由 host 把文本以 mode:'queue' 投递进目标会话的持久队列（Inbox next-turn），
 * 复用 dsh 既有排队机制：agent 运行中逐步消费，空闲时立即成为下一轮。
 */

/** 任务状态机：pending（待触发）→ sent（已投递）/ missed（触发时投递失败）/ cancelled（用户取消）。 */
export type JobStatus = "pending" | "sent" | "missed" | "cancelled";

/** 一条持久化定时任务记录。 */
export interface ScheduledJob {
  /** 任务 id（client 生成或 host 生成；唯一）。 */
  id: string;
  /** 目标会话 id（dsh session id）。 */
  sessionId: string;
  /** 会话标题快照（仅展示用；host 不校验）。 */
  sessionTitle?: string;
  /** 到点发送的文本内容（多行 OK）。 */
  text: string;
  /** 触发时刻（epoch 毫秒，本地时区语义——由 client 按浏览器时区换算后提交）。 */
  fireAt: number;
  status: JobStatus;
  /** 创建时刻（epoch ms）。 */
  createdAt: number;
  /** 实际触发时刻（epoch ms）；pending 时缺省。 */
  firedAt?: number;
  /** 投递失败原因（仅 missed）。 */
  error?: string;
  /** 用户备注（可选）。 */
  note?: string;
}

/** GET /jobs 的响应。 */
export interface JobsResponse {
  ok: boolean;
  jobs: ScheduledJob[];
  version: string;
}

/** POST /jobs 请求体（创建或修改任务）。 */
export interface JobUpsertRequest {
  /** 缺省 = 新建（host 生成 id）；给出 = 更新该任务。 */
  id?: string;
  sessionId: string;
  sessionTitle?: string;
  text: string;
  /** 触发时刻（epoch ms）。必须 > 当前时间。 */
  fireAt: number;
  note?: string;
}

export interface JobUpsertResponse {
  ok: boolean;
  job?: ScheduledJob;
  error?: string;
}

/** DELETE /jobs/:id 响应（cancel 语义；pending 之外为幂等 no-op）。 */
export interface JobCancelResponse {
  ok: boolean;
  error?: string;
}