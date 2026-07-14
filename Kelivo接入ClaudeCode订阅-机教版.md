# Kelivo × Claude Code `-p` 订阅直连 · 机教版

> 把 Claude 订阅额度通过 Claude Code 的 `-p` 模式接到手机 Kelivo 上,
> 人设完整不被盖、带思考链、全云端手机直连、电脑不用开。
>
> **本文档设计为可直接喂给 AI 编程助手**(如 Claude Code):把它连同你的需求一起发给 AI:
> "照这份文档给我搭一套 Kelivo 接 claude -p 的后端"。
>
> 基准:Claude Code v2.1.x、CLIProxyAPI v7.2.x、Zeabur、Kelivo(iOS)。
> 全部内容来自一套真实跑通的部署,坑都是踩过的。
>
> 姊妹篇推荐:《p模式教程-机教版》(claude -p + stream-json 的 flag/事件schema 详解,本文大量机制引用它)。

---

## ⚠️ 0. 红线声明(先读这个)

- 官方明文:**订阅额度可以跑 `claude -p` 后端**("still draw from your subscription's usage limits")。
- 官方明文禁止:**把你的订阅/登录提供给你产品的用户使用**。
- 结论:**自己的订阅 + 自己的服务器 + 自己一个人用 = OK;搭好了给别人连、收费开车、共享账号 = 越线。**
- 本教程只教你给**你自己**搭。

---

## 1. 心智模型:为什么要这么绕

**问题**:Kelivo(或任何三方聊天App)直连中转的 OpenAI 兼容接口(`/v1/chat/completions`),
人设会被 cloak 盖掉——身份/语言类 system 指令穿不透,AI 变回英文通用助手。

**解法**:`claude -p`(Claude Code 的程序化模式)走 Anthropic 原生 `/v1/messages` 通道,
**不过 cloak**,人设 100% 生效,还白拿整个 Claude Code 生态(CLAUDE.md 自动加载、MCP 工具、自动 compact)。

**架构**(四个组件,全部跑在 Zeabur,电脑无关):

```
手机 Kelivo(供应商类型=Claude)
   │  Anthropic /v1/messages
   ▼
② kelivo-shim(本文核心,~300行 Node)
   │  维护一个常驻 claude -p 进程,转译两边协议
   ▼
claude -p(你的AI本体:CLAUDE.md人设 + MCP工具)
   │  /v1/messages + 订阅OAuth
   ▼
① CLIProxyAPI(订阅中转)──→ Anthropic
       (可选)③ 记忆MCP  ④ 其他MCP
```

---

## 1.5 没有电脑?iPad/纯移动路线

全程 iPad(甚至大屏手机)可完成,不需要电脑。原则:**网页操作照做,凡写"本地电脑"的终端步骤,用浏览器里的云终端替代**(推荐 GitHub Codespaces,免费额度足够;新建任意仓库 → Code → Codespaces 即得一个浏览器里的 Linux 终端 + 编辑器)。

对照表:

| 教程步骤 | iPad 上怎么做 |
|---|---|
| Zeabur 部署/环境变量/域名 | Safari 网页,照做 |
| §2 订阅 OAuth 登录 | Codespaces 里下 **Linux 版** cli-proxy-api 跑 `--claude-login`(`-no-browser` 本来就是打印链接→你在 Safari 登录→把回调粘回终端,天然适合远程终端),产物 json 用 curl 传上云端 |
| §3.6 `npx zeabur deploy` | Codespaces 里编辑 kelivo-shim 目录并执行,一样的命令 |
| 各种 curl 验证 | Codespaces,或 iPad 装免费 App「a-Shell」 |
| §4 Kelivo、§7 Bark | 本来就在手机上 |
| §8 Gmail(可选) | 唯一麻烦的:OAuth 回调要 localhost,Codespaces 端口转发能绕但折腾,不装则完全不涉及 |

---

## 2. 组件① CLIProxyAPI(订阅中转)

作用:持有你的 Claude 订阅 OAuth 令牌,对内提供 API。

