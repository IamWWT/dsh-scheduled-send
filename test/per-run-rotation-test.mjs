/**
 * dsh-scheduled-send — 0.10.8「每次执行新建会话」（per-run 轮转）回归测试。
 *
 * 纯 Node，mock 官方 ctx.schedule / sessionController / workspaceRegistry。
 * 覆盖：
 *   1. 会话模式缺省判定（builtin 采集类 per-run、自定义/单次 fixed）；
 *   2. per-run 首次会话命名带日期时间 + 建后即退席；
 *   3. 投递后轮转：新会话 → 新官方任务 → 删旧任务，配置与元数据全继承；
 *   4. 轮转幂等（同一条投递只轮转一次；刷新多次不重复建会话）；
 *   5. 第二次投递再轮转（每天都一个新会话，任务指向第三个未用会话）；
 *   6. fixed 任务不受影响（只用一个会话）；
 *   7. 轮转失败保留原任务并给出可见错误（会话建不出来 / 删旧失败要回滚）；
 *   8. 崩溃留下的半截交换（pendingSwap）自愈；
 *   9. 执行过的轮转会话在 turn/start 后挂回工作区。
 *
 * 运行：node test/per-run-rotation-test.mjs
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";

const LIB = new URL("../lib/index.js", import.meta.url);
const mod = await import(LIB.href);
const Bridge = mod.ScheduleBridge ?? mod.Scheduler ?? mod.default?.ScheduleBridge;
assert.equal(typeof Bridge, "function", "lib/index.js 应导出 ScheduleBridge");

const iso = (offset) => new Date(Date.now() + offset).toISOString();

/** 官方 Schedule 的最小 mock（与 smoke-test 同形，外加失败注入）。 */
function createSchedule() {
  const entries = [];
  const calls = [];
  let seq = 0;
  const state = { failDeleteOnce: null, failDeleteAlways: null };
  return {
    entries,
    calls,
    state,
    async catalog() {
      return entries.map(e => ({ ...e }));
    },
    async create(sessionId, request) {
      calls.push({ op: "create", sessionId, request });
      seq += 1;
      const record = {
        id: `schedule-${seq}`,
        kind: request.at !== undefined ? "at" : request.every_seconds !== undefined ? "every"
          : request.daily !== undefined ? "daily" : request.weekly !== undefined ? "weekly"
            : request.cron !== undefined ? "cron" : "after",
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
      if (state.failDeleteOnce === request.id) {
        state.failDeleteOnce = null;
        throw new Error("模拟删旧失败");
      }
      if (state.failDeleteAlways === request.id) throw new Error("模拟删除持续失败");
      const i = entries.findIndex(e => e.id === request.id);
      if (i === -1) return { id: request.id, deleted: false, code: "schedule_not_found" };
      entries.splice(i, 1);
      return { id: request.id, deleted: true };
    },
    async deleteInactive() {
      calls.push({ op: "deleteInactive" });
      return { deleted: 0 };
    },
    async history() {
      return { records: [], earlierRecordsUnavailable: false };
    },
    /** 模拟一次官方投递：给任务行写回执（官方 commit 后才 emit schedule/changed）。 */
    deliver(id, messageId) {
      const entry = entries.find(e => e.id === id);
      assert.ok(entry !== undefined, `投递目标任务 ${id} 不存在`);
      entry.lastDelivery = { scheduledAt: iso(0), deliveredAt: iso(0), messageId };
      entry.scheduledAt = iso(3600_000);
    },
  };
}

function createHost() {
  const schedule = createSchedule();
  const createdSessions = [];
  const renamed = [];
  const prompts = [];
  const modelCalls = [];
  const sessionEvents = [];
  const attached = new Set();
  const workspaceCalls = [];
  const flags = { failSessionCreate: false };

  const ctx = {
    schedule,
    sessionController: {
      async create(request) {
        if (flags.failSessionCreate) throw new Error("模拟建会话失败");
        const sessionId = `sess-${createdSessions.length + 1}`;
        createdSessions.push({ sessionId, request });
        return { sessionId };
      },
      async rename(request) { renamed.push(request); return { title: request.title }; },
      async selectModel(request) { modelCalls.push(request); return { selected: {} }; },
      async prompt(request) { prompts.push(request); return { accepted: true }; },
    },
    sessions: { get: () => undefined },
    on(topic, cb) {
      if (topic === "session/event") sessionEvents.push(cb);
      return () => {};
    },
    workspaceRegistry: {
      archivedSessionIds: [],
      list() { return [{ id: "ws-1", path: "/tmp/ws-1", sessionIds: [...attached] }]; },
      get(id) {
        if (id !== "ws-1") return undefined;
        return {
          async attachSession(sessionId) { attached.add(sessionId); workspaceCalls.push({ op: "attach", sessionId }); },
          async detachSession(sessionId) { attached.delete(sessionId); workspaceCalls.push({ op: "detach", sessionId }); },
        };
      },
    },
  };
  return {
    ctx,
    schedule,
    flags,
    createdSessions,
    renamed,
    prompts,
    modelCalls,
    attached,
    workspaceCalls,
    fire(sessionId, event) { for (const cb of sessionEvents) cb({ id: sessionId }, event); },
  };
}

const stateDir = mkdtempSync(join(tmpdir(), "dss-per-run-"));
const host = createHost();
const bridge = new Bridge(host.ctx, stateDir, "test");
bridge.start();

// ── 1. 会话模式缺省判定 ───────────────────────────────────────────────
const dailyFreq = { kind: "daily", time: "09:00:00", timeZone: "Asia/Shanghai" };

const collectionDefault = await bridge.create({
  title: "日报-每日日记收集",
  prompt: "收集今天的日记",
  workspaceId: "ws-1",
  frequency: dailyFreq,
  builtin: true,
});
assert.equal(collectionDefault.sessionMode, "per-run", "builtin 采集类任务默认 per-run");

const weeklyCollection = await bridge.create({
  title: "周报-每周总结",
  prompt: "写周报",
  workspaceId: "ws-1",
  frequency: { kind: "weekly", time: "09:00:00", timeZone: "Asia/Shanghai", weekdays: [1] },
  builtin: true,
});
assert.equal(weeklyCollection.sessionMode, "per-run", "周报同样默认 per-run");

const customTask = await bridge.create({
  title: "自定义提醒",
  prompt: "x",
  workspaceId: "ws-1",
  frequency: dailyFreq,
});
assert.equal(customTask.sessionMode, "fixed", "非 builtin 缺省 fixed");

const builtinButFixed = await bridge.create({
  title: "月报-月报总结",
  prompt: "写月报",
  workspaceId: "ws-1",
  frequency: dailyFreq,
  builtin: true,
  sessionMode: "fixed",
});
assert.equal(builtinButFixed.sessionMode, "fixed", "显式 fixed 覆盖采集类缺省");

const onceCollection = await bridge.create({
  title: "日报-临时一次",
  prompt: "一次性",
  workspaceId: "ws-1",
  frequency: { kind: "once", at: iso(600_000) },
  builtin: true,
  sessionMode: "per-run",
});
assert.equal(onceCollection.sessionMode, "fixed", "单次任务强制 fixed（无下一次可轮转）");

// 单次任务禁止事后切成 per-run（报错而不是静默降级）
await assert.rejects(
  () => bridge.update({ id: onceCollection.id, sessionMode: "per-run" }),
  /单次任务不支持/,
  "单次任务切 per-run 应报错",
);

// ── 2. per-run 首次会话命名 + 建后即退席 ───────────────────────────────
const firstSession = host.createdSessions[0].sessionId;
const firstRename = host.renamed.find(r => r.sessionId === firstSession);
assert.ok(firstRename !== undefined, "per-run 建会话后应 rename");
assert.match(firstRename.title, /^日报-每日日记收集 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u,
  "per-run 会话名 = 任务名 · 本地日期时间");
assert.ok(
  host.workspaceCalls.some(c => c.op === "detach" && c.sessionId === firstSession),
  "per-run 会话建好即退席（沿用 0.10.7 的 releaseSeat）",
);
assert.equal(host.attached.has(firstSession), false, "退席后不在工作区名单");

// ── 3. 投递后轮转：新会话 → 新任务 → 删旧任务，配置全继承 ──────────────
await bridge.update({ id: collectionDefault.id, endsAt: Date.now() + 5 * 86400_000 });
const beforeRotate = host.createdSessions.length;
const taskCountBefore = host.schedule.entries.length;
const oldId = collectionDefault.id;
host.schedule.deliver(oldId, "msg-A");

let list = await bridge.list();
assert.equal(host.createdSessions.length, beforeRotate + 1, "投递后应新建 1 个会话");
const secondSession = host.createdSessions.at(-1).sessionId;
assert.notEqual(secondSession, firstSession, "新会话必须不同于已投递的会话");
const secondRename = host.renamed.find(r => r.sessionId === secondSession);
assert.match(secondRename.title, /^日报-每日日记收集 · /u, "轮转会话同样带日期时间");
assert.equal(host.attached.has(secondSession), false, "轮转出来的新会话也立即退席");

assert.equal(host.schedule.entries.some(e => e.id === oldId), false, "旧任务行应被删除（不重复投递）");
assert.equal(host.schedule.entries.length, taskCountBefore, "官方任务总数不变（删一条建一条，不留重复）");

const rotated = list.find(t => t.sessionId === secondSession && t.title === "日报-每日日记收集");
assert.ok(rotated !== undefined, "列表里任务的当前绑定 = 新会话");
assert.equal(rotated.sessionMode, "per-run");
assert.equal(rotated.endsAt !== undefined, true, "截止时间继承到新任务");
assert.equal(rotated.builtin, true, "builtin 归属继承");
assert.equal(rotated.lastRunSessionId, firstSession, "「本次执行会话」= 轮转走的会话");
assert.match(rotated.lastRunSessionTitle, /^日报-每日日记收集 · /u, "本次执行会话标题可读");

const rotatedCreate = host.schedule.calls.filter(c => c.op === "create").at(-1);
assert.equal(rotatedCreate.sessionId, secondSession, "新官方任务绑定新会话");
assert.equal(rotatedCreate.request.daily.time, "09:00:00", "频率配置原样保留");
assert.equal(rotatedCreate.request.title, "日报-每日日记收集", "标题保留");
assert.equal(rotatedCreate.request.prompt, "收集今天的日记", "提示词保留");

// ── 4. 幂等：同一投递不重复轮转 ───────────────────────────────────────
const afterFirstRotation = host.createdSessions.length;
await bridge.list();
await bridge.list();
assert.equal(host.createdSessions.length, afterFirstRotation, "重复刷新不得再建会话（幂等）");
assert.equal(
  host.schedule.calls.filter(c => c.op === "delete").length,
  1,
  "同一次投递只删一条旧任务",
);

// ── 5. 第二次投递 → 第三个会话（每天一个新会话，任务指向未使用的新会话） ──
host.schedule.deliver(rotated.id, "msg-B");
list = await bridge.list();
assert.equal(host.createdSessions.length, afterFirstRotation + 1, "第二次投递再建一个会话");
const thirdSession = host.createdSessions.at(-1).sessionId;
assert.equal(new Set([firstSession, secondSession, thirdSession]).size, 3, "三次执行 = 三个不同会话");
const next = list.find(t => t.sessionId === thirdSession && t.title === "日报-每日日记收集");
assert.ok(next !== undefined, "任务已指向第三个（未使用过的）会话");
assert.equal(next.lastRunSessionId, secondSession, "上一次执行会话跟着前移");
assert.equal(host.schedule.entries.some(e => e.sessionId === secondSession && e.title === "日报-每日日记收集"), false,
  "第二次执行的任务行已删除");

// ── 6. fixed 任务不受影响 ─────────────────────────────────────────────
const fixedEntry = host.schedule.entries.find(e => e.id === customTask.id);
assert.ok(fixedEntry !== undefined);
const fixedSessionsBefore = host.createdSessions.length;
host.schedule.deliver(customTask.id, "msg-C");
await bridge.list();
assert.equal(host.createdSessions.length, fixedSessionsBefore, "fixed 任务投递后不建新会话");
const fixedAfter = host.schedule.entries.find(e => e.id === customTask.id);
assert.ok(fixedAfter !== undefined, "fixed 任务行保持原 id");
assert.equal(fixedAfter.sessionId, customTask.sessionId, "fixed 任务始终用一个会话");

// ── 7a. 轮转失败（会话建不出来）→ 保留原任务 + 可见错误 ────────────────
const failTask = await bridge.create({
  title: "日报-失败演练",
  prompt: "x",
  workspaceId: "ws-1",
  frequency: dailyFreq,
  builtin: true,
});
const failSession = failTask.sessionId;
host.flags.failSessionCreate = true;
host.schedule.deliver(failTask.id, "msg-D");
list = await bridge.list();
const failView = list.find(t => t.id === failTask.id);
assert.ok(failView !== undefined, "轮转失败时任务必须保留");
assert.equal(failView.sessionId, failSession, "失败后仍绑原会话");
assert.match(String(failView.rotateError?.message), /模拟建会话失败/u, "失败原因写进 TaskView，页面可见");

// 同一次投递最多重试 2 次，之后等下一次投递（避免每 5 秒重建一次会话/刷日志）
const sessionsAfterFailure = host.createdSessions.length;
await bridge.list();
await bridge.list();
await bridge.list();
assert.equal(host.createdSessions.length, sessionsAfterFailure, "失败重试有上限，且失败阶段不留下半截会话");

// 恢复正常后，下一次投递能正常轮转并清掉错误
host.flags.failSessionCreate = false;
host.schedule.deliver(failTask.id, "msg-E");
list = await bridge.list();
const healed = list.find(t => t.title === "日报-失败演练");
assert.ok(healed !== undefined);
assert.notEqual(healed.sessionId, failSession, "恢复后正常轮转");
assert.equal(healed.rotateError, undefined, "成功轮转后清掉错误标记");

// ── 7b. 删旧失败 → 回滚新增任务，旧任务原样保留 ────────────────────────
const rollbackTask = await bridge.create({
  title: "日报-回滚演练",
  prompt: "y",
  workspaceId: "ws-1",
  frequency: dailyFreq,
  builtin: true,
});
const rollbackSession = rollbackTask.sessionId;
host.schedule.deliver(rollbackTask.id, "msg-F");
host.schedule.state.failDeleteOnce = rollbackTask.id;
list = await bridge.list();
const rollbackView = list.find(t => t.id === rollbackTask.id);
assert.ok(rollbackView !== undefined, "删旧失败必须回滚，任务不能丢");
assert.equal(rollbackView.sessionId, rollbackSession, "任务回到原会话");
assert.match(String(rollbackView.rotateError?.message), /模拟删旧失败/u, "回滚原因可见");
assert.equal(
  host.schedule.entries.filter(e => e.title === "日报-回滚演练").length,
  1,
  "回滚后不得残留重复任务",
);
assert.equal(host.schedule.entries.some(e => e.title === "日报-回滚演练" && e.sessionId !== rollbackSession), false,
  "回滚后不留指向新会话的任务行");

// ── 8. 半截交换自愈（进程在「建新任务 → 删旧任务」之间退出） ─────────────
const crashTask = await bridge.create({
  title: "日报-崩溃演练",
  prompt: "z",
  workspaceId: "ws-1",
  frequency: dailyFreq,
  builtin: true,
});
// 手工造出崩溃现场：官方表里同时有旧任务与「新会话上的同标题任务」，旧任务 meta 带 pendingSwap
const crashNewSession = "sess-crash-new";
const orphan = await host.schedule.create(crashNewSession, {
  title: "日报-崩溃演练",
  prompt: "z",
  daily: { time: "09:00:00", time_zone: "Asia/Shanghai" },
});
const metaStorePath = join(stateDir, "tasks-meta.json");
const metaFile = JSON.parse((await import("node:fs")).readFileSync(metaStorePath, "utf-8"));
metaFile.tasks[crashTask.id] = {
  ...metaFile.tasks[crashTask.id],
  sessionMode: "per-run",
  pendingSwap: { newSessionId: crashNewSession, messageId: "msg-crash", at: Date.now() },
};
(await import("node:fs")).writeFileSync(metaStorePath, JSON.stringify(metaFile, null, 2), "utf-8");

const healedBridge = new Bridge(host.ctx, stateDir, "test");
healedBridge.start();
list = await healedBridge.list();
assert.equal(
  host.schedule.entries.filter(e => e.title === "日报-崩溃演练").length,
  1,
  "半截交换收尾：只留新任务，不留重复",
);
const survivor = host.schedule.entries.find(e => e.title === "日报-崩溃演练");
assert.equal(survivor.id, orphan.id, "留下的是已建好的新任务");
const survivorView = list.find(t => t.title === "日报-崩溃演练");
assert.equal(survivorView.id, orphan.id);
assert.equal(survivorView.lastRunSessionId, crashTask.sessionId, "继承「本次执行会话」");
// 收尾后不得因为同一条 messageId 再轮转一次
const sessionsAfterHeal = host.createdSessions.length;
await healedBridge.list();
assert.equal(host.createdSessions.length, sessionsAfterHeal, "收尾后不重复轮转");
healedBridge.stop();

// ── 9. 执行过的轮转会话在 turn/start 后挂回工作区 ──────────────────────
assert.equal(host.attached.has(firstSession), false, "刚轮转走时该会话尚未挂回");
host.fire(firstSession, { type: "turn/start", data: { turn: 1 } });
await new Promise(r => setTimeout(r, 30));
assert.equal(host.attached.has(firstSession), true, "执行过的会话在 turn/start 后挂回工作区（历史可点开）");
assert.ok(
  host.workspaceCalls.some(c => c.op === "attach" && c.sessionId === firstSession),
  "挂回走 attachSession",
);
// 还没用过的新会话不能提前挂回（否则会被 web「新会话」复用）
assert.equal(host.attached.has(thirdSession), false, "未执行的新会话保持退席");

bridge.stop();
console.log("✔ dsh-scheduled-send per-run 轮转全部通过");
