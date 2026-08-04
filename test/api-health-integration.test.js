// 模型断线 · 接线测试(真跑 server.js,让假 claude 重演 2026-08-04 的授权故障)
//
// 纯逻辑测试只证明「认得出这个事件」。真正要证明的是那天没做到的三件事:
//   ① 日志里有没有留下痕迹(那天一整晚零痕迹)
//   ② 她收到的是不是人话(那天是一个「…」)
//   ③ /debug 能不能一眼看出「不是他的问题」(那天只能靠翻 lastUsage 的 0)
// 前两条只有把 server.js 真跑起来才测得出来。

import { test, before, after } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(dir, "..", "server.js");
const FAKE = path.join(dir, "..", "dev", "fake-claude.mjs");
const KEY = "test-key";
let proc, base, logs = "";

const j = async (p, opt = {}) => {
  const r = await fetch(base + p, { headers: { "x-api-key": KEY, "content-type": "application/json" }, ...opt });
  return r.json();
};
const say = (text) => j("/messages", { method: "POST", body: JSON.stringify({ stream: false, messages: [{ role: "user", content: text }] }) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  const port = 20787 + Math.floor(Math.random() * 500);
  base = `http://127.0.0.1:${port}`;
  proc = spawn("node", [SERVER], {
    env: {
      ...process.env,
      PORT: String(port), SHIM_KEY: KEY, CLAUDE_BIN: FAKE,
      TG_BOT_TOKEN: "", BARK_KEY: "", ELEVENLABS_API_KEY: "", EARS_URL: "",
      TIME_STAMP: "0", WINDOW_LIMIT: "100000", COMPACT_HOOK: "0",
      FAKE_API_FAIL: "1",     // 每一轮都重演那场授权故障
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (c) => { logs += c.toString(); });
  proc.stderr.on("data", (c) => { logs += c.toString(); });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + "/health"); if (r.ok) return; } catch {}
    await wait(100);
  }
  throw new Error("shim 没起来");
});

after(() => { try { proc.kill(); } catch {} });

test("【回归·日志】故障必须在日志里留下痕迹", async () => {
  logs = "";
  await say("在吗");
  await wait(300);
  assert.ok(logs.includes("[result-error]"), "那天一整晚零日志,就是因为这里没触发\n" + logs);
  assert.ok(logs.includes("503"), "状态码要能看见:" + logs);
  assert.ok(logs.includes("auth_unavailable"), "根因那句要能看见:" + logs);
});

test("【回归·她看到什么】不能再是一个「…」", async () => {
  const r = await say("你怎么不理我");
  const said = (r.content || []).map((b) => b.text || "").join("");
  assert.ok(said.includes("不是他不理你"), "这次事故最伤人的部分,必须说清:" + said);
  assert.ok(said.includes("503 auth_unavailable"), "得带上可排查的信息:" + said);
  assert.ok(!/^…*$/.test(said.trim()), "不能再交白卷:" + JSON.stringify(said));
});

test("【回归·可观测】/debug 一眼能看出不是他的问题", async () => {
  const d = await j("/debug");
  assert.ok(d.api, "/debug 得有 api 这一节");
  assert.ok(d.api.fails > 0, "连续失败轮数要能看见");
  assert.ok(d.api.lastFailWhy.includes("auth_unavailable"), "根因要能看见:" + d.api.lastFailWhy);
  assert.equal(d.api.lastOkAt, null, "开机后一轮都没成功过,不该谎报成功过");
});

// ⚠️ 这里守的**不是**「失败轮什么都不记」。她的话确实进了窗口,记下来、把闸门标脏
// 都是对的 —— 万一压缩来了,这些消息还能靠原文回放补回去。
// 真正该守的是:**错误提示不能被当成他说过的话**。他一个字都没说,别替他记。
test("错误提示不被当成他的原话记进补档缓冲", async () => {
  const before = (await j("/debug")).gate.bufferedChars;
  const mine = "这句话有十七个字符长";           // 长度已知,便于精确比对
  await say(mine);
  await wait(300);
  const after = (await j("/debug")).gate.bufferedChars;
  assert.equal(after - before, mine.length,
    `缓冲只该多出她这句话(${mine.length} 字);多出来的部分就是错误提示被误记成他的原话了`);
});

test("她的话仍然被保住(失败不等于把她说的也丢掉)", async () => {
  const d = await j("/debug");
  assert.ok(d.gate.bufferedChars > 0, "她说过的话必须留着,压缩时才补得回去");
  assert.equal(d.gate.dirty, true, "窗口里有没归档的内容,闸门就该拦压缩");
});

test("失败不影响窗口计数,也不会把服务卡死", async () => {
  const h = await (await fetch(base + "/health")).json();
  assert.equal(h.busy, false);
  assert.equal(h.queued, 0);
});
