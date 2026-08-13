import { test } from "node:test";
import assert from "node:assert/strict";
import { tgEsc, chunkForHtml, TG_HTML_MAX } from "../tg-chunk.js";

const WRAP = "<blockquote expandable>".length + "</blockquote>".length; // 36
const TG_LIMIT = 4096;

test("短内容原样一条,不切", () => {
  assert.deepEqual(chunkForHtml("你好"), ["你好"]);
  assert.deepEqual(chunkForHtml(""), []);
});

test("每一块转义后都在上限内", () => {
  const raw = "他想了很久,<思考>".repeat(600);   // 转义后会膨胀得很厉害
  for (const p of chunkForHtml(raw)) {
    assert.ok(tgEsc(p).length <= TG_HTML_MAX, `块超限:${tgEsc(p).length}`);
  }
});

test("套上 blockquote 之后仍不超过 Telegram 的 4096(这才是真正的判据)", () => {
  const raw = "<&>".repeat(4000);              // 最坏情况:全是要转义的字符
  const parts = chunkForHtml(raw);
  assert.ok(parts.length > 1, "这么长必须被切开");
  for (const p of parts) {
    assert.ok(tgEsc(p).length + WRAP <= TG_LIMIT, `发出去会被 TG 拒收:${tgEsc(p).length + WRAP}`);
  }
});

test("不丢内容 —— 这是与旧版截断行为的关键区别", () => {
  // 旧版:超过 3600 直接 slice + "…",他想得越长丢得越多。新版一个字都不许少。
  const raw = Array.from({ length: 2000 }, (_, i) => `第${i}行内容`).join("\n");
  const parts = chunkForHtml(raw);
  assert.ok(parts.length > 1);
  assert.equal(parts.join("\n"), raw);         // 断点用掉的换行拼回来 = 原文
});

test("按原文长度切是不够的(回归:正是这个导致线上被 TG 拒收)", () => {
  const raw = "<".repeat(3600);                 // 原文 3600,转义后 14400
  assert.equal(raw.length, 3600);
  assert.ok(tgEsc(raw).length > TG_LIMIT, "前提:转义后确实超了 4096");
  for (const p of chunkForHtml(raw)) {
    assert.ok(tgEsc(p).length + WRAP <= TG_LIMIT);
  }
});

test("优先在换行处断开", () => {
  const line = "一".repeat(100);
  const raw = Array.from({ length: 100 }, () => line).join("\n");
  const parts = chunkForHtml(raw);
  assert.ok(parts.length > 1);
  // 断在换行上 = 每块都是完整的若干行,不会出现半行
  for (const p of parts.slice(0, -1)) {
    assert.ok(p.endsWith(line), "块尾应是完整一行");
  }
});

test("没有换行也能切(硬切兜底,不能死循环)", () => {
  const raw = "字".repeat(10000);
  const parts = chunkForHtml(raw);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(""), raw);
  for (const p of parts) assert.ok(tgEsc(p).length <= TG_HTML_MAX);
});

test("单个字符就超上限时也不会卡住", () => {
  const parts = chunkForHtml("&&&&", 2);        // "&amp;" = 5 > 2
  assert.ok(parts.length >= 1);
  assert.equal(parts.join(""), "&&&&");
});
