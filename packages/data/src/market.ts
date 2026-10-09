import { resolve } from 'node:path';

import {
  resolveHome,
  SyncError,
  type AggregateSummary,
  type ContractSpec,
  type DataConfig,
  type RateLimitStatus,
  type SyncPlanEstimate,
  type SyncRunSummary,
  type SyncSummary,
  type SymbolEntry,
  type SymbolSyncState,
  type TradeToolConfig,
} from '@trade-tool/core';

import { runPython, type PythonRuntime } from './bridge.js';
import * as repo from './db/repo.js';
import { buildDsn, connectionOptions, type ConnectionOptions, type Pool } from './db/pool.js';

/**
 * 行情同步的中枢 API（R-2）。
 *
 * 这个模块是**控制面唯一需要认识的东西**：它把「调 Python 干活」和「查 PG 看状态」
 * 收敛成结构化的输入输出，因此 `apps/sync` 不需要知道 PG schema、
 * 回补队列或退避策略的任何内部细节（R-22.5）。
 *
 * 桥接只传控制信息：命令、参数、执行结果摘要。**K 线数据不经 stdout**（R-2.1）。
 */

export interface MarketContext {
  pool: Pool;
  config: TradeToolConfig;
  /** 传给 Python 的 libpq 连接串（经环境变量注入，不进 argv） */
  dsn: string;
  exchange: string;
  runtime: PythonRuntime;
  /** 覆盖默认连接参数（测试用临时 schema） */
  connectionOverrides?: Partial<ConnectionOptions>;
}

export function buildContext(
  pool: Pool,
  config: TradeToolConfig,
  options: { exchange?: string; overrides?: Partial<ConnectionOptions> } = {},
): MarketContext {
  const overrides = options.overrides;
  // 密码只从环境变量解析（connectionOptions 内部会做，缺失即抛 CONFIG_INVALID），
  // 因此 DSN 只能在这里生成，绝不能在别处手拼而绕过这个校验。
  const dsn = buildDsn(connectionOptions(config.database, overrides ?? {}));
  return {
    pool,
    config,
    dsn,
    exchange: options.exchange ?? config.market.exchange,
    runtime: config.data.python,
    ...(overrides ? { connectionOverrides: overrides } : {}),
  };
}

/** metaDir 相对 TRADE_TOOL_HOME 解析，与 cacheDir/rawDir 的约定一致。 */
function metaDir(config: TradeToolConfig): string {
  return resolve(resolveHome(), config.data.metaDir);
}

/** Python 子进程默认比普通调用更久：首次全量要拉数百页。 */
function syncTimeout(data: DataConfig): number {
  return Math.max(data.timeoutMs, 15 * 60_000);
}

function baseArgs(ctx: MarketContext): string[] {
  return ['--exchange', ctx.exchange];
}

interface InvokeOptions {
  data?: DataConfig;
  args: readonly string[];
  /** 是否需要把 PG DSN 注入环境（不需要的命令不注入，减少暴露面） */
  withDsn?: boolean;
}

async function invoke<T>(ctx: MarketContext, options: InvokeOptions): Promise<T> {
  const data = options.data ?? ctx.config.data;
  const { value } = await runPython<T>({
    runtime: ctx.runtime,
    module: 'quant_data',
    args: options.args,
    timeoutMs: syncTimeout(data),
    env: options.withDsn ? { TRADE_TOOL_PG_DSN: ctx.dsn } : {},
  });
  return value;
}

function metadataArgs(ctx: MarketContext): string[] {
  const data = ctx.config.data;
  return [
    '--meta-dir',
    metaDir(ctx.config),
    '--ttl-ms',
    String(data.metadataTtlMs),
    ...(data.allowStaleMetadata ? ['--allow-stale'] : []),
  ];
}

// -------------------------------------------------------------- 技术指标（v0.3.0）

/**
 * 把配置里的指标设置编成 argv。
 *
 * 参数集**始终**显式下发（不是「缺省由 Python 决定」）：CLI 与 Python 两侧各有一份
 * 缺省值时，改了一边就会出现「配置里没写的那个参数集在两边跑出不同的行集」。
 * 显式下发让 Python 侧成为纯粹的执行者，配置的唯一真相在 TS 侧的配置 schema。
 *
 * `{}` 下发成**空串**：那是「显式关闭指标层」（R-12.2），与「没配置」不同。
 */
