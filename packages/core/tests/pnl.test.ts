/**
 * 盈亏口径（v0.8.0）。
 *
 * 重点是三件事：
 *   * 多空的方向别搞反（搞反了「赚」会显示成「亏」）；
 *   * 手续费**从毛利里扣**，而且是**整轮**的手续费（入场那笔也算）；
 *   * 分批的两段出场不能被揉成一个均价（`exitNotional` 是累计成交额）。
 */

import { describe, expect, it } from 'vitest';

import { estimateBracketPnl, realizedPnl, QUOTE_ASSET } from '../src/pnl.js';

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
    expect(pnl.gross).toBeCloseTo(20, 10);
    expect(pnl.fee).toBeCloseTo(1.5, 10);
    expect(pnl.net).toBeCloseTo(18.5, 10);
  });

  it('空头：卖出价高于买回价才是赚', () => {
    const pnl = realizedPnl({
      positionSide: 'SHORT',
      entryPrice: 100,
      closedQty: 2,
      exitNotional: 180,
      feeAmount: 1,
    });
    expect(pnl.gross).toBeCloseTo(20, 10);
    expect(pnl.net).toBeCloseTo(19, 10);
  });

  it('亏的时候净盈亏是负的，而且手续费让它更亏', () => {
    const pnl = realizedPnl({
      positionSide: 'LONG',
      entryPrice: 100,
      closedQty: 2,
      exitNotional: 180,
      feeAmount: 1,
    });
    expect(pnl.gross).toBeCloseTo(-20, 10);
    expect(pnl.net).toBeCloseTo(-21, 10);
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
    expect(pnl.gross).toBeCloseTo(0, 10);
    expect(pnl.net).toBeCloseTo(-0.4, 10);
  });

  it('计价币是稳定币', () => {
    expect(QUOTE_ASSET).toBe('USDT');
  });
});
