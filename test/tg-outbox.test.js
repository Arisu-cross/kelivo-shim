import test from "node:test";
import assert from "node:assert/strict";
import { Outbox, sendWithRetry, shouldRetry, retryAfterMs, backoffFor } from "../tg-outbox.js";

const noSleep = () => Promise.resolve();

test("shouldRetry:网络异常和 429/5xx 重试,4xx 不重试", () => {
  assert.equal(shouldRetry({ thrown: true, message: "fetch failed" }), true);   // 8-19 事故那一类
  assert.equal(shouldRetry({ ok: false, error_code: 429 }), true);
  assert.equal(shouldRetry({ ok: false, error_code: 502 }), true);
  assert.equal(shouldRetry({ ok: false, error_code: 400 }), false);             // 内容不合法,重发也一样
  assert.equal(shouldRetry({ ok: false, error_code: 403 }), false);
  assert.equal(shouldRetry({ ok: true }), false);
  assert.equal(shouldRetry(undefined), true);
});

test("retryAfterMs / backoffFor", () => {
  assert.equal(retryAfterMs({ parameters: { retry_after: 7 } }), 7000);
  assert.equal(retryAfterMs({ ok: false }), 0);
  assert.equal(backoffFor(0), 1000);
  assert.equal(backoffFor(99), 8000);   // 表用完就一直用最后一档
});

test("sendWithRetry:抖一下之后成功", async () => {
  let n = 0;
  const res = await sendWithRetry(async () => {
    n++;
    if (n < 3) throw new Error("fetch failed");
    return { ok: true };
  }, { sleep: noSleep });
  assert.equal(res.ok, true);
  assert.equal(n, 3);
});

test("sendWithRetry:4xx 不浪费重试", async () => {
  let n = 0;
  const res = await sendWithRetry(async () => { n++; return { ok: false, error_code: 400 }; }, { sleep: noSleep });
  assert.equal(res.ok, false);
  assert.equal(n, 1);
});

test("sendWithRetry:一直失败就返回最后一次结果", async () => {
  let n = 0;
  const res = await sendWithRetry(async () => { n++; throw new Error("fetch failed"); },
    { sleep: noSleep, attempts: 4 });
  assert.equal(n, 4);
  assert.equal(res.thrown, true);
});

test("Outbox:网络恢复后按原顺序补投", async () => {
  let up = false;
  const sent = [];
  const ob = new Outbox({
    send: async (it) => { if (!up) throw new Error("fetch failed"); sent.push(it.text); return { ok: true }; },
    sleep: noSleep,
  });
  ob.push({ text: "第一句" });
  ob.push({ text: "第二句" });
  let r = await ob.drain();
  assert.equal(r.sent, 0);
  assert.equal(ob.size(), 2, "发不出去要留着,不能丢");

  up = true;
  r = await ob.drain();
  assert.equal(r.sent, 2);
  assert.deepEqual(sent, ["第一句", "第二句"], "补投必须保持原顺序");
  assert.equal(ob.size(), 0);
});

test("Outbox:前一条没送出去就停,不让她先看到后半句", async () => {
  const sent = [];
  const ob = new Outbox({
    send: async (it) => {
      if (it.text === "第一句") throw new Error("fetch failed");
      sent.push(it.text); return { ok: true };
    },
    sleep: noSleep,
  });
  ob.push({ text: "第一句" });
  ob.push({ text: "第二句" });
  await ob.drain();
  assert.deepEqual(sent, [], "第一句卡住时第二句不许抢跑");
  assert.equal(ob.size(), 2);
});

test("Outbox:攒太久的丢弃,被 TG 拒收的也丢弃", async () => {
  let t = 0;
  const ob = new Outbox({
    send: async () => ({ ok: false, error_code: 400 }),
    sleep: noSleep, now: () => t, maxAgeMs: 100,
  });
  ob.push({ text: "旧的" });
  t = 500;                       // 超过 maxAge
  let r = await ob.drain();
  assert.equal(r.dropped, 1);
  assert.equal(ob.size(), 0);

  ob.push({ text: "内容不合法" });
  r = await ob.drain();          // 400 → 重发也没用
  assert.equal(r.dropped, 1);
  assert.equal(ob.size(), 0);
});

test("Outbox:队列满了丢最旧的,保住离现在最近的话", async () => {
  const ob = new Outbox({ send: async () => ({ ok: true }), sleep: noSleep, maxItems: 3 });
  for (const x of ["1", "2", "3", "4"]) ob.push({ text: x });
  assert.equal(ob.size(), 3);
  const sent = [];
  ob.send = async (it) => { sent.push(it.text); return { ok: true }; };
  await ob.drain();
  assert.deepEqual(sent, ["2", "3", "4"]);
});
