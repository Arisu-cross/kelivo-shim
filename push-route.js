// push-route.js — 主动开口的话(自主时间 / 查岗结果 / 自动归档后那句)往哪扇门送
//
// 原来只有一条路:Telegram(没有就 Bark)。接上 iMessage 之后(一个独立的 imessage-bridge 服务,
// 调本 shim 的 /v1/messages,请求头带 `x-client: imessage`),她可能人在「信息」里、Telegram 没开。
// 规则很简单:**她最后一次是从哪扇门说话的,主动的话就先往那扇门送;送不到退回 Telegram**。
//
// 为什么「先试、失败再退」而不是「两边都发」:两边都发 = 她同一句话收两遍。
// bridge 那边的 /push 约定(和它配套写死的):
//   第一句发出去 → 立刻回 200,剩下的它后台接着发(我们这边只等 PUSH_TIMEOUT_MS)
//   第一句就发不出去 → 502,它那边停发;还不知道往哪个对话发 → 503
// 所以「非 2xx / 超时 / 网络错」一律当「那边一句都没出现」,退回 Telegram 不会重复。
//
// 纯逻辑 + 一次 HTTP,不碰进程、不碰窗口;fetchImpl 可注入,单测不出网。

export const PUSH_TIMEOUT_MS = 60000;

// 她说话时记下来的「门」。只认这几个值,别的一律当 null(= 老行为)。
const CLIENTS = new Set(["telegram", "kelivo", "imessage"]);
export function normalizeClient(v) {
  const s = String(v || "").trim().toLowerCase();
  return CLIENTS.has(s) ? s : null;
}

// 这次主动开口按什么顺序试。返回 ["imessage", "telegram"] 这样的列表,调用方挨个试、成功就停。
// hasTg:Telegram 能发(有 token 且已锁定聊天);bark:这类消息允许退到 Bark(心跳/查岗允许,归档那句不允许,
// 保持原来的行为不变)。
export function pushOrder({ lastClient, imessageUrl, hasTg, hasBark, bark = true }) {
  const out = [];
  if (lastClient === "imessage" && imessageUrl) out.push("imessage");
  if (hasTg) out.push("telegram");
  else if (bark && hasBark) out.push("bark");
  return out;
}

// 往 bridge 的 /push 送一段话。只回 true/false,不抛错 —— 失败了调用方退回下一扇门。
export async function pushToImessage({ url, key, text, timeoutMs = PUSH_TIMEOUT_MS, fetchImpl = fetch }) {
  try {
    const r = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key || "" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: r.status >= 200 && r.status < 300, status: r.status };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}
