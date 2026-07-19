// voice.js — [语音] 标记解析 + ElevenLabs TTS(Telegram 语音条用)
//
// 回复文本里 [语音]English content[/语音] 包住的段落转成 Ogg/Opus 语音,
// 其余照常发文字,顺序保持混排。任何环节失败由调用方降级为文字,内容不丢。

import { spawn } from "child_process";

// 宽松匹配:方括号接受半角 [] 与全角 【】 混用,斜杠接受半角/全角。
// 未闭合的开标记匹配不上 → 原样当普通文本,不吞字。
const VOICE_RE = /[\[【]\s*语音\s*[\]】]([\s\S]*?)[\[【]\s*[/／]\s*语音\s*[\]】]/g;

// 语音硬闸:只出英文。命中中日韩汉字/假名/全角形 → 这段绝不送 TTS。
// 汉字(基本+扩展A)、兼容汉字、平/片假名、全角与半角假名标点全覆盖。
// 声音说中文/日文太出戏,宁可降级成文字也不出非英文语音。
const NON_LATIN_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/;

// 把一轮回复切成 [{ type: "text"|"voice", content }] 有序段落。
// 空白的语音段丢弃;文字段原样保留(交给发送方自己 trim/分行)。
// 含非拉丁字符的语音段降级为文字(见 NON_LATIN_RE),不出中文语音。
export function splitVoiceSegments(text) {
  const segs = [];
  let last = 0;
  VOICE_RE.lastIndex = 0;
  for (let m; (m = VOICE_RE.exec(text)); ) {
    if (m.index > last) segs.push({ type: "text", content: text.slice(last, m.index) });
    const inner = m[1].trim();
    if (inner) segs.push({ type: NON_LATIN_RE.test(inner) ? "text" : "voice", content: inner });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ type: "text", content: text.slice(last) });
  return segs;
}

// ElevenLabs TTS → Ogg/Opus Buffer(Telegram sendVoice 要求的格式)。
// 优先请求 opus 直出;拿不到(部分 output_format 有套餐门槛)退 mp3 + ffmpeg 转码。
// voiceSettings 整个对象透传(speed/stability/similarity_boost/style/use_speaker_boost),
// 配方由人耳盲测定,见机教版环境变量表。
export async function ttsOgg({ text, apiKey, voiceId, modelId, voiceSettings, log = () => {} }) {
  const call = async (fmt) => {
    const r = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${fmt}`,
      {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ text, model_id: modelId, voice_settings: voiceSettings }),
        signal: AbortSignal.timeout(60000),
      }
    );
    if (!r.ok) throw new Error(`elevenlabs ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return Buffer.from(await r.arrayBuffer());
  };
  try {
    return await call("opus_48000_64");
  } catch (e) {
    log("[voice] opus direct failed, falling back to mp3+ffmpeg:", e.message);
    return mp3ToOgg(await call("mp3_44100_128"));
  }
}

function mp3ToOgg(mp3) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", ["-i", "pipe:0", "-c:a", "libopus", "-b:a", "48k", "-f", "ogg", "pipe:1"],
      { stdio: ["pipe", "pipe", "pipe"] });
    const out = [], err = [];
    ff.stdout.on("data", (d) => out.push(d));
    ff.stderr.on("data", (d) => err.push(d));
    ff.on("error", reject); // ffmpeg 未安装等
    ff.on("close", (code) => code === 0 && out.length
      ? resolve(Buffer.concat(out))
      : reject(new Error(`ffmpeg exit ${code}: ${Buffer.concat(err).toString().slice(-200)}`)));
    ff.stdin.on("error", () => {}); // EPIPE 由 close 兜底
    ff.stdin.end(mp3);
  });
}
