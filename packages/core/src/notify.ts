/**
 * 通知层（v0.8.0）：把「系统里发生的事」推到**人看得到的地方**。
 *
 * 为什么有这一层：这个仓库里最贵的故障不是「报错」，而是**没人知道**。止盈止损挂单失败、
 * 仓位在交易所裸奔、工具外的仓位——这些事在日志里只是几行 warn，而日志没人盯着。
 * 对账已经能判出这些事（`packages/core/src/reconcile.ts`），缺的是一个**出口**。
 *
 * 三条口径，不可协商：
 *
 * 1. **推送失败必须抛错**。静默失败等于没接：调用方会以为「已经通知过了」，
 *    而群里什么都没有。这正是 AGENTS.md 约定 9 说的「看起来成功其实什么都没做」。
 * 2. **推送绝不影响主流程**。对账失败绝不能拖垮挂单（AGENTS.md 对账层规则 1），
 *    因此**调用方**负责兜住异常并记日志，本文件不吞错误。
 * 3. **同一件事不许反复刷屏**。对账每 5 分钟跑一次，一个持续存在的裸仓若每轮都推，
 *    群里三天就没人看了——而「没人看」等于没接。因此推送要**去重 + 冷却**，
 *    并在问题消失时推一条「已恢复」。
 *
 * 通道选的是**飞书自定义机器人的 webhook**（不是机器人应用）：它不需要管理员审核、
 * 不需要申请消息权限，配一个地址就能用，适合「服务往群里推告警」这件事。
 * 契约核对日期 **2026-10-19**（官方《自定义机器人使用指南》）。
 */

import { createHmac } from 'node:crypto';

import { SyncError, type SyncErrorCode } from './market-sync.js';
import { RECONCILE_KIND_INFO, RECONCILE_KINDS } from './reconcile.js';

/**
 * **要通知哪些内容**的完整清单。
 *
 * 两类来源合成一份：
 *   * 交易对账的差异类型（`RECONCILE_KINDS`，8 种）——「哪种异常要我知道了」；
 *   * 交易生命周期事件（2 种）——「止盈止损挂上了」「这一轮走完了」。
 *
 * 合成一份而不是两套机制：用户在一个列表里勾，页面也只有一份清单可显示。
 * 清单与文案都由服务端下发（`NOTIFY_KIND_INFO`），页面不自己抄一份——抄了就会漂。
 */
export const NOTIFY_KINDS = [
  ...RECONCILE_KINDS,
  'bracket-armed',
  'bracket-settled',
  'llm-fallback',
] as const;

export type NotifyKind = (typeof NOTIFY_KINDS)[number];

/** 每个内容类型的**中文名与一句话说明**（页面的勾选项文案）。 */
export const NOTIFY_KIND_INFO: Record<NotifyKind, { label: string; hint: string }> = {
  ...RECONCILE_KIND_INFO,
  'bracket-armed': {
    label: '止盈止损挂单成功',
    hint: '成交后两张条件单都挂上了，附预估收益与预估亏损（计价币）',
  },
  'bracket-settled': {
    label: '一轮买卖完成',
    hint: '这一轮平掉了，附实际盈亏（已扣手续费，计价币）',
  },
  'llm-fallback': {
    label: 'LLM 决策降级',
    hint: '模型这一轮没给出可用档位，本次按 risk_policy 的配置挂单（仓位仍受保护）',
  },
};

/** 通知的严重度。顺序即优先级：`critical` 最要紧。 */
export type NotifySeverity = 'critical' | 'warning' | 'info';

/**
 * 全部严重度。**只在这里列一次**：`config.ts` 的 zod 枚举从这里取，
 * 免得「配置能填的值」与「代码认的值」各有一份（漂移的经典形态）。
 */
export const NOTIFY_SEVERITIES = ['critical', 'warning', 'info'] as const;

const SEVERITY_RANK: Record<NotifySeverity, number> = { critical: 3, warning: 2, info: 1 };

