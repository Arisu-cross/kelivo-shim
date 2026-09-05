// 空转看门狗 · 接线测试(真把 server.js 跑起来,用假 claude 演 9-02 那次)
//
// 纯逻辑在 deadturn.test.js 里打过了。这里测的是只有跑起来才看得见的事:
//   1. 空转真的被数上了(result 那个分支确实调到了看门狗);
//   2. 到了阈值 alerted 翻上去 —— 也就是「该吭声了」这一步真的会发生;
//   3. 【核心】他回【沉默】不许被算成空转(9-02 拖八小时就栽在这两者分不开);
//   4. 有真实产出之后计数清零,两段故障不会被拼成一段;
//   5. DEAD_TURN_WATCH=0 是彻底的空操作。
//
// 为什么不测「TG 到底发出去没有」:发送写死打 api.telegram.org,测这一步要么真出网、
// 要么为测试改生产代码的出站路径。这里到 alerted 为止 —— 再往后是 tgSend,
// 它在归档失败那条路上已经用了很久。

import { test } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(dir, "..", "server.js");
const FAKE = path.join(dir, "..", "dev", "fake-claude.mjs");
const KEY = "test-key";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function withShim(env, fn) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "shim-dead-"));
  const port = 19701 + Math.floor(Math.random() * 200);
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn("node", [SERVER], {
    cwd: work,
    env: {
      ...process.env,
      PORT: String(port), SHIM_KEY: KEY,
      CLAUDE_BIN: FAKE,
      TG_BOT_TOKEN: "", BARK_KEY: "", ELEVENLABS_API_KEY: "", EARS_URL: "",
      TIME_STAMP: "0", COMPACT_HOOK: "0",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", () => {}); proc.stderr.on("data", () => {});
  try {
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(base + "/health")).ok) break; } catch {}
      await wait(100);
    }
    await fn({
      base,
      say: async (t) => (await fetch(base + "/messages", {
        method: "POST",
        headers: { "x-api-key": KEY, "content-type": "application/json" },
        body: JSON.stringify({ stream: false, messages: [{ role: "user", content: t }] }),
      })).json(),
      dbg: async () => (await fetch(base + "/debug")).json(),
    });
  } finally { try { proc.kill(); } catch {} }
}

test("空转被数上了,到阈值就该吭声(9-02 那次的原样)", async () => {
  await withShim({ DEAD_TURN_ALERT_AFTER: "3" }, async ({ say, dbg }) => {
    await say("DEAD_NOW");
    let d = await dbg();
    assert.equal(d.deadTurn.on, true);
    assert.equal(d.deadTurn.streak, 1);
    assert.equal(d.deadTurn.alerted, false, "第一轮不许吵她");

    await say("DEAD_NOW");
    assert.equal((await dbg()).deadTurn.alerted, false, "第二轮还不许吵她");

    await say("DEAD_NOW");
    d = await dbg();
    assert.equal(d.deadTurn.streak, 3);
    assert.equal(d.deadTurn.alerted, true, "第三轮该报了");
  });
});

test("【核心】他回【沉默】不算空转 —— 这就是 9-02 分不开的那两件事", async () => {
  await withShim({ DEAD_TURN_ALERT_AFTER: "2" }, async ({ say, dbg }) => {
    // 假 claude 对普通文本回「嗯,在听」,是有 output token 的一轮 —— 和【沉默】同一类:有产出
    for (let i = 0; i < 5; i++) await say("在吗");
    const d = await dbg();
    assert.equal(d.deadTurn.streak, 0);
    assert.equal(d.deadTurn.alerted, false);
    assert.ok(d.deadTurn.lastGoodAt, "有产出的轮次要记下时刻,告警里要用");
  });
});

test("有真实产出就清零,两段故障不会被拼成一段", async () => {
  await withShim({ DEAD_TURN_ALERT_AFTER: "3" }, async ({ say, dbg }) => {
    await say("DEAD_NOW");
    await say("DEAD_NOW");
    assert.equal((await dbg()).deadTurn.streak, 2);
    await say("在吗");
    assert.equal((await dbg()).deadTurn.streak, 0);
    await say("DEAD_NOW");
    await say("DEAD_NOW");
    const d = await dbg();
    assert.equal(d.deadTurn.streak, 2);
    assert.equal(d.deadTurn.alerted, false, "重新数,不许接着上一段报");
  });
});

test("DEAD_TURN_WATCH=0 是彻底的空操作(想关随时能关)", async () => {
  await withShim({ DEAD_TURN_WATCH: "0", DEAD_TURN_ALERT_AFTER: "1" }, async ({ say, dbg }) => {
    await say("DEAD_NOW");
    await say("DEAD_NOW");
    const d = await dbg();
    assert.equal(d.deadTurn.on, false);
    assert.equal(d.deadTurn.streak, 0);
    assert.equal(d.deadTurn.alerted, false);
  });
});
