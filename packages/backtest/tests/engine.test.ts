import { describe, expect, it } from 'vitest';

import { computeMetrics, drawdownSeries } from '../src/metrics.js';
import { runBacktest } from '../src/engine.js';
import { MaCrossStrategy } from '../src/strategies/ma-cross.js';

const equity = [100, 110, 90, 120].map((equityValue, i) => ({
  time: i,
  equity: equityValue,
  drawdown: 0,
}));

describe('drawdownSeries', () => {
  it('跟踪历史峰值', () => {
    expect(drawdownSeries([100, 110, 90, 120]).map((d) => Number(d.toFixed(4)))).toEqual([
      0, 0, 0.1818, 0,
    ]);
  });
});

describe('computeMetrics', () => {
  it('样本不足时返回零值而不是 NaN', () => {
    const m = computeMetrics([{ time: 0, equity: 100, drawdown: 0 }], 252, []);
    expect(m.totalReturn).toBe(0);
    expect(Number.isNaN(m.sharpe)).toBe(false);
  });

  it('总收益率与最大回撤正确', () => {
    const m = computeMetrics(equity, 4, [{ pnl: 10 }, { pnl: -5 }]);
    expect(m.totalReturn).toBeCloseTo(0.2, 6);
    expect(m.maxDrawdown).toBeCloseTo(0.181818, 5);
    expect(m.winRate).toBe(0.5);
    expect(m.tradeCount).toBe(2);
    expect(m.profitFactor).toBeCloseTo(2, 6);
  });
});

describe('runBacktest', () => {
  it('空 bars 直接报错', () => {
    const strategy = new MaCrossStrategy('1h', { fast: 2, slow: 3 });
    expect(() =>
      runBacktest({
        symbol: 'BTCUSDT',
        strategy,
        bars: [],
        initialCapital: 1000,
        feeRate: 0,
        slippageRate: 0,
        barsPerYear: 8760,
      }),
    ).toThrow(/bars 为空/);
  });

  it('强制平仓后不留持仓，净值不出现 NaN', () => {
    // 单调上涨序列会触发一次金叉，末尾由引擎强制平仓
    const bars = Array.from({ length: 30 }, (_, i) => ({
      time: i,
      open: 100 + i,
      high: 101 + i,
      low: 99 + i,
      close: 100 + i,
      volume: 1,
    }));
    const strategy = new MaCrossStrategy('1h', { fast: 2, slow: 5 });
    const result = runBacktest({
      symbol: 'TEST',
      strategy,
      bars,
      initialCapital: 1000,
      feeRate: 0.0005,
      slippageRate: 0,
      barsPerYear: 8760,
    });
    expect(result.equity).toHaveLength(bars.length);
    expect(result.equity.every((p) => Number.isFinite(p.equity))).toBe(true);
    expect(result.trades.every((t) => Number.isFinite(t.pnl))).toBe(true);
  });

  it('fast 必须小于 slow', () => {
    expect(() => new MaCrossStrategy('1h', { fast: 10, slow: 5 })).toThrow(RangeError);
  });
});
