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
  aggregateAnalystReport,
  buildAnalystPrompt,
  buildTraderPrompt,
  createLogger,
  deriveExecutionPlan,
  parseAnalystReport,
  parseTraderProposal,
  SyncError,
  type AgentConfig,
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
} from '@trade-tool/data';

import { assertAutoExecutionDisabled } from './execute-guard.js';

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
  /** 模型客户端。 */
  llm: LlmClient;
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

/** 模型要看到的系统提示。两个 Agent 共用一句：**只输出 JSON**。 */
const SYSTEM_MESSAGE = {
  role: 'system' as const,
  content:
    '你只输出 JSON 对象。不要输出任何解释性文字，不要用 markdown 代码块标记。' +
    '不要输出你没被要求输出的字段。',
};

/**
 * 建编排器。
 *
 * @throws SyncError 'CONFIG_INVALID' 配置不合法（由 `configSchema` 保证，这里不再重复校验）；
 *         'CONFIG_INVALID' `execute.enabled = true`——自动执行路径本期未实现，
 *         开着它就等于「以为在下单、实际什么也没做」（见 `execute-guard.ts`）。
 */
export function createAgentService(deps: AgentDeps): AgentService {
  const { ctx, llm, config } = deps;
  // 闸门放在这里而不是各入口：守护进程与 CLI 共用这一个编排器，
  // 于是两条路径**同时**被拦住，不会出现「守护进程拦了、命令行没拦」的缝。
  assertAutoExecutionDisabled(config);
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
      let analystRaw: string;
      try {
        analystRaw = await llm.complete([SYSTEM_MESSAGE, { role: 'user', content: analystPrompt }]);
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

      let traderRaw: string;
      try {
        traderRaw = await llm.complete([SYSTEM_MESSAGE, { role: 'user', content: traderPrompt }]);
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
      } else {
        log.info(`${symbol} 本轮不做：${plan.rationale}`);
      }

      return { symbol, report: verdict, reportId, plan, planId, failure: null };
    },
  };
}
