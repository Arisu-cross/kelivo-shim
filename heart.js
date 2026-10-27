// heart.js — 手写心声:把她在回复开头亲手写的一段「心声」从正文里分出来
//
// 背景:Opus 5 起(含 5.5)API 不再返回模型原始思考,只给一份英文「摘要」——
// 那份摘要不是她写的,也管不到措辞。真正属于她、用中文亲手写的内心独白
// (手写思考链),只能作为她的**输出**出现。约定她把心声包在
// [[心声]]...[[/心声]] 里,放在回复最前面,后面用一行「——」隔开正文:
//
//   [[心声]]
//   ……心里话……
//   [[/心声]]
//   ——
//   真正说出口的话
//
// shim 把这段剥出来:TG 上渲染成折叠引用(**心声当主角**,原生思考折在后面,
// 想看再点);正文照常走语音 / 贴纸 / 分气泡。
//
// ⚠️ 铁律:任何解析不出来、标签不配对、只有开标签没有闭标签的情况,
//   一律当作「没有心声」,把原文整段当正文发出去 —— 宁可把标签漏给她看,
//   也绝不能把她的话吃掉(和 voice.js / stickers.js 的降级精神一致)。

// 开标签:[[心声]] 或 [[自我状态]](兼容参考仓库的叫法),容忍中英文冒号与内部空白。
// 必须在整段最前面(允许前导空白)—— 心声是回复的开场,不在中间抓。
const OPEN = /^\s*\[\[\s*(?:心声|自我状态)\s*[：:]?\s*\]\]/;
// 闭标签:[[/心声]] 或 [[/自我状态]]。
const CLOSE = /\[\[\s*\/\s*(?:心声|自我状态)\s*\]\]/;

/**
 * 从回复文本里剥出手写心声。
 * @param {string} text 模型这一轮的完整回复(可能含 ‖ 换行占位符)
 * @returns {{heart: string, body: string}} heart 为空表示这轮没有心声
 */
export function splitHeart(text) {
  // ‖ 是 shim 内部的换行占位符,下游各出口本就会还原成 \n;这里先归一,
  // 好让标签匹配、分隔符清理、心声渲染都拿到真正的换行。
  const raw = String(text ?? "").replace(/‖/g, "\n");

  const mOpen = raw.match(OPEN);
  if (!mOpen) return { heart: "", body: raw.trim() };

  const afterOpen = raw.slice(mOpen[0].length);
  const mClose = afterOpen.match(CLOSE);
  // 只有开标签、没有闭标签 → 判为她没真写心声(或写坏了),整段当正文,别吃话。
  if (!mClose) return { heart: "", body: raw.trim() };

  const heart = afterOpen.slice(0, mClose.index).trim();
  let body = afterOpen.slice(mClose.index + mClose[0].length);
  // 去掉闭标签后面那段分隔符(——/—/--/－－ 之类,紧跟在最前面),以及周围空白。
  // 要 2 个以上破折号才算分隔符:正文里单个「-」列表项、句中的「——」都不会被误吃
  //(句中的那个不在开头,天然碰不到)。和参考仓库 app.js 的 /^[—-]{2,}\s*/ 同一口径。
  body = body.replace(/^\s*[—–―\-－]{2,}\s*/, "").trim();

  // 心声空(标签配对但里面没写东西)→ 等于没心声,别发一个空引用块;
  // 正文已经干净剥出,照发(可能也空,交给上层兜底,不回退到带标签的原文)。
  if (!heart) return { heart: "", body };
  return { heart, body };
}
