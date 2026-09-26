/**
 * dsh-scheduled-send — Host HTTP 路由单元测试（纯 Node，无外部依赖）。
 *
 * 覆盖 `src/host/routes.ts` 的全部端点，用 mock webServer 捕获 handler、
 * 用 EventEmitter 模拟 req/res 直接调用：
 *   GET  /health /jobs；POST /jobs（新建/更新）；/jobs/cancel /delete /fire；405。
 * 关键回归项：**readBody 必须读 req**（v0.5.0 卡死根因——若误传 res，handler 永不
 * resolve）。每个调用带 2s 超时守卫：handler 挂起即判定失败。
 *
 * 运行：node test/routes-test.mjs（pnpm test 会一并执行）
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import assert from "node:assert";

const LIB = new URL("../lib/index.js", import.meta.url);
const mod = await import(LIB.href);
const { Scheduler, registerRoutes } = mod;

const tmp = mkdtempSync(join(tmpdir(), "dss-route-"));
const stateDir = join(tmp, "st");

/** mock ctx：webServer 捕获 handler；sessionController 记录 prompt 调用。 */
const promptCalls = [];
const handlers = new Map(); // path -> handler
const ctx = {
  webServer: {
    register: (spec) => { handlers.set(spec.path, spec.handler); return () => {}; },
  },
  get: (k) => (k === "sessionController" ? {
    prompt: async (r) => { promptCalls.push(r); return { accepted: true }; },
  } : undefined),
};

const scheduler = new Scheduler({ stateDir, version: "test" });
scheduler.attach(ctx);
registerRoutes(ctx, scheduler, "0.6.0-test");

/** 断言 path 已注册。 */
function assertRegistered(path) {
  assert.ok(handlers.has(path), `路由未注册：${path}`);
}

/**
 * 调用一个 handler。带 2s 超时守卫——若 readBody 误传 res（handler 永不返回），
 * 这里直接失败，而不是让整个测试挂起。
 * @returns {Promise<{status:number, body:unknown}>}
 */
