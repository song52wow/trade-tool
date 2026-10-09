/**
 * 止盈止损执行记录（v0.4.0）。
 *
 * 这层只做两件事，且都围绕**幂等**：
 *
 * 1. `claimBracket()`：**先占坑再动手**。`(exchange, symbol, entry_order_id)` 冲突
 *    即代表这笔买入成交已被处理过，返回 `null` 让调用方跳过。用户数据流在
 *    listenKey 续期与断线重连后都会重放事件，而止盈止损是**会真实下单**的动作——
 *    处理两次就是两组单在跑，第二组还会吃掉第一组。
 * 2. `markBracketArmed()` / `markBracketSettled()`：把交易所侧的订单号与最终状态回填。
 *
 * 为什么不把「占坑 + 下单」放进一个事务：坑在 PG、单在交易所，两者无法原子提交。
 * 于是选择「占坑后下单失败 → 留下 `failed` 行并把原因写进 `last_error`」，
 * 而不是「下单成功但没记下来 → 重连后再挂一次」。前者看得见，后者会重复下单。
 *
 * 表名是常量，不是参数（R-2.5 / R-6.2 继续成立）；schema 的唯一来源在
 * `sql/006_risk_bracket.sql`，本模块不另持影子定义。
 */

import { SyncError, type PositionSide } from '@trade-tool/core';

import { toSyncError } from './errors.js';
import type { Pool } from './pool.js';

// 方向 / 仓位类型只有 core 那一份定义，这里只转出去（AGENTS.md 约定 5）。
export type { PositionSide } from '@trade-tool/core';

/** 固定表名。绝不把 symbol / state 之类拼进 SQL。 */
const TABLE = 'risk_bracket';

const COLUMNS = `exchange, symbol, entry_order_id, entry_price, entry_time, filled_qty,
  position_side, atr, atr_period, atr_interval, atr_window_from, atr_window_to,
  stop_price, take_profit, tp_order_id, sl_order_id, state, last_error, created_at, updated_at`;

export type BracketState = 'armed' | 'take_profit' | 'stop_loss' | 'cancelled' | 'failed';

/** 一次待挂止盈止损的意图：只描述「发生了什么成交、算出什么价」。 */
export interface BracketClaim {
  exchange: string;
  symbol: string;
  entryOrderId: string;
  entryPrice: number;
  entryTime: number;
  filledQty: number;
  positionSide: PositionSide;
  atr: number;
  atrPeriod: number;
  atrInterval: string;
  atrWindowFrom: number;
  atrWindowTo: number;
  stopPrice: number;
  takeProfit: number;
  /** 下单时刻（epoch ms），落 created_at / updated_at。 */
  now: number;
}

/** 库里的一行。与 `BracketClaim` 分开：`now` 是入参，库里存的是两个时间戳。 */
export interface BracketRecord {
  exchange: string;
  symbol: string;
  entryOrderId: string;
  entryPrice: number;
  entryTime: number;
  filledQty: number;
  positionSide: PositionSide;
  atr: number;
  atrPeriod: number;
  atrInterval: string;
  atrWindowFrom: number;
  atrWindowTo: number;
  stopPrice: number;
  takeProfit: number;
  tpOrderId: number | null;
  slOrderId: number | null;
  state: BracketState;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

function num(row: Record<string, unknown>, field: string, where: string): number {
  const value = row[field];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new SyncError('NULL_NOT_ALLOWED', `${where} 的 ${field} 不是有限数字`, {
    field,
    value,
  });
}

function bigint(row: Record<string, unknown>, field: string, where: string): number {
  const value = row[field];
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  throw new SyncError('NULL_NOT_ALLOWED', `${where} 的 ${field} 不是整数`, { field, value });
}

function str(row: Record<string, unknown>, field: string, where: string): string {
  const value = row[field];
  if (typeof value === 'string') return value;
  throw new SyncError('NULL_NOT_ALLOWED', `${where} 的 ${field} 不是字符串`, { field, value });
}

function optionalBigint(row: Record<string, unknown>, field: string, where: string): number | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  return bigint(row, field, where);
}

function optionalStr(row: Record<string, unknown>, field: string, where: string): string | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  return str(row, field, where);
}

function toRecord(row: Record<string, unknown>): BracketRecord {
  const where = `${String(row['exchange'])}/${String(row['symbol'])}/${String(row['entry_order_id'])}`;
  return {
    exchange: str(row, 'exchange', where),
    symbol: str(row, 'symbol', where),
    entryOrderId: str(row, 'entry_order_id', where),
    entryPrice: num(row, 'entry_price', where),
    entryTime: bigint(row, 'entry_time', where),
    filledQty: num(row, 'filled_qty', where),
    positionSide: str(row, 'position_side', where) as PositionSide,
    atr: num(row, 'atr', where),
    atrPeriod: num(row, 'atr_period', where),
    atrInterval: str(row, 'atr_interval', where),
    atrWindowFrom: bigint(row, 'atr_window_from', where),
    atrWindowTo: bigint(row, 'atr_window_to', where),
    stopPrice: num(row, 'stop_price', where),
    takeProfit: num(row, 'take_profit', where),
    tpOrderId: optionalBigint(row, 'tp_order_id', where),
    slOrderId: optionalBigint(row, 'sl_order_id', where),
    state: str(row, 'state', where) as BracketState,
    lastError: optionalStr(row, 'last_error', where),
    createdAt: bigint(row, 'created_at', where),
    updatedAt: bigint(row, 'updated_at', where),
  };
}

