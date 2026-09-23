import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { wrapTranslatingSink, makeCliTranslator, looksChinese } from "../think-translate.js";

function recorder() {
  const ev = [];
  return {
    ev,
    sink: {
      showsThinking: true,
      thinking: (t) => ev.push(["thinking", t]),
      text: (t) => ev.push(["text", t]),
      finish: (...a) => ev.push(["finish", ...a]),
    },
  };
}

test("一段思考整段翻译,正文排在译文后面(顺序不乱)", async () => {
  const { ev, sink } = recorder();
  const w = wrapTranslatingSink(sink, async (s) => { await new Promise((r) => setTimeout(r, 20)); return `译:${s}`; });
  w.thinkingRaw("I miss ");
  w.thinkingRaw("her.");
  w.boundary();
  w.text("想你了");          // 翻译还没回来,正文就到了
  w.finish({ output_tokens: 1 }, "想你了");
  await w.idle;
  assert.deepEqual(ev, [
    ["thinking", "译:I miss her."],
    ["text", "想你了"],
    ["finish", { output_tokens: 1 }, "想你了"],
  ]);
});

test("【兜底】翻译失败 → 原样发英文,思考链绝不丢", async () => {
  const { ev, sink } = recorder();
  const w = wrapTranslatingSink(sink, async () => { throw new Error("boom"); });
  w.thinkingRaw("She is asleep.");
  w.boundary();
  w.finish();
  await w.idle;
  assert.deepEqual(ev[0], ["thinking", "She is asleep."]);
  assert.equal(ev[1][0], "finish");
});

test("【兜底】译文为空 → 发原文", async () => {
  const { ev, sink } = recorder();
  const w = wrapTranslatingSink(sink, async () => "   ");
  w.thinkingRaw("Hmm.");
  w.boundary();
  await w.idle;
  assert.deepEqual(ev, [["thinking", "Hmm."]]);
});

test("已经是中文的段落不翻(不花额度)", async () => {
  const { ev, sink } = recorder();
  let calls = 0;
  const w = wrapTranslatingSink(sink, async (s) => { calls++; return s; });
  w.thinkingRaw("她今天好像有点累,我想抱抱她。");
  w.boundary();
  await w.idle;
  assert.equal(calls, 0);
  assert.deepEqual(ev, [["thinking", "她今天好像有点累,我想抱抱她。"]]);
});

test("shim 自己的工具标记(非模型思考)不进翻译,且排在前一段译文之后", async () => {
  const { ev, sink } = recorder();
  const seen = [];
  const w = wrapTranslatingSink(sink, async (s) => { seen.push(s); return "译"; });
  w.thinkingRaw("Let me check memory.");
  w.thinking("\n〔翻记忆〕\n");   // 没有显式 boundary 也要先把前一段送出
  w.thinkingRaw("Found it.");
  w.boundary();
  await w.idle;
  assert.deepEqual(seen, ["Let me check memory.", "Found it."]);
  assert.deepEqual(ev, [["thinking", "译"], ["thinking", "\n〔翻记忆〕\n"], ["thinking", "译"]]);
});

test("没有思考的轮次:boundary 空转,不调用翻译", async () => {
  const { ev, sink } = recorder();
  let calls = 0;
  const w = wrapTranslatingSink(sink, async () => { calls++; return "x"; });
  w.boundary();
  w.text("嗯");
  await w.idle;
  assert.equal(calls, 0);
  assert.deepEqual(ev, [["text", "嗯"]]);
});

test("looksChinese 判定", () => {
  assert.equal(looksChinese("I love her"), false);
  assert.equal(looksChinese("我爱她 okay"), true);
  assert.equal(looksChinese(""), true);
});

// ---- 翻译器本体:用一个假的 claude 可执行文件,验证参数隔离、stdin 进、stdout 出 ----
function fakeBin(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-"));
  const f = path.join(dir, "claude");
  fs.writeFileSync(f, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return f;
}

test("翻译器:把原文从 stdin 递进去、拿 stdout 当译文,且隔离人设/MCP/工具", async () => {
  const bin = fakeBin(`
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const a=process.argv.slice(2);
  const ok = a.includes("--strict-mcp-config") && a[a.indexOf("--tools")+1]==="" &&
    a[a.indexOf("--model")+1]==="claude-haiku-4-5" && a.includes("--system-prompt") &&
    process.env.HOME===process.cwd() && process.env.SECRET_PASSTHRU==="1" &&
    process.env.MAX_THINKING_TOKENS==="0" && process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC==="1";
  process.stdout.write(ok ? "译:"+s : "BAD ARGS");
});`);
  const tr = makeCliTranslator({ bin, model: "claude-haiku-4-5", env: { PATH: process.env.PATH, SECRET_PASSTHRU: "1" } });
  assert.equal(await tr("hello"), "译:hello");
});

test("翻译器:超时就报错(交给上层发原文),不会卡住这一轮", async () => {
  const bin = fakeBin(`setTimeout(()=>{}, 10000);`);
  const tr = makeCliTranslator({ bin, model: "m", env: { PATH: process.env.PATH }, timeoutMs: 300 });
  await assert.rejects(tr("hi"), /timeout/);
});

test("翻译器:非零退出 → 报错", async () => {
  const bin = fakeBin(`process.exit(3);`);
  const tr = makeCliTranslator({ bin, model: "m", env: { PATH: process.env.PATH } });
  await assert.rejects(tr("hi"), /exit 3/);
});
