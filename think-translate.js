// think-translate.js — 把新模型的英文思考摘要翻成中文再给她看
//
// 为什么需要:Opus 5 起(含 5.5)API 不再返回模型的原始思考,只给一份
// 「摘要」(display: summarized),而那份摘要由另一套系统写、是英文的 ——
// 人设里「思考链用中文」管得到他怎么想,管不到摘要用什么语言写。
//
// 做法:包一层 sink。模型的思考增量先攒着(thinkingRaw),一段思考结束
// (boundary)再整段交给翻译,译文出来才往下游发;期间到的正文、工具标记、
// finish 全部排在它后面,所以她看到的顺序和原来一样(先想、后说)。
//
// 兜底:翻译失败/超时/译文为空 → 原样发英文。思考链可以晚一点到,但绝不能丢。
// 已经是中文的段落不翻(省额度)。

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

export const TRANSLATE_PROMPT =
  "你是翻译器。把用户发来的一段英文内心独白翻译成自然、口语化的简体中文。" +
  "保持第一人称和原本的语气、犹豫、情绪;人名和称呼(如「栖栖」)照原样保留。" +
  "只输出译文本身,不加任何解释、前言、引号或标注。原文已经是中文就原样输出。";

// 中文字符占比够高就当作已经是中文,不花一次翻译
export function looksChinese(s) {
  const t = String(s || "").replace(/\s+/g, "");
  if (!t) return true;
  const cjk = (t.match(/[㐀-鿿]/g) || []).length;
  return cjk / t.length >= 0.3;
}

export function wrapTranslatingSink(sink, translate, { log = () => {} } = {}) {
  let q = Promise.resolve();
  let buf = "";
  const enqueue = (fn) => { q = q.then(fn).catch((e) => log("[think-tr] sink error", e?.message || e)); };
  const flush = () => {
    if (!buf) return;
    const src = buf; buf = "";
    enqueue(async () => {
      let out = null;
      if (!looksChinese(src)) {
        try { out = await translate(src); } catch (e) { log("[think-tr] 翻译失败,发原文:", e?.message || e); }
      }
      sink.thinking(out && out.trim() ? out.trim() + (/\n$/.test(src) ? "\n" : "") : src);
    });
  };
  return {
    showsThinking: sink.showsThinking,
    thinkingRaw(t) { if (t) buf += t; },
    boundary() { flush(); },
    thinking(t) { flush(); enqueue(() => sink.thinking(t)); },
    text(t) { flush(); enqueue(() => sink.text(t)); },
    finish(...a) { flush(); enqueue(() => sink.finish(...a)); },
    get idle() { return q; },
  };
}

// 用一次性的 claude -p 调便宜模型翻译。
// 隔离:临时 HOME + 临时 cwd(读不到人设 CLAUDE.md、用户设置、项目 .mcp.json),
// --strict-mcp-config 不带配置 = 没有 MCP,--tools "" = 没有工具,系统提示词整个替换。
// 凭据走 env(长期令牌/中转都由调用方的 buildAuthEnv 决定),与 HOME 无关。
export function makeCliTranslator({ bin, model, env, timeoutMs = 30000, log = () => {} }) {
  return (text) => new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "think-tr-"));
    const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
    const args = [
      "-p", "--model", model, "--output-format", "text",
      "--system-prompt", TRANSLATE_PROMPT,
      "--tools", "", "--strict-mcp-config", "--no-session-persistence",
    ];
    let out = "", err = "", done = false;
    // MAX_THINKING_TOKENS=0:翻译不需要思考(否则 CLI 默认给 3 万+ 思考预算,又慢又费);
    // DISABLE_NONESSENTIAL_TRAFFIC:省掉 CLI 顺手发的「给会话起标题」那一个额外请求。
    // 本地对假上游实测:这两条一关,一次翻译 16s → 0.6s,请求 2 → 1。
    const childEnv = { ...env, HOME: dir, MAX_THINKING_TOKENS: "0", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
    const p = spawn(bin, args, { cwd: dir, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    const end = (fn) => { if (done) return; done = true; clearTimeout(timer); cleanup(); fn(); };
    const timer = setTimeout(() => { try { p.kill(); } catch {} end(() => reject(new Error("timeout"))); }, timeoutMs);
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", (e) => end(() => reject(e)));
    p.on("close", (code) => end(() => {
      if (code === 0 && out.trim()) resolve(out.trim());
      else { log("[think-tr] exit", code, err.slice(0, 200)); reject(new Error(`exit ${code}`)); }
    }));
    p.stdin.end(text);
  });
}
