/**
 * LLM 决策契约的纯函数测试（不连 PG、不出网）。
 *
 * 锁的是三件事：
 *   1. **模型说了不算** —— 输出必须过 schema 的范围校验，越界即报错；
 *   2. **不静默兜底** —— 解析失败一律抛 `LLM_DECISION_INVALID`，绝不返回默认值；
 *   3. **只有一份口径** —— 合并时模型只覆盖倍数，取数口径永远来自策略。
 */

import {
  SyncError,
  buildDecisionPrompt,
  clampLlmDecision,
  mergeDecisionIntoPolicy,
  parseLlmDecision,
  validateLlmDecision,
  type LlmDecision,
} from '@trade-tool/core';
import { describe, expect, it } from 'vitest';

const valid: LlmDecision = {
  stopAtrMult: 2.5,
  takeProfitAtrMult: 4,
  takeProfit1Ratio: 0,
  takeProfit1AtrMult: 3,
  trailAtrMult: 2,
  breakevenAfterTp1: true,
};

describe('parseLlmDecision', () => {
  it('接受纯 JSON', () => {
    const { decision, rationale } = parseLlmDecision(
      JSON.stringify({ ...valid, rationale: '波动放大，止损放宽一点' }),
    );
    expect(decision.stopAtrMult).toBe(2.5);
    expect(decision.takeProfitAtrMult).toBe(4);
    expect(rationale).toBe('波动放大，止损放宽一点');
  });

  it('接受带 markdown 围栏的 JSON（模型最常见的输出形态）', () => {
    const fenced = '```json\n' + JSON.stringify(valid) + '\n```';
    expect(parseLlmDecision(fenced).decision).toEqual(valid);
  });

  it('接受不带语言标记的围栏', () => {
    const fenced = '```\n' + JSON.stringify(valid) + '\n```';
    expect(parseLlmDecision(fenced).decision).toEqual(valid);
  });

  it('rationale 可以不给', () => {
    const { rationale } = parseLlmDecision(JSON.stringify(valid));
    expect(rationale).toBeUndefined();
  });

  it('空内容报错，不返回默认值', () => {
    expect(() => parseLlmDecision('')).toThrow(SyncError);
    expect(() => parseLlmDecision('   ')).toThrow(/LLM_DECISION_INVALID/);
  });

  it('不是 JSON 就报错，不从散文里抠数字', () => {
    // 模型说了一句人话 —— 那不是档位。
    expect(() => parseLlmDecision('我觉得止损应该放在 2.5 倍 ATR 附近')).toThrow(SyncError);
  });

  it('JSON 数组不是对象，报错', () => {
    expect(() => parseLlmDecision('[1,2,3]')).toThrow(SyncError);
  });

  it('越界的倍数必须报错而不是截断', () => {
    expect(() => parseLlmDecision(JSON.stringify({ ...valid, stopAtrMult: 25 }))).toThrow(
      /LLM_DECISION_INVALID/,
    );
    expect(() => parseLlmDecision(JSON.stringify({ ...valid, takeProfitAtrMult: 99 }))).toThrow(
      SyncError,
    );
    expect(() => parseLlmDecision(JSON.stringify({ ...valid, stopAtrMult: 0 }))).toThrow(SyncError);
    expect(() => parseLlmDecision(JSON.stringify({ ...valid, stopAtrMult: -1 }))).toThrow(
      SyncError,
    );
    expect(() => parseLlmDecision(JSON.stringify({ ...valid, takeProfit1Ratio: 1.5 }))).toThrow(
      SyncError,
    );
  });

  it('缺字段报错', () => {
    const { trailAtrMult: _drop, ...incomplete } = valid;
    expect(() => parseLlmDecision(JSON.stringify(incomplete))).toThrow(/LLM_DECISION_INVALID/);
  });

  it('rationale 类型不对时报错（说明整体输出不可信）', () => {
    expect(() => parseLlmDecision(JSON.stringify({ ...valid, rationale: 123 }))).toThrow(SyncError);
  });
});

