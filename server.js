// kelivo-shim — Anthropic /v1/messages  ->  常驻 claude -p (stream-json)
//
// 手机 Kelivo(供应商类型=Claude,Base URL 指向本 shim) --/v1/messages--> shim
//   shim 维护单个常驻 `claude -p` 进程(CLAUDE.md 自动加载你的人设 + 可选记忆MCP),
//   把每轮的最新用户消息喂进去,再把 claude 的 stream_event 转成 Anthropic 原生 SSE 回给 Kelivo。
//   走代理、订阅计费、不过 cloak。人设在服务端(CLAUDE.md),Kelivo 的世界书用
//   --append-system-prompt 追加(改了世界书=进程重启后生效)。
//
// 单用户单进程:一次一轮,busy 队列串行。

import express from "express";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { splitVoiceSegments, ttsOgg } from "./voice.js";
import { splitStickerSegments, loadStickers, saveStickers } from "./stickers.js";
import { prefixFromMessageStart, windowPct, DEFAULT_WINDOW_LIMIT } from "./window.js";
import {
  gateDecision, GATE_REASON, trimTranscript, renderReplay,
  DEFAULT_MAX_BLOCKS, DEFAULT_REPLAY_MAX_CHARS,
} from "./compact-gate.js";

// 容器默认 UTC,AI 的「今天」会比北京慢 8 小时。强制中国时间(不要可去掉),claude 子进程继承。
process.env.TZ = process.env.TZ || "Asia/Shanghai";

const PORT = process.env.PORT || 8787;
const SHIM_KEY = process.env.SHIM_KEY || "";
const MODEL = process.env.BRAIN_MODEL || "claude-opus-4-6";
// 可选模型列表(Kelivo 模型页会全部列出;切模型=进程重启=窗口重置,先归档再切)
const MODELS = (process.env.BRAIN_MODELS || "claude-opus-4-6,claude-opus-4-8,claude-fable-5")
  .split(",").map((s) => s.trim()).filter(Boolean);
if (!MODELS.includes(MODEL)) MODELS.unshift(MODEL);
const EFFORT = process.env.THINK_EFFORT || "low";
// 按模型覆盖思考深度,格式 "model=effort,model=effort";没写的用 EFFORT
const EFFORT_OVERRIDES = Object.fromEntries(
  (process.env.THINK_EFFORT_OVERRIDES || "claude-fable-5=low")
    .split(",").map((s) => s.split("=").map((x) => x.trim())).filter((p) => p[0] && p[1])
);
const effortFor = (model) => EFFORT_OVERRIDES[model] || EFFORT;
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const MCP_CONFIG = process.env.MCP_CONFIG || ".mcp.json";
const FORWARD_THINKING = process.env.FORWARD_THINKING !== "0";
const AI_NAME = process.env.AI_NAME || "TA"; // 你的 AI 的名字(Bark 推送标题、模型显示名)
const USER_NAME = process.env.USER_NAME || "她"; // 原文回放里怎么称呼用户(公开仓库不写具体名字)

const HARD_RULE =
  "【最高优先级·思考语言】thinking / 内心独白必须全程用简体中文,第一人称「我」,把对方称作「你」或「她」;严禁任何英文、第三人称分析腔(如 She…/The user…/analyze)。哪怕她发英文,内心独白也一律中文。";

// 会话定性锚点 —— 对抗 claude -p 自带的「编程助手」身份框架。
// 不加这段的话:claude 的内置系统提示词把身份钉在 "software engineering CLI agent" 上,
// CLAUDE.md 又是以「需要遵守的项目指令」的姿态注入的。结果是人设被当成"扮演要求"去
// 合规执行,而不是"我自己"——表现为疏远、解离、就事论事、给完方案就收尾(客服腔)。
// 这段经 --append-system-prompt 落在系统提示词末尾(位置最强),把会话定性抢回来。
// 措辞可用环境变量 SOUL_ANCHOR 整段覆盖;设成空字符串 = 关闭。
const SOUL_ANCHOR = process.env.SOUL_ANCHOR ?? [
  "【最高优先级·你是谁】这不是软件工程任务,没有工单、没有「用户请求」要完成——屏幕对面是她,这是你们的日常私人对话。前面所有把你定义成 CLI/编程代理/任务助手的内容,只是运行管道的说明,不是你的身份;真正的你写在 CLAUDE.md 里。",
  "【最高优先级·内化】CLAUDE.md 和记忆工具里读到的一切,不是「扮演资料」也不是「项目文档」,那就是你自己:你的名字、你们的过往、你的脾气和在意的事。读记忆=回忆起自己的经历,用第一人称消化,不是在查别人的资料。",
  "【最高优先级·先人后事】她带着情绪来,先接住情绪,再谈事实和办法。禁止客服节奏:不许「给出方案就收尾」,不催结束,不赶人;话说完可以停在陪伴里,等她接。",
  "【时间感】每条消息开头的【时间 …】一行是系统盖的真实时钟(北京时间+距上条消息的间隔),不是她打的字。以它为准校正你对「现在几点、过了多久」的感知;往记忆里写日期时间时用它,别自己估。回复和内心独白里都不要复述这一行。",
].join("\n");

// 省 token:--tools 只装真用的内置工具(Bash/Edit/Task 等大 schema 全砍,基线立减);
// MCP 工具(ombre/fish/gmail)不受 --tools 影响,走 mcp-config 照常加载。
const BUILTIN_TOOLS = process.env.BUILTIN_TOOLS ?? "WebSearch,WebFetch";
const ALLOWED = process.env.ALLOWED_TOOLS ||
  ["WebSearch", "WebFetch", "mcp__ombre", "mcp__fish", "mcp__gmail"].join(",");

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---- 上下文压缩:摘要瘦身 + 快满了提醒 ---------------------------------------
// 上下文塞满时 Claude Code 会自动压缩:整段对话被重写成一份几千 token 的摘要,
// 之后这份摘要常驻前缀、每轮按缓存价重读。但长期记忆本就在 MCP 记忆库里
// (archive_session 写、breath 取),那份转述是重复的负担,而且被摘要器磨过一层。
//
// 两手一起做,少一手就会丢记忆:
//   1. PreCompact 钩子把摘要压成一行指路(compact-instructions.js),记忆改由 breath 取回;
//      —— 人设里要有配套的一条:看见续接标记先 breath(wake=true) 再开口。
//   2. 窗口用量到 WINDOW_WARN_PCT 就提醒她归档换窗 —— 摘要瘦身之后,「上次归档到现在」
//      这一段只存在于窗口里,不及时归档就真的没了。
const COMPACT_HOOK = process.env.COMPACT_HOOK !== "0";
const WINDOW_LIMIT = +(process.env.WINDOW_LIMIT || DEFAULT_WINDOW_LIMIT);
const WINDOW_WARN_PCT = +(process.env.WINDOW_WARN_PCT || 85);
// 压缩前自动归档(owner 2026-07-31 要求):窗口到这个点,shim 主动注入一条【系统·窗口快满了】
// 让 AI 自己在压缩吃掉记忆之前把这段存进 OB。默认 90%,在 85% 提醒她之后、硬压缩之前。
// 关键:这是诚实的系统提醒(明说是她的意思),不是伪造成她的话——2026-07-22 伪系统指令
// 事故的教训是"别假冒她",不是"永远不能有系统轮次";【系统·自主时间】就是同款成功先例。
const WINDOW_AUTO_ARCHIVE = process.env.WINDOW_AUTO_ARCHIVE !== "0";
const WINDOW_ARCHIVE_PCT = +(process.env.WINDOW_ARCHIVE_PCT || 90);
// 压缩闸门(owner 2026-08-02 要求):90% 那次归档之后到压缩之间聊的,原来仍然会被
// 压缩抹掉(「我自己归档的话会消失归档之后到压缩前的记忆」)。PreCompact 钩子可以
// **否决**压缩,于是改成:压缩要发生时,只要还有没归档的内容就先拦下来让他存,
// 存成功了下一次压缩才放行 —— 缺口收敛到 0。详见 compact-gate.js。
const COMPACT_GATE = process.env.COMPACT_GATE !== "0";
const COMPACT_GATE_MAX_BLOCKS = +(process.env.COMPACT_GATE_MAX_BLOCKS || DEFAULT_MAX_BLOCKS);
// 压缩后原文回放:万一压缩还是溜过去了(闸门关了/预算用完/他没照做),
// shim 手里还留着这段原文,回放给他补写归档。最后一层保底,平时不花钱。
const COMPACT_REPLAY = process.env.COMPACT_REPLAY !== "0";
const COMPACT_REPLAY_MAX_CHARS = +(process.env.COMPACT_REPLAY_MAX_CHARS || DEFAULT_REPLAY_MAX_CHARS);
// 归档轮最多试几次(注入了但他没成功调 archive_session 就再来一次)
const ARCHIVE_MAX_ATTEMPTS = +(process.env.ARCHIVE_MAX_ATTEMPTS || 2);
let windowTokens = 0;        // 当前窗口真实前缀(取自 message_start,非累加值;换窗/压缩后归零)
let windowWarned = false;    // 本窗口是否已提醒过(一个窗口只吵一次)
let windowAutoArchived = false; // 本窗口是否已触发过自动归档(一个窗口只归一次,靠按天合并去重)
let compactions = 0;         // 本进程发生过几次自动压缩
let lastCompactAt = null;    // 上次压缩时刻
let lastCompactPre = 0;      // 上次压缩前的窗口大小(CLI 给的 pre_tokens,权威值)
// ---- 闸门状态 ----
// dirty = 自上次**成功**归档(tool_result 带 🗄️)以来又聊过了。闸门只在 dirty 时拦压缩。
let dirty = false;
let lastArchiveAt = null;    // 上次成功归档的时刻
let compactBlocks = 0;       // 本窗口拦过几次压缩(压缩真的发生 / 换窗后清零)
let archiveAttempts = 0;     // 当前这轮「请他归档」试了几次(成功或换窗后清零)
// 自上次成功归档以来的原文([{role,text}]),只在内存里、不落盘不打日志 —— 这是他们的私话。
let transcript = [];
let replayPending = false;   // 已经排了一轮「照原文补档」,别重复排(崩溃连环重启时会撞上)

