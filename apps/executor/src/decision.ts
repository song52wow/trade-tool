/**
 * LLM 决策编排（v0.9.0）。
 *
 * ## 它做什么
 *
 * 在一笔买入成交被处理时，问模型「这笔仓的止盈止损档位该用多少」，
 * 然后把答案变成一份**可落库**的决策记录。
 *
 * ## 它不做什么
 *
 * - **不碰价格**。价格永远由 `deriveStagedPlan` 算（AGENTS.md 约定 4）。
 *   模型只选倍数，见 `packages/core/src/llm-decision.ts` 的文件头。
 * - **不决定挂不挂单**。挂单与否由 `service.ts` 按既有的十条规则决定，
 *   本模块只提供「用哪套档位」这一个答案。
 *
 * ## 降级语义（这一节是整个模块最要紧的部分）
 *
 * 模型失败时有三档处置，由 `fallbackToPolicy` 决定走哪条：
 *
 * | 情况                       | `fallbackToPolicy=true`（缺省） | `fallbackToPolicy=false`         |
 * | -------------------------- | ------------------------------- | -------------------------------- |
 * | 超时 / 报错 / 输出越界     | 降级到 `risk_policy` 的档位      | **拒绝下单**（仓位裸着）          |
 * | 留下的痕迹                 | `decision_source='config-fallback'` + 原因 | `decision_source='config-fallback'` + 原因 |
 *
 * 缺省为什么是「降级」而不是「拒绝」：仓位**已经成交**了。不挂止损单就是裸仓，
 * 价格反向运行时没有任何保护。「模型没说好」比「按配置挂上」危险得多。
 *
 * 但降级**必须可见**——这正是 `config-fallback` 这个独立来源值的意义。
 * 约定 9 忌讳的是「静默兜底」：兜底本身不犯规，**不留痕迹**才犯规。
 * 于是降级会同时走三条路：落库（`decision_fallback_reason`）、记日志、告警。
 *
 * ## 为什么不把模型放进核心链路
 *
 * 模型的响应时间不可控（1 秒到 30 秒都可能）。放在「成交 → 挂单」之间，
 * 裸仓窗口就等于模型响应时间。因此这里的做法是：
 *
 * - **超时硬上限**（`llm.timeoutMs`，缺省 8 秒）——超过就降级，不无限等。
 * - **模型只决定倍数**——即使它慢，档位的形状仍然是「ATR 的几倍」，
 *   不会产出「一个奇怪的绝对价格」这种没法用历史回测复现的东西。
 *
 * 裸仓窗口是这条路线**固有**的代价，本模块能做的是把它**封顶**并让超时可见。
 * 真正的消除要靠把决策提前到成交之前（预取），那是另一条路线。
 */

import {
  SyncError,
  buildDecisionPrompt,
  clampLlmDecision,
  createLogger,
  mergeDecisionIntoPolicy,
  parseLlmDecision,
  validateLlmDecision,
  type DecisionPromptContext,
  type DecisionSource,
  type LlmDecision,
  type LlmConfig,
} from '@trade-tool/core';
import type { LlmClient } from '@trade-tool/data';

const log = createLogger('executor');

/**
 * 决策器。executor 依赖的是这个接口而不是具体的客户端，
 * 测试可以整体替身（与 `OrderPlacer` / `AtrProvider` 同一套做法）。
 */
export interface RiskDecider {
  /**
   * 为一笔成交决定档位。
   *
   * **绝不抛错**：失败会降级成 `config-fallback` 并在结果里说清原因。
   * 理由是调用方（`service.ts`）在这条路径上还要继续挂单，抛错会让它
   * 误以为「整笔成交处理失败」而走 `failed` 分支——那会留下一个没有保护的仓位。
   */
  decide(input: DecideInput): Promise<DecideOutput>;
}

/** 决策所需的输入。全部是**已经取到的数**，不含任何 IO。 */
export interface DecideInput {
  symbol: string;
  /** 开仓方向：`BUY` 开多 / `SELL` 开空。 */
  side: string;
  entryPrice: number;
  atr: number;
  atrPeriod: number;
  atrInterval: string;
  /** 当前生效的档位，作为提示词里的基准。 */
  baseline: LlmDecision;
  /** 最近若干根 K 线的收益率（百分比数）。 */
  recentReturns: readonly number[];
}

/** 决策的结果。 */
export interface DecideOutput {
  /** 实际生效的六个参数。 */
  decision: LlmDecision;
  /** 这份档位是从哪来的。 */
  source: DecisionSource;
  /** 模型给的理由。降级时为空。 */
  rationale?: string;
  /** 降级原因。正常决策时为空。 */
  fallbackReason?: string;
  /** 模型原始返回的正文。降级时也可能非空（模型说错了但我们留了原文）。 */
  raw?: string;
  /**
   * **不要挂单**。
   *
   * 只有一种情况为真：配置了 `fallbackToPolicy = false` 且模型这一轮没能给出
   * 可用的档位。用户明确选择了「宁可不挂也不要按配置挂」——那就照做。
   *
   * 缺省（`fallbackToPolicy = true`）永远是假：降级到配置档位并挂单。
   */
  refuse: boolean;
}

/** 建决策器需要的依赖。 */
export interface CreateDeciderOptions {
  /** 模型客户端。没配 LLM 时可以不给。 */
  llm?: LlmClient;
  /** LLM 配置。 */
  config: LlmConfig;
}

