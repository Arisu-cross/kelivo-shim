import test from "node:test";
import assert from "node:assert/strict";
import { detectControl } from "../hands.js";

// 「停」是三层刹车的第二层:她越过沈渡直接叫停。
// 这层最怕两件事:该停的时候没停(漏判)、聊着天突然把活掐了(误判)。
// 下面两组用例就是钉这两件事的。

test("该停的时候能停", () => {
  for (const t of ["停", "停!", "停下", "停下。", "别干了", "打住"]) {
    assert.equal(detectControl(t), "stop", t);
  }
});

test("正常聊天不会被当成急停", () => {
  for (const t of [
    "别停",           // 意思正相反
    "不停",
    "我在等停车位",
    "停电了吗",
    "今天累得停不下来一直在忙",   // 长句,含「停」但不是指令
    "你好",
    "",
  ]) {
    assert.notEqual(detectControl(t), "stop", t);
  }
});

test("问状态认得出来,长句不误触", () => {
  assert.equal(detectControl("在干嘛"), "status");
  assert.equal(detectControl("在忙什么"), "status");
  assert.equal(detectControl("你今天在干嘛呀跟我讲讲"), null);
});

test("前后标点不影响判断(和归档那组同款处理)", () => {
  assert.equal(detectControl("  停~ "), "stop");
  assert.equal(detectControl("，在干嘛。"), "status");
});