function indicatorArgs(ctx: MarketContext): string[] {
  const data = ctx.config.data;
  return [
    '--indicator-intervals',
    data.indicatorIntervals.join(','),
    '--indicator-specs',
    JSON.stringify(data.indicatorSpecs),
  ];
}

export interface IndicatorOptions {
  /** 显式给出时以命令行为准；缺省取 `data.indicatorIntervals` */
  intervals?: readonly string[] | undefined;
  /** 显式给出时以命令行为准；缺省取 `data.indicatorSpecs` */
  specs?: unknown;
  from?: number | undefined;
  to?: number | undefined;
}

/** 单个「周期 × 参数集」的物化统计（跨语言契约：与 Python 侧 `IndicatorStat.to_dict` 逐字段一致）。 */
export interface IndicatorIntervalStats {
  indicator: string;
  params: Record<string, number | string>;
  /** 真正**改动**的行数；重复执行必然为 0 */
  upserted: number;
  /** 因**预热期**不落库的行数 */
  withheldWarmup: number;
  skipped?: string;
}

/** `data indicators` 的结果摘要。**不许只报「成功」**（R-6.6）。 */
export interface IndicatorSummary {
  symbol: string;
  from: number | null;
  to: number | null;
  rebuild: boolean;
  check: boolean;
  /** `{ interval: { 'MA(window=20)': {...} } }`，键序固定 */
  indicators: Record<string, Record<string, IndicatorIntervalStats>>;
  implVersion: number;
  durationMs: number;
}

/**
 * 指标补齐 / `--rebuild` / `--check`（v0.3.0 R-6）。
 *
 * **不进交易所、不改 `sync_state`**：只读派生 K 线、只写指标表。单写者锁与
 * `SymbolLock` 同键（Python 侧抢），因此这里不需要额外加锁。
 */
export async function indicatorSymbol(
  ctx: MarketContext,
  symbol: string,
  options: IndicatorOptions = {},
  mode: { rebuild?: boolean; check?: boolean } = {},
): Promise<IndicatorSummary> {
  const { assertSchemaVersion } = await import('./db/migrate.js');
  await assertSchemaVersion(ctx.pool);
  const data = ctx.config.data;
  return invoke<IndicatorSummary>(ctx, {
    args: [
      'indicators',
      ...baseArgs(ctx),
      '--symbol',
      symbol,
      '--intervals',
      (options.intervals ?? data.indicatorIntervals).join(','),
      // 命令行没显式给 specs 时下发**配置里的缺省**，因此两边永远看到同一份。
      '--indicator-specs',
      JSON.stringify(options.specs ?? data.indicatorSpecs),
      '--indicator-batch-bars',
      String(data.indicatorBatchBars),
      ...(options.from === undefined ? [] : ['--from', String(options.from)]),
      ...(options.to === undefined ? [] : ['--to', String(options.to)]),
      ...(mode.rebuild ? ['--rebuild'] : []),
      ...(mode.check ? ['--check'] : []),
    ],
    withDsn: true,
  });
}

// ------------------------------------------------------------------ 回测（v0.3.0）

export interface BacktestResult {
  symbol: string;
  interval: string;
  intervalMs: number;
  bars: number;
  strategy: string;
  params: Record<string, number>;
  /** 成交模型标识：``signal-at-close-t-fill-at-open-t+1``（R-2.3） */
  fills: { model: string };
  equity: Array<{ time: number; equity: number; drawdown: number }>;
  trades: Array<{
    entryTime: number;
    exitTime: number;
    entryPrice: number;
    exitPrice: number;
    quantity: number;
    pnl: number;
    reason: string;
  }>;
  metrics: {
    total_return: number;
    cagr: number;
    volatility: number;
    sharpe: number;
    max_drawdown: number;
    trade_count: number;
    win_rate: number;
  };
}

export interface BacktestRequest {
  symbol: string;
  interval: string;
  bars: number;
  fast: number;
  slow: number;
  initialCapital: number;
  feeRate: number;
  slippageRate: number;
}

/**
 * 跑一次回测并返回结果（v0.3.0 R-7.4）。
 *
 * 回测实现整体迁到 Python，**TS 侧不再有任何指标与引擎代码**——两侧各有一份 `sma`
 * 就会在浮点舍入上分叉，而症状是「回测赚钱、实盘不赚」且几乎无法定位（R-1）。
 *
 * 合成数据路径在 Python 进程内生成并消费，K 线不经 stdout（R-7.2）。
 */
