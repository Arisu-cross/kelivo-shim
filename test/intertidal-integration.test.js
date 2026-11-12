// Intertidal App 那扇门(后端是 ob-backup/tide)· 接线测试(真把 server.js 跑起来,用假 claude)
//
// 和 iMessage 那扇门同一套规矩,钉住:
//   1. 【核心】App 的请求不带 system,**不许**因此换窗口;/health 报出认识这扇门(tide 靠它决定敢不敢转发);
//   2. 她最后在 App 说话 → 心跳先推 tide 的 /push;tide 说 App 不在线(503)→ 退回下一扇门;
//   3. App 里换模型 / 思考深度(POST /brain):模型她下一句起生效(换窗),深度下次起进程生效;额度从 rate_limit_event 来。

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

async function fakeTide(status = 200) {
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
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "shim-tide-"));
  const argvOut = path.join(work, "argv.json");
  const port = 19801 + Math.floor(Math.random() * 90);
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn("node", [SERVER], {
    cwd: work,
    env: {
      ...process.env,
      PORT: String(port), SHIM_KEY: KEY, CLAUDE_BIN: FAKE, FAKE_ARGV_OUT: argvOut,
      TG_BOT_TOKEN: "", BARK_KEY: "", ELEVENLABS_API_KEY: "", EARS_URL: "", IMESSAGE_PUSH_URL: "",
      TIME_STAMP: "0", COMPACT_HOOK: "0", BRAIN_MODEL: "claude-opus-5-5", BRAIN_MODELS: "claude-opus-5-5,claude-opus-4-6",
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
  const brain = (body) => fetch(base + "/brain", {
    method: body ? "POST" : "GET", headers: { "x-api-key": KEY, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/health")).ok) break; } catch {} await wait(100); }
    await fn({
      base, logs: () => logs, brain,
      spawns: () => (logs.match(/\[claude\] spawned/g) || []).length,
      argv: () => { try { return JSON.parse(fs.readFileSync(argvOut, "utf8")); } catch { return []; } },
      kelivo: (t, system, model) => post({}, { system, model, messages: [{ role: "user", content: t }] }),
      app: (t) => post({ "x-client": "intertidal" }, { messages: [{ role: "user", content: t }] }),
      hb: () => fetch(base + "/hb", { method: "POST", headers: { "x-api-key": KEY } }),
      dbg: async () => (await fetch(base + "/debug")).json(),
      health: async () => (await fetch(base + "/health")).json(),
    });
  } finally { try { proc.kill(); } catch {} }
}
const flag = (argv, name) => argv[argv.indexOf(name) + 1];

test("【核心】Kelivo 带世界书之后,App 不带 system 也不换窗口;/health 报出认识这扇门", async () => {
  await withShim({}, async ({ kelivo, app, spawns, argv, health, dbg }) => {
    assert.ok((await health()).doors.includes("intertidal"), "tide 靠这个决定敢不敢转发");
    await kelivo("在吗", "世界书:下雨天");
    assert.equal(spawns(), 1);
    const r = await app("我在 App 里");
    assert.ok(r.content[0].text, "App 那边拿到了回话");
    await app("还在吗");
    assert.equal(spawns(), 1, "App 两轮之后还是同一个窗口");
    assert.ok(argv().join(" ").includes("世界书:下雨天"));
    assert.equal((await dbg()).imessage.lastClient, "intertidal");
  });
});

test("她最后在 App → 心跳推 tide 的 /push;提示里说的是 App", async () => {
  const t = await fakeTide(200);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "shim-tide-in-"));
  const inputOut = path.join(work, "in.txt");
  try {
    await withShim({ INTERTIDAL_PUSH_URL: t.url, FAKE_INPUT_OUT: inputOut }, async ({ app, hb, logs, dbg }) => {
      assert.equal((await dbg()).intertidal.push, true);
      await app("我在 App 里");
      await hb();
      assert.ok(await until(() => t.got.length > 0), "tide 收到了心跳:\n" + logs());
      assert.equal(t.got[0].key, KEY);
      assert.match(logs(), /\[wake\] → Intertidal/);
      const wakeText = fs.readFileSync(inputOut, "utf8").split("\n\u0000\n").find((x) => x.includes("【系统·心跳】"));
      assert.match(wakeText, /App\(Neris\)/);
    });
  } finally { t.close(); }
});

test("App 不在线(tide 回 503)→ 不吞,退到下一扇门", async () => {
  const t = await fakeTide(503);
  try {
    await withShim({ INTERTIDAL_PUSH_URL: t.url }, async ({ app, hb, logs }) => {
      await app("我在 App 里");
      await hb();
      assert.ok(await until(() => /Intertidal 没送到\(503\)/.test(logs())), logs());
    });
  } finally { t.close(); }
});

test("App 里换模型:她下一句起换窗生效;思考深度下次起进程生效;Kelivo 明说的模型会被记住、不来回拽", async () => {
  await withShim({}, async ({ app, kelivo, brain, spawns, argv, logs }) => {
    await app("在吗");
    assert.equal(flag(argv(), "--model"), "claude-opus-5-5");
    let b = await brain();
    assert.equal(b.model, "claude-opus-5-5"); assert.equal(b.pendingModel, null);
    assert.ok(b.efforts.includes("high"));
    assert.equal((await brain({ model: "没有这个" })).ok, false);
    await brain({ model: "claude-opus-4-6", effort: "high" });
    b = await brain();
    assert.equal(b.pendingModel, "claude-opus-4-6");
    assert.equal(spawns(), 1, "光改设置不重启");
    await app("换了吗");
    assert.equal(spawns(), 2, "她下一句起换窗");
    assert.ok(await until(() => flag(argv(), "--model") === "claude-opus-4-6"), logs());
    assert.ok(!/\[claude\] exited/.test(logs()), "旧窗口退出不许被当成新窗口挂了:\n" + logs());
    assert.equal(flag(argv(), "--model"), "claude-opus-4-6");
    assert.equal(flag(argv(), "--effort"), "high");
    b = await brain();
    assert.equal(b.model, "claude-opus-4-6"); assert.equal(b.pendingModel, null); assert.equal(b.effortApplied, "high");
    // Kelivo 选了 5.5 说一句(Kelivo 每句都报它菜单里选的模型)→ 换回 5.5,之后 App 的话不会再把它拽回 4.6
    await kelivo("我在 Kelivo", "", "claude-opus-5-5");
    assert.ok(await until(() => flag(argv(), "--model") === "claude-opus-5-5"));
    const n = spawns();
    await app("App 里再说一句");
    await wait(1800);                                   // 旧代码在这 1.5 秒后会多起一个进程
    assert.equal(spawns(), n, "没有来回换窗、也没有多起进程");
  });
});

test("额度:CLI 的 rate_limit_event 进 GET /brain;要钥匙", async () => {
  await withShim({}, async ({ app, brain, base }) => {
    await app("RATE_NOW 在吗");
    const b = await brain();
    assert.equal(b.rateLimits.five_hour.utilization, 0.42);
    assert.ok(b.rateLimitsAt > 0);
    assert.equal((await fetch(base + "/brain")).status, 401);
  });
});
