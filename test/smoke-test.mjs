/**
 * dsh-scheduled-send — Host 适配层冒烟测试（纯 Node，无外部依赖）。
 *
 * 0.8.0 起不再测试自建定时器：核心是 ScheduleBridge 对官方 ctx.schedule 的
 * 包装（创建会话/任务、列表、更新、立即执行、删除、截止时间元数据）。
 *
 * 运行：node test/smoke-test.mjs
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";

const LIB = new URL("../lib/index.js", import.meta.url);
const mod = await import(LIB.href);
const Bridge = mod.ScheduleBridge ?? mod.Scheduler ?? mod.default?.ScheduleBridge;
assert.equal(typeof Bridge, "function", "lib/index.js 应导出 ScheduleBridge");

const stateDir = mkdtempSync(join(tmpdir(), "dss-bridge-"));

/** 官方 Schedule 的最小 mock；记录调用，行为与真实服务一致到本测试所需程度。 */
function createSchedule() {
  const entries = [];
  let seq = 0;
  const nextIso = (offset = 3600_000) => new Date(Date.now() + offset).toISOString();
  return {
    entries,
    calls: [],
    async catalog() {
      return entries.map(e => ({ ...e }));
    },
    async create(sessionId, request) {
      this.calls.push({ op: "create", sessionId, request });
      seq += 1;
      const record = {
        id: `schedule-${seq}`,
        kind: request.at !== undefined ? "at" : request.every_seconds !== undefined ? "every"
          : request.daily !== undefined ? "daily" : request.weekly !== undefined ? "weekly"
            : request.cron !== undefined ? "cron" : "after",
        title: request.title,
        prompt: request.prompt,
        scheduledAt: request.at ?? nextIso(),
        ...(request.every_seconds === undefined ? {} : { everySeconds: request.every_seconds }),
        ...(request.cron === undefined ? {} : { expression: request.cron.expression, timeZone: request.cron.time_zone }),
      };
      entries.push({ ...record, sessionId, status: "active" });
      return record;
    },
    async update(request) {
      this.calls.push({ op: "update", request });
      const entry = entries.find(e => e.id === request.id);
      if (entry === undefined) return { id: request.id, updated: false, code: "schedule_not_found" };
      if (request.title !== undefined) entry.title = request.title;
      if (request.prompt !== undefined) entry.prompt = request.prompt;
      if (request.change?.kind === "every") entry.everySeconds = request.change.every_seconds;
      return { id: entry.id, updated: true, record: { ...entry } };
    },
    async delete(request) {
      this.calls.push({ op: "delete", request });
      const i = entries.findIndex(e => e.id === request.id);
      if (i === -1) return { id: request.id, deleted: false, code: "schedule_not_found" };
      entries.splice(i, 1);
      return { id: request.id, deleted: true };
    },
    async deleteInactive() {
      this.calls.push({ op: "deleteInactive" });
      const before = entries.length;
      for (let i = entries.length - 1; i >= 0; i -= 1) if (entries[i].status !== "active") entries.splice(i, 1);
      return { deleted: before - entries.length };
    },
    async history(request) {
      this.calls.push({ op: "history", request });
      return {
        records: [{
          scheduledAt: new Date().toISOString(),
          deliveredAt: new Date().toISOString(),
          messageId: "msg-1",
        }],
        earlierRecordsUnavailable: false,
      };
    },
  };
}

const schedule = createSchedule();
const createdSessions = [];
const renamed = [];
const prompts = [];
const modelCalls = [];
const ctx = {
  schedule,
  sessionController: {
    async create(request) {
      const sessionId = `sess-${createdSessions.length + 1}`;
      createdSessions.push({ sessionId, request });
      return { sessionId };
    },
    async rename(request) { renamed.push(request); return { title: request.title }; },
    async selectModel(request) { modelCalls.push(request); return { selected: { provider: request.provider, model: request.model } }; },
    async prompt(request) { prompts.push(request); return { accepted: true }; },
  },
  sessions: {
    get(id) { return id === "sess-existing" ? { id, header: { title: "已有会话" } } : undefined; },
  },
  on(topic, cb) {
    if (topic === "session/event") sessionEventHandlers.push(cb);
    return () => {};
  },
};
const sessionEventHandlers = [];

/**
 * 工作区注册表 mock（0.10.7 起 bridge 用它把任务会话退出/挂回成员席位）。
 * `list()` 只报 ws-1；`get()` 返回带 attachSession/detachSession 的工作区实体。
 */
