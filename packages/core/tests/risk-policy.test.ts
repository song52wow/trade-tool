/**
 * 风控策略的纯函数测试（不连 PG、不出网）。
 *
 * 锁的是「算出来的价格对不对、会不会静默算出怪价格」：
 *   * 对称倍数；
 *   * 对齐方向（两张单都朝远离入场价的一侧）；
 *   * ATR = 0 / 倍数为 0 / tick 比 ATR 还大 —— 必须报错，不得算出怪价格。
 */

import { SyncError, alignToTick, decimalsOf, deriveBracketPlan } from '@trade-tool/core';
import { describe, expect, it } from 'vitest';

const base = {
  side: 'BUY' as const,
  atrPeriod: 14,
  stopAtrMult: 2,
  takeProfitAtrMult: 3,
};

describe('alignToTick', () => {
  it('向下对齐不因浮点误差白丢一个 tick', () => {
    // 0.1 + 0.2 = 0.30000000000000004，直接 Math.floor(0.3*100)/100 也对，
    // 但 1050.0000000001 这类值若不先取整就会掉到 1049.99。
    expect(alignToTick(1050.0000000001, 0.01, 'down')).toBe(1050);
    expect(alignToTick(100.567, 0.01, 'down')).toBe(100.56);
    expect(alignToTick(100.561, 0.01, 'up')).toBe(100.57);
  });

  it('支持小数 tick 与整 tick', () => {
    expect(decimalsOf(0.1)).toBe(1);
    expect(decimalsOf(0.01)).toBe(2);
    expect(decimalsOf(1)).toBe(0);
    expect(alignToTick(1050.5678, 0.5, 'down')).toBe(1050.5);
  });

  it('非正价格 / 非正 tick 直接报错', () => {
    expect(() => alignToTick(0, 0.01, 'down')).toThrow(SyncError);
    expect(() => alignToTick(100, 0, 'down')).toThrow(SyncError);
  });
});

describe('deriveBracketPlan', () => {
  it('多头：止损在下、止盈在上，倍数正确', () => {
    const plan = deriveBracketPlan({ ...base, entryPrice: 100, atr: 10, tickSize: 0.01 });
    expect(plan.positionSide).toBe('LONG');
    expect(plan.exitSide).toBe('SELL');
    expect(plan.stopPrice).toBeCloseTo(80, 6);
    expect(plan.takeProfitPrice).toBeCloseTo(130, 6);
    expect(plan.riskReward).toBeCloseTo(1.5, 6);
  });

  it('空头完全镜像', () => {
    const plan = deriveBracketPlan({
      ...base,
      side: 'SELL',
      entryPrice: 100,
      atr: 10,
      tickSize: 0.01,
    });
    expect(plan.positionSide).toBe('SHORT');
    expect(plan.exitSide).toBe('BUY');
    expect(plan.stopPrice).toBeCloseTo(120, 6);
    expect(plan.takeProfitPrice).toBeCloseTo(70, 6);
  });

  it('两张单都朝远离入场价的方向对齐：止损不因取整变紧', () => {
    // entry=100, atr=7.333, stop=100-14.666=85.334 → 向下取到 85.33（更松，不更紧）
    const plan = deriveBracketPlan({
      ...base,
      entryPrice: 100,
      atr: 7.333,
      stopAtrMult: 2,
      takeProfitAtrMult: 1,
      tickSize: 0.01,
    });
    expect(plan.stopPrice).toBe(85.33);
    // 若按四舍五入会得到 85.33 之外的更近一档；这里断言的是「不更紧」
    expect(plan.stopPrice).toBeLessThanOrEqual(100 - 2 * 7.333);
  });

  it('空头时向上对齐', () => {
    const plan = deriveBracketPlan({
      ...base,
      side: 'SELL',
      entryPrice: 100,
      atr: 7.333,
      takeProfitAtrMult: 1,
      tickSize: 0.01,
    });
    expect(plan.takeProfitPrice).toBe(92.67);
  });

  it('ATR 为 0 直接报错：否则止损会正好落在入场价上', () => {
    expect(() => deriveBracketPlan({ ...base, entryPrice: 100, atr: 0, tickSize: 0.01 })).toThrow(
      /ATR 必须为正/,
    );
  });

  it('倍数为 0 / 负数报错', () => {
    expect(() =>
      deriveBracketPlan({ ...base, stopAtrMult: 0, entryPrice: 100, atr: 1, tickSize: 0.01 }),
    ).toThrow(SyncError);
    expect(() =>
      deriveBracketPlan({
        ...base,
        takeProfitAtrMult: -1,
        entryPrice: 100,
        atr: 1,
        tickSize: 0.01,
      }),
    ).toThrow(SyncError);
  });

  it('tick 相对 ATR 太大时报错，而不是挂一张必然被拒的单', () => {
    expect(() =>
      deriveBracketPlan({ ...base, entryPrice: 100, atr: 0.001, tickSize: 0.1 }),
    ).toThrow(/同一侧|太大/);
  });

  it('确定性：同一组输入永远给出同一组价格', () => {
    const input = { ...base, entryPrice: 63_412.7, atr: 231.55, tickSize: 0.1 };
    expect(deriveBracketPlan(input)).toEqual(deriveBracketPlan(input));
  });
});
