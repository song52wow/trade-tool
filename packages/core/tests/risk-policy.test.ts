/**
 * 风控策略的纯函数测试（不连 PG、不出网）。
 *
 * 锁的是「算出来的价格对不对、会不会静默算出怪价格」：
 *   * 对称倍数；
 *   * 对齐方向（两张单都朝远离入场价的一侧）；
 *   * ATR = 0 / 倍数为 0 / tick 比 ATR 还大 —— 必须报错，不得算出怪价格。
 */

import {
  SyncError,
  alignToQty,
  alignToTick,
  decimalsOf,
  deriveBracketPlan,
  deriveStagedPlan,
  deriveTrailingPlan,
  normalizeTakeProfit1Ratio,
  percentToRatio,
  ratioToPercent,
} from '@trade-tool/core';
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

// ---------------------------------------------------------------------------
// 分批止盈 + 移动止损（v0.7.0 起；v0.9.1 合并成一个止盈倍数）
// ---------------------------------------------------------------------------

const staged = {
  side: 'BUY' as const,
  entryPrice: 100,
  atr: 2,
  atrPeriod: 14,
  tickSize: 0.01,
  stepSize: 0.001,
  filledQty: 1,
  stopAtrMult: 2,
  takeProfitAtrMult: 3,
  takeProfit1Ratio: 0.5,
};

describe('alignToQty', () => {
  it('按步长整数倍向下取整，且不吃掉浮点尾数', () => {
    expect(alignToQty(0.5, 0.001, 'down')).toBe(0.5);
    expect(alignToQty(0.56789, 0.01, 'down')).toBe(0.56);
    // 取整到 0 是「这个数量压根不存在」，必须报错而不是返回 0 冒充合法数量
    expect(() => alignToQty(0.0001, 0.001, 'down')).toThrow(SyncError);
  });

  it('非正数量 / 非正步长直接报错', () => {
    expect(() => alignToQty(0, 0.001, 'down')).toThrow(SyncError);
    expect(() => alignToQty(1, 0, 'down')).toThrow(SyncError);
  });
});

describe('normalizeTakeProfit1Ratio', () => {
  it('1 归一到 0（两者逐字等价：都是一次全平、都用同一个倍数）', () => {
    expect(normalizeTakeProfit1Ratio(1)).toBe(0);
    expect(normalizeTakeProfit1Ratio(0)).toBe(0);
    expect(normalizeTakeProfit1Ratio(0.5)).toBe(0.5);
  });

  it('越界直接报错，不静默夹回', () => {
    expect(() => normalizeTakeProfit1Ratio(1.5)).toThrow(SyncError);
    expect(() => normalizeTakeProfit1Ratio(-0.1)).toThrow(SyncError);
    expect(() => normalizeTakeProfit1Ratio(Number.NaN)).toThrow(SyncError);
  });
});

describe('两个算价的函数必须给出**同一个价**（Agent 与 executor 的对齐保证）', () => {
  /**
   * 为什么有这条：Agent 的执行方案走 `deriveBracketPlan`，
   * 而 `apps/executor` 挂单走 `deriveStagedPlan`——**两个不同的函数**。
   *
   * 文档里写着「方案上的止损价与交易所上的止损价不会差一个 tick」，
   * 那这句话就必须由**代码**担保，而不是由一句注释担保：
   * 一旦哪天有人改了其中一个的对齐方向，方案上的价就会与真挂出去的那张单差一格，
   * 而**没有任何一处会报错**——那正是「看起来成功了，其实什么都没做」的形态。
   *
   * 口径：`deriveStagedPlan` 明确「止损的算式完全复用 v0.4.0 的口径，不另抄一遍」，
   * 而 v0.4.0 的口径就是 `deriveBracketPlan`；两者的 tick 对齐方向也相同
   * （多头向下、空头向上）。下面这条断言就是把这个「复用」钉死。
   */
  const cases = [
    { name: '多头 / 不分批', side: 'BUY' as const, ratio: 0 },
    { name: '多头 / 分批', side: 'BUY' as const, ratio: 0.5 },
    { name: '空头 / 不分批', side: 'SELL' as const, ratio: 0 },
    { name: '空头 / 分批', side: 'SELL' as const, ratio: 0.5 },
  ];

  for (const c of cases) {
    it(`${c.name}：止损价与止盈价逐字相同`, () => {
      const common = {
        side: c.side,
        entryPrice: 100,
        atr: 2,
        atrPeriod: 14,
        tickSize: 0.01,
        stopAtrMult: 2,
        takeProfitAtrMult: 3,
      };
      const bracket = deriveBracketPlan(common);
      const stagedPlan = deriveStagedPlan({
        ...common,
        stepSize: 0.001,
        filledQty: 1,
        takeProfit1Ratio: c.ratio,
      });

      expect(stagedPlan.stopPrice).toBe(bracket.stopPrice);
      expect(stagedPlan.takeProfitPrice).toBe(bracket.takeProfitPrice);
      expect(stagedPlan.stopDistance).toBe(bracket.stopDistance);
    });
  }

  it('ATR 相对 tick 很小时也一样（对齐方向不同才会暴露差异）', () => {
    // ATR = 0.013、tick = 0.01：两个价都落在 tick 网格上但不在整格里，
    // 任何「差一格」的偏差都会在这里现形。
    const common = {
      side: 'BUY' as const,
      entryPrice: 100,
      atr: 0.013,
      atrPeriod: 14,
      tickSize: 0.01,
      stopAtrMult: 2,
      takeProfitAtrMult: 3,
    };
    const bracket = deriveBracketPlan(common);
    const stagedPlan = deriveStagedPlan({
      ...common,
      stepSize: 0.001,
      filledQty: 1,
      takeProfit1Ratio: 0.5,
    });

    expect(stagedPlan.stopPrice).toBe(bracket.stopPrice);
    expect(stagedPlan.takeProfitPrice).toBe(bracket.takeProfitPrice);
  });
});

