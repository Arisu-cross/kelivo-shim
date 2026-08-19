// 出站兜底 —— 「他回了,但消息没到她手机上」这件事不许再发生。
//
// 2026-08-19 事故:容器的 IPv6 出口不通,而 DNS 把 api.telegram.org 的 IPv6 地址排在前面,
// Node 的 fetch 按解析顺序连、不做 Happy Eyeballs → 大量 `fetch failed`。
// 当时的 tgSendReply 发失败只写一行日志就算了,没有重试、也没有别的路 ——
// 于是他连着答了四条,她一条都没收到,还以为他不理她。
//
// 根因已经在 server.js 顶部用 ipv4first + autoSelectFamily 治了。这里是第二层:
// **任何**网络抖动(不只是这一次的 IPv6)都不该让他的话凭空消失。
//
// 两条规矩:
//   ① 能重试的才重试。429/5xx/网络异常是「等会儿再来就好」;400/403 是「内容本身不合法」,
//      重发一百次也一样,只会刷屏。
//   ② 重试完还是不行 → 进 outbox,后台慢慢补投,直到成功或者超过 maxAge 认赔。
//      认赔也要留日志,别静默。

export const DEFAULT_BACKOFF = [1000, 3000, 8000];   // 立即重试的间隔(毫秒)
export const DEFAULT_ATTEMPTS = 4;                    // 首发 + 3 次重试

/** 第 attempt 次重试(从 0 数)该等多久。表用完就一直用最后一档。 */
export function backoffFor(attempt, table = DEFAULT_BACKOFF) {
  return table[Math.min(Math.max(attempt, 0), table.length - 1)];
}

/**
 * 这次失败值不值得再试一次。
 * res 有两种形态:
 *   { thrown: true, message }        —— fetch 自己抛了(网络层:DNS/连接/超时)
 *   Telegram 的 JSON 响应             —— { ok, error_code, description, parameters }
 */
export function shouldRetry(res) {
  if (!res) return true;                 // 什么都没拿到,当网络问题
  if (res.thrown) return true;           // fetch failed / AbortError
  if (res.ok) return false;              // 成功
  const code = +res.error_code || 0;
  if (code === 429) return true;         // 限流,等 retry_after
  if (code >= 500) return true;          // TG 自己抽风
  return false;                          // 400/403/404:内容或权限问题,重发无意义
}

/** 限流时 Telegram 会告诉你等几秒。没说就返回 0。 */
export function retryAfterMs(res) {
  const s = +(res?.parameters?.retry_after || 0);
  return s > 0 ? s * 1000 : 0;
}

/**
 * 补投队列。只在内存里(和 transcript 一样,这是他们俩的私话,不落盘)。
 * send(item) 要返回 shouldRetry 认得的那种结果,或者抛错。
 */
export class Outbox {
  constructor({ send, sleep, now = Date.now, log = () => {},
                maxAgeMs = 10 * 60e3, intervalMs = 20e3, maxItems = 50 } = {}) {
    this.send = send;
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = now;
    this.log = log;
    this.maxAgeMs = maxAgeMs;
    this.intervalMs = intervalMs;
    this.maxItems = maxItems;
    this.items = [];
    this.timer = null;
    this.draining = false;
  }

  size() { return this.items.length; }

  /** 队满就丢最旧的 —— 离现在最近的那句话最要紧(和 trimTranscript 同一个取舍)。 */
  push(item) {
    this.items.push({ item, at: this.now() });
    while (this.items.length > this.maxItems) {
      this.items.shift();
      this.log("[outbox] 队列满,丢掉最旧的一条");
    }
    return this.size();
  }

  /**
   * 走一遍队列。成功出队;还能再试的留着下一轮;超过 maxAge 的认赔丢弃。
   * 保持顺序:前面那条没送出去就停,免得她先看到后半句。
   */
  async drain() {
    if (this.draining || !this.items.length) return { sent: 0, dropped: 0, left: this.size() };
    this.draining = true;
    let sent = 0, dropped = 0;
    try {
      while (this.items.length) {
        const head = this.items[0];
        if (this.now() - head.at > this.maxAgeMs) {
          this.items.shift(); dropped++;
          this.log("[outbox] 一条补投超时丢弃(攒了太久,补发过去反而错位)");
          continue;
        }
        let res;
        try { res = await this.send(head.item); }
        catch (e) { res = { thrown: true, message: e?.message }; }
        if (res?.ok) { this.items.shift(); sent++; continue; }
        if (!shouldRetry(res)) {
          this.items.shift(); dropped++;
          this.log("[outbox] 一条补投被 TG 拒收,重发也没用,丢弃");
          continue;
        }
        break;  // 还是发不出去,留到下一轮
      }
    } finally { this.draining = false; }
    if (sent) this.log("[outbox] 补投成功", sent, "条,剩", this.size());
    return { sent, dropped, left: this.size() };
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.drain().catch(() => {}); }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}

/**
 * 带重试的一次发送。call() 返回 Telegram 的 JSON,抛错视为网络层失败。
 * 重试用完仍不行 → 返回最后一次的结果,由调用方决定进不进 outbox。
 */
export async function sendWithRetry(call, {
  attempts = DEFAULT_ATTEMPTS, backoff = DEFAULT_BACKOFF,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {}, label = "tg",
} = {}) {
  let res;
  for (let i = 0; i < attempts; i++) {
    try { res = await call(); }
    catch (e) { res = { thrown: true, message: e?.message || String(e) }; }
    if (res?.ok) return res;
    if (!shouldRetry(res) || i === attempts - 1) return res;
    const wait = Math.max(retryAfterMs(res), backoffFor(i, backoff));
    log(`[${label}] 发送失败(${res.thrown ? res.message : "code " + res.error_code}),${wait}ms 后第 ${i + 1} 次重试`);
    await sleep(wait);
  }
  return res;
}