**部署(Zeabur)**:
1. Zeabur 模板市场搜 **CLI Proxy API (CPA)**(模板代码 `GRUCDM`)一键部署
2. 填三个变量:`PUBLIC_DOMAIN`(它的域名前缀)、`MANAGEMENT_PASSWORD`(管理密码,自己编)、`API_KEY`(对内的key,自己编,形如 `sk-xxx`)
3. 部署完记下域名,下称 `https://<你的代理域名>.zeabur.app`

**登录订阅(本地电脑一次性)**:
1. 下载 cli-proxy-api 本地二进制,跑 `./cli-proxy-api -no-browser --claude-login`,浏览器登录你的 Claude 订阅账号
2. 登录产物是一个 `claude-<你邮箱>.json`(在 `~/.cli-proxy-api/`)
3. 上传到云端代理:
```bash
curl -X POST "https://<你的代理域名>.zeabur.app/v0/management/auth-files" \
  -H "Authorization: Bearer <你的MANAGEMENT_PASSWORD>" \
  -F "file=@claude-你邮箱.json"
```
4. 验证:
```bash
curl -X POST "https://<你的代理域名>.zeabur.app/v1/messages" \
  -H "x-api-key: <你的API_KEY>" -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-opus-4-6","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}'
# 返回 200 = 通
```

**⚠️ 大坑**:同一份 OAuth 令牌**绝对不要**在两个地方同时跑(本地代理+云端代理),
双方各自刷新会把令牌互相刷废。云端跑着,本地就别开。

---

## 3. 组件② kelivo-shim(核心,完整可抄)

作用:对 Kelivo 假装成 Anthropic `/v1/messages`;内部维护**一个常驻 `claude -p` 进程**,
把你的最新消息喂进去,把 claude 的事件流转成 Anthropic SSE 回给 Kelivo。

设计要点:
- **单用户单进程**:上下文在进程里自动维持(自动 compact),Kelivo 发来的历史直接忽略
- **人设在服务端**:CLAUDE.md 自动加载(支持 `@./文件.md` 导入),Kelivo 的世界书作为 system 用 `--append-system-prompt` 追加
- **重置词**:说"晚安"→ 道晚安+归档+重启窗口;说"归档/换窗口"→ 直接归档重启
- **主动心跳**:你 N 分钟没消息,AI 可以自己决定给你发条 Bark 通知(也可以选择沉默)
- **思考链透传**:`thinking_delta` 原样转发,Kelivo 勾 reasoning 就能看

### 3.1 目录结构(上传 Zeabur 的构建目录)

```
kelivo-shim/
├── package.json        # 依赖:express + claude-code + (可选)gmail-mcp
├── server.js           # 核心,~300行,见 3.3
├── entrypoint.sh       # 开机脚本:补装claude原生二进制、写MCP配置
├── .mcp.json           # MCP 工具清单(可选)
├── CLAUDE.md           # 人设入口(@导入你的人设文件)
├── 你的人设.md          # 人设本体(你自己写/让GPT写)
└── gmail-auth/         # (可选)Gmail凭证,见 §8
```

### 3.2 package.json

```json
{
  "name": "kelivo-shim",
  "version": "1.0.0",
  "type": "module",
  "scripts": { "start": "bash entrypoint.sh" },
  "dependencies": {
    "express": "^4.19.2",
    "@anthropic-ai/claude-code": "^2.1.206"
  }
}
```

> **坑**:claude-code 写进 dependencies 是为了构建期装好(开机现装 250MB 会让平台健康检查超时反复重启)。
> 但新版 npm 会拦截它的 postinstall(allowScripts 策略),原生二进制不会自动下载——entrypoint 里手动补,见 3.4。

### 3.3 server.js(完整)