const workspaceCalls = [];
const attached = new Set();
const workspaceRegistry = {
  archivedSessionIds: [],
  list() {
    return [{ id: "ws-1", path: "/tmp/ws-1", sessionIds: [...attached] }];
  },
  get(id) {
    if (id !== "ws-1") return undefined;
    return {
      async attachSession(sessionId) { attached.add(sessionId); workspaceCalls.push({ op: "attach", sessionId }); },
      async detachSession(sessionId) { attached.delete(sessionId); workspaceCalls.push({ op: "detach", sessionId }); },
    };
  },
};
ctx.workspaceRegistry = workspaceRegistry;

const bridge = new Bridge(ctx, stateDir, "test");
bridge.start();

// 1) 工作区新建任务 → 自动建会话 + 命名 + 写官方任务
const task = await bridge.create({
  title: "每日审查",
  prompt: "检查今天的构建结果",
  workspaceId: "ws-1",
  frequency: { kind: "every", seconds: 3600 },
  endsAt: Date.now() + 7 * 86400_000,
});
assert.equal(createdSessions.length, 1);
assert.equal(createdSessions[0].request.workspaceId, "ws-1");
assert.equal(renamed[0].title, "每日审查");
assert.equal(task.title, "每日审查");
assert.equal(task.status, "active");
assert.equal(task.frequency.kind, "every");
assert.equal(task.frequency.seconds, 3600);
assert.ok(task.endsAt > Date.now(), "应保存截止时间");
// 0.10.7：新建的任务会话必须立刻退出工作区成员席位，否则会被 web「新会话」当成可复用空白会话抢走
assert.deepEqual(
  workspaceCalls.filter(c => c.op === "detach").map(c => c.sessionId).slice(0, 1),
  [createdSessions[0].sessionId],
  "任务会话建好即退席（detachSession）",
);
assert.equal(attached.has(createdSessions[0].sessionId), false, "退席后不应仍算工作区成员");

// 2) 列表
let list = await bridge.list();
assert.equal(list.length, 1);
assert.equal(list[0].id, task.id);

// 3) 沿用现有会话
const existing = await bridge.create({
  title: "用现有会话",
  prompt: "hello",
  sessionId: "sess-existing",
  frequency: { kind: "once", at: new Date(Date.now() + 600_000).toISOString() },
});
assert.equal(existing.sessionId, "sess-existing");
assert.equal(existing.sessionTitle, "已有会话");

// 4) 更新名称/提示词/频率
const updated = await bridge.update({
  id: task.id,
  title: "每日审查 v2",
  prompt: "新的提示词",
  frequency: { kind: "every", seconds: 7200 },
});
assert.equal(updated.title, "每日审查 v2");
assert.equal(updated.prompt, "新的提示词");
assert.equal(updated.frequency.seconds, 7200);

// 5) 立即执行走官方队列
await bridge.runNow(task.id);
assert.equal(prompts.length, 1);
assert.equal(prompts[0].mode, "queue");
assert.equal(prompts[0].sessionId, task.sessionId);
assert.equal(prompts[0].content[0].text, "新的提示词");

