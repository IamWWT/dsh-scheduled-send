/**
 * dsh-scheduled-send — 0.10.9「跨轮转的运行历史」回归测试。
 *
 * 背景：per-run 轮转 = 删旧任务建新任务，官方 `history()` 对新任务是空的，
 * 用户看不到跨轮转的投递/执行历史。插件改为在元数据里按**稳定 taskKey** 自持一份记录。
 *
 * 纯 Node，mock 官方 ctx.schedule / sessionController / workspaceRegistry。
 * 覆盖：
 *   1. 首次投递 → 1 条；两次轮转后 → 2 条且会话 id 与执行序对应（跨任务 id 变化连续）；
 *   2. 幂等：同一 messageId 反复刷新/重复投递只记一条；旧任务 id 仍能查到历史；
 *   3. 执行结果吸附：turn/end 把状态写进对应那条（per-run 轮转后的旧 id 也能找对）；
 *   4. 跨重启：重新 new Bridge（= 重新 apply）后历史从 tasks-meta.json 读回；
 *   5. 上限截断：超过 200 条丢最旧，dropped 计数 + historyTruncated 标记；
 *   6. 写 meta 失败不影响投递/轮转（只 console.warn），页面仍能读到内存里的历史；
 *   7. fixed 任务同样记录（不轮转、会话不变、执行结果同样吸附）。
 *
 * 运行：node test/run-history-test.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";

const LIB = new URL("../lib/index.js", import.meta.url);
const mod = await import(LIB.href);
const Bridge = mod.ScheduleBridge ?? mod.Scheduler ?? mod.default?.ScheduleBridge;
assert.equal(typeof Bridge, "function", "lib/index.js 应导出 ScheduleBridge");

/** 每任务上限（与 src/shared/constants.ts 的 RUN_HISTORY_LIMIT 一致）。 */
const LIMIT = 200;

const iso = (offset = 0) => new Date(Date.now() + offset).toISOString();

/** 官方 Schedule 的最小 mock。 */
function createSchedule() {
  const entries = [];
  const calls = [];
  let seq = 0;
  return {
    entries,
    calls,
    async catalog() { return entries.map(e => ({ ...e })); },
    async create(sessionId, request) {
      calls.push({ op: "create", sessionId, request });
      seq += 1;
      const record = {
        id: `schedule-${seq}`,
        kind: request.every_seconds !== undefined ? "every" : request.at !== undefined ? "at" : "daily",
        title: request.title,
        prompt: request.prompt,
        scheduledAt: request.at ?? iso(3600_000),
        ...(request.every_seconds === undefined ? {} : { everySeconds: request.every_seconds }),
        ...(request.daily === undefined ? {} : { time: request.daily.time, timeZone: request.daily.time_zone }),
      };
      entries.push({ ...record, sessionId, status: "active" });
      return record;
    },
    async update(request) {
      calls.push({ op: "update", request });
      const entry = entries.find(e => e.id === request.id);
      if (entry === undefined) return { id: request.id, updated: false, code: "schedule_not_found" };
      return { id: entry.id, updated: true, record: { ...entry } };
    },
    async delete(request) {
      calls.push({ op: "delete", request });
      const i = entries.findIndex(e => e.id === request.id);
      if (i === -1) return { id: request.id, deleted: false, code: "schedule_not_found" };
      entries.splice(i, 1);
      return { id: request.id, deleted: true };
    },
    async deleteInactive() { calls.push({ op: "deleteInactive" }); return { deleted: 0 }; },
    async history() { return { records: [], earlierRecordsUnavailable: false }; },
    /** 模拟一次官方投递：写回执（官方 commit 后才 emit schedule/changed）。 */
    deliver(id, messageId, deliveredAt = iso(0)) {
      const entry = entries.find(e => e.id === id);
      assert.ok(entry !== undefined, `投递目标任务 ${id} 不存在`);
      entry.lastDelivery = { scheduledAt: iso(0), deliveredAt, messageId };
      entry.scheduledAt = iso(3600_000);
    },
  };
}

