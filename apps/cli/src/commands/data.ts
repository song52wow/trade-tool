import { createInterface } from 'node:readline/promises';

import {
  createLogger,
  intervalToMs,
  loadConfigOrDefault,
  ONE_MINUTE_MS,
  SyncError,
  type Bar,
  type Interval,
  type SyncPlanEstimate,
  type SyncRunSummary,
} from '@trade-tool/core';
import {
  backfillRange,
  estimateFirstPull,
  getGaps,
  listExchangeSymbols,
  readBars,
  requireContract,
  syncSymbol,
  verifySymbol,
  watermark,
} from '@trade-tool/data';

import { withContext } from '../context.js';
import { assertSchema } from './db.js';

const log = createLogger('cli:data');
const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

/** 周期 -> 每年 bar 数，供年化指标换算。 */
export function barsPerYear(interval: Interval): number {
  return Math.round(MS_PER_YEAR / intervalToMs(interval));
}

export function summarize(bars: readonly Bar[]): Record<string, unknown> {
  const first = bars[0];
  const last = bars[bars.length - 1];
  const closes = bars.map((b) => b.close);
  return {
    count: bars.length,
    from: first ? new Date(first.time).toISOString() : null,
    to: last ? new Date(last.time).toISOString() : null,
    firstClose: first?.close ?? null,
    lastClose: last?.close ?? null,
    minClose: closes.length ? Math.min(...closes) : null,
    maxClose: closes.length ? Math.max(...closes) : null,
  };
}

/** 命令行 override；`exactOptionalPropertyTypes` 下显式允许 undefined，方便直接透传 commander 的 options。 */
export interface DataOverrides {
  symbol?: string | undefined;
  interval?: string | undefined;
  bars?: string | number | undefined;
  noCache?: boolean | undefined;
  source?: string | undefined;
}

export interface FetchResult {
  bars: Bar[];
  symbol: string;
  interval: Interval;
  source: 'synthetic' | 'binance';
}

/**
 * 解析行情来源。
 *
 * R-14.2 要求 source 显式、无隐式默认：它只能来自 `--source` 或配置里的 `market.source`，
 * 默认值是 `synthetic`（`defaultConfig()` 的既有行为，AC-29 要求不传新参数时行为不变）。
 * 关键在于**不得在 binance 失败时回落到 synthetic**（R-14.1）——那由下面的分支保证。
 */
function resolveSource(overrides: DataOverrides, configSource: 'synthetic' | 'binance') {
  const raw = overrides.source ?? configSource;
  if (raw !== 'synthetic' && raw !== 'binance') {
    throw new SyncError(
      'CONFIG_INVALID',
      `未知的数据来源：${String(overrides.source)}（只能是 synthetic 或 binance）`,
    );
  }
  return raw;
}

/** 把库里读出的行转成既有 Bar 契约，让上层（回测等）无感知。 */
function toBars(
  rows: readonly {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }[],
): Bar[] {
  return rows.map((row) => ({
    time: row.time,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
  }));
}

/**
 * `data fetch --source binance` 的区间。
 *
 * 1m 固定，所以 N 根就是 N 分钟。`to` 取**最后一根已收盘 bar** 的开盘时间——
 * 与「丢弃最后一根」规则同源，从源头就不可能把未收盘 bar 写进库（R-10）。
 */
export function closedBarRange(bars: number, nowMs: number): { from: number; to: number } {
  const lastClosedOpen = Math.floor(nowMs / ONE_MINUTE_MS) * ONE_MINUTE_MS - ONE_MINUTE_MS;
  return { from: lastClosedOpen - (bars - 1) * ONE_MINUTE_MS, to: lastClosedOpen };
}

/** 从 binance 拉取并入库。失败一律抛错，绝不回退到 `generate_series`（R-14.1 / AC-12）。 */
async function fetchFromBinance(
  symbol: string,
  bars: number,
  nowMs?: number,
): Promise<FetchResult> {
  return withContext(async (ctx) => {
    await assertSchema(ctx.pool);
    // 运行时元数据校验：合法性由交易所判定，不做枚举（AC-13 / R-15.1）。
    await requireContract(ctx, symbol);
    const range = closedBarRange(bars, nowMs ?? Date.now());
    await backfillRange(ctx, symbol, range);
    const stored = await readBars(ctx.pool, symbol, {
      from: range.from,
      to: range.to,
      limit: bars + 1,
    });

    // 「拉了 N 根却一根都没有」必须报错而不是安静地返回 count=0：
    // 用户要的是数据，拿到空结果却不给任何提示就是 R-14 说的静默兜底。
    if (stored.length === 0) {
      throw new SyncError(
        'EXCHANGE_ERROR',
        `交易所未返回 ${symbol} 在 ${new Date(range.from).toISOString()} → ${new Date(range.to).toISOString()} 区间内的任何 1m K 线（期望 ${bars} 根）`,
        { symbol, requested: bars, from: range.from, to: range.to },
      );
    }
    if (stored.length < bars) {
      log.warn(`${symbol} 只取到 ${stored.length}/${bars} 根：该区间在交易所侧不完整`);
    }
    return { bars: toBars(stored), symbol, interval: '1m', source: 'binance' };
  });
}

