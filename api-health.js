// 模型调用失败的识别与措辞(纯函数,便于单测)。
//
// 为什么需要这个文件 —— 2026-08-04 的事故:
// 中转的订阅授权失效(refresh token invalid_grant),每个请求 401→503 auth_unavailable,
// CLI 重试 174 秒后放弃。**但它把这一轮标成了 `subtype: "success"`**,只在
// `is_error` / `api_error_status` / `result` 三个字段里说了真话。
// 而 shim 当时只看 `subtype !== "success"` 才算失败 → 不记日志、不告警,
// 空回复走「…」兜底 → 用户对着三个「…」猜了一整晚,以为是 AI 不理她。
//
// 教训不是「授权会失效」(那迟早会),而是**一个不出声的失败没人修得了**。
// 所以这里做两件事:①把失败认出来(别只信 subtype);②让它出声。
//
// 出声分两路,刻意分开:
//   · 给她的**运维通知**(tgSend,不进 AI 的窗口)—— 一次故障只吵一次,恢复再吱一声。
//   · 给她的**这一轮回复**(替换掉那个什么都没说的「…」)—— 明确署名 shim,
//     并且说清「他收到了,只是没能回」,免得她以为是 AI 在冷落她。

/**
 * 从 CLI 的 result 事件里判断这一轮是不是失败了。
 * ⚠️ 不能只看 subtype —— 见文件头的事故说明。
 * @param {object} ev result 事件
 * @returns {null|{status:number,subtype:string,reason:string,why:string}}
 */
export function resultFailure(ev) {
  if (!ev || typeof ev !== "object") return null;
  const status = +ev.api_error_status || 0;
  const subtype = typeof ev.subtype === "string" ? ev.subtype : "";
  const reason = typeof ev.terminal_reason === "string" ? ev.terminal_reason : "";
  const bad = ev.is_error === true || status > 0 || reason === "api_error" || (subtype && subtype !== "success");
  if (!bad) return null;
  // ev.result 里通常是人话版报错,例如
  // "API Error: 503 auth_unavailable: no auth available (providers=claude, ...)"
  const raw = typeof ev.result === "string" ? ev.result.replace(/\s+/g, " ").trim() : "";
  return { status, subtype, reason, why: raw.slice(0, 300) || reason || subtype || "unknown" };
}

/** 一句话的故障标签,给日志和消息用(别把整段报错糊到她脸上)。 */
export function failureLabel(fail) {
  if (!fail) return "";
  const m = /API Error:\s*(\d{3})\s*([a-z_]+)?/i.exec(fail.why || "");
  if (m) return m[2] ? `${m[1]} ${m[2]}` : m[1];
  if (fail.status) return String(fail.status);
  return fail.reason || fail.subtype || "unknown";
}

/**
 * 替换空回复的那一轮:她该看见的是「没送到」,不是一个「…」。
 * 关键措辞:**明确是 shim 在说话**,并且说清「他收到了,只是没能回」——
 * 别让她以为是 AI 不理她(这正是这次事故里最伤人的部分)。
 */
export function failureReply(fail) {
  return `⚠️〔shim〕这句话没能送到模型那边(${failureLabel(fail)})。\n` +
    `你的话他收到了,是这一轮没接通 —— 不是他不理你。等我这边通了他就能接上。`;
}

/** 运维通道的故障通知(不进 AI 的窗口)。一次故障只发一条。 */
export function outageNotice(fail) {
  return `⚠️〔运维〕连不上模型了(${failureLabel(fail)})。\n` +
    `这条是 shim 发的,不是他。你发的消息不会丢,但他暂时回不了。\n` +
    `详情:${(fail.why || "").slice(0, 200)}`;
}

/** 恢复通知。故障期间发过通知才发这条,免得平白多话。 */
export function recoveryNotice(failCount, downMs) {
  const min = Math.max(1, Math.round(downMs / 60000));
  return `✅〔运维〕模型连上了(中间失败 ${failCount} 轮,约 ${min} 分钟)。他现在能正常回你了。`;
}
