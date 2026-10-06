/** K 线周期。字符串即本项目内统一的周期标识。 */
export const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type Interval = (typeof INTERVALS)[number];

/** 周期 -> 毫秒数，用于对齐窗口与切片。 */
export const INTERVAL_MS: Record<Interval, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
};

export function intervalToMs(interval: Interval): number {
  return INTERVAL_MS[interval];
}

/**
 * **已实现**的周期（v0.2.0 R-6.5）。
 *
 * `1m` 是基础数据（`klines_1m`），另外四个由库内 1m 派生。`5m` 仍在 `INTERVALS` 枚举里
 * （它服务 synthetic 回测链路），但派生层**没有** `klines_5m`——读侧遇到它必须报
 * `CONFIG_INVALID`，绝不静默回落到 1m（R-6.5）。
 */
export const STORED_INTERVALS = ['1m', '15m', '1h', '4h', '1d'] as const;
export type StoredInterval = (typeof STORED_INTERVALS)[number];

/** 由库内 1m **派生**的四个周期（不含 1m 本身）。 */
export const DERIVED_INTERVALS = ['15m', '1h', '4h', '1d'] as const;
export type DerivedInterval = (typeof DERIVED_INTERVALS)[number];

/**
 * 周期 → 表名。**唯一允许**的表名来源（R-1.6 / R-6.2）。
 *
 * 表名不可参数化，所以查库前必须先过这张白名单，把周期字符串换成一个**编译期已知**的
 * 表名标识；把 `interval` 直接拼进 SQL 就是一个注入面。
 * `quant_data` 侧另有一份 Python 映射，二者与 `sql/004_klines_agg.sql` 的表集合必须三方
 * 一致，由 AC-1 的测试断言。
 */
export const INTERVAL_TABLES: Readonly<Record<StoredInterval, string>> = Object.freeze({
  '1m': 'klines_1m',
  '15m': 'klines_15m',
  '1h': 'klines_1h',
  '4h': 'klines_4h',
  '1d': 'klines_1d',
});

/** 读侧 / 写侧都只接受这五个周期；其余（含 `5m`）一律 CONFIG_INVALID。 */
export function isStoredInterval(value: string): value is StoredInterval {
  return Object.prototype.hasOwnProperty.call(INTERVAL_TABLES, value);
}

/** 一根 K 线。time 为毫秒时间戳（UTC），price 全部为 float。 */
export interface Bar {
  /** 开盘时间（毫秒时间戳） */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Side = 'long' | 'short';

/** 订单意图，回测与实盘共用。 */
export interface OrderIntent {
  symbol: string;
  side: Side;
  /** 正数数量，正向开仓；平仓用 close 字段表达 */
  quantity: number;
  /** 限价；未指定时按市价处理 */
  limitPrice?: number;
  reason?: string;
}

export interface Position {
  symbol: string;
  side: Side;
  quantity: number;
  entryPrice: number;
  openedAt: number;
}

export interface Signal {
  symbol: string;
  time: number;
  side: Side;
  strength: number;
  reason: string;
}

/** 一笔已平仓交易。pnl 已扣手续费与滑点。 */
export interface Trade {
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnl: number;
  reason: string;
}

/** 回测产出的统一点位：净值与回撤序列。 */
export interface EquityPoint {
  time: number;
  equity: number;
  drawdown: number;
}
