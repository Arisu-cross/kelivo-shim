// 自动浮现 · 接线测试(真跑 server.js + 假 claude + 假 OB)
// 钉的是只有跑起来才看得见的事:off 完全不问;observe 问但不递;运行时切 on 真递且不换窗口;
// 慢的那句后面紧跟的「嗯」不许插队;OB 超时照常发;重置词不问;浮现那行不进「原话」。

import { test } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(dir, "..", "server.js");
const FAKE = path.join(dir, "..", "dev", "fake-claude.mjs");
const KEY = "test-key";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await wait(40); } return false; }

// 假 OB:q 里带「鼻炎」就回一件旧事;带「慢」就故意等 delayMs
async function fakeOB({ delayMs = 0 } = {}) {
  const got = [];
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    got.push({ q: u.searchParams.get("q"), auth: req.headers.authorization, exclude: u.searchParams.get("exclude") });
    const q = u.searchParams.get("q") || "";
    if (q.includes("慢")) await wait(delayMs);
    const pick = q.includes("鼻炎") || q.includes("慢")
      ? { id: "nose1", name: "她的鼻炎", created: "2026-08-14", rare: ["鼻炎"], excerpt: "换季她鼻炎犯了。" } : null;
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ pick, reason: pick ? "ok" : "no_trusted_hit", candidates: [] }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { got, url: `http://127.0.0.1:${srv.address().port}/api/recall`, close: () => srv.close() };
}

async function withShim(env, fn) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "shim-recall-"));
  const inputOut = path.join(work, "in.txt");
  const port = 20101 + Math.floor(Math.random() * 90);
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn("node", [SERVER], {
    cwd: work,
    env: { ...process.env, PORT: String(port), SHIM_KEY: KEY, CLAUDE_BIN: FAKE, FAKE_INPUT_OUT: inputOut,
      TG_BOT_TOKEN: "", BARK_KEY: "", ELEVENLABS_API_KEY: "", EARS_URL: "", TIME_STAMP: "0", COMPACT_HOOK: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  proc.stdout.on("data", (d) => (logs += d)); proc.stderr.on("data", (d) => (logs += d));
  const say = (t) => fetch(base + "/v1/messages", {
    method: "POST", headers: { "x-api-key": KEY, "content-type": "application/json" },
    body: JSON.stringify({ stream: false, messages: [{ role: "user", content: t }] }),
  }).then((r) => r.json());
  const inputs = () => { try { return fs.readFileSync(inputOut, "utf8").split("\n\u0000\n").filter(Boolean); } catch { return []; } };
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/health")).ok) break; } catch {} await wait(100); }
    await fn({ base, say, inputs, logs: () => logs, spawns: () => (logs.match(/\[claude\] spawned/g) || []).length,
      dbg: async () => (await fetch(base + "/debug")).json(),
      setMode: (mode) => fetch(base + "/recall", { method: "POST", headers: { "x-api-key": KEY, "content-type": "application/json" }, body: JSON.stringify({ mode }) }) });
  } finally { try { proc.kill(); } catch {} }
}

test("off(默认):一次都不问 OB,他收到的话原样", async () => {
  const ob = await fakeOB();
  try {
    await withShim({ RECALL_URL: ob.url, RECALL_TOKEN: "tok" }, async ({ say, inputs, dbg }) => {
      await say("鼻炎又犯了");
      assert.equal(ob.got.length, 0);
      assert.deepEqual(inputs(), ["鼻炎又犯了"]);
      assert.equal((await dbg()).recall.mode, "off");
    });
  } finally { ob.close(); }
});

test("on:浮现那行在她的话之前、带钥匙去问;重置词不问;GET /recall 要钥匙", async () => {
  const ob = await fakeOB();
  try {
    await withShim({ RECALL_URL: ob.url, RECALL_TOKEN: "tok", RECALL_MODE: "on" }, async ({ base, say, inputs }) => {
      await say("鼻炎又犯了");
      assert.equal(ob.got[0].auth, "Bearer tok");
      const first = inputs()[0];
      assert.match(first, /^【系统·浮现】.*「她的鼻炎」换季她鼻炎犯了。.*\n鼻炎又犯了$/s);
      await say("今天天气不错");
      assert.equal(inputs()[1], "今天天气不错", "没翻到就什么都不加");
      const n = ob.got.length;
      await say("归档");
      assert.equal(ob.got.length, n, "重置词不问");
      assert.equal((await fetch(base + "/recall")).status, 401);
      const g = await (await fetch(base + "/recall", { headers: { "x-api-key": KEY } })).json();
      assert.ok(g.log.some((x) => x.injected && x.pick?.name === "她的鼻炎"));
      assert.ok(!JSON.stringify(g).includes("换季她鼻炎犯了"), "观察记录不带记忆正文");
      // 冷却:同一件 12 小时内不再递 —— 第二次问时 exclude 里带着它
      await say("鼻炎还没好");
      assert.equal(ob.got.at(-1).exclude, "nose1");
    });
  } finally { ob.close(); }
});

test("observe 问了但不递;运行时切 on 真递,而且不换窗口", async () => {
  const ob = await fakeOB();
  try {
    await withShim({ RECALL_URL: ob.url, RECALL_TOKEN: "tok", RECALL_MODE: "observe", RECALL_COOLDOWN_H: "0.0001" }, async ({ say, inputs, spawns, setMode }) => {
      await say("鼻炎又犯了");
      assert.equal(ob.got.length, 1);
      assert.equal(inputs()[0], "鼻炎又犯了");
      assert.equal((await setMode("on")).status, 200);
      await wait(50);
      await say("鼻炎好点了");
      assert.match(inputs()[1], /^【系统·浮现】/);
      assert.equal(spawns(), 1, "同一个进程 = 没换窗口");
      assert.equal((await setMode("bogus")).status, 400);
    });
  } finally { ob.close(); }
});

test("不乱序:等 OB 的那句后面紧跟一个「嗯」,「嗯」不许先进去", async () => {
  const ob = await fakeOB({ delayMs: 800 });
  try {
    await withShim({ RECALL_URL: ob.url, RECALL_TOKEN: "tok", RECALL_MODE: "on" }, async ({ say, inputs }) => {
      const a = say("慢慢说鼻炎的事");
      await wait(50);
      const b = say("嗯");
      await Promise.all([a, b]);
      const got = inputs();
      assert.equal(got.length, 2);
      assert.match(got[0], /慢慢说鼻炎的事$/);
      assert.equal(got[1], "嗯");
    });
  } finally { ob.close(); }
});

test("OB 超时:照常发、不附", async () => {
  const ob = await fakeOB({ delayMs: 2000 });
  try {
    await withShim({ RECALL_URL: ob.url, RECALL_TOKEN: "tok", RECALL_MODE: "on", RECALL_TIMEOUT_MS: "300" }, async ({ say, inputs, logs }) => {
      const t0 = Date.now();
      await say("慢慢说");
      assert.equal(inputs()[0], "慢慢说");
      assert.ok(Date.now() - t0 < 1800, "没傻等 OB");
      assert.match(logs(), /\[recall\] on timeout/);
    });
  } finally { ob.close(); }
});
