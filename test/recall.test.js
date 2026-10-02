import test from "node:test";
import assert from "node:assert/strict";
import { recallMode, skipReason, coolingIds, buildUrl, formatHint, fetchRecall, observation, pushRing } from "../recall.mjs";

test("档位只认 off / observe / on,别的都当 off", () => {
  assert.equal(recallMode("on"), "on");
  assert.equal(recallMode(" Observe "), "observe");
  for (const v of ["", undefined, "true", "1"]) assert.equal(recallMode(v), "off");
});

test("什么时候不问 OB", () => {
  const base = { mode: "on", configured: true, text: "鼻炎又犯了", reset: null, systemTurn: false, windowCount: 0, windowMax: 30 };
  assert.equal(skipReason(base), "");
  assert.equal(skipReason({ ...base, mode: "off" }), "off");
  assert.equal(skipReason({ ...base, configured: false }), "not_configured");
  assert.equal(skipReason({ ...base, reset: "archive" }), "reset");
  assert.equal(skipReason({ ...base, text: "嗯" }), "too_short");
  assert.equal(skipReason({ ...base, windowCount: 30 }), "window_full");
  assert.equal(skipReason({ ...base, windowCount: 99, windowMax: 0 }), "", "0 = 不封顶");
});

test("冷却:没过期的留下,过期的顺手清掉", () => {
  const m = new Map([["a", 0], ["b", 10 * 3600e3]]);
  assert.deepEqual(coolingIds(m, 13 * 3600e3, 12), ["b"]);
  assert.equal(m.has("a"), false);
});

test("拼地址 + 递进去的那一行", () => {
  const u = new URL(buildUrl("https://ob/api/recall", { q: "鼻炎", n: 240, minAgeH: 24, exclude: ["x", "y"] }));
  assert.equal(u.searchParams.get("q"), "鼻炎");
  assert.equal(u.searchParams.get("exclude"), "x,y");
  assert.equal(formatHint(null), "");
  const line = formatHint({ id: "abc", name: "她的鼻炎", created: "2026-08-14", excerpt: "换季犯了。" });
  assert.match(line, /^【系统·浮现】/);
  assert.match(line, /2026-08-14 「她的鼻炎」换季犯了。\(全文:dream\(detail_ids="abc"\)\)$/);
});

test("调 OB:失败一律回 { error },不抛", async () => {
  let r = await fetchRecall({ url: "http://x", token: "t", timeoutMs: 100, fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.equal(r.error, "http_500");
  r = await fetchRecall({ url: "http://x", token: "t", timeoutMs: 100, fetchImpl: async () => { throw new Error("boom"); } });
  assert.equal(r.error, "fetch_failed");
  let seen;
  r = await fetchRecall({ url: "http://x", token: "t", timeoutMs: 100, fetchImpl: async (u, o) => { seen = o; return { ok: true, json: async () => ({ pick: null, reason: "empty" }) }; } });
  assert.equal(seen.headers.Authorization, "Bearer t");
  assert.equal(r.reason, "empty");
});

test("观察记录只留开头 24 字,不带记忆正文;环形最多 50 条", () => {
  const o = observation({ mode: "on", text: "一".repeat(40), res: { pick: { id: "a", name: "n", rare: ["鼻炎"], excerpt: "正文" }, ms: 5 }, injected: true });
  assert.equal(o.preview.length, 24);
  assert.equal(JSON.stringify(o).includes("正文"), false);
  const ring = [];
  for (let i = 0; i < 60; i++) pushRing(ring, i);
  assert.equal(ring.length, 50);
  assert.equal(ring[0], 10);
});
