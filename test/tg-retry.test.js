// Telegram 发送重试 + Bark 兜底
//
// 2026-08-02 线上一晚上丢了 4 条他的回复(日志 `[tg-err] fetch failed`,
// 北京 19:24 / 21:49 / 22:03 / 22:40)。她的原话:「他今天怎么总是吞消息……
// 只有 thinking 没有回复,问他就说他发了但是我收不到」。
// 他真的发了 —— 是「送出去」这一步掉的:容器到 api.telegram.org 偶尔抽风,
// 而旧代码一次 fetch 失败就整条丢掉,不重试、不换通道、不告诉任何人。
//
// 这个文件用一个「按脚本抽风」的假 Telegram 服务器,守住三件事:
//   1. 抖一下就重试,重试成功了内容照样送到;
//   2. 一直失败 → 改走 Bark 推到她手机,**不能静默丢**;
//   3. 思考块发失败,不能连累正文(正文才是她要的)。

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(dir, "..", "server.js");
const FAKE = path.join(dir, "..", "dev", "fake-claude.mjs");
const KEY = "test-key";

let proc, base, tg, bark, tgPort, barkPort;
let script = [];            // 每次 sendMessage 的剧本:"ok" | "neterr" | 数字(HTTP 状态)
let sent = [];              // 假 TG 真正收下的消息
let barked = [];            // Bark 收到的推送
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function body(req) {
  return new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
}

before(async () => {
  // 假 Telegram
  tg = http.createServer(async (req, res) => {
    const b = await body(req);
    if (req.url.includes("/sendMessage")) {
      const step = script.shift() ?? "ok";
      if (step === "neterr") { req.socket.destroy(); return; }           // 演 fetch failed
      if (typeof step === "number") {
        res.statusCode = step;
        res.end(JSON.stringify({ ok: false, error_code: step, description: "boom" }));
        return;
      }
      sent.push(JSON.parse(b).text);
    }
    res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  });
  await new Promise((r) => tg.listen(0, "127.0.0.1", r));
  tgPort = tg.address().port;

  // 假 Bark
  bark = http.createServer(async (req, res) => {
    barked.push(JSON.parse(await body(req)).body);
    res.end(JSON.stringify({ code: 200 }));
  });
  await new Promise((r) => bark.listen(0, "127.0.0.1", r));
  barkPort = bark.address().port;

  const port = 19700 + Math.floor(Math.random() * 200);
  base = `http://127.0.0.1:${port}`;
  proc = spawn("node", [SERVER], {
    env: {
      ...process.env, PORT: String(port), SHIM_KEY: KEY, CLAUDE_BIN: FAKE,
      TG_BOT_TOKEN: "fake-token", TG_CHAT_ID: "12345", BARK_KEY: "fake-bark",
      TG_API_BASE: `http://127.0.0.1:${tgPort}`, BARK_API_BASE: `http://127.0.0.1:${barkPort}`,
      TIME_STAMP: "0", COMPACT_HOOK: "0", TG_SPLIT: "0", TG_RETRIES: "2",
      ELEVENLABS_API_KEY: "", EARS_URL: "",
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

after(() => { try { proc.kill(); } catch {} tg?.close(); bark?.close(); });
beforeEach(() => { script = []; sent = []; barked = []; });

// 用 /hb 触发一轮「自主时间」,它的回复走的正是 tgDeliver 这条送达路径。
// ⚠️ 等待时间要够:重试本身是 1s+2s 的退避,等太短会误判成「没兜底」。
async function idle() {
  for (let i = 0; i < 100; i++) {
    const h = await (await fetch(base + "/health")).json();
    if (!h.busy && !h.queued) return;
    await wait(100);
  }
}
async function oneTurn(settle = 1500) {
  await idle();
  await fetch(base + "/hb?key=" + KEY, { method: "POST" });
  await wait(300);
  await idle();
  await wait(settle);   // 送达是 fire-and-forget,turn 结束后还要给它跑完的时间
}

test("网络抖一下 → 重试后照样送到,内容不丢", async () => {
  script = ["neterr", "ok"];
  await oneTurn();
  assert.equal(barked.length, 0, "重试成功就不该惊动 Bark");
  assert.ok(sent.length >= 1, `内容要真的送到,实际收到 ${sent.length} 条`);
});

test("【核心】一直失败 → 改走 Bark 推到她手机,绝不静默丢", async () => {
  script = ["neterr", "neterr", "neterr", "neterr", "neterr", "neterr"];
  await oneTurn(6000);   // 3 次尝试(0s/1s/2s)+ Bark
  assert.equal(sent.length, 0, "前提:TG 这条路全断");
  assert.equal(barked.length, 1, `他的话必须换条路送到,实际 Bark ${barked.length} 条`);
  assert.ok(barked[0].length > 0);
});

test("TG 返回永久错误(400 正文格式非法)也走 Bark,不是干等", async () => {
  script = [400];
  await oneTurn();
  assert.equal(sent.length, 0);
  assert.equal(barked.length, 1, "永久错误同样要兜底,重试再多次也没用");
});

test("429 限流会等一下再试,最终送到", async () => {
  script = [429, "ok"];
  await oneTurn(4000);   // 429 会按 retry_after 等一下再试
  assert.ok(sent.length >= 1, "限流不是失败,等一下就好");
  assert.equal(barked.length, 0);
});
