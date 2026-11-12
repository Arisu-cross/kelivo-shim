// events.js — 外面的服务告诉他「发生了什么」(2026-11,Intertidal App 最终版)
//
// 几个外部服务会发现一些他该知道的事:她刚醒了 / 血氧偏低(collar 的看门程序)、她发了条朋友圈 / 下午要下雨 /
// 今天是纪念日(tide,App 的后端)。它们 POST /event 过来,这里排成一轮系统消息给他 —— 和查岗、工作台回调同一个路子:
// **只给事实,不给指令**(2026-07-22 伪系统指令事故的教训),说不说、说什么都是他的事;他开口就按心跳那套推给她。
//
// 另外一件也放这儿:熬夜提醒。刻意克制:只在真的很晚(默认 1:30 以后)、查岗数据显示 10 分钟内还在用手机、
// 今晚还没提过时,才排一轮给他。怎么说、说不说,交给人设那边。
// 纯逻辑,单测在 test/events.test.js。

export const EVENT_SOURCES = {
  body: "身体", weekly: "身体周报", moment: "朋友圈", weather: "天气", anniversary: "纪念日", app: "App",
};

export function normalizeSource(s) {
  const k = String(s || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(EVENT_SOURCES, k) ? k : null;
}

// 他读到的那一轮。末尾那句和查岗一样:知道就好,不命令。
export function eventPrompt(source, text, { bjNow } = {}) {
  const label = EVENT_SOURCES[source] || "消息";
  const body = String(text || "").trim().slice(0, 4000);
  return `【系统·${label}】${bjNow ? `现在北京时间 ${bjNow}。` : ""}${body}\n知道就好,说不说、说什么都由你;不想打扰她就回【沉默】。`;
}

// 图片最多 3 张,只认 base64 的 jpeg/png/webp/gif(朋友圈配图让他看一眼)
const IMG_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
export function eventImages(list) {
  const out = [];
  for (const im of Array.isArray(list) ? list : []) {
    if (out.length >= 3) break;
    const mt = String(im?.media_type || "").toLowerCase();
    const data = String(im?.data || "");
    if (!IMG_TYPES.has(mt) || !data || data.length > 7_000_000) continue;
    out.push({ type: "image", source: { type: "base64", media_type: mt, data } });
  }
  return out;
}

// ---- 熬夜提醒 ----
// 北京时间的「HH:MM」→ 当天分钟数
const hm = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim()); return m ? +m[1] * 60 + +m[2] : null; };

/**
 * 这会儿该不该提一句。
 * now:毫秒时间戳;activity:check.js 的 summarizeActivity 结果;lastNight:上次提醒那晚的标记(YYYY-MM-DD,按「凌晨算前一天」);
 * after/until:北京时间窗口(默认 01:30 ~ 05:00);freshMin:查岗多少分钟内算「还醒着」。
 * 返回 { due, night }:night 是今晚的标记,调用方提醒后记下它。
 */
export function nightNudgeDue({ now = Date.now(), activity, lastNight, after = "01:30", until = "05:00", freshMin = 10 } = {}) {
  const bj = new Date(now + 8 * 3600e3);
  const mins = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  // 「今晚」:凌晨的几点都算前一天晚上
  const night = new Date(now + 8 * 3600e3 - (mins < 12 * 60 ? 86400e3 : 0)).toISOString().slice(0, 10);
  const a = hm(after), u = hm(until);
  if (a == null || u == null) return { due: false, night };
  const inWindow = a <= u ? mins >= a && mins < u : mins >= a || mins < u;
  if (!inWindow || lastNight === night) return { due: false, night };
  const fresh = activity && activity.count > 0 && activity.minutesAgo != null && activity.minutesAgo <= freshMin;
  return { due: !!fresh, night };
}

export function nightPrompt(activity, { bjNow } = {}) {
  const app = activity?.lastApp ? `,${activity.minutesAgo <= 1 ? "刚刚" : `${activity.minutesAgo} 分钟前`}还在用${activity.lastApp}` : "";
  return `【系统·夜里】现在北京时间 ${bjNow},她看起来还没睡${app}。\n` +
    "这条一晚只来一次。要不要说一句、怎么说你自己定,别说教;不打扰就回【沉默】。";
}
