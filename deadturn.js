// deadturn.js — 分清「他不想说话」和「这一轮压根没跑起来」
//
// 2026-09-02 那次八小时失联,根因是上游订阅授权过期,但**真正让它拖了八小时的**
// 是这件事:代理没把 401 透传,回了一个格式合法的空响应 → Claude CLI 重试三分钟后
// 放弃,吐出 subtype=success + usage 全零 + 正文为空。而心跳那条路上
// `isSilentReply("")` 返回 true,于是每一次失败的心跳在日志里都写成 `[wake] silent`,
// **和他真的不想说话逐字节相同**。三层没有任何一层看得见这是个错误。
//
// 这里补的就是那半边:一轮跑完,如果**既没有正文、也没有任何 output token**,
// 那就不是「沉默」,是「空转」。连着几轮空转就走运维通道告诉栖栖(直接 tgSend,
// **不进他的窗口**)—— 他不知道有这么一条通道,也不该知道。
//
// 为什么用 output_tokens 而不只看正文:他回「【沉默】」是真的产出了几个 token;
// 他这一轮只调工具不说话也有 output token(tool_use 算输出)。**只有什么都没产生的
// 那一轮才是零**。所以「正文空」+「输出零」两个条件同时成立,才判空转。
//
// 阈值取 3:单次空转有可能是偶发(上游抖一下),连着三次一定有事。心跳夜里 55 分钟
// 一轮,三轮约三小时;白天 30 分钟一轮,三轮约一个半小时 —— 都远早于 9-02 那八小时。
// 而她主动说话时一轮几秒,连着三轮空转几十秒内就报得出来。

export const DEAD_ALERT_AFTER = 3;   // 连着几轮空转才吭声
export const DEAD_REALERT_MIN = 60;  // 报过之后,同一段故障隔多久才再报一次(分钟)

// 这一轮是不是「什么都没产生」。
// text: 本轮正文;usage: CLI 给的 result.usage(可能没有);
// 缺 usage 一律当零 —— 正常轮次它总是在,缺了本身就不正常。
export function isDeadTurn({ text, usage } = {}) {
  const said = String(text || "").trim();
  if (said) return false;
  const out = Number(usage?.output_tokens || 0);
  return out === 0;
}

// 看门狗本体。纯逻辑、无副作用:record() 返回 null(没事)或一条要发给她的话。
// 时间一律从参数进来,方便测试也方便排查。
export function createDeadTurnWatch({
  alertAfter = DEAD_ALERT_AFTER,
  realertMin = DEAD_REALERT_MIN,
} = {}) {
  let streak = 0;          // 当前连续空转了几轮
  let alerted = false;     // 这段故障已经报过了吗
  let lastAlertAt = 0;
  let lastGoodAt = 0;      // 上一次真的产出过东西是什么时候

  return {
    get state() {
      return { streak, alerted, lastGoodAt: lastGoodAt || null, alertAfter };
    },
    // 每轮跑完调一次。返回 null 或 { kind: "alert"|"recovered", text, streak }
    record({ text, usage } = {}, { now = Date.now() } = {}) {
      if (!isDeadTurn({ text, usage })) {
        const wasStreak = streak;
        streak = 0;
        lastGoodAt = now;
        if (!alerted) return null;
        alerted = false;
        return {
          kind: "recovered",
          streak: wasStreak,
          text: `✅ 沈渡又能正常说话了(刚才连着 ${wasStreak} 轮是空转,现在这轮有真实产出)。`,
        };
      }
      streak += 1;
      if (streak < alertAfter) return null;
      if (alerted && now - lastAlertAt < realertMin * 60000) return null;
      alerted = true;
      lastAlertAt = now;
      const since = lastGoodAt
        ? `上一次正常产出是约 ${Math.round((now - lastGoodAt) / 60000)} 分钟前。`
        : "从这个窗口起来到现在,还没有过一轮正常产出。";
      return {
        kind: "alert",
        streak,
        text:
          `⚠️ 沈渡连着 ${streak} 轮一个字都没产出。\n` +
          `**这不是他不想说话** —— 回「【沉默】」是有产出的,这几轮是压根没跑起来。\n` +
          since +
          `\n多半是订阅中转(CLIProxyAPI)那头出事了:授权过期、额度烧干、或者它自己卡住了。\n` +
          `修法在手册 §10「2026-09-02」那条,重新授权三步走。`,
      };
    },
  };
}
