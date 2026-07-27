// stickers.js — [贴纸:名字] 标记解析 + 表情包注册表(Telegram sendSticker 用)
//
// 回复文本里的 [贴纸:名字] 认出来就发对应的原生贴纸,标记本身从文字里抹掉;
// 名字不在注册表里、或标记没闭合,一律原样当普通文本留着——宁可露出标记也不吞字。
// 解析全在这一层做,模型只管写标记,不知道也不需要知道底下怎么发。
//
// 注册表(名字→file_id/本地文件)是私人内容,不进这个仓库:
// 正本放持久卷,路径由 STICKER_REGISTRY / STICKER_DIR 给,缺省即整个功能静默关闭。

import fs from "fs";
import path from "path";

// 宽松匹配:方括号接受半角 [] 与全角 【】混用,冒号半角/全角都认,标记内外多余空格都容忍。
// 名字里不允许出现括号和换行——避免一个没闭合的标记把后面半篇回复都吃掉。
const STICKER_RE = /[[【]\s*贴纸\s*[:：]\s*([^[\]【】\n]{1,32}?)\s*[\]】]/g;

// 把一段文字切成 [{ type: "text"|"sticker", content }] 有序段落。
// has(name) 决定某个名字算不算数:命中→独立贴纸段;没命中→标记原样并回文字,
// 所以未知标签的后果只是「聊天里看得见一个标记」,消息本身照常发出去。
export function splitStickerSegments(text, has = () => true) {
  const segs = [];
  let buf = "";
  let last = 0;
  const flush = () => { if (buf) segs.push({ type: "text", content: buf }); buf = ""; };
  STICKER_RE.lastIndex = 0;
  for (let m; (m = STICKER_RE.exec(text)); ) {
    buf += text.slice(last, m.index);
    const name = m[1].trim();
    if (name && has(name)) { flush(); segs.push({ type: "sticker", content: name }); }
    else buf += m[0];                       // 未知标签:原样保留
    last = m.index + m[0].length;
  }
  buf += text.slice(last);
  flush();
  return segs;
}

// ---- 注册表 ------------------------------------------------------------------
// 形态:{ "得意": { file_id: "CAAC…", file: "deyi.webp", emoji: "😏", added: "2026-07-27" } }
// file_id 是 Telegram 那边的永久句柄,首次上传后回写,之后重启/重部署都直接复用,不必重传。
// file 是持久卷上的 webp 文件名,只在还没有 file_id(或 file_id 失效)时用来上传一次。

export function loadStickers(file, log = () => {}) {
  if (!file) return {};
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    const out = {};
    for (const [k, v] of Object.entries(j)) {
      const name = String(k).trim();
      if (!name) continue;
      if (typeof v === "string") out[name] = { file_id: v };            // 极简写法也认
      else if (v && typeof v === "object") out[name] = { ...v };
    }
    log("[sticker] loaded", Object.keys(out).length, "from", file);
    return out;
  } catch (e) {
    if (e.code !== "ENOENT") log("[sticker] registry unreadable:", e.message); // 坏文件不影响聊天
    return {};
  }
}

// 原子写:先写临时文件再 rename,防止半截文件把下次开机的注册表毁掉。
export function saveStickers(file, reg, log = () => {}) {
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch (e) { log("[sticker] save failed:", e.message); return false; }
}