/**
 * 占坑。**已存在则返回 `null`**——这就是「同一笔买入成交只处理一次」的唯一实现点。
 *
 * 抛错而不是静默跳过：DB_UNIQUE_VIOLATION 之类的问题必须暴露（AGENTS.md 约定 9）。
 */
export async function claimBracket(pool: Pool, claim: BracketClaim): Promise<BracketRecord | null> {
  const values = [
    claim.exchange,
    claim.symbol,
    claim.entryOrderId,
    claim.entryPrice,
    claim.entryTime,
    claim.filledQty,
    claim.positionSide,
    claim.atr,
    claim.atrPeriod,
    claim.atrInterval,
    claim.atrWindowFrom,
    claim.atrWindowTo,
    claim.stopPrice,
    claim.takeProfit,
    claim.now,
    claim.now,
  ];
  try {
    const result = await pool.query<Record<string, unknown>>(
      `INSERT INTO ${TABLE} (exchange, symbol, entry_order_id, entry_price, entry_time, filled_qty,
         position_side, atr, atr_period, atr_interval, atr_window_from, atr_window_to,
         stop_price, take_profit, state, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'failed', $15, $16)
       ON CONFLICT (exchange, symbol, entry_order_id) DO NOTHING
       RETURNING ${COLUMNS}`,
      values,
    );
    const row = result.rows[0];
    return row ? toRecord(row) : null;
  } catch (error) {
    throw toSyncError(error, `占坑止盈止损记录失败：${claim.symbol} ${claim.entryOrderId}`);
  }
}

/** 两张条件单都挂上了。回填订单号并置 `armed`。 */
export async function markBracketArmed(
  pool: Pool,
  key: { exchange: string; symbol: string; entryOrderId: string },
  orderIds: { tpOrderId: number; slOrderId: number },
  now: number,
): Promise<void> {
  try {
    const result = await pool.query(
      `UPDATE ${TABLE} SET tp_order_id = $4, sl_order_id = $5, state = 'armed',
         last_error = NULL, updated_at = $6
       WHERE exchange = $1 AND symbol = $2 AND entry_order_id = $3`,
      [key.exchange, key.symbol, key.entryOrderId, orderIds.tpOrderId, orderIds.slOrderId, now],
    );
    if (result.rowCount !== 1) {
      throw new SyncError(
        'SYNC_ALREADY_RUNNING',
        `止盈止损记录不存在，无法标记为已挂上：${key.symbol} ${key.entryOrderId}`,
        key as unknown as Record<string, unknown>,
      );
    }
  } catch (error) {
    throw toSyncError(error, `回填止盈止损订单号失败：${key.symbol} ${key.entryOrderId}`);
  }
}

/**
 * 记失败。`last_error` 常驻可见。
 *
 * 单号已知也要保留（可能是止盈挂上、止损没挂上），因此 orderIds 可选。
 */
export async function markBracketFailed(
  pool: Pool,
  key: { exchange: string; symbol: string; entryOrderId: string },
  error: { tpOrderId?: number; slOrderId?: number },
  reason: string,
  now: number,
): Promise<void> {
  try {
    await pool.query(
      `UPDATE ${TABLE} SET state = 'failed', last_error = $4,
         tp_order_id = COALESCE($5, tp_order_id), sl_order_id = COALESCE($6, sl_order_id),
         updated_at = $7
       WHERE exchange = $1 AND symbol = $2 AND entry_order_id = $3`,
      [
        key.exchange,
        key.symbol,
        key.entryOrderId,
        reason,
        error.tpOrderId ?? null,
        error.slOrderId ?? null,
        now,
      ],
    );
  } catch (caught) {
    throw toSyncError(caught, `记录止盈止损失败原因时出错：${key.symbol} ${key.entryOrderId}`);
  }
}

/** 交易所回报成交：另一张单由交易所自动撤销，这里只落最终状态。 */
export async function markBracketSettled(
  pool: Pool,
  key: { exchange: string; symbol: string; entryOrderId: string },
  state: Extract<BracketState, 'take_profit' | 'stop_loss' | 'cancelled'>,
  now: number,
): Promise<void> {
  try {
    await pool.query(
      `UPDATE ${TABLE} SET state = $4, updated_at = $5
       WHERE exchange = $1 AND symbol = $2 AND entry_order_id = $3`,
      [key.exchange, key.symbol, key.entryOrderId, state, now],
    );
  } catch (caught) {
    throw toSyncError(caught, `更新止盈止损最终状态失败：${key.symbol} ${key.entryOrderId}`);
  }
}

/** 读一笔。找不到返回 `null`（「还没处理过」不是错误）。 */
export async function readBracket(
  pool: Pool,
  exchange: string,
  symbol: string,
  entryOrderId: string,
): Promise<BracketRecord | null> {
  try {
    const result = await pool.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM ${TABLE} WHERE exchange = $1 AND symbol = $2 AND entry_order_id = $3`,
      [exchange, symbol, entryOrderId],
    );
    const row = result.rows[0];
    return row ? toRecord(row) : null;
  } catch (error) {
    throw toSyncError(error, `读取止盈止损记录失败：${symbol} ${entryOrderId}`);
  }
}

/** 某标的最近的记录，倒序。控制面与排障用。 */
export async function listBrackets(
  pool: Pool,
  exchange: string,
  symbol: string,
  limit = 50,
): Promise<BracketRecord[]> {
  try {
    const result = await pool.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM ${TABLE} WHERE exchange = $1 AND symbol = $2
       ORDER BY updated_at DESC LIMIT $3`,
      [exchange, symbol, limit],
    );
    return result.rows.map(toRecord);
  } catch (error) {
    throw toSyncError(error, `读取 ${symbol} 止盈止损记录失败`);
  }
}