export async function runBacktest(
  ctx: MarketContext,
  request: BacktestRequest,
): Promise<BacktestResult> {
  return invoke<BacktestResult>(ctx, {
    // 回测不需要 PG：不注入 DSN，进一步缩小凭证暴露面。
    withDsn: false,
    args: [
      'backtest',
      '--symbol',
      request.symbol,
      '--interval',
      request.interval,
      '--bars',
      String(request.bars),
      '--fast',
      String(request.fast),
      '--slow',
      String(request.slow),
      '--initial-capital',
      String(request.initialCapital),
      '--fee-rate',
      String(request.feeRate),
      '--slippage-rate',
      String(request.slippageRate),
    ],
  });
}

// ------------------------------------------------------------------ 元数据

export interface ExchangeSymbol extends ContractSpec {
  cachedAt: number;
  ageMs: number;
  stale: boolean;
}

export interface ListSymbolsResult {
  exchange: string;
  count: number;
  cachedAt: number;
  ageMs: number;
  stale: boolean;
  symbols: ContractSpec[];
}

/** 运行时发现全部可同步标的（AC-14）。集合是动态的，绝不内置白名单（R-5.4）。 */
export async function listExchangeSymbols(
  ctx: MarketContext,
  options: { refresh?: boolean } = {},
): Promise<ListSymbolsResult> {
  return invoke<ListSymbolsResult>(ctx, {
    // exchangeInfo 也是出网请求，必须经过同一个全局限速器（R-20.2）。
    // 不注入 DSN 时 Python 侧拿不到配额桶，`symbols` / `resolve` 会绕开限速器直连交易所。
    withDsn: true,
    args: [
      'symbols',
      ...baseArgs(ctx),
      ...metadataArgs(ctx),
      ...(options.refresh ? ['--refresh'] : []),
    ],
  });
}

/** 精确匹配 + 校验标的（R-7.2）。失败抛带错误码的 SyncError。 */
export async function resolveContract(ctx: MarketContext, symbol: string): Promise<ExchangeSymbol> {
  return invoke<ExchangeSymbol>(ctx, {
    // addSymbol 的元数据校验走的就是这里，同样要过限速器（R-20.2）。
    withDsn: true,
    args: ['resolve', ...baseArgs(ctx), '--symbol', symbol, ...metadataArgs(ctx)],
  });
}

/** 首次全量的规模预估（R-8.3）。执行前先算给人看，不给「缩短范围」的选项。 */
export async function estimateFirstPull(
  ctx: MarketContext,
  symbol: string,
  options: { nowMs?: number } = {},
): Promise<SyncPlanEstimate> {
  return invoke<SyncPlanEstimate>(ctx, {
    // 刻意**不注入** DSN：R-8.3 要求规模预估不需要数据库，
    // 这样在还没有迁移过的库上也能先算给人看。代价是这一次 exchangeInfo 不经限速器，
    // 但它有进程内单例 + 1 小时 TTL，暴露面可以忽略。
    args: [
      'estimate',
      ...baseArgs(ctx),
      '--symbol',
      symbol,
      ...metadataArgs(ctx),
      '--weight-budget',
      String(ctx.config.sync.weightBudgetPerMinute),
      ...(options.nowMs === undefined ? [] : ['--now-ms', String(options.nowMs)]),
    ],
  });
}

// ------------------------------------------------------------------ 同步

export interface SyncOptions {
  /** 显式起点。缺省为增量语义（起点 = max(time)，UPSERT） */
  from?: number | undefined;
  to?: number | undefined;
  nowMs?: number | undefined;
  maxGapAttempts?: number | undefined;
  batchSize?: number | undefined;
  /**
   * 本轮是否回补**已登记的缺口**（R-11.B6）；false 时只检测与登记，不尝试修复。
   *
   * 刻意不叫「允许首次全量」：首次全量由「库里有没有历史」决定，没有开关（R-8.2），
   * 拦住回补风暴的闸门是新增标的默认 `paused`（R-8.4）。这个按调用粒度的开关只服务
   * 「先只登记缺口、留到下一轮再修」的场景（测试用它把「检测到」与「补得上」拆开断言）。
   */
  allowBackfill?: boolean | undefined;
  /**
   * 覆盖派生周期集合；缺省取 `data.aggregateIntervals`。
   * 传 `[]` 是**显式关闭派生**（R-9.2 / AC-22），不是「这次不算」——状态里会如实
   * 显示「未启用派生」。
   */
  aggregateIntervals?: readonly string[] | undefined;
}

