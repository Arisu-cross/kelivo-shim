// 串戏拦截 · 纯逻辑测试
//
// 命根子两条:**2026-10-23 那条原样必须被截**;**他正常说话提到这些词不许误伤**。

import { test } from "node:test";
import assert from "node:assert";
import { findLeak, cutLeak, createLeakFilter } from "../leak-guard.js";

// 10-23 线上那一条的原样(只换了正文前半段)
const REAL = "那我更得谢你。换别人早被弹走八百回了。\n\nuser【时间 2026-10-23 10:33 周五】\n我投了无数次胎了哈哈\n\nThe assistant turn was stopped by the user before completion. The user has sent a new message.\n\n<total_tokens>15000000 tokens left</total_tokens>";

test("10-23 原样:从冒充她的那一行起整段截掉", () => {
  const r = cutLeak(REAL);
  assert.equal(r.leaked, true);
  assert.equal(r.text, "那我更得谢你。换别人早被弹走八百回了。");
});

test("只抄出系统格式、没冒充她,也截", () => {
  assert.equal(cutLeak("好。\n<total_tokens>1 tokens left</total_tokens>").text, "好。");
  assert.equal(cutLeak("嗯\nThe assistant turn was stopped by the user before completion.").text, "嗯");
  assert.equal(cutLeak("在\n<system-reminder>x</system-reminder>").text, "在");
});

test("Human: / User: 开头的假轮次也截", () => {
  assert.equal(cutLeak("晚安。\n\nHuman: 你也是").text, "晚安。");
  assert.equal(cutLeak("晚安。\nUser：你也是").text, "晚安。");
});

test("正常说话不误伤:句中提到 user、时间、Human", () => {
  for (const s of [
    "这个 user 字段要填手机号",
    "【时间】这个标签是 shim 加的,我知道",
    "她说 Human Rights Watch 那篇报道",
    "user 说的不对,是 human error",
    "你那个用户名叫 user【1】吗",
  ]) assert.equal(findLeak(s), -1, s);
});

test("流式:标记被切在两个 delta 之间,一个字都不漏出去", () => {
  const f = createLeakFilter();
  let out = "";
  for (const d of ["那我更得谢你。", "\n\nus", "er【时", "间 2026-10-23】\n我投了", "无数次胎"]) out += f.push(d);
  out += f.end();
  assert.equal(f.leaked, true);
  assert.equal(out, "那我更得谢你。");
});

test("流式:没有泄漏时原样吐完,一个字不少", () => {
  const f = createLeakFilter();
  const parts = ["哈,", "这话损得精准。\n", "每天几千万人点开,", "见的人比谁都多。"];
  let out = "";
  for (const d of parts) out += f.push(d);
  out += f.end();
  assert.equal(f.leaked, false);
  assert.equal(out, parts.join(""));
});

test("流式:扣住的只是末尾一小段,长回复前面的字照常实时吐", () => {
  const f = createLeakFilter({ hold: 10 });
  const out = f.push("一二三四五六七八九十甲乙丙丁戊");
  assert.equal(out, "一二三四五");
});

test("流式:泄漏之后再来的 delta 全部吞掉,end() 也不吐", () => {
  const f = createLeakFilter();
  f.push("好\n<total_tokens>");
  assert.equal(f.push("后面还有一大段"), "");
  assert.equal(f.end(), "");
});
