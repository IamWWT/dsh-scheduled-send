/**
 * dsh-scheduled-send — 双端共享常量。
 */

/** 每个会话最多可同时存在的 pending（待触发）定时任务数（需求：最多 3 个）。 */
export const MAX_PENDING_PER_SESSION = 3;

/**
 * 最晚可定到的时间边界（天偏移，相对今天）：
 * 今天只可定"当前时刻之后"，明天可定 0–24 点。
 * 因此业务上最晚 = 明天 23:59:59（dayOffset 1 整天）。
 */
export const MAX_SCHEDULE_DAY_OFFSET = 1;

/** 客户端请求超时（毫秒）：创建/列表等一律限时，绝不无限挂起。 */
export const API_TIMEOUT_MS = 10000;