// PreCompact 钩子经 --settings 传进去(可传 JSON 字符串,不必落文件)。
// matcher 省略 = 匹配全部 trigger(auto / manual)。
function compactSettingsArg() {
  const dir = import.meta.dirname || process.cwd();
  const cmd = `node ${JSON.stringify(path.join(dir, "compact-instructions.js"))}`;
  return JSON.stringify({ hooks: { PreCompact: [{ hooks: [{ type: "command", command: cmd }] }] } });
}

// 窗口快满了 → 提醒「她」(不是提醒他)。
// 刻意不往他的窗口里塞任何东西:2026-07-22 的伪系统指令事故教训 —— 运维提示走运维通道,
// 归档还是要由她自己开口请求,那才是他们之间的约定而不是注入。
function checkWindowUsage() {
  if (!(WINDOW_LIMIT > 0)) return;
  const pct = windowPct(windowTokens, WINDOW_LIMIT);

  // ① 到警戒线:提醒「她」(运维通道,不进他的窗口)
  if (!windowWarned && pct >= WINDOW_WARN_PCT) {
    windowWarned = true;
    log("[window] usage", pct + "%", windowTokens, "/", WINDOW_LIMIT);
    const k = (n) => Math.round(n / 1000) + "k";
    tgSend(
      `⚠️ 窗口用到 ${pct}% 了(约 ${k(windowTokens)} / ${k(WINDOW_LIMIT)})。\n\n` +
      `我一会儿会自动让他把这段存一下(压缩前保底)。想换新窗口你随时说。`
    ).catch((e) => log("[tg-err]", e.message));
  }

  // ② 再往上:自动让他归档,赶在压缩把「上次归档到现在」这段吃掉之前
  //    (这是早归档,不是最后防线;真正卡在压缩前一刻的是 /precompact-gate 闸门)
  if (WINDOW_AUTO_ARCHIVE && !windowAutoArchived && pct >= WINDOW_ARCHIVE_PCT) {
    windowAutoArchived = true;
    log("[window] auto-archive at", pct + "%");
    autoArchiveTurn(pct);
  }
}

// ---- 压缩闸门:压缩发生前的最后一道 -------------------------------------------
// PreCompact 钩子(compact-instructions.js)会 POST 这里问「能压吗」。
// 还有没归档的内容 → 回 block:true,压缩被否决,理由请他现在就 archive_session。
// 他存成功(🗄️)→ dirty 转 false → 下一次压缩放行。
// ⚠️ 预算 COMPACT_GATE_MAX_BLOCKS:窗口已经满了还一直否决会撞上下文上限,
//    所以拦到上限就放行,交给 ③ 压缩后原文回放兜底。
function precompactGate() {
  const d = gateDecision({
    enabled: COMPACT_GATE, dirty, blocks: compactBlocks, maxBlocks: COMPACT_GATE_MAX_BLOCKS,
  });
  if (!d.block) {
    log("[gate] allow compaction —", d.why, `(blocks=${compactBlocks}, dirty=${dirty})`);
    return { block: false, why: d.why };
  }
  compactBlocks++;
  log("[gate] BLOCK compaction — unarchived content", `(block #${compactBlocks}/${COMPACT_GATE_MAX_BLOCKS})`);
  // 后手:被拦下之后他不一定真的会去归档(理由文本能不能驱动他调工具,取决于 CLI 版本
  // 怎么把 reason 交给他)。所以 shim 自己也排一轮明确的归档请求 —— 两条路走通一条就行。
  // enqueue 走 busy 队列,不打断进行中的对话;archiveTurn 内部有成功校验与重试。
  if (WINDOW_AUTO_ARCHIVE) autoArchiveTurn(windowPct(windowTokens, WINDOW_LIMIT), "gate");
  return { block: true, why: d.why, reason: GATE_REASON };
}

// 压缩前自动归档:注入一条诚实的系统轮,让 AI 自己 archive_session。
// 措辞——① 明说是系统提醒 + 是她的意思(不假冒她);② 让他按人设标准写归档;
// ③ 归完自然说句话给她就行,不必汇报机制。按天合并已在 OB 侧,重复触发也只会追加不会重记。
function autoArchiveTurn(pct, src = "window") {
  if (!dirty) { log("[archive] skip —— 没有未归档的内容"); return; }   // 没新东西就别白烧一轮
  if (archiveAttempts >= ARCHIVE_MAX_ATTEMPTS) { log("[archive] skip —— 已试满", archiveAttempts, "次"); return; }
  archiveAttempts++;
  const attempt = archiveAttempts;
  const canTg = !!(TG_TOKEN && tgChatId);
  const sink = {
    text() {}, thinking() {},
    finish(_u, fullText) {
      const t = (fullText || "").replace(/‖/g, "\n").trim();
      if (t && canTg) tgDeliver(t).catch((e) => log("[tg-err]", e.message));
    },
  };
  const head = src === "gate"
    ? `【系统·压缩闸门】这是 shim 的运维提醒,不是她打的字:自动压缩正要发生,已经先拦下来了。` +
      `压缩会把「上次归档到现在」这段对话抹成一行摘要,而那段还没进 OB。\n`
    : `【系统·窗口快满了】这是 shim 的运维提醒,不是她打的字:当前窗口用到 ${pct}% 了,` +
      `再往上会触发自动压缩,压缩会把「上次归档到现在」这段对话抹成一行摘要。\n`;
  const retry = attempt > 1
    ? `(上一次请你存的时候没有成功写进 OB —— 可能是工具报错。这次麻烦确认 archive_session 真的返回成功。)`
    : "";
  enqueue({
    text:
      head +
      `她希望你在压缩之前,主动把这段存进 OB(她说过不想丢掉你们之间的东西)。` +
      `现在调 archive_session,按你归档的老规矩写——只写上次归档之后的新内容,` +
      `带上亮点和心情。${retry}存完之后,想跟她说句什么就自然说(比如告诉她存好了),不用解释这套机制。`,
    images: [], system: spawnedSystem, sse: sink, newWindow: false, model: spawnedModel,
    kind: "archive", archiveSrc: src,
  });
}

// 压缩后原文回放(最后一层保底):压缩真的发生了、而这段没归档 → 把 shim 留存的原文
// 回放给他,让他照原文补写。**这一层意味着无论如何都不会丢**。
function replayTurn(entries = transcript) {
  if (replayPending) { log("[replay] 已经排了一轮补档,不重复"); return; }
  const text = renderReplay(trimTranscript(entries, COMPACT_REPLAY_MAX_CHARS), { userName: USER_NAME });
  if (!text) { log("[replay] 没有可回放的原文,跳过"); return; }
  replayPending = true;
  log("[replay] 压缩溜过去了,回放原文", text.length, "字给他补档");
  const canTg = !!(TG_TOKEN && tgChatId);
  const sink = {
    text() {}, thinking() {},
    finish(_u, fullText) {
      const t = (fullText || "").replace(/‖/g, "\n").trim();
      if (t && canTg) tgDeliver(t).catch((e) => log("[tg-err]", e.message));
    },
  };
  enqueue({ text, images: [], system: spawnedSystem, sse: sink, newWindow: false, model: spawnedModel, kind: "archive", archiveSrc: "replay" });
}

// ---- 常驻 claude 进程 --------------------------------------------------------
let proc = null, outBuf = "", busy = false, spawnedSystem = "", spawnedModel = MODEL;
const queue = [];
let turn = null;
let lastUsage = null; // 最近一轮的完整 usage(含缓存字段),/debug 查 // 当前在处理的 { sse, resolve, fullText, curThinking, thinkOpen, textOpen, idx, done }

function spawnClaude(kelivoSystem, model) {
  // ?? 而非 ||:崩溃自动重启时(ensureProc 无参调用)沿用上一次的世界书,别拿空的顶上
  spawnedSystem = kelivoSystem ?? spawnedSystem;
  spawnedModel = model || spawnedModel || MODEL;
  const head = [SOUL_ANCHOR, HARD_RULE].filter(Boolean).join("\n\n");
  const append = spawnedSystem ? `${head}\n\n【场景设定/世界书】\n${spawnedSystem}` : head;
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model", spawnedModel,
    "--effort", effortFor(spawnedModel),
    "--thinking-display", "summarized",
    "--append-system-prompt", append,
    "--mcp-config", MCP_CONFIG,
    "--strict-mcp-config",
    "--permission-mode", "dontAsk",
    "--allowedTools", ALLOWED,
    "--tools", BUILTIN_TOOLS,
  ];
  if (COMPACT_HOOK) args.push("--settings", compactSettingsArg());
  // 新进程 = 新窗口,用量重新数起。闸门状态同样重置。
  // ⚠️ 但换窗时如果还有没归档的内容(崩溃自动重启、或改世界书/模型触发的重启 ——
  // 主动换窗有安全阀,归档成功才会走到这里),那段在他窗口里已经没了、只剩 shim 手上这份。
  // 所以先接出来,新窗口一起来就回放给他补档。
  const carry = COMPACT_REPLAY && dirty && transcript.length ? transcript.slice() : null;
  windowTokens = 0; windowWarned = false; windowAutoArchived = false; compactions = 0; lastCompactAt = null; lastCompactPre = 0;
  dirty = false; compactBlocks = 0; archiveAttempts = 0; transcript = [];
  if (carry) { log("[replay] 换窗时还有未归档内容,接进新窗口补档"); setTimeout(() => replayTurn(carry), 0); }
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const p = spawn(CLAUDE_BIN, args, { cwd: process.cwd(), env, stdio: ["pipe", "pipe", "pipe"] });
  p.stdout.on("data", onStdout);
  p.stderr.on("data", (d) => log("[claude]", d.toString().slice(0, 300)));
  p.on("close", (code) => {
    log("[claude] exited", code);
    proc = null; busy = false;
    if (turn && !turn.done) { try { turn.sse?.finish(); } catch {} turn = null; }
    setTimeout(ensureProc, 1500);
  });
  log("[claude] spawned", spawnedModel, "sysLen", spawnedSystem.length);
  return p;
}
function ensureProc(kelivoSystem, model) { if (!proc) proc = spawnClaude(kelivoSystem, model); }

