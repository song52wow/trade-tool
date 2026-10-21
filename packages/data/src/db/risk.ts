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

import {
  SyncError,
  type DecisionSource,
  type LlmDecision,
  type PositionSide,
} from '@trade-tool/core';

import { toSyncError } from './errors.js';
import type { Pool } from './pool.js';

// 方向 / 仓位类型只有 core 那一份定义，这里只转出去（AGENTS.md 约定 5）。
export type { PositionSide } from '@trade-tool/core';
// 决策相关类型同样只有 core 那一份（v0.9.0）。
export type { DecisionSource, LlmDecision } from '@trade-tool/core';

/** 固定表名。绝不把 symbol / state 之类拼进 SQL。 */
const TABLE = 'risk_bracket';

const COLUMNS = `exchange, symbol, entry_order_id, entry_price, entry_time, filled_qty,
  position_side, atr, atr_period, atr_interval, atr_window_from, atr_window_to,
  stop_price, take_profit, tp_algo_id, sl_algo_id, state, last_error, created_at, updated_at,
  tp1_algo_id, tp1_qty, tp1_price, tp1_filled_qty, tp1_filled_at,
  trail_extreme, trail_stop_price, trail_atr, trail_atr_from, trail_atr_to,
  trail_updated_at, trail_last_error,
  decision_source, decision_stop_atr_mult, decision_take_profit_atr_mult,
  decision_take_profit1_ratio, decision_trail_atr_mult,
  decision_breakeven_after_tp1, decision_rationale, decision_fallback_reason,
  decision_raw, decision_at,
  closed_qty, exit_notional, fee_amount`;

/**
 * 七个状态。**未终结**的四个：`armed` / `partial_armed` / `trailing` / `failed`。
 *
 * v0.7.0 追加的两个阶段：
 *   * `partial_armed` —— 第一段（带数量）止盈 + `closePosition` 止损都已挂上；
 *   * `trailing`      —— 第一段已成交，剩余仓位只剩一张止损，且它正在移动。
 *
 * 为什么要有 `trailing` 而不是给 `armed` 加个布尔位：它在交易所上的形态是
 * 「**只剩一张单**」，与 `armed`（两张）不同——判据（对账）必须能分开这两种形态，
 * 否则就会每轮报出一条「止盈单不见了」的假警报。
 */
export type BracketState =
  'armed' | 'partial_armed' | 'trailing' | 'take_profit' | 'stop_loss' | 'cancelled' | 'failed';

/** 仍然受保护的（尚未终结的）状态。收窄点只有 `toUnsettledRecord` 一处。 */
export type UnsettledBracketState = Extract<
  BracketState,
  'armed' | 'partial_armed' | 'trailing' | 'failed'
>;

/** 一次待挂止盈止损的意图：只描述「发生了什么成交、算出什么价」。 */
export interface BracketClaim {
  exchange: string;
  symbol: string;
  entryOrderId: string;
  entryPrice: number;
  entryTime: number;
  filledQty: number;
  /**
   * 仓位方向。**只有 LONG / SHORT**——表上的 CHECK 也只允许这两个
   * （`BOTH` 是账户模式，不是仓位方向）。跟着 schema 收窄，
   * 免得下游拿到一个「永远不可能出现」的方向值还照样算盈亏。
   */
  positionSide: 'LONG' | 'SHORT';
  atr: number;
  atrPeriod: number;
  atrInterval: string;
  atrWindowFrom: number;
  atrWindowTo: number;
  stopPrice: number;
  takeProfit: number;
  /**
   * 第一段止盈（v0.7.0）。**只有分批形态才带**：三项必须同时给全，
   * 表上的 `risk_bracket_staged_check` 会挡住缺项的 `partial_armed` 行。
   */
  tp1AlgoId?: number;
  tp1Qty?: number;
  tp1Price?: number;
  /**
   * **入场那笔成交的手续费**（计价币）。
   *
   * 一轮的手续费是「入场 + 各段平仓」的总和——只扣出场那笔，收益会算虚高。
   */
  entryFeeAmount?: number;
  /**
   * 决策留痕（v0.9.0）。**整组可不带**——不带时 `decision_source` 落默认值
   * `'config'`，也就是「按配置挂的」，这与 v0.9.0 之前的行为逐字一致。
   *
   * 带了的时候必须给全 `decision`：表上的 CHECK 会挡住 `source='llm'` 却
   * 缺参数的半截行（那样「模型定的」这句话就是空的，而查档位恰恰靠这些列）。
   */
  decision?: BracketDecision;
  /** 下单时刻（epoch ms），落 created_at / updated_at。 */
  now: number;
}