describe('deriveStagedPlan', () => {
  it('比例 0：不分批，一次全平', () => {
    const plan = deriveStagedPlan({ ...staged, takeProfit1Ratio: 0 });
    expect(plan.mode).toBe('single');
    expect(plan.tp1Qty).toBeNull();
    // 止盈价 = 入场 + 3×ATR；它就是挂出去的那张单的价
    expect(plan.takeProfitPrice).toBe(106);
    // 止损与 v0.4.0 逐字一致：入场 ∓ 2×ATR
    expect(plan.stopPrice).toBe(96);
  });

  it('比例 1：归一到 0，因此与「比例 0」逐字相同', () => {
    const one = deriveStagedPlan({ ...staged, takeProfit1Ratio: 1 });
    const zero = deriveStagedPlan({ ...staged, takeProfit1Ratio: 0 });
    expect(one.mode).toBe('single');
    expect(one.tp1Qty).toBeNull();
    expect(one.takeProfitPrice).toBe(zero.takeProfitPrice);
    expect(one.stopPrice).toBe(zero.stopPrice);
  });

  it('分批形态：止盈价用**同一个**倍数（没有「整段价」那个虚构概念了）', () => {
    const plan = deriveStagedPlan({ ...staged, takeProfit1Ratio: 0.5 });
    expect(plan.mode).toBe('partial');
    // 挂出去的是那张「带数量」的第一段止盈单，它的价格 = 入场 + 3×ATR
    expect(plan.takeProfitPrice).toBe(106);
    expect(plan.tp1Qty).toBe(0.5);
  });

  it('分批形态：止盈价落在入场价同一侧时拒绝（别挂一张必然被拒的单）', () => {
    expect(() =>
      deriveStagedPlan({
        ...staged,
        takeProfit1Ratio: 0.5,
        atr: 0.001,
        tickSize: 0.1,
        takeProfitAtrMult: 0.5,
      }),
    ).toThrow(/同一侧/);
  });

  it('比例落在 (0,1)：减仓量按步长向下取整，止损不变', () => {
    const plan = deriveStagedPlan({ ...staged, filledQty: 0.3, takeProfit1Ratio: 0.8 });
    expect(plan.mode).toBe('partial');
    // 0.3 × 0.8 = 0.24… 浮点上落到步长下界之外时必须落到最近的合法步长
    expect(plan.tp1Qty).toBeGreaterThan(0);
    expect(plan.tp1Qty!).toBeLessThan(0.3);
    expect(Number.isInteger(Math.round(plan.tp1Qty! / 0.001))).toBe(true);
    expect(plan.stopPrice).toBe(96);
  });

  it('取整后数量不合法 → 拒绝，不退化成全平或不减仓', () => {
    // 0.001 × 0.5 = 0.0005 → 向下取整到步长 0.001 就是 0
    expect(() => deriveStagedPlan({ ...staged, filledQty: 0.001, takeProfit1Ratio: 0.5 })).toThrow(
      /拒绝这一段/,
    );
  });

  it('空头完全镜像', () => {
    const plan = deriveStagedPlan({ ...staged, side: 'SELL', takeProfit1Ratio: 0.5 });
    expect(plan.exitSide).toBe('BUY');
    expect(plan.stopPrice).toBe(104);
    expect(plan.takeProfitPrice).toBe(94);
    expect(plan.tp1Qty).toBe(0.5);
  });

  it('比例越界直接报错', () => {
    expect(() => deriveStagedPlan({ ...staged, takeProfit1Ratio: 1.5 })).toThrow(SyncError);
    expect(() => deriveStagedPlan({ ...staged, takeProfit1Ratio: -0.1 })).toThrow(SyncError);
  });

  it('确定性', () => {
    expect(deriveStagedPlan(staged)).toEqual(deriveStagedPlan(staged));
  });
});

