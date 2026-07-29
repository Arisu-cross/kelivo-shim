// 窗口用量估算测试
//
// 这里最容易搞错、也最值得测的一点:一轮里每次工具调用都是一次 API 请求,
// usage 顶层是这一轮所有请求的累加值。拿顶层当窗口大小会高估好几倍 ——
// 下面第二个用例就是线上 /debug 抓下来的真实数据(顶层 cache_read 20 万,
// 真实前缀 6.7 万),用来钉死这个坑。

import { test } from "node:test";
import assert from "node:assert";
import { estimateWindowTokens, windowPct, DEFAULT_WINDOW_LIMIT } from "../window.js";

test("单次调用的轮次:顶层就是精确值", () => {
  const usage = { input_tokens: 5, cache_read_input_tokens: 67098, cache_creation_input_tokens: 103 };
  assert.equal(estimateWindowTokens(usage), 67206);
});

test("多次调用的轮次:取 iterations 里最大的那次,不能用顶层累加值", () => {
  // 线上真实数据:顶层 cache_read=200405 是 3 次调用的累加,真实前缀约 6.7 万
  const usage = {
    input_tokens: 5,
    cache_creation_input_tokens: 733,
    cache_read_input_tokens: 200405,
    iterations: [
      { input_tokens: 1, cache_read_input_tokens: 67098, cache_creation_input_tokens: 103 },
      { input_tokens: 2, cache_read_input_tokens: 67320, cache_creation_input_tokens: 210 },
    ],
  };
  const est = estimateWindowTokens(usage);
  assert.equal(est, 67532, "应取 iterations 里最大的一次");
  assert.ok(est < 100000, "绝不能把顶层累加值当窗口大小(会高估 3 倍触发误报)");
});

test("没有 usage / 空对象不炸", () => {
  assert.equal(estimateWindowTokens(null), 0);
  assert.equal(estimateWindowTokens(undefined), 0);
  assert.equal(estimateWindowTokens({}), 0);
});

test("iterations 是空数组时退回顶层", () => {
  const usage = { cache_read_input_tokens: 1234, iterations: [] };
  assert.equal(estimateWindowTokens(usage), 1234);
});

test("缺字段按 0 计,不产生 NaN", () => {
  const est = estimateWindowTokens({ cache_read_input_tokens: 500 });
  assert.equal(est, 500);
  assert.ok(!Number.isNaN(est));
});

test("百分比:85% 提醒线两侧", () => {
  assert.equal(windowPct(0, 167000), 0);
  assert.ok(windowPct(141000, 167000) < 85, "141k 还不该提醒");
  assert.ok(windowPct(142000, 167000) >= 85, "142k 该提醒了");
  assert.equal(windowPct(167000, 167000), 100);
});

test("limit 为 0 不除零", () => {
  assert.equal(windowPct(1000, 0), 0);
});

test("默认触发线与 Claude Code 的算法对得上(200k 上下文)", () => {
  // effectiveWindow = 200000 - min(maxOutput, 20000);  threshold = effectiveWindow - 13000
  assert.equal(DEFAULT_WINDOW_LIMIT, 200000 - 20000 - 13000);
});
