/** dsh-scheduled-send — 双端共享常量。 */

/** 客户端请求超时（毫秒）：创建/列表等一律限时，绝不无限挂起。 */
export const API_TIMEOUT_MS = 15000;

/** 列表轮询间隔（毫秒）。 */
export const REFRESH_MS = 5000;

/** 执行摘要最大字符数（通知与列表共用）。 */
export const EXECUTION_SUMMARY_MAX = 240;

/** 截止时间最远允许到当前时间之后多少天（防止误填进 30 年后的定时器）。 */
export const MAX_VALIDITY_DAYS = 3650;

/** 兼容旧版本导出（0.7.x 的每会话最多 3 个待触发限制已随官方 Schedule 废弃）。 */
export const MAX_PENDING_PER_SESSION = 3;