/** 人话标签，进消息第一行。 */
const SEVERITY_LABEL: Record<NotifySeverity, string> = {
  critical: '紧急',
  warning: '注意',
  info: '提示',
};

/** 严重度的可比较大小。用于「只推不低于某个级别」这类过滤。 */
export function severityRank(severity: NotifySeverity): number {
  return SEVERITY_RANK[severity];
}

/** 严重度的人话标签（「紧急」/「注意」/「提示」）。**只有这一份**。 */
export function severityLabel(severity: NotifySeverity): string {
  return SEVERITY_LABEL[severity];
}

/**
 * 通知的**类型**。
 *
 * 为什么要单独一维：飞书的消息列表里只显示卡片的头部标题，于是「这是什么事」
 * 必须在那一眼里说得清。严重度回答「急不急」，类型回答「是什么事」，两件事。
 */
export type NotifyCategory = 'risk' | 'error' | 'trade' | 'info';

/** 每种类型的标签与图标。**只有这一份**。 */
export const NOTIFY_CATEGORY_META: Record<NotifyCategory, { label: string; emoji: string }> = {
  // 止盈止损挂上了：这类是「保护已就位」。
  risk: { label: '止盈止损', emoji: '🛡️' },
  // 报错：仓位有问题、或者决策降级了。
  error: { label: '报错', emoji: '🚨' },
  // 成交：一轮买卖走完了，附实际盈亏。
  trade: { label: '成交', emoji: '💰' },
  // 提示：其余（例如「发送测试消息」）。
  info: { label: '提示', emoji: 'ℹ️' },
};

/** 一条要推出去的通知。 */
export interface NotifyEvent {
  /**
   * 推送类型。**进消息标题**——消息列表里只看得到标题，
   * 所以「这是止盈止损还是报错还是成交」必须在这一眼里说得清。
   */
  category?: NotifyCategory;
  /** 一句话标题。给人看的，不是给机器解析的。 */
  title: string;
  severity: NotifySeverity;
  /** 正文行，逐行展示。 */
  lines?: readonly string[];
  /**
   * **要突出的数值**（盈亏金额之类）。
   *
   * 卡片里加粗；纯文本兜底时同样展示，只是不加粗。
   * 单独一栏而不是塞进 `lines`，是因为「加粗」是卡片的表达方式，
   * 而文案本身不该带着 markdown 符号。
   */
  highlights?: readonly string[];
  /** 卡片底部的小字（来源、时间等）。可选。 */
  footer?: string;
}

/**
 * 通知通道。
 *
 * 刻意只有一个方法：加第二个方法（「发文件」「发卡片」）之前，先想清楚是不是在造一个
 * 没人用的能力面（AGENTS.md 约定 9 的同一条精神）。
 */
export interface Notifier {
  /** 关闭时为 `false`。调用方据此知道「这件事没在做」，而不是以为发出去了。 */
  readonly enabled: boolean;
  /** 发送一条通知。**失败必须抛错**——见文件头第 1 条。 */
  notify(event: NotifyEvent): Promise<void>;
}

/**
 * 拼出飞书**纯文本**消息的内容（卡片发不出去时的兜底）。
 *
 * 第一行固定带 `trade-tool 告警` 三个字：飞书自定义机器人可以配「自定义关键词」，
 * 只有正文里**包含**关键词才放行（否则返回 19024）。固定前缀让「配了关键词」的群
 * 也能收到消息，而不用把关键词塞进每一句告警文案里。
 */
export function formatFeishuText(event: NotifyEvent): string {
  const category = NOTIFY_CATEGORY_META[event.category ?? 'info'];
  const lines = [
    `【trade-tool 告警·${category.label}·${SEVERITY_LABEL[event.severity]}】${event.title}`,
  ];
  for (const line of event.lines ?? []) {
    if (line !== '') lines.push(line);
  }
  for (const line of event.highlights ?? []) {
    if (line !== '') lines.push(line);
  }
  if (event.footer !== undefined && event.footer !== '') lines.push(event.footer);
  return lines.join('\n');
}

