// recall.mjs — 自动浮现(shim 半边):她每句话前问记忆库「有没有一件确实相关的旧事」,有就在那句前加一行。
// 挑哪件在记忆库做(Ombre-Brain 的 GET /api/recall);这里只管要不要问、怎么递、别乱序。纯逻辑,零依赖。
// 三档:off(默认,和没这功能时逐字相同)/ observe(问、记日志、不递)/ on(真递)。运行时可改档,不重启。

export function recallMode(v) {
  const s = String(v || "").trim().toLowerCase();
  return s === "on" || s === "observe" ? s : "off";
}

// 这句该不该去问 OB。返回空串 = 该问;否则是不问的原因。
export function skipReason({ mode, configured, text, reset, systemTurn, windowCount, windowMax }) {
  if (mode === "off") return "off";
  if (!configured) return "not_configured";
  if (systemTurn) return "system_turn";          // 系统自己发的回合(查岗之类)不是她说的话
  if (reset) return "reset";                     // 晚安 / 归档 / 换窗口这类重置词不附
  if (String(text || "").trim().length < 2) return "too_short";
  if (windowMax > 0 && windowCount >= windowMax) return "window_full";
  return "";
}

// 还在冷却中的桶 id(顺手清掉过期的)。cooldown: Map<id, 上次递出的毫秒时间>
export function coolingIds(cooldown, now, hours) {
  const out = [];
  for (const [id, t] of cooldown) {
    if (now - t < hours * 3600e3) out.push(id);
    else cooldown.delete(id);
  }
  return out;
}

export function buildUrl(base, { q, n, exclude, minAgeH }) {
  const u = new URL(base);
  u.searchParams.set("q", String(q || "").slice(0, 2000));
  if (n) u.searchParams.set("n", String(n));
  if (minAgeH != null) u.searchParams.set("min_age_hours", String(minAgeH));
  if (exclude && exclude.length) u.searchParams.set("exclude", exclude.join(","));
  return u.toString();
}

// 递给 AI 的那一行。用法写在标注里,所以不用改人设文件。
export function formatHint(pick) {
  if (!pick || !pick.id) return "";
  const date = pick.created ? `${pick.created} ` : "";
  const name = pick.name ? `「${pick.name}」` : "";
  return `【系统·浮现】记忆库里自动翻到一件可能相关的旧事(系统附的,不是她说的;用得上就自然接住,用不上就当没看见;别提这行标注):`
    + `${date}${name}${pick.excerpt || ""}(全文:dream(detail_ids="${pick.id}"))`;
}

// 调 OB。任何失败都返回 { error },调用方照常发消息、只是不附。
export async function fetchRecall({ url, token, timeoutMs, fetchImpl = fetch }) {
  const t0 = Date.now();
  try {
    const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { error: `http_${r.status}`, ms: Date.now() - t0 };
    return { ...(await r.json()), ms: Date.now() - t0 };
  } catch (e) {
    return { error: e?.name === "TimeoutError" ? "timeout" : "fetch_failed", ms: Date.now() - t0 };
  }
}

// 观察记录的一条:只留她那句的开头 24 字,不带记忆正文。
export function observation({ mode, text, res, injected, skip }) {
  return {
    at: new Date().toISOString(), mode,
    preview: String(text || "").replace(/\s+/g, " ").slice(0, 24),
    skip: skip || null,
    reason: res ? (res.error || res.reason || null) : null,
    ms: res?.ms ?? null,
    pick: res?.pick ? { id: res.pick.id, name: res.pick.name, rare: res.pick.rare } : null,
    candidates: (res?.candidates || []).map((c) => ({ name: c.name, score: c.score, skip: c.skip })),
    injected: !!injected,
  };
}

export function pushRing(ring, item, max = 50) {
  ring.push(item);
  while (ring.length > max) ring.shift();
  return ring;
}
