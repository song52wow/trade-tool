import {
  createLogger,
  type Bar,
  type EquityPoint,
  type Strategy,
  type Trade,
} from '@trade-tool/core';

import { computeMetrics, type PerformanceMetrics } from './metrics.js';

const log = createLogger('backtest:engine');

export interface BacktestOptions {
  symbol: string;
  strategy: Strategy;
  bars: readonly Bar[];
  initialCapital: number;
  feeRate: number;
  slippageRate: number;
  /** 每年 bar 数，用于年化指标换算 */
  barsPerYear: number;
}

export interface BacktestResult {
  symbol: string;
  strategy: string;
  equity: EquityPoint[];
  trades: Trade[];
  metrics: PerformanceMetrics;
}

/**
 * 单标的、单持仓的向量化回测循环。
 * 成交假设：信号在当根 bar 收盘确认，成交价 = 收盘价 × (1 ± 滑点)，并扣双边手续费。
 */
export function runBacktest(options: BacktestOptions): BacktestResult {
  const { strategy, bars, initialCapital, feeRate, slippageRate } = options;
  if (bars.length === 0) throw new Error('bars 为空，无法回测');

  let cash = initialCapital;
  let qty = 0;
  let entryPrice = 0;
  let entryTime = 0;
  const trades: Trade[] = [];
  const equity: EquityPoint[] = [];
  let peak = initialCapital;

  const buyFill = (price: number) => price * (1 + slippageRate);
  const sellFill = (price: number) => price * (1 - slippageRate);

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i]!;
    const signal = strategy.onBar(bar, bars.slice(0, i + 1));

    if (signal?.side === 'long' && qty === 0 && cash > 0) {
      const fill = buyFill(bar.close);
      const quantity = cash / fill;
      const fee = quantity * fill * feeRate;
      if (fee < cash) {
        cash -= quantity * fill + fee;
        qty = quantity;
        entryPrice = fill;
        entryTime = bar.time;
        log.debug(`open long @${fill.toFixed(2)} qty=${quantity.toFixed(6)}`);
      }
    } else if (signal?.side === 'short' && qty > 0) {
      const fill = sellFill(bar.close);
      const fee = qty * fill * feeRate;
      const proceeds = qty * fill - fee;
      trades.push({
        entryTime,
        exitTime: bar.time,
        entryPrice,
        exitPrice: fill,
        quantity: qty,
        pnl: proceeds - qty * entryPrice,
        reason: signal.reason,
      });
      cash += proceeds;
      qty = 0;
    }

    const equityValue = cash + qty * bar.close;
    if (equityValue > peak) peak = equityValue;
    equity.push({
      time: bar.time,
      equity: equityValue,
      drawdown: peak === 0 ? 0 : (peak - equityValue) / peak,
    });
  }

  if (qty > 0) {
    const last = bars[bars.length - 1]!;
    const fill = sellFill(last.close);
    trades.push({
      entryTime,
      exitTime: last.time,
      entryPrice,
      exitPrice: fill,
      quantity: qty,
      pnl: qty * (fill - entryPrice),
      reason: 'forced-close',
    });
  }

  return {
    symbol: options.symbol,
    strategy: strategy.name,
    equity,
    trades,
    metrics: computeMetrics(equity, options.barsPerYear, trades),
  };
}