/**
 * 一段平仓：成交价、数量、手续费。
 *
 * 一轮可能有多段（v0.7.0 的两段模型：先止盈一部分，剩下由移动止损了结），
 * 因此这些量都是**累加**的，不能用「最后一笔覆盖前一笔」——
 * 只算最后一段，净盈亏就只算了一半。
 */
export interface CloseLeg {
  /** 成交价（合约价）。 */
  price: number;
  /** 成交数量（基础币）。 */
  qty: number;
  /** 这一段的手续费（计价币，正数）。 */
  fee: number;
}

/**
 * 一次决策的留痕（v0.9.0）。
 *
 * `source` 决定其余字段的语义，三种取值的差别见 `sql/012_llm_decision.sql` 的注释。
 */
export interface BracketDecision {
  /** 这份档位是从哪来的。 */
  source: DecisionSource;
  /** 实际生效的六个参数。`source='llm'` 时**必填**。 */
  decision?: LlmDecision;
  /** 模型给的理由（人可读）。 */
  rationale?: string;
  /** 降级原因。`source='config-fallback'` 时**必填**。 */
  fallbackReason?: string;
  /** 模型原始返回的正文，原样存。 */
  raw?: string;
  /** 决策时刻（epoch ms）。 */
  at: number;
}

/** 库里的一行。与 `BracketClaim` 分开：`now` 是入参，库里存的是两个时间戳。 */
export interface BracketRecord {
  exchange: string;
  symbol: string;
  entryOrderId: string;
  entryPrice: number;
  entryTime: number;
  filledQty: number;
  /**
   * 仓位方向。**只有 LONG / SHORT**——表上的 CHECK 也只允许这两个
   * （`BOTH` 是账户模式，不是仓位方向）。跟着 schema 收窄，
   * 免得下游拿到一个「永远不可能出现」的方向值还照样算盈亏。
   */
  positionSide: 'LONG' | 'SHORT';
  atr: number;
  atrPeriod: number;
  atrInterval: string;
  atrWindowFrom: number;
  atrWindowTo: number;
  stopPrice: number;
  takeProfit: number;
  tpAlgoId: number | null;
  slAlgoId: number | null;
  state: BracketState;
  lastError: string | null;
  // ---- v0.7.0：第一段止盈与移动止损档位。NULL 语义是「未进入该阶段」，不是 0。
  tp1AlgoId: number | null;
  tp1Qty: number | null;
  tp1Price: number | null;
  tp1FilledQty: number | null;
  tp1FilledAt: number | null;
  /** 持仓期极值：多头是最高 high，空头是最低 low。移动止损的基准。 */
  trailExtreme: number | null;
  /** 当前生效的那一档止损价。`trailing` 阶段必有值。 */
  trailStopPrice: number | null;
  trailAtr: number | null;
  trailAtrFrom: number | null;
  trailAtrTo: number | null;
  trailUpdatedAt: number | null;
  /** 本轮没有移动（或移动失败）的原因。常驻可见，不静默跳过。 */
  trailLastError: string | null;
  // ---- v0.8.0：盈亏的**事实**（累计）。盈亏金额本身不存，由 core 的 realizedPnl() 现算。
  /** 累计平仓量。 */
  closedQty: number;
  /** 累计平仓成交额（计价币）。 */
  exitNotional: number;
  /** 累计手续费（计价币）：入场 + 各段平仓。 */
  feeAmount: number;
  // ---- v0.9.0：决策留痕。回答「这次挂单用的档位是模型定的还是人配的」。
  /** 决策来源。`'llm'` = 模型定的，`'config'` = 按配置，`'config-fallback'` = 降级兜底。 */
  decisionSource: DecisionSource;
  /** 实际生效的倍数。`decisionSource='llm'` 时必有值。 */
  decisionStopAtrMult: number | null;
  decisionTakeProfitAtrMult: number | null;
  decisionTakeProfit1Ratio: number | null;
  decisionTrailAtrMult: number | null;
  decisionBreakevenAfterTp1: boolean | null;
  /** 模型给的理由（人可读）。 */
  decisionRationale: string | null;
  /** 降级原因。`decisionSource='config-fallback'` 时必有值。 */
  decisionFallbackReason: string | null;
  /** 模型原始返回的正文，原样存。 */
  decisionRaw: string | null;
  /** 决策时刻（epoch ms）。 */
  decisionAt: number | null;
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

/** 可空的有限数字。NULL 语义是「未进入该阶段」，不是 0。 */
function optionalNum(row: Record<string, unknown>, field: string, where: string): number | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  return num(row, field, where);
}