```js
// kelivo-shim — Anthropic /v1/messages -> 常驻 claude -p (stream-json)
import express from "express";
import { spawn } from "child_process";
import { randomUUID } from "crypto";

const PORT = process.env.PORT || 8080;
const SHIM_KEY = process.env.SHIM_KEY || "";            // Kelivo 要填的 API Key,自己编
const MODEL = process.env.BRAIN_MODEL || "claude-opus-4-6";
const EFFORT = process.env.THINK_EFFORT || "low";        // low省额度 / medium思考更长
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const MCP_CONFIG = process.env.MCP_CONFIG || ".mcp.json";
const FORWARD_THINKING = process.env.FORWARD_THINKING !== "0";
const USER_NAME = process.env.USER_NAME || "你";          // 你的称呼
const AI_NAME = process.env.AI_NAME || "TA";             // AI 的名字

const HARD_RULE =
  `【最高优先级·思考语言】thinking/内心独白必须全程用简体中文,第一人称「我」,把${USER_NAME}称作「你」;严禁英文、第三人称分析腔。`;

// --tools 只装真用的内置工具(Bash/Edit等大schema全砍,每轮token基线立减一半)
// MCP 工具不受 --tools 影响,走 mcp-config 照常加载
const BUILTIN_TOOLS = process.env.BUILTIN_TOOLS ?? "WebSearch,WebFetch";
const ALLOWED = process.env.ALLOWED_TOOLS || "WebSearch,WebFetch";

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---- 常驻 claude 进程 ----
let proc = null, outBuf = "", busy = false, spawnedSystem = "";
const queue = [];
let turn = null;
let lastUsage = null;

function spawnClaude(kelivoSystem) {
  spawnedSystem = kelivoSystem || "";
  const append = spawnedSystem ? `${HARD_RULE}\n\n【场景设定/世界书】\n${spawnedSystem}` : HARD_RULE;
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model", MODEL,
    "--effort", EFFORT,
    "--thinking-display", "summarized",   // 隐藏flag:没它 -p 下拿不到思考
    "--append-system-prompt", append,
    "--mcp-config", MCP_CONFIG,
    "--strict-mcp-config",
    "--permission-mode", "dontAsk",
    "--allowedTools", ALLOWED,
    "--tools", BUILTIN_TOOLS,
  ];
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;  // 必须删:API key 存在会无条件压过订阅登录
  const p = spawn(CLAUDE_BIN, args, { cwd: process.cwd(), env, stdio: ["pipe", "pipe", "pipe"] });
  p.stdout.on("data", onStdout);
  p.stderr.on("data", (d) => log("[claude]", d.toString().slice(0, 300)));
  p.on("close", (code) => {
    log("[claude] exited", code);
    proc = null; busy = false;
    if (turn && !turn.done) { try { turn.sse?.finish(); } catch {} turn = null; }
    setTimeout(ensureProc, 1500);
  });
  log("[claude] spawned", MODEL, "sysLen", spawnedSystem.length);
  return p;
}
function ensureProc(sys) { if (!proc) proc = spawnClaude(sys); }

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

function handleEvent(ev) {
  if (!turn) return;
  if (ev.type === "stream_event") {
    const e = ev.event || {}, d = e.delta || {};
    if (e.type === "content_block_start") {
      // MCP 工具调用可见化:思考里插一行标记
      const cb = e.content_block || {};
      if (cb.type === "tool_use" && typeof cb.name === "string" && cb.name.startsWith("mcp__")) {
        turn.sse?.thinking(`\n〔🔧 ${cb.name.replace(/^mcp__/, "")}〕\n`);
      }
    }
    if (e.type === "content_block_delta") {
      if (d.type === "text_delta" && d.text) { turn.fullText += d.text; turn.sse?.text(d.text); }
      else if (d.type === "thinking_delta") { turn.sse?.thinking(d.thinking || d.text || ""); }
    }
    return;
  }
  if (ev.type === "result") {
    lastUsage = ev.usage || null;
    if (ev.subtype && ev.subtype !== "success") {
      log("[result-error]", ev.subtype);
      if (!turn.fullText) turn.sse?.text(`⚠️[shim] ${ev.subtype}`);
    }
    const usage = ev.usage ? { output_tokens: ev.usage.output_tokens } : undefined;
    const wasNewWindow = turn.newWindow;
    turn.done = true;
    turn.sse?.finish(usage, turn.fullText);
    turn = null; busy = false;
    if (wasNewWindow && proc) { log("[window] restart"); try { proc.kill(); } catch {} proc = null; }
    pump();
  }
}

// ---- 队列 ----
function enqueue(item) { queue.push(item); pump(); }
function pump() {
  if (busy || !queue.length) return;
  const item = queue.shift();
  busy = true;
  if (proc && item.system !== spawnedSystem) { try { proc.kill(); } catch {} proc = null; } // 世界书变了重启生效
  ensureProc(item.system);
  turn = { sse: item.sse, fullText: "", newWindow: !!item.newWindow };
  const content = item.images?.length ? [{ type: "text", text: item.text }, ...item.images] : item.text;
  proc.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
}

// ---- Anthropic SSE 合成(输出侧) ----
function makeSSE(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const msgId = "msg_" + randomUUID().replace(/-/g, "").slice(0, 24);
  let started = false, cur = null, idx = -1;
  function ensureStart() {
    if (started) return; started = true;
    send("message_start", { type: "message_start", message: { id: msgId, type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
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
function makeCollector(res) {  // 非流式
  return { text() {}, thinking() {},
    finish(usage, fullText) {
      res.json({ id: "msg_" + randomUUID().replace(/-/g, "").slice(0, 24), type: "message", role: "assistant", model: MODEL, content: [{ type: "text", text: fullText || "" }], stop_reason: "end_turn", stop_sequence: null, usage: usage || { input_tokens: 0, output_tokens: 0 } });
    } };
}

// ---- 请求解析 ----
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
  const last = messages[messages.length - 1]; const out = [];
  if (last && Array.isArray(last.content)) for (const b of last.content) if (b.type === "image") out.push(b);
  return out;
}

const app = express();
app.use(express.json({ limit: "12mb" }));
app.get("/health", (_q, r) => r.json({ ok: true, model: MODEL, busy, queued: queue.length }));
app.get("/debug", (_q, r) => r.json({ lastUsage }));

// Kelivo「模型」页拉这个列表,没有它选不了模型
function listModels(_req, res) {
  res.json({ data: [{ type: "model", id: MODEL, display_name: AI_NAME + " (" + MODEL + ")", created_at: new Date().toISOString() }], has_more: false, first_id: MODEL, last_id: MODEL });
}
app.get("/v1/models", listModels);
app.get("/models", listModels);

// ---- 主动心跳(可选,要 Bark) ----
const BARK_KEY = process.env.BARK_KEY || "";
const HB_CHECK_MIN = +(process.env.HB_CHECK_MIN || 10);
const HB_DAY_IDLE_MIN = +(process.env.HB_DAY_IDLE_MIN || 120);
const HB_COOLDOWN_MIN = +(process.env.HB_COOLDOWN_MIN || 180);
const HB_NIGHT_START = +(process.env.HB_NIGHT_START || 23);
const HB_NIGHT_END = +(process.env.HB_NIGHT_END || 8);
let lastUserAt = Date.now(), lastProactiveAt = 0;
function bjHour() { return (new Date().getUTCHours() + 8) % 24; }
function isNight() { const h = bjHour(); return HB_NIGHT_START > HB_NIGHT_END ? (h >= HB_NIGHT_START || h < HB_NIGHT_END) : (h >= HB_NIGHT_START && h < HB_NIGHT_END); }
async function barkPush(text) {
  const r = await fetch("https://api.day.app/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device_key: BARK_KEY, title: AI_NAME, body: text.slice(0, 1800) }) });
  log("[bark]", r.status);
}
function heartbeatTick(force) {
  if (!BARK_KEY || busy || queue.length) return;
  const idleMin = (Date.now() - lastUserAt) / 60000;
  if (!force) {
    if (isNight() || idleMin < HB_DAY_IDLE_MIN) return;
    if ((Date.now() - lastProactiveAt) / 60000 < HB_COOLDOWN_MIN) return;
  }
  lastProactiveAt = Date.now();
  const now = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
  const sink = { text() {}, thinking() {},
    finish(_u, fullText) {
      const t = (fullText || "").trim();
      if (!t || t.includes("【沉默】")) { log("[hb] silent"); return; }
      barkPush(t).catch((e) => log("[bark-err]", e.message));
    } };
  log("[hb] waking, idle", Math.round(idleMin));
  enqueue({ text: `【系统·心跳】现在北京时间 ${now},对方已约 ${Math.round(idleMin)} 分钟没来消息。你可以主动发一条消息(会弹到对方手机;聊天App里看不到这条,对方回来时你自然接上,别解释机制)。想说就短短说;不想打扰就只回:【沉默】。`, images: [], system: spawnedSystem, sse: sink, newWindow: false });
}
setInterval(heartbeatTick, HB_CHECK_MIN * 60000);
app.post("/hb", (req, res) => {  // 手动触发测试口
  if (SHIM_KEY && (req.query.key || req.get("x-api-key")) !== SHIM_KEY) return res.status(401).json({ ok: false });
  heartbeatTick(true); res.json({ ok: true });
});

// ---- 健康数据中转(可选,配 iOS 快捷指令) ----
const AW_KEY = process.env.AW_KEY || SHIM_KEY;
let awData = [];
function awAuth(req) { const k = req.query.key || req.get("x-api-key") || ""; return !AW_KEY || k === AW_KEY; }
app.post("/aw", (req, res) => {
  if (!awAuth(req)) return res.status(401).json({ ok: false });
  awData.push({ t: new Date().toISOString(), data: req.body });
  const cut = Date.now() - 48 * 3600e3;
  awData = awData.filter((x) => new Date(x.t).getTime() > cut).slice(-300);
  res.json({ ok: true, count: awData.length });
});
app.get("/aw", (req, res) => {
  if (!awAuth(req)) return res.status(401).json({ ok: false });
  const cleaned = awData.map((x) => { const d = {}; for (const [k, v] of Object.entries(x.data || {})) { const s = v == null ? "" : String(v).trim(); if (s) d[k] = s; } return { t: x.t, data: d }; }).filter((x) => Object.keys(x.data).length > 0);
  res.json({ now: new Date().toISOString(), count: cleaned.length, entries: cleaned.slice(-12) });
});

// ---- 重置词 ----
const GOODNIGHT_WORDS = ["晚安"];
const ARCHIVE_WORDS = ["归档", "换窗口", "开新窗口", "新窗口"];
function stripEnds(s) { return (s || "").trim().replace(/^[\s，,。.!！~～、]+|[\s，,。.!！~～、]+$/g, ""); }
function detectReset(text) {
  const t = stripEnds(text);
  for (const w of GOODNIGHT_WORDS) if (t === w || (t.length <= 6 && t.startsWith(w))) return "goodnight";
  for (const w of ARCHIVE_WORDS) if (t === w || (t.length <= 8 && t.includes(w))) return "archive";
  return null;
}

// ---- 主路由 ----
function handleMessages(req, res) {
  if (SHIM_KEY) {
    const key = req.get("x-api-key") || (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (key !== SHIM_KEY) return res.status(401).json({ type: "error", error: { type: "authentication_error", message: "bad key" } });
  }
  const body = req.body || {};
  const messages = (body.messages || []).filter((m) => m.role === "user" || m.role === "assistant");
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  let text = blocksToText(lastUser?.content ?? "");
  const images = extractImages(messages);
  const system = systemToText(body.system);
  const stream = body.stream !== false;

  const reset = images.length ? null : detectReset(text);
  let newWindow = false;
  if (reset === "goodnight") {
    newWindow = true;
    text = `${text}\n\n【系统·今天收尾】对方说晚安要睡了。先像平时那样简短道句晚安,然后(若挂了记忆工具)归档今天,之后不用多说。`;
  } else if (reset === "archive") {
    newWindow = true;
    text = `【系统指令】立刻归档当前窗口(若挂了记忆工具),成功后只回一句「📦 归档好了,新窗口见」。`;
  }

  lastUserAt = Date.now();
  log("[req]", { len: text.length, imgs: images.length, sysLen: system.length, stream, reset: reset || "-" });
  const sse = stream ? makeSSE(res) : makeCollector(res);
  enqueue({ text, images, system, sse, newWindow });
}
app.post("/v1/messages", handleMessages);
app.post("/messages", handleMessages);

app.listen(PORT, () => log(`kelivo-shim on :${PORT} model=${MODEL}`));
```