/** 既有离线链路：`generate_series` + 文件缓存。行为与本次改动前完全一致（AC-29）。 */
async function fetchSynthetic(
  symbol: string,
  interval: Interval,
  bars: number,
  noCache: boolean,
): Promise<FetchResult> {
  const { loadBars } = await import('@trade-tool/data');
  const config = await loadConfigOrDefault();
  const series = await loadBars({
    symbol,
    interval,
    bars,
    runtime: config.data.python,
    timeoutMs: config.data.timeoutMs,
    cacheDir: config.data.cacheDir,
    useCache: !noCache,
  });
  return { bars: series, symbol, interval, source: 'synthetic' };
}

/** 统一的数据拉取入口：配置在 config.json，命令行的 override 优先。 */
export async function fetchBars(overrides: DataOverrides): Promise<FetchResult> {
  const config = await loadConfigOrDefault();
  const symbol = overrides.symbol ?? config.market.symbol;
  const source = resolveSource(overrides, config.market.source);
  const bars = Number(overrides.bars ?? config.market.bars);

  if (!Number.isInteger(bars) || bars <= 0) {
    throw new Error(`bars 必须是正整数，收到：${String(overrides.bars ?? bars)}`);
  }

  if (source === 'binance') {
    // 1m 固定，不接受 interval——周期约束体现在 schema 表名上（R-6）。
    return fetchFromBinance(symbol, bars);
  }
  const interval = (overrides.interval ?? config.market.interval) as Interval;
  return fetchSynthetic(symbol, interval, bars, overrides.noCache ?? false);
}

// ------------------------------------------------------------ 同步相关命令

export interface SyncFlags {
  symbol?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  json?: boolean | undefined;
  yes?: boolean | undefined;
  bars?: string | undefined;
}

function parseMs(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new SyncError('CONFIG_INVALID', `${flag} 必须是 epoch 毫秒的非负整数，收到：${value}`);
  }
  return n;
}

function requireSymbol(symbol: string | undefined): string {
  if (!symbol)
    throw new SyncError(
      'CONFIG_INVALID',
      '必须通过 --symbol 指定标的（不做枚举校验，合法性由运行时元数据判定）',
    );
  return symbol;
}

/**
 * 首次全量前的规模提示与显式确认（R-8.3）。
 * CLI 是「点一下就完」的重灾区：全量是数百次请求量级，所以必须先算给人看并要求确认。
 */
async function confirmFirstPull(
  symbol: string,
  options: { yes?: boolean | undefined; json?: boolean | undefined },
): Promise<SyncPlanEstimate | undefined> {
  const estimate = await withContext((ctx) => estimateFirstPull(ctx, symbol));
  if (options.json) return estimate;
  console.error(
    [
      `标的 ${symbol} 尚无历史数据，本次将执行**首次全量**（无「缩短范围」选项）：`,
      `  区间      ${new Date(estimate.from).toISOString()} → ${new Date(estimate.to).toISOString()}`,
      `  约 ${estimate.bars.toLocaleString('en-US')} 根 1m K 线`,
      `  约 ${estimate.requests.toLocaleString('en-US')} 次请求（权重约 ${estimate.weight.toLocaleString('en-US')}）`,
      `  预计耗时 约 ${Math.max(1, Math.round(estimate.estimatedMs / 60_000))} 分钟`,
    ].join('\n'),
  );
  if (options.yes) return estimate;

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question('确认执行首次全量？输入 yes 继续：');
    if (answer.trim().toLowerCase() !== 'yes') {
      throw new SyncError('CONFIG_INVALID', '用户取消了首次全量', { symbol });
    }
  } finally {
    rl.close();
  }
  return estimate;
}

