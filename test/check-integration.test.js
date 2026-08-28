// 查岗 · 接线测试(真的把 server.js 跑起来,用假 claude 演)
//
// 纯逻辑那层在 check.test.js 里已经打过了。这里测的是只有跑起来才看得见的四件事:
//   1. 他写 [查岗] → 真的有一轮【系统·查岗】喂回去,而且带着她刚开的那个 App;
//   2. **防打转**:结果轮里他又写了一次 [查岗],不许再查第二次(假 claude 默认就这么演);
//   3. **查岗不算「她出现了」**:lastUserAt 不许被这一轮刷新(否则他说的等待时长全是假的);
//   4. 他选择不打扰(回【沉默】)时,压缩闸门不许被这一轮拉脏。
// 外加:钥匙、行踪不进裸奔的 /debug。

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
const TOKEN = "report-token";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 起一个 shim,把 base / 假 claude 收到的所有轮次文本交给回调,收工自动收摊
async function withShim(env, fn) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "shim-check-"));
  const inputOut = path.join(work, "input.txt");
  const port = 19301 + Math.floor(Math.random() * 300);
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn("node", [SERVER], {
    cwd: work,
    env: {
      ...process.env,
      PORT: String(port), SHIM_KEY: KEY, REPORT_TOKEN: TOKEN,
      CLAUDE_BIN: FAKE, FAKE_INPUT_OUT: inputOut,
      TG_BOT_TOKEN: "", BARK_KEY: "", ELEVENLABS_API_KEY: "", EARS_URL: "",
      TIME_STAMP: "0", COMPACT_HOOK: "0",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", () => {}); proc.stderr.on("data", () => {});
  const turns = () => { try { return fs.readFileSync(inputOut, "utf8"); } catch { return ""; } };
  try {
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(base + "/health")).ok) break; } catch {}
      await wait(100);
    }
    await fn({
      base, turns,
      say: async (t) => (await fetch(base + "/messages", {
        method: "POST",
        headers: { "x-api-key": KEY, "content-type": "application/json" },
        body: JSON.stringify({ stream: false, messages: [{ role: "user", content: t }] }),
      })).json(),
      dbg: async () => (await fetch(base + "/debug")).json(),
    });
  } finally { try { proc.kill(); } catch {} }
}

const countOf = (hay, needle) => hay.split(needle).length - 1;

