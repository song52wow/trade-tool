/**
 * 止盈止损策略的读写（v0.5.0）。
 *
 * 两个作用域，合并成一次查询返回：全局默认 + 该标的的覆盖。**标的行优先**，
 * 没有标的行才用全局行。
 *
 * 这个优先级只有一份实现（`resolvePolicy`）。页面预览、控制面展示、executor
 * 实际下单都调它——三处各写一遍 `row ?? global`，一旦 executor 那边和页面那边
 * 漂移，用户看到的是「设置里写的是 3 倍止损」，仓位上挂的却是 2 倍。
 *
 * **配置只影响之后的新买入成交**：已经挂出去的单不会被改写。改倍数不会去撤单重挂
 * ——那会平掉真实仓位，是不可逆的。
 */

import { SyncError, type ExecutorConfig } from '@trade-tool/core';

import { toSyncError } from './errors.js';
import type { Pool } from './pool.js';

const TABLE = 'risk_policy';

/** 可配置的口径。取值范围与 `executorSchema` 一致，schema 层的 CHECK 也钉住了同一套。 */
export interface RiskPolicy {
  atrPeriod: number;
  atrInterval: string;
  stopAtrMult: number;
  takeProfitAtrMult: number;
}

export interface RiskPolicyScope {
  scope: 'global' | 'symbol';
  exchange: string;
  symbol: string;
  updatedAt: number;
}

/** 一条策略连同它的作用域。页面直接按这个形状渲染两栏。 */
export interface RiskPolicyEntry extends RiskPolicy, RiskPolicyScope {}

interface Row {
  scope: string;
  exchange: string;
  symbol: string;
  atr_period: number;
  atr_interval: string;
  stop_atr_mult: number;
  take_profit_atr_mult: number;
  updated_at: string | number;
}

function toEntry(row: Row): RiskPolicyEntry {
  return {
    scope: row.scope as 'global' | 'symbol',
    exchange: row.exchange,
    symbol: row.symbol,
    atrPeriod: row.atr_period,
    atrInterval: row.atr_interval,
    stopAtrMult: row.stop_atr_mult,
    takeProfitAtrMult: row.take_profit_atr_mult,
    updatedAt: typeof row.updated_at === 'number' ? row.updated_at : Number(row.updated_at),
  };
}

/** 读全部策略（全局 + 各标的覆盖）。 */
export async function listRiskPolicies(pool: Pool, exchange: string): Promise<RiskPolicyEntry[]> {
  try {
    const result = await pool.query<Row>(
      `SELECT scope, exchange, symbol, atr_period, atr_interval,
              stop_atr_mult, take_profit_atr_mult, updated_at
       FROM ${TABLE} WHERE exchange = $1
       ORDER BY (scope = 'symbol') DESC, symbol ASC`,
      [exchange],
    );
    return result.rows.map(toEntry);
  } catch (error) {
    throw toSyncError(error, `读取 ${exchange} 止盈止损策略失败`);
  }
}

/** 写一条。scope 与 symbol 的相容性由 schema 的 CHECK 保证，这里只挡明显的空值。 */
export async function writeRiskPolicy(
  pool: Pool,
  input: { scope: RiskPolicyScope['scope']; exchange: string; symbol: string } & RiskPolicy & {
      now: number;
    },
): Promise<RiskPolicyEntry> {
  if (input.scope === 'global' && input.symbol !== '') {
    throw new SyncError('CONFIG_INVALID', '全局默认策略不能带标的');
  }
  if (input.scope === 'symbol' && input.symbol.trim() === '') {
    throw new SyncError('CONFIG_INVALID', '标的覆盖必须给 symbol');
  }
  const symbol = input.scope === 'global' ? '' : input.symbol.trim();
  try {
    const result = await pool.query<Row>(
      `INSERT INTO ${TABLE}
         (scope, exchange, symbol, atr_period, atr_interval,
          stop_atr_mult, take_profit_atr_mult, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (scope, exchange, symbol) DO UPDATE
         SET atr_period = EXCLUDED.atr_period, atr_interval = EXCLUDED.atr_interval,
             stop_atr_mult = EXCLUDED.stop_atr_mult,
             take_profit_atr_mult = EXCLUDED.take_profit_atr_mult,
             updated_at = EXCLUDED.updated_at
       RETURNING scope, exchange, symbol, atr_period, atr_interval,
                 stop_atr_mult, take_profit_atr_mult, updated_at`,
      [
        input.scope,
        input.exchange,
        symbol,
        input.atrPeriod,
        input.atrInterval,
        input.stopAtrMult,
        input.takeProfitAtrMult,
        input.now,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new SyncError('CONFIG_INVALID', '写入策略后没有拿到回写行');
    return toEntry(row);
  } catch (error) {
    if (error instanceof SyncError) throw error;
    // CHECK 约束拒绝时把库的理由原样带出去：页面需要知道是倍数超界还是周期未实现，
    // 而不是一句笼统的「保存失败」。
    throw toSyncError(error, `写入 ${input.symbol || '全局'} 止盈止损策略失败`);
  }
}

export async function deleteRiskPolicy(
  pool: Pool,
  scope: 'global' | 'symbol',
  exchange: string,
  symbol: string,
): Promise<void> {
  if (scope === 'symbol' && symbol.trim() === '') {
    throw new SyncError('CONFIG_INVALID', '标的覆盖必须给 symbol');
  }
  try {
    await pool.query(`DELETE FROM ${TABLE} WHERE scope = $1 AND exchange = $2 AND symbol = $3`, [
      scope,
      exchange,
      scope === 'global' ? '' : symbol.trim(),
    ]);
  } catch (error) {
    throw toSyncError(error, '删除止盈止损策略失败');
  }
}

/**
 * **唯一的优先级实现**：标的覆盖 > 全局默认 > 配置文件兜底。
 *
 * 兜底那一档是有意保留的：库里一条都没有时，仍然要用配置里的值，
 * 而不是因为「数据库是空的」就让 executor 没有可执行的策略。
 */
export async function resolvePolicy(
  pool: Pool,
  exchange: string,
  symbol: string,
  fallback: ExecutorConfig,
): Promise<RiskPolicy & { source: 'symbol' | 'global' | 'config' }> {
  try {
    const result = await pool.query<Row>(
      `SELECT scope, exchange, symbol, atr_period, atr_interval,
              stop_atr_mult, take_profit_atr_mult, updated_at
       FROM ${TABLE}
       WHERE exchange = $1 AND ((scope = 'symbol' AND symbol = $2) OR (scope = 'global' AND symbol = ''))
       -- 标的覆盖先命中：两行都可能存在，优先级在这一句里定死，不靠应用层的顺序
       ORDER BY (scope = 'symbol') DESC
       LIMIT 1`,
      [exchange, symbol.trim()],
    );
    const row = result.rows[0];
    if (row !== undefined) {
      return {
        atrPeriod: row.atr_period,
        atrInterval: row.atr_interval,
        stopAtrMult: row.stop_atr_mult,
        takeProfitAtrMult: row.take_profit_atr_mult,
        source: row.scope === 'symbol' ? 'symbol' : 'global',
      };
    }
    return {
      atrPeriod: fallback.atrPeriod,
      atrInterval: fallback.atrInterval,
      stopAtrMult: fallback.stopAtrMult,
      takeProfitAtrMult: fallback.takeProfitAtrMult,
      source: 'config',
    };
  } catch (error) {
    throw toSyncError(error, `解析 ${symbol} 止盈止损策略失败`);
  }
}
