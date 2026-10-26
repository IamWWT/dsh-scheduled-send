/**
 * dsh-scheduled-send — Host HTTP 路由单元测试（纯 Node，无外部依赖）。
 *
 * 覆盖 0.8.0 端点：health / tasks / update / delete / delete-inactive / run / history，
 * 以及精确路由上的宿主鉴权拒绝。readBody 仍直接读 req（历史上误传 res 会永久挂起）。
 *
 * 运行：node test/routes-test.mjs
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import assert from "node:assert";

const LIB = new URL("../lib/index.js", import.meta.url);
const mod = await import(LIB.href);
const { ScheduleBridge, registerRoutes } = mod;
assert.equal(typeof ScheduleBridge, "function");
assert.equal(typeof registerRoutes, "function");

const stateDir = mkdtempSync(join(tmpdir(), "dss-routes-"));

function makeSchedule() {
  const entries = [];
  let seq = 0;
  return {
    entries,
    async catalog() { return entries.map(e => ({ ...e })); },
    async create(sessionId, request) {
      seq += 1;
      const record = {
        id: `s-${seq}`,
        kind: request.at === undefined ? "every" : "at",
        title: request.title,
        prompt: request.prompt,
        scheduledAt: request.at ?? new Date(Date.now() + 3600_000).toISOString(),
        ...(request.every_seconds === undefined ? {} : { everySeconds: request.every_seconds }),
      };
      entries.push({ ...record, sessionId, status: "active" });
      return record;
    },
    async update() { return { id: "s-1", updated: false, code: "schedule_conflict" }; },
    async delete(request) {
      const i = entries.findIndex(e => e.id === request.id);
      if (i === -1) return { id: request.id, deleted: false };
      entries.splice(i, 1);
      return { id: request.id, deleted: true };
    },
    async deleteInactive() {
      const before = entries.length;
      for (let i = entries.length - 1; i >= 0; i -= 1) if (entries[i].status !== "active") entries.splice(i, 1);
      return { deleted: before - entries.length };
    },
    async history() {
      return { records: [{ scheduledAt: new Date().toISOString(), deliveredAt: new Date().toISOString(), messageId: "m1" }] };
    },
  };
}

const schedule = makeSchedule();
const prompts = [];
const handlers = new Map();
const ctx = {
  webServer: {
    register(spec) { handlers.set(spec.path, spec.handler); return () => {}; },
  },
  schedule,
  sessionController: {
    async create() { return { sessionId: "sess-created" }; },
    async rename() { return {}; },
    async prompt(r) { prompts.push(r); return {}; },
  },
  sessions: { get: () => undefined },
  get() { return undefined; }, // 无 connection：本地测试放行
  on() { return () => {}; },
};

const bridge = new ScheduleBridge(ctx, stateDir, "test");
bridge.start();
registerRoutes(ctx, bridge, "test");

function invoke(path, opts = {}) {
  const handler = handlers.get(`/api/scheduled-send${path}`);
  assert.equal(typeof handler, "function", `未注册路由 ${path}`);
  const req = new EventEmitter();
  req.method = opts.method ?? "GET";
  req.headers = opts.headers ?? {};
  req.destroy = () => {};
  const res = {
    status: undefined,
    body: "",
    writeHead(status) { this.status = status; },
    end(body) { this.body = body ?? ""; },
  };
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`路由 ${path} 挂起`)), 2000);
    Promise.resolve(handler(req, res)).then(() => {
      clearTimeout(timer);
      let json;
      try { json = res.body === "" ? undefined : JSON.parse(res.body); } catch { json = res.body; }
      resolve({ status: res.status, body: json });
    }, reject);
  });
  if (opts.json !== undefined) req.emit("data", Buffer.from(JSON.stringify(opts.json)));
  req.emit("end");
  return done;
}

// 1) 健康检查
{
  const { status, body } = await invoke("/health");
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.scheduleService, true);
}

// 2) 创建任务（工作区 → 建会话）
{
  const { status, body } = await invoke("/tasks", {
    method: "POST",
    json: {
      title: "构建检查",
      prompt: "检查构建",
      workspaceId: "ws-1",
      frequency: { kind: "once", at: new Date(Date.now() + 600_000).toISOString() },
    },
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.task.title, "构建检查");
  assert.equal(body.task.sessionId, "sess-created");
}

// 3) 列表
{
  const { body } = await invoke("/tasks");
  assert.equal(body.ok, true);
  assert.equal(body.tasks.length, 1);
}

// 4) 更新冲突 → 明确失败
{
  const { body } = await invoke("/tasks/update", {
    method: "POST",
    json: { id: "s-1", title: "改名" },
  });
  assert.equal(body.ok, false);
  assert.match(body.error, /拒绝更新/);
}

// 5) 立即执行
{
  const { body } = await invoke("/tasks/run", { method: "POST", json: { id: "s-1" } });
  assert.equal(body.ok, true);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].mode, "queue");
}

// 6) 历史
{
  const { body } = await invoke("/tasks/history", {
    method: "POST",
    json: { id: "s-1", sessionId: "sess-created", limit: 10 },
  });
  assert.equal(body.ok, true);
  assert.equal(body.records.length, 1);
}

// 7) 删除 + 清理已结束
{
  const del = await invoke("/tasks/delete", { method: "POST", json: { id: "s-1" } });
  assert.equal(del.body.ok, true);
  const clean = await invoke("/tasks/delete-inactive", { method: "POST", json: {} });
  assert.equal(clean.body.ok, true);
}

// 8) 方法错误
{
  const { status } = await invoke("/tasks", { method: "PATCH" });
  assert.equal(status, 405);
}

// 9) 精确路由也必须过宿主鉴权
{
  const handlers2 = new Map();
  const ctx2 = {
    webServer: { register(spec) { handlers2.set(spec.path, spec.handler); return () => {}; } },
    schedule,
    sessionController: ctx.sessionController,
    sessions: ctx.sessions,
    get(name) {
      if (name === "connection") return { requestRejection: () => 401 };
      return undefined;
    },
    on() { return () => {}; },
  };
  const bridge2 = new ScheduleBridge(ctx2, stateDir + "-auth", "test");
  registerRoutes(ctx2, bridge2, "test");
  const req = new EventEmitter();
  req.method = "GET";
  req.headers = {};
  req.destroy = () => {};
  const res = { writeHead(s) { this.status = s; }, end(b) { this.body = b ?? ""; } };
  await handlers2.get("/api/scheduled-send/tasks")(req, res);
  assert.equal(res.status, 401);
  bridge2.stop();
}

bridge.stop();
console.log("✔ dsh-scheduled-send routes 全部通过");