function createHost() {
  const schedule = createSchedule();
  const createdSessions = [];
  const prompts = [];
  const sessionEvents = [];
  const attached = new Set();
  const ctx = {
    schedule,
    sessionController: {
      async create(request) {
        const sessionId = `sess-${createdSessions.length + 1}`;
        createdSessions.push({ sessionId, request });
        return { sessionId };
      },
      async rename(request) { return { title: request.title }; },
      async selectModel() { return { selected: {} }; },
      async prompt(request) { prompts.push(request); return { accepted: true }; },
    },
    sessions: { get: () => undefined },
    on(topic, cb) {
      if (topic !== "session/event") return () => {};
      sessionEvents.push(cb);
      // 真宿主返回退订函数：stop() 之后旧实例不得再收事件（否则重启用例会双写）。
      return () => {
        const i = sessionEvents.indexOf(cb);
        if (i !== -1) sessionEvents.splice(i, 1);
      };
    },
    workspaceRegistry: {
      archivedSessionIds: [],
      list() { return [{ id: "ws-1", path: "/tmp/ws-1", sessionIds: [...attached] }]; },
      get(id) {
        if (id !== "ws-1") return undefined;
        return {
          async attachSession(sessionId) { attached.add(sessionId); },
          async detachSession(sessionId) { attached.delete(sessionId); },
        };
      },
    },
  };
  return {
    ctx,
    schedule,
    createdSessions,
    prompts,
    /** 触发一轮「定时投递 → turn/end」，用于验证执行结果吸附。 */
    fire(sessionId, event) { for (const cb of sessionEvents) cb({ id: sessionId }, event); },
    runTurn(sessionId, taskId, { status = "completed", summary = "执行完成", error } = {}) {
      this.fire(sessionId, { type: "turn/start", data: { turn: 1 } });
      this.fire(sessionId, {
        type: "user/message",
        data: {
          content: [{ type: "text", text: `[SCHEDULE REMINDER]\nschedule_id_json: "${taskId}"` }],
          source: { kind: "schedule" },
          role: "user",
          id: "m-1",
        },
      });
      this.fire(sessionId, { type: "assistant/message", data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: summary }] } } });
      this.fire(sessionId, {
        type: "turn/end",
        data: { turn: 1, reason: { kind: status, ...(error === undefined ? {} : { error: { message: error } }) } },
      });
    },
  };
}

const stateDir = mkdtempSync(join(tmpdir(), "dss-run-history-"));
const host = createHost();
const bridge = new Bridge(host.ctx, stateDir, "test");
bridge.start();

const everyMinute = { kind: "every", seconds: 60 };

// ── 1. per-run 任务：两次轮转，历史跨任务 id 连续 ───────────────────────────
const task = await bridge.create({
  title: "日报-历史验证",
  prompt: "只回 OK",
  workspaceId: "ws-1",
  frequency: everyMinute,
  builtin: true,
});
assert.equal(task.sessionMode, "per-run", "builtin 采集类任务缺省 per-run");
const firstSession = task.sessionId;
const taskKey = task.taskKey;
assert.ok(typeof taskKey === "string" && taskKey !== "", "创建时应分配稳定任务键");
assert.equal(task.runCount, 0, "刚建的任务没有运行历史");

host.schedule.deliver(task.id, "msg-A");
let list = await bridge.list();
const rotated1 = list.find(t => t.title === "日报-历史验证");
assert.ok(rotated1 !== undefined, "投递后任务仍在列表");
const secondSession = rotated1.sessionId;
assert.notEqual(secondSession, firstSession, "第一次投递后应轮转到新会话");
assert.equal(rotated1.taskKey, taskKey, "轮转继承稳定任务键（跨官方 id 变化）");
assert.equal(rotated1.runCount, 1, "第一次投递 = 1 条运行历史");

