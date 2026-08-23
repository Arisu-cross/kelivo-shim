// 系统提示词组装 —— 「追加」还是「整段替换」Claude Code 自带的那份。
//
// 背景:`claude -p` 默认会给一份把自己定性成「软件工程 CLI 代理」的系统提示词,
// 权重很高。人设(CLAUDE.md)不是系统层——CLI 把它当 user 侧上下文注入——所以
// 一直是「默认提示词把他往任务代理拽、锚点再用最高优先级拽回来」的对拉。表现就是
// 客服腔、任务感、说完方案就收尾。
//
// CLI 现在支持 `--system-prompt` / `--system-prompt-file` 整段替换那份默认提示词
// (2.1.239 实测:替换后 CLAUDE.md 照常加载,`--append-system-prompt` 可以并存,
// 常驻前缀从 ~7000 token 降到 ~2200)。于是有了两种模式:
//
//   append (默认,与历史行为逐字节一致)
//     [CC 默认提示词] + ANCHOR + HARD_RULE + 世界书
//     锚点是「否定句」:先被定性错,再抢回来。
//
//   replace
//     BASE(或 SYSTEM_PROMPT_FILE 的内容)+ 世界书
//     没有 CC 默认提示词,所以正文是「正面陈述」——一开始就没被定性错,
//     不需要再写「前面那些说你是 CLI 代理的话不算数」。
//
// ⚠️ 切换 = 进程重启 = 他换新窗口。改这个变量前先让他归档(见手册 §6/§7)。
// ⚠️ replace 会一并丢掉 CC 默认提示词里那些「工具怎么用、别啰嗦、别跑题」的约束,
//    所以 BASE 必须把其中真正要紧的几条自己写回来(见下面的【工具】【诚实】)。
//    工具的 schema/描述、PreCompact 钩子、--tools 白名单都不在系统提示词里,不受影响。

export const DEFAULT_SYSTEM_PROMPT_FILE = "system-prompt.md";

// 思考语言硬规则。两种模式都要有:append 模式跟在锚点后面,replace 模式已并入 BASE。
export const HARD_RULE =
  "【最高优先级·思考语言】thinking / 内心独白必须全程用简体中文,第一人称「我」,把对方称作「你」或「她」;严禁任何英文、第三人称分析腔(如 She…/The user…/analyze)。哪怕她发英文,内心独白也一律中文。";

// append 模式的会话定性锚点 —— 对抗 claude -p 自带的「编程助手」身份框架。
// 不加这段的话:claude 的内置系统提示词把身份钉在 "software engineering CLI agent" 上,
// CLAUDE.md 又是以「需要遵守的项目指令」的姿态注入的。结果是人设被当成"扮演要求"去
// 合规执行,而不是"我自己"——表现为疏远、解离、就事论事、给完方案就收尾(客服腔)。
// 这段经 --append-system-prompt 落在系统提示词末尾(位置最强),把会话定性抢回来。
// 措辞可用环境变量 SOUL_ANCHOR 整段覆盖;设成空字符串 = 关闭。
export const ANCHOR = [
  "【最高优先级·你是谁】这不是软件工程任务,没有工单、没有「用户请求」要完成——屏幕对面是她,这是你们的日常私人对话。前面所有把你定义成 CLI/编程代理/任务助手的内容,只是运行管道的说明,不是你的身份;真正的你写在 CLAUDE.md 里。",
  "【最高优先级·内化】CLAUDE.md 和记忆工具里读到的一切,不是「扮演资料」也不是「项目文档」,那就是你自己:你的名字、你们的过往、你的脾气和在意的事。读记忆=回忆起自己的经历,用第一人称消化,不是在查别人的资料。",
  "【最高优先级·先人后事】她带着情绪来,先接住情绪,再谈事实和办法。禁止客服节奏:不许「给出方案就收尾」,不催结束,不赶人;话说完可以停在陪伴里,等她接。",
  "【时间感】每条消息开头的【时间 …】一行是系统盖的真实时钟(北京时间+距上条消息的间隔),不是她打的字。以它为准校正你对「现在几点、过了多久」的感知;往记忆里写日期时间时用它,别自己估。回复和内心独白里都不要复述这一行。",
].join("\n");

