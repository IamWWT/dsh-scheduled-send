/**
 * dsh-scheduled-send — Host HTTP 路由（浏览器同源直连，前缀 /api/scheduled-send/）。
 *
 *   GET  health                 健康检查
 *   GET  tasks                  官方任务 + 插件元数据
 *   POST tasks                  新建任务（可自动建立工作区任务会话）
 *   POST tasks/update           编辑名称/提示词/频率/截止时间
 *   POST tasks/delete           删除任务
 *   POST tasks/delete-inactive  清除全部已结束任务
 *   POST tasks/run              立即投递到官方队列
 *   POST tasks/history          官方投递历史（只对当前任务行有效；轮转后为空）
 *   POST tasks/run-history      插件自持的运行历史（跨轮转/跨重启，0.10.9）
 *
 * 安全：这些是 **exact** 路由，匹配优先于 connection 的 `/api` 前缀路由，
 * 因此不会自动经过宿主鉴权。每个请求先调用 `connection.requestRejection`：
 * 公网入口只有带有效 dsh-auth cookie 的浏览器能管理任务；桌面/无 connection
 * 服务的本地环境才允许直连。
 *
 * ⚠️ 历史教训（v0.4.1 卡死根因）：`readBody` 必须读**请求对象 req**，绝不能传 res。
 */
import type { ScheduleBridge } from "./bridge.ts";
import type {
  HealthResponse,
  RunHistoryRequest,
  TaskCreateRequest,
  TaskDeleteRequest,
  TaskHistoryRequest,
  TaskListResponse,
  TaskRunRequest,
  TaskUpdateRequest,
} from "../shared/types.ts";

type HttpReq = {
  method?: string;
  headers?: unknown;
  on: (ev: "data" | "end" | "error", fn: (chunk?: unknown, err?: unknown) => void) => void;
  destroy: () => void;
};

type HttpRes = {
  writeHead: (status: number, headers: Record<string, string>) => void;
  end: (body?: string) => void;
};

type ConnectionLike = {
  requestRejection?: (request: { headers?: unknown }) => 401 | 403 | undefined;
};

function sendJson(res: HttpRes, status: number, obj: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(obj));
}

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

async function readJsonBody<T>(req: HttpReq): Promise<T | undefined> {
  try {
    return JSON.parse(await readBody(req)) as T;
  } catch {
    return undefined;
  }
}

function resolveConnection(ctx: unknown): ConnectionLike | undefined {
  try {
    const getter = (ctx as unknown as { get?: (name: string) => unknown }).get;
    if (typeof getter !== "function") return undefined;
    return getter.call(ctx, "connection") as ConnectionLike | undefined;
  } catch {
    return undefined;
  }
}

/** 先过宿主鉴权；返回 true = 已写拒绝响应，调用方必须停止。 */
function rejected(ctx: unknown, req: HttpReq, res: HttpRes): boolean {
  const connection = resolveConnection(ctx);
  if (connection?.requestRejection === undefined) return false;
  let rejection: 401 | 403 | undefined;
  try {
    rejection = connection.requestRejection({ headers: req.headers });
  } catch {
    rejection = 403;
  }
  if (rejection === undefined) return false;
  sendJson(res, rejection, { ok: false, error: rejection === 401 ? "未登录或登录已过期" : "来源被拒绝" });
  return true;
}

function methodOf(req: HttpReq): string {
  return (req.method ?? "GET").toUpperCase();
}

