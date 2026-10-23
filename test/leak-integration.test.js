// 串戏拦截 + 降级提醒 · 接线测试(真把 server.js 跑起来,用假 claude 演 10-22/10-23 那两件事)
//
// 纯逻辑在 leak-guard.test.js 里打过了。这里测只有跑起来才看得见的:
//   1. 他编的那截真的没出现在返回给前端的正文里(result 分支确实截了);
//   2. 流式出口(Kelivo)一个泄漏的字都没吐出去 —— 标记被切在两个 delta 之间也一样;
//   3. 降级被记下来了,而且一个窗口只记一次;
//   4. LEAK_GUARD=0 是彻底的空操作。

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
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "shim-leak-"));
  const port = 19901 + Math.floor(Math.random() * 200);
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn("node", [SERVER], {
    cwd: work,
    env: {
      ...process.env,
      PORT: String(port), SHIM_KEY: KEY,
      CLAUDE_BIN: FAKE, BRAIN_MODEL: "claude-opus-5-5[1m]",
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
    const post = (t, stream) => fetch(base + "/messages", {
      method: "POST",
      headers: { "x-api-key": KEY, "content-type": "application/json" },
      body: JSON.stringify({ stream, messages: [{ role: "user", content: t }] }),
    });
    await fn({
      base,
      say: async (t) => (await post(t, false)).json(),
      sayStream: async (t) => (await post(t, true)).text(),
      dbg: async () => (await fetch(base + "/debug")).json(),
    });
  } finally { try { proc.kill(); } catch {} }
}

const textOf = (r) => (r.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
// 把 SSE 里所有 text_delta 拼回来 = 前端实际看到的字
const streamedText = (sse) => sse.split("\n")
  .filter((l) => l.startsWith("data: "))
  .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
  .filter((j) => j?.delta?.type === "text_delta")
  .map((j) => j.delta.text).join("");

test("非流式:他编的那截被截掉,前面的话一个字不少", async () => {
  await withShim({}, async ({ say, dbg }) => {
    const t = textOf(await say("LEAK_NOW"));
    assert.equal(t, "那我更得谢你。");
    const d = await dbg();
    assert.equal(d.leakGuard.count, 1);
    assert.ok(d.leakGuard.lastAt);
  });
});

test("流式(Kelivo):标记切在两个 delta 之间,也一个泄漏的字都没吐出去", async () => {
  await withShim({}, async ({ sayStream }) => {
    const shown = streamedText(await sayStream("LEAK_NOW"));
    assert.equal(shown, "那我更得谢你。");
    assert.ok(!shown.includes("user") && !shown.includes("total_tokens"));
  });
});

test("正常回复不受影响(流式与非流式都原样)", async () => {
  await withShim({}, async ({ say, sayStream, dbg }) => {
    assert.equal(textOf(await say("在吗")), "嗯,在听");
    assert.equal(streamedText(await sayStream("在吗")), "嗯,在听");
    assert.equal((await dbg()).leakGuard.count, 0);
  });
});

test("降级被记下来了,一个窗口只记一次", async () => {
  await withShim({}, async ({ say, dbg }) => {
    assert.equal((await dbg()).modelFallback, null);
    await say("FALLBACK_NOW");
    const first = (await dbg()).modelFallback;
    assert.ok(first, "降级没被发现");
    assert.equal(first.to, "claude-opus-4-8");
    assert.equal(first.via, "model_refusal_fallback");
    await say("FALLBACK_NOW");
    assert.deepEqual((await dbg()).modelFallback, first, "同一个窗口不许重复记");
  });
});

test("LEAK_GUARD=0 是彻底的空操作(想关随时能关)", async () => {
  await withShim({ LEAK_GUARD: "0" }, async ({ say, dbg }) => {
    assert.ok(textOf(await say("LEAK_NOW")).includes("total_tokens"));
    assert.equal((await dbg()).leakGuard.on, false);
    assert.equal((await dbg()).leakGuard.count, 0);
  });
});