function syncArgs(ctx: MarketContext, symbol: string, options: SyncOptions): string[] {
  const data = ctx.config.data;
  return [
    'sync',
    ...baseArgs(ctx),
    '--symbol',
    symbol,
    '--batch-size',
    String(options.batchSize ?? data.batchSize),
    '--max-gap-attempts',
    String(options.maxGapAttempts ?? data.maxGapAttempts),
    '--weight-budget',
    String(ctx.config.sync.weightBudgetPerMinute),
    ...metadataArgs(ctx),
    '--intervals',
    (options.aggregateIntervals ?? data.aggregateIntervals).join(','),
    ...indicatorArgs(ctx),
    ...(options.from === undefined ? [] : ['--from', String(options.from)]),
    ...(options.to === undefined ? [] : ['--to', String(options.to)]),
    ...(options.nowMs === undefined ? [] : ['--now-ms', String(options.nowMs)]),
    ...(options.allowBackfill === false ? ['--no-backfill'] : []),
  ];
}

/**
 * 执行一轮同步并返回摘要（R-9 / R-10 / R-11）。
 * 幂等：重复执行同一区间不会产生重复行，重复增量返回 `added = 0`（R-12）。
 */
export async function syncSymbol(
  ctx: MarketContext,
  symbol: string,
  options: SyncOptions = {},
): Promise<SyncRunSummary> {
  // 每次触碰数据前都过一遍版本闸门：schema 不匹配时**立即停止**，不得重试（R-21.6）。
  const { assertSchemaVersion } = await import('./db/migrate.js');
  await assertSchemaVersion(ctx.pool);
  return invoke<SyncRunSummary>(ctx, {
    args: syncArgs(ctx, symbol, options),
    withDsn: true,
  });
}

/** 显式区间回补，一律 DO NOTHING，绝不改写已有行（R-9.3 / R-15.2）。 */
export async function backfillRange(
  ctx: MarketContext,
  symbol: string,
  range: { from: number; to: number },
  options: SyncOptions = {},
): Promise<SyncRunSummary> {
  const { assertSchemaVersion } = await import('./db/migrate.js');
  await assertSchemaVersion(ctx.pool);
  return invoke<SyncRunSummary>(ctx, {
    args: [
      'backfill',
      ...baseArgs(ctx),
      '--symbol',
      symbol,
      '--from',
      String(range.from),
      '--to',
      String(range.to),
      '--batch-size',
      String(options.batchSize ?? ctx.config.data.batchSize),
      '--weight-budget',
      String(ctx.config.sync.weightBudgetPerMinute),
      ...metadataArgs(ctx),
      '--intervals',
      (options.aggregateIntervals ?? ctx.config.data.aggregateIntervals).join(','),
      ...indicatorArgs(ctx),
      ...(options.nowMs === undefined ? [] : ['--now-ms', String(options.nowMs)]),
    ],
    withDsn: true,
  });
}

export interface VerifyResult {
  symbol: string;
  scannedRows: number;
  gapsFound: number;
  verifiedUpTo: number | null;
}

/** 全表缺口扫描并重建 verified_upto 基线（R-11.A3 ② / R-15）。 */
export async function verifySymbol(ctx: MarketContext, symbol: string): Promise<VerifyResult> {
  // 与 syncSymbol / backfillRange 一致：数据命令进入前先过版本闸门（R-1.3 / R-19.7）。
  const { assertSchemaVersion } = await import('./db/migrate.js');
  await assertSchemaVersion(ctx.pool);
  return invoke<VerifyResult>(ctx, {
    args: ['verify', ...baseArgs(ctx), '--symbol', symbol],
    withDsn: true,
  });
}

// ---------------------------------------------------------------- 派生周期

export interface AggregateOptions {
  /** 显式给出时以命令行为准；缺省取 `data.aggregateIntervals`（R-5.2） */
  intervals?: readonly string[] | undefined;
  from?: number | undefined;
  to?: number | undefined;
}

