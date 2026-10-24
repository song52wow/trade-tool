/**
 * 盈亏口径（v0.8.0）。
 *
 * 重点是三件事：
 *   * 多空的方向别搞反（搞反了「赚」会显示成「亏」）；
 *   * 手续费**从毛利里扣**，而且是**整轮**的手续费（入场那笔也算）；
 *   * 分批的两段出场不能被揉成一个均价（`exitNotional` 是累计成交额）。
 */

import { describe, expect, it } from 'vitest';

import {
  estimateBracketPnl,
  feeInQuoteAsset,
  feePriceSymbol,
  realizedPnl,
  QUOTE_ASSET,
} from '../src/pnl.js';

describe('estimateBracketPnl', () => {
  it('多头：止盈在上、止损在下，收益与亏损都是正的', () => {
    const estimate = estimateBracketPnl({
      positionSide: 'LONG',
      entryPrice: 100,
      quantity: 2,
      takeProfitPrice: 110,
      stopPrice: 90,
    });
    expect(estimate.expectedProfit).toBeCloseTo(20, 10);
    expect(estimate.expectedLoss).toBeCloseTo(20, 10);
  });

  it('空头：止盈在下、止损在上，收益与亏损同样都是正的', () => {
    const estimate = estimateBracketPnl({
      positionSide: 'SHORT',
      entryPrice: 100,
      quantity: 2,
      takeProfitPrice: 90,
      stopPrice: 110,
    });
    // 方向搞反的话，这里会变成「赚 20、亏 20」的反号——所以断言的是**值**不是符号。
    expect(estimate.expectedProfit).toBeCloseTo(20, 10);
    expect(estimate.expectedLoss).toBeCloseTo(20, 10);
  });

  it('数量是 0 时两个数都是 0（不拿 0 冒充缺失）', () => {
    const estimate = estimateBracketPnl({
      positionSide: 'LONG',
      entryPrice: 100,
      quantity: 0,
      takeProfitPrice: 110,
      stopPrice: 90,
    });
    expect(estimate.expectedProfit).toBe(0);
    expect(estimate.expectedLoss).toBe(0);
  });
});

describe('realizedPnl', () => {
  it('多头：毛利 = 成交额 − 入场成本，净盈亏再减手续费', () => {
    const pnl = realizedPnl({
      positionSide: 'LONG',
      entryPrice: 100,
      closedQty: 2,
      exitNotional: 220,
      feeAmount: 1.5,
    });
    expect(pnl).not.toBeNull();
    expect(pnl?.gross).toBeCloseTo(20, 10);
    expect(pnl?.fee).toBeCloseTo(1.5, 10);
    expect(pnl?.net).toBeCloseTo(18.5, 10);
  });

  it('空头：卖出价高于买回价才是赚', () => {
    const pnl = realizedPnl({
      positionSide: 'SHORT',
      entryPrice: 100,
      closedQty: 2,
      exitNotional: 180,
      feeAmount: 1,
    });
    expect(pnl).not.toBeNull();
    expect(pnl?.gross).toBeCloseTo(20, 10);
    expect(pnl?.net).toBeCloseTo(19, 10);
  });

  it('亏的时候净盈亏是负的，而且手续费让它更亏', () => {
    const pnl = realizedPnl({
      positionSide: 'LONG',
      entryPrice: 100,
      closedQty: 2,
      exitNotional: 180,
      feeAmount: 1,
    });
    expect(pnl).not.toBeNull();
    expect(pnl?.gross).toBeCloseTo(-20, 10);
    expect(pnl?.net).toBeCloseTo(-21, 10);
  });

  it('分批的两段出场：按累计成交额算，中间那一段不能当成结账', () => {
    // 第一段 110 卖 1 个（赚 10），第二段 90 卖 1 个（亏 10）→ 整轮毛利 0。
    // 只看第一段会报「赚 10」；成交额是累计的事实，盈亏要等整轮走完才算得出。
    const pnl = realizedPnl({
      positionSide: 'LONG',
      entryPrice: 100,
      closedQty: 2,
      exitNotional: 110 + 90,
      feeAmount: 0.4,
    });
    expect(pnl).not.toBeNull();
    expect(pnl?.gross).toBeCloseTo(0, 10);
    expect(pnl?.net).toBeCloseTo(-0.4, 10);
  });

  it('已平仓但没拿到出场成交额时：算不出来，不编一个假数', () => {
    // 2026-10-22 实测的线上事故：出场价被当成 0 → 成交额 0 →
    // 「毛利 = (0 − 入场价) × 数量」= −194 USDT 的假亏损。
    // 这里必须返回 null，让调用方说「算不出」。
    const pnl = realizedPnl({
      positionSide: 'LONG',
      entryPrice: 84466,
      closedQty: 0.0023,
      exitNotional: 0,
      feeAmount: 0.15547621,
    });
    expect(pnl).toBeNull();
  });

  it('还没平仓（closedQty=0）时不算盈亏，也不返回 null', () => {
    const pnl = realizedPnl({
      positionSide: 'LONG',
      entryPrice: 100,
      closedQty: 0,
      exitNotional: 0,
      feeAmount: 0.5,
    });
    expect(pnl).not.toBeNull();
    expect(pnl?.gross).toBeCloseTo(0, 10);
    expect(pnl?.net).toBeCloseTo(-0.5, 10);
  });

  it('计价币是稳定币', () => {
    expect(QUOTE_ASSET).toBe('USDT');
  });
});

