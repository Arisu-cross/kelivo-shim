#!/usr/bin/env node
// 假的 `claude -p` —— 让整个 shim 能在没有订阅、没有网络的情况下真跑起来。
// 存在的理由:压缩闸门的 bug 不在纯逻辑里,在**接线**上(dirty 有没有被正确置位、
// 归档成功有没有清账、闸门端点读到的是不是同一份状态)。这些只有把 server.js
// 真的跑起来才测得出来 —— 2026-07-25 那次「漏改函数签名默认值导致新逻辑成了死代码,
// 表面一切正常」就是纯逻辑测试抓不到的那类。
//
// 协议:按 stream-json 读 stdin 的每行 {type:"user",message:{content}},照约定回事件。
// 用消息文本里的暗号决定这一轮怎么演:
//   含 "archive_session" → 演成功归档(tool_use + tool_result 带 🗄️)
//   含 "ARCHIVE_FAIL"    → 演归档失败(tool_result 不带 🗄️)
//   含 "COMPACT_NOW"     → 先发一个 compact_boundary,再正常回一轮
// 另外 FAKE_PREFIX 环境变量决定 message_start 报的窗口前缀大小。

// 另外两个开关,给系统提示词模式的接线测试用:
//   FAKE_HELP_HAS_SYSTEM_PROMPT=1  → `--help` 里印出 --system-prompt,冒充新版 CLI
//   FAKE_ARGV_OUT=<path>           → 把这次收到的 argv 落盘,测试据此断言 shim 传了什么

import { writeFileSync } from "node:fs";

if (process.argv.includes("--help")) {
  // 只印测试关心的那一行;真 CLI 从 2.1.239 起有这个参数,旧版没有。
  process.stdout.write(process.env.FAKE_HELP_HAS_SYSTEM_PROMPT === "1"
    ? "  --system-prompt <prompt>   System prompt to use for the session\n"
    : "  --append-system-prompt <prompt>   Append a system prompt\n");
  process.exit(0);
}
if (process.env.FAKE_ARGV_OUT) {
  try { writeFileSync(process.env.FAKE_ARGV_OUT, JSON.stringify(process.argv.slice(2))); } catch {}
}

let buf = "";
const PREFIX = +(process.env.FAKE_PREFIX || 1000);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

process.stdin.on("data", (c) => {
  buf += c.toString();
  const lines = buf.split("\n");
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    const content = msg?.message?.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content) ? content.map((b) => b.text || "").join(" ") : "";
    setTimeout(() => reply(text), 5);
  }
});

function reply(text) {
  // ⚠️ 回放补档那一轮会把原文整段带回来,里面还留着上一条消息的暗号 ——
  // 不排除掉的话假 claude 会二次触发压缩,测出来的现象全是假的。
  const isReplay = text.includes("原文开始");
  if (text.includes("COMPACT_NOW") && !isReplay) {
    out({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 160000 } });
  }
  out({ type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 3, cache_read_input_tokens: PREFIX } } } });

  const wantArchive = text.includes("archive_session");
  const wantFail = text.includes("ARCHIVE_FAIL");
  if (wantArchive || wantFail) {
    const id = "toolu_fake_1";
    out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "mcp__ombre__archive_session" } } });
    out({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
    out({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: id, content: wantFail ? "归档失败: OB 连不上" : "🗄️ 已归档 会话归档 2026-08-02" }] },
    });
  }

  const say = wantFail ? "没存上" : wantArchive ? "存好了" : "嗯,在听";
  out({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: say } } });
  out({ type: "result", subtype: "success", usage: { output_tokens: 5 } });
}
