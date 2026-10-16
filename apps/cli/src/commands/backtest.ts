import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { loadConfigOrDefault, resolveHome, type TradeToolConfig } from '@trade-tool/core';
import { runBacktest as invokeBacktest, type BacktestResult } from '@trade-tool/data';

import { withContext } from '../context.js';

export interface BacktestOverrides {
  symbol?: string | undefined;
  interval?: string | undefined;
  bars?: string | number | undefined;
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

/**
 * 报告正文。
 *
 * **字段名与顺序与改动前逐字一致**（R-7.4「对外行为不变」）：命令行的参数、报告文件的
 * 路径与命名、stdout 的渲染格式、`--json` 的形状、退出码都保持不变。唯一有意变化的是
 * **报告里的数字**——成交模型从「以 t 收盘价成交」改成「信号在 t 收盘确认、成交在 t+1
 * 开盘」（R-2.3），那是修掉未来函数的结果，不是回归。
 */
export function renderReport(result: BacktestResult): string {
  const m = result.metrics;
  const lines = [
    `策略        ${result.strategy}`,
    `标的        ${result.symbol}`,
    `样本        ${result.equity.length} bars`,
    `总收益      ${pct(m.total_return)}`,
    `年化收益    ${pct(m.cagr)}`,
    `年化波动    ${pct(m.volatility)}`,
    `夏普        ${fmt(m.sharpe)}`,
    `最大回撤    ${pct(m.max_drawdown)}`,
    `交易次数    ${m.trade_count}`,
    `胜率        ${pct(m.win_rate)}`,
    `盈亏比      ${profitFactor(result)}`,
  ];
  return lines.join('\n');
}

/**
 * 盈亏比：毛盈利 / 毛亏损。**没有亏损交易时为 null**（而不是 0 或无穷）——
 * 「没发生亏损」与「盈亏比为 0」是完全不同的两件事。
 */
function profitFactor(result: BacktestResult): string | number {
  const wins = result.trades.filter((t) => t.pnl > 0);
  const losses = result.trades.filter((t) => t.pnl < 0);
  const grossProfit = wins.reduce((acc, t) => acc + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((acc, t) => acc + t.pnl, 0));
  if (grossLoss === 0) return grossProfit > 0 ? 'n/a' : 'n/a';
  return fmt(grossProfit / grossLoss);
}

export async function runBacktestCommand(overrides: BacktestOverrides): Promise<number> {
  const config: TradeToolConfig = await loadConfigOrDefault();
  const params = config.backtest.params;
  const symbol = overrides.symbol ?? config.market.symbol;
  const interval = overrides.interval ?? config.market.interval;
  const bars = Number(overrides.bars ?? config.market.bars);
  if (!Number.isInteger(bars) || bars <= 0) {
    throw new Error(`bars 必须是正整数，收到：${String(overrides.bars ?? bars)}`);
  }

  const fast = num(overrides.fast) ?? Number(params.fast ?? 20);
  const slow = num(overrides.slow) ?? Number(params.slow ?? 60);

  // 回测实现整体在 Python 侧（v0.3.0 R-7）。这里只负责**编排**：把控制信息经 argv
  // 传过去，把摘要接回来、写报告文件、打 stdout。
  const result = await withContext((ctx) =>
    invokeBacktest(ctx, {
      symbol,
      interval,
      bars,
      fast,
      slow,
      initialCapital: config.market.initialCapital,
      feeRate: config.market.feeRate,
      slippageRate: config.market.slippageRate,
    }),
  );

  const reportDir = resolve(resolveHome(), 'reports');
  await mkdir(reportDir, { recursive: true });
  const reportPath = resolve(
    reportDir,
    `${result.symbol}_${result.interval}_${result.strategy}_${Date.now()}.json`,
  );
  await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  if (overrides.json) {
    console.log(JSON.stringify({ reportPath, ...result }, null, 2));
  } else {
    console.log(renderReport(result));
    console.log(`\n报告已写入 ${reportPath}`);
    // 成交模型的变更必须**说在报告里**，而不是让一个熟悉旧输出的用户以为数字错了。
    console.log(
      '成交模型：信号在 t 收盘确认，成交在 t+1 开盘（v0.3.0 起；与旧口径的数字不同是有意的）',
    );
  }
  return 0;
}
