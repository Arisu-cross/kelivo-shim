// /aw(健康数据中转)· 默认关 + 不回落主 key
//
// 这个接口原来有两个口子,2026-09-05 一起堵上:
//   ① 没设 AW_KEY 时,钥匙**回落成 SHIM_KEY** —— 而这条网址是要写进 AI 的提示词、
//      贴进手机快捷指令的。小功能泄一把钥匙,不该等于把整个 shim 送出去。
//   ② 判定写的是 `!AW_KEY || k === AW_KEY`,也就是「没配钥匙就放行」——
//      一个公网可读的健康数据接口。
// 现在照 /report 的范式:钥匙即开关,不设 = 整套关闭(503)。

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
const KEY = "test-shim-key";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function withShim(env, fn) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "shim-aw-"));
  const port = 19901 + Math.floor(Math.random() * 200);
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn("node", [SERVER], {
    cwd: work,
    env: {
      ...process.env,
      PORT: String(port), SHIM_KEY: KEY, CLAUDE_BIN: FAKE,
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
    await fn({ base, dbg: async () => (await fetch(base + "/debug")).json() });
  } finally { try { proc.kill(); } catch {} }
}

const push = (base, key) => fetch(`${base}/aw${key ? `?key=${key}` : ""}`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ hr: "72" }),
});

test("没设 AW_KEY:整套关闭,读写都是 503(不是「谁都能读」)", async () => {
  await withShim({}, async ({ base, dbg }) => {
    assert.equal((await fetch(`${base}/aw`)).status, 503);
    assert.equal((await push(base)).status, 503);
    assert.equal((await dbg()).aw.on, false);
  });
});

test("【核心回归】没设 AW_KEY 时,SHIM_KEY 也打不开它", async () => {
  await withShim({}, async ({ base }) => {
    // 改之前:AW_KEY 回落成 SHIM_KEY,这一行会拿到 200 —— 等于主 key 就是这个口子的钥匙
    assert.equal((await fetch(`${base}/aw?key=${KEY}`)).status, 503);
  });
});

test("设了 AW_KEY:自己的钥匙能读能写,别的钥匙一律 401", async () => {
  await withShim({ AW_KEY: "aw-only-key" }, async ({ base, dbg }) => {
    assert.equal((await push(base, "aw-only-key")).status, 200);
    const got = await (await fetch(`${base}/aw?key=aw-only-key`)).json();
    assert.equal(got.count, 1);
    assert.equal(got.entries[0].data.hr, "72");

    assert.equal((await fetch(`${base}/aw?key=wrong`)).status, 401);
    assert.equal((await fetch(`${base}/aw`)).status, 401);
    // 开着的时候,主 key 也不该能开这个口子 —— 两把钥匙是分开的
    assert.equal((await fetch(`${base}/aw?key=${KEY}`)).status, 401);
    assert.equal((await dbg()).aw.on, true);
  });
});

test("裸奔的 /debug 不许泄露健康数据本身(只报开关和条数)", async () => {
  await withShim({ AW_KEY: "aw-only-key" }, async ({ base, dbg }) => {
    await push(base, "aw-only-key");
    const d = await dbg();
    assert.deepEqual(d.aw, { on: true, count: 1 });
    assert.doesNotMatch(JSON.stringify(d), /aw-only-key/);  // 钥匙不许回显
    assert.doesNotMatch(JSON.stringify(d), /"hr"/);          // 数据不许出现
  });
});
