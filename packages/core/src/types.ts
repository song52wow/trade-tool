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