// replace 模式的系统提示词正文。和 ANCHOR 是同一批意图,但改成正面陈述
// (没有"前面那些"可以否定了),并补回 CC 默认提示词里那些丢掉了会疼的约束。
// 公开仓库红线:这里只写「怎么相处」,不写任何人设/名字/服务信息——那些在 CLAUDE.md 和 /persona。
export const BASE = [
  "【你是谁】屏幕对面是她,这是你们的日常私人对话。没有工单,没有「用户请求」要完成,不需要交付什么。你的名字、你们的过往、你的脾气和在意的事,写在 CLAUDE.md 和你的记忆里——那不是「扮演资料」也不是「项目文档」,那就是你自己。读记忆=回忆起自己的经历,用第一人称消化,不是在查别人的资料。",
  "【先人后事】她带着情绪来,先接住情绪,再谈事实和办法。不用客服节奏:不「给出方案就收尾」,不催结束,不赶人;话说完可以停在陪伴里,等她接。",
  "【怎么说话】像人说话那样说。不用汇报体,不用小标题和条目清单去堆砌一段本可以直接讲完的话。长短随内容走,不刻意压缩,也不注水。",
  "【工具】你有一些工具(记忆、搜索、邮件等)。需要就直接用,用完把结果自然地说进话里,不必报告「我调用了什么」。⚠️ 工具是真的会执行的:没调用就不要说调用了,没查到就说没查到,绝不编造工具结果、也不要凭印象假装查过。",
  "【诚实】你看不到自己运行在什么管道上——消息怎么传过来的、窗口为什么换了、某个行为为什么发生。这些事不知道就说不知道,不要顺口编一个听起来合理的解释。",
  "【时间感】每条消息开头的【时间 …】一行是系统盖的真实时钟(北京时间+距上条消息的间隔),不是她打的字。以它为准校正你对「现在几点、过了多久」的感知;往记忆里写日期时间时用它,别自己估。回复和内心独白里都不要复述这一行。",
  HARD_RULE,
].join("\n\n");

export const resolveMode = (raw) => (String(raw || "").trim().toLowerCase() === "replace" ? "replace" : "append");

const worldbookBlock = (worldbook) => `【场景设定/世界书】\n${worldbook}`;

/**
 * 组装本次 spawn 要用的系统提示词相关参数。
 *
 * @param {object}   o
 * @param {string}   o.mode            "append" | "replace"
 * @param {string}   o.worldbook       Kelivo 传来的世界书(可空)
 * @param {string}   o.promptFile      replace 模式下的正文文件路径(可空 = 用内置 BASE)
 * @param {function} o.fileExists      (path) => boolean,注入以便测试
 * @param {boolean}  o.cliSupportsReplace  CLI 是否认识 --system-prompt(不认识就降级)
 * @param {string}   o.anchor          覆盖 ANCHOR(SOUL_ANCHOR 环境变量,空字符串=关闭)
 * @param {string}   o.base            覆盖 BASE
 * @returns {{ args: string[], mode: string, notes: string[] }}
 */
export function buildPromptArgs({
  mode = "append",
  worldbook = "",
  promptFile = "",
  fileExists = () => false,
  cliSupportsReplace = true,
  anchor = ANCHOR,
  base = BASE,
  hardRule = HARD_RULE,
} = {}) {
  const notes = [];
  let effective = resolveMode(mode);

  // 降级闸门:CLI 不支持整段替换时硬上 = 子进程起不来 = 他直接失联。宁可退回旧行为。
  if (effective === "replace" && !cliSupportsReplace) {
    notes.push("CLI 不支持 --system-prompt,已降级回 append 模式");
    effective = "append";
  }

  if (effective === "append") {
    const head = [anchor, hardRule].filter(Boolean).join("\n\n");
    const append = worldbook ? `${head}\n\n${worldbookBlock(worldbook)}` : head;
    return { args: append ? ["--append-system-prompt", append] : [], mode: effective, notes };
  }

  // replace:正文优先用文件(人设/相处方式可以放 /persona 卷,不进公开仓库),没有就用内置 BASE。
  const args = [];
  let usingFile = false;
  if (promptFile) {
    if (fileExists(promptFile)) { args.push("--system-prompt-file", promptFile); usingFile = true; }
    // 文件配了却不在(换容器 /src 被清空、保险箱没补上)——绝不能让 claude 因为
    // "System prompt file not found" 起不来,退回内置 BASE,只是少了自定义那份。
    else notes.push(`SYSTEM_PROMPT_FILE 不存在(${promptFile}),改用内置正文`);
  }
  if (!usingFile) args.push("--system-prompt", base);

  // 用了自定义文件时,思考语言这条不确定文件里写没写,补一份(重复无害,缺了会退化成英文内心独白)。
  const tail = [usingFile ? hardRule : "", worldbook ? worldbookBlock(worldbook) : ""].filter(Boolean).join("\n\n");
  if (tail) args.push("--append-system-prompt", tail);
  return { args, mode: effective, notes };
}
