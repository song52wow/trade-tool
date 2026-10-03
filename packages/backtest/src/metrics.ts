import type { EquityPoint } from '@trade-tool/core';

export interface PerformanceMetrics {
  /** 总收益率 */
  totalReturn: number;
  /** 年化收益率（按 bars 频率折算） */
  cagr: number;
  /** 年化波动率 */
  volatility: number;
  /** 无风险利率按 0 计算的夏普 */
  sharpe: number;
  /** 最大回撤，正数表示下跌幅度 */
  maxDrawdown: number;
  /** 胜率（已平仓交易） */
  winRate: number;
  tradeCount: number;
  /** 盈亏比，未平仓或无盈利交易时为 null */
  profitFactor: number | null;
}

export function drawdownSeries(equity: readonly number[]): number[] {
  const out: number[] = [];
  let peak = equity[0] ?? 0;
  for (const value of equity) {
    if (value > peak) peak = value;
    out.push(peak === 0 ? 0 : (peak - value) / peak);
  }
  return out;
}

function stdev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** barsPerYear 由调用方按周期传入，避免包内硬编码周期表。 */
export function computeMetrics(
  points: readonly EquityPoint[],
  barsPerYear: number,
  trades: readonly { pnl: number }[],
): PerformanceMetrics {
  const equity = points.map((p) => p.equity);
  if (equity.length < 2) {
    return {
      totalReturn: 0,
      cagr: 0,
      volatility: 0,
      sharpe: 0,
      maxDrawdown: 0,
      winRate: 0,
      tradeCount: trades.length,
      profitFactor: null,
    };
  }

  const first = equity[0]!;
  const last = equity[equity.length - 1]!;
  const totalReturn = first === 0 ? 0 : last / first - 1;
  const years = (equity.length - 1) / barsPerYear;

  const returns: number[] = [];
  for (let i = 1; i < equity.length; i += 1) {
    const prev = equity[i - 1]!;
    returns.push(prev === 0 ? 0 : equity[i]! / prev - 1);
  }

  const perBarMean = returns.length === 0 ? 0 : returns.reduce((a, b) => a + b, 0) / returns.length;
  const perBarStd = stdev(returns);
  const volatility = perBarStd * Math.sqrt(barsPerYear);
  const sharpe = perBarStd === 0 ? 0 : (perBarMean * barsPerYear) / volatility;
  const cagr = years <= 0 || first <= 0 || last <= 0 ? 0 : (last / first) ** (1 / years) - 1;
  const maxDrawdown = Math.max(0, ...drawdownSeries(equity));

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const grossProfit = wins.reduce((acc, t) => acc + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((acc, t) => acc + t.pnl, 0));

  return {
    totalReturn,
    cagr,
    volatility,
    sharpe,
    maxDrawdown,
    winRate: trades.length === 0 ? 0 : wins.length / trades.length,
    tradeCount: trades.length,
    profitFactor: grossLoss === 0 ? (grossProfit > 0 ? null : 0) : grossProfit / grossLoss,
  };
}
