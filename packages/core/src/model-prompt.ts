/**
 * 发给模型的提示词：系统提示、镜像消息的构造与截断（v1.0.0）。
 *
 * ## 这一层解决什么问题
 *
 * 模型这一环是整个仓库里**最黑**的一环：输入是几千字的提示词，输出是一段 JSON，
 * 中间没有任何东西落在日志或界面上。于是「模型为什么这么答」永远答不出来——
 * 只能看到结论（看多 / 看空 / 止损几个 ATR），看不到**它当时看见了什么**。
 *
 * 把提示词同步发到飞书群，就是在补这条线索：排障时群里那条消息就是**逐字**发给
 * 模型的东西（不是「大概的意思」，不是重新拼的）。
 *
 * ## 三条口径
 *
 * 1. **逐字**。镜像的是**真正发出去的那一组消息**，不是重新拼一份——
 *    重新拼的那份与模型看见的那份一旦有出入，线索就废了。
 *    所以调用方把同一个数组既用来调模型、也用来镜像。
 * 2. **默认不勾**。提示词里带着行情与账户权益，发到群里等于把仓位信息交给第三方。
 *    提示词镜像是**唯二默认关闭**的通知内容（`notify.ts` 的 `DEFAULT_NOTIFY_KINDS`）。
 * 3. **截断要看得见**。提示词可能超过飞书单条消息的上限，截断时**必须写明**截了多少——
 *    悄悄截掉一半的提示词，比不发更坏：人会以为那就是模型看见的全貌。
 *
 * ## 为什么不放在 `notify.ts` 里
 *
 * `notify.ts` 说的是「一条通知长什么样、怎么发出去」，它不该知道提示词来自哪里。
 * 而这里说的是「提示词长什么样、是谁发的」——是**领域**的东西，因此住在 core。
 */

import type { NotifyEvent, PromptMirrorKind } from './notify.js';

/**
 * 一条对话消息。
 *
 * 与 `packages/data` 的 `LlmMessage` **同形**（结构相同即可互相赋值），
 * 但这里自己声明一份：core 不依赖 `packages/data`（AGENTS.md 约定 1）。
 */
export interface AgentPromptMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * 两个 Agent 共用的系统提示。**只此一份**。
 *
 * 它原来住在 `apps/agent/src/service.ts`，而镜像要发的正是它——
 * 搬家是为了让「模型看见的」与「群里看到的」永远是同一份字符串。
 */
export const AGENT_SYSTEM_MESSAGE: AgentPromptMessage = {
  role: 'system',
  content:
    '你只输出 JSON 对象。不要输出任何解释性文字，不要用 markdown 代码块标记。' +
    '不要输出你没被要求输出的字段。',
};

/**
 * **提示词的来源**：谁发的这一组消息。
 *
 * 每一种来源归属**一种勾选项**（`kind`）：用户可以在控制面分别决定要不要看。
 * 分开的理由是频率差得远——Agent 每标的每轮两条，executor **每次成交**一条。
 */
export type PromptSource = 'agent-analyst' | 'agent-trader' | 'executor-decision';

/** 每种来源：归属哪种勾选项 + 群里怎么称呼它。 */
export const PROMPT_SOURCE_INFO: Record<PromptSource, { kind: PromptMirrorKind; label: string }> = {
  'agent-analyst': { kind: 'agent-prompt', label: '分析师' },
  'agent-trader': { kind: 'agent-prompt', label: '交易员' },
  'executor-decision': { kind: 'decision-prompt', label: '止盈止损档位' },
};

/** 消息角色在正文里的标签。 */
const MESSAGE_ROLE_LABEL: Record<AgentPromptMessage['role'], string> = {
  system: '系统提示',
  user: '用户提示',
  assistant: '助手回复',
};

/**
 * 镜像出去的提示词**最长多少字**。
 *
 * 依据是飞书自定义机器人的**卡片请求体上限 30 KB**（官方《自定义机器人使用指南》，
 * 契约核对日期 2026-10-19）。中文在 UTF-8 里占 3 字节，所以 6000 字最坏约 18 KB，
 * 加上卡片外壳仍有余量。
 *
 * 为什么不用文本消息那条路（上限大得多）：卡片有头部配色与标题，
 * 群里扫一眼就知道「这是提示词、哪个标的、谁发的」。
 */
export const MAX_AGENT_PROMPT_CHARS = 6000;

/**
 * 给结尾那句「已截断」预留的字数。
 *
 * 预留而不是精确计算：标记里带着原文长度，那个数字的位数会变，
 * 精确算就得写成循环。留 80 字足够（标记最长约 50 字），而总数仍然**不超过**上限。
 */
const TRUNCATION_MARKER_RESERVE = 80;

/** 截断的结果。 */
export interface TruncatedPrompt {
  /** 截断后的正文（末尾带「已截断」说明，若被截过）。 */
  text: string;
  /** 有没有被截断。 */
  truncated: boolean;
  /** 原文多少字。 */
  originalChars: number;
}

/**
 * 截断提示词，**截了要写明**。
 *
 * 为什么要写明：群里那条消息如果只是「提示词的前一半」而没有任何说明，
 * 排障的人会以为模型就看见了这些——而模型看见的是全部。
 * 一句「已截断：原文共 N 字，这里只发了前 M 字」把这件事说清楚。
 *
 * 顺带处理一个容易漏的细节：按 UTF-16 码元切可能把一个**代理对**
 * （emoji 之类）切成两半，群里就会显示成乱码。切完检查一下末尾，
 * 落在代理对前半截就把最后一个码元去掉。
 */
export function truncateAgentPrompt(
  prompt: string,
  maxChars: number = MAX_AGENT_PROMPT_CHARS,
): TruncatedPrompt {
  if (prompt.length <= maxChars) {
    return { text: prompt, truncated: false, originalChars: prompt.length };
  }
  const keep = Math.max(0, maxChars - TRUNCATION_MARKER_RESERVE);
  let head = prompt.slice(0, keep);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    // 末尾是代理对的前半截：整个字丢掉，宁可少一个也不能发乱码。
    head = head.slice(0, -1);
  }
  const marker = `\n…（已截断：原文共 ${String(prompt.length)} 字，这里只发了前 ${String(head.length)} 字）`;
  return { text: head + marker, truncated: true, originalChars: prompt.length };
}

/**
 * 把真正发给模型的那一组消息，变成一条通知。
 *
 * **纯函数**（AGENTS.md 约定 4）：同样的输入永远给出同样的消息。
 *
 * @param source 谁发的这一组消息（决定归属哪种勾选项与标题里的称呼）。
 * @param symbol 标的。
 * @param messages **真正发出去的那一组消息**（含系统提示）。
 * @param maxChars 正文上限，缺省 {@link MAX_AGENT_PROMPT_CHARS}。
 */
export function buildPromptEvent(input: {
  source: PromptSource;
  symbol: string;
  messages: readonly AgentPromptMessage[];
  maxChars?: number;
}): NotifyEvent {
  const info = PROMPT_SOURCE_INFO[input.source];
  const body = input.messages
    .map((message) => `【${MESSAGE_ROLE_LABEL[message.role]}】\n${message.content}`)
    .join('\n\n');
  const truncated = truncateAgentPrompt(body, input.maxChars);
  return {
    category: 'info',
    severity: 'info',
    title: `模型提示词 · ${input.symbol} · ${info.label}`,
    lines: [truncated.text],
    footer: `提示词原文共 ${String(truncated.originalChars)} 字`,
  };
}
