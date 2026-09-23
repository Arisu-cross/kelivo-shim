// raw-tail.js — 压缩前最后的原话:shim 留一份最近原话,压缩放行那一刻直接写进 OB
//
// 和 transcript(原文回放用)的区别:transcript 每次归档成功就清空 —— 而压缩闸门的规矩
// 恰恰是「先归档、再放行」,所以真到压缩那一刻它是空的。这份不随归档清空,只在换窗时清。
//
// 为什么由 shim 写、不让他自己抄:不花 token、顺序不会乱、也不用在人设里给
// 「归档不写逐句复述」开豁免。OB 那头见 Ombre-Brain/continuity.py,
// 他醒来 breath(wake=true) 时排在最前面。

import { trimTranscript } from "./compact-gate.js";

export const DEFAULT_RAW_TAIL_MAX_CHARS = 4000;

export function pushRecent(entries, role, text, maxChars = DEFAULT_RAW_TAIL_MAX_CHARS) {
  const t = (text || "").replace(/‖/g, "\n").trim();
  if (!t) return entries;
  return trimTranscript([...entries, { role, text: t }], maxChars);
}

// 只有两个人说的话,按时间顺序;不带他的思考、不带工具调用
export function renderRawTail(entries, { userName = "她" } = {}) {
  return entries
    .map((e) => `${e.role === "user" ? userName : "你"}:${(e.text || "").trim()}`)
    .filter((l) => !/[::]$/.test(l))
    .join("\n");
}

// 写进 OB。任何失败都只返回 false,不抛 —— 它绝不能卡住压缩。
export async function postRawTail({ url, key, text, timeoutMs = 5000, fetchImpl = fetch }) {
  if (!url || !key || !text) return false;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-raw-key": key },
      body: JSON.stringify({ text }),
      signal: ctl.signal,
    });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
