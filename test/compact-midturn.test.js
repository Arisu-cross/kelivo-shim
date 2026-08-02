// 回归:压缩发生在一轮的中间时,窗口用量不能被压缩前的旧前缀污染
//
// 2026-08-02 线上真实现象:19:34 压缩过一次,之后 /debug 显示窗口 46%,
// 而 `warned`(85% 已提醒)和 `autoArchived`(90% 已自动归档)**都是 true**。
// 根因:真实事件顺序是
//   [同一轮] message_start(压缩前 167159) → compact_boundary → message_start(压缩后 9000) → result
// shim 取「本轮最大前缀」,于是压缩刚做完反被记成 100% 满窗。后果两条:
//   ① 压缩后立刻给用户发一条假的「窗口 100%」提醒;
//   ② 85%/90% 标志被假读数用掉,这个窗口后面真到 90% 时早归档不再触发。
// 修法:compact_boundary 里把本轮已累计的 peakPrefix 清零 —— 那份上下文已经不存在了。

import { test, before, after } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(dir, "..", "server.js");
const FAKE = path.join(dir, "..", "dev", "fake-claude-compact-mid.mjs");
const KEY = "test-key";
let proc, base;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  const port = 19300 + Math.floor(Math.random() * 400);
  base = `http://127.0.0.1:${port}`;
  proc = spawn("node", [SERVER], {
    env: {
      ...process.env, PORT: String(port), SHIM_KEY: KEY, CLAUDE_BIN: FAKE,
      TG_BOT_TOKEN: "", BARK_KEY: "", ELEVENLABS_API_KEY: "", EARS_URL: "",
      TIME_STAMP: "0", COMPACT_HOOK: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", () => {}); proc.stderr.on("data", () => {});
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(base + "/health")).ok) return; } catch {}
    await wait(100);
  }
  throw new Error("shim 没起来");
});
after(() => { try { proc.kill(); } catch {} });

test("【回归】压缩后的窗口用量按压缩后的前缀算,不是压缩前那个满窗值", async () => {
  await fetch(base + "/messages", {
    method: "POST",
    headers: { "x-api-key": KEY, "content-type": "application/json" },
    body: JSON.stringify({ stream: false, messages: [{ role: "user", content: "聊天" }] }),
  });
  await wait(200);
  const d = await (await fetch(base + "/debug", { headers: { "x-api-key": KEY } })).json();

  assert.equal(d.window.compactions, 1, "压缩要被记到");
  assert.ok(d.window.tokens <= 9000, `窗口该是压缩后的 9000,实际 ${d.window.tokens}`);
  assert.ok(d.window.pct < 85, `压缩后不该显示成满窗,实际 ${d.window.pct}%`);
  assert.equal(d.window.warned, false, "不能发那条假的「窗口快满了」提醒");
  assert.equal(d.window.autoArchived, false, "90% 早归档的额度不能被假读数用掉");
  assert.equal(d.window.lastCompactPreTokens, 167159, "压缩前的大小仍要如实留档(供排查)");
});
