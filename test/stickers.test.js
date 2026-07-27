// node --test 跑;只测纯函数 splitStickerSegments,不碰网络也不碰文件。
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitStickerSegments } from "../stickers.js";

const has = (n) => ["得意", "委屈", "晚安"].includes(n);

test("纯文字:整段原样、单段", () => {
  assert.deepEqual(splitStickerSegments("今天怎么样?\n早点睡。", has),
    [{ type: "text", content: "今天怎么样?\n早点睡。" }]);
});

test("单标记:只出一个 sticker 段,标记从文字里抹掉", () => {
  assert.deepEqual(splitStickerSegments("[贴纸:得意]", has),
    [{ type: "sticker", content: "得意" }]);
});

test("文字+贴纸混排:按出现顺序,前后文字各自成段", () => {
  assert.deepEqual(splitStickerSegments("知道了。[贴纸:得意]别得寸进尺。", has), [
    { type: "text", content: "知道了。" },
    { type: "sticker", content: "得意" },
    { type: "text", content: "别得寸进尺。" },
  ]);
});

test("多个标记:各自独立、顺序保持", () => {
  assert.deepEqual(splitStickerSegments("[贴纸:委屈]中间插一句[贴纸:晚安]", has), [
    { type: "sticker", content: "委屈" },
    { type: "text", content: "中间插一句" },
    { type: "sticker", content: "晚安" },
  ]);
});

test("未闭合标记:视为普通文本,不吞字", () => {
  const raw = "喏[贴纸:得意 这句没闭合";
  assert.deepEqual(splitStickerSegments(raw, has), [{ type: "text", content: raw }]);
});

test("未知标签:原样保留成文字,和相邻文字并成一段", () => {
  const raw = "前面[贴纸:没这张]后面";
  assert.deepEqual(splitStickerSegments(raw, has), [{ type: "text", content: raw }]);
});

test("全角括号/全角冒号/多余空格:宽松匹配", () => {
  assert.deepEqual(splitStickerSegments("【贴纸:得意】好[ 贴纸 : 晚安 ]", has), [
    { type: "sticker", content: "得意" },
    { type: "text", content: "好" },
    { type: "sticker", content: "晚安" },
  ]);
});

test("已知与未知混排:已知的抽出来,未知的留在文字里", () => {
  assert.deepEqual(splitStickerSegments("[贴纸:哈哈][贴纸:委屈]", has), [
    { type: "text", content: "[贴纸:哈哈]" },
    { type: "sticker", content: "委屈" },
  ]);
});

test("空名字:不当贴纸,原样留着", () => {
  assert.deepEqual(splitStickerSegments("[贴纸:]", has), [{ type: "text", content: "[贴纸:]" }]);
});

test("不传 has 时默认全部命中(注册表由调用方把关)", () => {
  assert.deepEqual(splitStickerSegments("[贴纸:随便什么]"),
    [{ type: "sticker", content: "随便什么" }]);
});