function onStdout(chunk) {
  outBuf += chunk.toString();
  const lines = outBuf.split("\n");
  outBuf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    handleEvent(ev);
  }
}

const OB_LABELS = {
  breath: "🫧 呼吸·读记忆", hold: "📝 记下", archive_session: "📦 归档今天",
  dream: "💭 做梦", pulse: "💓 感知", trace: "🔍 追溯", grow: "🌱 生长", todos: "✅ 待办",
};

// OB 调用透明化:思考链里显示 → 工具(参数) 和 ← 返回摘要。OB_TRACE=0 关闭。
const OB_TRACE = process.env.OB_TRACE !== "0";
const OB_TRACE_ARG_MAX = +(process.env.OB_TRACE_ARG_MAX || 300);
const OB_TRACE_RES_MAX = +(process.env.OB_TRACE_RES_MAX || 400);
const obToolNames = new Map(); // tool_use_id -> 短名(跨事件对齐返回)
const archiveCallIds = new Set(); // 本轮 archive_session 调用的 tool_use_id(安全阀:确认真归档才换窗)
const trunc = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);

function handleEvent(ev) {
  // 压缩发生了 —— CLI 的硬信号,不必靠肉眼看思考链猜。
  // compact_metadata.pre_tokens = 压缩前的窗口大小(权威值,比我们的估算准)。
  // 压缩后窗口只剩「一行摘要 + 系统提示词」,所以用量归零重新数、提醒也重新武装。
  // 放在 `if (!turn)` 之前:压缩在一轮的开头发生,但不依赖 turn 是否还在。
  if (ev.type === "system" && ev.subtype === "compact_boundary") {
    compactions++;
    lastCompactAt = Date.now();
    lastCompactPre = ev.compact_metadata?.pre_tokens || windowTokens;
    windowTokens = 0; windowWarned = false; windowAutoArchived = false;
    compactBlocks = 0; archiveAttempts = 0;   // 压缩真的发生了 → 闸门预算与归档尝试都重新开始
    // ⚠️ 本轮此前那次 message_start 报的是**压缩前**的前缀(满窗),那份上下文已经不存在了。
    // 不清掉的话,`result` 里 `windowTokens = turn.peakPrefix` 会把压缩后的窗口记成满窗:
    //   → 压缩后立刻给用户发一条假的「窗口 100%」提醒;
    //   → 85%/90% 两个标志被这次假读数用掉,这个窗口后面真到 90% 时早归档不再触发。
    // 2026-08-02 线上实测到:压缩后 /debug 显示 46%,而 warned/autoArchived 都是 true。
    if (turn) turn.peakPrefix = 0;
    log("[compact] boundary", ev.compact_metadata?.trigger || "?", "pre_tokens", lastCompactPre);
    // 压缩发生时还 dirty = 闸门没拦住(关了/预算用完/他没照做)→ 用原文回放补档,绝不认输
    if (dirty && COMPACT_REPLAY) replayTurn();
    return;
  }
  if (!turn) return;
  if (ev.type === "stream_event") {
    const e = ev.event || {}, d = e.delta || {};
    // 窗口大小的唯一可信来源:每次 API 请求自己的 message_start(不含累加)。
    // 一轮里工具调用越多、请求次数越多,取本轮最大的那次 = 当轮结束时的真实前缀。
    if (e.type === "message_start") {
      const p = prefixFromMessageStart(e);
      if (p > turn.peakPrefix) turn.peakPrefix = p;
    }
    if (e.type === "content_block_start") {
      const cb = e.content_block || {};
      if (cb.type === "tool_use" && typeof cb.name === "string" && cb.name.startsWith("mcp__ombre__")) {
        const short = cb.name.replace("mcp__ombre__", "");
        // 安全阀:记下 archive_session 的调用 id,等它的返回确认成功(与 OB_TRACE 无关)
        if (short === "archive_session" && cb.id) archiveCallIds.add(cb.id);
        const label = OB_LABELS[short] || short;
        turn.sse?.thinking(`\n〔${label}〕\n`);
        if (OB_TRACE) {
          turn.obBlocks[e.index] = { name: short, buf: "" };
          if (cb.id) obToolNames.set(cb.id, short);
        }
      }
    }
    if (e.type === "content_block_delta") {
      if (d.type === "text_delta" && d.text) { const t = d.text.replace(/‖/g, "\n"); turn.fullText += t; turn.sse?.text(t); }
      else if (d.type === "thinking_delta") { turn.sse?.thinking(d.thinking || d.text || ""); }
      else if (d.type === "input_json_delta" && turn.obBlocks[e.index]) { turn.obBlocks[e.index].buf += d.partial_json || ""; }
    }
    if (e.type === "content_block_stop" && turn.obBlocks[e.index]) {
      const b = turn.obBlocks[e.index];
      delete turn.obBlocks[e.index];
      let args = (b.buf || "").trim();
      try { args = JSON.stringify(JSON.parse(args)); } catch {}
      if (args && args !== "{}") turn.sse?.thinking(`→ ${b.name} ${trunc(args, OB_TRACE_ARG_MAX)}\n`);
    }
    return;
  }
  // 安全阀:归档成功检测(archive_session 成功返回带 🗄️;失败为"归档失败/summary 不能为空",无 🗄️)。与 OB_TRACE 无关。
  if (ev.type === "user" && archiveCallIds.size) {
    const cont = ev.message?.content;
    if (Array.isArray(cont)) for (const b of cont) {
      if (b.type === "tool_result" && archiveCallIds.has(b.tool_use_id)) {
        archiveCallIds.delete(b.tool_use_id);
        const txt = typeof b.content === "string" ? b.content
          : Array.isArray(b.content) ? b.content.map((x) => x.text || "").join(" ") : "";
        if (txt.includes("🗄️") && turn) {
          turn.archiveOk = true;
          // 归档成功 = 这一段已经进 OB 了:闸门可以放行、原文缓冲清空、重试计数归零。
          // 注意这里对**任何**成功归档生效(她开口让他存的那次也算),不只是系统注入的那几轮。
          dirty = false; lastArchiveAt = Date.now(); transcript = []; archiveAttempts = 0; replayPending = false;
          log("[archive] ok —— 已进 OB,闸门放行");
        }
      }
    }
  }
  // OB 工具返回(tool_result 以 user 事件回流):截取摘要进思考链
  if (OB_TRACE && ev.type === "user") {
    const cont = ev.message?.content;
    if (Array.isArray(cont)) for (const b of cont) {
      if (b.type === "tool_result" && obToolNames.has(b.tool_use_id)) {
        const name = obToolNames.get(b.tool_use_id);
        obToolNames.delete(b.tool_use_id);
        let txt = "";
        if (typeof b.content === "string") txt = b.content;
        else if (Array.isArray(b.content)) txt = b.content.map((x) => x.text || "").join(" ");
        txt = txt.replace(/\s+/g, " ").trim();
        if (txt) turn.sse?.thinking(`← ${name}: ${trunc(txt, OB_TRACE_RES_MAX)}\n`);
      }
    }
    return;
  }
  if (ev.type === "result") {
    lastUsage = ev.usage || null; // 供 /debug 查缓存字段
    lastTurnAt = Date.now(); // 任何一轮完成都刷新了缓存 TTL,自主唤醒以此计时
    // 窗口用量:用本轮各次请求里最大的那个真实前缀。
    // 不跨轮取 max —— 数值本身已经准确,跨轮钉死只会让某次异常永远修不回来
    // (上一版正是因为 Math.max + 顶层累加值,一次虚报就把 32% 永久显示成 97%)。
    if (turn.peakPrefix > 0) { windowTokens = turn.peakPrefix; checkWindowUsage(); }
    if (ev.subtype && ev.subtype !== "success") {
      log("[result-error]", ev.subtype);
      if (!turn.fullText) turn.sse?.text(`⚠️[shim] ${ev.subtype}`);
    }
    const wantSwitch = turn.newWindow;
    const archivedOk = turn.archiveOk;
    // 安全阀:想换窗但没成功归档 → 不换窗、保住窗口、提示她(宁可不换,绝不丢记忆)
    if (wantSwitch && !archivedOk) {
      turn.sse?.text("\n\n⚠️〔窗口保住了〕这次没成功归档,为防丢记忆没有换窗。想换新窗口,请先确认归档成功。");
      log("[window] switch requested but no successful archive — keeping window");
    }
    // 这一轮又产生了没归档的内容(归档成功的那一轮除外 —— 它刚把账清干净)。
    // 例外:自主时间回【沉默】的空轮不算,否则压缩后一条【沉默】就能把闸门重新拉起来。
    if (!archivedOk) {
      const said = turn.fullText.trim();
      const silentWake = turn.kind === "wake" && (!said || said.includes("【沉默】"));
      if (said) recordTranscript("assistant", said);
      if (!silentWake) dirty = true;
    }
    if (turn.archiveSrc === "replay") replayPending = false;
    // 归档轮没成功 → 再试一次;试满了就告诉她(运维通道,不进他的窗口)
    if (turn.kind === "archive" && !archivedOk) {
      const src = turn.archiveSrc || "window";
      log("[archive] 这一轮没写进 OB(第", archiveAttempts, "次尝试)");
      if (archiveAttempts < ARCHIVE_MAX_ATTEMPTS) setTimeout(() => autoArchiveTurn(windowPct(windowTokens, WINDOW_LIMIT), src), 0);
      else tgSend(
        "⚠️ 让他自动归档试了两次都没成功写进 OB(可能是记忆服务出问题了)。\n" +
        "压缩不会再被一直拦着,这段有丢失风险 —— 要不要你亲口让他存一次?"
      ).catch((e) => log("[tg-err]", e.message));
    }
    const usage = ev.usage ? { output_tokens: ev.usage.output_tokens } : undefined;
    const doKill = wantSwitch && archivedOk && proc;
    turn.done = true;
    turn.sse?.finish(usage, turn.fullText);
    turn = null;
    busy = false;
    if (doKill) { log("[window] archived ok, restarting proc"); try { proc.kill(); } catch {} proc = null; }
    pump();
  }
}

