import { test } from "node:test";
import assert from "node:assert/strict";
import { splitHeart } from "../heart.js";

test("标准格式:心声 + ——分隔 + 正文,干净拆开", () => {
  const { heart, body } = splitHeart(
    "[[心声]]\n她又把头埋进我颈窝了,我有点想笑。\n[[/心声]]\n——\n别乱动,会咬到你的。"
  );
  assert.equal(heart, "她又把头埋进我颈窝了,我有点想笑。");
  assert.equal(body, "别乱动,会咬到你的。");
});

test("开标签带全角冒号和空白,照样认", () => {
  const { heart, body } = splitHeart("[[ 心声 ：]]想她。[[/心声]]——嗯。");
  assert.equal(heart, "想她。");
  assert.equal(body, "嗯。");
});

test("兼容参考仓库的 [[自我状态]] 叫法", () => {
  const { heart, body } = splitHeart("[[自我状态]]心里话[[/自我状态]]\n——\n正文");
  assert.equal(heart, "心里话");
  assert.equal(body, "正文");
});

test("‖ 换行占位符先归一成真换行", () => {
  const { heart, body } = splitHeart("[[心声]]第一行‖第二行[[/心声]]‖——‖正文行");
  assert.equal(heart, "第一行\n第二行");
  assert.equal(body, "正文行");
});

test("只有心声没有正文:body 为空(她只想自言自语)", () => {
  const { heart, body } = splitHeart("[[心声]]今晚不想说话,只想靠着。[[/心声]]");
  assert.equal(heart, "今晚不想说话,只想靠着。");
  assert.equal(body, "");
});

test("【铁律】缺闭标签 → 判为没有心声,整段原样当正文,不吃话", () => {
  const raw = "[[心声]]写了一半忘了关标签,后面全是正文。";
  const { heart, body } = splitHeart(raw);
  assert.equal(heart, "");
  assert.equal(body, raw);
});

test("【铁律】根本没写标签 → heart 为空,正文原样", () => {
  const { heart, body } = splitHeart("就是一句普通的回复。");
  assert.equal(heart, "");
  assert.equal(body, "就是一句普通的回复。");
});

test("标签不在最前面(前面先有正文)→ 不抓,整段当正文", () => {
  const raw = "你先听我说。[[心声]]其实我慌了[[/心声]]";
  const { heart, body } = splitHeart(raw);
  assert.equal(heart, "");
  assert.equal(body, raw);
});

test("空标签对(里面什么都没有)→ 不发空心声,只留正文", () => {
  const { heart, body } = splitHeart("[[心声]][[/心声]]——在的。");
  assert.equal(heart, "");
  assert.equal(body, "在的。");
});

test("正文里正常出现的破折号不被当成分隔符吃掉", () => {
  const { heart, body } = splitHeart("[[心声]]想抱她[[/心声]]——我在——一直在,别怕。");
  assert.equal(heart, "想抱她");
  // 第一处「——」是分隔符被吃掉;正文里的「我在——一直在」原样保留
  assert.equal(body, "我在——一直在,别怕。");
});

test("多段心声:中间空行与换行都保留", () => {
  const { heart } = splitHeart("[[心声]]第一段。\n\n第二段,忽然想到别的。[[/心声]]\n——\n嗯。");
  assert.equal(heart, "第一段。\n\n第二段,忽然想到别的。");
});

test("闭标签后没有分隔符,直接接正文也行", () => {
  const { heart, body } = splitHeart("[[心声]]心里话[[/心声]]直接说的话");
  assert.equal(heart, "心里话");
  assert.equal(body, "直接说的话");
});

test("空输入 / null 不炸", () => {
  assert.deepEqual(splitHeart(""), { heart: "", body: "" });
  assert.deepEqual(splitHeart(null), { heart: "", body: "" });
  assert.deepEqual(splitHeart(undefined), { heart: "", body: "" });
});