function optionalStr(row: Record<string, unknown>, field: string, where: string): string | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  return str(row, field, where);
}

/** 可空的布尔。NULL 语义是「没这项信息」，不是 `false`。 */
function optionalBool(row: Record<string, unknown>, field: string, where: string): boolean | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  throw new SyncError('NULL_NOT_ALLOWED', `${where} 的 ${field} 不是布尔值`, {
    field,
    value,
  });
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
    positionSide: str(row, 'position_side', where) as 'LONG' | 'SHORT',
    atr: num(row, 'atr', where),
    atrPeriod: num(row, 'atr_period', where),
    atrInterval: str(row, 'atr_interval', where),
    atrWindowFrom: bigint(row, 'atr_window_from', where),
    atrWindowTo: bigint(row, 'atr_window_to', where),
    stopPrice: num(row, 'stop_price', where),
    takeProfit: num(row, 'take_profit', where),
    tpAlgoId: optionalBigint(row, 'tp_algo_id', where),
    slAlgoId: optionalBigint(row, 'sl_algo_id', where),
    state: str(row, 'state', where) as BracketState,
    lastError: optionalStr(row, 'last_error', where),
    tp1AlgoId: optionalBigint(row, 'tp1_algo_id', where),
    tp1Qty: optionalNum(row, 'tp1_qty', where),
    tp1Price: optionalNum(row, 'tp1_price', where),
    tp1FilledQty: optionalNum(row, 'tp1_filled_qty', where),
    tp1FilledAt: optionalBigint(row, 'tp1_filled_at', where),
    trailExtreme: optionalNum(row, 'trail_extreme', where),
    trailStopPrice: optionalNum(row, 'trail_stop_price', where),
    trailAtr: optionalNum(row, 'trail_atr', where),
    trailAtrFrom: optionalBigint(row, 'trail_atr_from', where),
    trailAtrTo: optionalBigint(row, 'trail_atr_to', where),
    trailUpdatedAt: optionalBigint(row, 'trail_updated_at', where),
    trailLastError: optionalStr(row, 'trail_last_error', where),
    closedQty: num(row, 'closed_qty', where),
    exitNotional: num(row, 'exit_notional', where),
    feeAmount: num(row, 'fee_amount', where),
    decisionSource: str(row, 'decision_source', where) as DecisionSource,
    decisionStopAtrMult: optionalNum(row, 'decision_stop_atr_mult', where),
    decisionTakeProfitAtrMult: optionalNum(row, 'decision_take_profit_atr_mult', where),
    decisionTakeProfit1Ratio: optionalNum(row, 'decision_take_profit1_ratio', where),
    decisionTrailAtrMult: optionalNum(row, 'decision_trail_atr_mult', where),
    decisionBreakevenAfterTp1: optionalBool(row, 'decision_breakeven_after_tp1', where),
    decisionRationale: optionalStr(row, 'decision_rationale', where),
    decisionFallbackReason: optionalStr(row, 'decision_fallback_reason', where),
    decisionRaw: optionalStr(row, 'decision_raw', where),
    decisionAt: optionalBigint(row, 'decision_at', where),
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
  // 决策留痕（v0.9.0）。不带 `decision` 时落默认的 'config'——也就是
  // 「按配置挂的」，与 v0.9.0 之前逐字一致。
  const decision = claim.decision;
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
    claim.tp1AlgoId ?? null,
    claim.tp1Qty ?? null,
    claim.tp1Price ?? null,
    claim.entryFeeAmount ?? 0,
    decision?.source ?? 'config',
    decision?.decision?.stopAtrMult ?? null,
    decision?.decision?.takeProfitAtrMult ?? null,
    decision?.decision?.takeProfit1Ratio ?? null,
    decision?.decision?.trailAtrMult ?? null,
    decision?.decision?.breakevenAfterTp1 ?? null,
    decision?.rationale ?? null,
    decision?.fallbackReason ?? null,
    decision?.raw ?? null,
    decision?.at ?? null,
    claim.now,
    claim.now,
  ];
  try {
    const result = await pool.query<Record<string, unknown>>(
      `INSERT INTO ${TABLE} (exchange, symbol, entry_order_id, entry_price, entry_time, filled_qty,
         position_side, atr, atr_period, atr_interval, atr_window_from, atr_window_to,
         stop_price, take_profit, tp1_algo_id, tp1_qty, tp1_price, fee_amount, state,
         decision_source, decision_stop_atr_mult, decision_take_profit_atr_mult,
         decision_take_profit1_ratio, decision_trail_atr_mult,
         decision_breakeven_after_tp1, decision_rationale, decision_fallback_reason,
         decision_raw, decision_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 'failed',
               $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30)
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
  orderIds: { tpAlgoId: number; slAlgoId: number },
  now: number,
): Promise<void> {
  try {
    const result = await pool.query(
      `UPDATE ${TABLE} SET tp_algo_id = $4, sl_algo_id = $5, state = 'armed',
         last_error = NULL, updated_at = $6
       WHERE exchange = $1 AND symbol = $2 AND entry_order_id = $3`,
      [key.exchange, key.symbol, key.entryOrderId, orderIds.tpAlgoId, orderIds.slAlgoId, now],
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

/** 已挂上第一段（带数量）与止损两张单。置为 `partial_armed`。 */
export async function markBracketPartialArmed(
  pool: Pool,
  key: { exchange: string; symbol: string; entryOrderId: string },
  orderIds: { slAlgoId: number; tp1AlgoId: number },
  now: number,
): Promise<void> {
  try {
    const result = await pool.query(
      `UPDATE ${TABLE} SET sl_algo_id = $4, tp1_algo_id = $5, state = 'partial_armed',
         last_error = NULL, updated_at = $6
       WHERE exchange = $1 AND symbol = $2 AND entry_order_id = $3`,
      [key.exchange, key.symbol, key.entryOrderId, orderIds.slAlgoId, orderIds.tp1AlgoId, now],
    );
    if (result.rowCount !== 1) {
      throw new SyncError(
        'SYNC_ALREADY_RUNNING',
        `止盈止损记录不存在，无法标记为已挂上第一段：${key.symbol} ${key.entryOrderId}`,
        key as unknown as Record<string, unknown>,
      );
    }
  } catch (error) {
    throw toSyncError(error, `回填第一段止盈订单号失败：${key.symbol} ${key.entryOrderId}`);
  }
}

/**
 * 记下「第一段止盈已成交」这个**事实**，并把这一段的平仓事实累加进去。
 *
 * 为什么单独一个函数（v0.9.1 补）：**成交了就是成交了**，它不依赖于「能不能算出移动止损」。
 * 早先这条事实只在 `markBracketTrailing` 里落库，而那是「推进到 trailing 阶段」
 * 的副作用——于是**推进失败时，这一段成交的事实就整个丢了**：成交价、数量、手续费
 * 都没记，盈亏少算一段；更糟的是，**没有任何东西能证明「TP1 成交过」**，
 * 于是「推进失败 → 永远不会被重试」——记录卡在 `partial_armed` 直到仓位被手工平掉。
 *
 * `tp1_filled_qty` / `tp1_filled_at` 这两列（迁移 `010` 加的）此前**没有任何代码写过**，
 * 它们就是为这件事留的位置：它们是「TP1 已成交」的**持久标记**，
 * 移动止损定时器靠它认领「等推进」的那些行。
 *
 * **幂等**：`WHERE … AND tp1_filled_at IS NULL`。用户数据流会重投事件
 * （listenKey 续期、断线重连），重投时不能把这一段再累加一次——
 * 累加两次算出来的净盈亏是错的，而且错得看不出来。
 *
 * **不改 state**：它记的是事实，不是阶段。阶段由 {@link markBracketTrailing} 推进。
 */
export async function recordBracketTp1Fill(
  pool: Pool,
  key: { exchange: string; symbol: string; entryOrderId: string },
  leg: CloseLeg,
  now: number,
): Promise<number> {
  try {
    const result = await pool.query(
      `UPDATE ${TABLE} SET tp1_filled_qty = $4, tp1_filled_at = $5,
         closed_qty = closed_qty + $6,
         exit_notional = exit_notional + $7,
         fee_amount = fee_amount + $8,
         updated_at = $5
       WHERE exchange = $1 AND symbol = $2 AND entry_order_id = $3
         AND tp1_filled_at IS NULL`,
      [
        key.exchange,
        key.symbol,
        key.entryOrderId,
        leg.qty,
        now,
        leg.qty,
        leg.price * leg.qty,
        leg.fee,
      ],
    );
    return result.rowCount ?? 0;
  } catch (caught) {
    throw toSyncError(caught, `记录第一段止盈成交事实失败：${key.symbol} ${key.entryOrderId}`);
  }
}

/**
 * 第一段已成交：进入 `trailing`，同时落**这一轮观测到的**极值与 ATR 快照。
 *
 * 为什么先落库再动交易所（AGENTS.md §6.3 第 4 条 / v0.7.0 R-5.4）：进程死在
 * 「已置 `trailing`、还没挂新止损」时，记录停在 `trailing`、止损还在进场那一档，
 * 移动止损定时器下一轮补挂（它按 `trail_stop_price` 重新算，价没变就不动单）。
 * 反过来（先挂单后落库），崩在中间就是「止损已经换了但库里还是旧档位」，
 * 账面与交易所永久对不上。
 *
 * ⚠️ `trail.stopPrice` 传进来的必须是**交易所上那张止损单现在的价**，不是
 * 「这一轮打算挪到的那一档」。这条口径让「库里记的」与「交易所挂着的」永远是
 * 同一件事：对账（§6.5）拿 `trail_stop_price` 比价才不会一直报价格不符，
 * 而「阶段推进了、价位还没挪」这一格是**可修**的（定时器下一轮接着挪），
 * 「价位写了、单还没挂」那一格不是。
 *
 * ⚠️ `WHERE … AND state = 'partial_armed'`：**只有**还停在这一态才推进。
 * 事件重放（listenKey 续期、断线重连）会让 TP1 成交事件再来一次，
 * 而不带这个条件，第二次会把止损**重挂一遍**——止盈止损是会真实下单的动作。
 *
 * **平仓事实不在这里累加**：它由 {@link recordBracketTp1Fill} 单独记一次
 * （幂等，且推进失败时也不会丢）。这里只管阶段与观测。
 *
 * **返回 rowCount**：调用方据此判断「这次真的推进了」还是「已经被推进过了」。
 */
export async function markBracketTrailing(
  pool: Pool,
  key: { exchange: string; symbol: string; entryOrderId: string },
  trail: {
    extreme: number;
    stopPrice: number;
    atr: number;
    atrFrom: number;
    atrTo: number;
    slAlgoId?: number;
  },
  now: number,
): Promise<number> {
  try {
    const result = await pool.query(
      `UPDATE ${TABLE} SET state = 'trailing',
         trail_extreme = $4, trail_stop_price = $5, trail_atr = $6,
         trail_atr_from = $7, trail_atr_to = $8, trail_updated_at = $9,
         sl_algo_id = COALESCE($10, sl_algo_id),
         last_error = NULL, trail_last_error = NULL, updated_at = $9
       WHERE exchange = $1 AND symbol = $2 AND entry_order_id = $3
         AND state = 'partial_armed'`,
      [
        key.exchange,
        key.symbol,
        key.entryOrderId,
        trail.extreme,
        trail.stopPrice,
        trail.atr,
        trail.atrFrom,
        trail.atrTo,
        now,
        trail.slAlgoId ?? null,
      ],
    );
    return result.rowCount ?? 0;
  } catch (caught) {
    throw toSyncError(caught, `推进到移动止损阶段失败：${key.symbol} ${key.entryOrderId}`);
  }
}

/**
 * 记一次「本轮没有移动」或「移动没能完成」，`trail_stop_price` 与止损单号都**不变**。
 *
 * 「没有移动」不是失败：价没变、止损位越过现价、极值取不到，都属于「本轮不动」，
 * 而它们必须**常驻可见**（AGENTS.md 约定 9）。写成 NULL 或清空原因，
 * 就会退化成「看起来一切正常，而追踪其实已经停了三天」。
 *
 * ⚠️ `WHERE` 同时接受 `partial_armed`：第一段刚成交、推进 `trailing` 就失败时，
 * 记录还停在 `partial_armed`。只接受 `trailing` 的话，那次失败的原因会被**静默丢弃**
 * ——正是「看起来正常、而移动止损其实没启动」的那一类。
 */
export async function markBracketTrailNotMoved(
  pool: Pool,
  key: { exchange: string; symbol: string; entryOrderId: string },
  reason: string,
  now: number,
  observed?: { extreme: number; atr: number; atrFrom: number; atrTo: number },
): Promise<void> {
  try {
    await pool.query(
      `UPDATE ${TABLE} SET trail_last_error = $4, trail_updated_at = $5, updated_at = $5,
         trail_extreme = COALESCE($6, trail_extreme),
         trail_atr = COALESCE($7, trail_atr),
         trail_atr_from = COALESCE($8, trail_atr_from),
         trail_atr_to = COALESCE($9, trail_atr_to)
       WHERE exchange = $1 AND symbol = $2 AND entry_order_id = $3
         AND state IN ('partial_armed', 'trailing')`,
      [
        key.exchange,
        key.symbol,
        key.entryOrderId,
        reason,
        now,
        observed?.extreme ?? null,
        observed?.atr ?? null,
        observed?.atrFrom ?? null,
        observed?.atrTo ?? null,
      ],
    );
  } catch (caught) {
    throw toSyncError(caught, `记录移动止损未调整原因时出错：${key.symbol} ${key.entryOrderId}`);
  }
}

/**
 * 移动止损**成功换档**：先挂新止损、再撤旧单，两件事都做完后才写这里。
 *
 * 顺序由调用方保证（R-4.1），本函数只负责「落新的档位」。
 * 因此 `slAlgoId` 必填：没有它就说明新止损还没挂上，而把档位写成新价、
 * 却让交易所挂着旧价的单，是最坏的一种不一致。
 */
export async function markBracketTrailMoved(
  pool: Pool,
  key: { exchange: string; symbol: string; entryOrderId: string },
  moved: {
    stopPrice: number;
    extreme: number;
    atr: number;
    atrFrom: number;
    atrTo: number;
    slAlgoId: number;
  },
  now: number,
): Promise<void> {
  try {
    await pool.query(
      `UPDATE ${TABLE} SET trail_stop_price = $4, trail_extreme = $5, trail_atr = $6,
         trail_atr_from = $7, trail_atr_to = $8, trail_updated_at = $9, sl_algo_id = $10,
         trail_last_error = NULL, updated_at = $9
       WHERE exchange = $1 AND symbol = $2 AND entry_order_id = $3 AND state = 'trailing'`,
      [
        key.exchange,
        key.symbol,
        key.entryOrderId,
        moved.stopPrice,
        moved.extreme,
        moved.atr,
        moved.atrFrom,
        moved.atrTo,
        now,
        moved.slAlgoId,
      ],
    );
  } catch (caught) {
    throw toSyncError(caught, `回填移动止损新档位失败：${key.symbol} ${key.entryOrderId}`);
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
  error: { tpAlgoId?: number; slAlgoId?: number },
  reason: string,
  now: number,
): Promise<void> {
  try {
    await pool.query(
      `UPDATE ${TABLE} SET state = 'failed', last_error = $4,
         tp_algo_id = COALESCE($5, tp_algo_id), sl_algo_id = COALESCE($6, sl_algo_id),
         updated_at = $7
       WHERE exchange = $1 AND symbol = $2 AND entry_order_id = $3`,
      [
        key.exchange,
        key.symbol,
        key.entryOrderId,
        reason,
        error.tpAlgoId ?? null,
        error.slAlgoId ?? null,
        now,
      ],
    );
  } catch (caught) {
    throw toSyncError(caught, `记录止盈止损失败原因时出错：${key.symbol} ${key.entryOrderId}`);
  }
}

/**
 * 落最终状态。
 *
 * **返回实际更新的行数**——调用方据此判断「这次真的收敛了一条」还是
 * 「别人已经收敛过了」。`ACCOUNT_UPDATE` 的归零收敛与止盈止损成算是两条并发路径，
 * 两者都会查同一批未终结记录；不返回 rowCount 的话两条路径都会打出
 * 「1 条置为 cancelled」，而实际只更新了一次——日志会骗人。
 *
 * ⚠️ **`WHERE` 带上「只结算未终结的行」这道闸**：用户数据流会重放事件（续期、重连），
 * 而平仓的量与成交额是**累加**的——重放一次就多算一次，净盈亏直接错一半。
 * 已经终结的行不再被更新，返回的 rowCount 也就是 0，调用方据此不重复通知。
 */
export async function markBracketSettled(
  pool: Pool,
  key: { exchange: string; symbol: string; entryOrderId: string },
  state: Extract<BracketState, 'take_profit' | 'stop_loss' | 'cancelled'>,
  now: number,
  /**
   * 这一段平仓的事实（成交价 / 数量 / 手续费）。
   *
   * **没有它就没有实际盈亏**：实际盈亏 = 累计成交额 − 入场成本 − 累计手续费，
   * 三个数都得从平仓的事实里来。工具外平仓（`cancelled`）没有我们的成交，
   * 传 `undefined` 即可——那笔盈亏**算不出来**，如实不算，不拿 0 冒充。
   */
  leg?: CloseLeg,
): Promise<number> {
  try {
    const result = await pool.query(
      `UPDATE ${TABLE} SET state = $4, updated_at = $5,
         closed_qty = closed_qty + $6,
         exit_notional = exit_notional + $7,
         fee_amount = fee_amount + $8
       WHERE exchange = $1 AND symbol = $2 AND entry_order_id = $3
         AND state IN ('armed', 'partial_armed', 'trailing', 'failed')`,
      [
        key.exchange,
        key.symbol,
        key.entryOrderId,
        state,
        now,
        leg?.qty ?? 0,
        leg === undefined ? 0 : leg.price * leg.qty,
        leg?.fee ?? 0,
      ],
    );
    return result.rowCount ?? 0;
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

/**
 * 未终结记录的返回类型：`state` **窄化**为四态。
 *
 * 窄化不是洁癖：`state` 若是完整的七态类型，`reconcileBrackets` 里那个
 * 「不是 failed 就当 armed」的分支就会在运行时悄悄把一条已终结记录当成未终结的，
 * 凭空报出「止损单不见了」。这里用同一个取值函数把类型收窄，转换点只有一处。
 */
export type UnsettledBracketRecord = Omit<BracketRecord, 'state' | 'positionSide'> & {
  state: UnsettledBracketState;
  /** 表上的 CHECK 约束只允许 LONG / SHORT，这里把它显式收窄而不是靠调用方相信。 */
  positionSide: Extract<PositionSide, 'LONG' | 'SHORT'>;
};

const UNSETTLED_STATES = ['armed', 'partial_armed', 'trailing', 'failed'] as const;

function toUnsettledRecord(row: Record<string, unknown>): UnsettledBracketRecord {
  const record = toRecord(row);
  if (!UNSETTLED_STATES.includes(record.state as UnsettledBracketState)) {
    // WHERE 已经限定了这几态，能走到这里说明约束被绕过或查询被改坏了。
    // 抛错而不是当成 armed —— 那正是上面说的假警报来源（AGENTS.md 约定 9）。
    throw new SyncError(
      'CONFIG_INVALID',
      `listUnsettledBrackets 收到非未终结状态：${record.state}`,
      {
        state: record.state,
      },
    );
  }
  if (record.positionSide !== 'LONG' && record.positionSide !== 'SHORT') {
    throw new SyncError(
      'CONFIG_INVALID',
      `listUnsettledBrackets 收到非法仓位方向：${record.positionSide}`,
      { positionSide: record.positionSide },
    );
  }
  // 上面那个 includes 检查已经把取值范围钉死了，但 TS 不会从 `includes` 反推窄化，
  // 所以这里的断言是**检查过之后**的收窄，不是绕过检查。
  return {
    ...record,
    state: record.state as UnsettledBracketState,
    positionSide: record.positionSide,
  };
}

/**
 * 未终结的记录（`armed` / `partial_armed` / `trailing` / `failed`），对账与定时器都用。
 *
 * 为什么只取这几态：`take_profit` / `stop_loss` / `cancelled` 的单**本来就该不在**
 * 交易所，把它们一起拉进来会凭空造出一堆「少了止损单」的假警报。
 *
 * ⚠️ `trailing` 与 `partial_armed` 在交易所上的**形态不同**（一张 vs 两张单），
 * 判据必须按形态分流（v0.7.0 R-10）——把四态当一态处理，报告就会同时漏真问题、
 * 报一堆假警报。
 *
 * `symbol` 为空串时查全部标的（对账要支持全账户扫描）。表名仍是常量，绝不拼 symbol。
 */
export async function listUnsettledBrackets(
  pool: Pool,
  exchange: string,
  symbol?: string,
): Promise<UnsettledBracketRecord[]> {
  try {
    const result = await pool.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM ${TABLE} WHERE exchange = $1
         AND state IN ('armed', 'partial_armed', 'trailing', 'failed')
         ${symbol === undefined ? '' : 'AND symbol = $2'}
       ORDER BY updated_at DESC`,
      symbol === undefined ? [exchange] : [exchange, symbol],
    );
    return result.rows.map(toUnsettledRecord);
  } catch (error) {
    throw toSyncError(error, `读取未终结的止盈止损记录失败${symbol ?? ''}`);
  }
}

