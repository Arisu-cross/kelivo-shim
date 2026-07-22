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
- **语音**(`voice.js`):`[语音]…[/语音]` 段落 → ElevenLabs opus 直出(失败降级
  mp3+ffmpeg,再失败降级文字)。突然不出声九成是 ElevenLabs 月度额度用完。

## 工作规范

- 改动走开发分支,不直推 main;commit 说清「改了什么、为什么」。
- 部署后**主动验证**(`/health`、`/debug`、exec 查代码特征串)——
  `zeabur deploy` 返回成功只是上传成功,滚动上线是异步的。
- 干完活去私有手册追加变更日志与新踩的坑。
