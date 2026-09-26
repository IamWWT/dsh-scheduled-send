/**
 * 从 DSH 客户端 `useSessions` 的 list 投影派生「会话元数据」查询表（纯函数，可单测）。
 *
 * 用途：设置面板任务列表需要展示每个任务目标会话的**标题**与**工作目录（cwd）**，
 * 数据源用 DSH sessions 服务的 list 投影（SessionSummary: id/displayTitle/title/cwd/...），
 * 比插件自存快照更权威、实时。
 *
 * 不依赖 dsh 包类型：只按结构读取，缺字段即空。
 */
export interface SessionMetaRow {
  /** 人类可读标题（displayTitle 优先，其次 title）。 */
  title?: string;
  /** 工作目录（cwd）。 */
  cwd?: string;
}

/** useSessions 投影的最小结构面（SessionListState.byId）。 */
export interface SessionListLike {
  byId?: Record<string, {
    displayTitle?: string;
    title?: string;
    cwd?: string;
  }>;
}

/**
 * 把 sessions 列表投影折叠为 `sessionId -> {title, cwd}` 查询表。
 * @param snap - useSessions(sel => sel) 的结果；undefined 或缺失 → 空表。
 */
export function sessionMetaOf(snap: SessionListLike | undefined): Record<string, SessionMetaRow> {
  const out: Record<string, SessionMetaRow> = {};
  const byId = snap?.byId;
  if (!byId) return out;
  for (const [id, row] of Object.entries(byId)) {
    out[id] = {
      title: row?.displayTitle ?? row?.title ?? undefined,
      cwd: row?.cwd ?? undefined,
    };
  }
  return out;
}