let page = await bridge.runHistory({ id: rotated1.id });
assert.equal(page.entries.length, 1);
assert.equal(page.entries[0].messageId, "msg-A");
assert.equal(page.entries[0].sessionId, firstSession, "记录的是**接收这次投递**的会话（轮转前那个）");
assert.equal(page.entries[0].reason, "scheduled");
assert.equal(page.entries[0].execution, undefined, "还没跑完 = 只有投递记录");
assert.match(String(page.entries[0].sessionTitle), /^日报-历史验证 · /u, "会话标题快照可读");

host.schedule.deliver(rotated1.id, "msg-B");
list = await bridge.list();
const rotated2 = list.find(t => t.title === "日报-历史验证");
assert.ok(rotated2 !== undefined);
assert.notEqual(rotated2.id, rotated1.id, "第二次投递后再次轮转（任务 id 变）");
assert.equal(rotated2.taskKey, taskKey, "第二次轮转仍继承同一个任务键");
assert.equal(rotated2.runCount, 2, "两次投递 = 2 条记录");

page = await bridge.runHistory({ id: rotated2.id });
assert.deepEqual(page.entries.map(e => e.messageId), ["msg-B", "msg-A"], "时间倒序（新的在前）");
assert.deepEqual(page.entries.map(e => e.sessionId), [secondSession, firstSession],
  "两条记录分别对应两次轮转的会话");
assert.equal(page.total, 2);
assert.equal(page.limit, LIMIT);

// 页面手里的旧 id（已被轮转删掉）也能查到同一份历史
const stalePage = await bridge.runHistory({ id: rotated1.id });
assert.deepEqual(stalePage.entries.map(e => e.messageId), ["msg-B", "msg-A"], "旧任务 id 仍能查到历史");

// ── 2. 幂等：重复刷新 / 重复回执不写第二条 ─────────────────────────────────
await bridge.list();
await bridge.list();
page = await bridge.runHistory({ id: rotated2.id });
assert.equal(page.entries.length, 2, "反复刷新不得重复记录（messageId 幂等）");

// 官方把同一条回执再报一次（模拟并发刷新读到同一 lastDelivery）
host.schedule.deliver(rotated2.id, "msg-B");
await bridge.list();
page = await bridge.runHistory({ id: rotated2.id });
assert.equal(page.entries.length, 2, "同一 messageId 再报一次也不得追加");

// ── 3. 执行结果吸附到对应那条（per-run：轮转后的旧 id 也要找得对） ──────────
host.runTurn(secondSession, rotated1.id, { summary: "第二次执行完成" });
page = await bridge.runHistory({ id: rotated2.id });
assert.equal(page.entries[0].execution?.status, "success", "执行结果写进最新那条");
assert.equal(page.entries[0].execution?.summary, "第二次执行完成");
assert.equal(page.entries[1].execution, undefined, "更早那条不受影响（FIFO 吸附）");

host.runTurn(firstSession, task.id, { status: "error", error: "模型凭据缺失" });
page = await bridge.runHistory({ id: rotated2.id });
assert.equal(page.entries[1].execution?.status, "failed", "失败也记录");
assert.equal(page.entries[1].execution?.error, "模型凭据缺失");

// ── 4. 跨重启：重新 apply（new Bridge 读同一 stateDir）后历史仍在 ──────────
bridge.stop();
const restarted = new Bridge(host.ctx, stateDir, "test");
restarted.start();
const restartedList = await restarted.list();
const afterRestart = restartedList.find(t => t.title === "日报-历史验证");
assert.ok(afterRestart !== undefined);
assert.equal(afterRestart.taskKey, taskKey, "重启后任务键不变");
assert.equal(afterRestart.runCount, 2, "重启后历史条数不变");
const restartedPage = await restarted.runHistory({ id: afterRestart.id });
assert.deepEqual(restartedPage.entries.map(e => e.messageId), ["msg-B", "msg-A"], "重启后历史内容读回");
assert.equal(restartedPage.entries[0].execution?.summary, "第二次执行完成", "执行摘要一并读回");