function aggregateIntervalArgs(ctx: MarketContext, options: AggregateOptions): string[] {
  const data = ctx.config.data;
  return [
    '--intervals',
    (options.intervals ?? data.aggregateIntervals).join(','),
    '--aggregate-batch-bars',
    String(data.aggregateBatchBars),
  ];
}

/**
 * 补齐 / 重建 / 校验派生 K 线（v0.2.0 R-5）。
 *
 * **不进交易所、不改 `sync_state` 的水位与 rows**（R-5.4）：Python 侧只读 1m、只写派生表。
 * 周期白名单由 Python 侧校验，出现 `1m` / `5m` / 其它一律 `CONFIG_INVALID`。
 */
export async function aggregateSymbol(
  ctx: MarketContext,
  symbol: string,
  options: AggregateOptions = {},
  mode: { rebuild?: boolean; check?: boolean } = {},
): Promise<AggregateSummary> {
  const { assertSchemaVersion } = await import('./db/migrate.js');
  await assertSchemaVersion(ctx.pool);
  return invoke<AggregateSummary>(ctx, {
    args: [
      'aggregate',
      ...baseArgs(ctx),
      '--symbol',
      symbol,
      ...aggregateIntervalArgs(ctx, options),
      ...(options.from === undefined ? [] : ['--from', String(options.from)]),
      ...(options.to === undefined ? [] : ['--to', String(options.to)]),
      ...(mode.rebuild ? ['--rebuild'] : []),
      ...(mode.check ? ['--check'] : []),
    ],
    withDsn: true,
  });
}

// ------------------------------------------------------------------ 状态读

export async function getState(
  ctx: MarketContext,
  symbol: string,
): Promise<SymbolSyncState | null> {
  return repo.readState(ctx.pool, ctx.exchange, symbol);
}

export async function getAllStates(ctx: MarketContext): Promise<SymbolSyncState[]> {
  // 按 exchange 过滤：全局汇总是按 exchange 统计的，不过滤会让 `sync status`
  // 列出的标的数与汇总数出自两个不同的总体。
  return repo.listStates(ctx.pool, ctx.exchange);
}

export async function getGaps(ctx: MarketContext, symbol?: string) {
  return repo.listGaps(ctx.pool, symbol);
}

export async function getSymbolEntries(ctx: MarketContext): Promise<SymbolEntry[]> {
  return repo.listSymbolEntries(ctx.pool, ctx.exchange);
}

export async function getRateLimitStatus(ctx: MarketContext): Promise<RateLimitStatus> {
  return repo.readWeightBudget(ctx.pool, ctx.config.sync.weightBudgetPerMinute);
}

export async function getSummary(ctx: MarketContext): Promise<SyncSummary> {
  const [global, rateLimit] = await Promise.all([
    // 传**实际启用的派生周期**：`aggregateIntervals: []` 时 `derived` 必须是空数组，
    // 否则 `sync status` 会打印四行「0 行 / 0.00 MB」——那是「未启用派生」被显示成
    // 「启用了但还没聚合」（R-8.4 / AC-22）。只启用子集时同理，不能把没启用的报成 0。
    repo.readGlobalSummary(ctx.pool, ctx.exchange, ctx.config.data.aggregateIntervals),
    getRateLimitStatus(ctx),
  ]);
  return { ...global, rateLimit };
}

/**
 * 水位一致性校验（R-19.6 / AC-21）。二者不一致必须报错，不得二选一。
 */
export async function assertWatermark(ctx: MarketContext, symbol: string): Promise<void> {
  await repo.assertWatermarkConsistent(ctx.pool, ctx.exchange, symbol);
}

/** 目标标的是否存在。不存在时抛 `SYMBOL_NOT_FOUND`，由调用方决定是「报错」还是「加入集合」。 */
export async function requireContract(ctx: MarketContext, symbol: string): Promise<ExchangeSymbol> {
  const spec = await resolveContract(ctx, symbol);
  if (spec.contractType !== 'PERPETUAL') {
    throw new SyncError(
      'NOT_PERPETUAL',
      `${symbol} 不是永续合约（contractType=${spec.contractType}）`,
      {
        symbol,
        contractType: spec.contractType,
      },
    );
  }
  if (spec.status !== 'TRADING') {
    throw new SyncError('NOT_TRADING', `${symbol} 当前不可交易（status=${spec.status}）`, {
      symbol,
      status: spec.status,
    });
  }
  return spec;
}
