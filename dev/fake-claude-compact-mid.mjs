#!/usr/bin/env node
// 复现用的假 claude:**压缩发生在一轮的中间**。
// 真实事件顺序是:这一轮的请求发出去 → 撞上限 → CLI 压缩(compact_boundary)→
// 用压缩后的小前缀重新请求 → 出结果。所以同一轮里会出现两个 message_start:
// 一个是压缩前的大前缀(167159),一个是压缩后的小前缀(9000)。
// shim 取「本轮最大前缀」,于是压缩后反而被记成满窗 —— 这个脚本就是来照出这件事的。

let buf = "";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

process.stdin.on("data", (c) => {
  buf += c.toString();
  const lines = buf.split("\n");
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    setTimeout(() => {
      out({ type: "stream_event", event: { type: "message_start", message: { usage: { cache_read_input_tokens: 167159 } } } });
      out({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 167159 } });
      out({ type: "stream_event", event: { type: "message_start", message: { usage: { cache_read_input_tokens: 9000 } } } });
      out({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "接上" } } });
      out({ type: "result", subtype: "success", usage: { output_tokens: 3 } });
    }, 5);
  }
});