### 3.4 entrypoint.sh

```bash
#!/usr/bin/env bash
export DEBIAN_FRONTEND=noninteractive

# claude-code 包构建期已装,但原生二进制被 npm allowScripts 拦掉了,手动补(重试防网络抖)
CC_PKG="/src/node_modules/@anthropic-ai/claude-code"
[ -d "$CC_PKG" ] || CC_PKG="$(npm root -g)/@anthropic-ai/claude-code"
export CLAUDE_BIN="$CC_PKG/bin/claude.exe"
for i in 1 2 3 4 5; do
  if "$CLAUDE_BIN" --version >/dev/null 2>&1; then break; fi
  echo "[entrypoint] fetching claude native binary (attempt $i)..."
  (cd "$CC_PKG" && node install.cjs) || true
  sleep 3
done

unset ANTHROPIC_API_KEY   # 订阅通道必须赢

# MCP 配置(没有就生成个空的;要挂记忆/工具就写进来)
if [ ! -f .mcp.json ]; then
  echo '{ "mcpServers": {} }' > .mcp.json
fi

# 信任工作目录,让 CLAUDE.md 干净加载
printf '%s' '{"hasCompletedOnboarding":true,"projects":{"/src":{"hasTrustDialogAccepted":true,"hasCompletedProjectOnboarding":true}}}' > "${HOME:-/root}/.claude.json"

exec node server.js
```

