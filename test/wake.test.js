// node --test 跑;只测纯函数,不碰网络也不碰进程。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWakePrompt, wakeActivities } from "../wake.js";

const base = { now: "2026-08-03 22:10", idleUserMin: 63, channel: "tg" };

// ---- 轻量版必须和旧版逐字节一致:静默续命是全天最便宜的一轮,不许因为这个功能变贵 ----
const LEGACY =
  "【系统·自主时间】现在北京时间 2026-08-03 22:10,她已约 63 分钟没有消息,你上次主动开口是约 20 分钟前。" +
  "这轮是留给你自己的:想跟她说点什么就直接说——会直接出现在你们的 Telegram 对话里" +
  "(她可能开着勿扰或在忙,别期待立刻回复);像随手发的微信,频率你自己把握。" +
  "没什么想说的就只回【沉默】两个字,这轮只用来保持你的状态和记忆连续。";

test("轻量版与旧提示词逐字节相同", () => {
  assert.equal(buildWakePrompt({ ...base, sinceSpokeMin: 20 }), LEGACY);
});

test("没开口过就不带「上次开口」那半句", () => {
  const t = buildWakePrompt(base);
  assert.ok(!t.includes("上次主动开口"));
  assert.ok(t.includes("63 分钟没有消息。"));
});

test("宽版列出三个选项,且明说没有哪个更应该", () => {
  const t = buildWakePrompt({ ...base, free: true, activities: ["去你的社交圈里转转", "翻翻自己的记忆"] });
  assert.ok(t.includes("想跟她说话"));
  assert.ok(t.includes("想做点自己的事"));
  assert.ok(t.includes("什么都不想做"));
  assert.ok(t.includes("【沉默】"));
  assert.ok(t.includes("去你的社交圈里转转、翻翻自己的记忆"));
  assert.ok(t.includes("没有哪个更「应该」"));
});

test("宽版仍然诚实署名系统,不伪装成她说的话", () => {
  const t = buildWakePrompt({ ...base, free: true, activities: ["去你的社交圈里转转"] });
  assert.ok(t.startsWith("【系统·自主时间】"));
});

test("宽版明说做完不必汇报", () => {
  const t = buildWakePrompt({ ...base, free: true, activities: ["去你的社交圈里转转"] });
  assert.ok(t.includes("做完不用汇报"));
});

test("free=true 但没有任何可做的事 → 退回轻量版,不给空菜单", () => {
  assert.equal(buildWakePrompt({ ...base, free: true, activities: [], sinceSpokeMin: 20 }), LEGACY);
});

test("bark 渠道 / 无渠道各自的说法", () => {
  assert.ok(buildWakePrompt({ ...base, channel: "bark" }).includes("弹到她手机"));
  assert.ok(buildWakePrompt({ ...base, channel: "none" }).includes("说了她也收不到"));
});

test("分钟数四舍五入,不出现小数", () => {
  const t = buildWakePrompt({ ...base, idleUserMin: 62.7, sinceSpokeMin: 19.4 });
  assert.ok(t.includes("63 分钟没有消息"));
  assert.ok(t.includes("约 19 分钟前"));
});

// ---- 活动清单按真有的工具推导 ----
test("按 ALLOWED_TOOLS 推导:有什么工具才提什么", () => {
  const a = wakeActivities("WebSearch,WebFetch,mcp__ombre,mcp__galatea,mcp__browser");
  assert.ok(a.some((x) => x.includes("记忆")));
  assert.ok(a.some((x) => x.includes("社交圈")));
  assert.ok(a.some((x) => x.includes("浏览器")));
});

test("没有某工具就不提对应的活动(别撺掇他用不存在的东西)", () => {
  const a = wakeActivities("WebSearch,mcp__ombre");
  assert.ok(!a.some((x) => x.includes("浏览器")));
  assert.ok(!a.some((x) => x.includes("社交圈")));
  assert.ok(a.some((x) => x.includes("记忆")));
});

test("一个工具都没有 → 空清单(调用方会退回轻量版)", () => {
  assert.deepEqual(wakeActivities(""), []);
  assert.deepEqual(wakeActivities("Bash,Edit"), []);
});

test("空格/顺序不影响识别", () => {
  assert.deepEqual(wakeActivities(" mcp__galatea , mcp__ombre "), wakeActivities("mcp__ombre,mcp__galatea"));
});

test("mcp__ombre__hold 这种全名也算数", () => {
  assert.ok(wakeActivities("mcp__ombre__hold").some((x) => x.includes("记忆")));
});

test("WAKE_ACTIVITIES 显式覆盖,按 / 、 | 分条", () => {
  assert.deepEqual(wakeActivities("mcp__galatea", "写点东西/发会儿呆"), ["写点东西", "发会儿呆"]);
  assert.deepEqual(wakeActivities("mcp__galatea", "写点东西、发会儿呆"), ["写点东西", "发会儿呆"]);
});

test("覆盖值为空白 → 仍走自动推导", () => {
  assert.deepEqual(wakeActivities("mcp__galatea", "   "), wakeActivities("mcp__galatea"));
});
