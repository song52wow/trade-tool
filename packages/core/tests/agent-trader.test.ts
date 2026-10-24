/**
 * 交易员 Agent 的纯函数测试（不连 PG、不出网、不调模型）。
 *
 * 锁的是**最要紧的那条边界**：模型只给比例，钱和价格由程序算。
 * 具体锁住：
 *   * 数量由「风险金额 ÷ 止损距离」算出，并按 `stepSize` 对齐；
 *   * 价格按 `tickSize` 对齐，且止损/止盈分居进场价两侧；
 *   * 风险比例超上限 → 夹住并**留下调整记录**（不静默截断）；
 *   * 盈亏比不达标 → 抬高止盈倍数；
 *   * 方向与分析师结论矛盾 → **拒绝出方案**；
 *   * 数量低于交易所最小下单量 → 拒绝出方案（那笔单根本不存在）。
 */

import {
  buildTraderPrompt,
  checkSideAlignment,
  deriveExecutionPlan,
  parseTraderProposal,
  stanceLabel,
  SyncError,
  type AnalystVerdict,
  type ExecutionLimits,
  type TraderProposal,
} from '@trade-tool/core';
import { describe, expect, it } from 'vitest';

const LIMITS: ExecutionLimits = {
  maxRiskFraction: 0.01,
  maxNotional: 0,
  minRiskReward: 1.5,
  neutralRiskFactor: 0.5,
};

function verdict(overrides: Partial<AnalystVerdict> = {}): AnalystVerdict {
  return {
    stance: 'bullish',
    confidence: 0.8,
    bias: 0.6,
    agreement: 0.9,
    facets: {
      technical: { score: 0.7, notes: ['a'] },
      sentiment: { score: 0.5, notes: ['b'] },
      fundamental: { score: 0.2, notes: ['c'] },
    },
    stopAtrMult: 2,
    takeProfitAtrMult: 3,
    rationale: '理由',
    ...overrides,
  } as AnalystVerdict;
}

function proposal(overrides: Partial<TraderProposal> = {}): TraderProposal {
  return {
    side: 'BUY',
    entryType: 'market',
    entryOffsetAtrMult: 0,
    riskFraction: 0.01,
    stopAtrMult: 2,
    takeProfitAtrMult: 3,
    rationale: '理由',
    ...overrides,
  };
}

const baseInput = {
  symbol: 'TESTUSDT',
  equity: 10_000,
  lastPrice: 100,
  atr: 2,
  atrPeriod: 14,
  tickSize: 0.01,
  stepSize: 0.001,
  minQty: 0.001,
  limits: LIMITS,
};

