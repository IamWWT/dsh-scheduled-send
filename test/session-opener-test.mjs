/**
 * sessionOpenerOf — 跳转 helper 单元测试。
 *
 * 背景（v0.6.0 真实故障）：DSH 的 `ISessions.open(id)` 方法体依赖 `this.manager`
 *（service.ts: `open(id){ this.manager.select(id) }`）。旧实现 `const f = svc.open; f(id)`
 * 把方法拆出再调，`this` 变 undefined → 报
 * `Cannot read properties of undefined (reading 'manager')`。
 *
 * 本测试：
 *  1) 用「方法体依赖 this」的伪服务复现旧 bug（证明其存在）；
 *  2) 验证 `sessionOpenerOf` 产出的箭头函数保引用调用、不丢 this；
 *  3) 覆盖服务缺失/无 open 的降级分支。
 *
 * 运行：node test/session-opener-test.mjs（pnpm test 会一并执行）
 */
import assert from "node:assert";

const LIB = new URL("../lib/index.js", import.meta.url);
const mod = await import(LIB.href);
const { sessionOpenerOf } = mod;
assert.equal(typeof sessionOpenerOf, "function", "lib/index.js 应导出 sessionOpenerOf");

/** 模拟 DSH sessions 服务：方法体依赖 this.manager（与真实现同构）。 */
function makeFakeService() {
  const opened = [];
  const service = {
    manager: {
      select: (id) => { opened.push(id); },
    },
    open: function open(id) {
      // 与 DSH service.open 同构：访问 this.manager（解构调用时会炸）
      this.manager.select(id);
    },
  };
  return { service, opened };
}

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  PASS  ${name}`); };

// ---- 1) 复现旧 bug：解构方法再调用 → this undefined → reading 'manager' ----
{
  const { service } = makeFakeService();
  const f = service.open; // 旧实现的错误姿势
  let threw = null;
  try { f("sess-x"); } catch (e) { threw = String(e?.message ?? e); }
  assert.ok(
    threw && /reading 'manager'/.test(threw),
    `旧姿势应抛 'manager' 相关错误，实际: ${threw}`,
  );
  ok("复现旧 bug：解构方法调用 → reading 'manager'（证明 bug 真实存在）");
}

// ---- 2) 修复验证：sessionOpenerOf 保引用调用，this 指向 svc ---------------
{
  const { service, opened } = makeFakeService();
  const jump = sessionOpenerOf(service);
  assert.equal(typeof jump, "function", "应有跳转函数");
  jump("sess-1");
  jump("sess-2");
  assert.deepEqual(opened, ["sess-1", "sess-2"], "manager.select 应被按序调用（this 绑定正确）");
  ok("sessionOpenerOf 跳转成功（this 绑定正确）");
}

// ---- 3) 降级覆盖 ------------------------------------------------------------
{
  assert.equal(sessionOpenerOf(undefined), undefined, "服务缺失 → undefined");
  assert.equal(sessionOpenerOf({}), undefined, "服务无 open → undefined");
  assert.equal(sessionOpenerOf({ open: "not-a-fn" }), undefined, "open 非函数 → undefined");
  ok("降级分支：无服务 / 无 open / open 非函数 → undefined");
}

console.log(`\n✔ session-opener 单元测试全部通过（${passed} 项）`);