/**
 * 分析师 Agent 与交易员 Agent 的编排（v1.0.0）。
 *
 * ## 一轮做什么
 *
 * ```
 * 行情上下文（Python 现算技术面 + 公开接口取情绪面 + 库里取合约规格）
 *        ↓
 * 分析师 Agent：三个面各打一个分 → 纯函数合成立场与信心
 *        ↓  （报告落库）
 * 交易员 Agent：把立场变成「进场方式 / 仓位大小 / 止损止盈」
 *        ↓  （方案落库）
 * ```
 *
 * ## 三条边界（与 core 里的契约一一对应）
 *
 * 1. **模型不输出价格与数量**：它只给分数、比例与 ATR 倍数。价格与数量由
 *    `deriveExecutionPlan` 算；`apps/executor` 挂单走 `deriveStagedPlan`，
 *    两者算式与 tick 对齐方向**逐字相同**，因此方案上的价与真挂出去的那张单
 *    不会差一个 tick（AGENTS.md 约定 4）。
 * 2. **总立场由程序合成**：模型给三个面的分数，`aggregateAnalystReport` 按权重算
 *    stance 与 confidence。报告里写着看多、库里记的是看空——不可能发生。
 * 3. **失败必须留痕**：模型失败、输出不合法、方案算不出来——都落一条
 *    `action = 'failed'` 的方案并写明原因。**不静默跳过**（AGENTS.md 约定 9）。
 *
 * ## 为什么「分析师失败」也要记一条方案
 *
 * 因为页面上要能回答「这个标的今天分析过没有」。只记成功的那些，
 * 就会看到「今天没有它的报告」——而那句话有两种完全不同的含义：
 * 「分析过但没结论」与「压根没分析」。前者必须能看见。
 */

import {
  AGENT_SYSTEM_MESSAGE,
  aggregateAnalystReport,
  autoExecutableProblem,
  buildAnalystPrompt,
  buildTraderPrompt,
  createLogger,
  deriveExecutionPlan,
  parseAnalystReport,
  parseTraderProposal,
  SyncError,
  type AgentConfig,
  type AgentPromptMessage,
  type AnalystContext,
  type AnalystVerdict,
  type ExecutionLimits,
  type ExecutionPlan,
  type Logger,
} from '@trade-tool/core';
import {
  loadAgentContext,
  recordAnalystReport,
  recordTradingPlan,
  type LlmClient,
  type MarketContext,
  type PromptMirrorInput,
} from '@trade-tool/data';

/** 一份行情上下文 + 落库留痕要的原始载荷。 */
export interface AgentContextBundle {
  context: AnalystContext;
  payload: unknown;
  degraded: boolean;
}

/** 账户权益及其来源。 */
export interface EquityReading {
  equity: number;
  source: 'exchange' | 'config';
}

/** 编排器的依赖。全部可替身，测试用。 */
export interface AgentDeps {
  /** 行情上下文（PG 连接 + Python 桥接的基址）。 */
  ctx: MarketContext;
  /**
   * 取模型客户端。**每轮调一次**。
   *
   * 为什么是「取」而不是「给」：控制面可以改模型接入（地址 / 模型名 / 密钥 /
   * 超时），改完不必重启进程——下一轮就用新的那一份（与通知设置同一套做法：
   * 「每轮重新解析，改完不必重启」）。
   */
  resolveLlm: () => Promise<LlmClient>;
  /** Agent 配置段。 */
  config: AgentConfig;
  /** 读账户权益。读不到就抛错——**不返回 0**（0 会被当成「账户没钱」）。 */
  readEquity: () => Promise<EquityReading>;
  /** 取行情上下文。测试可整体替身。 */
  loadContext?: (
    ctx: MarketContext,
    options: { symbol: string; interval: string; bars: number },
  ) => Promise<AgentContextBundle>;
  /** 时钟（epoch ms）。测试可注入固定值。 */
  now?: () => number;
  /**
   * 把提示词镜像到飞书群（v1.0.0）。
   *
   * 缺省 = 不镜像。给了就**在调模型之前**把那一组消息发出去——
   * 模型超时或崩了，群里那条提示词仍然在，而那正是排障最需要的东西。
   *
   * ⚠️ **它必须不抛错**：镜像坏了不该让分析停下来。实现见 `prompt-mirror.ts`。
   */
  mirrorPrompt?: (input: PromptMirrorInput) => Promise<void>;
  /** 日志出口。默认走 core 的 logger（写 stderr，stdout 留给命令结果）。 */
  log?: Logger;
}