/**
 * 移动止损定时器的工作集合。
 *
 * **两类行**（v0.9.1 补）：
 *
 * 1. `trailing` —— 已经在移动止损里的（含 `sl_algo_id` 还没回填、等着补挂的那种）。
 * 2. `partial_armed` 且 **`tp1_filled_at` 非空** —— 第一段止盈**已经成交**、
 *    但当时没能推进到 `trailing` 的那些行。它们的成交事实已经落库
 *    （`recordBracketTp1Fill`），所以「该推进」这件事是**已提交但没做完**的意图，
 *    定时器有权续做。
 *
 * 为什么第 2 类必须有（2026-10-21 实测踩到）：推进失败时记录停在 `partial_armed`，
 * 而早先的定时器只取 `trailing` ——于是**没有任何东西会重试它**。
 * 失败原因写进了 `trail_last_error`，看着「有原因、很安全」，实际上那一笔仓位
 * 永远进不了移动止损：止损位不跟着价格上移，而人只会看到一行报错。
 * 「当时算不出来」是**暂时**的（行情没同步到开仓之后那种），过一会儿就该重试。
 *
 * ⚠️ `partial_armed` 但 `tp1_filled_at` 为空的那行**不在**这里：
 * 那是「TP1 还没成交」，属于进场保护，止损不该被移动（§6.8 第 3 条）。
 */
