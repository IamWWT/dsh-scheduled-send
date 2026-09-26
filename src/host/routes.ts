/**
 * dsh-scheduled-send — Host HTTP 路由（浏览器同源直连，前缀 /api/scheduled-send/）。
 *
 *   GET   health      健康检查（版本 + 任务统计）
 *   GET   jobs        任务列表（pending/sent/missed/cancelled）
 *   POST  jobs        创建/更新任务（有 id = 更新，无 id = 新建）
 *   POST  jobs/cancel 取消一个 pending 任务
 *   POST  jobs/delete 物理删除任意任务
 *   POST  fire        手动立即触发一个 pending 任务（测试/应急用）
 *
 * 全部 JSON；CORS 放开（与 dsh-personal-workbench 同惯例，dsh web 同源直连）。
 *
 * ⚠️ 历史教训（v0.4.1 卡死根因）：`readBody` 必须读**请求对象 req**（它才发 data/end
 * 事件），绝不能传响应对象 res——否则 promise 永不 resolve，处理器永不返回，
 * 客户端 fetch 无限挂起（表现为"创建中…"卡死）。v0.5.0 已全部修正。
 */
import type { JobUpsertRequest, JobUpsertResponse, ScheduledJob } from "../shared/types.ts";
import type { Scheduler, HostCtx } from "./scheduler.ts";

/** 请求对象最小面：Node http.IncomingMessage 的流式能力（body 读取）。 */
type HttpReq = {
  method?: string;
  on: (ev: "data" | "end" | "error", fn: (chunk?: unknown, err?: unknown) => void) => void;
  destroy: () => void;
};

type HttpRes = {
  writeHead: (status: number, headers: Record<string, string>) => void;
  end: (body: string) => void;
  on: (ev: "data" | "end" | "error", fn: (chunk?: unknown, err?: unknown) => void) => void;
  destroy: () => void;
};

function sendJson(res: HttpRes, status: number, obj: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(obj));
}

/** 从**请求对象**读取 body（传错对象会导致永久挂起，见文件头）。 */
function readBody(req: HttpReq, limit = 1 << 20): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    req.on("data", (chunk?: unknown) => {
      const c = chunk as Buffer;
      if (!c) return;
      size += c.length;
      if (size > limit) { reject(new Error("请求体过大")); req.destroy(); return; }
      chunks.push(new Uint8Array(c.buffer, c.byteOffset, c.byteLength));
    });
    req.on("end", () => resolve(Buffer.concat(chunks as unknown as readonly Uint8Array[]).toString("utf-8")));
    req.on("error", reject);
  });
}

/** 解析 JSON body；失败返回 undefined（调用方按缺省处理）。 */
async function readJsonBody<T>(req: HttpReq): Promise<T | undefined> {
  try {
    return JSON.parse(await readBody(req)) as T;
  } catch {
    return undefined;
  }
}

/** 注册 /api/scheduled-send/* 路由并启动调度器。 */
export function registerRoutes(ctx: HostCtx, scheduler: Scheduler, version: string): void {
  const ws = ctx.webServer;
  if (!ws) return;

  const R = (path: string, handler: (req: unknown, res: unknown) => Promise<void>) => {
    ws.register({
      kind: "exact",
      path: `/api/scheduled-send${path}`,
      handler: handler as never,
    });
  };

  R("/health", async (_req, res) => {
    const hres = res as unknown as HttpRes;
    const jobs = scheduler.list();
    const count = (s: string) => jobs.filter(j => j.status === s).length;
    sendJson(hres, 200, {
      ok: true,
      version,
      pending: count("pending"),
      sent: count("sent"),
      missed: count("missed"),
      cancelled: count("cancelled"),
    });
  });

  R("/jobs", async (req, res) => {
    const hreq = req as unknown as HttpReq;
    const hres = res as unknown as HttpRes;
    if (hreq.method === "GET") {
      sendJson(hres, 200, { ok: true, jobs: scheduler.list(), version });
      return;
    }
    if (hreq.method === "POST") {
      const body = await readJsonBody<JobUpsertRequest>(hreq);
      if (body === undefined) {
        sendJson(hres, 400, { ok: false, error: "body 不是合法 JSON" });
        return;
      }
      try {
        if (body.id) {
          // 更新：只要求 id + 至少一个可更新字段（客户端编辑只发 {id,text}，不带 sessionId）
          if (body.text !== undefined && !body.text.trim()) throw new Error("text 不能为空");
          if (body.text === undefined && !Number.isFinite(body.fireAt)) {
            throw new Error("更新至少需要 text 或 fireAt 之一");
          }
          const up: JobUpsertResponse = { ok: true };
          up.job = scheduler.update(body.id, {
            text: body.text,
            fireAt: body.fireAt,
            note: body.note,
            sessionTitle: body.sessionTitle,
          });
          sendJson(hres, 200, up);
        } else {
          // 新建：完整校验
          if (!body.sessionId || !body.sessionId.trim()) throw new Error("缺少 sessionId");
          if (!body.text || !body.text.trim()) throw new Error("text 不能为空");
          if (!Number.isFinite(body.fireAt)) throw new Error("fireAt 必须是时间戳（毫秒）");
          const up: JobUpsertResponse = { ok: true };
          up.job = scheduler.add({
            sessionId: body.sessionId.trim(),
            sessionTitle: body.sessionTitle,
            text: body.text,
            fireAt: body.fireAt,
            note: body.note,
          });
          sendJson(hres, 200, up);
        }
      } catch (e) {
        const up: JobUpsertResponse = { ok: false, error: String((e as Error).message) };
        sendJson(hres, 200, up);
      }
      return;
    }
    sendJson(hres, 405, { ok: false, error: "仅支持 GET/POST" });
  });

  R("/jobs/cancel", async (req, res) => {
    const hreq = req as unknown as HttpReq;
    const hres = res as unknown as HttpRes;
    const body = await readJsonBody<{ id?: string }>(hreq);
    const id = (body?.id ?? "").trim();
    if (!id) { sendJson(hres, 400, { ok: false, error: "缺少 id" }); return; }
    sendJson(hres, 200, { ok: scheduler.cancel(id) });
  });

  R("/jobs/delete", async (req, res) => {
    const hreq = req as unknown as HttpReq;
    const hres = res as unknown as HttpRes;
    const body = await readJsonBody<{ id?: string }>(hreq);
    const id = (body?.id ?? "").trim();
    if (!id) { sendJson(hres, 400, { ok: false, error: "缺少 id" }); return; }
    sendJson(hres, 200, { ok: scheduler.delete(id) });
  });

  R("/jobs/fire", async (req, res) => {
    const hreq = req as unknown as HttpReq;
    const hres = res as unknown as HttpRes;
    const body = await readJsonBody<{ id?: string }>(hreq);
    const id = (body?.id ?? "").trim();
    if (!id) { sendJson(hres, 400, { ok: false, error: "缺少 id" }); return; }
    const job = scheduler.get(id);
    if (!job) { sendJson(hres, 404, { ok: false, error: "任务不存在" }); return; }
    if (job.status !== "pending") { sendJson(hres, 200, { ok: false, error: `任务状态 ${job.status}，不可触发` }); return; }
    await scheduler.fire(id);
    const after = scheduler.get(id);
    sendJson(hres, 200, { ok: true, job: after });
  });
}