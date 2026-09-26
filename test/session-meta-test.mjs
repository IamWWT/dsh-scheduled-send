/**
 * sessionMetaOf — 会话元数据（标题/cwd）派生单元测试。
 *
 * 覆盖：displayTitle 优先于 title、cwd 透传、缺字段降级、空/undefined 投影。
 * 运行：node test/session-meta-test.mjs（pnpm test 会一并执行）
 */
import assert from "node:assert";

const LIB = new URL("../lib/index.js", import.meta.url);
const mod = await import(LIB.href);
const { sessionMetaOf } = mod;
assert.equal(typeof sessionMetaOf, "function", "lib/index.js 应导出 sessionMetaOf");

let passed = 0;
const ok = (name) => { passed += 1; console.log(`  PASS  ${name}`); };

// ---- 1) displayTitle 优先，cwd 透传 ---------------------------------------
{
  const meta = sessionMetaOf({
    byId: {
      "sess-a": { displayTitle: "我的会话 A", title: "fallback", cwd: "/srv/proj/a" },
    },
  });
  assert.equal(meta["sess-a"].title, "我的会话 A");
  assert.equal(meta["sess-a"].cwd, "/srv/proj/a");
  ok("displayTitle 优先 + cwd 透传");
}

// ---- 2) 只有 title（无 displayTitle）→ 回退 title --------------------------
{
  const meta = sessionMetaOf({
    byId: { "sess-b": { title: "仅标题", cwd: "/tmp/b" } },
  });
  assert.equal(meta["sess-b"].title, "仅标题");
  ok("无 displayTitle 时回退 title");
}

// ---- 3) 缺字段 → undefined，不抛错 ----------------------------------------
{
  const meta = sessionMetaOf({ byId: { "sess-c": {} } });
  assert.equal(meta["sess-c"].title, undefined);
  assert.equal(meta["sess-c"].cwd, undefined);
  ok("缺字段 → undefined（不抛错）");
}

// ---- 4) 空 / undefined 投影 → 空表 ----------------------------------------
{
  assert.deepEqual(sessionMetaOf(undefined), {});
  assert.deepEqual(sessionMetaOf({}), {});
  assert.deepEqual(sessionMetaOf({ byId: undefined }), {});
  ok("undefined / 空投影 → 空表");
}

console.log(`\n✔ session-meta 单元测试全部通过（${passed} 项）`);