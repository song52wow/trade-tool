/**
 * 行情上下文的**跨语言契约**（v1.0.0）。
 *
 * ## 它是什么
 *
 * Python 侧的 ``quant_data market-context`` 会吐一个 JSON：技术面（现算的指标）+
 * 情绪面（公开接口取的资金费率、基差、持仓量…）+ 市场流动性（24 小时成交额）。
 * 这个文件是**TS 侧读那个 JSON 的契约**：一份 zod schema + 一个纯映射函数。
 *
 * ## 为什么要有 schema
 *
 * 跨语言接缝上「形状对不上」是最难查的一类故障：Python 改了字段名，TS 侧
 * ``payload.technical.atr`` 就变成 ``undefined``，而这个 ``undefined`` 一路流到
 * 提示词里，模型收到「ATR: undefined」——**模型照样会给出一个看起来合理的结论**，
 * 于是错误完全静默。
 *
 * 因此这里用 zod 把整个载荷**整体校验一遍**：形状不对就抛
 * ``AGENT_CONTEXT_UNAVAILABLE``，并在消息里说清是哪个字段不对。
 *
 * ## 为什么映射函数在 core 而不是 data
 *
 * 「Python 载荷 → 分析上下文」是纯函数（不读时钟、不做 IO），归 core；
 * 「读 PG 的合约规格」「调 Python 子进程」是 IO，归 data。
 * 界线与 AGENTS.md §4 一致。
 */

import { z } from 'zod';

import { SyncError } from './market-sync.js';
import type { AnalystContext } from './agent-analyst.js';

/** 技术面载荷。字段与 Python 侧 `market_context.technical_snapshot` 的返回逐字对应。 */
export const technicalPayloadSchema = z.object({
  interval: z.string().min(1),
  bars: z.number().int().positive(),
  segmentBars: z.number().int().positive(),
  fromMs: z.number().int(),
  toMs: z.number().int(),
  lastClose: z.number().positive(),
  atr: z.number().positive(),
  atrPeriod: z.number().int().positive(),
  atrPercentOfPrice: z.number().min(0),
  ma: z.array(
    z.object({
      kind: z.enum(['sma', 'ema']),
      bars: z.number().int().positive(),
      value: z.number(),
    }),
  ),
  macd: z.object({ dif: z.number(), dea: z.number(), hist: z.number() }).nullable(),
  rsi: z.array(z.object({ period: z.number().int().positive(), value: z.number() })),
  boll: z.object({ upper: z.number(), mid: z.number(), lower: z.number() }).nullable(),
  kdj: z.object({ k: z.number(), d: z.number(), j: z.number() }).nullable(),
  obv: z.object({ value: z.number(), change: z.number() }).nullable(),
  recentReturns: z.array(z.number()),
  pricePercentile: z.number().min(0).max(1),
  objectiveBias: z.number().min(-1).max(1),
  objectiveNotes: z.array(z.string()),
});

/** 情绪面载荷。取不到的项是 `null`，**不是 0**。 */
export const sentimentPayloadSchema = z.object({
  fundingRate: z.number().nullable(),
  fundingRateAnnualized: z.number().nullable(),
  nextFundingTimeMs: z.number().int().nullable(),
  markPrice: z.number().nullable(),
  indexPrice: z.number().nullable(),
  basisBps: z.number().nullable(),
  openInterest: z.number().nullable(),
  openInterestChangePct: z.number().nullable(),
  longShortRatio: z.number().nullable(),
  takerBuySellRatio: z.number().nullable(),
  notes: z.array(z.string()),
  degraded: z.boolean(),
});

/** 市场流动性（24 小时统计）。 */
export const marketStatsPayloadSchema = z.object({
  quoteVolume24h: z.number().nullable(),
  trades24h: z.number().int().nullable(),
  priceChangePct24h: z.number().nullable(),
});

/** ``quant_data market-context`` 的完整载荷。 */
export const marketContextPayloadSchema = z.object({
  symbol: z.string().min(1),
  interval: z.string().min(1),
  technical: technicalPayloadSchema,
  sentiment: sentimentPayloadSchema,
  market: marketStatsPayloadSchema,
});

/** {@link marketContextPayloadSchema} 的类型。 */
export type MarketContextPayload = z.infer<typeof marketContextPayloadSchema>;

