import { z } from 'zod';

import { INTERVALS } from './types.js';

export const marketSchema = z.object({
  symbol: z.string().min(1),
  /**
   * **回测周期，与行情同步无关。**
   *
   * R-6 要求「周期固定 1m，不提供 `interval` 配置项」。那个约束作用于**行情同步链路**：
   * `data sync` / `data fetch --source binance` / `apps/sync` 全链路不读这个字段，
   * 1m 由 `klines_1m` 表名固化，CLI 也不接受 `--interval`。
   *
   * 之所以保留它：§0.1 明确「本次不动 `packages/backtest`」，而回测
   * （`ma-cross` 等策略）需要按周期取数；删掉它会直接破坏既有回测与 AC-29
   * 「`data fetch --bars 100` 不传新参数行为不变」。因此它只服务于 synthetic 回测链路。
   */
  interval: z.enum(INTERVALS),
  /** 行情来源。`synthetic` 为离线合成（默认，保持既有链路），`binance` 为真实交易所 */
  source: z.enum(['synthetic', 'binance']).default('synthetic'),
  /** 交易所标识，作为 symbols / contract_spec / sync_state 的分区键 */
  exchange: z.string().min(1).default('binance'),
  /** 市场类型：本需求只做 USDⓈ-M 永续（N-2） */
  marketType: z.enum(['usdm']).default('usdm'),
  /** 初始资金 */
  initialCapital: z.number().positive().default(10_000),
  /** 单边手续费率，0.001 = 万一 */
  feeRate: z.number().min(0).max(0.1).default(0.0005),
  /** 滑点，按成交价比例计 */
  slippageRate: z.number().min(0).max(0.1).default(0),
  bars: z.number().int().positive().max(100_000).default(500),
});

export const backtestSchema = z.object({
  strategy: z.string().min(1).default('ma-cross'),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});

export const dataSchema = z.object({
  /** python 侧使用的解释器运行时 */
  python: z.enum(['uv', 'python3']).default('uv'),
  /** 原始数据落盘目录，相对 TRADE_TOOL_HOME */
  rawDir: z.string().default('data/raw'),
  cacheDir: z.string().default('data/cache'),
  /** exchangeInfo 元数据缓存目录，相对 TRADE_TOOL_HOME */
  metaDir: z.string().default('data/meta'),
  /** exchangeInfo 缓存 TTL（毫秒），默认 1 小时（R-7.1） */
  metadataTtlMs: z.number().int().positive().default(3_600_000),
  /** TTL 过期且拉取失败时，是否允许使用过期缓存（R-7.1，默认允许但会 WARN + 标记 metadataStale） */
  allowStaleMetadata: z.boolean().default(true),
  /** 单次 python 子进程超时（毫秒） */
  timeoutMs: z.number().int().positive().default(60_000),
  /** PG 批量写入的批大小（R-3.2），每批一个事务 */
  batchSize: z.number().int().positive().max(100_000).default(5_000),
  /** 缺口自动回补的尝试次数上限（R-11.9），达上限后该标的进 error */
  maxGapAttempts: z.number().int().positive().default(5),
});

/**
 * PG 连接参数。密码**必须经环境变量注入**（R-13 database 段），
 * 这里只接受环境变量名，不接受明文密码。
 */
export const databaseSchema = z.object({
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().positive().max(65_535).default(5432),
  database: z.string().min(1).default('trade_tool'),
  user: z.string().min(1).default('trade'),
  /** 存放密码的环境变量名，默认 TRADE_TOOL_PG_PASSWORD */
  passwordEnv: z.string().min(1).default('TRADE_TOOL_PG_PASSWORD'),
  /** 连接池上限，与并发标的数、批大小一并配置（R-20.7） */
  poolMax: z.number().int().positive().max(200).default(10),
  /** 连接超时（毫秒） */
  connectionTimeoutMs: z.number().int().positive().default(10_000),
  ssl: z.boolean().default(false),
});

/** 标的移除时已入库数据的处置策略（R-18.3），禁止静默删除。 */
export const removePolicySchema = z.enum(['keep', 'archive', 'delete']);
/** 常驻同步守护进程配置（R-13 sync 段 / R-17…R-22）。 */
export const syncSchema = z.object({
  /** 标的集合；新标的默认 paused（R-8.4），需显式 start 才启动首次全量 */
  symbols: z.array(z.string().min(1)).default([]),
  /** 同时同步的标的数上限（R-20.5） */
  concurrency: z.number().int().positive().max(64).default(4),
  /** 轮询间隔（毫秒）：每轮调度之间休眠多久 */
  pollIntervalMs: z.number().int().positive().default(15_000),
  /** 每分钟权重预算。交易所硬配额 2400/分钟是账号级（R-20.1），预算取其 80% 留余量 */
  weightBudgetPerMinute: z.number().int().positive().max(2_400).default(1_920),
  /** 指数退避的初始间隔（毫秒） */
  backoffBaseMs: z.number().int().positive().default(5_000),
  /** 指数退避上限（毫秒） */
  backoffMaxMs: z.number().int().positive().default(300_000),
  /** 连续失败多少次后进入 error 并停止自动重试（R-21.3） */
  maxConsecutiveErrors: z.number().int().positive().default(5),
  /** removeSymbol 时已入库数据的处置策略 */
  onRemove: removePolicySchema.default('keep'),
  /** 是否允许执行首次全量回补；false 时新增标的仍为 paused（R-8.4） */
  allowBackfill: z.boolean().default(true),
});

export const configSchema = z.object({
  version: z.literal(1).default(1),
  market: marketSchema,
  // 整段可省略：只写要改的字段，其余走各字段自身的默认值
  backtest: backtestSchema.default({}),
  data: dataSchema.default({}),
  database: databaseSchema.default({}),
  sync: syncSchema.default({}),
});

export type MarketConfig = z.infer<typeof marketSchema>;
export type BacktestConfig = z.infer<typeof backtestSchema>;
export type DataConfig = z.infer<typeof dataSchema>;
export type DatabaseConfig = z.infer<typeof databaseSchema>;
export type SyncConfig = z.infer<typeof syncSchema>;
// 注意：`RemovePolicy` 这个类型名归 market-sync.ts 所有，config 只导出 zod schema，
// 避免同一概念在两个模块各有一个类型名。
export type RemovePolicySchema = z.infer<typeof removePolicySchema>;
export type TradeToolConfig = z.infer<typeof configSchema>;

export function defaultConfig(): TradeToolConfig {
  return configSchema.parse({
    market: { symbol: 'BTCUSDT', interval: '1h' },
    backtest: { strategy: 'ma-cross', params: { fast: 20, slow: 60 } },
    data: {},
    database: {},
    sync: {},
  });
}
