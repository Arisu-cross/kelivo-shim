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

const prefixOf = (u) =>
  (u?.input_tokens || 0) + (u?.cache_read_input_tokens || 0) + (u?.cache_creation_input_tokens || 0);

// 从一轮的 usage 估算「当前窗口前缀有多大」。
//
// ⚠️ 不能直接用顶层字段:一轮里每次工具调用都是一次 API 请求,顶层 usage 是这一轮
// 所有请求的**累加值**。实测一轮 3 次调用、顶层 cache_read 20 万,而真实前缀只有 6.7 万
// —— 直接拿顶层当窗口大小会高估好几倍,提醒会疯狂误报。
//
// iterations[] 里是每次调用各自的前缀,取最大的那次(窗口在一轮内只增不减,
// 所以最大的那次最接近当轮结束时的真实大小)。iterations 缺失时(单次调用的轮次,
// 也就是绝大多数日常对话)顶层就是精确值,直接用。
export function estimateWindowTokens(usage) {
  if (!usage) return 0;
  const iters = Array.isArray(usage.iterations) ? usage.iterations : [];
  if (!iters.length) return prefixOf(usage);
  const perCall = Math.max(...iters.map(prefixOf));
  // 兜底:iterations 里若不含最后一次调用,会略微低估;但窗口大小在 server.js 里
  // 取历次最大值(单调不减),下一轮就会自动补上,不会一直偏低。
  return perCall || prefixOf(usage);
}

export const windowPct = (tokens, limit = DEFAULT_WINDOW_LIMIT) =>
  limit > 0 ? Math.round((tokens / limit) * 100) : 0;
