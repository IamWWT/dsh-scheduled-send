/**
 * dsh-scheduled-send — 端到端 API 测试（0.8.0 起的新 /tasks 契约）。
 *
 * 前置：dsh 已重启并加载当前版本本插件；有启动日志里的登录 token。
 * 用法：node scripts/e2e-3082.mjs [baseUrl] [--token <token>] [--session <id> | --workspace <id>]
 *   baseUrl 默认 http://127.0.0.1:3082；
 *   token/session/workspace 也可用环境变量 DSH_E2E_TOKEN / DSH_E2E_SESSION_ID / DSH_E2E_WORKSPACE_ID。
 *   未指定目标时，复用现存任务里第一个任务的投递目标（列表为空则报错退出）。
 *
 * 测试只创建一条「次日 03:07 单次」探针任务（近期内不会触发），list→update→delete 清理；
 * 不会调用 run，不会向真实会话发送消息。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--token") out.token = argv[++i];
    else if (a === "--session") out.session = argv[++i];
    else if (a === "--workspace") out.workspace = argv[++i];
    else if (!a.startsWith("--")) out.base = a;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const base = (args.base ?? "http://127.0.0.1:3082").replace(/\/$/, "");
const apiBase = `${base}/api/scheduled-send`;
const token = args.token ?? process.env.DSH_E2E_TOKEN;
const wantedSession = args.session ?? process.env.DSH_E2E_SESSION_ID;
const wantedWorkspace = args.workspace ?? process.env.DSH_E2E_WORKSPACE_ID;
const packageUrl = new URL("../package.json", import.meta.url);
const expectedVersion = JSON.parse(readFileSync(fileURLToPath(packageUrl), "utf8")).version;
const timeoutMs = 8000;

/** 登录后收集 dsh-auth-* 等 cookie，后续请求带上（原生鉴权口径见 docs/linux.md）。 */
let cookieHeader = "";
function captureCookies(response) {
  const raw = response.headers.getSetCookie?.() ?? [];
  for (const line of raw) {
    const pair = line.split(";")[0];
    if (pair.includes("=")) cookieHeader = cookieHeader === "" ? pair : `${cookieHeader}; ${pair}`;
  }
}

async function request(path, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${apiBase}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(cookieHeader === "" ? {} : { Cookie: cookieHeader }),
        ...(init.headers ?? {}),
      },
    });
    captureCookies(response);
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** 用启动 token 走一次页面登录，兑换浏览器凭据 cookie。 */
async function login() {
  if (token === undefined || token === "") {
    console.warn("[e2e] 未提供 --token：直接按无凭据尝试；若 401 请从启动日志补 token。");
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}/?token=${encodeURIComponent(token)}`, {
      redirect: "manual",
      signal: controller.signal,
    });
    captureCookies(response);
    const location = response.headers.get("location");
    if (location !== null && (response.headers.getSetCookie?.() ?? []).length === 0) {
      const follow = await fetch(new URL(location, base).href, { redirect: "manual", signal: controller.signal });
      captureCookies(follow);
    }
  } finally {
    clearTimeout(timer);
  }
  console.log(`[e2e] 登录凭据：${cookieHeader === "" ? "未获得 cookie" : "cookie 已收集"}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** 次日 03:07（本地时区）ISO 串：近期内不会触发。 */
function probeAt() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(3, 7, 0, 0);
  const pad = (n) => String(n).padStart(2, "0");
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

let probeId;
try {
  console.log(`[e2e] target=${base}`);
  await login();

  const health = await request("/health");
  assert(health.status === 200 && health.body?.ok === true,
    `health 失败（${health.status}）：${JSON.stringify(health)}`);
  assert(health.body.version === expectedVersion,
    `版本不匹配：服务=${health.body.version}，源码 package=${expectedVersion}`);
  console.log(`  PASS health/version=${health.body.version}（active=${health.body.active} total=${health.body.total}）`);

  const before = await request("/tasks");
  assert(before.status === 200 && before.body?.ok === true && Array.isArray(before.body.tasks),
    `tasks 列表失败（${before.status}）：${JSON.stringify(before)}`);
  console.log(`  PASS tasks 列表可读（当前 ${before.body.tasks.length} 条）`);

  // 探针目标：显式 --session/--workspace 优先；否则复用现存任务的投递目标（不新建会话）
  const first = before.body.tasks[0];
  assert(wantedSession !== undefined || wantedWorkspace !== undefined || first !== undefined,
    "无探针目标：请传 --session/--workspace，或先让实例存在至少一个任务");
  const target = wantedSession !== undefined ? { sessionId: wantedSession }
    : wantedWorkspace !== undefined ? { workspaceId: wantedWorkspace }
      : first.sessionId !== undefined ? { sessionId: first.sessionId }
        : { workspaceId: first.workspaceId };

  const create = await request("/tasks", {
    method: "POST",
    body: JSON.stringify({
      title: "[e2e probe] scheduled-send",
      prompt: "[e2e probe] 自动化测试占位提示词，任务会被删除、不会执行。",
      frequency: { kind: "once", at: probeAt() },
      notify: false,
      ...target,
    }),
  });
  assert(create.status === 200 && create.body?.ok === true && typeof create.body.task?.id === "string",
    `创建失败：${JSON.stringify(create)}`);
  probeId = create.body.task.id;
  console.log(`  PASS 创建探针任务（${probeId}）`);

  const listed = await request("/tasks");
  const probe = listed.body.tasks.find(t => t.id === probeId);
  assert(probe !== undefined && probe.status === "active", "探针任务未出现在 active 列表");
  console.log("  PASS 探针任务出现在列表（active）");

  const renamed = await request("/tasks/update", {
    method: "POST",
    body: JSON.stringify({ id: probeId, title: "[e2e probe] renamed" }),
  });
  assert(renamed.status === 200 && renamed.body?.ok === true, `更新失败：${JSON.stringify(renamed)}`);
  console.log("  PASS 更新（改名）任务");

  const removed = await request("/tasks/delete", {
    method: "POST",
    body: JSON.stringify({ id: probeId }),
  });
  assert(removed.status === 200 && removed.body?.ok === true, `删除失败：${JSON.stringify(removed)}`);
  probeId = undefined;

  const after = await request("/tasks");
  assert(!after.body.tasks.some(t => t.title === "[e2e probe] renamed"), "探针任务清理后仍在列表");
  console.log("  PASS 删除后列表恢复");
  console.log("\n✔ 端到端 API 测试全部通过（/tasks 契约；未向真实会话投递消息）");
} catch (error) {
  if (probeId !== undefined) {
    try {
      await request("/tasks/delete", { method: "POST", body: JSON.stringify({ id: probeId }) });
    } catch { /* 尽力清理；原始错误优先 */ }
  }
  console.error(`✗ 端到端测试失败：${error?.message ?? error}`);
  console.error("提示：①确认 dsh 已重启并加载当前版本；②确认 --token 为启动日志里的最新 token；③看设置面板的 host 在线状态。");
  process.exit(1);
}
