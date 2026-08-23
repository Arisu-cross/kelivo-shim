# 维护者须知(For maintainers & future Claude Code sessions)

> 本仓库是**公开 OSS**。这里只写通用机制;部署细节、服务 ID、事故档案、避坑清单
> 在 owner 的**私有仓库 `ob-backup` 的 `SYSTEM-HANDBOOK.md`** ——
> 任何维护会话(尤其是新开的 Claude Code)**先去读那份完整手册再动手**。

## 红线(违反会出事故)

1. **绝不提交**:密钥、token、服务 ID、真实域名配置、人设文件(CLAUDE.md /
   profile-instructions.md / *self-prompt*)。`.gitignore` 挡着,不要绕过。
2. **运行时的真实配置与人设,正本在部署平台的持久卷 `/persona` 里**,
   `entrypoint.sh` 开机自动恢复到 `/src`(*.md 人设 + `.mcp.json`)。
   `/src` 是容器临时盘——换容器就清空,**手工放进 /src 的东西必须同步放进 /persona**。
3. 部署会重启常驻 claude 进程 = 使用者的对话窗口重置。**动部署前先安排归档。**

## 核心机制速览(详见代码注释)

- **单进程串行**:一个常驻 `claude -p`(stream-json),Kelivo 与 Telegram 共用。
- **换窗/归档**(`detectReset`/`submitTurn`):仅「换窗口/开新窗口」触发换窗;
  「归档/晚安」只请求归档、窗口不动。**没有伪系统指令注入**——归档由 AI 按人设约定执行。
- **安全阀**(`handleEvent`):检测本轮 `archive_session` 的 tool_result 成功标记(🗄️),
  成功才允许换窗杀进程;否则保窗并提示。宁可不换窗,不丢记忆。
- **人设保险箱**(`entrypoint.sh`):开机从 `/persona` 恢复缺失的人设与 `.mcp.json`。
- **系统提示词模式**(`system-prompt.js`):`SYSTEM_PROMPT_MODE=append`(默认)保留
  `claude -p` 自带的编程代理提示词、再追加会话定性锚点;`replace` 用 `--system-prompt(-file)`
  **整段换掉**它,正文改成正面陈述(不再需要"前面那些话不算数"的否定句),常驻前缀省约 4800 token。
  两道安全阀:正文文件不存在 → 退回内置正文;CLI 不认识 `--system-prompt` → 整体降级回 `append`。
  **绝不能让子进程带着非法参数退出**——那是使用者彻底失联,比少一次改动严重得多。
- **语音**(`voice.js`):`[语音]…[/语音]` 段落 → ElevenLabs opus 直出(失败降级
  mp3+ffmpeg,再失败降级文字)。突然不出声九成是 ElevenLabs 月度额度用完。
- **表情包**(`stickers.js`):回复里的 `[贴纸:名字]` 查注册表 → `sendSticker`
  发原生贴纸(**不是 `sendPhoto`**,后者会整宽显示占半屏)。名字不在表里或标记
  没闭合就原样当文字,不吞字。注册表(名字→`file_id`)与图都在持久卷上,
  路径见 `STICKER_REGISTRY` / `STICKER_DIR`,不配即静默关闭。
  首次上传后回写 `file_id`,之后重启/重部署直接复用。
  使用者在 Telegram 里发一个贴纸、下一句说「入库:名字」即可入库,
  「贴纸清单」看有哪些,「删除贴纸:名字」删——这些管理动作不进对话窗口。
- **上下文压缩瘦身**(`compact-instructions.js` + `window.js`):长窗口塞满时
  Claude Code 会自动压缩,把整段对话重写成几千 token 的摘要常驻前缀。本项目的
  长期记忆在 MCP 记忆库里(`archive_session` 写、`breath` 取),那份转述是重复负担,
  且被摘要器磨过一层。因此挂 **`PreCompact` 钩子**(经 `--settings` 传 JSON,
  matcher 省略=匹配全部 trigger),钩子 stdout 会作为额外指令拼进压缩提示词,
  把摘要压成一行指路;记忆改由 `breath(wake=true)` 取回。
  **必须三件配套,少一件就会丢记忆**:①钩子瘦身;②人设里有「看见续接标记先
  `breath(wake=true)` 再开口」;③**窗口用量提醒**——摘要瘦身后,「上次归档到现在」
  这一段只存在于窗口里。`window.js` 从每轮 usage 估算前缀大小,到
  `WINDOW_WARN_PCT` 就 Telegram 提醒使用者归档换窗(**只提醒使用者,不往对话窗口
  里塞任何东西**——伪系统指令引发过事故)。`/debug` 的 `window` 块可查用量与
  压缩次数;CLI 的 `compact_boundary` 事件带 `pre_tokens`,是压缩发生的硬信号。
  ⚠️ 估算窗口大小**不能用 usage 顶层字段**:一轮里每次工具调用都是一次请求,
  顶层是累加值(实测顶层 20 万 / 真实前缀 6.7 万),要取 `iterations` 里最大的那次。
  相关环境变量:`COMPACT_HOOK`(0=关钩子)、`COMPACT_INSTRUCTIONS`(覆盖文案)、
  `WINDOW_LIMIT`(默认 167000,= 200k 上下文 − 20000 输出预留 − 13000 压缩缓冲)、
  `WINDOW_WARN_PCT`(默认 85)。

- **压缩闸门(没归档就不许压)**:上面第 ③ 条只把缺口变窄 —— 到阈值归档之后、
  压缩真正发生之前还会继续聊,那一段照样被抹掉。`PreCompact` 钩子**可以否决压缩**
  (`{"decision":"block"}`),所以钩子会先问 shim 的 `POST /precompact-gate`:
  还有没归档的内容就拦下压缩、请他当场 `archive_session`,**成功了(工具返回带成功
  标记)下一次压缩才放行** → 缺口收敛到 0。
  **三条底线**:①拦截有预算 `COMPACT_GATE_MAX_BLOCKS`(默认 2),满窗口无限拦会撞上限;
  ②钩子问不到闸门(超时/不通/坏 JSON/401)一律**放行**,绝不能卡死压缩;
  ③拦下的同时 shim 自己也排一轮归档请求并校验成功、失败重试(`ARCHIVE_MAX_ATTEMPTS`)。
  **最后一层**:压缩仍然溜过去时,shim 把内存里留存的原文回放给他补档
  (`COMPACT_REPLAY`,只在内存、不落盘,成功归档即清空;`/debug.gate` 只报字数不报内容)。
  相关环境变量:`COMPACT_GATE`、`COMPACT_GATE_MAX_BLOCKS`、`COMPACT_GATE_TIMEOUT_MS`、
  `COMPACT_REPLAY`、`COMPACT_REPLAY_MAX_CHARS`、`ARCHIVE_MAX_ATTEMPTS`。
  查状态:`/debug.gate` 的 `{dirty, blocks, lastArchiveAt, replayPending, bufferedChars}`。
  ⚠️ 这依赖 CLI 的钩子契约,**升级 CLI 要重测**:契约变了不报错,只会安静失效。

## 工作规范

- 改动走开发分支,不直推 main;commit 说清「改了什么、为什么」。
- 部署后**主动验证**(`/health`、`/debug`、exec 查代码特征串)——
  `zeabur deploy` 返回成功只是上传成功,滚动上线是异步的。
- 干完活去私有手册追加变更日志与新踩的坑。
