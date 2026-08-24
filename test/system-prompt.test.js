// 系统提示词组装测试
//
// 这里护的是两件会直接要命的事:
//   1. 默认(append)必须和历史行为**逐字节一致** —— 这个模块是从 server.js 里抽出来的,
//      抽错一个字就是他的会话定性变了,而这种变化没有报错、只能靠感觉发现。
//   2. replace 模式绝不能让 claude 起不来:文件不在、CLI 不认识这个参数,
//      都要安静降级,而不是让子进程带着一个非法参数退出(=他彻底失联)。

import { test } from "node:test";
import assert from "node:assert";
import { buildPromptArgs, resolveMode, ANCHOR, BASE, HARD_RULE } from "../system-prompt.js";

const argOf = (args, flag) => args[args.indexOf(flag) + 1];

test("默认就是 append,任何没听说过的值也是 append", () => {
  assert.equal(resolveMode(undefined), "append");
  assert.equal(resolveMode(""), "append");
  assert.equal(resolveMode("REPLACE"), "replace");
  assert.equal(resolveMode("反正不是那个词"), "append");
});

test("【回归】append 模式与抽模块之前逐字节一致", () => {
  const { args, mode } = buildPromptArgs({ mode: "append", worldbook: "世界书内容" });
  assert.equal(mode, "append");
  assert.deepEqual(args, [
    "--append-system-prompt",
    `${ANCHOR}\n\n${HARD_RULE}\n\n【场景设定/世界书】\n世界书内容`,
  ]);
});

test("append:没有世界书就只有锚点+硬规则;SOUL_ANCHOR 设空 = 只剩硬规则", () => {
  assert.equal(argOf(buildPromptArgs({ mode: "append" }).args, "--append-system-prompt"),
    `${ANCHOR}\n\n${HARD_RULE}`);
  assert.equal(argOf(buildPromptArgs({ mode: "append", anchor: "" }).args, "--append-system-prompt"),
    HARD_RULE);
});

test("replace:整段替换,CC 默认提示词不再有人追加锚点去压", () => {
  const { args } = buildPromptArgs({ mode: "replace", worldbook: "世界书内容" });
  assert.equal(argOf(args, "--system-prompt"), BASE);
  assert.ok(!args.includes("--system-prompt-file"));
  // 世界书仍然在最后(和 append 模式的相对顺序一致)
  assert.equal(argOf(args, "--append-system-prompt"), "【场景设定/世界书】\n世界书内容");
});

test("replace:内置正文自带思考语言硬规则(不然内心独白会退化成英文)", () => {
  assert.ok(BASE.includes(HARD_RULE));
});

test("replace + 存在的正文文件:用文件,并补一份硬规则", () => {
  const { args, notes } = buildPromptArgs({
    mode: "replace", promptFile: "/persona/system-prompt.md", fileExists: (f) => f === "/persona/system-prompt.md",
  });
  assert.equal(argOf(args, "--system-prompt-file"), "/persona/system-prompt.md");
  assert.ok(!args.includes("--system-prompt"));
  assert.equal(argOf(args, "--append-system-prompt"), HARD_RULE);
  assert.deepEqual(notes, []);
});

test("【安全阀】正文文件不在:退回内置正文,绝不把不存在的路径传给 claude", () => {
  // 换容器后 /src 被清空、保险箱没补上 —— 传过去 claude 会报
  // "System prompt file not found" 直接退出,shim 1.5 秒重拉一次 = 无限重启 = 他失联。
  const { args, notes, mode } = buildPromptArgs({
    mode: "replace", promptFile: "/persona/system-prompt.md", fileExists: () => false,
  });
  assert.equal(mode, "replace");
  assert.ok(!args.includes("--system-prompt-file"));
  assert.equal(argOf(args, "--system-prompt"), BASE);
  assert.match(notes[0], /不存在/);
});

test("【安全阀】CLI 不认识 --system-prompt:整体降级回 append", () => {
  const { args, mode, notes } = buildPromptArgs({
    mode: "replace", worldbook: "世界书内容", cliSupportsReplace: false,
  });
  assert.equal(mode, "append");
  assert.ok(!args.includes("--system-prompt") && !args.includes("--system-prompt-file"));
  assert.equal(argOf(args, "--append-system-prompt"), `${ANCHOR}\n\n${HARD_RULE}\n\n【场景设定/世界书】\n世界书内容`);
  assert.match(notes[0], /降级/);
});

// ---- 接线测试:真的把 server.js 跑起来,看它到底给 claude 传了什么 ----------
// 纯逻辑测过了不代表接对了 —— 这里假 claude 会把收到的 argv 落盘,直接断言。

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(dir, "..", "server.js");
const FAKE = path.join(dir, "..", "dev", "fake-claude.mjs");

// 起一个 shim,发一句话,把假 claude 收到的 argv 拿回来
async function spawnArgs(env = {}) {
  const port = 19287 + Math.floor(Math.random() * 400);
  const base = `http://127.0.0.1:${port}`;
  const argvOut = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "shim-argv-")), "argv.json");
  const proc = spawn("node", [SERVER], {
    env: {
      ...process.env,
      PORT: String(port), SHIM_KEY: "test-key", CLAUDE_BIN: FAKE, FAKE_ARGV_OUT: argvOut,
      TG_BOT_TOKEN: "", BARK_KEY: "", ELEVENLABS_API_KEY: "", EARS_URL: "",
      TIME_STAMP: "0", COMPACT_HOOK: "0", SOUL_ANCHOR: undefined, ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", () => {}); proc.stderr.on("data", () => {});
  try {
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(base + "/health")).ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    await fetch(base + "/messages", {
      method: "POST",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      body: JSON.stringify({ stream: false, messages: [{ role: "user", content: "在吗" }] }),
    });
    const debug = await (await fetch(base + "/debug", { headers: { "x-api-key": "test-key" } })).json();
    return { argv: JSON.parse(fs.readFileSync(argvOut, "utf8")), debug };
  } finally { try { proc.kill(); } catch {} }
}

test("【接线】默认(append):照旧只有 --append-system-prompt", async () => {
  const { argv, debug } = await spawnArgs();
  assert.ok(argv.includes("--append-system-prompt"));
  assert.ok(!argv.includes("--system-prompt"));
  assert.equal(argv[argv.indexOf("--append-system-prompt") + 1], `${ANCHOR}\n\n${HARD_RULE}`);
  assert.equal(debug.systemPrompt.mode, "append");
});

test("【接线】replace + 新版 CLI:CC 那份被换掉,锚点不再追加", async () => {
  const { argv, debug } = await spawnArgs({ SYSTEM_PROMPT_MODE: "replace", FAKE_HELP_HAS_SYSTEM_PROMPT: "1" });
  assert.equal(argv[argv.indexOf("--system-prompt") + 1], BASE);
  assert.ok(!argv.includes("--append-system-prompt")); // 没世界书时连追加都不需要
  assert.equal(debug.systemPrompt.mode, "replace");
});

test("【接线·安全阀】replace + 旧版 CLI:降级回 append,进程照样起得来", async () => {
  const { argv, debug } = await spawnArgs({ SYSTEM_PROMPT_MODE: "replace", FAKE_HELP_HAS_SYSTEM_PROMPT: "0" });
  assert.ok(!argv.includes("--system-prompt") && !argv.includes("--system-prompt-file"));
  assert.equal(argv[argv.indexOf("--append-system-prompt") + 1], `${ANCHOR}\n\n${HARD_RULE}`);
  assert.equal(debug.systemPrompt.mode, "append");
});