// ── 5. fixed 任务同样记录（不轮转、会话不变） ──────────────────────────────
const fixed = await restarted.create({
  title: "fixed-历史验证",
  prompt: "x",
  workspaceId: "ws-1",
  frequency: everyMinute,
});
assert.equal(fixed.sessionMode, "fixed");
const fixedSession = fixed.sessionId;
host.schedule.deliver(fixed.id, "msg-F1");
let flist = await restarted.list();
const fixedAfter = flist.find(t => t.id === fixed.id);
assert.ok(fixedAfter !== undefined, "fixed 任务投递后 id/会话都不变");
assert.equal(fixedAfter.sessionId, fixedSession);
assert.equal(fixedAfter.runCount, 1, "fixed 任务同样有运行历史");
host.runTurn(fixedSession, fixed.id, { summary: "fixed 执行完成" });
let fpage = await restarted.runHistory({ id: fixed.id });
assert.equal(fpage.entries[0].sessionId, fixedSession);
assert.equal(fpage.entries[0].execution?.status, "success");
assert.equal(fpage.entries[0].execution?.summary, "fixed 执行完成");

// 4b) 顺序错位：执行结果先到、投递记录后到（模型快速失败的真实场景）——
//     先缓冲，等刷新把投递记录写进来再吸附，不能永远停在「投递成功」。
{
  const fast = await restarted.create({
    title: "fixed-顺序错位验证",
    prompt: "x",
    workspaceId: "ws-1",
    frequency: everyMinute,
  });
  host.schedule.deliver(fast.id, "msg-ORD");
  // 故意不刷新：turn/end 比「从官方回执里读投递记录」的那次刷新更早发生
  const bufferedWarnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { bufferedWarnings.push(args.map(String).join(" ")); };
  try {
    host.runTurn(fast.sessionId, fast.id, { status: "error", error: "无凭据" });
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(
    bufferedWarnings.some(w => /已缓冲待投递记录落地/u.test(w)),
    "执行结果先到时必须进缓冲并留痕（不是静默丢弃）",
  );
  await restarted.list();
  const afterRefresh = await restarted.runHistory({ id: fast.id });
  assert.equal(afterRefresh.entries.length, 1);
  assert.equal(afterRefresh.entries[0].messageId, "msg-ORD");
  assert.equal(afterRefresh.entries[0].execution?.status, "failed",
    "先到的执行结果在投递记录落地后被补吸附（不会停在投递成功）");
  await restarted.delete(fast.id);
}

// 手动「立即执行」也要记一条（幂等键 = manual:<requestId>）
await restarted.runNow(fixed.id);
fpage = await restarted.runHistory({ id: fixed.id });
assert.equal(fpage.entries.length, 2, "手动执行同样入历史");
assert.equal(fpage.entries[0].reason, "manual-run");
assert.equal(fpage.entries[0].sessionId, fixedSession);
assert.match(String(fpage.entries[0].messageId), /^manual:scheduled-send-/u, "手动执行有独立幂等键");
assert.equal(host.prompts.length, 1, "手动执行确实投递了");

// 手动执行的执行结果也要归因：手动 prompt 没有 schedule framing，靠「登记过的会话 + 下一个 turn/end」
host.fire(fixedSession, { type: "turn/start", data: { turn: 2 } });
host.fire(fixedSession, { type: "assistant/message", data: { turn: 2, step: 1, message: { role: "assistant", content: [{ type: "text", text: "手动执行完成" }] } } });
host.fire(fixedSession, { type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } });
fpage = await restarted.runHistory({ id: fixed.id });
assert.equal(fpage.entries[0].reason, "manual-run");
assert.equal(fpage.entries[0].execution?.status, "success", "手动执行的结果写进 manual-run 那条");
assert.equal(fpage.entries[0].execution?.summary, "手动执行完成");

