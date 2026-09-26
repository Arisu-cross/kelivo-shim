import { test } from "node:test";
import assert from "node:assert/strict";
import { pushRecent, renderRawTail, postRawTail } from "../raw-tail.js";

test("只留最近的原话,超出上限从最早的开始丢,顺序不乱", () => {
  let e = [];
  for (let i = 0; i < 50; i++) e = pushRecent(e, i % 2 ? "assistant" : "user", `第${i}句`, 60);
  const nums = e.map((x) => +x.text.replace(/\D/g, ""));
  assert.equal(nums.at(-1), 49, "最近那句一定在");
  assert.deepEqual(nums, [...nums].sort((a, b) => a - b));
  assert.ok(e.reduce((n, x) => n + x.text.length, 0) <= 60);
});

test("空话不记;‖ 换成换行", () => {
  let e = pushRecent([], "user", "   ");
  assert.equal(e.length, 0);
  e = pushRecent(e, "assistant", "嗯‖在呢");
  assert.equal(e[0].text, "嗯\n在呢");
});

test("渲染:只有两个人说的话,按时间顺序,用称呼区分", () => {
  const out = renderRawTail([{ role: "user", text: "还醒着吗" }, { role: "assistant", text: "在" }], { userName: "栖栖" });
  assert.equal(out, "栖栖:还醒着吗\n你:在");
  assert.equal(renderRawTail([]), "");
});

test("写 OB:带钥匙头、JSON 正文;成功回 true", async () => {
  let seen;
  const ok = await postRawTail({
    url: "http://ob/api/raw-tail", key: "k", text: "她:晚安",
    fetchImpl: async (u, o) => { seen = { u, o }; return { ok: true }; },
  });
  assert.equal(ok, true);
  assert.equal(seen.o.headers["x-raw-key"], "k");
  assert.deepEqual(JSON.parse(seen.o.body), { text: "她:晚安" });
});

test("【绝不卡压缩】OB 报错/抛异常/超时一律只回 false", async () => {
  assert.equal(await postRawTail({ url: "u", key: "k", text: "t", fetchImpl: async () => ({ ok: false }) }), false);
  assert.equal(await postRawTail({ url: "u", key: "k", text: "t", fetchImpl: async () => { throw new Error("down"); } }), false);
  const hang = (u, o) => new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(new Error("aborted"))));
  assert.equal(await postRawTail({ url: "u", key: "k", text: "t", timeoutMs: 50, fetchImpl: hang }), false);
});

test("没配 url/key 或没内容 → 不发", async () => {
  let called = false;
  const f = async () => { called = true; return { ok: true }; };
  assert.equal(await postRawTail({ url: "", key: "k", text: "t", fetchImpl: f }), false);
  assert.equal(await postRawTail({ url: "u", key: "", text: "t", fetchImpl: f }), false);
  assert.equal(await postRawTail({ url: "u", key: "k", text: "", fetchImpl: f }), false);
  assert.equal(called, false);
});
