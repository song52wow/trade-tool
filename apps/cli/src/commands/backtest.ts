import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { MaCrossStrategy, runBacktest } from '@trade-tool/backtest';
import { loadConfigOrDefault, resolveHome, type TradeToolConfig } from '@trade-tool/core';

import { barsPerYear, fetchBars, type DataOverrides } from './data.js';

export interface BacktestOverrides extends DataOverrides {
  fast?: string | undefined;
  slow?: string | undefined;
  json?: boolean | undefined;
}

function num(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`无法解析为数字：${value}`);
  return parsed;
}

function fmt(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

function pct(value: number): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : 'n/a';
}

export function renderReport(result: ReturnType<typeof runBacktest>): string {
  const m = result.metrics;
  const lines = [
    `策略        ${result.strategy}`,
    `标的        ${result.symbol}`,
    `样本        ${result.equity.length} bars`,
    `总收益      ${pct(m.totalReturn)}`,
    `年化收益    ${pct(m.cagr)}`,
    `年化波动    ${pct(m.volatility)}`,
    `夏普        ${fmt(m.sharpe)}`,
    `最大回撤    ${pct(m.maxDrawdown)}`,
    `交易次数    ${m.tradeCount}`,
    `胜率        ${pct(m.winRate)}`,
    `盈亏比      ${m.profitFactor === null ? 'n/a' : fmt(m.profitFactor)}`,
  ];
  return lines.join('\n');
}

export async function runBacktestCommand(overrides: BacktestOverrides): Promise<number> {
  const config: TradeToolConfig = await loadConfigOrDefault();
  const { bars, symbol, interval } = await fetchBars(overrides);
  const params = config.backtest.params;

  const fast = num(overrides.fast) ?? Number(params.fast ?? 20);
  const slow = num(overrides.slow) ?? Number(params.slow ?? 60);
  const strategy = new MaCrossStrategy(interval, { fast, slow });

  const result = runBacktest({
    symbol,
    strategy,
    bars,
    initialCapital: config.market.initialCapital,
    feeRate: config.market.feeRate,
    slippageRate: config.market.slippageRate,
    barsPerYear: barsPerYear(interval),
  });

  const reportDir = resolve(resolveHome(), 'reports');
  await mkdir(reportDir, { recursive: true });
  const reportPath = resolve(
    reportDir,
    `${result.symbol}_${interval}_${strategy.name}_${Date.now()}.json`,
  );
  await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  if (overrides.json) {
    console.log(JSON.stringify({ reportPath, ...result }, null, 2));
  } else {
    console.log(renderReport(result));
    console.log(`\n报告已写入 ${reportPath}`);
  }
  return 0;
}
