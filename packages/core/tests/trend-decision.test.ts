/**
 * 趋势档位决策的纯函数测试（不连 PG、不出网）。
 *
 * 锁的是三件事：
 *   1. **口径不能混** —— 提示词里只出现「算价基准 ATR」这一个带单位的波动尺度；
 *      趋势周期的 ATR **不许以数值出现**（两者差着一到两个数量级，混用会让止损
 *      近到一根针就能被扫掉）；
 *   2. **相对量的符号不能错** —— 均线在成交价上方还是下方，由程序算好；
 *      模型自己做减法会把「压制」读成「支撑」；
 *   3. **缺失不许被 0 冒充** —— 情绪面取不到的项是 `null`，提示词里要写明缺了。
 */

import {
  buildTrendDecisionPrompt,
  toTrendDecisionContext,
  type AnalystContext,
} from '@trade-tool/core';
import { describe, expect, it } from 'vitest';

/**
 * 趋势周期的 ATR。**故意取一个绝对不会撞上别的数的值**（987.65），
 * 这样「它有没有漏进提示词」就能被一条断言钉死。
 */
const TREND_ATR = 987.65;

/** 一份行情上下文。数值刻意选得**互不相同**，这样断言里不会互相蒙混过关。 */
const analyst: AnalystContext = {
  symbol: 'BTCUSDT',
  asOfMs: 1_700_000_000_000,
  technical: {
    interval: '1h',
    bars: 300,
    lastClose: 104,
    atr: TREND_ATR,
    atrPeriod: 14,
    atrPercentOfPrice: 0.125,
    ma: [
      { kind: 'sma', bars: 20, value: 102 },
      { kind: 'ema', bars: 60, value: 98 },
    ],
    macd: { dif: 1.5, dea: 1.1, hist: 0.8 },
    rsi: [{ period: 14, value: 58 }],
    boll: { upper: 110, mid: 104, lower: 98 },
    kdj: { k: 70, d: 66, j: 78 },
    obv: { value: 123_456, change: 789 },
    recentReturns: [0.5, -0.2, 1.1],
    pricePercentile: 0.63,
    objectiveBias: 0.43,
    objectiveNotes: ['收盘价 > MA20（+1）', 'MA20 > MA60（+1）'],
  },
  sentiment: {
    fundingRate: 0.0001,
    fundingRateAnnualized: 0.123,
    nextFundingTimeMs: 1_700_003_600_000,
    markPrice: 104,
    indexPrice: 104,
    basisBps: 8.5,
    openInterest: 1_000,
    openInterestChangePct: 2.1,
    longShortRatio: 1.85,
    takerBuySellRatio: 1.12,
    notes: [],
  },
  fundamental: {
    contractType: 'PERPETUAL',
    onboardDateMs: null,
    tickSize: 0.1,
    stepSize: 0.001,
    minQty: 0.001,
    quoteVolume24h: 1_000_000,
    trades24h: 100_000,
    priceChangePct24h: 1.2,
    carryCostAnnualized: 0.123,
    notes: [],
  },
  baseline: { stopAtrMult: 2, takeProfitAtrMult: 3 },
};

/** 算价基准 ATR。与趋势周期的 ATR 刻意不同。 */
const BASE_ATR = 1.37;

function context() {
  return toTrendDecisionContext({
    analyst,
    side: 'BUY',
    entryPrice: 100,
    atr: BASE_ATR,
    atrInterval: '1m',
    atrPeriod: 14,
  });
}

