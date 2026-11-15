/**
 * CLI 的纯函数用例。
 *
 * 这些函数决定「命令行看到什么」：区间算错一格就会多拉/少拉一根 bar，
 * 汇总算错就让 `data fetch` 的摘要与库里的数据对不上，报告渲染错了则
 * 让人对着错误的夏普做决策。它们都不碰 IO，因此可以脱离 PG 直接断言。
 *
 * （AGENTS §8.3 曾写着「apps.cli 没有测试设施」——2026-11-12 已补上。）
 */

import type { BacktestResult } from '@trade-tool/data';
import { describe, expect, it } from 'vitest';

import { renderReport } from '../src/commands/backtest.js';
import { barsPerYear, closedBarRange, summarize } from '../src/commands/data.js';

const MINUTE = 60_000;

describe('barsPerYear', () => {
  it('四个已实现周期的年化根数', () => {
    expect(barsPerYear('15m')).toBe(35_040);
    expect(barsPerYear('1h')).toBe(8_760);
    expect(barsPerYear('4h')).toBe(2_190);
    expect(barsPerYear('1d')).toBe(365);
  });
});

describe('closedBarRange', () => {
  const NOW = 1_760_000_012_345; // 故意带秒与毫秒：区间必须对齐到整分钟

  it('最后一根是「上一个整分钟」，不是当前这根（未收盘）', () => {
    const { to } = closedBarRange(1, NOW);
    expect(to).toBe(Math.floor(NOW / MINUTE) * MINUTE - MINUTE);
    expect(to).toBeLessThan(NOW);
    expect(to % MINUTE).toBe(0);
  });

  it('N 根是连续 N 分钟的闭区间（根数 = (to-from)/1m + 1）', () => {
    const { from, to } = closedBarRange(5, NOW);
    expect((to - from) / MINUTE + 1).toBe(5);
  });

  it('恰好落在整分钟边界时也一样：不多算当前这根', () => {
    const exact = 1_760_000_040_000; // 整分钟
    const { to } = closedBarRange(1, exact);
    expect(to).toBe(exact - MINUTE);
  });
});

describe('summarize', () => {
  it('空序列：计数 0、首尾为 null（不是 0 冒充）', () => {
    expect(summarize([])).toEqual({
      count: 0,
      from: null,
      to: null,
      firstClose: null,
      lastClose: null,
      minClose: null,
      maxClose: null,
    });
  });

  it('统计首尾收盘与极值', () => {
    const bars = [
      { time: 1_000, open: 1, high: 3, low: 0.5, close: 2, volume: 10 },
      { time: 2_000, open: 2, high: 9, low: 1.5, close: 4, volume: 20 },
      { time: 3_000, open: 4, high: 5, low: 3, close: 1, volume: 30 },
    ];
    const out = summarize(bars);
    expect(out['count']).toBe(3);
    expect(out['firstClose']).toBe(2);
    expect(out['lastClose']).toBe(1);
    expect(out['minClose']).toBe(1);
    expect(out['maxClose']).toBe(4);
    expect(out['from']).toBe(new Date(1_000).toISOString());
    expect(out['to']).toBe(new Date(3_000).toISOString());
  });
});

describe('renderReport', () => {
  function result(overrides: Partial<BacktestResult> = {}): BacktestResult {
    return {
      symbol: 'BTCUSDT',
      interval: '1h',
      intervalMs: 3_600_000,
      bars: 500,
      strategy: 'ma-cross',
      params: { fast: 20, slow: 60 },
      fills: { model: 'signal-at-close-t-fill-at-open-t+1' },
      equity: Array.from({ length: 500 }, (_, i) => ({ time: i, equity: 10_000, drawdown: 0 })),
      trades: [
        {
          entryTime: 1,
          exitTime: 2,
          entryPrice: 100,
          exitPrice: 110,
          quantity: 1,
          pnl: 10,
          reason: 'ma-cross',
        },
        {
          entryTime: 3,
          exitTime: 4,
          entryPrice: 100,
          exitPrice: 95,
          quantity: 1,
          pnl: -5,
          reason: 'ma-cross',
        },
      ],
      metrics: {
        total_return: 0.05,
        cagr: 0.1,
        volatility: 0.2,
        sharpe: 1.5,
        max_drawdown: 0.08,
        trade_count: 2,
        win_rate: 0.5,
      },
      ...overrides,
    };
  }

  it('逐项渲染指标，盈亏比按「毛盈利 / 毛亏损」算', () => {
    const text = renderReport(result());
    expect(text).toContain('标的        BTCUSDT');
    expect(text).toContain('样本        500 bars');
    expect(text).toContain('总收益      5.00%');
    expect(text).toContain('夏普        1.50');
    expect(text).toContain('最大回撤    8.00%');
    expect(text).toContain('胜率        50.00%');
    expect(text).toContain('盈亏比      2.00'); // 10 / 5
  });

  it('没有亏损交易时盈亏比是 n/a，不是 0/Infinity', () => {
    const text = renderReport(
      result({
        trades: [
          {
            entryTime: 1,
            exitTime: 2,
            entryPrice: 100,
            exitPrice: 110,
            quantity: 1,
            pnl: 10,
            reason: 'ma-cross',
          },
        ],
      }),
    );
    expect(text).toContain('盈亏比      n/a');
  });

  it('指标是 NaN 时渲染成 n/a，而不是 "NaN"', () => {
    const text = renderReport(
      result({
        metrics: {
          total_return: Number.NaN,
          cagr: Number.NaN,
          volatility: Number.NaN,
          sharpe: Number.NaN,
          max_drawdown: Number.NaN,
          trade_count: 0,
          win_rate: Number.NaN,
        },
      }),
    );
    expect(text).not.toContain('NaN');
    expect(text).toContain('夏普        n/a');
  });
});