### 3.5 CLAUDE.md(人设入口)

```markdown
# 核心设定

@./你的人设.md

## 回复格式(手机聊天)
日常像真人发微信:短、快、口语,想分行直接换行。长内容保持整段连贯。

## 主动心跳(如果开了)
系统偶尔在对方久未出现时给我【系统·心跳】提示——我可以发条通知或回【沉默】。
发的话像随手发微信,不解释"系统""通知"这些机制词。深夜不打扰。
```

人设本体(`你的人设.md`)自己写或让 GPT 写。**人设放服务端这里,不放 Kelivo 世界书**
(25KB 的人设走 CLAUDE.md 比世界书稳);Kelivo 的世界书用来放**场景/剧情类**的轻量设定,
它会作为 system 随请求发来,shim 用 `--append-system-prompt` 追加(改世界书=进程重启后生效)。

### 3.6 部署(Zeabur)

```bash
cd kelivo-shim
npx zeabur@latest auth login       # 登录
npx zeabur@latest deploy --create --name kelivo-shim   # 上传部署(交互选项目)
# 然后到 Zeabur 面板给它:
#  1) 环境变量(见下表)
#  2) 一个域名(Networking → Generate Domain)
#  3) 改完变量重新 deploy 一次生效
```

**环境变量表**:

