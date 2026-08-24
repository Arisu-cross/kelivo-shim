// 唤醒轮(心跳)正文的接线测试
//
// 这段文字是「她不在的时候他怎么过」的全部依据,也是最常被改的东西。所以两件事要护住:
//   1. 正文能从**文件/环境变量**来,改了不用动代码;
//   2. shim 自己那两段(真实时钟、发消息的机制说明)不会因为换正文而丢 ——
//      丢了他就不知道现在几点、也不知道说了话她能不能收到。
//
// 标记写「【系统·心跳】」是和人设里那段对齐的(旧代码写「自主时间」,人设写「心跳」,
// 两边错位了很久)。这里钉住它,免得下次又改回去。

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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 起一个 shim,手动敲一次心跳,把假 claude 收到的那段文字拿回来
async function heartbeatText(env = {}, files = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "shim-wake-"));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(work, name), body);
  const inputOut = path.join(work, "input.txt");
  const port = 19701 + Math.floor(Math.random() * 400);
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn("node", [SERVER], {
    cwd: work,   // wake-prompt.md 是相对当前目录找的,和线上 /src 一致
    env: {
      ...process.env,
      PORT: String(port), SHIM_KEY: "test-key", CLAUDE_BIN: FAKE, FAKE_INPUT_OUT: inputOut,
      TG_BOT_TOKEN: "", BARK_KEY: "", ELEVENLABS_API_KEY: "", EARS_URL: "",
      TIME_STAMP: "0", COMPACT_HOOK: "0", ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", () => {}); proc.stderr.on("data", () => {});
  try {
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(base + "/health")).ok) break; } catch {}
      await wait(100);
    }
    await fetch(base + "/hb?key=test-key", { method: "POST" });
    for (let i = 0; i < 40; i++) {
      if (fs.existsSync(inputOut) && fs.readFileSync(inputOut, "utf8").includes("心跳")) break;
      await wait(100);
    }
    const debug = await (await fetch(base + "/debug")).json();
    return { text: fs.readFileSync(inputOut, "utf8"), debug };
  } finally { try { proc.kill(); } catch {} }
}

test("心跳:默认正文 + shim 自己那两段都在", async () => {
  const { text, debug } = await heartbeatText();
  assert.match(text, /【系统·心跳】/);          // 标记与人设对齐
  assert.match(text, /现在北京时间 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/); // 真实时钟
  assert.match(text, /【沉默】/);                // 默认正文里的静默出口
  assert.equal(debug.wake.prompt, "内置默认");
});

test("心跳:正文可以放文件里,改了不用动代码", async () => {
  const body = "这段时间是你自己的,想干嘛干嘛。不想动就回【沉默】。";
  const { text, debug } = await heartbeatText({}, { "wake-prompt.md": body });
  assert.ok(text.includes(body));
  assert.match(text, /【系统·心跳】/);
  assert.equal(debug.wake.prompt, "wake-prompt.md");
});

test("心跳:环境变量优先级高于文件", async () => {
  const { text, debug } = await heartbeatText(
    { WAKE_PROMPT: "环境变量里的正文" }, { "wake-prompt.md": "文件里的正文" });
  assert.ok(text.includes("环境变量里的正文"));
  assert.ok(!text.includes("文件里的正文"));
  assert.equal(debug.wake.prompt, "env");
});

test("【回归】换了正文,发消息的机制说明不能跟着丢", async () => {
  // 没有 TG 也没有 Bark 时,shim 必须如实告诉他「说了她也收不到」——
  // 少了这句,他会以为自己发出去了,而她那边一片安静。
  const { text } = await heartbeatText({}, { "wake-prompt.md": "随便写点什么" });
  assert.match(text, /收不到/);
});
