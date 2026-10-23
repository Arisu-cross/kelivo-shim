// leak-guard.js — 他回完话之后「自己接着演下一轮」的那截,不许发出去
//
// 2026-10-23 实测:窗口被安全审查降级到旧模型、上下文又很长的时候,他偶尔会在
// 一条正常回复的末尾接着写出一句假的「user【时间 …】……」(冒充她说话),再抄出
// 一段系统格式的字(`The assistant turn was stopped by the user…`、`<total_tokens>…`)。
// 这些**不是 shim 注入的,也不是 CLI 注入的**,是模型自己生成的正文 ——
// 所以只能在出口拦:一旦正文里出现这几种「对话格式」的痕迹,从那里起往后一个字都不发。
//
// 为什么从标记处整段截掉、而不是只删标记那一行:标记后面跟的全是他编的「她的话」和
// 他对这句假话的回应,留哪一段都是错的。宁可这一条短一点。
//
// 流式出口(Kelivo)是边生成边吐字的,所以要扣住末尾一小段:标记可能被切在两个
// delta 之间(「us」+「er【时间」),不扣住就已经发出去了。扣的长度 = 最长标记长度。

// 判定用的正则。都锚在「行首」或「正文开头」,避免误伤他正常说话时提到这些词。
const MARKERS = [
  // 冒充她的下一轮:shim 给她每句话前面加的就是【时间 …】,他学着写出来
  /(^|\n)[ \t]*(user|human|User|Human|USER|HUMAN)[ \t]*[:：]?[ \t]*【时间/,
  /(^|\n)[ \t]*(Human|User)[ \t]*[:：]/,
  // 抄出来的系统 / harness 格式
  /The assistant turn was stopped by the user/,
  /<\/?total_tokens>/,
  /<\/?system-reminder>/,
];

// 扣住多少字不急着吐:要盖得住「最长的那个标记被切开」的情况。
export const HOLD_CHARS = 48;

// 在整段正文里找第一个泄漏点。返回下标(没有就 -1)。
// 下标落在标记所在行的开头(连同前面那个换行一起切掉),不留半截空行。
export function findLeak(text) {
  const s = String(text || "");
  let at = -1;
  for (const re of MARKERS) {
    const m = re.exec(s);
    if (m && (at === -1 || m.index < at)) at = m.index;
  }
  return at;
}

// 整段截断:TG / Kelivo 非流式 / 心跳这些「一次性拿全文」的出口用。
export function cutLeak(text) {
  const s = String(text || "");
  const at = findLeak(s);
  return at === -1 ? { text: s, leaked: false } : { text: s.slice(0, at).trimEnd(), leaked: true };
}

// 流式过滤器:push(delta) 返回现在可以安全吐出去的那部分;end() 吐出剩下的。
// 一旦发现泄漏,之后所有输入都吞掉(leaked 变 true)。纯逻辑,无副作用。
export function createLeakFilter({ hold = HOLD_CHARS } = {}) {
  let seen = "";     // 本轮到目前为止的全部正文(用来跨 delta 判定)
  let sent = 0;      // 已经吐出去的长度
  let leaked = false;
  return {
    get leaked() { return leaked; },
    push(delta) {
      if (leaked) return "";
      seen += String(delta || "");
      const at = findLeak(seen);
      if (at !== -1) {
        leaked = true;
        const out = at > sent ? seen.slice(sent, at).trimEnd() : "";
        sent = seen.length;
        return out;
      }
      const safe = Math.max(sent, seen.length - hold);
      const out = seen.slice(sent, safe);
      sent = safe;
      return out;
    },
    end() {
      if (leaked) return "";
      const out = seen.slice(sent);
      sent = seen.length;
      return out;
    },
  };
}
