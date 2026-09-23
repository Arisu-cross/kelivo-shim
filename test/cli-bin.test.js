import { test } from "node:test";
import assert from "node:assert/strict";
import { pickCliBin, parseModelList } from "../cli-bin.js";

const opts = { bin: "/old/claude", nextBin: "/new/claude", nextModels: ["claude-opus-5-5"] };

test("点名的新模型走新版 CLI", () => {
  assert.equal(pickCliBin("claude-opus-5-5", opts), "/new/claude");
});

test("其余模型照旧走主力 CLI(思考链不受影响)", () => {
  for (const m of ["claude-opus-4-6", "claude-opus-4-8", "claude-fable-5", "claude-opus-5"]) {
    assert.equal(pickCliBin(m, opts), "/old/claude");
  }
});

test("新版没装上时一律退回主力 CLI", () => {
  assert.equal(pickCliBin("claude-opus-5-5", { ...opts, nextBin: "" }), "/old/claude");
});

test("名单清空 = 全部退回主力 CLI", () => {
  assert.equal(pickCliBin("claude-opus-5-5", { ...opts, nextModels: parseModelList("") }), "/old/claude");
});

test("名单解析去空格、去空项", () => {
  assert.deepEqual(parseModelList(" a , ,b "), ["a", "b"]);
});

test("带 [1m] 后缀的模型也走新版 CLI(名单只写基础名)", () => {
  assert.equal(pickCliBin("claude-opus-5-5[1m]", opts), "/new/claude");
  assert.equal(pickCliBin("claude-opus-4-6[1m]", opts), "/old/claude");
});