/** 卡片头部的配色。严重度一眼可见，不靠人读文字。 */
const CARD_TEMPLATE: Record<NotifySeverity, string> = {
  critical: 'red',
  warning: 'orange',
  info: 'blue',
};

/**
 * 拼出飞书**卡片**（`msg_type: "interactive"`）。
 *
 * 为什么用卡片：纯文本在群里就是一坨字，看不出轻重缓急。卡片的**头部颜色**按严重度分
 * （紧急红 / 注意橙 / 提示蓝），扫一眼就知道要不要立刻处理。
 *
 * 头部标题固定带 `trade-tool 告警`：飞书的「自定义关键词」只对 `text` / `title` 这类
 * 文本参数生效（官方文档原话），卡片的 `header.title` 正是 title 参数——关键词写在
 * 标题里就能过检。正文**不重复**这个前缀（卡片已经很明显了）。
 *
 * 形状照官方《自定义机器人使用指南》里的卡片示例（`schema: "2.0"`）。
 */
export function formatFeishuCard(event: NotifyEvent): Record<string, unknown> {
  const category = NOTIFY_CATEGORY_META[event.category ?? 'info'];
  const elements: Record<string, unknown>[] = (event.lines ?? [])
    .filter((line) => line !== '')
    .map((line) => ({
      tag: 'markdown',
      content: line,
      text_align: 'left',
      text_size: 'normal_v2',
      margin: '0px 0px 0px 0px',
    }));
  // 数值单独一段并**加粗**：盈亏金额是这张卡里最该被一眼看到的东西。
  const highlights = (event.highlights ?? []).filter((line) => line !== '');
  if (highlights.length > 0) {
    elements.push({
      tag: 'markdown',
      content: highlights.map((line) => `**${line}**`).join('\n'),
      text_align: 'left',
      text_size: 'normal_v2',
      margin: '4px 0px 0px 0px',
    });
  }
  if (event.footer !== undefined && event.footer !== '') {
    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: event.footer }],
    });
  }
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      wide_screen_mode: true,
      style: {
        text_size: {
          normal_v2: { default: 'normal', pc: 'normal', mobile: 'heading' },
        },
      },
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 12px 12px',
      elements,
    },
    header: {
      // 标题 = 类型 + 图标 + 具体是什么事。飞书的消息列表只显示这一行，
      // 所以「这是止盈止损 / 报错 / 成交」必须在这里就说清。
      title: {
        tag: 'plain_text',
        content: `${category.emoji} ${category.label} · ${event.title}`,
      },
      // 副标题带固定前缀：飞书的「自定义关键词」只对 text / title 这类文本参数生效，
      // 标题里必须能命中关键词。
      subtitle: {
        tag: 'plain_text',
        content: `trade-tool 告警 · ${SEVERITY_LABEL[event.severity]}`,
      },
      template: CARD_TEMPLATE[event.severity],
      padding: '12px 12px 12px 12px',
    },
  };
}

/**
 * 飞书自定义机器人的签名（官方「签名校验」）。
 *
 * 官方算法（2026-10-19 核对）：把 `timestamp + "\n" + 密钥` 当作**签名字符串**，
 * 用 HmacSHA256 对**空串**计算签名（即：以签名字符串为 HMAC 的 key），再 Base64。
 *
 * ```python
 * string_to_sign = '{}\n{}'.format(timestamp, secret)
 * hmac_code = hmac.new(string_to_sign.encode("utf-8"), digestmod=hashlib.sha256).digest()
 * sign = base64.b64encode(hmac_code).decode('utf-8')
 * ```
 *
 * `timestamp` 是**秒**，且距发送时刻不能超过 1 小时（官方硬性要求，超了返回 19021）。
 */
export function feishuSign(timestampSeconds: number, secret: string): string {
  const stringToSign = `${String(timestampSeconds)}\n${secret}`;
  return createHmac('sha256', stringToSign).update('').digest('base64');
}