test("上报:钥匙不对 401、对了就收下;GET 和 POST 都通", async () => {
  await withShim({}, async ({ base }) => {
    assert.equal((await fetch(`${base}/report?key=wrong&app=x`)).status, 401);
    const g = await (await fetch(`${base}/report?key=${TOKEN}&app=${encodeURIComponent("小红书")}`)).json();
    assert.deepEqual(g, { ok: true, stored: true, count: 1 });
    const p = await (await fetch(`${base}/report?key=${TOKEN}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_name: "抖音" }),
    })).json();
    assert.equal(p.count, 2);
    // 没带 App 名:收下但不入账,而且明确告诉调用方 stored:false(排障时分得清)
    const empty = await (await fetch(`${base}/report?key=${TOKEN}`)).json();
    assert.deepEqual(empty, { ok: true, stored: false });
  });
});

test("上报:App 名走请求头也认(网址里的裸中文进不了 express)", async () => {
  await withShim({}, async ({ base }) => {
    await fetch(`${base}/report?key=${TOKEN}`, {
      // 头里的非 ASCII 到 Node 手上是 latin1 字节,服务端要还原成 UTF-8
      headers: { "x-app": Buffer.from("小红书", "utf8").toString("latin1") },
    });
    const a = await (await fetch(`${base}/activity?key=${TOKEN}`)).json();
    assert.equal(a.lastApp, "小红书");
    // 排障口不许把钥匙原样回显出来
    assert.doesNotMatch(JSON.stringify(a), new RegExp(TOKEN));
  });
});

test("行踪不进裸奔的 /debug(只报条数),/activity 要钥匙", async () => {
  await withShim({}, async ({ base, dbg }) => {
    await fetch(`${base}/report?key=${TOKEN}&app=${encodeURIComponent("小红书")}`);
    const d = await dbg();
    assert.deepEqual(d.report, { on: true, count: 1 });
    assert.doesNotMatch(JSON.stringify(d), /小红书/);         // 公网可读的口子上没有她的行踪
    assert.equal((await fetch(`${base}/activity`)).status, 401);
  });
});

test("【核心】他写 [查岗] → 补一轮把她刚开的 App 喂回去,标记不给她看", async () => {
  await withShim({}, async ({ base, say, turns }) => {
    await fetch(`${base}/report?key=${TOKEN}&app=${encodeURIComponent("小红书")}`);
    const r = await say("CHECK_NOW");
    for (let i = 0; i < 40 && !turns().includes("【系统·查岗】"); i++) await wait(100);
    const all = turns();
    assert.match(all, /【系统·查岗】/);
    assert.match(all, /打开了小红书/);
    assert.match(all, /现在北京时间 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    // 非流式的 Kelivo 出口拿到的是剥过的正文(流式那条和 [语音]/[贴纸] 一样,标记会露出来)
    assert.equal(r.content[0].text, "嗯。");
  });
});

test("【防打转】结果轮里他又写了一次 [查岗] —— 只查一次", async () => {
  await withShim({}, async ({ base, say, turns }) => {
    await fetch(`${base}/report?key=${TOKEN}&app=${encodeURIComponent("抖音")}`);
    await say("CHECK_NOW");
    for (let i = 0; i < 40 && !turns().includes("【系统·查岗】"); i++) await wait(100);
    await wait(800);                                  // 给它足够时间打转(如果会的话)
    assert.equal(countOf(turns(), "【系统·查岗】"), 1);
  });
});

test("【坑 8】他自己伸头看一眼 ≠ 她回来了:lastUserAt 不许被刷新", async () => {
  await withShim({}, async ({ base, say, turns, dbg }) => {
    await fetch(`${base}/report?key=${TOKEN}&app=x`);
    await say("CHECK_NOW");
    const before = (await dbg()).wake.lastUserAt;      // 她说完话之后的基准
    for (let i = 0; i < 40 && !turns().includes("【系统·查岗】"); i++) await wait(100);
    await wait(400);
    assert.equal((await dbg()).wake.lastUserAt, before);
  });
});

test("功能没开(没配 REPORT_TOKEN):接口 503,标记原样留着不吞、也不空转", async () => {
  await withShim({ REPORT_TOKEN: "" }, async ({ base, say, turns }) => {
    assert.equal((await fetch(`${base}/report?key=x&app=y`)).status, 503);
    const r = await say("CHECK_NOW");
    await wait(600);
    assert.equal(r.content[0].text, "嗯。[查岗]");     // 露出来,好过安静地什么都不发生
    assert.equal(countOf(turns(), "【系统·查岗】"), 0);
    assert.equal((await (await fetch(base + "/debug")).json()).report.on, false);
  });
});

test("他选择不打扰(回【沉默】):不发给她,也不把压缩闸门拉脏", async () => {
  await withShim({ FAKE_LOOKUP_REPLY: "【沉默】" }, async ({ base, say, turns, dbg }) => {
    await fetch(`${base}/report?key=${TOKEN}&app=${encodeURIComponent("小红书")}`);
    // 归档 + 写标记同一轮:归档成功把闸门的账清干净(dirty=false),紧接着补一轮查岗。
    // 于是「查岗轮回【沉默】会不会把闸门重新顶起来」就成了这里唯一的变量。
    await say("archive_session CHECK_NOW");
    for (let i = 0; i < 40 && !turns().includes("【系统·查岗】"); i++) await wait(100);
    await wait(500);
    assert.equal(countOf(turns(), "【系统·查岗】"), 1);
    // 空轮不算「又产生了没归档的内容」——和心跳轮一个待遇。
    // 少了这条豁免,夜里几条查岗就能把压缩一直拦着。
    assert.equal((await dbg()).gate.dirty, false);
  });
});
