/**
 * dsh-scheduled-send — Host 冒烟测试（纯 Node，无外部依赖）。
 *
 * 直接 require 已构建的 lib/index.js 中的 Scheduler 类进行断言。
 * 运行：node test/smoke-test.mjs
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert";

const LIB = new URL("../lib/index.js", import.meta.url);
const mod = await import(LIB.href);
const Scheduler = mod.Scheduler ?? mod.default?.Scheduler;
if (!Scheduler) {
  console.error("✗ lib/index.js 未导出 Scheduler 类");
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), "dss-test-"));
const stateDir = join(tmp, "st");

const scheduler = new Scheduler({ stateDir, version: "test" });

// ---- 场景 1：新建 + 列表 -------------------------------------------------
const job = scheduler.add({ sessionId: "sess-abc", text: "hello at 18:30", fireAt: Date.now() + 3600_000 });
assert.ok(job.id, "job 应有 id");
assert.equal(job.status, "pending");
assert.equal(scheduler.list().length, 1);
assert.equal(scheduler.get(job.id)?.text, "hello at 18:30");

// ---- 场景 2：fireAt 必须晚于现在 -----------------------------------------
assert.throws(() => scheduler.add({ sessionId: "s", text: "x", fireAt: Date.now() - 1000 }), /晚于/);

// ---- 场景 3：更新 --------------------------------------------------------
const upd = scheduler.update(job.id, { text: "updated", fireAt: Date.now() + 7200_000 });
assert.equal(upd.text, "updated");

// ---- 场景 4：fire 投递（mock sessionController）--------------------------
const calls = [];
const mockCtx = {
  get: (k) => (k === "sessionController" ? {
    prompt: async (r) => { calls.push(r); return { accepted: true }; },
  } : undefined),
};
scheduler.attach(mockCtx);
await scheduler.fire(job.id);
const after = scheduler.get(job.id);
assert.equal(after.status, "sent");
assert.ok(after.firedAt);
assert.equal(calls.length, 1);
assert.equal(calls[0].mode, "queue");
assert.equal(calls[0].sessionId, "sess-abc");
assert.equal(calls[0].content[0].text, "updated");

// ---- 场景 5：fire 失败 → missed -----------------------------------------
const j2 = scheduler.add({ sessionId: "s2", text: "will fail", fireAt: Date.now() + 1000 });
const failCtx = { get: (k) => (k === "sessionController" ? { prompt: async () => { throw new Error("boom"); } } : undefined) };
await scheduler.fire(j2.id, failCtx);
const m = scheduler.get(j2.id);
assert.equal(m.status, "missed");
assert.match(m.error ?? "", /boom/);

// ---- 场景 6：取消 + 删除 -------------------------------------------------
const j3 = scheduler.add({ sessionId: "s3", text: "cancel me", fireAt: Date.now() + 5000 });
assert.equal(scheduler.cancel(j3.id), true);
assert.equal(scheduler.get(j3.id)?.status, "cancelled");
const j4 = scheduler.add({ sessionId: "s4", text: "delete me", fireAt: Date.now() + 5000 });
assert.equal(scheduler.delete(j4.id), true);
assert.equal(scheduler.get(j4.id), undefined);

// ---- 场景 7：持久化往返（重新 load 后任务仍在）---------------------------
const s2 = new Scheduler({ stateDir, version: "test" });
const reloaded = s2.get(job.id);
assert.ok(reloaded, "重载后 job 仍在");
assert.equal(reloaded.status, "sent");

// ---- 场景 8：每会话最多 3 个待触发任务（MAX_PENDING_PER_SESSION）----------
const s3 = new Scheduler({ stateDir: join(tmp, "st3"), version: "test" });
for (let i = 1; i <= 3; i++) {
  s3.add({ sessionId: "sess-limit", text: `msg-${i}`, fireAt: Date.now() + 60_000 + i });
}
const limitErr = (() => {
  try {
    s3.add({ sessionId: "sess-limit", text: "msg-4", fireAt: Date.now() + 120_000 });
    return null;
  } catch (e) {
    return String(e.message ?? e);
  }
})();
assert.ok(limitErr && /最多.*3/.test(limitErr), `第 4 个应被拒绝，实际: ${limitErr}`);
// 不同会话互不影响
s3.add({ sessionId: "sess-other", text: "ok", fireAt: Date.now() + 60_000 });


// ---- 场景 9：最晚边界（明天 23:59:59）由 host 强校验 ----------------------
const max = Scheduler.maxFireAt();
assert.ok(max > Date.now(), "maxFireAt 应晚于当前");
assert.throws(
  () => scheduler.add({ sessionId: "sess-cap", text: "too-late", fireAt: max + 1000 }),
  /明天 23:59:59/,
  "超过明天结束应被拒绝",
);
// 恰好等于明天结束应可通过（不早于 now 时）
const atMax = Math.max(max, Date.now() + 1000);
if (atMax <= max) {
  scheduler.add({ sessionId: "sess-cap", text: "at-max", fireAt: atMax });
}

console.log("✔ dsh-scheduled-send smoke 全部通过");