describe('feeInQuoteAsset', () => {
  it('BNB 计价的手续费按汇率折成计价币', () => {
    // 2026-10-23 目标机上那笔真实的成交：0.00009805 BNB，按 590 折 ≈ 0.0578 USDT。
    const amount = feeInQuoteAsset(0.00009805, 'BNB', 590);
    expect(amount).toBeCloseTo(0.0578495, 10);
  });

  it('折算结果与「当成计价币直接记」差着几百倍——这正是要修的那个 bug', () => {
    const raw = 0.00009805;
    const converted = feeInQuoteAsset(raw, 'BNB', 590);
    // 原代码记的是 raw（当成 USDT），实际值是 converted。
    expect(converted / raw).toBeCloseTo(590, 6);
  });

  it('币种就是计价币时按原价折（汇率传 1）', () => {
    expect(feeInQuoteAsset(0.04, 'USDT', 1)).toBeCloseTo(0.04, 10);
  });

  it('手续费是 0 时折出来还是 0', () => {
    expect(feeInQuoteAsset(0, 'BNB', 590)).toBe(0);
  });

  it('没有币种就报错——宁可报错，也不要默默当成计价币', () => {
    expect(() => feeInQuoteAsset(0.04, '', 590)).toThrow(/币种/);
    expect(() => feeInQuoteAsset(0.04, '   ', 590)).toThrow(/币种/);
  });

  it('金额是负数或非有限数就报错', () => {
    expect(() => feeInQuoteAsset(-1, 'BNB', 590)).toThrow(/非负/);
    expect(() => feeInQuoteAsset(Number.NaN, 'BNB', 590)).toThrow(/非负/);
  });

  it('价格不是正数就报错（0 与负价会把手续费变成 0 或负数）', () => {
    expect(() => feeInQuoteAsset(0.04, 'BNB', 0)).toThrow(/正有限数/);
    expect(() => feeInQuoteAsset(0.04, 'BNB', -1)).toThrow(/正有限数/);
    expect(() => feeInQuoteAsset(0.04, 'BNB', Number.POSITIVE_INFINITY)).toThrow(/正有限数/);
  });
});

describe('feePriceSymbol', () => {
  it('手续费币种拼成取价用的交易对', () => {
    expect(feePriceSymbol('BNB')).toBe('BNBUSDT');
    expect(feePriceSymbol('bnb')).toBe('BNBUSDT');
    expect(feePriceSymbol(' BNB ')).toBe('BNBUSDT');
  });

  it('计价币可以换，但默认是 USDT', () => {
    expect(feePriceSymbol('BNB', 'USDC')).toBe('BNBUSDC');
  });

  it('没有币种就报错', () => {
    expect(() => feePriceSymbol('')).toThrow(/币种/);
  });

  it('币种就是计价币时报错——那种情况根本不需要折算', () => {
    expect(() => feePriceSymbol('USDT')).toThrow(/不需要折算/);
  });
});