// 5b) 执行观察回归：真实事件形状（user/message 的 content/source 直接在 data 下，
//     2026-10-26 生产会话日志实证；曾因按 data.message 解析而全链路静默）
const executionUpdates = [];
bridge.onExecution = (u) => executionUpdates.push(u);
const fire = (event) => { for (const h of sessionEventHandlers) h({ id: task.sessionId }, event); };
fire({ type: "turn/start", data: { turn: 1 } });
fire({
  type: "user/message",
  data: {
    content: [{ type: "text", text: `[SCHEDULE REMINDER]\nThis is a scheduled message from the user\nschedule_id_json: "${task.id}"\noccurrence_at: 2026-10-26T06:19:26.625Z\nreminder_prompt_json: "x"` }],
    source: { kind: "schedule" },
    role: "user",
    id: "msg-1",
  },
});
fire({ type: "assistant/message", data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "定时链路验证成功" }] } } });
fire({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
assert.equal(executionUpdates.length, 1, "真实形状事件应产生一条执行更新");
assert.equal(executionUpdates[0].status, "success");
assert.equal(executionUpdates[0].summary, "定时链路验证成功");
assert.ok(executionUpdates[0].taskIds.includes(task.id));
list = await bridge.list();
assert.equal(list.find(t => t.id === task.id)?.lastExecution?.status, "success", "lastExecution 应写回 meta");

// 5b2) 0.10.7：任务会话出现真实轮次（turn/start）后要挂回工作区——那一刻已不空白，不会被复用
await new Promise(r => setTimeout(r, 50));
assert.equal(attached.has(task.sessionId), true, "有真实轮次的任务会话应挂回工作区");
assert.ok(
  workspaceCalls.some(c => c.op === "attach" && c.sessionId === task.sessionId),
  "投递后的任务会话应走 attachSession",
);

// 5c) preset + 模型：新会话带 agentPreset 创建；selectModel 应用到绑定会话
const withModel = await bridge.create({
  title: "带模型任务",
  prompt: "x",
  workspaceId: "ws-1",
  agentPreset: "engineering",
  model: { provider: "deepseek-account", model: "deepseek-reasoner", providerName: "DeepSeek", modelName: "Reasoner" },
  frequency: { kind: "every", seconds: 3600 },
});
assert.equal(createdSessions[1].request.agentPreset, "engineering", "create 应透传 agentPreset");
assert.equal(modelCalls.length, 1);
assert.equal(modelCalls[0].sessionId, createdSessions[1].sessionId);
assert.equal(modelCalls[0].provider, "deepseek-account");
assert.equal(withModel.agentPreset, "engineering");
assert.equal(withModel.model?.model, "deepseek-reasoner");
// 编辑换模型 → 再次 selectModel；model:null → 只清记录，不回调宿主
await bridge.update({ id: withModel.id, model: { provider: "p2", model: "m2" } });
assert.equal(modelCalls.length, 2);
assert.equal(modelCalls[1].provider, "p2");
const cleared = await bridge.update({ id: withModel.id, model: null });
assert.equal(modelCalls.length, 2, "null 不应触发 selectModel");
assert.equal(cleared.model, undefined);
await bridge.delete(withModel.id);

// 6) 删除
await bridge.delete(task.id);
list = await bridge.list();
assert.equal(list.some(t => t.id === task.id), false);

// 7) 错误输入
await assert.rejects(() => bridge.create({ title: "", prompt: "x", workspaceId: "ws-1", frequency: { kind: "every", seconds: 60 } }), /名称/);
await assert.rejects(() => bridge.create({ title: "x", prompt: "", workspaceId: "ws-1", frequency: { kind: "every", seconds: 60 } }), /提示词/);
await assert.rejects(() => bridge.create({ title: "x", prompt: "y", frequency: { kind: "every", seconds: 60 } }), /工作区/);

// 8) 截止时间过期 → 删除官方任务
const expiring = await bridge.create({
  title: "即将到期",
  prompt: "x",
  workspaceId: "ws-1",
  frequency: { kind: "daily", time: "09:00:00", timeZone: "Asia/Shanghai" },
});
await bridge.update({ id: expiring.id, endsAt: Date.now() + 50 });
await new Promise(r => setTimeout(r, 120));
list = await bridge.list();
assert.equal(list.some(t => t.id === expiring.id), false, "到期任务应被删除");

// 9) 0.10.7 启动迁移：旧版本留下的「空白任务会话」重启后也要退出工作区；
//    已投递过的会话不动（它有真实轮次，不会被「新会话」复用）
const legacy = await bridge.create({
  title: "历史空白任务",
  prompt: "x",
  workspaceId: "ws-1",
  frequency: { kind: "cron", expression: "0 18 30 * *", timeZone: "Asia/Shanghai" },
});
const legacyDelivered = await bridge.create({
  title: "历史已投递任务",
  prompt: "y",
  workspaceId: "ws-1",
  frequency: { kind: "cron", expression: "0 18 30 * *", timeZone: "Asia/Shanghai" },
});
// 模拟宿主 bootstrap 把两者按 cwd 重新挂回工作区（重启后必然发生）
attached.add(legacy.sessionId);
attached.add(legacyDelivered.sessionId);
const deliveredEntry = schedule.entries.find(e => e.sessionId === legacyDelivered.sessionId);
deliveredEntry.lastDelivery = { scheduledAt: new Date().toISOString(), deliveredAt: new Date().toISOString(), messageId: "msg-legacy" };
bridge.stop();

const callsBeforeRestart = workspaceCalls.length;
const restarted = new Bridge(ctx, stateDir, "test");
restarted.start();
await restarted.list();
const detachAfterRestart = workspaceCalls.slice(callsBeforeRestart)
  .filter(c => c.op === "detach").map(c => c.sessionId);
assert.deepEqual(detachAfterRestart, [legacy.sessionId],
  "启动迁移只摘「插件建过且从未投递」的空白任务会话");
assert.equal(attached.has(legacy.sessionId), false, "启动迁移后旧空白任务会话不再是工作区成员");
assert.equal(attached.has(legacyDelivered.sessionId), true, "已投递任务会话保持成员身份");
restarted.stop();

bridge.stop();
console.log("✔ dsh-scheduled-send bridge smoke 全部通过");
