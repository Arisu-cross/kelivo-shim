// 窗口用量监测 —— 这个窗口离「自动压缩」还有多远。
//
// 为什么需要:压缩摘要被 PreCompact 钩子瘦身成一行之后,没归档的那段对话就没有
// 兜底了。所以要在撞线之前提醒用户「让他把这段存一下、换个新窗口」。

// 自动压缩的触发线(token)。Claude Code 的算法(v2.1.x):
//   effectiveWindow = 模型上下文上限 - min(最大输出 token, 20000)
//   threshold       = effectiveWindow - 13000(压缩缓冲)
// 200k 上下文的模型 → 200000 - 20000 - 13000 = 167000。
// 换模型/上限变了就用环境变量 WINDOW_LIMIT 覆盖。
export const DEFAULT_WINDOW_LIMIT = 167000;

// 1M 上下文(模型名带 `[1m]` 后缀,如 claude-opus-5-5[1m]):1000000 - 20000 - 13000。
// 2026-09-23 用 CLI 2.1.280 对假上游实测:不带后缀的 5.5 在 17.5 万~18 万之间就压缩
// (CLI 当它是 200k 模型);带 [1m] 到 96 万都不压,且请求带 context-1m beta。
export const WINDOW_LIMIT_1M = 967000;
export const is1m = (model) => /\[1m\]$/i.test(String(model || ""));
// 这个模型的窗口按哪条线算。上限不再是一个全局常数 —— 同一个 shim 里 200k 和 1M 的模型会混着用。
export const windowLimitFor = (model, { base = DEFAULT_WINDOW_LIMIT, big = WINDOW_LIMIT_1M } = {}) =>
  is1m(model) ? big : base;

// 一次 API 请求的「前缀大小」= 这次请求实际送进去的上下文。
export const prefixOf = (u) =>
  (u?.input_tokens || 0) + (u?.cache_read_input_tokens || 0) + (u?.cache_creation_input_tokens || 0);

// ⚠️⚠️ 绝对不要用 result 事件里那个顶层 usage 来估算窗口大小 ⚠️⚠️
//
// 2026-07-29 线上翻车实录:一轮里每调用一次工具就是一次独立的 API 请求,而 CLI 的
// 顶层 usage 是**整轮所有请求的累加**(源码 v2.1.220:每个 message_stop 都执行
// `totalUsage = AV6(totalUsage, M1)`,AV6 把 cache_read 等字段逐项相加)。
// 于是一轮调 3 次工具 → 顶层 cache_read ≈ 真实前缀 × 3。
// 实测:真实窗口 53947,顶层报 161206,**虚报 3 倍**,把 32% 显示成了 97%,
// 并触发了一条毫无根据的 85% 提醒。
//
// 更早的版本还想靠 `iterations[]` 兜底(取其中最大的一次)——同样不可靠:
// 源码里 iterations 是 `q.iterations ?? A.iterations` 直接传递、不累加,
// 线上绝大多数轮次它就是**空数组**,于是兜底逻辑退回顶层 = 踩进同一个坑。
//
// 正确来源只有一个:**每次 API 请求自己的 `message_start` 事件**,
// 它带的 usage 就是这一次请求的真实前缀,不含任何累加。见 server.js 的 trackMessageStart。

// 从一次 message_start 事件里取出这次请求的前缀大小;不是 message_start 就返回 0。
export function prefixFromMessageStart(event) {
  if (!event || event.type !== "message_start") return 0;
  return prefixOf(event.message?.usage);
}

export const windowPct = (tokens, limit = DEFAULT_WINDOW_LIMIT) =>
  limit > 0 ? Math.round((tokens / limit) * 100) : 0;
