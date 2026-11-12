// events.js 纯逻辑 + POST /event 接线(真起 server.js,用假 claude)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeSource, eventPrompt, eventImages, nightNudgeDue, nightPrompt } from "../events.js";

// 北京时间 → 毫秒(测试里好读)
const bj = (s) => Date.parse(s + "+08:00");

test("来源白名单;提示词只给事实、末尾留「不打扰就沉默」", () => {
  assert.equal(normalizeSource(" Body "), "body");
  assert.equal(normalizeSource("hack"), null);
  const p = eventPrompt("body", "她刚醒了,昨晚睡了 6 小时 52 分。", { bjNow: "2026-11-13 07:40" });
  assert.match(p, /^【系统·身体】现在北京时间 2026-11-13 07:40。她刚醒了/);
  assert.match(p, /【沉默】/);
});

test("事件配图:最多 3 张,只认图片类型", () => {
  const ok = { media_type: "image/jpeg", data: "AAAA" };
  const r = eventImages([ok, { media_type: "text/html", data: "x" }, ok, ok, ok]);
  assert.equal(r.length, 3);
  assert.deepEqual(r[0], { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } });
  assert.deepEqual(eventImages(null), []);
});

test("熬夜提醒:1:30 以后、10 分钟内还在用手机、今晚没提过才提", () => {
  const act = (min) => ({ count: 3, lastApp: "小红书", minutesAgo: min });
  assert.equal(nightNudgeDue({ now: bj("2026-11-13T01:20:00"), activity: act(1) }).due, false, "还没到 1:30");
  const r = nightNudgeDue({ now: bj("2026-11-13T01:40:00"), activity: act(3) });
  assert.equal(r.due, true);
  assert.equal(r.night, "2026-11-12", "凌晨算前一晚");
  assert.equal(nightNudgeDue({ now: bj("2026-11-13T02:10:00"), activity: act(1), lastNight: r.night }).due, false, "一晚只一次");
  assert.equal(nightNudgeDue({ now: bj("2026-11-13T01:40:00"), activity: act(25) }).due, false, "25 分钟没动静 = 可能睡了");
  assert.equal(nightNudgeDue({ now: bj("2026-11-13T05:30:00"), activity: act(1) }).due, false, "五点以后不算熬夜了");
  assert.equal(nightNudgeDue({ now: bj("2026-11-13T23:50:00"), activity: act(1), after: "23:30" }).due, true, "窗口可以跨零点");
  assert.equal(nightNudgeDue({ now: bj("2026-11-13T01:40:00"), activity: { count: 0 } }).due, false);
});

test("熬夜那句带上她刚在用的 App,一晚只一次", () => {
  const p = nightPrompt({ lastApp: "小红书", minutesAgo: 3 }, { bjNow: "2026-11-13 01:40" });
  assert.match(p, /3 分钟前还在用小红书/);
  assert.match(p, /一晚只来一次/);
});

// ---- 接线 ----
const dir = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(dir, "..", "server.js");
const FAKE = path.join(dir, "..", "dev", "fake-claude.mjs");
const KEY = "test-key";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await wait(50); } return false; }

test("POST /event:要自己的钥匙;排一轮系统消息给他;他开口就推到她最后在的那扇门", async () => {
  const got = [];
  const tide = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)).on("end", () => { got.push(JSON.parse(b || "{}")); res.writeHead(200).end("{}"); }); });
  await new Promise((r) => tide.listen(0, "127.0.0.1", r));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "shim-ev-"));
  const inputOut = path.join(work, "in.txt");
  const port = 19701 + Math.floor(Math.random() * 90);
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn("node", [SERVER], { cwd: work, stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env, PORT: String(port), SHIM_KEY: KEY, CLAUDE_BIN: FAKE, FAKE_INPUT_OUT: inputOut, EVENT_TOKEN: "ev-tok",
    TG_BOT_TOKEN: "", BARK_KEY: "", ELEVENLABS_API_KEY: "", EARS_URL: "", IMESSAGE_PUSH_URL: "",
    INTERTIDAL_PUSH_URL: `http://127.0.0.1:${tide.address().port}/push`, TIME_STAMP: "0", COMPACT_HOOK: "0" } });
  let logs = ""; proc.stdout.on("data", (d) => (logs += d)); proc.stderr.on("data", (d) => (logs += d));
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/health")).ok) break; } catch {} await wait(100); }
    // 她先在 App 里说一句 → 主动的话会推回 App
    await fetch(base + "/v1/messages", { method: "POST", headers: { "x-api-key": KEY, "content-type": "application/json", "x-client": "intertidal" },
      body: JSON.stringify({ stream: false, messages: [{ role: "user", content: "在吗" }] }) }).then((r) => r.json());
    const post = (key, body) => fetch(base + "/event", { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post("wrong", { source: "body", text: "x" })).status, 401);
    assert.equal((await post(KEY, { source: "body", text: "x" })).status, 401, "SHIM_KEY 不能代替 EVENT_TOKEN");
    assert.equal((await post("ev-tok", { source: "nope", text: "x" })).status, 400);
    assert.equal((await post("ev-tok", { source: "body", text: "她刚醒了,昨晚睡了 6 小时。" })).status, 200);
    assert.ok(await until(() => fs.existsSync(inputOut) && fs.readFileSync(inputOut, "utf8").includes("【系统·身体】")), logs);
    assert.ok(await until(() => got.length > 0), "他开口了就推到 App:\n" + logs);
    assert.ok(got[0].text);
    const d = await (await fetch(base + "/debug")).json();
    assert.equal(d.events.on, true); assert.equal(d.events.count, 1);
  } finally { proc.kill(); tide.close(); }
});