/** 一轮的结果。 */
export interface AgentRoundResult {
  symbol: string;
  /** 分析师的结论。分析师这一步失败时为 `null`。 */
  report: AnalystVerdict | null;
  reportId: string | null;
  /** 执行方案。失败时为 `null`（失败的原因在 `failure` 里）。 */
  plan: ExecutionPlan | null;
  planId: string | null;
  /** 这一轮失败的原因。成功时为 `null`。 */
  failure: string | null;
}

/** 编排器。 */
export interface AgentService {
  /** 跑一轮：分析 + 出方案 + 落库。 */
  analyzeSymbol(symbol: string): Promise<AgentRoundResult>;
}

function reasonOf(error: unknown): string {
  if (error instanceof SyncError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 一轮要发给模型的那一组消息。
 *
 * **同一个数组既用来调模型、也用来镜像**——这样群里那条与模型看见的**逐字相同**。
 * 重新拼一份的话，两边一旦有出入，这条排障线索就废了。
 */
function promptMessages(userContent: string): AgentPromptMessage[] {
  return [AGENT_SYSTEM_MESSAGE, { role: 'user', content: userContent }];
}

/**
 * 建编排器。
 *
 * @throws SyncError 'CONFIG_INVALID' 配置不合法（由 `configSchema` 保证，这里不再重复校验）。
 */
export function createAgentService(deps: AgentDeps): AgentService {
  const { ctx, config } = deps;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? createLogger('agent');
  const loadContext = deps.loadContext ?? loadAgentContext;
  const exchange = ctx.exchange;

  const limits: ExecutionLimits = {
    maxRiskFraction: config.risk.maxRiskFraction,
    maxNotional: config.risk.maxNotional,
    minRiskReward: config.risk.minRiskReward,
    neutralRiskFactor: config.risk.neutralRiskFactor,
  };

  /**
   * 记一条「这一轮没出方案」。
   *
   * `stance` 记成 `neutral`、`confidence` 记成 0：那不是「看空」也不是「看多」，
   * 而是**没有结论**。数据库要求这两列非空，而「没有结论」必须也能落库——
   * 否则失败的那几轮在页面上就是空白。
   */
  async function recordFailure(
    symbol: string,
    reason: string,
    reportId: string | null,
    asOfMs: number,
    raw: string | null,
  ): Promise<AgentRoundResult> {
    const planId = await recordTradingPlan(ctx.pool, {
      exchange,
      symbol,
      reportId,
      asOfMs,
      createdAtMs: now(),
      action: 'failed',
      side: null,
      entryType: null,
      entryPrice: null,
      stopPrice: null,
      takeProfitPrice: null,
      quantity: null,
      notional: null,
      riskAmount: null,
      equity: null,
      equitySource: null,
      riskFraction: null,
      atr: null,
      stopAtrMult: null,
      takeProfitAtrMult: null,
      riskReward: null,
      stance: 'neutral',
      confidence: 0,
      rationale: reason,
      adjustments: [],
      failureReason: reason,
      raw,
    });
    log.warn(`${symbol} 本轮未出方案：${reason}`);
    return { symbol, report: null, reportId, plan: null, planId, failure: reason };
  }

  return {
    async analyzeSymbol(symbol: string): Promise<AgentRoundResult> {
      // ------------------------------------------------------------ 行情上下文
      let bundle: AgentContextBundle;
      try {
        bundle = await loadContext(ctx, {
          symbol,
          interval: config.interval,
          bars: config.bars,
        });
      } catch (error) {
        // 上下文取不到（库里没 K 线、没合约规格、形状对不上）——这与分析无关，
        // 但同样要留痕：否则页面上看不到「这个标的今天根本没被分析过」。
        return recordFailure(symbol, `行情上下文不可用：${reasonOf(error)}`, null, now(), null);
      }
      const asOfMs = bundle.context.asOfMs;

      // ---------------------------------------------------------------- 分析师
      const analystPrompt = buildAnalystPrompt(bundle.context);
      const analystMessages = promptMessages(analystPrompt);
      // 镜像**在调模型之前**：模型超时或崩了，群里那条提示词仍然在。
      await deps.mirrorPrompt?.({
        symbol,
        source: 'agent-analyst',
        messages: analystMessages,
      });
      let analystRaw: string;
      try {
        const llm = await deps.resolveLlm();
        analystRaw = await llm.complete(analystMessages);
      } catch (error) {
        const reason = `分析师模型调用失败：${reasonOf(error)}`;
        if (!config.llm.fallbackToTrade) {
          await recordFailure(symbol, reason, null, asOfMs, null);
          throw error;
        }
        return recordFailure(symbol, reason, null, asOfMs, null);
      }

      let report;
      try {
        report = parseAnalystReport(analystRaw);
      } catch (error) {
        const reason = `分析师输出不合法：${reasonOf(error)}`;
        if (!config.llm.fallbackToTrade) {
          await recordFailure(symbol, reason, null, asOfMs, analystRaw);
          throw error;
        }
        return recordFailure(symbol, reason, null, asOfMs, analystRaw);
      }

      // **立场由程序合成**，不是模型给的。
      const verdict = aggregateAnalystReport(report, config.weights, {
        neutralBand: config.neutralBand,
      });

      const reportId = await recordAnalystReport(ctx.pool, {
        exchange,
        symbol,
        interval: config.interval,
        asOfMs,
        createdAtMs: now(),
        verdict,
        atr: bundle.context.technical.atr,
        lastClose: bundle.context.technical.lastClose,
        context: bundle.payload,
        raw: analystRaw,
        degraded: bundle.degraded,
      });

      // ---------------------------------------------------------------- 交易员
      let equity: EquityReading;
      try {
        equity = await deps.readEquity();
      } catch (error) {
        return recordFailure(
          symbol,
          `读不到账户权益，算不出仓位：${reasonOf(error)}`,
          reportId,
          asOfMs,
          null,
        );
      }

      const t = bundle.context.technical;
      const f = bundle.context.fundamental;
      const traderPrompt = buildTraderPrompt({
        symbol,
        verdict,
        equity: equity.equity,
        lastPrice: t.lastClose,
        atr: t.atr,
        atrPeriod: t.atrPeriod,
        tickSize: f.tickSize,
        stepSize: f.stepSize,
        minQty: f.minQty,
        limits,
        baseline: bundle.context.baseline,
      });

      const traderMessages = promptMessages(traderPrompt);
      // 镜像**在调模型之前**（理由同上）。
      await deps.mirrorPrompt?.({
        symbol,
        source: 'agent-trader',
        messages: traderMessages,
      });
      let traderRaw: string;
      try {
        const llm = await deps.resolveLlm();
        traderRaw = await llm.complete(traderMessages);
      } catch (error) {
        return recordFailure(
          symbol,
          `交易员模型调用失败：${reasonOf(error)}`,
          reportId,
          asOfMs,
          null,
        );
      }

      let proposal;
      try {
        proposal = parseTraderProposal(traderRaw);
      } catch (error) {
        return recordFailure(
          symbol,
          `交易员输出不合法：${reasonOf(error)}`,
          reportId,
          asOfMs,
          traderRaw,
        );
      }

      let plan: ExecutionPlan;
      try {
        plan = deriveExecutionPlan({
          symbol,
          verdict,
          proposal,
          equity: equity.equity,
          lastPrice: t.lastClose,
          atr: t.atr,
          atrPeriod: t.atrPeriod,
          tickSize: f.tickSize,
          stepSize: f.stepSize,
          minQty: f.minQty,
          limits,
        });
      } catch (error) {
        return recordFailure(
          symbol,
          `算不出可执行的方案：${reasonOf(error)}`,
          reportId,
          asOfMs,
          traderRaw,
        );
      }

      // ------------------------------------------------------------------ 落库
      //
      // 「这份方案能不能自动执行」先算出来（判据只有一份，见下），
      // 落库时的初始状态与后面的日志都用它。
      const executableProblem = autoExecutableProblem(
        plan.action === 'enter' ? plan.entryType : null,
        plan.action,
      );
      const planId = await recordTradingPlan(ctx.pool, {
        exchange,
        symbol,
        reportId,
        asOfMs,
        createdAtMs: now(),
        action: plan.action,
        side: plan.action === 'enter' ? plan.side : null,
        entryType: plan.action === 'enter' ? plan.entryType : null,
        entryPrice: plan.action === 'enter' ? plan.entryPrice : null,
        stopPrice: plan.action === 'enter' ? plan.stopPrice : null,
        takeProfitPrice: plan.action === 'enter' ? plan.takeProfitPrice : null,
        quantity: plan.action === 'enter' ? plan.quantity : null,
        notional: plan.action === 'enter' ? plan.notional : null,
        riskAmount: plan.action === 'enter' ? plan.riskAmount : null,
        equity: equity.equity,
        equitySource: equity.source,
        riskFraction: plan.action === 'enter' ? plan.riskFraction : null,
        atr: plan.atr,
        stopAtrMult: plan.action === 'enter' ? plan.stopAtrMult : null,
        takeProfitAtrMult: plan.action === 'enter' ? plan.takeProfitAtrMult : null,
        riskReward: plan.action === 'enter' ? plan.riskReward : null,
        stance: verdict.stance,
        confidence: verdict.confidence,
        rationale: plan.rationale,
        adjustments: plan.action === 'enter' ? plan.adjustments : [],
        failureReason: null,
        raw: traderRaw,
        // 自动执行开关打开时，**可执行的**方案直接进 `approved`，由 executor 消费。
        //
        // 为什么不是「停在建议、等人在控制面点批准」：那等于两处开关——
        // 用户已经明确打开了「允许自动下单」，还要再点一次批准，
        // 于是「开关打开了却没下单」看起来像是坏了。
        //
        // ⚠️ **「可执行」用 `autoExecutableProblem` 判，不在这里自己写一遍**：
        // 判据只有一份（`packages/core/src/agent-plan.ts`），控制面的人工批准、
        // 命令行的人工批准、executor 的兜底检查**四处共用**。
        //
        // 不可执行的（「这一轮不做」「出不了方案」「限价进场」）一律落 `advisory`：
        // 批准了它，执行器每轮都会把它捞出来又跳过，而页面上显示「已批准、
        // 等 executor 消费」，看上去像是有一单在等着下。这正是「以为会做、
        // 实际什么也没做」（约定 9）。
        //
        // 关着的时候一律 `advisory`：方案只是建议，控制面与 CLI 能看，
        // 真正下单要显式打开开关。
        status: config.execute.enabled && executableProblem === null ? 'approved' : 'advisory',
      });

      if (plan.action === 'enter') {
        log.info(
          `${symbol} 方案：${plan.side} ${plan.entryType} @ ${plan.entryPrice} ` +
            `数量 ${plan.quantity}（名义 ${plan.notional.toFixed(2)}）` +
            `止损 ${plan.stopPrice} 止盈 ${plan.takeProfitPrice} ` +
            `R:R=${plan.riskReward.toFixed(2)} 风险 ${plan.riskAmount.toFixed(2)}`,
        );
        for (const adjustment of plan.adjustments) {
          log.warn(`${symbol} 方案已调整：${adjustment}`);
        }
        // 不可自动执行的方案**要让人知道**：页面显示「已批准、等 executor 消费」的话，
        // 看上去像是有一单在等着下，而它永远不会下——那正是「以为会做、实际什么也没做」。
        //
        // 原因用 `autoExecutableProblem` 给（判据只有一份），这里只补「怎么办」。
        if (executableProblem !== null) {
          log.warn(
            `${symbol} 方案**未自动批准**：${executableProblem}。` +
              '方案已落库（status=advisory），可在控制面查看。',
          );
        }
      } else {
        log.info(`${symbol} 本轮不做：${plan.rationale}`);
      }

      return { symbol, report: verdict, reportId, plan, planId, failure: null };
    },
  };
}