export async function listTrailingBrackets(
  pool: Pool,
  exchange: string,
  now: number,
): Promise<UnsettledBracketRecord[]> {
  const all = await listUnsettledBrackets(pool, exchange);
  // 定时器可能正在补挂一条刚置为 trailing 的记录（含 sl_algo_id 还没回填的那种）。
  // **不按 updated_at 过滤**：崩溃后重启时，旧记录当然很旧，而它正是要补的对象。
  return all.filter(
    (record) =>
      (record.state === 'trailing' && record.entryTime <= now) ||
      (record.state === 'partial_armed' && record.tp1FilledAt !== null),
  );
}

/** 七态计数，**七项永远都在**，没有的态是 0。
 *
 * 为什么要一份独立的统计而不是从 `listBrackets` 的结果里数：控制面只回最近 N 条，
 * 而 `failed` 恰恰是最老、最容易被挤出这个窗口的状态——库里有一条「占坑成功但保护单
 * 没挂上」的记录，页面上却因为它不在前 20 条而显示一切正常。用截断过的列表反推完整
 * 状态，正是 v0.4.0 要防的那种「看上去没事」。
 *
 * `state` 在 DDL 里是 CHECK 约束列，这里仍按已知七态建桶：真出现未知值说明约束被绕过
 * 了，那属于要暴露的问题，因此直接抛错而不是悄悄归到某个态里（AGENTS.md 约定 9）。
 */
export async function countBracketsByState(
  pool: Pool,
  exchange: string,
  symbol: string,
): Promise<Record<BracketState, number>> {
  try {
    const result = await pool.query<{ state: string; n: string }>(
      `SELECT state, COUNT(*)::text AS n FROM ${TABLE}
       WHERE exchange = $1 AND symbol = $2 GROUP BY state`,
      [exchange, symbol],
    );
    const counts: Record<BracketState, number> = {
      armed: 0,
      partial_armed: 0,
      trailing: 0,
      take_profit: 0,
      stop_loss: 0,
      cancelled: 0,
      failed: 0,
    };
    for (const row of result.rows) {
      const key = row.state as BracketState;
      if (!(key in counts)) {
        throw new SyncError('CONFIG_INVALID', `risk_bracket 出现未知状态：${row.state}`, {
          state: row.state,
        });
      }
      counts[key] = Number(row.n);
    }
    return counts;
  } catch (error) {
    if (error instanceof SyncError) throw error;
    throw toSyncError(error, `统计 ${symbol} 止盈止损状态失败`);
  }
}