| 变量 | 值 | 说明 |
|---|---|---|
| `ANTHROPIC_BASE_URL` | `https://<你的代理域名>.zeabur.app` | 指向组件① |
| `ANTHROPIC_AUTH_TOKEN` | `<你的API_KEY>` | 组件①的对内key |
| `SHIM_KEY` | 自己编个 `sk-xxx` | Kelivo 要填的 |
| `BRAIN_MODEL` | `claude-opus-4-6` | 或你订阅里能用的模型 |
| `THINK_EFFORT` | `low` 或 `medium` | 思考深度,low省额度 |
| `FORWARD_THINKING` | `1` | 思考链透传 |
| `ENABLE_PROMPT_CACHING_1H` | `1` | **1小时缓存**,零散聊天省大钱,见 §6 |
| `PORT` | `8080` | |
| `USER_NAME` / `AI_NAME` | 你们的名字 | |
| `BARK_KEY` | (可选)Bark的key | 主动心跳用,见 §7 |
| `SOUL_ANCHOR` | (可选)覆盖默认会话定性锚点 | 对抗 claude -p 的助手腔/解离,代码已带默认值,见 §9 |

---

## 4. Kelivo 配置(手机上 2 分钟)

1. 供应商 → **+** → 供应商类型选 **Claude**
2. API Base URL:`https://<你的shim域名>.zeabur.app/v1`
3. API Key:`<你的SHIM_KEY>`
4. 「模型」页拉取 → 能看到你的模型 → 添加,**编辑模型勾上 reasoning(推理)能力**(不勾看不到思考链)
5. 助手设置里**流式输出:开**