describe('validateLlmDecision', () => {
  it('分批形态下第一段必须比整段更靠近入场价', () => {
    const bad = { ...valid, takeProfit1Ratio: 0.5, takeProfit1AtrMult: 5, takeProfitAtrMult: 3 };
    const result = validateLlmDecision(bad, 14);
    expect(result.ok).toBe(false);
  });

  it('顺序对了就通过', () => {
    const good = { ...valid, takeProfit1Ratio: 0.5, takeProfit1AtrMult: 2, takeProfitAtrMult: 3 };
    expect(validateLlmDecision(good, 14).ok).toBe(true);
  });

  it('不分批（ratio=0）与全平（ratio=1）不比较远近', () => {
    // ratio=0 时第一段倍数毫无意义，不该因此拒绝这份决策。
    expect(validateLlmDecision({ ...valid, takeProfit1Ratio: 0 }, 14).ok).toBe(true);
    expect(
      validateLlmDecision(
        { ...valid, takeProfit1Ratio: 1, takeProfit1AtrMult: 9, takeProfitAtrMult: 3 },
        14,
      ).ok,
    ).toBe(true);
  });
});

describe('clampLlmDecision', () => {
  it('夹到区间边界，不改结构', () => {
    const clamped = clampLlmDecision({
      stopAtrMult: 99,
      takeProfitAtrMult: 999,
      takeProfit1Ratio: 5,
      takeProfit1AtrMult: 0,
      trailAtrMult: -3,
      breakevenAfterTp1: false,
    });
    expect(clamped.stopAtrMult).toBe(20);
    expect(clamped.takeProfitAtrMult).toBe(50);
    expect(clamped.takeProfit1Ratio).toBe(1);
    expect(clamped.trailAtrMult).toBeGreaterThan(0);
    // 布尔值原样保留
    expect(clamped.breakevenAfterTp1).toBe(false);
  });
});

describe('mergeDecisionIntoPolicy', () => {
  it('模型覆盖倍数，但取数口径永远来自策略', () => {
    const policy = {
      atrPeriod: 14,
      atrInterval: '15m',
      stopAtrMult: 2,
      takeProfitAtrMult: 3,
      takeProfit1Ratio: 0,
      takeProfit1AtrMult: 3,
      trailAtrMult: 2,
      breakevenAfterTp1: true,
    };
    const merged = mergeDecisionIntoPolicy(policy, valid);
    expect(merged.stopAtrMult).toBe(2.5);
    expect(merged.takeProfitAtrMult).toBe(4);
    // 口径没被动过
    expect(merged.atrPeriod).toBe(14);
    expect(merged.atrInterval).toBe('15m');
  });
});

describe('buildDecisionPrompt', () => {
  it('是纯函数：同样输入给同样输出', () => {
    const context = {
      symbol: 'BTCUSDT',
      side: 'BUY',
      entryPrice: 100,
      atr: 2,
      atrInterval: '15m',
      atrPeriod: 14,
      recentReturns: [0.1, -0.2],
      atrPercentOfPrice: 0.02,
      baseline: valid,
    };
    expect(buildDecisionPrompt(context)).toBe(buildDecisionPrompt(context));
  });

  it('提示词里没有绝对价格，只让模型选倍数', () => {
    const prompt = buildDecisionPrompt({
      symbol: 'BTCUSDT',
      side: 'BUY',
      entryPrice: 100,
      atr: 2,
      atrInterval: '15m',
      atrPeriod: 14,
      recentReturns: [],
      baseline: valid,
    });
    // 要求模型输出六个字段
    expect(prompt).toContain('stopAtrMult');
    expect(prompt).toContain('takeProfitAtrMult');
    expect(prompt).toContain('takeProfit1Ratio');
    expect(prompt).toContain('trailAtrMult');
    expect(prompt).toContain('breakevenAfterTp1');
    // 明确禁止它输出绝对价格
    expect(prompt).toContain('不要输出入场价、止损价、止盈价');
  });
});
