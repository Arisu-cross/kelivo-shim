// Telegram HTML 消息切块 —— 按「转义之后」的长度切,不是按原文长度。
//
// 为什么需要(2026-08-13 线上事故):
// 思考链以 <blockquote expandable> + parse_mode=HTML 发出,而 HTML 转义会把内容撑大
// (`&` → `&amp;` 是 5 倍,`<` → `&lt;` 是 4 倍)。原来的代码按**原文** 3600 字符截断,
// 转义后可能超过 Telegram 单条 4096 的硬上限 → 整条被 TG 拒收。
//
// 更糟的是调用点:思考链先发、正文后发,共用一个 catch —— 发思考链那步一抛错,
// 后面那行正文就永远不会执行,表现是「他明明回了,她那边一片安静」。
// 所以这里有两条规矩,都不能破:
//   ① 按转义后的长度算,保证每条都在上限内;
//   ② 宁可多发几条,也不截断内容(以前超长直接砍掉补 `…`,他想得越长丢得越多)。

/** Telegram 的 HTML 模式只需要转义这三个字符。 */
export const tgEsc = (x) =>
  String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Telegram 单条消息上限 4096。减去 <blockquote expandable></blockquote>(36 字符)
// 再留一点余量,取 3900 —— 余量是给将来可能换的包裹标签,不是凑整。
export const TG_HTML_MAX = 3900;

/**
 * 把 raw 切成若干块,保证每块 tgEsc() 之后的长度不超过 max。
 * 尽量在换行处断开,读起来不至于半句拦腰截断;整块都没有换行时才硬切。
 * 返回的各块拼起来 = 原文(除了被用作断点的那个换行符),不丢内容。
 */
export function chunkForHtml(raw, max = TG_HTML_MAX) {
  const s = String(raw ?? "");
  if (!s) return [];
  if (tgEsc(s).length <= max) return [s];

  const out = [];
  let buf = "";
  let esc = 0;
  for (const ch of s) {
    const add = tgEsc(ch).length;
    if (esc + add > max && buf) {
      // 断点优先找换行,但不能太靠前 —— 否则一块只装半点东西,平白多出很多条
      const nl = buf.lastIndexOf("\n");
      if (nl > max * 0.5) {
        out.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1) + ch;
      } else {
        out.push(buf);
        buf = ch;
      }
      esc = tgEsc(buf).length;
      continue;
    }
    buf += ch;
    esc += add;
  }
  if (buf) out.push(buf);
  return out;
}
