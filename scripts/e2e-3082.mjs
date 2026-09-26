/**
 * dsh-scheduled-send — 3082 端到端 API 测试。
 *
 * 前置：用户已重启 dsh-dev-web 并确认加载本版本插件。
 * 用法：node scripts/e2e-3082.mjs [baseUrl]
 * 默认 baseUrl：http://127.0.0.1:3082
 *
 * 测试只创建一条临时 pending 任务，然后 cancel + delete 清理；不会调用 fire，
 * 不会向真实会话发送消息。用于验证：live host 路由、持久任务列表、创建、撤回、删除。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const base = (process.argv[2] ?? "http://127.0.0.1:3082").replace(/\/$/, "");
const apiBase = `${base}/api/scheduled-send`;
const packageUrl = new URL("../package.json", import.meta.url);
const expectedVersion = JSON.parse(readFileSync(fileURLToPath(packageUrl), "utf8")).version;
const timeoutMs = 5000;

async function request(path, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${apiBase}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let probeId;
try {
  console.log(`[e2e] target=${base}`);

  const health = await request("/health");
  assert(health.status === 200 && health.body?.ok === true, `health 失败：${JSON.stringify(health)}`);
  assert(health.body.version === expectedVersion,
    `版本不匹配：服务=${health.body.version}，源码 package=${expectedVersion}`);
  console.log(`  PASS health/version=${health.body.version}`);

  const before = await request("/jobs");
  assert(before.status === 200 && before.body?.ok === true && Array.isArray(before.body.jobs),
    `jobs 列表失败：${JSON.stringify(before)}`);
  console.log(`  PASS jobs 列表可读（当前 ${before.body.jobs.length} 条）`);

  const sessionId = `e2e-probe-${Date.now()}`;
  const create = await request("/jobs", {
    method: "POST",
    body: JSON.stringify({
      sessionId,
      text: "[e2e probe] scheduled-send test; this will be cancelled",
      fireAt: Date.now() + 60_000,
      note: "自动化测试临时任务",
    }),
  });
  assert(create.status === 200 && create.body?.ok === true && create.body.job?.status === "pending",
    `创建失败：${JSON.stringify(create)}`);
  probeId = create.body.job.id;
  console.log(`  PASS 创建 pending 任务（${probeId}）`);

  const listed = await request("/jobs");
  assert(listed.body.jobs.some((j) => j.id === probeId && j.status === "pending"),
    "新任务未出现在 GET /jobs 列表");
  console.log("  PASS 新任务出现在列表");

  const cancel = await request("/jobs/cancel", {
    method: "POST",
    body: JSON.stringify({ id: probeId }),
  });
  assert(cancel.status === 200 && cancel.body?.ok === true, `撤回失败：${JSON.stringify(cancel)}`);
  console.log("  PASS 撤回任务");

  const remove = await request("/jobs/delete", {
    method: "POST",
    body: JSON.stringify({ id: probeId }),
  });
  assert(remove.status === 200 && remove.body?.ok === true, `删除失败：${JSON.stringify(remove)}`);
  console.log("  PASS 删除测试任务");

  const after = await request("/jobs");
  assert(!after.body.jobs.some((j) => j.id === probeId), "测试任务清理后仍在列表");
  console.log("  PASS 清理后列表恢复");
  console.log("\n✔ 3082 API 端到端测试全部通过（未发送真实会话消息）");
} catch (error) {
  if (probeId) {
    try {
      await request("/jobs/cancel", { method: "POST", body: JSON.stringify({ id: probeId }) });
      await request("/jobs/delete", { method: "POST", body: JSON.stringify({ id: probeId }) });
    } catch { /* 尽力清理；原始错误优先 */ }
  }
  console.error(`✗ 端到端测试失败：${error?.message ?? error}`);
  console.error("提示：先确认 dsh 已重启并加载当前版本，再检查设置面板的 host 在线状态。");
  process.exit(1);
}