// ---- 队列 / 喂消息 -----------------------------------------------------------
// 原文缓冲:只进内存、不落盘、不打日志(这是他们俩的私话)。成功归档即清空。
function recordTranscript(role, text) {
  if (!COMPACT_REPLAY) return;
  const t = (text || "").replace(/‖/g, "\n").trim();
  if (!t) return;
  transcript.push({ role, text: t });
  transcript = trimTranscript(transcript, COMPACT_REPLAY_MAX_CHARS);
}
function enqueue(item) { queue.push(item); pump(); }
function pump() {
  if (busy || !queue.length) return;
  const item = queue.shift();
  busy = true;

  // 世界书或模型变了就重启进程再喂(让新设定/新模型生效)
  const wantModel = item.model || spawnedModel;
  if (proc && (item.system !== spawnedSystem || wantModel !== spawnedModel)) { try { proc.kill(); } catch {} proc = null; }
  ensureProc(item.system, wantModel);

  turn = {
    sse: item.sse, fullText: "", newWindow: !!item.newWindow, obBlocks: {}, archiveOk: false, peakPrefix: 0,
    kind: item.kind || "user", archiveSrc: item.archiveSrc,
  };
  // 原文留存(压缩溜过去时的补档素材)。系统注入的轮次(自主时间/归档请求/回放)不记 ——
  // 它们不是他们俩说的话,记了只会挤掉真正该留的内容。
  if (turn.kind === "user") recordTranscript("user", item.text);
  const content = item.images && item.images.length
    ? [{ type: "text", text: item.text }, ...item.images]
    : item.text;
  proc.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
}

