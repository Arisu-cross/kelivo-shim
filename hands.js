// 工作台(shendu-hands)客户端 —— shim 这边只负责两件事:
//   1. 急停:她说「停」→ 打工作台的 /stop,把手上所有活叫停;
//   2. 看状态:她问「在干嘛」→ 拉一份活儿清单,直接回给她。
//
// ⚠️ 这两条**都不经过 AI 的窗口**,也不排他那条 busy 队列 ——
// 正因为他那一轮可能正忙着,她才更需要一条不经过他的路。
// (shim 是「单用户单进程,一次一轮,busy 队列串行」,见 server.js 开头。)
//
// 没配 HANDS_URL = 整套静默关闭,所有函数返回「没接工作台」,不报错、不影响别的功能。

const URL_ = () => (process.env.HANDS_URL || "").replace(/\/+$/, "");
const TOKEN = () => process.env.HANDS_TOKEN || "";

export const handsReady = () => !!URL_();

/** 从工作台把一个文件取回来(shim 要转发到 Telegram)。返回 {buf, name} 或抛错。 */
export async function fetchFile(relPath) {
  if (!handsReady()) throw new Error("没接工作台");
  const r = await fetch(`${URL_()}/file?path=${encodeURIComponent(relPath)}`, {
    headers: { "x-token": TOKEN() },
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw new Error(`工作台取文件失败 ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/** 把她发来的文件存进工作台的收件夹。返回工作台给的相对路径。 */
export async function uploadFile(name, buf) {
  if (!handsReady()) throw new Error("没接工作台");
  const r = await fetch(`${URL_()}/upload?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "x-token": TOKEN(), "content-type": "application/octet-stream" },
    body: buf,
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw new Error(`工作台存文件失败 ${r.status}`);
  const j = await r.json();
  return j.path;
}

async function call(path, { method = "GET", timeoutMs = 10000 } = {}) {
  if (!handsReady()) return { ok: false, off: true };
  try {
    const r = await fetch(`${URL_()}${path}`, {
      method,
      headers: { "x-token": TOKEN() },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, data: await r.json() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 急停。返回一句可以直接发给她的话。 */
export async function stopAll() {
  const r = await call("/stop", { method: "POST" });
  if (r.off) return { stopped: 0, text: "" };            // 没接工作台 = 这条不该有反应
  if (!r.ok) return { stopped: null, text: `⚠️ 工作台没连上(${r.status || r.error}),那边的活我停不掉。` };
  const n = r.data?.stopped?.length ?? 0;
  return { stopped: n, text: n ? `⛔ 已经叫停 ${n} 件活。` : "工作台那边本来就没有活在跑。" };
}

/** 活儿清单。返回一句可以直接发给她的话。 */
export async function listJobs() {
  const r = await call("/jobs");
  if (r.off) return "";
  if (!r.ok) return `⚠️ 工作台没连上(${r.status || r.error})。`;
  const jobs = r.data?.jobs || [];
  const live = jobs.filter((j) => j.status === "running");
  if (!jobs.length) return "工作台那边没有活。";
  const line = (j) => `${j.status === "running" ? "▶" : "·"} ${j.name}(${j.id})— ${j.status},${j.elapsedSec}秒`;
  const head = live.length ? `手上有 ${live.length} 件活在跑:` : "手上没有在跑的活。最近几件:";
  return [head, ...jobs.slice(0, 8).map(line)].join("\n");
}

// ---- 她说的话是不是「控制指令」---------------------------------------------
// 沿用 §6 那套「整句很短且包含关键词」的判法:她随口说的长句子不会误触。
// ⚠️ 阈值故意比归档那组更紧(≤4 字):「停」是个太常见的字,
// 「别停」「停车」这种要能正常聊,不能一说就把活掐了。
const STOP_WORDS = ["停", "停下", "别干了", "打住"];
// 反例:这几句里的「停」是相反的意思或别的意思,不能当急停。
const NOT_STOP = ["别停", "不停", "没停", "停车", "停电", "停课"];
const STATUS_WORDS = ["在干嘛", "在忙什么", "干嘛呢", "活儿"];

function strip(s) {
  return (s || "").trim().replace(/^[\s，,。.!！~～、]+|[\s，,。.!！~～、]+$/g, "");
}

export function detectControl(text) {
  const t = strip(text);
  if (!t) return null;
  if (NOT_STOP.some((w) => t.includes(w))) return null;
  for (const w of STOP_WORDS) { if (t === w || (t.length <= 4 && t.includes(w))) return "stop"; }
  for (const w of STATUS_WORDS) { if (t === w || (t.length <= 6 && t.includes(w))) return "status"; }
  return null;
}