export function registerRoutes(ctx: unknown, bridge: ScheduleBridge, version: string): void {
  const webCtx = ctx as unknown as {
    webServer?: {
      register: (spec: { kind: "exact"; path: string; handler: (req: HttpReq, res: HttpRes) => Promise<void> | void }) => () => void;
    };
  };
  const ws = webCtx.webServer;
  if (ws === undefined) return;

  const R = (path: string, handler: (req: HttpReq, res: HttpRes) => Promise<void>) => {
    ws.register({
      kind: "exact",
      path: `/api/scheduled-send${path}`,
      handler: (req, res) => {
        if (rejected(ctx, req, res)) return;
        return handler(req, res).catch((e: unknown) => {
          sendJson(res, 500, { ok: false, error: String((e as Error)?.message ?? e) });
        });
      },
    });
  };

  R("/health", async (_req, res) => {
    const health = await bridge.health();
    const body: HealthResponse = {
      ok: health.scheduleService,
      version,
      scheduleService: health.scheduleService,
      active: health.active,
      total: health.total,
      ...(health.scheduleService ? {} : { error: "宿主未提供 schedule 服务" }),
    };
    sendJson(res, health.scheduleService ? 200 : 503, body);
  });

  R("/tasks", async (req, res) => {
    if (methodOf(req) === "GET") {
      try {
        const tasks = await bridge.list();
        const health = await bridge.health();
        const body: TaskListResponse = {
          ok: true,
          version,
          tasks,
          scheduleService: health.scheduleService,
        };
        sendJson(res, 200, {...body, warnings:bridge.defaults().warnings});
      } catch (e) {
        const body: TaskListResponse = {
          ok: false,
          version,
          tasks: [],
          scheduleService: false,
          error: String((e as Error)?.message ?? e),
        };
        sendJson(res, 200, body);
      }
      return;
    }
    if (methodOf(req) !== "POST") {
      sendJson(res, 405, { ok: false, error: "仅支持 GET/POST" });
      return;
    }
    const body = await readJsonBody<TaskCreateRequest>(req);
    if (body === undefined) {
      sendJson(res, 400, { ok: false, error: "body 不是合法 JSON" });
      return;
    }
    try {
      const task = await bridge.create(body);
      sendJson(res, 200, { ok: true, version, task });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: String((e as Error)?.message ?? e) });
    }
  });

  R('/defaults',async(req,res)=>{
    if(methodOf(req)!=='GET'){sendJson(res,405,{ok:false,error:'仅支持 GET'});return;}
    await bridge.list();
    sendJson(res,200,{ok:true,...bridge.defaults()});
  });
  R('/defaults/restore',async(req,res)=>{
    if(methodOf(req)!=='POST'){sendJson(res,405,{ok:false,error:'仅支持 POST'});return;}
    const body=await readJsonBody<{confirm?:boolean}>(req);
    if(body?.confirm!==true){sendJson(res,400,{ok:false,error:'请先预览并确认恢复预置任务'});return;}
    sendJson(res,200,{ok:true,...await bridge.restoreDefaults()});
  });
  for(const action of ['pause','resume'] as const)R('/tasks/'+action,async(req,res)=>{
    if(methodOf(req)!=='POST'){sendJson(res,405,{ok:false,error:'仅支持 POST'});return;}
    const body=await readJsonBody<{id?:string}>(req);
    if(typeof body?.id!=='string'||!body.id){sendJson(res,400,{ok:false,error:'缺少任务 id'});return;}
    await bridge[action](body.id);sendJson(res,200,{ok:true});
  });

  R("/tasks/update", async (req, res) => {
    if (methodOf(req) !== "POST") { sendJson(res, 405, { ok: false, error: "仅支持 POST" }); return; }
    const body = await readJsonBody<TaskUpdateRequest>(req);
    if (body === undefined || typeof body.id !== "string" || body.id === "") {
      sendJson(res, 400, { ok: false, error: "缺少任务 id" });
      return;
    }
    try {
      const task = await bridge.update(body);
      sendJson(res, 200, { ok: true, version, task });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: String((e as Error)?.message ?? e) });
    }
  });

  R("/tasks/delete", async (req, res) => {
    if (methodOf(req) !== "POST") { sendJson(res, 405, { ok: false, error: "仅支持 POST" }); return; }
    const body = await readJsonBody<TaskDeleteRequest>(req);
    if (body === undefined || typeof body.id !== "string" || body.id === "") {
      sendJson(res, 400, { ok: false, error: "缺少任务 id" });
      return;
    }
    try {
      await bridge.delete(body.id);
      sendJson(res, 200, { ok: true, version });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: String((e as Error)?.message ?? e) });
    }
  });

  R("/tasks/delete-inactive", async (req, res) => {
    if (methodOf(req) !== "POST") { sendJson(res, 405, { ok: false, error: "仅支持 POST" }); return; }
    try {
      const deleted = await bridge.deleteInactive();
      sendJson(res, 200, { ok: true, version, deleted });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: String((e as Error)?.message ?? e) });
    }
  });

  R("/tasks/run", async (req, res) => {
    if (methodOf(req) !== "POST") { sendJson(res, 405, { ok: false, error: "仅支持 POST" }); return; }
    const body = await readJsonBody<TaskRunRequest>(req);
    if (body === undefined || typeof body.id !== "string" || body.id === "") {
      sendJson(res, 400, { ok: false, error: "缺少任务 id" });
      return;
    }
    try {
      await bridge.runNow(body.id);
      sendJson(res, 200, { ok: true, version });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: String((e as Error)?.message ?? e) });
    }
  });

  R("/tasks/run-history", async (req, res) => {
    if (methodOf(req) !== "POST") { sendJson(res, 405, { ok: false, error: "仅支持 POST" }); return; }
    const body = await readJsonBody<RunHistoryRequest>(req);
    if (body === undefined || typeof body.id !== "string" || body.id === "") {
      sendJson(res, 400, { ok: false, error: "缺少任务 id" });
      return;
    }
    try {
      const page = await bridge.runHistory(body);
      sendJson(res, 200, { ok: true, version, ...page });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: String((e as Error)?.message ?? e) });
    }
  });

  R("/tasks/history", async (req, res) => {
    if (methodOf(req) !== "POST") { sendJson(res, 405, { ok: false, error: "仅支持 POST" }); return; }
    const body = await readJsonBody<TaskHistoryRequest>(req);
    if (body === undefined || typeof body.id !== "string" || typeof body.sessionId !== "string") {
      sendJson(res, 400, { ok: false, error: "缺少 id/sessionId" });
      return;
    }
    try {
      const page = await bridge.history(body);
      sendJson(res, 200, { ok: true, version, ...page });
    } catch (e) {
      sendJson(res, 200, { ok: false, error: String((e as Error)?.message ?? e) });
    }
  });
}
