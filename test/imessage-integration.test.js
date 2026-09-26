// iMessage 那扇门 · 接线测试(真把 server.js 跑起来,用假 claude)
//
// 纯逻辑在 push-route.test.js 里打过了。这里钉三件只有跑起来才看得见的事:
//   1. 【核心】iMessage 的请求不带 system,**不许**因此杀进程换窗口
//      (Kelivo 带世界书、iMessage 不带,换一次入口丢一次窗口 —— 这是接 iMessage 最大的雷);
//   2. 她最后在 iMessage 说话 → 心跳先推到 bridge 的 /push;bridge 挂了 → 不吞,退到下一扇门;
//   3. 她回到 Kelivo 说话 → 心跳不再推 iMessage。

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
async function until(fn, ms = 5000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await wait(50); } return false; }

// 假 bridge 的 /push:记下收到的,按 status 回
async function fakeBridge(status = 200) {
  const got = [];
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (d) => (b += d)).on("end", () => {
      got.push({ key: req.headers["x-api-key"], body: JSON.parse(b || "{}") });
      res.writeHead(status, { "Content-Type": "application/json" }).end("{}");
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { got, url: `http://127.0.0.1:${srv.address().port}/push`, close: () => srv.close() };
}

async function withShim(env, fn) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "shim-imsg-"));
  const argvOut = path.join(work, "argv.json");
  const port = 19901 + Math.floor(Math.random() * 90);
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn("node", [SERVER], {
    cwd: work,
    env: {
      ...process.env,
      PORT: String(port), SHIM_KEY: KEY, CLAUDE_BIN: FAKE, FAKE_ARGV_OUT: argvOut,
      TG_BOT_TOKEN: "", BARK_KEY: "", ELEVENLABS_API_KEY: "", EARS_URL: "",
      TIME_STAMP: "0", COMPACT_HOOK: "0",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  proc.stdout.on("data", (d) => (logs += d)); proc.stderr.on("data", (d) => (logs += d));
  const post = (headers, body) => fetch(base + "/v1/messages", {
    method: "POST", headers: { "x-api-key": KEY, "content-type": "application/json", ...headers },
    body: JSON.stringify({ stream: false, ...body }),
  }).then((r) => r.json());
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/health")).ok) break; } catch {} await wait(100); }
    await fn({
      base, logs: () => logs,
      spawns: () => (logs.match(/\[claude\] spawned/g) || []).length,
      argv: () => { try { return fs.readFileSync(argvOut, "utf8"); } catch { return ""; } },
      kelivo: (t, system) => post({}, { system, messages: [{ role: "user", content: t }] }),
      imessage: (t) => post({ "x-client": "imessage" }, { messages: [{ role: "user", content: t }] }),
      hb: () => fetch(base + "/hb", { method: "POST", headers: { "x-api-key": KEY } }),
      dbg: async () => (await fetch(base + "/debug")).json(),
    });
  } finally { try { proc.kill(); } catch {} }
}

test("【核心】Kelivo 带世界书之后,iMessage 不带 system 也不换窗口", async () => {
  await withShim({}, async ({ kelivo, imessage, spawns, argv }) => {
    await kelivo("在吗", "世界书:下雨天");
    assert.equal(spawns(), 1);
    assert.ok(argv().includes("世界书:下雨天"), "世界书进了进程");
    await imessage("我换到信息里了");
    await imessage("还在吗");
    assert.equal(spawns(), 1, "iMessage 两轮之后还是同一个进程 = 同一个窗口");
    assert.ok(argv().includes("世界书:下雨天"), "世界书没被空串顶掉");
    await kelivo("回来了", "世界书:下雨天");
    assert.equal(spawns(), 1, "切回 Kelivo 也不换");
  });
});

test("对照:Kelivo 自己改世界书照旧会重开(原有行为没被这次改动吞掉)", async () => {
  await withShim({}, async ({ kelivo, spawns }) => {
    await kelivo("在吗", "世界书A");
    await kelivo("在吗", "世界书B");
    assert.equal(spawns(), 2);
  });
});

test("她最后在 iMessage → 心跳推到 bridge 的 /push,带钥匙", async () => {
  const b = await fakeBridge(200);
  try {
    await withShim({ IMESSAGE_PUSH_URL: b.url }, async ({ imessage, hb, dbg, logs }) => {
      await imessage("我在信息里");
      assert.equal((await dbg()).imessage.lastClient, "imessage");
      await hb();
      assert.ok(await until(() => b.got.length > 0), "bridge 收到了心跳:\n" + logs());
      assert.equal(b.got[0].key, KEY);
      assert.ok(b.got[0].body.text, "带着他说的话");
      assert.match(logs(), /\[wake\] → iMessage/);
    });
  } finally { b.close(); }
});

test("心跳提示按实际去向说「信息」,不再说 Telegram", async () => {
  const b = await fakeBridge(200);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "shim-imsg-in-"));
  const inputOut = path.join(work, "in.txt");
  try {
    await withShim({ IMESSAGE_PUSH_URL: b.url, FAKE_INPUT_OUT: inputOut }, async ({ imessage, hb }) => {
      await imessage("我在信息里");
      await hb();
      assert.ok(await until(() => fs.existsSync(inputOut) && fs.readFileSync(inputOut, "utf8").includes("【系统·心跳】")));
      const wakeText = fs.readFileSync(inputOut, "utf8").split("\n\u0000\n").find((t) => t.includes("【系统·心跳】"));
      assert.match(wakeText, /「信息」/);
      assert.doesNotMatch(wakeText, /Telegram/);
    });
  } finally { b.close(); }
});