function reasonOf(error: unknown): string {
  if (error instanceof SyncError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 把一份「按配置来的档位」包成决策结果。
 *
 * 单独一个函数是为了让**三条路径**（没开 LLM / 降级 / 正常）产出同一种形状，
 * 调用方因此不需要分支——它拿到的永远是 `{decision, source, ...}`。
 */
function policyOutcome(baseline: LlmDecision, source: DecisionSource): DecideOutput {
  return { decision: baseline, source, refuse: false };
}

/**
 * 建决策器。
 *
 * `llm` 没给（或配置 `enabled=false`）时，返回的决策器**永远**给 `source='config'`，
 * 行为与 v0.9.0 之前逐字一致。
 */
export function createRiskDecider(options: CreateDeciderOptions): RiskDecider {
  const { llm, config } = options;

  return {
    async decide(input: DecideInput): Promise<DecideOutput> {
      // 没开 LLM：直接用配置里的档位。这条路径**不产生任何 IO**。
      if (!config.enabled || llm === undefined) {
        return policyOutcome(input.baseline, 'config');
      }

      // ATR 占成交价的比例：判断「止损会不会太近」的关键尺度。
      // ATR 为 0 时除法没有意义——那本来就不会走到这里（ATR=0 会让止损落在入场价上，
      // 上游的 `risk-atr` 已经会拒绝）。
      const atrPercentOfPrice = input.entryPrice > 0 ? input.atr / input.entryPrice : undefined;

      const promptContext: DecisionPromptContext = {
        symbol: input.symbol,
        side: input.side,
        entryPrice: input.entryPrice,
        atr: input.atr,
        atrInterval: input.atrInterval,
        atrPeriod: input.atrPeriod,
        recentReturns: input.recentReturns,
        ...(atrPercentOfPrice !== undefined ? { atrPercentOfPrice } : {}),
        baseline: input.baseline,
      };
      const prompt = buildDecisionPrompt(promptContext);

      let raw: string;
      try {
        raw = await llm.complete([
          {
            role: 'system',
            content: '你只输出 JSON 对象。不要输出任何解释性文字，不要用 markdown 代码块标记。',
          },
          { role: 'user', content: prompt },
        ]);
      } catch (error) {
        // 调用失败（超时 / 网络 / 服务端错误）。
        return fallback(
          input,
          undefined,
          `模型调用失败：${reasonOf(error)}`,
          !config.fallbackToPolicy,
        );
      }

      // 解析失败：模型说了一句不是合法档位的话。
      let parsed: { decision: LlmDecision; rationale?: string };
      try {
        parsed = parseLlmDecision(raw);
      } catch (error) {
        return fallback(input, raw, `模型输出不合法：${reasonOf(error)}`, !config.fallbackToPolicy);
      }

      // 跨字段语义校验：分批形态下第一段必须比整段近。
      const valid = validateLlmDecision(parsed.decision, input.atrPeriod);
      if (!valid.ok) {
        return fallback(
          input,
          raw,
          `模型输出的档位自相矛盾：${valid.reason}`,
          !config.fallbackToPolicy,
        );
      }

      // 夹回区间。理论上 parse 时已经查过范围，这里是**第二道闸**——
      // 万一将来放宽了解析层，这里还挡得住。
      const decision = clampLlmDecision(parsed.decision);

      log.info(
        `${input.symbol} LLM 决策已采纳：止损 ${String(decision.stopAtrMult)}×ATR / ` +
          `止盈 ${String(decision.takeProfitAtrMult)}×ATR` +
          (parsed.rationale === undefined ? '' : `（${parsed.rationale}）`),
      );

      return {
        decision,
        source: 'llm',
        refuse: false,
        ...(parsed.rationale === undefined ? {} : { rationale: parsed.rationale }),
        raw,
      };
    },
  };
}

/**
 * 降级。
 *
 * `fallbackToPolicy=false` 时**不降级**：返回的 `source` 仍是 `'config-fallback'`，
 * 但 `decision` 用的是配置里的档位——由调用方（`service.ts`）决定是否拒绝下单。
 *
 * 这里刻意**不抛错**：抛错会让 `service.ts` 走 `failed` 分支，那条分支的行为是
 * 「记一笔 failed 行、不挂任何单」，正好是裸仓。降级与否是**策略选择**，
 * 必须在调用方那里显式表达，不能由一个异常隐式决定。
 */
function fallback(
  input: DecideInput,
  raw: string | undefined,
  reason: string,
  refuse: boolean,
): DecideOutput {
  log.warn(`${input.symbol} LLM 决策降级到配置档位：${reason}`);
  return {
    decision: input.baseline,
    source: 'config-fallback',
    fallbackReason: reason,
    refuse,
    ...(raw === undefined ? {} : { raw }),
  };
}

/**
 * 把决策合并进一份策略。
 *
 * 模型的倍数覆盖策略的倍数，而 `atrPeriod` / `atrInterval` **永远**来自策略——
 * 模型说了也不算（见 `llm-decision.ts` 的「三个刻意的边界」）。
 *
 * 这个函数是「模型输出」到「真正拿去算价的参数」之间的**唯一**转换点。
 *
 * ⚠️ **`agent-plan` 也走这条路**（v1.0.0）：Agent 方案的档位同样要覆盖配置档位，
 * 否则「人批准的那份方案」挂出去的止损价与方案页面上写的不一样——
 * 而方案是**人看过才批准**的，它比配置档位更该说话。
 *
 * `config` 与 `config-fallback` 不覆盖：它们本来就是策略本身。
 */
export function applyDecision<T extends LlmDecision>(policy: T, outcome: DecideOutput): T {
  if (outcome.source !== 'llm' && outcome.source !== 'agent-plan') return policy;
  return mergeDecisionIntoPolicy(policy, outcome.decision);
}