/** 最小化的 HTTP 客户端接口：只声明本文件用到的两个方法，测试可整体替身。 */
export interface FeishuHttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type FeishuFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<FeishuHttpResponse>;

export interface FeishuNotifierOptions {
  /** 机器人给的 webhook 地址，形如 `https://open.feishu.cn/open-apis/bot/v2/hook/xxx`。 */
  webhookUrl: string;
  /** 签名密钥。机器人的「安全设置」选了「签名校验」时才需要，否则留空。 */
  secret?: string;
  /** 单次请求超时（毫秒）。 */
  timeoutMs?: number;
  /** 注入的 HTTP 客户端，测试用。 */
  fetchImpl?: FeishuFetch;
  /** 注入的时钟，测试用。 */
  now?: () => number;
}

/**
 * 飞书业务错误码 → 本仓库的错误码。
 *
 * 只复用**已有**的码，不新增：跨语言接缝约定「错误码与 `SyncErrorCode` 一一对应」，
 * 加一个只有 TS 侧会抛的码会让那条约定变得可疑。
 *
 * | 飞书 code | 含义                | 本仓库码        |
 * | --------- | ------------------- | -------------- |
 * | 11232     | 限频                | `RATE_LIMITED` |
 * | 19021     | 签名不匹配 / 超 1 小时 | `CONFIG_INVALID` |
 * | 19022     | IP 不在白名单        | `CONFIG_INVALID` |
 * | 19024     | 关键词不匹配        | `CONFIG_INVALID` |
 *
 * 19021 / 19022 / 19024 都是「配错了」，不是「服务坏了」——处置是改配置，
 * 因此归到 `CONFIG_INVALID`，错误消息里会写清怎么改。
 */
function feishuErrorCode(code: number): SyncErrorCode {
  if (code === 11232) return 'RATE_LIMITED';
  if (code === 19021 || code === 19022 || code === 19024) return 'CONFIG_INVALID';
  return 'INTERNAL_ERROR';
}

/**
 * 飞书自定义机器人 webhook 通道。
 *
 * 只发**文本**消息（`msg_type: "text"`），不发卡片：官方文档写明「自定义关键词只对
 * `text`、`title` 这类文本参数值生效」，正文用文本才能兼容配了关键词的群；
 * 而卡片那条路（`msg_type: "interactive"`）的 body 是 markdown 元素，关键词根本不会
 * 去那里匹配——结果是「配了关键词的群收不到卡片」。
 */
export class FeishuNotifier implements Notifier {
  readonly enabled = true;

  private readonly webhookUrl: string;
  private readonly secret: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FeishuFetch;
  private readonly now: () => number;