function printRun(summary: SyncRunSummary, json: boolean | undefined): void {
  if (json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(
    JSON.stringify(
      {
        symbol: summary.symbol,
        added: summary.added,
        from: summary.from === null ? null : new Date(summary.from).toISOString(),
        to: summary.to === null ? null : new Date(summary.to).toISOString(),
        writeStrategy: summary.writeStrategy,
        watermark: summary.watermark,
        gapsFilled: summary.gapsFilled,
        gapsPending: summary.gapsPending,
        requests: summary.requests,
        weight: summary.weight,
        metadataStale: summary.metadataStale,
      },
      null,
      2,
    ),
  );
}

/**
 * `data sync` —— 增量续传，本期主入口（R-15）。
 * 不传 `--from` 是增量语义；传了且早于 max(time) 则退化为区间补数（DO NOTHING）。
 */
export async function runSync(flags: SyncFlags): Promise<number> {
  const symbol = requireSymbol(flags.symbol);
  const from = parseMs(flags.from, '--from');
  const to = parseMs(flags.to, '--to');

  return withContext(async (ctx) => {
    await assertSchema(ctx.pool);
    const before = await watermark(ctx.pool, symbol);

    if (from === undefined && before.maxTime === null) {
      await confirmFirstPull(symbol, flags);
    }

    const summary = await syncSymbol(ctx, symbol, { from, to });
    printRun(summary, flags.json);
    return 0;
  });
}

/** `data backfill` —— 显式区间回补，永远 DO NOTHING，重复执行行数不变（AC-5）。 */
export async function runBackfill(flags: SyncFlags): Promise<number> {
  const symbol = requireSymbol(flags.symbol);
  const from = parseMs(flags.from, '--from');
  const to = parseMs(flags.to, '--to');
  if (from === undefined || to === undefined) {
    throw new SyncError(
      'CONFIG_INVALID',
      'data backfill 必须同时提供 --from 与 --to（毫秒时间戳）',
    );
  }
  if (to < from) throw new SyncError('CONFIG_INVALID', `--to（${to}）不能早于 --from（${from}）`);

  return withContext(async (ctx) => {
    await assertSchema(ctx.pool);
    const summary = await backfillRange(ctx, symbol, { from, to });
    printRun(summary, flags.json);
    return 0;
  });
}

/** `data verify` —— 全表缺口扫描，重建 verified_upto 基线（R-11.A3 ②）。 */
export async function runVerify(flags: SyncFlags): Promise<number> {
  const symbol = requireSymbol(flags.symbol);
  return withContext(async (ctx) => {
    await assertSchema(ctx.pool);
    const result = await verifySymbol(ctx, symbol);
    console.log(JSON.stringify(result, null, 2));
    return 0;
  });
}

/** `data gaps` —— 待回补缺口清单与缺失总行数，缺口不得静默存在（R-11.11）。 */
export async function runGaps(flags: SyncFlags): Promise<number> {
  return withContext(async (ctx) => {
    await assertSchema(ctx.pool);
    const gaps = await getGaps(ctx, flags.symbol);
    const missing = gaps.reduce((sum, gap) => sum + gap.missingRows, 0);
    if (flags.json) {
      console.log(JSON.stringify({ gaps, count: gaps.length, missingRows: missing }, null, 2));
      return 0;
    }
    if (gaps.length === 0) {
      console.log('无待回补缺口。');
      return 0;
    }
    for (const gap of gaps) {
      console.log(
        `${gap.symbol}  ${new Date(gap.gapStart).toISOString()} → ${new Date(gap.gapEnd).toISOString()}  ` +
          `缺 ${gap.missingRows} 根  尝试 ${gap.attempts} 次${gap.lastError ? `  最后错误：${gap.lastError}` : ''}`,
      );
    }
    console.log(`合计 ${gaps.length} 个缺口，缺失 ${missing} 行。`);
    return 0;
  });
}

/** `data symbols` —— 运行时发现可用标的，纯 JSON 数组（AC-14）。 */
export async function runSymbols(flags: {
  source?: string | undefined;
  json?: boolean | undefined;
  refresh?: boolean | undefined;
}): Promise<number> {
  const source = flags.source ?? 'binance';
  if (source !== 'binance') {
    throw new SyncError(
      'CONFIG_INVALID',
      `data symbols 只支持 --source binance（合成源没有真实标的集合），收到：${source}`,
    );
  }
  return withContext(async (ctx) => {
    const result = await listExchangeSymbols(ctx, { refresh: flags.refresh ?? false });
    if (flags.json) {
      console.log(JSON.stringify(result.symbols.map((s) => s.symbol)));
      return 0;
    }
    for (const spec of result.symbols) {
      console.log(
        `${spec.symbol}\t${spec.contractType}\t${spec.status}\t${new Date(spec.onboardDate).toISOString()}`,
      );
    }
    console.error(`共 ${result.count} 个标的${result.stale ? '（元数据来自过期缓存）' : ''}`);
    return 0;
  });
}