describe('toTrendDecisionContext', () => {
  it('均线换算成「相对成交价」的百分比，符号不会错', () => {
    const ctx = context();
    // MA20 = 102，成交价 = 100 → 高 2%。
    expect(ctx.ma[0]?.kind).toBe('sma');
    expect(ctx.ma[0]?.percentFromEntry).toBeCloseTo(2, 10);
    // MA60 = 98 → 低 2%。
    expect(ctx.ma[1]?.kind).toBe('ema');
    expect(ctx.ma[1]?.percentFromEntry).toBeCloseTo(-2, 10);
  });

  it('ATR 占成交价的比例按**算价基准**算，不是按趋势周期的 ATR', () => {
    const ctx = context();
    // 1.37 / 100 = 1.37%。若错用趋势周期的 ATR（987.65），这里会变成 987%。
    expect(ctx.atrPercentOfPrice).toBeCloseTo(0.0137, 10);
  });

  it('布林带换算成相对成交价的百分比', () => {
    const ctx = context();
    // 上轨 110 → +10%；下轨 98 → -2%。
    expect(ctx.boll?.upperPercent).toBeCloseTo(10, 10);
    expect(ctx.boll?.lowerPercent).toBeCloseTo(-2, 10);
  });

  it('最新收盘价相对成交价的百分比', () => {
    // 104 vs 100 → +4%。
    expect(context().priceVsEntryPercent).toBeCloseTo(4, 10);
  });

  it('情绪面取不到的项保持 null（不用 0 冒充）', () => {
    const degraded: AnalystContext = {
      ...analyst,
      sentiment: { ...analyst.sentiment, fundingRateAnnualized: null, basisBps: null },
    };
    const ctx = toTrendDecisionContext({
      analyst: degraded,
      side: 'BUY',
      entryPrice: 100,
      atr: BASE_ATR,
      atrInterval: '1m',
      atrPeriod: 14,
    });
    expect(ctx.sentiment.fundingRateAnnualized).toBeNull();
    expect(ctx.sentiment.basisBps).toBeNull();
    // 取到的那些不受影响。
    expect(ctx.sentiment.openInterestChangePct).toBe(2.1);
  });
});

describe('buildTrendDecisionPrompt', () => {
  it('只给出**算价基准** ATR，趋势周期的 ATR 不许以数值出现', () => {
    const prompt = buildTrendDecisionPrompt(context());
    // 算价基准 ATR（1.37）必须在——模型要拿它换算距离。
    expect(prompt).toContain('1.37');
    // 趋势周期的 ATR **不许**出现：它与算价基准差着三个数量级，
    // 模型拿它当基准，止损就会远到离谱。
    expect(prompt).not.toContain(String(TREND_ATR));
  });

  it('硬性要求写明「倍数以算价基准 ATR 为单位」', () => {
    const prompt = buildTrendDecisionPrompt(context());
    expect(prompt).toContain('以【算价基准 ATR】为度量单位');
  });

  it('配置基准档位同时给出倍数与「占成交价的百分比」', () => {
    const prompt = buildTrendDecisionPrompt(context());
    // 止损 2 倍 × 1.37% = 成交价的 2.74%。
    expect(prompt).toContain('止损 2 倍');
    expect(prompt).toContain('2.740%');
  });

  it('客观倾向分与逐条依据都在提示词里', () => {
    const prompt = buildTrendDecisionPrompt(context());
    expect(prompt).toContain('客观倾向分：0.43');
    expect(prompt).toContain('收盘价 > MA20（+1）');
  });

  it('情绪面全部缺失时要写明，而不是当成 0', () => {
    const empty: AnalystContext = {
      ...analyst,
      sentiment: {
        ...analyst.sentiment,
        fundingRateAnnualized: null,
        basisBps: null,
        openInterestChangePct: null,
        longShortRatio: null,
        takerBuySellRatio: null,
      },
    };
    const prompt = buildTrendDecisionPrompt(
      toTrendDecisionContext({
        analyst: empty,
        side: 'SELL',
        entryPrice: 100,
        atr: BASE_ATR,
        atrInterval: '1m',
        atrPeriod: 14,
      }),
    );
    expect(prompt).toContain('都没取到');
    expect(prompt).toContain('做空');
  });

  it('是纯函数：同样的输入永远给出同样的提示词', () => {
    expect(buildTrendDecisionPrompt(context())).toBe(buildTrendDecisionPrompt(context()));
  });
});