async function invoke(path, { method = "GET", json } = {}) {
  const handler = handlers.get(path);
  assert.ok(handler, `handler 不存在：${path}`);
  const req = new EventEmitter();
  req.method = method;
  let status = 0;
  let bodyText = "";
  const res = {
    writeHead: (s) => { status = s; },
    end: (b) => { bodyText = b; },
  };
  const result = handler(req, res);
  if (json !== undefined) {
    const buf = Buffer.from(JSON.stringify(json));
    queueMicrotask(() => {
      req.emit("data", buf);
      req.emit("end");
    });
  } else if (method === "POST") {
    // POST 无 body 也应正常结束（空 body → 400）
    queueMicrotask(() => req.emit("end"));
  }
  const timed = await Promise.race([
    result.then(() => true),
    new Promise((r) => setTimeout(() => r(false), 2000)),
  ]);
  assert.ok(timed, `handler 挂起超过 2s：${path}（疑似 readBody 传错对象？）`);
  return { status, body: bodyText ? JSON.parse(bodyText) : null };
}

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  PASS  ${name}`); };

// ---- GET /health ----------------------------------------------------------
assertRegistered("/api/scheduled-send/health");
{
  const { status, body } = await invoke("/api/scheduled-send/health");
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.version, "0.6.0-test");
  assert.equal(typeof body.pending, "number");
  ok("GET /health 返回版本与统计");
}

// ---- GET /jobs（空表）-----------------------------------------------------
assertRegistered("/api/scheduled-send/jobs");
{
  const { status, body } = await invoke("/api/scheduled-send/jobs");
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.jobs, []);
  ok("GET /jobs 空表");
}

// ---- POST /jobs 新建（缺 sessionId）---------------------------------------
{
  const { body } = await invoke("/api/scheduled-send/jobs", {
    method: "POST",
    json: { text: "x", fireAt: Date.now() + 60000 },
  });
  assert.equal(body.ok, false);
  assert.match(body.error ?? "", /sessionId/);
  ok("POST /jobs 缺 sessionId → 拒绝");
}

// ---- POST /jobs 新建（缺 text）--------------------------------------------
{
  const { body } = await invoke("/api/scheduled-send/jobs", {
    method: "POST",
    json: { sessionId: "s1", fireAt: Date.now() + 60000 },
  });
  assert.equal(body.ok, false);
  assert.match(body.error ?? "", /text/);
  ok("POST /jobs 缺 text → 拒绝");
}

// ---- POST /jobs 新建（fireAt 为过去）---------------------------------------
{
  const { body } = await invoke("/api/scheduled-send/jobs", {
    method: "POST",
    json: { sessionId: "s1", text: "x", fireAt: Date.now() - 1000 },
  });
  assert.equal(body.ok, false);
  assert.match(body.error ?? "", /晚于/);
  ok("POST /jobs fireAt 过去 → 拒绝");
}

// ---- POST /jobs 新建（超出最晚边界：明天 23:59:59）-------------------------
{
  const { body } = await invoke("/api/scheduled-send/jobs", {
    method: "POST",
    json: { sessionId: "s1", text: "x", fireAt: Scheduler.maxFireAt() + 1000 },
  });
  assert.equal(body.ok, false);
  assert.match(body.error ?? "", /明天 23:59:59/);
  ok("POST /jobs fireAt 超出明天结束 → 拒绝（maxFireAt 消费）");
}

// ---- POST /jobs 新建（正常）------------------------------------------------
let created;
{
  const { status, body } = await invoke("/api/scheduled-send/jobs", {
    method: "POST",
    json: { sessionId: "sess-e2e", text: "hello", fireAt: Date.now() + 3600_000 },
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(body.job?.id);
  assert.equal(body.job.status, "pending");
  created = body.job;
  ok("POST /jobs 新建成功（pending）");
}

// ---- 每会话最多 3 个（经 HTTP 层）-----------------------------------------
{
  let lastBody = null;
  for (let i = 0; i < 2; i++) {
    const r = await invoke("/api/scheduled-send/jobs", {
      method: "POST",
      json: { sessionId: "sess-e2e", text: `msg-${i}`, fireAt: Date.now() + 3600_000 + i },
    });
    lastBody = r.body;
  }
  const r4 = await invoke("/api/scheduled-send/jobs", {
    method: "POST",
    json: { sessionId: "sess-e2e", text: "msg-4", fireAt: Date.now() + 3600_000 },
  });
  assert.equal(r4.body.ok, false);
  assert.match(r4.body.error ?? "", /最多/);
  ok("每会话最多 3 个：第 4 个经 HTTP 被拒");
}

// ---- POST /jobs 更新（by id；模拟客户端编辑只发 {id,text}，无 sessionId）-----
{
  const { body } = await invoke("/api/scheduled-send/jobs", {
    method: "POST",
    json: { id: created.id, text: "updated-text" },
  });
  assert.equal(body.ok, true);
  assert.equal(body.job.text, "updated-text");
  assert.equal(body.job.status, "pending");
  ok("POST /jobs 更新文本成功（仅 {id,text}）");
}

// ---- POST /jobs 更新（空 text 拒绝）---------------------------------------
{
  const { body } = await invoke("/api/scheduled-send/jobs", {
    method: "POST",
    json: { id: created.id, text: "   " },
  });
  assert.equal(body.ok, false);
  assert.match(body.error ?? "", /text/);
  ok("POST /jobs 更新空 text → 拒绝");
}

// ---- POST /jobs 更新（无 text 无 fireAt → 拒绝）----------------------------
{
  const { body } = await invoke("/api/scheduled-send/jobs", {
    method: "POST",
    json: { id: created.id },
  });
  assert.equal(body.ok, false);
  assert.match(body.error ?? "", /text 或 fireAt/);
  ok("POST /jobs 更新既无 text 也无 fireAt → 拒绝");
}

// ---- POST /jobs/fire（mock sessionController 记录 mode:queue）-------------
{
  const { body } = await invoke("/api/scheduled-send/jobs/fire", {
    method: "POST",
    json: { id: created.id },
  });
  assert.equal(body.ok, true);
  assert.equal(body.job.status, "sent");
  const call = promptCalls[promptCalls.length - 1];
  assert.equal(call.mode, "queue");
  assert.equal(call.sessionId, "sess-e2e");
  assert.equal(call.content[0].text, "updated-text");
  ok("POST /jobs/fire 投递（mode:queue，读回更新后的文本）");
}

// ---- POST /jobs/cancel------------------------------------------------------
let cancelledId;
{
  const r = await invoke("/api/scheduled-send/jobs", {
    method: "POST",
    json: { sessionId: "sess-e2e", text: "cancel-me", fireAt: Date.now() + 3600_000 },
  });
  cancelledId = r.body.job.id;
  const { body } = await invoke("/api/scheduled-send/jobs/cancel", {
    method: "POST",
    json: { id: cancelledId },
  });
  assert.equal(body.ok, true);
  const after = scheduler.get(cancelledId);
  assert.equal(after.status, "cancelled");
  ok("POST /jobs/cancel → cancelled");
}

// ---- POST /jobs/delete------------------------------------------------------
{
  const { body } = await invoke("/api/scheduled-send/jobs/delete", {
    method: "POST",
    json: { id: cancelledId },
  });
  assert.equal(body.ok, true);
  assert.equal(scheduler.get(cancelledId), undefined);
  ok("POST /jobs/delete 移除");
}

// ---- 非法 JSON body → 400---------------------------------------------------
{
  const handler = handlers.get("/api/scheduled-send/jobs");
  const req = new EventEmitter();
  req.method = "POST";
  let status = 0;
  const res = { writeHead: (s) => { status = s; }, end: () => {} };
  const result = handler(req, res);
  queueMicrotask(() => { req.emit("data", Buffer.from("{not-json")); req.emit("end"); });
  const timed = await Promise.race([
    result.then(() => true),
    new Promise((r) => setTimeout(() => r(false), 2000)),
  ]);
  assert.ok(timed, "非法 JSON 也应快速返回");
  assert.equal(status, 400);
  ok("非法 JSON body → 400");
}

// ---- 不支持的方法 → 405-----------------------------------------------------
{
  const { status } = await invoke("/api/scheduled-send/jobs", { method: "PATCH" });
  assert.equal(status, 405);
  ok("PATCH /jobs → 405");
}

console.log(`\n✔ routes 单元测试全部通过（${passed} 项）`);