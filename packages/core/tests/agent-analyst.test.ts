/**
 * 分析师 Agent 的纯函数测试（不连 PG、不出网、不调模型）。
 *
 * 锁的是三件事：
 *   * **立场由程序合成**：三个面的分数 → 立场与信心，判据只有一份；
 *   * **一致性会折进信心**：三个面互相抵消时，结论不该是高信心；
 *   * **解析不许宽松**：模型说了句不是 JSON 的话，必须报错而不是尽力修复。
 */

import {
  aggregateAnalystReport,
  buildAnalystPrompt,
  parseAnalystReport,
  SyncError,
  type AnalystReport,
  type AnalystWeights,
} from '@trade-tool/core';
import { describe, expect, it } from 'vitest';

const WEIGHTS: AnalystWeights = { technical: 1, sentiment: 1, fundamental: 0.5 };

function report(overrides: Partial<AnalystReport> = {}): AnalystReport {
  return {
    technical: { score: 0.8, notes: ['收盘价在 MA20 上方'] },
    sentiment: { score: 0.4, notes: ['资金费率为正，多头付费'] },
    fundamental: { score: 0, notes: ['流动性正常'] },
    confidence: 0.9,
    stopAtrMult: 2,
    takeProfitAtrMult: 3,
    rationale: '趋势向上，回调买。',
    ...overrides,
  };
}

describe('aggregateAnalystReport', () => {
  it('三个面同向看多 → 看多，信心等于自评信心（面完全一致）', () => {
    const verdict = aggregateAnalystReport(
      report({
        technical: { score: 0.8, notes: [] },
        sentiment: { score: 0.8, notes: [] },
        fundamental: { score: 0.8, notes: [] },
      }),
      WEIGHTS,
    );
    expect(verdict.stance).toBe('bullish');
    expect(verdict.bias).toBeCloseTo(0.8, 6);
    expect(verdict.agreement).toBeCloseTo(1, 6);
    expect(verdict.confidence).toBeCloseTo(0.9, 6);
  });

  it('权重按配置归一：基本面权重 0.5，综合分只算一半', () => {
    // 技术面 +1、情绪面 −1、基本面 0：加权 (1×1 + 1×(−1) + 0.5×0) / 2.5 = 0
    const verdict = aggregateAnalystReport(
      report({
        technical: { score: 1, notes: [] },
        sentiment: { score: -1, notes: [] },
        fundamental: { score: 0, notes: [] },
      }),
      WEIGHTS,
    );
    expect(verdict.bias).toBeCloseTo(0, 6);
    expect(verdict.stance).toBe('neutral');
  });

  it('面与面互相抵消时，信心被一致性折下去', () => {
    // 技术面 +1、情绪面 −1、基本面 0（权重 0.5）：
    //   bias = (1×1 + 1×(−1) + 0.5×0) / 2.5 = 0
    //   dispersion = (1×1 + 1×1 + 0.5×0) / 2.5 = 0.8 → agreement = 0.2
    //   confidence = 自评 0.9 × 0.2 = 0.18
    //
    // 注意一致性**不是** 0：基本面给 0 分，与「两个面互相抵消后的落点 0」是一致的，
    // 它给了一票「站在中间」的同意。
    const verdict = aggregateAnalystReport(
      report({
        technical: { score: 1, notes: [] },
        sentiment: { score: -1, notes: [] },
        fundamental: { score: 0, notes: [] },
      }),
      WEIGHTS,
    );
    expect(verdict.stance).toBe('neutral');
    expect(verdict.bias).toBeCloseTo(0, 6);
    expect(verdict.agreement).toBeCloseTo(0.2, 6);
    expect(verdict.confidence).toBeCloseTo(0.18, 6);
  });

  it('三个面里两个对立时，一致性更低', () => {
    // 技术面 +1、情绪面 −1、基本面 +1（权重 0.5）：
    //   bias = (1 − 1 + 0.5) / 2.5 = 0.2
    //   dispersion = (0.8 + 1.2 + 0.4) / 2.5 = 0.96 → agreement = 0.04
    //
    // 对比上一个用例（agreement = 0.2）：那里的基本面是 0，与抵消后的落点一致；
    // 这里基本面跳到 +1，于是三个面互相打架，一致性掉到 0.04。
    const verdict = aggregateAnalystReport(
      report({
        technical: { score: 1, notes: [] },
        sentiment: { score: -1, notes: [] },
        fundamental: { score: 1, notes: [] },
      }),
      WEIGHTS,
    );
    expect(verdict.agreement).toBeCloseTo(0.04, 6);
  });

  it('中性带内的综合分算中性，不硬给方向', () => {
    const verdict = aggregateAnalystReport(
      report({
        technical: { score: 0.15, notes: [] },
        sentiment: { score: 0.15, notes: [] },
        fundamental: { score: 0.15, notes: [] },
      }),
      WEIGHTS,
    );
    expect(verdict.stance).toBe('neutral');
    expect(verdict.bias).toBeCloseTo(0.15, 6);
  });

  it('权重为 0 或负数直接报错：权重为 0 等于「关掉这个面」，不能悄悄当没配', () => {
    expect(() =>
      aggregateAnalystReport(report(), { technical: 0, sentiment: 1, fundamental: 1 }),
    ).toThrow(SyncError);
    expect(() =>
      aggregateAnalystReport(report(), { technical: -1, sentiment: 1, fundamental: 1 }),
    ).toThrow(SyncError);
  });

  it('中性带越界报错', () => {
    expect(() => aggregateAnalystReport(report(), WEIGHTS, { neutralBand: 1.5 })).toThrow(
      SyncError,
    );
    expect(() => aggregateAnalystReport(report(), WEIGHTS, { neutralBand: 1 })).toThrow(SyncError);
  });
});