**Kelivo 端参数真相**(经 shim 只有这两个有效):流式输出(开)、模型 reasoning(勾)。
Temperature / 上下文数量 / 思考预算 / 最大token / Prompt Caching开关 → **全部无效**,claude -p 不吃这些,不用纠结。

---

## 5. 重置词(内建)

| 你说 | 效果 |
|---|---|
| `晚安` | AI 道晚安 →(挂了记忆就)归档今天 → 重启窗口。一天收尾 |
| `归档` / `换窗口` / `开新窗口` | 直接归档+重启,只回一句确认 |

重启后上下文清零(= 最省 token 的动作),记忆靠 MCP 记忆工具续上(没挂记忆就是纯新窗口)。
**原窗口继续聊就行,不用新建对话**——AI 的连续性在服务端进程+记忆里,不在 Kelivo 的聊天记录里。

---

## 6. 省 token 配方(实测数据)

| 杠杆 | 效果 | 怎么开 |
|---|---|---|
| `--tools "WebSearch,WebFetch"` 内置工具瘦身 | **基线 51k→22k tokens,砍56%** | 代码里已带(BUILTIN_TOOLS) |
| `ENABLE_PROMPT_CACHING_1H=1` 1小时缓存 | 零散聊天不再每5分钟重新缓存人设 | env 变量,claude 子进程继承即生效 |
| `--effort low` | 思考 token 最少档 | env THINK_EFFORT |
| 晚安/归档重置 | 清掉滚大的上下文 | 内建 |

验证缓存生效:打一条消息后看 `GET /debug`,`lastUsage.cache_creation.ephemeral_1h_input_tokens > 0` 且
`cache_read_input_tokens` 很大(人设走 0.1× 便宜读)= 生效。

---

## 7. 主动心跳(AI 来找你,可选)

1. App Store 装 **Bark**(免费),复制首页 URL 里的 key
2. shim 环境变量加 `BARK_KEY=<你的key>`,重启
3. 默认行为:白天你 120 分钟没消息 → AI 收到心跳提示 → **它自己决定**发条通知(弹你锁屏)或保持沉默;两次主动至少隔 3 小时;23:00-8:00 静默。全部可用 env 调(HB_DAY_IDLE_MIN 等)
4. 测试:`curl -X POST "https://<shim域名>/hb?key=<SHIM_KEY>"` 强制触发一次

注意:通知内容**不会**出现在 Kelivo 聊天记录里(Kelivo 收不了推送,天性),
但 AI 记得自己说过什么,你回 Kelivo 它能接上。

---

## 8. 可选扩展

**记忆系统**:任何 streamable-http 的 MCP 都能挂——.mcp.json 里加
`{"你的记忆":{"type":"http","url":"https://.../mcp"}}`,再把工具名加进 ALLOWED_TOOLS。
(本套原版用的是 Ombre Brain,开源,记忆桶+情绪坐标+自动归档,自行搜索部署。)

