// 心跳频率:白天勤一点、夜里稀一点
//
// 2026-08-30 起阈值分昼夜(默认白天 30 / 夜里 55 分钟,白天 = 北京时间 [07:00, 24:00))。
// 这里钉住三件容易被下一次改动碰坏的事:
//   1. 默认值就是 30 / 55,而且真的会随时段换档(靠 WAKE_DAY_* 把「现在」判成白天或夜里);
//   2. 夜里那档 < 60 分钟 —— 越过提示词缓存 TTL 就要全价重写缓存,比多跑一轮还贵;
//   3. 老变量 WAKE_IDLE_MIN 设了仍然一路压过昼夜两档(回滚到旧行为的口子)。

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

// 起一个 shim,只把 /debug 里的 wake 段拿回来
async function wakeDebug(env = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "shim-idle-"));
  const port = 19301 + Math.floor(Math.random() * 400);
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn("node", [SERVER], {
    cwd: work,
    env: {
      ...process.env,
      PORT: String(port), SHIM_KEY: "test-key", CLAUDE_BIN: FAKE,
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
    return (await (await fetch(base + "/debug")).json()).wake;
  } finally { try { proc.kill(); } catch {} }
}

// 把「现在」强行判成白天/夜里:整天都算白天 = 0-24,整天都算夜 = 空窗口 0-0。
const ALL_DAY = { WAKE_DAY_START: "0", WAKE_DAY_END: "24" };
const ALL_NIGHT = { WAKE_DAY_START: "0", WAKE_DAY_END: "0" };

test("白天:默认 30 分钟一轮", async () => {
  const w = await wakeDebug(ALL_DAY);
  assert.equal(w.day, true);
  assert.equal(w.idleMin, 30);
});

test("夜里:默认 55 分钟一轮,且必须留在缓存 TTL(60min)以内", async () => {
  const w = await wakeDebug(ALL_NIGHT);
  assert.equal(w.day, false);
  assert.equal(w.idleMin, 55);
  // 阈值 + 一次轮询的粒度 = 最坏情况的真实间隔,不能碰到 60
  assert.ok(w.idleMin + w.checkMin <= 60, `夜里最坏间隔 ${w.idleMin + w.checkMin} 分钟,越过了缓存 TTL`);
});

test("两档都可以用环境变量单独调", async () => {
  const w = await wakeDebug({ ...ALL_DAY, WAKE_IDLE_MIN_DAY: "20", WAKE_IDLE_MIN_NIGHT: "45" });
  assert.equal(w.idleMin, 20);
  assert.equal(w.idleMinNight, 45);
});

test("老变量 WAKE_IDLE_MIN 设了就压过昼夜两档(退回旧行为的口子)", async () => {
  for (const when of [ALL_DAY, ALL_NIGHT]) {
    const w = await wakeDebug({ ...when, WAKE_IDLE_MIN: "50" });
    assert.equal(w.idleMin, 50);
    assert.equal(w.idleMinFixed, 50);
  }
});

test("白天窗口可以跨零点(如 22 点到次日 7 点)", async () => {
  // 22-7 这种反向区间必须仍然把「窗口内」判成 true;这里用一个必定包含此刻的反向窗口
  const h = new Date(Date.now() + 8 * 3600e3).getUTCHours();
  const w = await wakeDebug({ WAKE_DAY_START: String(h), WAKE_DAY_END: String((h + 23) % 24) });
  assert.equal(w.day, true, `反向窗口 ${h}-${(h + 23) % 24} 应包含北京时间 ${h} 点`);
});
