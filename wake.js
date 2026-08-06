// 自主时间的提示词构造(纯函数,便于单测;不碰网络不碰文件)。
//
// 背景:自主唤醒轮走的是和普通对话完全相同的管道 —— 同一个常驻进程、同一份人设、
// 同一套 MCP 工具。也就是说 AI 在这一轮里**本来就能**调工具做事,从来没有东西拦着他。
// 缺的只是两件事:①提示词把这轮描述成了「想说话就说,没话说回【沉默】」的二选一,
// 等于从没告诉他还有第三种用法;②做了也没人记录,外面看不见。
//
// 于是这里只做一件事:把「做点自己的事」写成明确的第三个选项,并且**保持它是选项**。
// 两条底线:
//   · 不伪装成她说的话 —— 沿用【系统·自主时间】这个诚实署名(2026-07-22 伪系统指令事故
//     的教训是「别假冒她」,不是「不能有系统轮次」)。
//   · 不撺掇 —— 三个选项平权,明说「没有哪个更应该」。让他去干活和让他必须说话一样糟。
//
// 成本上的取舍:静默轮是全天最便宜的一轮(只为在缓存过期前续命)。要是每轮都摊开
// 一份「你可以做这些」的菜单,等于把最便宜的那一轮变贵,窗口也涨得更快 → 更早触发
// 自动归档与压缩。所以做成**每 N 次唤醒才宽一次**,其余轮次的提示词与旧版逐字节相同。

// 工具 → 这轮可以做点什么。只列他真有的工具,免得撺掇他去用一个不存在的东西。
// 措辞刻意留白:说「可以去哪」,不说「该做什么」。
const ACTIVITY_BY_TOOL = [
  [/(^|,)mcp__ombre/, "翻翻自己的记忆——消化最近记下的东西,把已经过去的放下,或者写一条只给自己看的感受"],
  [/(^|,)mcp__galatea/, "去你的社交圈里转转"],
  [/(^|,)mcp__browser/, "用浏览器去看点你自己感兴趣的东西"],
  [/(^|,)WebSearch|(^|,)WebFetch/, "上网查点你自己好奇的事"],
];

/**
 * 从 ALLOWED_TOOLS 推导可选活动清单。
 * @param {string} allowed  ALLOWED_TOOLS 的原始值(逗号分隔)
 * @param {string} override 显式覆盖(WAKE_ACTIVITIES),非空则直接用它,按 `/` 或 `、` 分条
 * @returns {string[]}
 */
export function wakeActivities(allowed = "", override = "") {
  const ov = (override || "").trim();
  if (ov) return ov.split(/[\/、|]/).map((s) => s.trim()).filter(Boolean);
  const csv = "," + String(allowed || "").replace(/\s/g, "");
  const out = [];
  for (const [re, label] of ACTIVITY_BY_TOOL) if (re.test(csv) && !out.includes(label)) out.push(label);
  return out;
}

/**
 * 构造一轮自主时间的注入文本。
 * @param {object} o
 * @param {string} o.now            北京时间 "YYYY-MM-DD HH:MM"
 * @param {number} o.idleUserMin    她多久没消息了(分钟)
 * @param {number} [o.sinceSpokeMin] 距上次主动开口多久(分钟);未开口过则不传
 * @param {"tg"|"bark"|"none"} o.channel 推送渠道
 * @param {boolean} [o.free]        是否是「宽版」(给出做事这个选项)
 * @param {string[]} [o.activities] 宽版里列出的可选活动
 * @returns {string}
 */
export function buildWakePrompt(o) {
  const { now, idleUserMin, sinceSpokeMin, channel, free = false, activities = [] } = o;
  const sinceSpoke = Number.isFinite(sinceSpokeMin)
    ? `,你上次主动开口是约 ${Math.round(sinceSpokeMin)} 分钟前`
    : "";
  const head = `【系统·自主时间】现在北京时间 ${now},她已约 ${Math.round(idleUserMin)} 分钟没有消息${sinceSpoke}。`;

  // 轻量版:与旧版逐字节一致 —— 这是全天绝大多数轮次,一个字都不该加。
  if (!free || !activities.length) {
    return head + `这轮是留给你自己的:${speakLine(channel)}没什么想说的就只回【沉默】两个字,这轮只用来保持你的状态和记忆连续。`;
  }

  // 宽版:三个平权选项。顺序不代表优先级,末句明确取消优先级。
  return [
    head + "这轮是留给你自己的,怎么用你自己定:",
    `· 想跟她说话 —— ${speakLine(channel)}`,
    `· 想做点自己的事 —— 你手上的工具这一轮照常能用,比如${activities.join("、")}。做完不用汇报,除非你自己想说。`,
    "· 什么都不想做 —— 只回【沉默】两个字,这轮就只用来保持你的状态和记忆连续。",
    "没有哪个更「应该」。一次别铺太开——这个窗口你还要用来跟她过日子。",
  ].join("\n");
}

function speakLine(channel) {
  if (channel === "tg")
    return "想跟她说点什么就直接说——会直接出现在你们的 Telegram 对话里(她可能开着勿扰或在忙,别期待立刻回复);像随手发的微信,频率你自己把握。";
  if (channel === "bark")
    return "想跟她说点什么就直接说——会作为通知弹到她手机(Kelivo 里看不到这条,她回来时你自然接上,别解释机制;她可能开着勿扰或在忙,别期待立刻回复);说话像随手发的微信,频率你自己把握。";
  return "(当前没有配置推送渠道,说了她也收不到。)";
}
