// reactions.js — [回应:表情] 标记解析 + Telegram 表情回应白名单(setMessageReaction 用)
//
// 「回应」是 Telegram 里长按一条消息贴上去的那个小表情:挂在**她那条消息**的右下角,
// 不新增一条消息、不打断对话节奏。他现在只会「说话」和「发贴纸」,这是第三种表达方式:
// 半夜她说「睡了」,他不想吵她,就在那条上贴个 ❤️。
//
// 和贴纸同一套分工:模型只管在回复里写 [回应:❤️],怎么贴、贴不贴得上,全在这一层决定。
//
// ⚠️ 这里最要紧的一件事:**Telegram 只认一张固定的表情白名单**(见 ALLOWED)。
// 非会员 bot 贴白名单以外的表情,API 直接回 400 REACTION_INVALID。
// 而模型很自然就会想写 😏 —— 它恰好不在白名单里。所以白名单不是可选的校验,
// 是这个功能能不能用的前提。名单外的表情不报错、不丢弃,由调用方降级成一条普通气泡
// (见 server.js 的 tgSendReply),情绪照样到得了她那边。

// Telegram Bot API 允许普通 bot 使用的表情回应,原样照抄官方名单。
// 注意其中若干个带 ZWJ(❤‍🔥 / 👨‍💻 / 🤷‍♂),也有几个是不带变体选择符的裸码位(❤ 🕊 ⚡ ✍ ☃)——
// 白名单里存的是**规范形态**,匹配时两边都抹掉 U+FE0F 再比,发出去用这里的形态。
export const ALLOWED = [
  "👍", "👎", "❤", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩",
  "🤮", "💩", "🙏", "👌", "🕊", "🤡", "🥱", "🥴", "😍", "🐳", "❤‍🔥", "🌚", "🌭", "💯",
  "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓", "🍾", "💋", "🖕", "😈", "😴", "😭",
  "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈", "😇", "😨", "🤝", "✍", "🤗", "🫡", "🎅", "🎄",
  "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎", "👾",
  "🤷‍♂", "🤷", "🤷‍♀", "😡",
];

// 变体选择符(U+FE0F)只影响显示成彩色还是黑白,不影响是哪个表情。
// 手机输入法打出来的 ❤️ 带它、官方名单里的 ❤ 不带,不抹掉就永远对不上。
const bare = (s) => String(s).replace(/️/g, "");
const CANON = new Map(ALLOWED.map((e) => [bare(e), e]));

/**
 * 归一化成 Telegram 认的那个形态;不在白名单里返回 null。
 * 调用方拿 null 当作「这个表情贴不上去」,而不是「出错了」。
 */
export function canonicalReaction(emoji) {
  return CANON.get(bare(emoji)) ?? null;
}

// 宽松匹配:方括号半角 [] 与全角 【】混用都认,冒号半角/全角都认,标记内外多余空格容忍。
// 名字段不允许括号和换行——避免一个没闭合的标记把后面半篇回复都吃掉(和 stickers.js 同一条规矩)。
const REACTION_RE = /[[【]\s*回应\s*[:：]\s*([^[\]【】\n]{1,16}?)\s*[\]】]/g;

// 标记里装的到底像不像一个表情。
// 只放行「短、没有字母数字、没有汉字假名谚文、至少有一个非 ASCII 字符」的内容:
// [回应:❤️] 认,[回应:好的] 不认。不认的原样当普通文本留着,宁可让她看见一个标记,
// 也不要把他写的字吞掉——同 stickers.js 对未知贴纸名的处理。
const CJK_RE = /[㐀-䶿一-鿿぀-ヿ가-힯]/;
function looksLikeEmoji(s) {
  if (!s || [...s].length > 8) return false;
  if (/[0-9A-Za-z]/.test(s) || CJK_RE.test(s)) return false;
  return /[^\x00-\x7F]/.test(s);
}

/**
 * 把一段文字切成 [{ type: "text"|"reaction", content }] 有序段落。
 *
 * reaction 段的 content 是标记里原样的表情字符串(**没有**过白名单)——
 * 白名单校验故意留给发送层,因为「贴不上」和「不认识」要走同一条降级路:
 * 都变成一条只有表情的气泡。在这里就把名单外的表情当普通文本退回去,
 * 反而会把 [回应:😏] 这个标记漏给她看。
 */
export function splitReactionSegments(text) {
  const segs = [];
  let buf = "";
  let last = 0;
  const flush = () => { if (buf) segs.push({ type: "text", content: buf }); buf = ""; };
  REACTION_RE.lastIndex = 0;
  for (let m; (m = REACTION_RE.exec(text)); ) {
    buf += text.slice(last, m.index);
    const emoji = m[1].trim();
    if (looksLikeEmoji(emoji)) { flush(); segs.push({ type: "reaction", content: emoji }); }
    else buf += m[0];                       // 不像表情:原样保留
    last = m.index + m[0].length;
  }
  buf += text.slice(last);
  flush();
  return segs;
}
