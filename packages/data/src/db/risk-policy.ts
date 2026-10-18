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
  /**
   * 第一段减仓比例（v0.7.0），`[0, 1]`。`0` = 关闭分批。
   *
   * 库里的值**永远是具体数字**：`trailAtrMult` 与 `takeProfit1AtrMult` 的
   * 「配置里没写就取另一个参数」那条规则只发生在 `resolvePolicy` 的兜底分支，
   * 页面保存时要求显式给出，因此不存在「两处各有一份默认」的问题。
   */
  takeProfit1Ratio: number;
  takeProfit1AtrMult: number;
  trailAtrMult: number;
  breakevenAfterTp1: boolean;
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
  take_profit1_ratio: number;
  take_profit1_atr_mult: number;
  trail_atr_mult: number;
  breakeven_after_tp1: boolean;
  updated_at: string | number;
}

/** SELECT / RETURNING 共用一份列清单——两处各写一遍，改字段时必漏一处。 */
const COLUMNS = `scope, exchange, symbol, atr_period, atr_interval,
  stop_atr_mult, take_profit_atr_mult, take_profit1_ratio, take_profit1_atr_mult,
  trail_atr_mult, breakeven_after_tp1, updated_at`;

function toEntry(row: Row): RiskPolicyEntry {
  return {
    scope: row.scope as 'global' | 'symbol',
    exchange: row.exchange,
    symbol: row.symbol,
    atrPeriod: row.atr_period,
    atrInterval: row.atr_interval,
    stopAtrMult: row.stop_atr_mult,
    takeProfitAtrMult: row.take_profit_atr_mult,
    takeProfit1Ratio: row.take_profit1_ratio,
    takeProfit1AtrMult: row.take_profit1_atr_mult,
    trailAtrMult: row.trail_atr_mult,
    breakevenAfterTp1: row.breakeven_after_tp1,
    updatedAt: typeof row.updated_at === 'number' ? row.updated_at : Number(row.updated_at),
  };
}

/** 读全部策略（全局 + 各标的覆盖）。 */
export async function listRiskPolicies(pool: Pool, exchange: string): Promise<RiskPolicyEntry[]> {
  try {
    const result = await pool.query<Row>(
      `SELECT ${COLUMNS} FROM ${TABLE} WHERE exchange = $1
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
  // v0.7.0 的四个字段同样**必须有具体值**：不靠数据库 DEFAULT 兜。
  // 少了它们时若直接写库，报出来的是 `not-null constraint` 的 INTERNAL_ERROR，
  // 而那句话完全指不出「是策略请求缺字段」——用户会去看数据库而不是看请求体
  // （AGENTS.md 约定 8：配置缺失要说清怎么配）。
  for (const [name, value] of [
    ['takeProfit1Ratio', input.takeProfit1Ratio],
    ['takeProfit1AtrMult', input.takeProfit1AtrMult],
    ['trailAtrMult', input.trailAtrMult],
  ] as const) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new SyncError(
        'CONFIG_INVALID',
        `止盈止损策略缺少 ${name}（收到 ${String(value)}）：两段止盈与移动止损的参数必须显式给全，` +
          `取值范围见 executorSchema`,
        { field: name, value: String(value) },
      );
    }
  }
  if (typeof input.breakevenAfterTp1 !== 'boolean') {
    throw new SyncError(
      'CONFIG_INVALID',
      `止盈止损策略缺少 breakevenAfterTp1（收到 ${String(input.breakevenAfterTp1)}）：` +
        `第一段兑现后是否上移到保本位必须显式给出`,
      { field: 'breakevenAfterTp1' },
    );
  }
  const symbol = input.scope === 'global' ? '' : input.symbol.trim();
  try {
    const result = await pool.query<Row>(
      `INSERT INTO ${TABLE}
         (scope, exchange, symbol, atr_period, atr_interval,
          stop_atr_mult, take_profit_atr_mult,
          take_profit1_ratio, take_profit1_atr_mult, trail_atr_mult, breakeven_after_tp1,
          updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (scope, exchange, symbol) DO UPDATE
         SET atr_period = EXCLUDED.atr_period, atr_interval = EXCLUDED.atr_interval,
             stop_atr_mult = EXCLUDED.stop_atr_mult,
             take_profit_atr_mult = EXCLUDED.take_profit_atr_mult,
             take_profit1_ratio = EXCLUDED.take_profit1_ratio,
             take_profit1_atr_mult = EXCLUDED.take_profit1_atr_mult,
             trail_atr_mult = EXCLUDED.trail_atr_mult,
             breakeven_after_tp1 = EXCLUDED.breakeven_after_tp1,
             updated_at = EXCLUDED.updated_at
       RETURNING ${COLUMNS}`,
      [
        input.scope,
        input.exchange,
        symbol,
        input.atrPeriod,
        input.atrInterval,
        input.stopAtrMult,
        input.takeProfitAtrMult,
        input.takeProfit1Ratio,
        input.takeProfit1AtrMult,
        input.trailAtrMult,
        input.breakevenAfterTp1,
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
      `SELECT ${COLUMNS}
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
        takeProfit1Ratio: row.take_profit1_ratio,
        takeProfit1AtrMult: row.take_profit1_atr_mult,
        trailAtrMult: row.trail_atr_mult,
        breakevenAfterTp1: row.breakeven_after_tp1,
        source: row.scope === 'symbol' ? 'symbol' : 'global',
      };
    }
    // 兜底分支（库里一条都没有）。`trailAtrMult` / `takeProfit1AtrMult` 在这里
    // **显式**取 `stopAtrMult` / `takeProfitAtrMult` 的值——这是「同一个参数的两个
    // 名字」的声明，不是猜：改了止损倍数而没显式写移动止损倍数时，移动止损跟着它走
    // 是用户预期内的，而反过来「两者毫无关联」才是意外。
    return {
      atrPeriod: fallback.atrPeriod,
      atrInterval: fallback.atrInterval,
      stopAtrMult: fallback.stopAtrMult,
      takeProfitAtrMult: fallback.takeProfitAtrMult,
      takeProfit1Ratio: fallback.takeProfit1Ratio,
      takeProfit1AtrMult: fallback.takeProfit1AtrMult,
      trailAtrMult: fallback.trailAtrMult,
      breakevenAfterTp1: fallback.breakevenAfterTp1,
      source: 'config',
    };
  } catch (error) {
    throw toSyncError(error, `解析 ${symbol} 止盈止损策略失败`);
  }
}