describe('deriveExecutionPlan', () => {
  it('数量由「风险金额 ÷ 止损距离」算出：10000 × 1% ÷ 4 = 25', () => {
    const plan = deriveExecutionPlan({
      ...baseInput,
      verdict: verdict(),
      proposal: proposal(),
    });
    expect(plan.action).toBe('enter');
    if (plan.action !== 'enter') return;
    // 进场 100、ATR 2、止损 2×ATR → 止损 96，止损距离 4
    expect(plan.entryPrice).toBeCloseTo(100, 6);
    expect(plan.stopPrice).toBeCloseTo(96, 6);
    expect(plan.takeProfitPrice).toBeCloseTo(106, 6);
    expect(plan.quantity).toBeCloseTo(25, 6);
    expect(plan.riskAmount).toBeCloseTo(100, 6);
    expect(plan.notional).toBeCloseTo(2500, 6);
    expect(plan.riskReward).toBeCloseTo(1.5, 6);
  });

  it('价格按 tickSize 对齐', () => {
    const plan = deriveExecutionPlan({
      ...baseInput,
      verdict: verdict(),
      proposal: proposal({ stopAtrMult: 1.5 }),
      tickSize: 0.5,
    });
    if (plan.action !== 'enter') throw new Error('应当出方案');
    expect(plan.entryPrice % 0.5).toBeCloseTo(0, 9);
    expect(plan.stopPrice % 0.5).toBeCloseTo(0, 9);
  });

  it('数量按 stepSize 向下对齐', () => {
    const plan = deriveExecutionPlan({
      ...baseInput,
      verdict: verdict(),
      proposal: proposal(),
      stepSize: 0.1,
    });
    if (plan.action !== 'enter') throw new Error('应当出方案');
    expect(plan.quantity).toBeCloseTo(25, 9);
    expect(Math.round(plan.quantity / 0.1) * 0.1).toBeCloseTo(plan.quantity, 9);
  });

  it('风险比例超过上限 → 夹到上限，并留下调整记录（不静默截断）', () => {
    const plan = deriveExecutionPlan({
      ...baseInput,
      verdict: verdict(),
      proposal: proposal({ riskFraction: 0.03 }),
    });
    if (plan.action !== 'enter') throw new Error('应当出方案');
    expect(plan.adjustments.join(' ')).toContain('夹到上限');
    expect(plan.riskFraction).toBeCloseTo(0.01, 6);
    expect(plan.riskAmount).toBeCloseTo(100, 6);
  });

  it('盈亏比不达标 → 抬高止盈倍数，并留下调整记录', () => {
    const plan = deriveExecutionPlan({
      ...baseInput,
      verdict: verdict(),
      proposal: proposal({ stopAtrMult: 2, takeProfitAtrMult: 2 }),
      limits: { ...LIMITS, minRiskReward: 2 },
    });
    if (plan.action !== 'enter') throw new Error('应当出方案');
    expect(plan.adjustments.join(' ')).toContain('止盈倍数');
    expect(plan.riskReward).toBeGreaterThanOrEqual(2);
    expect(plan.takeProfitAtrMult).toBeGreaterThan(2);
  });

  it('名义金额超上限 → 按上限缩量，并留下调整记录', () => {
    const plan = deriveExecutionPlan({
      ...baseInput,
      verdict: verdict(),
      proposal: proposal(),
      limits: { ...LIMITS, maxNotional: 1_000 },
    });
    if (plan.action !== 'enter') throw new Error('应当出方案');
    expect(plan.adjustments.join(' ')).toContain('按上限缩量');
    expect(plan.notional).toBeLessThanOrEqual(1_000);
  });

  it('方向与分析师结论矛盾 → 拒绝出方案', () => {
    expect(() =>
      deriveExecutionPlan({
        ...baseInput,
        verdict: verdict(),
        proposal: proposal({ side: 'SELL' }),
      }),
    ).toThrow(SyncError);
  });

  it('分析师看空而方案做多 → 同样拒绝', () => {
    expect(() =>
      deriveExecutionPlan({
        ...baseInput,
        verdict: verdict({ stance: 'bearish' }),
        proposal: proposal({ side: 'BUY' }),
      }),
    ).toThrow(SyncError);
  });

  it('结论中性时两个方向都允许，但风险敞口减半并留下记录', () => {
    const plan = deriveExecutionPlan({
      ...baseInput,
      verdict: verdict({ stance: 'neutral' }),
      proposal: proposal({ riskFraction: 0.01 }),
    });
    if (plan.action !== 'enter') throw new Error('应当出方案');
    expect(plan.stanceAlignment).toBe('neutral');
    expect(plan.adjustments.join(' ')).toContain('打折');
    expect(plan.riskFraction).toBeCloseTo(0.005, 6);
  });

  it('side = NONE → 不做（不是失败）', () => {
    const plan = deriveExecutionPlan({
      ...baseInput,
      verdict: verdict(),
      proposal: proposal({ side: 'NONE' }),
    });
    expect(plan.action).toBe('hold');
  });

  it('数量低于交易所最小下单量 → 拒绝出方案', () => {
    // 权益 10000、风险 0.01% → 愿意亏 1 元；止损距离 4 → 数量 0.25。
    // 而这个标的的最小下单量是 1 → 这一笔根本不存在，必须拒绝而不是出一份 0.25 的方案。
    expect(() =>
      deriveExecutionPlan({
        ...baseInput,
        verdict: verdict(),
        proposal: proposal({ riskFraction: 0.0001 }),
        minQty: 1,
      }),
    ).toThrow(SyncError);
  });

  it('限价进场挂在现价下方（多头回调买），并按 tick 对齐', () => {
    const plan = deriveExecutionPlan({
      ...baseInput,
      verdict: verdict(),
      proposal: proposal({ entryType: 'limit', entryOffsetAtrMult: 1 }),
    });
    if (plan.action !== 'enter') throw new Error('应当出方案');
    expect(plan.entryPrice).toBeCloseTo(98, 6);
    expect(plan.entryPrice).toBeLessThan(baseInput.lastPrice);
  });

  it('空头：止损在上、止盈在下', () => {
    const plan = deriveExecutionPlan({
      ...baseInput,
      verdict: verdict({ stance: 'bearish' }),
      proposal: proposal({ side: 'SELL' }),
    });
    if (plan.action !== 'enter') throw new Error('应当出方案');
    expect(plan.stopPrice).toBeCloseTo(104, 6);
    expect(plan.takeProfitPrice).toBeCloseTo(94, 6);
    expect(plan.stopPrice).toBeGreaterThan(plan.entryPrice);
  });

  it('权益 / ATR 非正直接报错', () => {
    expect(() =>
      deriveExecutionPlan({ ...baseInput, equity: 0, verdict: verdict(), proposal: proposal() }),
    ).toThrow(SyncError);
    expect(() =>
      deriveExecutionPlan({ ...baseInput, atr: 0, verdict: verdict(), proposal: proposal() }),
    ).toThrow(SyncError);
  });
});

describe('checkSideAlignment', () => {
  it('看多 + 做多 = aligned；看多 + 做空 = contradicts', () => {
    expect(checkSideAlignment('bullish', 'BUY')).toBe('aligned');
    expect(checkSideAlignment('bullish', 'SELL')).toBe('contradicts');
    expect(checkSideAlignment('bearish', 'SELL')).toBe('aligned');
    expect(checkSideAlignment('neutral', 'BUY')).toBe('neutral');
    expect(checkSideAlignment('bullish', 'NONE')).toBe('aligned');
  });
});

