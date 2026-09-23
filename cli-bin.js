// cli-bin.js — 按模型挑用哪一份 Claude Code
//
// 为什么要两份:主力 CLI 精确钉在一个验证过思考链的旧版本(别动它),
// 但新模型(如 claude-opus-5-5)旧版不认识,发出去是空回、usage 全零。
// 所以装第二份新版 CLI,**只给点名的新模型用**,其余模型照旧走主力版本 ——
// 老模型的思考链零风险;新模型出问题,删掉 NEXT_CLI_MODELS 里的名字就退回。
//
// 第二份没装上(nextBin 为空)时一律走主力版本,不会因此起不来。

export function parseModelList(s) {
  return String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
}

export function pickCliBin(model, { bin, nextBin, nextModels = [] } = {}) {
  if (nextBin && nextModels.includes(model)) return nextBin;
  return bin;
}
