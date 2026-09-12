// auth-env.js — 决定 claude 子进程拿哪把钥匙去连上游
//
// 背景(2026-09-12):沈渡的订阅授权一直经 CLIProxyAPI(下称 CPA)中转。
// 9-02 那晚 CPA 手里的 OAuth 过期、refresh 也失效,而它**没把上游 401 透传**,
// 回了一个格式合法的空响应 → CLI 重试三分钟后放弃、报 success、正文为空。
// 三层没有任何一层看得见这是个错误,拖了八小时。
// 直连能把这个中间人整个去掉:出事时 401 就是 401,当场报错。
//
// 直连用的是 `claude setup-token` 生成的一年期长期令牌 CLAUDE_CODE_OAUTH_TOKEN。
// 它的权限范围是 user:inference —— 只能发模型请求,建不了远程会话、拿不到
// claude.ai 连接器(都跟沈渡无关);本地 .mcp.json 里那些 MCP 服务不受影响。
//
// ⚠️ 这里唯一的机关,也是这个文件存在的理由:**光设 CLAUDE_CODE_OAUTH_TOKEN 没有用。**
//
// CLI 的凭据优先级是固定的:
//   1 云厂商 → 2 ANTHROPIC_AUTH_TOKEN → 3 ANTHROPIC_API_KEY
//   → 4 apiKeyHelper → 5 CLAUDE_CODE_OAUTH_TOKEN → 6 profile → 7 /login 登录态
//
// 长期令牌排第 5,**排在 CPA 那两个变量后面**。2026-09-12 实测(同时设
// ANTHROPIC_AUTH_TOKEN + CLAUDE_CODE_OAUTH_TOKEN + 一个假的 BASE_URL):
// CLI 照样去拨那个假 BASE_URL,长期令牌被完全无视,**而且一声不吭**。
// 也就是说,只在面板上加一个新变量,结果会是「一切照旧走 CPA」,
// 却让人以为已经换过路了 —— 跟 9-02 同一类的静默失败。
//
// 所以开关做成「令牌在不在」,并且由这个函数负责把挡路的一并摘掉:
//   设了 CLAUDE_CODE_OAUTH_TOKEN → 直连(摘掉 CPA 的 AUTH_TOKEN + BASE_URL)
//   没设                        → 老路,经 CPA,行为与今天逐字节一致
//
// 回退办法:在 Zeabur 面板**删掉 CLAUDE_CODE_OAUTH_TOKEN** + 重启即可,
// 不用回滚代码、不用重新部署。

/**
 * 造一份给 claude 子进程用的环境变量。纯函数,不改传进来的那份。
 * @param {object} src 通常是 process.env
 */
export function buildAuthEnv(src = {}) {
  const env = { ...src };

  // API key 任何时候都不该出现在他的进程里:它排在订阅授权前面,
  // 一旦存在,这一轮就会走按量计费而不是栖栖的订阅额度。
  delete env.ANTHROPIC_API_KEY;

  if (hasToken(src)) {
    // 直连:把优先级高于长期令牌的那两个摘掉,否则它们会静默压过它(见上）。
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_BASE_URL;
  }

  return env;
}

/** 这一次 spawn 走的是哪条路,用于开机日志与 /health 自查 */
export function authMode(src = {}) {
  return hasToken(src) ? "direct" : "proxy";
}

// 空字符串 / 全是空格一律当「没设」—— 面板上留一个空值是常见的手滑,
// 那种情况下应该老老实实走 CPA,而不是摘掉 CPA 的变量后拿一个空令牌去连。
function hasToken(src) {
  return String(src?.CLAUDE_CODE_OAUTH_TOKEN || "").trim() !== "";
}