describe('parseTraderProposal', () => {
  it('接受纯 JSON 与带围栏的 JSON', () => {
    const body = {
      side: 'BUY',
      entryType: 'limit',
      entryOffsetAtrMult: 0.5,
      riskFraction: 0.01,
      stopAtrMult: 2,
      takeProfitAtrMult: 3,
      rationale: '理由',
    };
    expect(parseTraderProposal(JSON.stringify(body)).side).toBe('BUY');
    const fenced = '```json\n' + JSON.stringify(body) + '\n```';
    expect(parseTraderProposal(fenced).entryOffsetAtrMult).toBe(0.5);
  });

  it('越界 / 不是 JSON / 缺字段都报错', () => {
    expect(() =>
      parseTraderProposal(
        JSON.stringify({
          side: 'BUY',
          riskFraction: 0.5,
          stopAtrMult: 2,
          takeProfitAtrMult: 3,
          rationale: 'r',
        }),
      ),
    ).toThrow(SyncError);
    expect(() => parseTraderProposal('做多吧')).toThrow(SyncError);
    expect(() => parseTraderProposal('{"side":"BUY"}')).toThrow(SyncError);
  });
});

describe('buildTraderPrompt', () => {
  it('提示词是纯函数，且讲清「不许输出数量与价格」', () => {
    const context = {
      symbol: 'TESTUSDT',
      verdict: verdict(),
      equity: 10_000,
      lastPrice: 100,
      atr: 2,
      atrPeriod: 14,
      tickSize: 0.01,
      stepSize: 0.001,
      minQty: 0.001,
      limits: LIMITS,
      baseline: { stopAtrMult: 2, takeProfitAtrMult: 3 },
    };
    expect(buildTraderPrompt(context)).toBe(buildTraderPrompt(context));
    expect(buildTraderPrompt(context)).toContain('不要输出数量、价格、金额');
    expect(buildTraderPrompt(context)).toContain('看多');
  });

  it('立场标签：看多 / 看空 / 中性', () => {
    expect(stanceLabel('bullish')).toBe('看多');
    expect(stanceLabel('bearish')).toBe('看空');
    expect(stanceLabel('neutral')).toBe('中性');
  });

  it('风险上限必须说清「比例是多少、相当于百分之几」', () => {
    // 踩过的坑：模板把 `0.01` 与 `1%` 直接拼在一起，提示词里就成了
    // 「不得超过 0.011%」——把 1% 的上限说成了 0.011%，**小了 100 倍**。
    // 模型照着提的 riskFraction 在 schema 合法区间里，程序不会夹它，
    // 于是仓位只有该有的百分之一，而日志上一切正常。
    const context = {
      symbol: 'TESTUSDT',
      verdict: verdict(),
      equity: 10_000,
      lastPrice: 100,
      atr: 2,
      atrPeriod: 14,
      tickSize: 0.01,
      stepSize: 0.001,
      minQty: 0.001,
      limits: LIMITS,
      baseline: { stopAtrMult: 2, takeProfitAtrMult: 3 },
    };
    const prompt = buildTraderPrompt(context);
    // 比例与百分比都在，且**没有**被拼成「0.011%」这种混账。
    expect(prompt).toContain(String(LIMITS.maxRiskFraction));
    expect(prompt).toContain('1%');
    expect(prompt).not.toContain('0.011%');
    expect(prompt).not.toContain(
      `${String(LIMITS.maxRiskFraction)}${String(LIMITS.maxRiskFraction * 100)}%`,
    );
  });

  it('风险上限：换成别的上限也不能拼出混账', () => {
    const context = {
      symbol: 'TESTUSDT',
      verdict: verdict(),
      equity: 10_000,
      lastPrice: 100,
      atr: 2,
      atrPeriod: 14,
      tickSize: 0.01,
      stepSize: 0.001,
      minQty: 0.001,
      limits: { ...LIMITS, maxRiskFraction: 0.02 },
      baseline: { stopAtrMult: 2, takeProfitAtrMult: 3 },
    };
    const prompt = buildTraderPrompt(context);
    expect(prompt).toContain('0.02');
    expect(prompt).toContain('2%');
    expect(prompt).not.toContain('0.022%');
  });

  it('字段说明说清 riskFraction 是比例不是百分数', () => {
    const context = {
      symbol: 'TESTUSDT',
      verdict: verdict(),
      equity: 10_000,
      lastPrice: 100,
      atr: 2,
      atrPeriod: 14,
      tickSize: 0.01,
      stepSize: 0.001,
      minQty: 0.001,
      limits: LIMITS,
      baseline: { stopAtrMult: 2, takeProfitAtrMult: 3 },
    };
    expect(buildTraderPrompt(context)).toContain('要 1% 就填 0.01，不要填 1');
  });
});