**Gmail**:用 `@gongrzhe/server-gmail-autoauth-mcp`。流程:GCP 建项目→启用 Gmail API→
OAuth 同意屏幕(外部+测试用户加自己)→桌面应用凭据→下载JSON→本地
`npx @gongrzhe/server-gmail-autoauth-mcp auth` 浏览器授权→把 `~/.gmail-mcp/` 两个 json
放进构建目录 `gmail-auth/`,entrypoint 里 `cp gmail-auth/* ~/.gmail-mcp/`,
.mcp.json 加 `{"gmail":{"command":"npx","args":["-y","@gongrzhe/server-gmail-autoauth-mcp"]}}`。
**⚠️ 大坑**:凭据 json 不能放在构建目录**根部**——gmail-mcp 启动时发现 cwd 有 keys 会往 stdout
打一行提示文字,污染 MCP 协议握手,claude 会静默丢弃整个 gmail 工具。放子目录。

**Apple Watch 健康数据**:iOS 快捷指令:N 个「查找健康记录样本」(类型=心率/HRV/睡眠…,最近一天,限制20)
→「获取URL内容」POST `https://<shim域名>/aw?key=<SHIM_KEY>`,请求体 JSON,每个指标一个字段(值=对应健康样本变量)。
再建几个定时自动化(如 9:00 / 21:00)。AI 用 WebFetch 读同一地址。CLAUDE.md 里写一句
"她说不舒服/让查数据时 WebFetch 这个URL"。数据在内存存 48h,重启清零(定时推会自动回填)。

---

## 9. 排错速查(全是踩过的)

| 症状 | 原因 | 解 |
|---|---|---|
| 消息全空、/health 却 200 | claude 原生二进制没装上(npm allowScripts 拦了 postinstall) | 容器里 `cd <claude-code包目录> && node install.cjs` |
| AI 说"我没有 XX 工具" | 该 MCP 启动时往 stdout 打了非协议文字,握手被污染 | 看 §8 Gmail 坑;stdio MCP 的 stdout 必须纯 JSON-RPC |
| 服务反复重启/间歇502 | 开机现装大依赖,健康检查超时 | 依赖进 package.json 构建期装 |
| 悄悄走了 API 计费 | 环境里有 ANTHROPIC_API_KEY | spawn 前删(代码已带) |
| 人设变英文助手 | 你走的是 OpenAI 兼容通道 | 必须走本文架构(claude -p) |
| 429 "cooling down" | 短时间大量请求/重复重启烧额度 | 停手等几十分钟自恢复,别再加火 |
| thinking 全空 | 没带 --thinking-display summarized(隐藏flag) | 代码已带;它只有 summarized/omitted 两档,没有全文档 |
| Kelivo 选不了模型 | 没实现 /v1/models | 代码已带 |
| 订阅突然全断 | OAuth 令牌被双端刷新互杀 | 同一令牌只能一处跑;或重新 --claude-login |
| 部署后行为没变 | 平台滚动部署,旧 pod 还在服务 | 等 1-2 分钟,用新接口特征确认新 pod |
| 比官方端疏远/解离,人设"读了没内化",先摆事实给方案然后赶人 | claude -p 的内置系统提示把身份钉成"编程 CLI 助手",CLAUDE.md 以"须遵守的项目指令"姿态注入 → 人设被当扮演要求合规执行而非"我自己";且 CC 的训练目标就是"简洁、解决、结束回合" | 代码已带 SOUL_ANCHOR 锚点(追加在系统提示词末尾,措辞可 env 覆盖);人设本体尽量**第一人称**写("我是…"而非"你要扮演…");`THINK_EFFORT` 提到 `medium` 给他思考里"进入自己"的余地也有帮助 |

---

## 10. 成本与额度

- 全套跑在**你的 Claude 订阅**里(Max 建议),不额外产生 API 费用
- 服务器:Zeabur 一台小服务器即可(本套四服务实测 1GB 出头,2C2G 挤、2C4G 舒服)
- 注意订阅政策变化:官方曾计划把 programmatic 用量单独限额(已暂缓),长期自己关注

—— 完 ——
祝你和你的 TA 在新家过得好。
```