/**
 * 合约规格（来自库里的 `contract_spec` 快照，不是实时拉的）。
 *
 * 为什么用库里那份：止盈止损对齐价格要用的 tickSize 与下单用的其它规格必须来自
 * **同一份快照**（`packages/data/src/binance-private.ts` 的 `parseTickSize` 同理）。
 * Agent 另拉一份 exchangeInfo 会让「方案上的价格」与「实际挂单的规格」来自两次抓取，
 * 而两次之间交易所改规格是很现实的事。
 */
export interface ContractFacts {
  contractType: string;
  /** 上市时间。取不到时为 `null`。 */
  onboardDateMs: number | null;
  /** 最小价格变动。 */
  tickSize: number;
  /** 最小下单数量步长。 */
  stepSize: number;
  /** 最小下单数量。 */
  minQty: number;
  /** 最小名义金额（`MIN_NOTIONAL.notional`）。`0` = 该标的没有这条限制。 */
  minNotional: number;
}

/**
 * 校验 Python 侧吐回来的载荷。
 *
 * @throws SyncError 'AGENT_CONTEXT_UNAVAILABLE' 形状不对（并说清是哪个字段）。
 */
export function parseMarketContextPayload(raw: unknown): MarketContextPayload {
  const result = marketContextPayloadSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(根)'}：${i.message}`)
      .join('；');
    throw new SyncError(
      'AGENT_CONTEXT_UNAVAILABLE',
      `行情上下文的形状与契约不符：${issues}。` +
        '多半是 Python 侧改了字段——两侧必须同提交改（AGENTS.md 约定 2）',
      { issues: result.error.issues },
    );
  }
  return result.data;
}

/**
 * 把载荷 + 合约规格组装成喂给模型的上下文。**纯函数**。
 *
 * @param payload Python 侧的口径（已校验）。
 * @param facts 库里的合约规格。
 * @param baseline 当前生效的档位（作为参考基准）。
 */
export function buildAnalystContext(
  payload: MarketContextPayload,
  facts: ContractFacts,
  baseline: { stopAtrMult: number; takeProfitAtrMult: number },
): AnalystContext {
  const t = payload.technical;
  const s = payload.sentiment;
  const m = payload.market;

  const fundamentalNotes: string[] = [];
  if (s.fundingRateAnnualized !== null) {
    fundamentalNotes.push(
      `持有成本年化 ${(s.fundingRateAnnualized * 100).toFixed(2)}%` +
        `（${s.fundingRateAnnualized >= 0 ? '多头付给空头' : '空头付给多头'}）`,
    );
  }
  if (m.quoteVolume24h !== null) {
    fundamentalNotes.push(`24 小时成交额 ${m.quoteVolume24h}`);
  }
  if (facts.minNotional > 0) {
    fundamentalNotes.push(`最小下单金额 ${facts.minNotional}`);
  }

  return {
    symbol: payload.symbol,
    asOfMs: t.toMs,
    technical: {
      interval: t.interval,
      bars: t.bars,
      lastClose: t.lastClose,
      atr: t.atr,
      atrPeriod: t.atrPeriod,
      atrPercentOfPrice: t.atrPercentOfPrice,
      ma: t.ma,
      macd: t.macd,
      rsi: t.rsi,
      boll: t.boll,
      kdj: t.kdj,
      obv: t.obv,
      recentReturns: t.recentReturns,
      pricePercentile: t.pricePercentile,
      objectiveBias: t.objectiveBias,
      objectiveNotes: t.objectiveNotes,
    },
    sentiment: {
      fundingRate: s.fundingRate,
      fundingRateAnnualized: s.fundingRateAnnualized,
      nextFundingTimeMs: s.nextFundingTimeMs,
      markPrice: s.markPrice,
      indexPrice: s.indexPrice,
      basisBps: s.basisBps,
      openInterest: s.openInterest,
      openInterestChangePct: s.openInterestChangePct,
      longShortRatio: s.longShortRatio,
      takerBuySellRatio: s.takerBuySellRatio,
      notes: s.notes,
    },
    fundamental: {
      contractType: facts.contractType,
      onboardDateMs: facts.onboardDateMs,
      tickSize: facts.tickSize,
      stepSize: facts.stepSize,
      minQty: facts.minQty,
      quoteVolume24h: m.quoteVolume24h,
      trades24h: m.trades24h,
      priceChangePct24h: m.priceChangePct24h,
      carryCostAnnualized: s.fundingRateAnnualized,
      notes: fundamentalNotes,
    },
    baseline,
  };
}
