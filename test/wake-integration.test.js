// 自主时间 · 接线测试(真把 server.js 跑起来,用假的 claude 演)
//
// 纯逻辑测试只能证明提示词长得对,证明不了这套东西真的接上了:
// 宽版到底有没有被喂进去、他在自主时间里做的事有没有被记下、
// 「做了事的那一轮」会不会被闸门当成空轮放过去(那就等于压缩能把他做的事抹掉)。
// 手册 §10 记着 2026-07-25 那次「漏改函数签名默认值,新逻辑成了死代码、表面一切正常」——
// 这类事只有真跑起来才抓得到。

import { test, before, after } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(dir, "..", "server.js");
const FAKE = path.join(dir, "..", "dev", "fake-claude.mjs");
const KEY = "test-key";
let proc, base, logs = "";

const j = async (p, opt = {}) => {
  const r = await fetch(base + p, { headers: { "x-api-key": KEY, "content-type": "application/json" }, ...opt });
  return r.json();
};
const dbg = () => j("/debug");
const hb = (q = "") => j("/hb?key=" + KEY + q, { method: "POST", body: "{}" });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  const port = 19787 + Math.floor(Math.random() * 500);
  base = `http://127.0.0.1:${port}`;
  proc = spawn("node", [SERVER], {
    env: {
      ...process.env,
      PORT: String(port), SHIM_KEY: KEY, CLAUDE_BIN: FAKE,
      TG_BOT_TOKEN: "", BARK_KEY: "", ELEVENLABS_API_KEY: "", EARS_URL: "",
      TIME_STAMP: "0", WINDOW_LIMIT: "100000", COMPACT_HOOK: "0",
      ALLOWED_TOOLS: "WebSearch,WebFetch,mcp__ombre,mcp__fish,mcp__galatea",
      FAKE_WAKE_TOOL: "mcp__fish__fish",   // 演成他去钓鱼了
      WAKE_FREE_EVERY: "3", FAKE_ECHO: "1", // 回显真正喂进去的那段文字

    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // 假 claude 收到的注入文本会随 shim 日志出来吗?不会 —— 所以改看 shim 自己的
  // [wake] light/free 与 [wake] did: 两行,它们就是这套逻辑的可观测面。
  proc.stdout.on("data", (c) => { logs += c.toString(); });
  proc.stderr.on("data", (c) => { logs += c.toString(); });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + "/health"); if (r.ok) return; } catch {}
    await wait(100);
  }
  throw new Error("shim 没起来");
});

after(() => { try { proc.kill(); } catch {} });

test("/debug 报得出这一档的状态,活动清单按 ALLOWED 推导", async () => {
  const f = (await dbg()).wake.free;
  assert.equal(f.enabled, true);
  assert.equal(f.every, 3);
  assert.ok(f.activities.some((x) => x.includes("钓鱼")));
  assert.ok(f.activities.some((x) => x.includes("社交圈")));
  assert.ok(!f.activities.some((x) => x.includes("浏览器")), "没给 mcp__browser 就不该提浏览器");
  assert.equal(f.lastActedAt, null);
});

test("第一次唤醒就是宽版(开窗后不用等三轮才知道自己能做事)", async () => {
  logs = "";
  await hb();
  await wait(400);
  assert.ok(logs.includes("[wake] free"), "第一轮应是宽版\n" + logs);
  assert.ok((await dbg()).wake.free.lastFreeAt, "lastFreeAt 该被记下");
});

test("接下来两轮是轻量版,载荷与旧版一致 —— 静默续命不为这个功能变贵", async () => {
  logs = "";
  await hb(); await wait(300);
  await hb(); await wait(300);
  assert.equal(logs.match(/\[wake\] light/g)?.length, 2, logs);
  assert.ok(!logs.includes("[wake] free"), logs);
  const recv = logs.split("\n").filter((l) => l.includes("[fake] recv:")).pop() || "";
  assert.ok(!recv.includes("想做点自己的事"), "轻量轮不该夹带菜单:" + recv);
  assert.ok(recv.includes("没什么想说的就只回【沉默】两个字"), "轻量轮该与旧版一字不差:" + recv);
});

test("到第 4 轮又轮到宽版(每 3 次一回)", async () => {
  logs = "";
  await hb(); await wait(300);
  assert.ok(logs.includes("[wake] free"), logs);
});

test("free=1 可以强制要一轮宽版(排查/演示用)", async () => {
  logs = "";
  const r = await hb("&free=1");
  assert.equal(r.free, true);
  await wait(300);
  assert.ok(logs.includes("[wake] free"), logs);
});

test("【核心】他在自主时间里做了事 → 记下工具名,且不算空轮(压缩要被拦下)", async () => {
  logs = "";
  await hb(); await wait(400);
  const d = await dbg();
  assert.deepEqual(d.wake.free.lastTools, ["mcp__fish__fish"], "该记下他用了钓鱼工具");
  assert.ok(d.wake.free.lastActedAt, "该记下他动手的时刻");
  assert.equal(d.gate.dirty, true, "做了事的那一轮不是空轮,闸门必须拦压缩,否则他做的事会被压没");
  assert.ok(logs.includes("[wake] did: mcp__fish__fish"), logs);
});

test("闸门端点与 /debug 读的是同一份状态(真会拦下压缩)", async () => {
  const g = await j("/precompact-gate", { method: "POST", body: "{}" });
  assert.equal(g.block, true);
});

// 放在最后:强制宽版会推进唤醒计数,别打乱上面几条对轮次节奏的断言。
test("【载荷】宽版真的把三个选项和活动清单喂了进去,不是只走了分支", async () => {
  await wait(600);  // 等上一条测试拦下压缩后排的那轮归档走完,别把它的载荷混进来
  logs = "";
  await hb("&free=1"); await wait(400);
  const recvs = logs.split("\n").filter((l) => l.includes("[fake] recv:"));
  const recv = recvs.find((l) => l.includes("【系统·自主时间】")) || "";
  assert.ok(recv, "这一轮该有一条署名【系统·自主时间】的注入(不伪装成她说的话):" + recvs.join("|"));
  assert.ok(recv.includes("想做点自己的事"), "宽版该真的给出「做事」这个选项:" + recv);
  assert.ok(recv.includes("去钓鱼"), "活动清单该真的进到文本里:" + recv);
  assert.ok(recv.includes("【沉默】"), "沉默必须仍然是可选项:" + recv);
  assert.ok(recv.includes("没有哪个更「应该」"), "三个选项必须平权,不能变成撺掇他干活:" + recv);
});

test("只记工具名,不记参数也不记返回", async () => {
  const s = JSON.stringify((await dbg()).wake.free);
  assert.ok(s.includes("mcp__fish__fish"));
  assert.ok(!s.includes("command"), "不该把工具参数漏进 /debug:" + s);
});
