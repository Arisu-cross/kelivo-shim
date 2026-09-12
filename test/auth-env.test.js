// 上游凭据选择 · 纯逻辑测试
//
// 命根子是这一条:**设了长期令牌,就必须把 CPA 那两个变量摘掉**。
// 不摘的话 CLI 会照走 CPA 而且不报错 —— 人以为换了路,其实没换,
// 跟 9-02 同一类的静默失败(见 auth-env.js 顶部注释)。

import { test } from "node:test";
import assert from "node:assert";
import { buildAuthEnv, authMode } from "../auth-env.js";

// 线上现状:CPA 那两个设着,没有 API key,没有长期令牌
const PROXY_ENV = {
  ANTHROPIC_BASE_URL: "https://kelivo-cpa-7351.example",
  ANTHROPIC_AUTH_TOKEN: "cpa-key",
  SHIM_KEY: "unrelated",
};

test("没设长期令牌 = 完全照旧,CPA 那两个一个都不许动", () => {
  const env = buildAuthEnv(PROXY_ENV);
  assert.equal(env.ANTHROPIC_BASE_URL, "https://kelivo-cpa-7351.example");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "cpa-key");
  assert.equal(authMode(PROXY_ENV), "proxy");
});

test("设了长期令牌 = 摘掉 CPA 的两个变量,令牌留着", () => {
  const src = { ...PROXY_ENV, CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-xxx" };
  const env = buildAuthEnv(src);
  assert.equal("ANTHROPIC_BASE_URL" in env, false, "BASE_URL 没摘 = 还在走 CPA");
  assert.equal("ANTHROPIC_AUTH_TOKEN" in env, false, "AUTH_TOKEN 没摘 = 它优先级更高,会压过令牌");
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat01-xxx");
  assert.equal(authMode(src), "direct");
});

test("ANTHROPIC_API_KEY 任何情况下都不进子进程(它会把额度算成按量计费)", () => {
  for (const extra of [{}, { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-xxx" }]) {
    const env = buildAuthEnv({ ...PROXY_ENV, ANTHROPIC_API_KEY: "sk-ant-api-xxx", ...extra });
    assert.equal("ANTHROPIC_API_KEY" in env, false);
  }
});

test("令牌是空串/空白 = 当没设,老老实实走 CPA", () => {
  // 面板上留一个空值是常见手滑。那种情况下摘掉 CPA 再拿空令牌去连 = 他直接哑掉。
  for (const bad of ["", "   ", undefined, null]) {
    const src = { ...PROXY_ENV, CLAUDE_CODE_OAUTH_TOKEN: bad };
    assert.equal(authMode(src), "proxy");
    assert.equal(buildAuthEnv(src).ANTHROPIC_AUTH_TOKEN, "cpa-key");
  }
});

test("纯函数:不许改动传进来的那份 env", () => {
  const src = { ...PROXY_ENV, CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-xxx", ANTHROPIC_API_KEY: "k" };
  const before = JSON.stringify(src);
  buildAuthEnv(src);
  assert.equal(JSON.stringify(src), before, "改了 process.env 会波及整个进程");
});

test("直连模式下,其余变量原样传下去(人设/语音/MCP 全靠它们)", () => {
  const src = { ...PROXY_ENV, CLAUDE_CODE_OAUTH_TOKEN: "t", GALATEA_TOKEN: "g", ELEVENLABS_API_KEY: "e" };
  const env = buildAuthEnv(src);
  assert.equal(env.SHIM_KEY, "unrelated");
  assert.equal(env.GALATEA_TOKEN, "g");
  assert.equal(env.ELEVENLABS_API_KEY, "e");
});