test("bridge 挂了(502)→ 不吞,记日志退到下一扇门", async () => {
  const b = await fakeBridge(502);
  try {
    await withShim({ IMESSAGE_PUSH_URL: b.url }, async ({ imessage, hb, logs }) => {
      await imessage("我在信息里");
      await hb();
      assert.ok(await until(() => /iMessage 没送到\(502\)/.test(logs())), logs());
    });
  } finally { b.close(); }
});

test("她回到 Kelivo 说话 → 心跳不再推 iMessage", async () => {
  const b = await fakeBridge(200);
  try {
    await withShim({ IMESSAGE_PUSH_URL: b.url }, async ({ imessage, kelivo, hb, dbg }) => {
      await imessage("我在信息里");
      await kelivo("我回 Kelivo 了");
      assert.equal((await dbg()).imessage.lastClient, "kelivo");
      await hb();
      await wait(800);
      assert.equal(b.got.length, 0);
    });
  } finally { b.close(); }
});

test("没配 IMESSAGE_PUSH_URL:iMessage 说话照样不推,/debug 如实报", async () => {
  await withShim({}, async ({ imessage, dbg }) => {
    await imessage("在吗");
    const d = await dbg();
    assert.deepEqual(d.imessage, { push: false, lastClient: "imessage" });
  });
});

test("GET /stickers/file:要钥匙;卷上有文件就给原图;路径跳不出贴纸目录;没有的名字 404", async () => {
  const sdir = fs.mkdtempSync(path.join(os.tmpdir(), "shim-stk-"));
  const webp = Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBPfake");
  fs.writeFileSync(path.join(sdir, "hug.webp"), webp);
  fs.writeFileSync(path.join(sdir, "reg.json"), JSON.stringify({
    "抱抱": { file: "hug.webp" }, "越狱": { file: "../../etc/passwd" }, "只有句柄": { file_id: "CAAC" },
  }));
  await withShim({ STICKER_REGISTRY: path.join(sdir, "reg.json"), STICKER_DIR: sdir }, async ({ base }) => {
    const get = (name, key = KEY) => fetch(`${base}/stickers/file?name=${encodeURIComponent(name)}`, { headers: { "x-api-key": key } });
    assert.equal((await get("抱抱", "wrong")).status, 401);
    const r = await get("抱抱");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "image/webp");
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), webp);
    assert.equal((await get("越狱")).status, 404, "basename 之后贴纸目录里没有 passwd");
    assert.equal((await get("只有句柄")).status, 404, "没配 TG 时拿不到 file_id 的图,老实 404");
    assert.equal((await get("不存在")).status, 404);
    const names = await (await fetch(`${base}/stickers`, { headers: { "x-api-key": KEY } })).json();
    assert.deepEqual(names.names.sort(), ["只有句柄", "抱抱", "越狱"].sort());
  });
});