describe('parseAnalystReport', () => {
  it('接受纯 JSON 与带围栏的 JSON', () => {
    const body = {
      technical: { score: 0.5, notes: ['a'] },
      sentiment: { score: 0.1, notes: [] },
      fundamental: { score: 0, notes: ['b'] },
      confidence: 0.7,
      stopAtrMult: 2,
      takeProfitAtrMult: 3,
      rationale: '理由',
    };
    expect(parseAnalystReport(JSON.stringify(body)).technical.score).toBe(0.5);
    const fenced = '```json\n' + JSON.stringify(body) + '\n```';
    expect(parseAnalystReport(fenced).rationale).toBe('理由');
  });

  it('分数越界报错，不静默截断', () => {
    const body = {
      technical: { score: 1.5, notes: [] },
      sentiment: { score: 0, notes: [] },
      fundamental: { score: 0, notes: [] },
      confidence: 0.7,
      stopAtrMult: 2,
      takeProfitAtrMult: 3,
      rationale: '理由',
    };
    expect(() => parseAnalystReport(JSON.stringify(body))).toThrow(SyncError);
  });

  it('不是 JSON / 空内容 / 不是对象都报错', () => {
    expect(() => parseAnalystReport('')).toThrow(SyncError);
    expect(() => parseAnalystReport('我觉得应该看多')).toThrow(SyncError);
    expect(() => parseAnalystReport('[1,2,3]')).toThrow(SyncError);
  });

  it('缺字段报错', () => {
    expect(() => parseAnalystReport('{"technical":{"score":0,"notes":[]}}')).toThrow(SyncError);
  });
});

describe('buildAnalystPrompt', () => {
  const context = {
    symbol: 'TESTUSDT',
    asOfMs: 1_700_000_000_000,
    technical: {
      interval: '1h',
      bars: 300,
      lastClose: 100,
      atr: 2,
      atrPeriod: 14,
      atrPercentOfPrice: 0.02,
      ma: [{ kind: 'sma' as const, bars: 20, value: 99 }],
      macd: { dif: 1, dea: 0.5, hist: 0.5 },
      rsi: [{ period: 14, value: 60 }],
      boll: { upper: 110, mid: 100, lower: 90 },
      kdj: { k: 70, d: 60, j: 80 },
      obv: { value: 1000, change: 50 },
      recentReturns: [0.1, -0.2],
      pricePercentile: 0.7,
      objectiveBias: 0.33,
      objectiveNotes: ['收盘价高于 MA20'],
    },
    sentiment: {
      fundingRate: null,
      fundingRateAnnualized: null,
      nextFundingTimeMs: null,
      markPrice: null,
      indexPrice: null,
      basisBps: null,
      openInterest: null,
      openInterestChangePct: null,
      longShortRatio: null,
      takerBuySellRatio: null,
      notes: ['资金费率没取到：情绪面少一个最重要的参考'],
    },
    fundamental: {
      contractType: 'PERPETUAL',
      onboardDateMs: null,
      tickSize: 0.01,
      stepSize: 0.001,
      minQty: 0.001,
      quoteVolume24h: null,
      trades24h: null,
      priceChangePct24h: null,
      carryCostAnnualized: null,
      notes: [],
    },
    baseline: { stopAtrMult: 2, takeProfitAtrMult: 3 },
  };

  it('提示词是纯函数：同样输入永远同样输出', () => {
    expect(buildAnalystPrompt(context)).toBe(buildAnalystPrompt(context));
  });

  it('取不到的数据写「未取到」，不写 0', () => {
    const prompt = buildAnalystPrompt(context);
    expect(prompt).toContain('未取到');
    expect(prompt).not.toContain('资金费率：0.0000%');
  });

  it('提示词讲清三件事：只输出 JSON、不许输出价格、每个数都会被用掉', () => {
    const prompt = buildAnalystPrompt(context);
    expect(prompt).toContain('只输出 JSON');
    expect(prompt).toContain('不要输出入场价、止损价、止盈价');
    expect(prompt).toContain('会被直接用掉');
  });

  it('提示词里带三个面的数据与客观倾向分', () => {
    const prompt = buildAnalystPrompt(context);
    expect(prompt).toContain('技术面');
    expect(prompt).toContain('情绪面');
    expect(prompt).toContain('基本面');
    expect(prompt).toContain('客观倾向分');
  });
});
