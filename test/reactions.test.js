// node --test 跑;只测纯函数,不碰网络。
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitReactionSegments, canonicalReaction, ALLOWED } from "../reactions.js";

test("纯文字:整段原样、单段", () => {
  assert.deepEqual(splitReactionSegments("今天怎么样?\n早点睡。"),
    [{ type: "text", content: "今天怎么样?\n早点睡。" }]);
});

test("单标记:只出一个 reaction 段,标记从文字里抹掉", () => {
  assert.deepEqual(splitReactionSegments("[回应:❤️]"),
    [{ type: "reaction", content: "❤️" }]);
});

test("文字+回应混排:按出现顺序,前后文字各自成段", () => {
  assert.deepEqual(splitReactionSegments("睡吧。[回应:❤️]明天见。"), [
    { type: "text", content: "睡吧。" },
    { type: "reaction", content: "❤️" },
    { type: "text", content: "明天见。" },
  ]);
});

test("全角括号/全角冒号/多余空格都认", () => {
  for (const raw of ["【回应:👍】", "[回应:👍]", "[ 回应 : 👍 ]", "【 回应 : 👍 】"]) {
    assert.deepEqual(splitReactionSegments(raw), [{ type: "reaction", content: "👍" }], raw);
  }
});

test("内容不像表情:标记原样保留,不吞字", () => {
  for (const raw of ["[回应:好的]", "[回应:ok]", "[回应:123]"]) {
    assert.deepEqual(splitReactionSegments(raw), [{ type: "text", content: raw }], raw);
  }
});

test("没闭合的标记原样当文字,不把后半篇吃掉", () => {
  const raw = "[回应:❤️ 你今天还好吗";
  assert.deepEqual(splitReactionSegments(raw), [{ type: "text", content: raw }]);
});

test("白名单外的表情照样切成 reaction 段(降级交给发送层,标记不许漏给她看)", () => {
  assert.deepEqual(splitReactionSegments("[回应:😏]"), [{ type: "reaction", content: "😏" }]);
  assert.equal(canonicalReaction("😏"), null);
});

test("canonicalReaction:带不带变体选择符都认,返回 TG 那边的形态", () => {
  assert.equal(canonicalReaction("❤️"), "❤");   // 输入法打出来的带 U+FE0F
  assert.equal(canonicalReaction("❤"), "❤");
  assert.equal(canonicalReaction("👍"), "👍");
  assert.equal(canonicalReaction("🤷‍♀️"), "🤷‍♀");  // 带 ZWJ 的也要能对上
  assert.equal(canonicalReaction("好的"), null);
  assert.equal(canonicalReaction(""), null);
});

test("白名单本身:每一项都能被自己认出来(防手抄名单时打错字)", () => {
  for (const e of ALLOWED) assert.equal(canonicalReaction(e), e, e);
});

test("一轮里多个标记都切出来(只让第一个真的贴上去是发送层的事)", () => {
  assert.deepEqual(splitReactionSegments("[回应:❤️]嗯。[回应:👍]"), [
    { type: "reaction", content: "❤️" },
    { type: "text", content: "嗯。" },
    { type: "reaction", content: "👍" },
  ]);
});
