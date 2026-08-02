#!/usr/bin/env node
// PreCompact 钩子 —— 自动压缩发生「之前」执行。这个钩子干两件事:
//
// ① 闸门(2026-08-02 新增):先问 shim「这一窗还有没有没归档的内容?」
//    有 → **否决这次压缩**(PreCompact 支持 {"decision":"block"}),理由里请他现在就
//    archive_session。他存完之后窗口仍是满的,压缩会立刻再来一次,那时 shim 说"干净了"
//    就放行。**缺口因此收敛到 0** —— 压缩总是发生在一次成功归档之后。
//    (原来只有「窗口到 90% 请他归档」,那之后到压缩之间聊的仍然会被抹掉。)
//
// ② 摘要瘦身(原有):放行时,stdout 会作为额外指令拼进压缩提示词。
//    本项目的长期记忆走 MCP 记忆库(archive_session 写、breath 取回),摘要里那份转述
//    是重复的负担,而且是摘要器写的转述,语气和细节都会被磨平一层。所以只留一行指路。
//
// 配套(缺一不可,少一个就会丢记忆)
//   1. 人设里要有一条:看见续接标记先 breath(wake=true) 再开口;
//   2. shim 在窗口用量到阈值时请他归档(WINDOW_ARCHIVE_PCT),闸门是它的兜底不是替代;
//   3. 压缩真的溜过去时,shim 把原文回放给他补档(server.js 的 COMPACT_REPLAY)。
//
// ⚠️ 铁律:**这个脚本任何情况下都不能让压缩卡死**。
//   shim 不通、超时、返回坏 JSON、闸门没开 —— 一律退回「放行 + 摘要瘦身」。
//   宁可少拦一次(后面还有兜底),也不能把他卡在「压不动又满了」的状态里。
//
// 关掉:COMPACT_HOOK=0(shim 不挂这个钩子)、COMPACT_GATE=0(挂钩子但只瘦身不拦)。
// 改文案:COMPACT_INSTRUCTIONS 整段覆盖摘要指令。

import { hookStdout } from "./compact-gate.js";

const DEFAULT = `【摘要要求 · 最高优先级,覆盖以上全部默认摘要规则】
这段对话的完整记忆由长期记忆系统保管,不需要你在摘要里复述。
禁止:复述对话内容、引用原话、列举细节、罗列待办、总结技术状态、分点展开。
整份摘要只输出下面这一行,不要有任何其他文字:

上文已存入长期记忆。细节请用 breath(wake=true) 取回,不要凭这一行推测上文。`;

const SUMMARY = process.env.COMPACT_INSTRUCTIONS || DEFAULT;
const GATE_URL = process.env.COMPACT_GATE_URL || `http://127.0.0.1:${process.env.PORT || 8787}`;
const GATE_TIMEOUT_MS = +(process.env.COMPACT_GATE_TIMEOUT_MS || 3000);

async function askGate() {
  // 超时必须有:shim 卡住时钩子跟着卡 = 压缩卡死 = 窗口撞上限。
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), GATE_TIMEOUT_MS);
  try {
    const r = await fetch(`${GATE_URL}/precompact-gate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.SHIM_KEY || "" },
      body: JSON.stringify({ trigger: process.env.CLAUDE_COMPACT_TRIGGER || "" }),
      signal: ctl.signal,
    });
    if (!r.ok) return { block: false, why: `http_${r.status}` };
    const j = await r.json();
    return { block: !!j.block, reason: j.reason, why: j.why };
  } catch (e) {
    // 拿不到闸门的意见 = 不拦。记一行到 stderr(钩子的 stderr 不进他的窗口)。
    process.stderr.write(`[precompact-gate] unreachable: ${e.message}\n`);
    return { block: false, why: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

const decision = await askGate();
if (decision.block) process.stderr.write(`[precompact-gate] blocking compaction (${decision.why})\n`);
process.stdout.write(hookStdout(decision, SUMMARY));