const trailing = {
  side: 'BUY' as const,
  prevStop: 96,
  extreme: 110,
  atr: 2,
  entryPrice: 100,
  tickSize: 0.01,
  trailAtrMult: 2,
  applyBreakeven: false,
  // 参考现价要高于新算出的档位（110 − 2×2 = 106），否则会走「越过现价就不动」那条
  referencePrice: 108,
};

describe('deriveTrailingPlan', () => {
  it('候选价向下对齐，且只上移不放宽', () => {
    const plan = deriveTrailingPlan(trailing);
    // 110 − 2×2 = 106 → 向下对齐仍是 106 > 96，上移
    expect(plan.stopPrice).toBe(106);
    expect(plan.changed).toBe(true);
    expect(plan.reason).toBe('moved');
  });

  it('波动变小算出的档位更松 → 不动，且必须 changed=false', () => {
    const plan = deriveTrailingPlan({ ...trailing, prevStop: 107 });
    expect(plan.stopPrice).toBe(107);
    expect(plan.changed).toBe(false);
    expect(plan.reason).toBe('unchanged');
  });

  it('对齐方向是向下：105.999 得 105.99 而不是 106', () => {
    const plan = deriveTrailingPlan({ ...trailing, extreme: 108, atr: 1 });
    // 108 − 2×1 = 106 → 恰好在 tick 上；用 105.999 验证向下取整
    expect(plan.stopPrice).toBe(106);
    const down = deriveTrailingPlan({ ...trailing, extreme: 107.999, atr: 1 });
    expect(down.stopPrice).toBe(105.99);
  });

  it('保本档位朝有利方向对齐：多头向上，不会低于入场价', () => {
    const plan = deriveTrailingPlan({
      ...trailing,
      prevStop: 96,
      extreme: 101,
      atr: 2,
      applyBreakeven: true,
    });
    // 极值 101 − 4 = 97 < 100，保本 100 胜出
    expect(plan.stopPrice).toBe(100);
    expect(plan.reason).toBe('breakeven');
    expect(plan.stopPrice).toBeGreaterThanOrEqual(trailing.entryPrice);
  });

  it('止损位越过现价 → 不动，保留旧档并给出原因', () => {
    const plan = deriveTrailingPlan({
      ...trailing,
      prevStop: 96,
      extreme: 106,
      atr: 1,
      referencePrice: 105,
    });
    // 106 − 2 = 104 < 105，能挂；再抬高极值让它越过
    expect(plan.changed).toBe(true);
    const crossed = deriveTrailingPlan({
      ...trailing,
      prevStop: 96,
      extreme: 130,
      atr: 1,
      referencePrice: 105,
    });
    expect(crossed.stopPrice).toBe(96);
    expect(crossed.changed).toBe(false);
    expect(crossed.reason).toBe('beyond-price');
  });

  it('空头完全镜像：候选价向上对齐、只下移', () => {
    const plan = deriveTrailingPlan({
      ...trailing,
      side: 'SELL',
      prevStop: 104,
      extreme: 90,
      // 空头是「止损 <= 现价才算越过」，所以参考现价必须低于新档位 94
      referencePrice: 92,
    });
    // 90 + 4 = 94 < 104，下移
    expect(plan.stopPrice).toBe(94);
    expect(plan.changed).toBe(true);
  });

  it('非正 ATR / 极值 / 旧档直接报错', () => {
    expect(() => deriveTrailingPlan({ ...trailing, atr: 0 })).toThrow(SyncError);
    expect(() => deriveTrailingPlan({ ...trailing, extreme: 0 })).toThrow(SyncError);
    expect(() => deriveTrailingPlan({ ...trailing, prevStop: 0 })).toThrow(SyncError);
    expect(() => deriveTrailingPlan({ ...trailing, trailAtrMult: -1 })).toThrow(SyncError);
  });

  it('确定性', () => {
    expect(deriveTrailingPlan(trailing)).toEqual(deriveTrailingPlan(trailing));
  });
});

describe('比例与百分数的换算', () => {
  it('双向可逆，且抹掉浮点尾数', () => {
    expect(ratioToPercent(0.8)).toBe(80);
    expect(percentToRatio(80)).toBe(0.8);
    expect(ratioToPercent(0.5)).toBe(50);
    expect(percentToRatio(33.3)).toBeCloseTo(0.333, 10);
  });

  it('越界直接报错', () => {
    expect(() => ratioToPercent(1.2)).toThrow(SyncError);
    expect(() => percentToRatio(101)).toThrow(SyncError);
    expect(() => percentToRatio(-1)).toThrow(SyncError);
  });
});