  constructor(options: FeishuNotifierOptions) {
    this.webhookUrl = options.webhookUrl;
    this.secret = options.secret;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FeishuFetch);
    this.now = options.now ?? (() => Date.now());
  }

  async notify(event: NotifyEvent): Promise<void> {
    // **先发卡片**：头部按严重度上色，群里一眼看得出轻重缓急。
    //
    // 被飞书**明确拒收**（回了一个非 0 的码）时，退回纯文本再发一次——
    // 兜底不是静默的：卡片被拒的原因会记进日志，纯文本那条也带着
    // 「trade-tool 告警」前缀，关键词校验照样能过。
    //
    // 只在「对方明确拒收」时兜底：网络错误意味着「不知道送没送到」，
    // 那时再发一次可能变成群里两条一样的消息。
    const rejected = await this.post({
      msg_type: 'interactive',
      card: formatFeishuCard(event),
    });
    if (rejected === null) return;

    console.error(`[notify] 飞书拒绝了卡片消息（${rejected.message}），改用纯文本重发`);
    const textRejected = await this.post({
      msg_type: 'text',
      content: { text: formatFeishuText(event) },
    });
    if (textRejected !== null) {
      throw new SyncError(textRejected.code, textRejected.message, textRejected.details);
    }
  }

  /**
   * 发一次请求。
   *
   * 成功返回 `null`；被飞书拒收（业务码非 0）返回拒收原因；网络/HTTP 层的失败
   * 直接抛错——那不是「对方拒收」，是「送不到」，不归兜底管。
   */
  private async post(
    payload: Record<string, unknown>,
  ): Promise<{ code: SyncErrorCode; message: string; details: Record<string, unknown> } | null> {
    const body: Record<string, unknown> = { ...payload };

    if (this.secret !== undefined && this.secret !== '') {
      // 官方要求 timestamp 是秒级、且距发送时刻不超过 1 小时。
      const timestamp = Math.floor(this.now() / 1000);
      body['timestamp'] = String(timestamp);
      body['sign'] = feishuSign(timestamp, this.secret);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    let response: FeishuHttpResponse;
    try {
      response = await this.fetchImpl(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SyncError('NETWORK_ERROR', `飞书 webhook 请求失败：${this.redact(message)}`, {
        webhookUrl: redactWebhook(this.webhookUrl),
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new SyncError('NETWORK_ERROR', `飞书 webhook 返回 HTTP ${String(response.status)}`, {
        status: response.status,
        webhookUrl: redactWebhook(this.webhookUrl),
      });
    }

    const raw = await response.text();
    let parsed: { code?: unknown; msg?: unknown };
    try {
      parsed = JSON.parse(raw) as { code?: unknown; msg?: unknown };
    } catch {
      throw new SyncError('INTERNAL_ERROR', '飞书 webhook 返回的不是 JSON', {
        body: raw.slice(0, 200),
      });
    }

    // 成功响应恒为 `{"code":0,"msg":"success"}`。**没有 code 就算失败**：
    // 把它当成成功，就正好犯了「看起来成功其实什么都没做」。
    if (parsed.code !== 0) {
      const code = typeof parsed.code === 'number' ? parsed.code : -1;
      const msg = typeof parsed.msg === 'string' ? parsed.msg : '（无消息）';
      return {
        code: feishuErrorCode(code),
        message: `飞书 webhook 拒绝：${String(code)} ${msg}`,
        details: { feishuCode: code, feishuMsg: msg },
      };
    }
    return null;
  }

  /**
   * 把文本里的 webhook 地址抹掉。
   *
   * 底层 HTTP 客户端的报错常把完整 URL 带出来（"request to https://…/hook/xxx failed"），
   * 而那个地址就是凭据——它不该出现在日志或错误详情里。
   */
  private redact(text: string): string {
    return text.split(this.webhookUrl).join(redactWebhook(this.webhookUrl));
  }
}

/**
 * webhook 地址本身**就是一个凭据**：拿到它就能往群里发消息（官方文档明确要求不要外泄）。
 * 因此进日志、进错误详情时一律把 token 抹掉。
 */
export function redactWebhook(webhookUrl: string): string {
  return webhookUrl.replace(/\/hook\/.*$/, '/hook/***');
}

/**
 * 什么都不做的通道。
 *
 * 用于「显式关闭」：`notify.enabled = false`。它**不是**失败时的兜底——
 * 关闭是配置决定的状态，启动时会打日志说明「通知已关闭」。
 */
export const DISABLED_NOTIFIER: Notifier = {
  enabled: false,
  notify: () => Promise.resolve(),
};

/** 构造通知通道需要的配置（`config.ts` 的 `notify` 段与它结构兼容）。 */
export interface NotifierSettings {
  enabled: boolean;
  /** webhook 地址所在的**环境变量名**。 */
  webhookEnv: string;
  /** 签名密钥所在的环境变量名。 */
  secretEnv: string;
}

/**
 * 通知通道的**生效设置**。
 *
 * 它是「配置 + 环境变量」与「控制面录入」两档汇合后的形状：不管设置从哪来，
 * 通道只认这一份，于是「哪一份在生效」的问题在上游（解析层）就回答完了，
 * 通道本身不需要知道自己读的是哪一档。
 */
export interface NotifySettings {
  enabled: boolean;
  webhookUrl: string;
  secret: string;
  /**
   * **要通知哪些内容**（交易对账的差异类型）。
   *
   * 空数组 = 一样都不推。判定发生在「把报告变成告警」那一步（executor），
   * 派发器只拿它来知道「用户改了勾选」——那是「换口味」，不是「问题解决了」。
   */
  kinds: readonly string[];
  repeatCooldownMs: number;
}

/**
 * 按「生效设置」造一个通道。
 *
 * **开着却没有地址就抛错**，不返回一个沉默的空通道：那种通道会让人以为
 * 「配置了但没触发」，而真实情况是「压根没地址」——「看起来成功其实什么都没做」
 * 正是这个仓库最忌讳的状态。
 */
export function createNotifier(settings: { webhookUrl: string; secret?: string }): Notifier {
  const webhookUrl = settings.webhookUrl.trim();
  if (webhookUrl === '') {
    throw new SyncError(
      'CONFIG_INVALID',
      '通知已启用但没有 webhook 地址。飞书地址只能从环境变量或控制面录入来，' +
        '请在仓库根 .env 里设置对应变量，或在控制面「设置」页录入。',
    );
  }
  const secret = settings.secret?.trim() ?? '';
  return new FeishuNotifier({ webhookUrl, ...(secret === '' ? {} : { secret }) });
}

/**
 * 按配置 + 环境变量构造通道。
 *
 * 三种结果：
 *   * `enabled = false` → 返回关闭通道（**不读环境变量**，也不报错）；
 *   * 开了但环境变量没设 / 是空串 → 抛 `CONFIG_INVALID` 并说清怎么配；
 *   * 开了且配齐 → 飞书通道。
 *
 * 为什么「开了但没配」要**启动失败**而不是「安静地不推」：那正是约定 9 要治的病。
 * 用户显式要了通知，服务却因为地址没配而一声不吭——事后没人知道告警从来没发出去过。
 */
export function createNotifierFromEnv(
  settings: NotifierSettings,
  env: NodeJS.ProcessEnv = process.env,
): Notifier {
  if (!settings.enabled) return DISABLED_NOTIFIER;

  const webhookUrl = (env[settings.webhookEnv] ?? '').trim();
  if (webhookUrl === '') {
    throw new SyncError(
      'CONFIG_INVALID',
      `notify.enabled = true，但环境变量 ${settings.webhookEnv} 未设置或为空——` +
        '飞书自定义机器人的 webhook 地址只能从环境变量来（它是凭据，不能写进配置文件）。' +
        '请在 .env 里填上该地址，或把配置里的 notify.enabled 改回 false 关闭通知。',
      { webhookEnv: settings.webhookEnv },
    );
  }

  const secret = (env[settings.secretEnv] ?? '').trim();
  return createNotifier({ webhookUrl, secret });
}

/** 一条待推送的告警。 */
export interface AlertItem {
  /**
   * 稳定的指纹：**同一件事在多轮之间必须给出同一个值**。
   *
   * 它是去重与冷却的依据，因此只能由「是什么事」决定，不能由「这轮长什么样」决定
   * （否则每轮都算新指纹，冷却形同虚设）。
   */
  fingerprint: string;
  /** 推送类型（止盈止损 / 报错 / 成交 / 提示）。进消息标题。 */
  category?: NotifyCategory;
  severity: NotifySeverity;
  title: string;
  lines?: readonly string[];
  /** 要突出的数值（盈亏金额之类）。卡片里加粗。 */
  highlights?: readonly string[];
  /** 问题消失时推送的标题（缺省用「已恢复：<原标题>」）。 */
  resolvedTitle?: string;
  /**
   * **事件型**告警：推过就算，不参与「已恢复」判定。
   *
   * 「止盈止损挂上了」「这一轮走完了」都是**一次性事件**，不是持续状态——
   * 下一轮它们不在了，不等于「问题消失了」，因此不能推「已恢复」。
   * 状态型告警（对账差异）不设这个字段。
   */
  oneShot?: boolean;
}

/** 一轮派发的结果。调用方据此打日志，让「推了什么 / 压了什么」可见。 */
export interface AlertDispatchResult {
  /** 实际推送出去的条数。 */
  sent: number;
  /** 因为「同一件事还没到冷却时间」而被压下的条数。 */
  suppressed: number;
  /** 推送失败（已回调 `onError`）的条数。 */
  failed: number;
  /** 推送出去的「已恢复」条数。 */
  recovered: number;
}

/**
 * 一轮要用的**通道与它的参数**。
 *
 * 三个东西必须一起取：通道（往哪儿推）、要通知哪些内容、冷却时间
 * （同一件事多久推一次）。它们都由**同一份生效设置**决定，因此打成一个对象，
 * 免得出现「地址是新的、阈值还是旧的」这种半更新状态。
 */
export interface AlertChannel {
  notifier: Notifier;
  /**
   * 这一轮**启用**的内容种类（交易对账的差异类型）。
   *
   * 它不参与「这条要不要发」的判定（那一步在把报告变成告警时就已经做完了），
   * 而是用来发现「用户改了勾选」：那是**换口味**，不是「问题解决了」——
   * 两种情况在派发器看来都表现为「上一轮的内容不见了」，不区分就会误报一条
   * 「已恢复」。
   */
  kinds: readonly string[];
  /** 同一条告警的重复推送冷却时间（毫秒）。`0` = 每轮都推。 */
  repeatCooldownMs: number;
}

/**
 * 通道提供者：每轮调用一次，返回这一轮要用的通道。
 *
 * 返回 `null` = 这一轮没有可用通道（例如设置还没配全），派发器会**什么都不做**，
 * 而不是拿一个空通道假装推送成功。
 *
 * 「每轮重新解析」是为了让控制面改完设置后不必重启进程就能生效。
 */
export type AlertChannelProvider = () => AlertChannel | null | Promise<AlertChannel | null>;

export interface AlertDispatcherOptions {
  /**
   * 通道。可以是固定的一份，也可以是**每轮重新解析**的函数
   * （生产用法：设置随时可能被控制面改掉）。
   */
  channel: AlertChannel | AlertChannelProvider;
  /** 注入的时钟，测试用。 */
  now?: () => number;
  /** 推送失败时的回调。缺省记日志——失败必须**看得见**，不能静默。 */
  onError?: (error: unknown, context: { item: AlertItem; phase: 'alert' | 'recovery' }) => void;
}

/**
 * 告警派发器：**去重 + 冷却 + 恢复通知**。
 *
 * 为什么必须有它：对账默认每 5 分钟跑一次（`executor.reconcileIntervalMs`）。
 * 一个一直存在的裸仓若每轮都推，群里三天就没人看了——而被无视的告警等于没接。
 * 三条规则：
 *
 *   1. 同一指纹在冷却期内**只推一次**；
 *   2. 严重度变了（注意 → 紧急）**立刻重推**：那是新情况；
 *   3. 告警消失时推一条「已恢复」——让人知道事情结束了，而不是一直悬着。
 *
 * 推送失败**不记账**：下一次轮次会重试。记了就等于把一条永远送不出去的告警变成
 * 「已经通知过了」。
 */
export class AlertDispatcher {
  private readonly channel: AlertChannel | AlertChannelProvider;
  private readonly now: () => number;
  private readonly onError: AlertDispatcherOptions['onError'];
  /** 指纹 → 上次推送的信息。 */
  private readonly sent = new Map<
    string,
    { severity: NotifySeverity; at: number; item: AlertItem }
  >();
  /** 上一轮启用的是哪些内容种类。用来区分「问题解决了」与「用户改了勾选」。 */
  private lastKinds: string | null = null;

  constructor(options: AlertDispatcherOptions) {
    this.channel = options.channel;
    this.now = options.now ?? (() => Date.now());
    this.onError = options.onError;
  }

  /** 这一轮要用的通道。固定的那份直接拿，函数则当场解析一次。 */
  private async resolve(): Promise<AlertChannel | null> {
    const channel = typeof this.channel === 'function' ? await this.channel() : this.channel;
    if (channel === null) return null;
    // 通道自己说「我关着」也算没有：关着的时候推什么都是空操作。
    if (!channel.notifier.enabled) return null;
    return channel;
  }

  /**
   * 派发一轮。
   *
   * @param build 由**这一轮生效的通道**构造告警条目。
   *
   * 为什么不是一个现成的条目数组：「要通知哪些内容」（`channel.kinds`）就写在通道
   * 里，而**过滤必须在构造条目时做**——没勾的差异不该进条目（否则它们会混进指纹、
   * 触发一条内容相同的新消息）。把构造交给通道参数，就只解析一次设置，
   * 过滤与发送看到的必然是同一份「哪一份在生效」。
   */
  async dispatch(
    build: (channel: AlertChannel) => readonly AlertItem[],
  ): Promise<AlertDispatchResult> {
    const result: AlertDispatchResult = { sent: 0, suppressed: 0, failed: 0, recovered: 0 };
    const channel = await this.resolve();

    // 通道关着（或这一轮解析不出通道）：**什么都不发，也不记账**。
    // 记账会让「通道关着的这段时间」看起来像「已经通知过了」，
    // 等通道重新打开时，同一件事还得再等一个冷却期才推得出去。
    if (channel === null) {
      this.sent.clear();
      this.lastKinds = null;
      return result;
    }

    // **用户改了勾选** ≠ **问题解决了**。
    // 两种情况在这里长得一样（上一轮的内容这一轮不见了），不区分就会在用户
    // 取消勾选时凭空推一条「已恢复」。所以：勾选一变，上一轮的记账整个作废
    // （不推「已恢复」），按新设置从头开始。
    const kindsKey = [...channel.kinds].sort().join(',');
    if (this.lastKinds !== null && this.lastKinds !== kindsKey) {
      this.sent.clear();
    }
    this.lastKinds = kindsKey;

    const items = build(channel);
    const notifier = channel.notifier;
    const now = this.now();
    const seen = new Set<string>();

    for (const item of items) {
      seen.add(item.fingerprint);

      const previous = this.sent.get(item.fingerprint);
      const sameSeverity = previous !== undefined && previous.severity === item.severity;
      if (sameSeverity && now - previous.at < channel.repeatCooldownMs) {
        result.suppressed += 1;
        continue;
      }

      try {
        await notifier.notify({
          title: item.title,
          severity: item.severity,
          ...(item.category === undefined ? {} : { category: item.category }),
          ...(item.lines === undefined ? {} : { lines: item.lines }),
          ...(item.highlights === undefined ? {} : { highlights: item.highlights }),
        });
        this.sent.set(item.fingerprint, { severity: item.severity, at: now, item });
        result.sent += 1;
      } catch (error) {
        this.reportError(error, { item, phase: 'alert' });
        result.failed += 1;
      }
    }

    // 已经不在这一轮里的指纹 = 问题消失了，推一条「已恢复」。
    for (const [fingerprint, previous] of [...this.sent.entries()]) {
      if (seen.has(fingerprint)) continue;
      this.sent.delete(fingerprint);
      // 事件型告警推过即忘：它不在了**不代表**问题恢复了（下一轮本来就没有它）。
      if (previous.item.oneShot === true) continue;
      const title = previous.item.resolvedTitle ?? `已恢复：${previous.item.title}`;
      try {
        await notifier.notify({ title, severity: 'info' });
        result.recovered += 1;
      } catch (error) {
        this.reportError(error, { item: previous.item, phase: 'recovery' });
        result.failed += 1;
      }
    }

    return result;
  }

  private reportError(
    error: unknown,
    context: { item: AlertItem; phase: 'alert' | 'recovery' },
  ): void {
    if (this.onError) {
      this.onError(error, context);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[notify] 推送${context.phase === 'recovery' ? '「已恢复」' : '告警'}失败：${message}`,
    );
  }
}