// ── 6. 上限截断：超过 200 条丢最旧 ─────────────────────────────────────────
const bulk = await restarted.create({
  title: "批量-截断验证",
  prompt: "x",
  workspaceId: "ws-1",
  frequency: everyMinute,
});
for (let i = 1; i <= LIMIT + 5; i += 1) {
  host.schedule.deliver(bulk.id, `bulk-${i}`);
  await restarted.list();
}
const blist = await restarted.list();
const bulkAfter = blist.find(t => t.id === bulk.id);
assert.equal(bulkAfter.runCount, LIMIT, `运行历史最多保留 ${LIMIT} 条`);
assert.equal(bulkAfter.historyTruncated, true, "截断后 TaskView 标记已截断");
const bpage = await restarted.runHistory({ id: bulk.id, limit: LIMIT });
assert.equal(bpage.entries.length, LIMIT);
assert.equal(bpage.dropped, 5, "丢弃数 = 超出的 5 条");
assert.equal(bpage.entries[0].messageId, `bulk-${LIMIT + 5}`, "保留最新的一条");
assert.equal(bpage.entries.at(-1).messageId, "bulk-6", "丢弃的是最旧的 5 条");

// 默认分页：不传 limit 时只返 50 条
const bulkDefault = await restarted.runHistory({ id: bulk.id });
assert.equal(bulkDefault.entries.length, 50, "默认只返回最近 50 条");
assert.equal(bulkDefault.total, LIMIT, "total 报的是实际保留条数");

// 任务删除后历史跟着清掉，不留无主数据
await restarted.delete(bulk.id);
await restarted.list();
const metaFileAfterDelete = JSON.parse(readFileSync(join(stateDir, "tasks-meta.json"), "utf-8"));
assert.equal(
  Object.keys(metaFileAfterDelete.histories ?? {}).includes(bulk.taskKey ?? ""),
  false,
  "删除任务后对应运行历史被清理",
);
restarted.stop();

// ── 7. 写 meta 失败不得影响投递/轮转 ──────────────────────────────────────
const brokenDir = mkdtempSync(join(tmpdir(), "dss-run-history-broken-"));
const host2 = createHost();
const bridge2 = new Bridge(host2.ctx, brokenDir, "test");
bridge2.start();
const brokenTask = await bridge2.create({
  title: "日报-写盘失败演练",
  prompt: "x",
  workspaceId: "ws-1",
  frequency: everyMinute,
  builtin: true,
});
// 把元数据文件换成目录 → save() 的 renameSync 必然失败，但插件必须照常投递/轮转。
const metaPath = join(brokenDir, "tasks-meta.json");
renameSync(metaPath, `${metaPath}.bak`);
mkdirSync(metaPath);
const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };

let listAfterBroken = [];
try {
  host2.schedule.deliver(brokenTask.id, "msg-broken");
  listAfterBroken = await bridge2.list();
} finally {
  console.warn = originalWarn;
}
const brokenAfter = listAfterBroken.find(t => t.title === "日报-写盘失败演练");
assert.ok(brokenAfter !== undefined, "写 meta 失败不得影响任务列表");
assert.notEqual(brokenAfter.sessionId, brokenTask.sessionId, "写 meta 失败仍必须完成轮转");
assert.equal(host2.schedule.entries.filter(e => e.title === "日报-写盘失败演练").length, 1,
  "写 meta 失败也不得留下重复任务");
assert.ok(
  warnings.some(w => /元数据写入失败/u.test(w)),
  "写盘失败必须如实进 console（journal 可查），不能静默",
);
// 内存里的历史仍可读（页面不会白屏）
const brokenPage = await bridge2.runHistory({ id: brokenAfter.id });
assert.equal(brokenPage.entries.length, 1, "写盘失败仍能读到内存中的历史");
// 手动执行同样不受影响
await bridge2.runNow(brokenAfter.id);
assert.equal(host2.prompts.length, 1, "写盘失败不得影响手动执行投递");
bridge2.stop();
// 复原临时目录（把被替换的元数据放回去，避免后续排查困惑）
rmSync(metaPath, { recursive: true, force: true });
if (existsSync(`${metaPath}.bak`)) renameSync(`${metaPath}.bak`, metaPath);

console.log("✔ dsh-scheduled-send 运行历史全部通过");
