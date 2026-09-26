import test from "node:test";
import assert from "node:assert/strict";
import { normalizeClient, pushOrder, pushToImessage } from "../push-route.js";

test("门的名字只认三个,别的当没有", () => {
  assert.equal(normalizeClient("imessage"), "imessage");
  assert.equal(normalizeClient(" iMessage "), "imessage");
  assert.equal(normalizeClient("telegram"), "telegram");
  assert.equal(normalizeClient("kelivo"), "kelivo");
  for (const v of ["", null, undefined, "wechat", "imessage2"]) assert.equal(normalizeClient(v), null, String(v));
});

test("没配 IMESSAGE_PUSH_URL = 和原来一模一样(TG,没有就 Bark)", () => {
  assert.deepEqual(pushOrder({ lastClient: "imessage", imessageUrl: "", hasTg: true, hasBark: true }), ["telegram"]);
  assert.deepEqual(pushOrder({ lastClient: "imessage", imessageUrl: "", hasTg: false, hasBark: true }), ["bark"]);
  assert.deepEqual(pushOrder({ lastClient: null, imessageUrl: "", hasTg: false, hasBark: false }), []);
});

test("她最后在 iMessage → 先 iMessage,再退 TG", () => {
  assert.deepEqual(pushOrder({ lastClient: "imessage", imessageUrl: "http://b/push", hasTg: true, hasBark: true }), ["imessage", "telegram"]);
  assert.deepEqual(pushOrder({ lastClient: "imessage", imessageUrl: "http://b/push", hasTg: false, hasBark: true }), ["imessage", "bark"]);
});

test("她最后在 Telegram / Kelivo → 照旧只走 TG,不碰 iMessage", () => {
  for (const c of ["telegram", "kelivo", null]) {
    assert.deepEqual(pushOrder({ lastClient: c, imessageUrl: "http://b/push", hasTg: true, hasBark: true }), ["telegram"], String(c));
  }
});

test("bark=false 的那类(归档后那句)没有 TG 就不发,保持原行为", () => {
  assert.deepEqual(pushOrder({ lastClient: null, imessageUrl: "", hasTg: false, hasBark: true, bark: false }), []);
  assert.deepEqual(pushOrder({ lastClient: "imessage", imessageUrl: "http://b/push", hasTg: false, hasBark: true, bark: false }), ["imessage"]);
});

test("往 bridge 推:带钥匙、2xx 才算送到,别的一律退回", async () => {
  const seen = [];
  const fake = (status) => async (url, opts) => { seen.push({ url, opts }); return { status }; };
  let r = await pushToImessage({ url: "http://b/push", key: "k", text: "在干嘛", fetchImpl: fake(200) });
  assert.equal(r.ok, true);
  assert.equal(seen[0].opts.headers["x-api-key"], "k");
  assert.deepEqual(JSON.parse(seen[0].opts.body), { text: "在干嘛" });
  for (const s of [401, 502, 503, 500]) {
    r = await pushToImessage({ url: "http://b/push", key: "k", text: "x", fetchImpl: fake(s) });
    assert.equal(r.ok, false, String(s));
  }
  r = await pushToImessage({ url: "http://b/push", key: "k", text: "x", fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  assert.deepEqual(r, { ok: false, error: "ECONNREFUSED" });
});