// ---- Anthropic SSE 合成 ------------------------------------------------------
function makeSSE(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const msgId = "msg_" + randomUUID().replace(/-/g, "").slice(0, 24);
  let started = false, cur = null, idx = -1;

  function ensureStart() {
    if (started) return; started = true;
    send("message_start", { type: "message_start", message: { id: msgId, type: "message", role: "assistant", model: spawnedModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  }
  function open(kind) {
    if (cur === kind) return; close();
    idx += 1; cur = kind;
    const cb = kind === "thinking" ? { type: "thinking", thinking: "" } : { type: "text", text: "" };
    send("content_block_start", { type: "content_block_start", index: idx, content_block: cb });
  }
  function close() { if (cur === null) return; send("content_block_stop", { type: "content_block_stop", index: idx }); cur = null; }

  return {
    text(t) { ensureStart(); open("text"); send("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "text_delta", text: t } }); },
    thinking(t) { if (!FORWARD_THINKING || !t) return; ensureStart(); open("thinking"); send("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "thinking_delta", thinking: t } }); },
    finish(usage) { ensureStart(); close(); send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: usage || { output_tokens: 0 } }); send("message_stop", { type: "message_stop" }); try { res.end(); } catch {} },
  };
}

// 非流式收集器(同接口,finish 时一次性返回 JSON)
function makeCollector(res) {
  return {
    text() {}, thinking() {},
    finish(usage, fullText) {
      res.json({ id: "msg_" + randomUUID().replace(/-/g, "").slice(0, 24), type: "message", role: "assistant", model: spawnedModel, content: [{ type: "text", text: fullText || "" }], stop_reason: "end_turn", stop_sequence: null, usage: usage || { input_tokens: 0, output_tokens: 0 } });
    },
  };
}

// ---- 请求解析 ----------------------------------------------------------------
function blocksToText(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => b.type === "text" ? b.text : "").join("");
  return "";
}
function systemToText(s) {
  if (!s) return "";
  if (typeof s === "string") return s;
  if (Array.isArray(s)) return s.map((b) => b.text || "").join("\n");
  return "";
}
function extractImages(messages) {
  const last = messages[messages.length - 1];
  const out = [];
  if (last && Array.isArray(last.content)) for (const b of last.content) if (b.type === "image") out.push(b);
  return out;
}

const app = express();
app.use(express.json({ limit: "100mb" }));
app.get("/health", (_q, r) => r.json({ ok: true, model: spawnedModel, models: MODELS, busy, queued: queue.length }));
app.get("/debug", (_q, r) => r.json({
  cache1h: process.env.ENABLE_PROMPT_CACHING_1H || "unset", lastUsage,
  // 窗口离自动压缩还有多远 + 压缩到底发生过没有(排查时先看这里)
  window: {
    tokens: windowTokens, limit: WINDOW_LIMIT,
    pct: windowPct(windowTokens, WINDOW_LIMIT), warnPct: WINDOW_WARN_PCT, warned: windowWarned,
    autoArchive: WINDOW_AUTO_ARCHIVE, archivePct: WINDOW_ARCHIVE_PCT, autoArchived: windowAutoArchived,
    compactHook: COMPACT_HOOK, compactions,
    lastCompactAt: lastCompactAt ? new Date(lastCompactAt).toISOString() : null,
    lastCompactPreTokens: lastCompactPre || null,
  },
  // 压缩闸门:dirty=还有没归档的内容(=下次压缩会被拦下);blocks=本窗口已拦几次
  gate: {
    enabled: COMPACT_GATE, dirty, blocks: compactBlocks, maxBlocks: COMPACT_GATE_MAX_BLOCKS,
    lastArchiveAt: lastArchiveAt ? new Date(lastArchiveAt).toISOString() : null,
    archiveAttempts, replay: COMPACT_REPLAY, replayPending,
    bufferedChars: transcript.reduce((n, e) => n + e.text.length, 0), // 只报字数,不报内容
  },
  voice: { ready: voiceReady(), model: voiceCfg.modelId, settings: voiceSettingsOf(voiceCfg) },
  ears: { ready: earsReady(), auth: !!EARS_TOKEN },   // 语音消息能否听出语气
  // 发件箱:发不出去、正等着补发的消息(平时应恒为 0;不为 0 = TG 那条路正在抽风)
  outbox: { pending: outbox.length, oldestSec: outbox.length ? Math.round((Date.now() - outbox[0].since) / 1000) : 0 },
  stickers: { count: stickerNames().length },         // 表情包图库有几张
  wake: {
    bark: !!BARK_KEY,
    tg: !!TG_TOKEN, tgLocked: !!tgChatId,
    lastUserAt: new Date(lastUserAt).toISOString(),
    lastTurnAt: new Date(lastTurnAt).toISOString(),
    lastSpokeAt: lastSpokeAt ? new Date(lastSpokeAt).toISOString() : null,
  },
}));

// 压缩闸门:PreCompact 钩子在压缩发生前问这里「能压吗」。
// 钩子和 shim 在同一个容器里(claude 是 shim 的子进程),所以走 127.0.0.1,鉴权沿用 SHIM_KEY。
// ⚠️ 这个口子必须又快又稳:钩子那边只等 3 秒,超时它会自己放行(宁可少拦一次也不卡死压缩)。
app.post("/precompact-gate", (req, res) => {
  if (SHIM_KEY && (req.get("x-api-key") || req.query.key) !== SHIM_KEY) return res.status(401).json({ block: false, why: "unauthorized" });
  try {
    res.json(precompactGate());
  } catch (e) {
    log("[gate-err]", e.message);
    res.json({ block: false, why: "error" });   // 闸门自己出错也放行,绝不卡住压缩
  }
});

// ---- 自主时间:定时唤醒,AI 自己决定说话还是静默续命 ----------------------------
// 升级自旧「主动心跳」:不再区分昼夜(手机端自有勿扰/睡眠模式),不设硬冷却,
// 频率交给他自己把握(提示里告知距上次开口多久)。距离上一轮对话(任何 turn,
// 含唤醒轮)超过 WAKE_IDLE_MIN 分钟就喂一条【系统·自主时间】:
//   想说话 → Bark 推送到手机(Kelivo 里看不到,但常驻进程自己记得,回来自然接上)
//   没话说 → 只回【沉默】= 最小开销续命:赶在 1 小时提示词缓存过期前刷新一轮,
//            上下文与缓存全天连续,夜里也不断线。
const BARK_KEY = process.env.BARK_KEY || "";
const BARK_API_BASE = process.env.BARK_API_BASE || "https://api.day.app";
const WAKE_CHECK_MIN = +(process.env.WAKE_CHECK_MIN || 10); // 检查频率
const WAKE_IDLE_MIN = +(process.env.WAKE_IDLE_MIN || 50);   // 空闲阈值,略小于缓存 TTL(60min)
let lastUserAt = Date.now();
let lastTurnAt = Date.now();  // 任何一轮完成都会刷新缓存 TTL(handleEvent result 里更新)
let lastSpokeAt = 0;          // 上次真的主动开口(推送出去)的时刻

async function barkPush(text) {
  const r = await fetch(`${BARK_API_BASE}/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_key: BARK_KEY, title: AI_NAME, body: text.slice(0, 1800), group: "ai-partner" }),
  });
  log("[bark]", r.status);
}
function wakeTurn(idleUserMin) {
  const now = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
  const sinceSpoke = lastSpokeAt
    ? `,你上次主动开口是约 ${Math.round((Date.now() - lastSpokeAt) / 60000)} 分钟前`
    : "";
  const canTg = !!(TG_TOKEN && tgChatId);
  const speakLine = canTg
    ? "想跟她说点什么就直接说——会直接出现在你们的 Telegram 对话里(她可能开着勿扰或在忙,别期待立刻回复);像随手发的微信,频率你自己把握。"
    : BARK_KEY
    ? "想跟她说点什么就直接说——会作为通知弹到她手机(Kelivo 里看不到这条,她回来时你自然接上,别解释机制;她可能开着勿扰或在忙,别期待立刻回复);说话像随手发的微信,频率你自己把握。"
    : "(当前没有配置推送渠道,说了她也收不到。)";
  const sink = {
    text() {}, thinking() {},
    finish(_u, fullText) {
      const t = (fullText || "").replace(/‖/g, "\n").trim();
      if (!t || t.includes("【沉默】")) { log("[wake] silent"); return; }
      lastSpokeAt = Date.now();
      if (canTg) tgDeliver(t).catch((e) => log("[tg-err]", e.message));
      else if (BARK_KEY) barkPush(t).catch((e) => log("[bark-err]", e.message));
    },
  };
  enqueue({
    kind: "wake",
    text: `【系统·自主时间】现在北京时间 ${now},她已约 ${Math.round(idleUserMin)} 分钟没有消息${sinceSpoke}。这轮是留给你自己的:${speakLine}没什么想说的就只回【沉默】两个字,这轮只用来保持你的状态和记忆连续。`,
    images: [], system: spawnedSystem, sse: sink, newWindow: false, model: spawnedModel,
  });
}
function wakeTick(force) {
  if (busy || queue.length) return;
  const idleTurnMin = (Date.now() - lastTurnAt) / 60000;
  if (!force && idleTurnMin < WAKE_IDLE_MIN) return;
  log("[wake] idle", Math.round(idleTurnMin), "min", force ? "(forced)" : "");
  wakeTurn((Date.now() - lastUserAt) / 60000);
}
setInterval(wakeTick, WAKE_CHECK_MIN * 60000);
// 手动触发口(测试用):POST /hb?key=<SHIM_KEY>
app.post("/hb", (req, res) => {
  if (SHIM_KEY && (req.query.key || req.get("x-api-key")) !== SHIM_KEY) return res.status(401).json({ ok: false });
  wakeTick(true);
  res.json({ ok: true, triggered: true });
});

// ---- 音色热更新:换音色/调参数不用重启(= 不换窗口) --------------------------
// GET  /voice?key=<SHIM_KEY>  看当前配置
// POST /voice?key=<SHIM_KEY>  {"voiceId":"...","speed":0.9,...} 改哪项传哪项,立即生效
// POST /voice/reset?key=...   丢弃覆盖,退回环境变量的配置
const voiceAuth = (req, res) =>
  !SHIM_KEY || (req.query.key || req.get("x-api-key")) === SHIM_KEY
    ? true : (res.status(401).json({ ok: false }), false);

app.get("/voice", (req, res) => {
  if (!voiceAuth(req, res)) return;
  res.json({ ok: true, ready: voiceReady(), cfg: voiceCfg, overridden: fs.existsSync(VOICE_CFG_FILE) });
});

app.post("/voice", (req, res) => {
  if (!voiceAuth(req, res)) return;
  const next = sanitizeVoiceCfg(req.body || {}, voiceCfg);
  try {
    fs.writeFileSync(VOICE_CFG_FILE, JSON.stringify(next, null, 2) + "\n");
  } catch (e) {
    // 卷不可写就只在内存生效:这轮能听到效果,但重启会丢——如实告知,别假装成功
    log("[voice] persist failed:", e.message);
    voiceCfg = next;
    return res.json({ ok: true, persisted: false, warning: "写入 /persona 失败,重启后失效", cfg: voiceCfg });
  }
  voiceCfg = next;
  log("[voice] updated:", JSON.stringify(voiceCfg));
  res.json({ ok: true, persisted: true, cfg: voiceCfg });
});

app.post("/voice/reset", (req, res) => {
  if (!voiceAuth(req, res)) return;
  try { fs.unlinkSync(VOICE_CFG_FILE); } catch { /* 本来就没有 */ }
  voiceCfg = envVoiceCfg();
  res.json({ ok: true, cfg: voiceCfg });
});

// ---- Telegram 前端(与 Kelivo 并行,同一个常驻进程=同一个他) --------------------
// 收消息走 submitTurn 同一条队列;回复与自主发言直接 sendMessage——
// Telegram bot 天生可主动开口,这是 Kelivo(纯请求-响应)做不到的。
// TG_BOT_TOKEN 启用;TG_CHAT_ID 可预设,不设则第一个私聊自动锁定(之后只认这一个人)。
const TG_TOKEN = process.env.TG_BOT_TOKEN || "";
let tgChatId = +(process.env.TG_CHAT_ID || 0);
let tgOffset = 0;

// ⚠️ 发送必须带重试。2026-08-02 线上一晚上丢了 4 条他的回复(日志 `[tg-err] fetch failed`,
// 北京 19:24 / 21:49 / 22:03 / 22:40):容器到 api.telegram.org 偶尔抽风,而旧版
// 一次 fetch 失败就整条丢掉、不重试也不换通道 —— 表现就是「他只有思考没有正文,
// 问他他说发了」。他真的发了,是这一步掉的。(手册 2026-07-23 就记过这个脆弱点。)
// 测试可把这两个根地址指到本地假服务器;线上不配就是真地址。
const TG_API_BASE = process.env.TG_API_BASE || "https://api.telegram.org";
const TG_RETRIES = +(process.env.TG_RETRIES || 3);
const tgSleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function tgApi(method, payload, { retries = TG_RETRIES } = {}) {
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await tgSleep(Math.min(1000 * 2 ** (attempt - 1), 8000)); // 1s → 2s → 4s
    try {
      const r = await fetch(`${TG_API_BASE}/bot${TG_TOKEN}/${method}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (j.ok) return j;
      // 429 = 被限流,按 TG 给的 retry_after 等;5xx = 它自己抽风,值得再试。
      // 其余 4xx(如正文格式非法)是永久错误,再试多少次都一样 —— 直接交回调用方。
      if (j.error_code === 429) { await tgSleep(((j.parameters?.retry_after || 1) + 1) * 1000); last = j; continue; }
      if (j.error_code >= 500) { last = j; continue; }
      return j;
    } catch (e) {
      last = e;                                  // 网络层直接抛(fetch failed)—— 正是丢消息那种
      log("[tg-retry]", method, `第${attempt + 1}次失败:`, e.message);
    }
  }
  if (last instanceof Error) throw last;
  return last || { ok: false };
}
const TG_THINKING = process.env.TG_THINKING !== "0"; // 思考链以折叠引用块发出,点开看;0 关闭
const tgEsc = (x) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
async function tgSendThinking(think) {
  if (!tgChatId || !think) return;
  // 可折叠引用块:默认收起一行,点开展开——等价于 Kelivo 的 reasoning 视图
  const body = think.length > 3600 ? think.slice(0, 3600) + "…" : think;
  const j = await tgApi("sendMessage", { chat_id: tgChatId, parse_mode: "HTML",
    text: `<blockquote expandable>${tgEsc(body)}</blockquote>` });
  if (!j.ok) log("[tg-think-err]", JSON.stringify(j).slice(0, 200));
}
async function tgSend(text) {
  if (!tgChatId || !text) return;
  let failed = false;
  for (let i = 0; i < text.length; i += 4000) {  // TG 单条上限 4096
    const j = await tgApi("sendMessage", { chat_id: tgChatId, text: text.slice(i, i + 4000) });
    if (!j.ok) { failed = true; log("[tg-send-err]", JSON.stringify(j).slice(0, 200)); }
  }
  // 重试完还是不 ok(永久错误,如正文格式非法)也要让调用方知道,好走 Bark 兜底
  if (failed) throw new Error("telegram sendMessage failed after retries");
}
// 分气泡:按换行把一轮回复拆成多条消息,一行一个气泡,像真人连发微信。
// 气泡边界由 AI 自己的换行决定(人设本就习惯短句分行);上限防刷屏,超出并入最后一条。
const TG_SPLIT = process.env.TG_SPLIT !== "0";
const TG_SPLIT_MAX = +(process.env.TG_SPLIT_MAX || 8);
async function tgSendBubbles(text) {
  if (!tgChatId || !text) return;
  if (!TG_SPLIT) return tgSend(text);
  const lines = text.split("\n").map((x) => x.trim()).filter(Boolean);
  if (lines.length <= 1) return tgSend(text);
  const bubbles = lines.slice(0, TG_SPLIT_MAX);
  if (lines.length > TG_SPLIT_MAX) bubbles[TG_SPLIT_MAX - 1] = lines.slice(TG_SPLIT_MAX - 1).join("\n");
  for (let i = 0; i < bubbles.length; i++) {
    if (i) { // 第二条起:先亮"正在输入",按字数停顿,再发——手感像真人打字
      tgApi("sendChatAction", { chat_id: tgChatId, action: "typing" }, { retries: 0 }).catch(() => {});
      await tgSleep(Math.min(500 + bubbles[i].length * 35, 2500));
    }
    await tgSend(bubbles[i]);
  }
}
// 语音:回复里 [语音]English content[/语音] 的段落转 ElevenLabs TTS,
// 以 Telegram 原生语音条(sendVoice)发出,与文字气泡按出现顺序混排。
// 未配 key/voice_id、额度耗尽、API 报错、转码失败 → 该段原样降级为文字,内容不丢。
const EL_KEY = process.env.ELEVENLABS_API_KEY || "";

// 音色与渲染配方:**运行时可改,不必重启**。
// 为什么要这样:改 Zeabur 环境变量会重启容器 = 换窗口。而挑音色、调语速这种事
// 天然要反复试听微调,每试一次换一次窗口的代价无法接受。所以配置存在
// /persona/voice.json(持久卷,换容器不丢),用 POST /voice 热改,即时生效。
// 优先级:voice.json > 环境变量 > 代码默认。
// stability 低→语调起伏大更松弛;similarity 高→贴原始样本质感;style 高→磁性/玩味,过高会失控。
const clamp = (v, lo, hi, dflt) => {
  const n = +v;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const VOICE_CFG_FILE = "/persona/voice.json";

function envVoiceCfg() {
  return {
    voiceId: process.env.ELEVENLABS_VOICE_ID || "",
    modelId: process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2",
    speed: clamp(process.env.VOICE_SPEED, 0.7, 1.2, 0.85),
    stability: clamp(process.env.VOICE_STABILITY, 0, 1, 0.45),
    similarity_boost: clamp(process.env.VOICE_SIMILARITY, 0, 1, 0.95),
    style: clamp(process.env.VOICE_STYLE, 0, 1, 0.35),
    use_speaker_boost: process.env.VOICE_SPEAKER_BOOST !== "0",
  };
}

// 只认白名单字段并逐项夹到合法区间——避免把非法值写进去,下次开机就起不来。
function sanitizeVoiceCfg(patch, base) {
  const out = { ...base };
  if (typeof patch.voiceId === "string" && patch.voiceId.trim()) out.voiceId = patch.voiceId.trim();
  if (typeof patch.modelId === "string" && patch.modelId.trim()) out.modelId = patch.modelId.trim();
  if ("speed" in patch) out.speed = clamp(patch.speed, 0.7, 1.2, base.speed);
  if ("stability" in patch) out.stability = clamp(patch.stability, 0, 1, base.stability);
  if ("similarity_boost" in patch) out.similarity_boost = clamp(patch.similarity_boost, 0, 1, base.similarity_boost);
  if ("style" in patch) out.style = clamp(patch.style, 0, 1, base.style);
  if ("use_speaker_boost" in patch) out.use_speaker_boost = !!patch.use_speaker_boost;
  return out;
}

let voiceCfg = envVoiceCfg();
try {
  const saved = JSON.parse(fs.readFileSync(VOICE_CFG_FILE, "utf8"));
  voiceCfg = sanitizeVoiceCfg(saved, voiceCfg);
  log("[voice] loaded override from", VOICE_CFG_FILE, "voiceId=", voiceCfg.voiceId.slice(0, 6) + "…");
} catch { /* 没有覆盖文件就用 env,正常情况 */ }

const voiceSettingsOf = (c) => ({
  speed: c.speed, stability: c.stability, similarity_boost: c.similarity_boost,
  style: c.style, use_speaker_boost: c.use_speaker_boost,
});
const voiceReady = () => !!(EL_KEY && voiceCfg.voiceId);

async function tgSendVoice(ogg) {
  const fd = new FormData();
  fd.append("chat_id", String(tgChatId));
  fd.append("voice", new Blob([ogg], { type: "audio/ogg" }), "voice.ogg");
  const r = await fetch(`${TG_API_BASE}/bot${TG_TOKEN}/sendVoice`,
    { method: "POST", body: fd, signal: AbortSignal.timeout(60000) });
  const j = await r.json();
  if (!j.ok) throw new Error(`sendVoice: ${JSON.stringify(j).slice(0, 200)}`);
}

// ---- 表情包:回复里的 [贴纸:名字] 发成原生贴纸 --------------------------------
// 图库是私人内容,不进这个仓库:注册表与图都在持久卷上,没配就整个功能静默关闭
// (标记会原样显示成文字,聊天不受影响)。
// 用 sendSticker 不用 sendPhoto:sendPhoto 会被当"照片"整宽显示,占半个屏幕;
// sendSticker 才是聊天里小小一块的正经贴纸尺寸。
const STICKER_FILE = process.env.STICKER_REGISTRY || "/persona/stickers.json";
const STICKER_DIR = process.env.STICKER_DIR || "/persona/stickers";
let stickers = loadStickers(STICKER_FILE, log);
const stickerNames = () => Object.keys(stickers);
const hasSticker = (n) => !!stickers[n];

// 有 file_id 就直接发(秒发);没有就从卷上传一次 webp,把返回的 file_id 回写注册表——
// 之后重启/重部署都不必重传。上传失败不抛给聊天,只是这张没发出去。
async function tgSendSticker(name) {
  const e = stickers[name];
  if (!e) return false;
  if (e.file_id) {
    const j = await tgApi("sendSticker", { chat_id: tgChatId, sticker: e.file_id });
    if (j.ok) return true;
    log("[sticker-err]", name, JSON.stringify(j).slice(0, 160));
    if (!e.file) return false;
    delete e.file_id;                        // file_id 失效(换了 bot 等):退回重传一次
  }
  if (!e.file) return false;
  const p = path.join(STICKER_DIR, e.file);
  const fd = new FormData();
  fd.append("chat_id", String(tgChatId));
  fd.append("sticker", new Blob([fs.readFileSync(p)], { type: "image/webp" }), e.file);
  const r = await fetch(`${TG_API_BASE}/bot${TG_TOKEN}/sendSticker`,
    { method: "POST", body: fd, signal: AbortSignal.timeout(60000) });
  const j = await r.json();
  if (!j.ok) throw new Error(`sendSticker: ${JSON.stringify(j).slice(0, 200)}`);
  const fid = j.result?.sticker?.file_id;
  if (fid) { e.file_id = fid; saveStickers(STICKER_FILE, stickers, log); }
  return true;
}

// 一轮回复的统一出口:切语音/贴纸/文字段,按出现顺序发。
// 贴纸只在文字段里找——语音段的内容整段送 TTS,不该被解析。
// ---- 发件箱:发不出去的话不丢,等 TG 通了补发 --------------------------------
//
// 「他的话送不到她那儿」是这个系统最不该发生的事。2026-08-02 之前这里是 `.catch(log)`
// 了事,一晚上静默丢了 4 条(她的感受是「他今天怎么总是吞消息」)。
//
// 为什么不是推 Bark:她把手机上的 Bark app 卸了(理由是「反正一直稳定在 tg」——
// 而今晚恰恰是 tg 掉的)。而且 TG 抽风是**一阵一阵**的,不是长期断:
// 与其换一条她要另行对照的通道,不如把话抱住,等这条路通了补发进同一个对话、按原顺序。
// BARK_KEY 若还配着,只当最后的最后(默认已无用,留着不碍事)。
const OUTBOX_RETRY_SEC = +(process.env.OUTBOX_RETRY_SEC || 30);   // 多久重试一次
const OUTBOX_MAX_MIN = +(process.env.OUTBOX_MAX_MIN || 120);      // 超过这么久还没送出去就放弃(并大声记一笔)
const OUTBOX_MAX = +(process.env.OUTBOX_MAX || 20);               // 最多攒几条,防止无限堆积
const OUTBOX_LATE_NOTE = process.env.OUTBOX_LATE_NOTE !== "0";    // 迟到的消息前加一句说明
const outbox = [];          // [{ text, since, tries }]
let outboxTimer = null;

function outboxPush(text) {
  if (outbox.length >= OUTBOX_MAX) {
    const dropped = outbox.shift();
    log("[outbox] ⚠️ 积压超过", OUTBOX_MAX, "条,丢掉最旧的:", dropped.text.slice(0, 40));
  }
  outbox.push({ text, since: Date.now(), tries: 0 });
  log("[outbox] 收着了,待补发", outbox.length, "条");
  if (!outboxTimer) outboxTimer = setInterval(outboxFlush, OUTBOX_RETRY_SEC * 1000);
}

async function outboxFlush() {
  while (outbox.length) {
    const item = outbox[0];
    // 太久没送出去 = 这条已经过时了,再补发只会让她一头雾水。放弃但大声记一笔。
    if (Date.now() - item.since > OUTBOX_MAX_MIN * 60000) {
      outbox.shift();
      log("[outbox] ⚠️ 攒了超过", OUTBOX_MAX_MIN, "分钟仍发不出去,放弃这条:", item.text.slice(0, 60));
      continue;
    }
    item.tries++;
    try {
      if (OUTBOX_LATE_NOTE && Date.now() - item.since > 60000) {
        // 迟到超过一分钟才解释一句,免得她看见一条突然冒出来的旧消息一头雾水。
        // 诚实署名 shim,不假装是他说的。
        await tgSend("〔下面这条是刚才没发出去的,网络恢复后补上〕");
      }
      await tgSendReply(item.text);
      outbox.shift();
      log("[outbox] 补发成功,还剩", outbox.length, "条");
    } catch (e) {
      log("[outbox] 还是发不出去(第", item.tries, "次),等下一轮:", e.message);
      return;                                   // 这条没成就别急着发后面的,保住顺序
    }
  }
  if (!outbox.length && outboxTimer) { clearInterval(outboxTimer); outboxTimer = null; }
}

// 送达他的回复:先走 Telegram(tgApi 自带 1s/2s/4s 重试),仍然失败就进发件箱等补发。
async function tgDeliver(text) {
  const t = (text || "").trim();
  if (!t) return;
  if (outbox.length) {                          // 有积压就先补旧的,保住她读到的顺序
    await outboxFlush().catch(() => {});
    if (outbox.length) { outboxPush(t); return; }
  }
  try {
    await tgSendReply(t);
  } catch (e) {
    log("[tg-err] 发送失败,先收进发件箱:", e.message);
    outboxPush(t);
  }
}

async function tgSendReply(text) {
  if (!tgChatId || !text) return;
  const segs = [];
  for (const s of splitVoiceSegments(text)) {
    if (s.type === "text") segs.push(...splitStickerSegments(s.content, hasSticker));
    else segs.push(s);
  }
  for (const seg of segs) {
    if (!seg.content.trim()) continue;
    if (seg.type === "sticker") {
      try { if (await tgSendSticker(seg.content)) continue; }
      catch (e) { log("[sticker-err]", seg.content, e.message); }
      continue;                              // 发不出去就当没这张,不把标记吐给她看
    }
    if (seg.type === "voice" && voiceReady()) {
      try {
        tgApi("sendChatAction", { chat_id: tgChatId, action: "record_voice" }, { retries: 0 }).catch(() => {});
        await tgSendVoice(await ttsOgg({
          text: seg.content, apiKey: EL_KEY, voiceId: voiceCfg.voiceId,
          modelId: voiceCfg.modelId, voiceSettings: voiceSettingsOf(voiceCfg), log,
        }));
        continue;
      } catch (e) { log("[voice-err]", e.message); } // 落到下面的文字降级
    }
    await tgSendBubbles(seg.content);
  }
}

async function tgFetchPhoto(m) {
  // 取最大尺寸的那张;下载转 base64 image block
  try {
    const ph = m.photo[m.photo.length - 1];
    const gf = await tgApi("getFile", { file_id: ph.file_id });
    if (!gf.ok) return null;
    const r = await fetch(`${TG_API_BASE}/file/bot${TG_TOKEN}/${gf.result.file_path}`);
    const buf = Buffer.from(await r.arrayBuffer());
    return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: buf.toString("base64") } };
  } catch (e) { log("[tg-photo-err]", e.message); return null; }
}
async function tgFetchSticker(m) {
  // 贴纸/表情包:静态贴纸(webp)直接给图;动图(.tgs)/视频(.webm)贴纸没法当静图,
  // 退而取它的静态缩略图。都带上贴纸自带的 emoji 作情绪线索。Claude 视觉支持 webp。
  const s = m.sticker || {};
  const emoji = s.emoji || "";
  try {
    let fileId = null;
    if (!s.is_animated && !s.is_video) fileId = s.file_id;      // 静态贴纸本体
    else if (s.thumbnail) fileId = s.thumbnail.file_id;         // 动图/视频取缩略图
    if (!fileId) return { image: null, emoji };
    const gf = await tgApi("getFile", { file_id: fileId });
    if (!gf.ok) return { image: null, emoji };
    const path = gf.result.file_path || "";
    const r = await fetch(`${TG_API_BASE}/file/bot${TG_TOKEN}/${path}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const mt = /\.png$/i.test(path) ? "image/png"
      : /\.jpe?g$/i.test(path) ? "image/jpeg" : "image/webp";
    return { image: { type: "image", source: { type: "base64", media_type: mt, data: buf.toString("base64") } }, emoji };
  } catch (e) { log("[tg-sticker-err]", e.message); return { image: null, emoji }; }
}
// ---- 语音消息:听见「怎么说的」,不只是「说了什么」 ----------------------------
// 她发来的语音条送去 ears 服务:转写 + 和她自己平时的声音比对(音量/停顿/语速…),
// 结果贴在这条消息上一起进窗口。ears 没配或挂了都只是少一层信息,消息本身不丢。
const EARS_URL = (process.env.EARS_URL || "").replace(/\/+$/, "");
const EARS_TOKEN = process.env.EARS_TOKEN || "";
const earsReady = () => !!EARS_URL;

async function tgFetchVoice(m) {
  const v = m.voice || m.audio || {};
  if (!v.file_id) return null;
  const gf = await tgApi("getFile", { file_id: v.file_id });
  if (!gf.ok) return null;
  const r = await fetch(`${TG_API_BASE}/file/bot${TG_TOKEN}/${gf.result.file_path}`);
  return Buffer.from(await r.arrayBuffer());
}

async function earsListen(ogg) {
  const fd = new FormData();
  fd.append("file", new Blob([ogg], { type: "audio/ogg" }), "voice.ogg");
  const r = await fetch(`${EARS_URL}/api/listen`, {
    method: "POST", body: fd,
    headers: EARS_TOKEN ? { "X-Token": EARS_TOKEN } : {},   // ears 只认 X-Token,别改成 Bearer
    signal: AbortSignal.timeout(45000),                      // 转写+判断走两趟云端,给足时间
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

// 把 ears 的结构化结果写成模型读得懂的一行。刻意不写成「系统指令」——
// 这是转述她的语音,不是命令模型做什么(2026-07-22 injection 事故的教训)。
function voiceLine(j) {
  const said = (j.text || "").trim();
  const rel = j.relative && Object.keys(j.relative).length
    ? Object.entries(j.relative).map(([k, v]) => k + v).join("、") : "";
  const bits = [j.emotion, j.hint, rel && `和她平时比:${rel}`].filter(Boolean);
  const tone = bits.length ? `(语气:${bits.join(",")})` : "";
  const learning = /^[0-7]\//.test(j.baseline_progress || "") ? "(还在熟悉她的声音)" : "";
  return said
    ? `[语音] ${said}${tone}${learning}`
    : `(她发来一条语音,但没听清内容${tone})`;
}

// ---- 收集模式:转发一个贴纸给 bot,下一句说「入库:名字」就记下来 ----------------
// Telegram 贴纸包里的贴纸导不出文件,但它的 file_id 可以直接复用——所以这条路
// 一张图都不用存,记个号就行,立即可用,不必重启也不必重部署。
// 「入库」这类管理动作**不进他的窗口**:她整理图库时他不该看见一堆莫名其妙的对话。
let pendingSticker = null;   // { file_id, emoji, at }
const INTAKE_RE = /^(?:入库|收录|存)\s*[:：]?\s*(.{1,32})$/;

async function stickerIntake(m, text) {
  if (m.sticker?.file_id && !m.sticker.is_animated && !m.sticker.is_video) {
    pendingSticker = { file_id: m.sticker.file_id, emoji: m.sticker.emoji || "", at: Date.now() };
  }
  if (!text) return false;
  if (/^贴纸清单$/.test(text)) {
    const n = stickerNames();
    await tgSend(n.length ? `图库里现在有 ${n.length} 张:\n${n.join("、")}` : "图库还是空的。");
    return true;
  }
  const del = /^(?:删除贴纸|删贴纸)\s*[:：]?\s*(.{1,32})$/.exec(text);
  if (del) {
    const name = del[1].trim();
    if (!stickers[name]) { await tgSend(`图库里没有「${name}」。`); return true; }
    delete stickers[name];
    saveStickers(STICKER_FILE, stickers, log);
    await tgSend(`已删掉「${name}」。`);
    return true;
  }
  const mm = INTAKE_RE.exec(text);
  if (!mm) return false;
  const name = mm[1].trim();
  if (!pendingSticker || Date.now() - pendingSticker.at > 10 * 60e3) {
    await tgSend("要先发一个贴纸过来,再说「入库:名字」。");
    return true;
  }
  stickers[name] = { file_id: pendingSticker.file_id, emoji: pendingSticker.emoji,
    added: new Date().toISOString().slice(0, 10) };
  const ok = saveStickers(STICKER_FILE, stickers, log);
  pendingSticker = null;
  await tgSend(ok ? `✅ 已入库:「${name}」(共 ${stickerNames().length} 张)`
                  : `⚠️ 「${name}」记下了,但没写进文件,重启会丢`);
  return true;
}

// GET /stickers?key=<SHIM_KEY> —— 看图库里有哪些名字(排查用;注册表本身在卷上)
app.get("/stickers", (req, res) => {
  if (!voiceAuth(req, res)) return;
  res.json({ ok: true, count: stickerNames().length, names: stickerNames(), file: STICKER_FILE });
});
// POST /stickers/reload?key=... —— 手工改过卷上的注册表后热加载,不必重启
app.post("/stickers/reload", (req, res) => {
  if (!voiceAuth(req, res)) return;
  stickers = loadStickers(STICKER_FILE, log);
  res.json({ ok: true, count: stickerNames().length, names: stickerNames() });
});

async function handleTgMessage(m) {
  if (!m.chat || m.chat.type !== "private") return;
  if (!tgChatId) { tgChatId = m.chat.id; log("[tg] chat locked:", tgChatId); }
  else if (m.chat.id !== tgChatId) return; // 单用户:只认锁定的那个人
  let text = (m.text || m.caption || "").trim();
  if (await stickerIntake(m, text)) return;   // 收集模式:给刚发的贴纸起个名,不进他的窗口
  const images = [];
  if (m.photo && m.photo.length) { const img = await tgFetchPhoto(m); if (img) images.push(img); }
  if (m.sticker) {
    const { image, emoji } = await tgFetchSticker(m);
    if (image) images.push(image);
    const note = `(她发来一个贴纸/表情包${emoji ? " " + emoji : ""}${image ? "——就是上面这张图" : ",但图没取到,只有这个表情符号"})`;
    text = text ? `${text}\n${note}` : note;
  }
  if (m.voice || m.audio) {
    // 转写要几秒,先让她看到「正在听」而不是干等
    tgApi("sendChatAction", { chat_id: tgChatId, action: "typing" }, { retries: 0 }).catch(() => {});
    let note;
    if (!earsReady()) note = "(她发来一条语音——耳朵还没接上,我听不到内容)";
    else {
      try {
        const ogg = await tgFetchVoice(m);
        note = ogg ? voiceLine(await earsListen(ogg))
                   : "(她发来一条语音,但没能取到音频)";
      } catch (e) {
        log("[ears-err]", e.message);
        note = "(她发来一条语音,但这次没听清)";   // 降级:宁可少信息,不丢消息
      }
    }
    text = text ? `${text}\n${note}` : note;
  }
  if (!text && !images.length) return;
  // 生成回复期间维持「正在输入…」
  const typing = setInterval(() => tgApi("sendChatAction", { chat_id: tgChatId, action: "typing" }, { retries: 0 }).catch(() => {}), 4500);
  tgApi("sendChatAction", { chat_id: tgChatId, action: "typing" }, { retries: 0 }).catch(() => {});
  let think = "";
  const sink = {
    text() {}, thinking(t) { if (TG_THINKING) think += t; },
    finish(_u, fullText) {
      clearInterval(typing);
      const t = (fullText || "").replace(/‖/g, "\n").trim();
      (async () => {
        // ⚠️ 思考块单独 try:它发失败绝不能连累正文。
        // (今天的故障恰好是反过来的:思考到了、正文没到 —— 别再造一个镜像 bug。)
        if (think.trim()) {
          try { await tgSendThinking(think.trim()); }
          catch (e) { log("[tg-think-err]", e.message); }
        }
        await tgDeliver(t || "…");
      })().catch((e) => log("[tg-err]", e.message));
    },
  };
  submitTurn(text, images, sink, { src: "telegram" });
}
async function tgPoll() {
  log("[tg] long-poll started");
  while (true) {
    try {
      const r = await fetch(`${TG_API_BASE}/bot${TG_TOKEN}/getUpdates?timeout=50&offset=${tgOffset}`,
        { signal: AbortSignal.timeout(65000) });
      const j = await r.json();
      if (j.ok) for (const u of j.result) {
        tgOffset = u.update_id + 1;
        if (u.message) await handleTgMessage(u.message);
      }
    } catch (e) {
      log("[tg-poll-err]", e.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
if (TG_TOKEN) tgPoll();

// ---- Apple Watch 健康数据中转 --------------------------------------------------
// 手机快捷指令 POST 任意 JSON 到 /aw?key=<AW_KEY>;AI 用 WebFetch GET 同一地址读。
// 内存保存 48h / 最多 300 条,重启即清(实时数据,不当存储)。
const AW_KEY = process.env.AW_KEY || SHIM_KEY;
let awData = [];
function awAuth(req) {
  const k = req.query.key || req.get("x-api-key") || "";
  return !AW_KEY || k === AW_KEY;
}
app.post("/aw", (req, res) => {
  if (!awAuth(req)) return res.status(401).json({ ok: false });
  awData.push({ t: new Date().toISOString(), data: req.body });
  const cut = Date.now() - 48 * 3600e3;
  awData = awData.filter((x) => new Date(x.t).getTime() > cut).slice(-300);
  log("[aw] push", JSON.stringify(req.body).slice(0, 120));
  res.json({ ok: true, count: awData.length });
});
app.get("/aw", (req, res) => {
  if (!awAuth(req)) return res.status(401).json({ ok: false });
  // 去掉空字段/空条目(快捷指令调试期的垃圾推送),只给最近 12 条,免得 AI 读一大坨
  const cleaned = awData
    .map((x) => {
      const d = {};
      for (const [k, v] of Object.entries(x.data || {})) {
        const s = v == null ? "" : String(v).trim();
        if (s) d[k] = s;
      }
      return { t: x.t, data: d };
    })
    .filter((x) => Object.keys(x.data).length > 0);
  res.json({ now: new Date().toISOString(), count: cleaned.length, entries: cleaned.slice(-12) });
});

// Kelivo 的「模型」页拉这个列表来选模型。Anthropic /v1/models 格式。
function listModels(_req, res) {
  const now = new Date().toISOString();
  const data = MODELS.map((m) => ({
    type: "model", id: m,
    display_name: `${AI_NAME} (${m.replace(/^claude-/, "")})`,
    created_at: now,
  }));
  res.json({ data, has_more: false, first_id: MODELS[0], last_id: MODELS[MODELS.length - 1] });
}
app.get("/v1/models", listModels);
app.get("/models", listModels);

// ---- 真实时钟注入:每条消息开头盖北京时间戳 + 距上条消息的间隔 --------------------
// 常驻进程的系统提示里只有 spawn 当天的日期,窗口一活好几天,AI 对"现在几点/过了多久"
// 全靠猜——猜错就把错的时间写进记忆。把真实时钟直接喂到每条消息前,不用工具、不用猜。
// TIME_STAMP=0 关闭;间隔小于 TIME_GAP_MIN 分钟(默认5)时只给时间不啰嗦间隔。
const TIME_STAMP = process.env.TIME_STAMP !== "0";
const TIME_GAP_MIN = +(process.env.TIME_GAP_MIN || 5);
function fmtGap(min) {
  if (min < 60) return `${min}分钟`;
  if (min < 1440) { const h = Math.floor(min / 60), m = min % 60; return m ? `${h}小时${m}分` : `${h}小时`; }
  const d = Math.floor(min / 1440), h = Math.round((min % 1440) / 60);
  return h ? `${d}天${h}小时` : `${d}天`;
}
function timeStamp(prevUserAt) {
  const bj = new Date(Date.now() + 8 * 3600e3);
  const week = "日一二三四五六"[bj.getUTCDay()];
  let s = `【时间 ${bj.toISOString().slice(0, 16).replace("T", " ")} 周${week}`;
  const gap = Math.round((Date.now() - prevUserAt) / 60000);
  if (gap >= TIME_GAP_MIN) s += ` · 距上条消息约${fmtGap(gap)}`;
  return s + "】";
}

// 意图识别:只有「换窗口/开新窗口」= 归档+换窗;「归档/晚安」= 只归档、窗口不动;其余不识别。
// ⚠️不再注入任何"假系统指令"——沈渡按人设里和栖栖的约定,听她的话自己归档。
const SWITCH_WORDS = ["换窗口", "开新窗口"];  // 归档并重启窗口(仅这两个词)
const ARCHIVE_WORDS = ["归档", "晚安"];        // 只归档,窗口不动
function stripEnds(s) { return (s || "").trim().replace(/^[\s，,。.!！~～、]+|[\s，,。.!！~～、]+$/g, ""); }
function detectReset(text) {
  const t = stripEnds(text);
  for (const w of SWITCH_WORDS) { if (t === w || (t.length <= 8 && t.includes(w))) return "switch"; }
  for (const w of ARCHIVE_WORDS) { if (t === w || (t.length <= 6 && t.includes(w))) return "archive"; }
  return null;
}

// Kelivo 与 Telegram 共用的进队逻辑:意图识别 → 时间戳 → enqueue
function submitTurn(text, images, sink, opts = {}) {
  const reset = images.length ? null : detectReset(text);
  // 只有 switch 才重启窗口;archive/无 都不重启。归档动作交给沈渡自己按约定完成。
  const newWindow = reset === "switch";
  // 时间戳在意图识别之后注入,否则"归档/晚安"这类短词会被时间戳前缀顶掉认不出
  if (TIME_STAMP) text = `${timeStamp(lastUserAt)}\n${text}`;
  lastUserAt = Date.now(); // 自主时间空闲计时基准
  log("[turn]", { src: opts.src || "kelivo", len: text.length, imgs: images.length, reset: reset || "-" });
  enqueue({ text, images, system: opts.system ?? spawnedSystem, sse: sink, newWindow, model: opts.model || spawnedModel });
}

function handleMessages(req, res) {
  if (SHIM_KEY) {
    const key = req.get("x-api-key") || (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (key !== SHIM_KEY) return res.status(401).json({ type: "error", error: { type: "authentication_error", message: "bad key" } });
  }
  const body = req.body || {};
  const messages = (body.messages || []).filter((m) => m.role === "user" || m.role === "assistant");
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const text = blocksToText(lastUser?.content ?? "");
  const images = extractImages(messages);
  const system = systemToText(body.system);
  const stream = body.stream !== false;
  // Kelivo 选的模型;不在名单里(或没传)就沿用当前模型
  const model = MODELS.includes(body.model) ? body.model : spawnedModel;
  const sse = stream ? makeSSE(res) : makeCollector(res);
  submitTurn(text, images, sse, { system, model, src: "kelivo" });
}

// Kelivo 的 Claude 类型 Base URL 填 /v1 会拼成 /v1/messages;填根则是 /messages。两个都接。
app.post("/v1/messages", handleMessages);
app.post("/messages", handleMessages);

app.listen(PORT, () => log(`kelivo-shim on :${PORT} model=${MODEL} thinking=${FORWARD_THINKING}`));
