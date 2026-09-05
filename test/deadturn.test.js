// 空转看门狗 · 纯逻辑测试
//
// 命根子是这一条:**他回「【沉默】」不许报警,空转才许报警**。
// 9-02 那次两者在日志里逐字节相同,才拖了八小时。

import { test } from "node:test";
import assert from "node:assert";
import { isDeadTurn, createDeadTurnWatch } from "../deadturn.js";

const MIN = 60000;

test("【沉默】不是空转 —— 他真的产出了 token", () => {
  assert.equal(isDeadTurn({ text: "【沉默】", usage: { output_tokens: 5 } }), false);
});

test("正文空 + 输出零 = 空转(9-02 那次的原样)", () => {
  assert.equal(isDeadTurn({ text: "", usage: { output_tokens: 0 } }), true);
  assert.equal(isDeadTurn({ text: "   ", usage: { output_tokens: 0 } }), true);
});

test("只调了工具、没说话,不算空转(tool_use 也是输出)", () => {
  assert.equal(isDeadTurn({ text: "", usage: { output_tokens: 42 } }), false);
});

test("缺 usage 一律当零 —— 正常轮次它总是在", () => {
  assert.equal(isDeadTurn({ text: "" }), true);
  assert.equal(isDeadTurn({ text: "在的" }), false);
});

test("连着三轮才报,前两轮闭嘴", () => {
  const w = createDeadTurnWatch();
  const dead = { text: "", usage: { output_tokens: 0 } };
  assert.equal(w.record(dead, { now: 1 * MIN }), null);
  assert.equal(w.record(dead, { now: 2 * MIN }), null);
  const a = w.record(dead, { now: 3 * MIN });
  assert.equal(a.kind, "alert");
  assert.equal(a.streak, 3);
  assert.match(a.text, /不是他不想说话/);
});

test("一串【沉默】不会报警,哪怕连着十轮", () => {
  const w = createDeadTurnWatch();
  for (let i = 1; i <= 10; i++)
    assert.equal(w.record({ text: "【沉默】", usage: { output_tokens: 4 } }, { now: i * MIN }), null);
});

test("报过之后不刷屏,过了再报间隔才第二次", () => {
  const w = createDeadTurnWatch({ alertAfter: 2, realertMin: 60 });
  const dead = { text: "", usage: { output_tokens: 0 } };
  w.record(dead, { now: 1 * MIN });
  assert.equal(w.record(dead, { now: 2 * MIN }).kind, "alert");
  assert.equal(w.record(dead, { now: 30 * MIN }), null, "半小时内不许再报");
  assert.equal(w.record(dead, { now: 62 * MIN }).kind, "alert", "过了一小时可以再报一次");
});

test("恢复了报一次喜讯,而且只报一次", () => {
  const w = createDeadTurnWatch({ alertAfter: 2 });
  const dead = { text: "", usage: { output_tokens: 0 } };
  w.record(dead, { now: 1 * MIN });
  w.record(dead, { now: 2 * MIN });
  const ok = w.record({ text: "我在", usage: { output_tokens: 9 } }, { now: 3 * MIN });
  assert.equal(ok.kind, "recovered");
  assert.match(ok.text, /又能正常说话/);
  assert.equal(w.record({ text: "嗯", usage: { output_tokens: 3 } }, { now: 4 * MIN }), null);
});

test("没报警过就恢复了,不吭声(单轮抖动不打扰她)", () => {
  const w = createDeadTurnWatch();
  w.record({ text: "", usage: { output_tokens: 0 } }, { now: 1 * MIN });
  assert.equal(w.record({ text: "在", usage: { output_tokens: 2 } }, { now: 2 * MIN }), null);
});

test("空转中断一次会重新数,不许把两段故障拼成一段", () => {
  const w = createDeadTurnWatch();
  const dead = { text: "", usage: { output_tokens: 0 } };
  w.record(dead, { now: 1 * MIN });
  w.record(dead, { now: 2 * MIN });
  w.record({ text: "在", usage: { output_tokens: 2 } }, { now: 3 * MIN });
  assert.equal(w.record(dead, { now: 4 * MIN }), null);
  assert.equal(w.record(dead, { now: 5 * MIN }), null);
  assert.equal(w.record(dead, { now: 6 * MIN }).kind, "alert");
});

test("告警里带上「上次正常产出是多久以前」", () => {
  const w = createDeadTurnWatch({ alertAfter: 1 });
  w.record({ text: "在", usage: { output_tokens: 2 } }, { now: 10 * MIN });
  const a = w.record({ text: "", usage: { output_tokens: 0 } }, { now: 100 * MIN });
  assert.match(a.text, /90 分钟前/);
});

test("state 给 /debug 用:数得对、报没报过看得见", () => {
  const w = createDeadTurnWatch({ alertAfter: 2 });
  const dead = { text: "", usage: { output_tokens: 0 } };
  w.record(dead, { now: 1 * MIN });
  assert.deepEqual(w.state, { streak: 1, alerted: false, lastGoodAt: null, alertAfter: 2 });
  w.record(dead, { now: 2 * MIN });
  assert.equal(w.state.alerted, true);
  w.record({ text: "在", usage: { output_tokens: 2 } }, { now: 3 * MIN });
  assert.deepEqual(w.state, { streak: 0, alerted: false, lastGoodAt: 3 * MIN, alertAfter: 2 });
});
