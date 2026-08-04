// node --test 跑;纯函数,不碰网络。
import { test } from "node:test";
import assert from "node:assert/strict";
import { resultFailure, failureLabel, failureReply, outageNotice, recoveryNotice } from "../api-health.js";

// 2026-08-04 事故现场抓到的**真实** result 事件(删掉无关字段)。
// 注意 subtype 是 "success" —— 这正是当时骗过 shim 的那一手。
const REAL = {
  is_error: true, duration_api_ms: 0, num_turns: 1, stop_reason: "stop_sequence",
  usage: { input_tokens: 0, output_tokens: 0 },
  terminal_reason: "api_error", subtype: "success", api_error_status: 503,
  result: "API Error: 503 auth_unavailable: no auth available (providers=claude, model=claude-opus-5); check Claude auth/key session and cooldown state.",
  type: "result", duration_ms: 174095,
};

test("【核心回归】subtype 说 success,但这一轮必须被认成失败", () => {
  const f = resultFailure(REAL);
  assert.ok(f, "这就是骗了一整晚的那个事件,认不出来等于白修");
  assert.equal(f.status, 503);
  assert.equal(f.subtype, "success");
  assert.equal(f.reason, "api_error");
  assert.ok(f.why.includes("auth_unavailable"));
});

test("正常成功的一轮不能被误判成失败", () => {
  assert.equal(resultFailure({ type: "result", subtype: "success", is_error: false,
    usage: { output_tokens: 12 }, result: "好啊" }), null);
});

test("老式失败(subtype 不是 success)照样认得出", () => {
  const f = resultFailure({ subtype: "error_during_execution" });
  assert.ok(f);
  assert.equal(f.subtype, "error_during_execution");
});

test("只有 is_error / 只有 api_error_status / 只有 terminal_reason 都算失败", () => {
  assert.ok(resultFailure({ is_error: true }));
  assert.ok(resultFailure({ api_error_status: 429 }));
  assert.ok(resultFailure({ terminal_reason: "api_error" }));
});

test("垃圾输入不炸(失败识别自己绝不能成为新的故障源)", () => {
  for (const x of [null, undefined, 0, "", "success", []]) assert.doesNotThrow(() => resultFailure(x));
  assert.equal(resultFailure(null), null);
});

test("超长报错被截断,不把一整坨糊到她脸上", () => {
  const f = resultFailure({ is_error: true, result: "x".repeat(5000) });
  assert.ok(f.why.length <= 300);
});

// ---- 措辞 ----
test("故障标签从报错里抠出「503 auth_unavailable」", () => {
  assert.equal(failureLabel(resultFailure(REAL)), "503 auth_unavailable");
});

test("标签兜底:没有人话报错就退回状态码/原因", () => {
  assert.equal(failureLabel(resultFailure({ api_error_status: 429 })), "429");
  assert.equal(failureLabel(resultFailure({ terminal_reason: "api_error" })), "api_error");
});

test("【最要紧的一条】给她的回复必须说清「不是他不理你」", () => {
  const r = failureReply(resultFailure(REAL));
  assert.ok(r.includes("不是他不理你"), "这次事故最伤人的就是她以为被冷落:" + r);
  assert.ok(r.includes("shim"), "必须署名 shim,别让她以为是他在说话");
  assert.ok(r.includes("503 auth_unavailable"), "得带上能用来排查的那句");
});

test("运维通知署名系统、说明消息不会丢", () => {
  const n = outageNotice(resultFailure(REAL));
  assert.ok(n.includes("运维"));
  assert.ok(n.includes("不是他"));
  assert.ok(n.includes("不会丢"));
});

test("恢复通知报出故障时长与失败轮数", () => {
  const n = recoveryNotice(7, 42 * 60000);
  assert.ok(n.includes("7"));
  assert.ok(n.includes("42 分钟"));
});

test("故障不足一分钟也不显示 0 分钟", () => {
  assert.ok(recoveryNotice(1, 3000).includes("1 分钟"));
});
