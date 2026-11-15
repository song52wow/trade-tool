/**
 * 链上仓位的读写（v1.2.0）。
 *
 * ## 边界
 *
 * * **只有 packages/data 能写库**（AGENTS.md 约定 11）。`apps/chain-monitor` 与
 *   控制面都走这里的函数，不各自连 PG。
 * * **这一层不碰链上**：链上事实由 `packages/data/src/bsc-v3.ts` 读，
 *   算账由 `packages/core/src/chain-v3.ts` 算，这里只负责落库与读出。
 * * **schema 的唯一来源是 `packages/data/sql/026_chain_position.sql`**：
 *   这里不另持一份列定义（AGENTS.md 约定 3）。
 *
 * ## 为什么金额用 numeric、价格用 double precision
 *
 * 代币数量是 18 位小数（1e18 量级），**超出 double precision 能精确表示的范围**
 * （2^53 ≈ 9e15）；用 double 会悄悄丢掉低位，而低位正是「这个仓位里到底有多少币」。
 * 价格与盈亏是给人看的两位小数，用 double precision 与本仓库其它表一致。
 */

import { CHAIN_APY_WINDOW_MS, SyncError } from '@trade-tool/core';

import { toSyncError } from './errors.js';
import type { Pool } from './pool.js';

/** 一笔被监控的仓位（配置 + 滚动状态 + 最近一次采样）。 */
export interface ChainPositionViewRow {
  positionKey: string;
  chain: string;
  positionManager: string;
  pool: string;
  token0: string;
  token1: string;
  tokenId: string;
  owner: string;
  tickLower: number;
  tickUpper: number;
  symbol0: string | null;
  symbol1: string | null;
  /** 投入时两个币的数量（原始单位，字符串）。 */
  depositAmount0: string;
  depositAmount1: string;
  depositTx: string | null;
  costUsdt: number;
  realizedUsdt: number;
  lastAlertPrice: number | null;
  lastAlertPnlPct: number | null;
  lastAlertAt: number | null;
  baselineDone: boolean;
  lastPollAt: number | null;
  lastError: string | null;
  /** 最近一次采样（没有采样过时为 null）。 */
  lastTs: number | null;
  lastBlock: string | null;
  lastPrice: number | null;
  lastValueUsdt: number | null;
  lastPnlUsdt: number | null;
  lastPnlPct: number | null;
  lastFeeUsdt: number | null;
  lastInRange: boolean | null;
  lastAmount0: string | null;
  lastAmount1: string | null;
  /**
   * **上一轮**记下的流动性（滚动状态）。
   *
   * 用来发现「有人加仓 / 减仓」：它与本轮采样里的流动性一比就知道变没变。
   * ⚠️ 它与「最近一次采样里的流动性」（`snapshotLiquidity`）**不是一回事**——
   * 2026-11-11 实测踩过：两者在 SQL 里同名（`s.liquidity AS last_liquidity`
   * 撞上了表里的 `last_liquidity` 列），后出现的那个把前一个盖掉了，
   * 于是「上一轮的值」永远是「这一轮的值」→ 加减仓与清空**都检测不出来**。
   */
  lastLiquidity: string | null;
  /** 最近一次采样里的流动性（当前值）。 */
  snapshotLiquidity: string | null;
  /**
   * **年化窗口起点**那次采样的时刻与累计手续费。
   *
   * 取的是「最新一次采样往前 7 天里最早的那一条」——这样窗口长度天然是
   * 「最近 7 天」，而不是「从第一次采样到现在」（那会把很久以前的行情也算进去，
   * 说成「当前年化」就是骗人）。
   */
  windowTs: number | null;
  windowFeeUsdt: number | null;
}

/** 一次采样的结果。 */
export interface ChainSnapshotRow {
  ts: number;
  block: string;
  price: number;
  amount0: string;
  amount1: string;
  valueUsdt: number;
  costUsdt: number;
  realizedUsdt: number;
  pnlUsdt: number;
  pnlPct: number;
  feeUsdt: number;
  inRange: boolean;
  liquidity: string;
}

/** 一条告警记录。 */
export interface ChainAlertRow {
  ts: number;
  reasons: string;
  sent: boolean;
  detail: Record<string, unknown> | null;
}

/** 滚动状态里可以改的字段。 */
export interface ChainPositionStatePatch {
  costUsdt?: number;
  realizedUsdt?: number;
  lastAlertPrice?: number | null;
  lastAlertPnlPct?: number | null;
  lastAlertAt?: number | null;
  lastLiquidity?: string | null;
  inRange?: boolean | null;
  baselineDone?: boolean;
  lastPollAt?: number | null;
  lastError?: string | null;
}

interface PositionRow {
  position_key: string;
  chain: string;
  position_manager: string;
  pool: string;
  token0: string;
  token1: string;
  token_id: string;
  owner: string;
  tick_lower: number;
  tick_upper: number;
  symbol0: string | null;
  symbol1: string | null;
  deposit_amount0: string;
  deposit_amount1: string;
  deposit_tx: string | null;
  cost_usdt: number;
  realized_usdt: number;
  last_alert_price: number | null;
  last_alert_pnl_pct: number | null;
  last_alert_at: string | null;
  last_liquidity: string | null;
  in_range: boolean | null;
  baseline_done: boolean;
  last_poll_at: string | null;
  last_error: string | null;
}

interface SnapshotRow {
  ts: string;
  block: string;
  price: number;
  amount0: string;
  amount1: string;
  value_usdt: number;
  cost_usdt: number;
  realized_usdt: number;
  pnl_usdt: number;
  pnl_pct: number;
  fee_usdt: number;
  in_range: boolean;
  liquidity: string;
}

function ms(value: string | null): number | null {
  if (value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 登记 / 更新一笔被监控的仓位（monitor 侧）。
 *
 * 用 upsert 而不是 insert：配置改了（换了池子、换了 tokenId）之后，
 * 重启服务不该因为「这行已经存在」而失败。**但滚动状态不被覆盖**——
 * 成本、已实现盈亏、上次推送的基准都是**账**，配置重写不该把账抹掉。
 */
export async function upsertChainPosition(
  pool: Pool,
  input: {
    positionKey: string;
    chain: string;
    positionManager: string;
    pool: string;
    token0: string;
    token1: string;
    tokenId: string;
    owner: string;
    tickLower: number;
    tickUpper: number;
    symbol0?: string | null;
    symbol1?: string | null;
    depositAmount0: string;
    depositAmount1: string;
    depositTx?: string | null;
    nowMs?: number;
  },
): Promise<void> {
  const now = input.nowMs ?? Date.now();
  try {
    await pool.query(
      `INSERT INTO chain_position
         (position_key, chain, position_manager, pool, token0, token1, token_id, owner,
          tick_lower, tick_upper, symbol0, symbol1, deposit_amount0, deposit_amount1,
          deposit_tx, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)
       ON CONFLICT (position_key) DO UPDATE
         SET chain = EXCLUDED.chain,
             position_manager = EXCLUDED.position_manager,
             pool = EXCLUDED.pool,
             token0 = EXCLUDED.token0,
             token1 = EXCLUDED.token1,
             token_id = EXCLUDED.token_id,
             owner = EXCLUDED.owner,
             tick_lower = EXCLUDED.tick_lower,
             tick_upper = EXCLUDED.tick_upper,
             symbol0 = EXCLUDED.symbol0,
             symbol1 = EXCLUDED.symbol1,
             deposit_amount0 = EXCLUDED.deposit_amount0,
             deposit_amount1 = EXCLUDED.deposit_amount1,
             deposit_tx = EXCLUDED.deposit_tx,
             updated_at = EXCLUDED.updated_at`,
      [
        input.positionKey,
        input.chain,
        input.positionManager,
        input.pool,
        input.token0,
        input.token1,
        input.tokenId,
        input.owner,
        input.tickLower,
        input.tickUpper,
        input.symbol0 ?? null,
        input.symbol1 ?? null,
        input.depositAmount0,
        input.depositAmount1,
        input.depositTx ?? null,
        now,
      ],
    );
  } catch (error) {
    throw toSyncError(error, '登记链上仓位失败');
  }
}

/**
 * 更新滚动状态（monitor 侧）。
 *
 * 「上次推送」的三项与其它状态**分开写**：推送失败时不该更新那三项
 * （没发出去就不能当成「已经说过」），而成本、流动性这些**照常更新**
 * （账要继续往下滚，与推没推出去无关）。
 */
export async function updateChainPositionState(
  pool: Pool,
  positionKey: string,
  patch: ChainPositionStatePatch,
): Promise<void> {
  const sets: string[] = ['updated_at = $2'];
  const values: unknown[] = [positionKey, Date.now()];
  const push = (column: string, value: unknown): void => {
    values.push(value);
    sets.push(`${column} = $${String(values.length)}`);
  };
  if (patch.costUsdt !== undefined) push('cost_usdt', patch.costUsdt);
  if (patch.realizedUsdt !== undefined) push('realized_usdt', patch.realizedUsdt);
  if (patch.lastLiquidity !== undefined) push('last_liquidity', patch.lastLiquidity);
  if (patch.inRange !== undefined) push('in_range', patch.inRange);
  if (patch.baselineDone !== undefined) push('baseline_done', patch.baselineDone);
  if (patch.lastPollAt !== undefined) push('last_poll_at', patch.lastPollAt);
  if (patch.lastError !== undefined) push('last_error', patch.lastError);
  try {
    await pool.query(
      `UPDATE chain_position SET ${sets.join(', ')} WHERE position_key = $1`,
      values,
    );
  } catch (error) {
    throw toSyncError(error, '更新链上仓位状态失败');
  }
}

/** 记录「上次推送」的基准（只有**真的推出去**时才调）。 */
export async function markChainPositionAlerted(
  pool: Pool,
  positionKey: string,
  input: { price: number; pnlPct: number; atMs: number },
): Promise<void> {
  try {
    await pool.query(
      `UPDATE chain_position
          SET last_alert_price = $2,
              last_alert_pnl_pct = $3,
              last_alert_at = $4,
              updated_at = $4
        WHERE position_key = $1`,
      [positionKey, input.price, input.pnlPct, input.atMs],
    );
  } catch (error) {
    throw toSyncError(error, '记录链上仓位告警基准失败');
  }
}

/** 写一次采样。 */
export async function insertChainSnapshot(
  pool: Pool,
  input: {
    positionKey: string;
    ts: number;
    block: bigint;
    price: number;
    amount0: bigint;
    amount1: bigint;
    valueUsdt: number;
    costUsdt: number;
    realizedUsdt: number;
    pnlUsdt: number;
    pnlPct: number;
    feeUsdt: number;
    inRange: boolean;
    liquidity: bigint;
  },
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO chain_position_snapshot
         (position_key, ts, block, price, amount0, amount1, value_usdt, cost_usdt,
          realized_usdt, pnl_usdt, pnl_pct, fee_usdt, in_range, liquidity)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        input.positionKey,
        input.ts,
        input.block.toString(),
        input.price,
        input.amount0.toString(),
        input.amount1.toString(),
        input.valueUsdt,
        input.costUsdt,
        input.realizedUsdt,
        input.pnlUsdt,
        input.pnlPct,
        input.feeUsdt,
        input.inRange,
        input.liquidity.toString(),
      ],
    );
  } catch (error) {
    throw toSyncError(error, '写入链上仓位采样失败');
  }
}

/** 写一条告警记录（**推送失败也要写**）。 */
export async function insertChainAlert(
  pool: Pool,
  input: {
    positionKey: string;
    ts: number;
    reasons: string;
    sent: boolean;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO chain_position_alert (position_key, ts, reasons, sent, detail)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        input.positionKey,
        input.ts,
        input.reasons,
        input.sent,
        input.detail === undefined ? null : JSON.stringify(input.detail),
      ],
    );
  } catch (error) {
    throw toSyncError(error, '写入链上仓位告警记录失败');
  }
}

function mapPosition(row: PositionRow & Record<string, unknown>): ChainPositionViewRow {
  return {
    positionKey: row.position_key,
    chain: row.chain,
    positionManager: row.position_manager,
    pool: row.pool,
    token0: row.token0,
    token1: row.token1,
    tokenId: row.token_id,
    owner: row.owner,
    tickLower: row.tick_lower,
    tickUpper: row.tick_upper,
    symbol0: row.symbol0,
    symbol1: row.symbol1,
    depositAmount0: row.deposit_amount0,
    depositAmount1: row.deposit_amount1,
    depositTx: row.deposit_tx,
    costUsdt: row.cost_usdt,
    realizedUsdt: row.realized_usdt,
    lastAlertPrice: row.last_alert_price,
    lastAlertPnlPct: row.last_alert_pnl_pct,
    lastAlertAt: ms(row.last_alert_at),
    baselineDone: row.baseline_done,
    lastPollAt: ms(row.last_poll_at),
    lastError: row.last_error,
    lastTs: ms((row['last_ts'] as string | null) ?? null),
    lastBlock: (row['last_block'] as string | null) ?? null,
    lastPrice: (row['last_price'] as number | null) ?? null,
    lastValueUsdt: (row['last_value_usdt'] as number | null) ?? null,
    lastPnlUsdt: (row['last_pnl_usdt'] as number | null) ?? null,
    lastPnlPct: (row['last_pnl_pct'] as number | null) ?? null,
    lastFeeUsdt: (row['last_fee_usdt'] as number | null) ?? null,
    lastInRange: (row['last_in_range'] as boolean | null) ?? null,
    lastAmount0: (row['last_amount0'] as string | null) ?? null,
    lastAmount1: (row['last_amount1'] as string | null) ?? null,
    lastLiquidity: row.last_liquidity,
    snapshotLiquidity: (row['snapshot_liquidity'] as string | null) ?? null,
    windowTs: ms((row['window_ts'] as string | null) ?? null),
    windowFeeUsdt: (row['window_fee_usdt'] as number | null) ?? null,
  };
}

/**
 * 列出被监控的仓位（控制面侧）。
 *
 * 最近一次采样用 `LEFT JOIN LATERAL` 取：页面要显示「现在什么价、赚没赚」，
 * 而这些数字在采样表里——分成两次查询再拼，前端就会看到「仓位」与「数字」对不上的中间态。
 *
 * ⚠️ **第二个 `LEFT JOIN LATERAL` 是年化窗口的起点**（最近 7 天里最早的一条采样）。
 * 它引用了前一个 LATERAL 的 `s.ts`（Postgres 允许 LATERAL 引用前面的 FROM 项），
 * 于是窗口永远是「以最后一次采样为准的最近 7 天」——监控停过几天时，
 * 窗口跟着最后一条采样走，而不是停在墙上。
 */
export async function listChainPositions(pool: Pool): Promise<ChainPositionViewRow[]> {
  let rows: (PositionRow & Record<string, unknown>)[];
  try {
    const result = await pool.query(
      `SELECT p.*,
              s.ts           AS last_ts,
              s.block        AS last_block,
              s.price        AS last_price,
              s.amount0      AS last_amount0,
              s.amount1      AS last_amount1,
              s.value_usdt   AS last_value_usdt,
              s.pnl_usdt     AS last_pnl_usdt,
              s.pnl_pct      AS last_pnl_pct,
              s.fee_usdt     AS last_fee_usdt,
              s.in_range     AS last_in_range,
              s.liquidity    AS snapshot_liquidity,
              w.ts           AS window_ts,
              w.fee_usdt     AS window_fee_usdt
         FROM chain_position p
         LEFT JOIN LATERAL (
           SELECT * FROM chain_position_snapshot s
            WHERE s.position_key = p.position_key
            ORDER BY s.ts DESC, s.id DESC
            LIMIT 1
         ) s ON true
         LEFT JOIN LATERAL (
           SELECT ts, fee_usdt FROM chain_position_snapshot
            WHERE position_key = p.position_key
              AND ts >= s.ts - $1
            ORDER BY ts ASC, id ASC
            LIMIT 1
         ) w ON true
        ORDER BY p.created_at`,
      [CHAIN_APY_WINDOW_MS],
    );
    rows = result.rows as (PositionRow & Record<string, unknown>)[];
  } catch (error) {
    throw toSyncError(error, '读链上仓位列表失败');
  }

  return rows.map(mapPosition);
}

/**
 * 按「仓位管理器 + tokenId」找一笔仓位。
 *
 * 用途：**读取失败时也要把错误写到对应的那一行上**。
 * 仓位 key 需要 tick 区间才算得出来，而读失败的时候恰恰拿不到 tick——
 * 于是退回到「管理器 + tokenId」这个次级标识（配置里就有）。
 */
export async function readChainPositionByToken(
  pool: Pool,
  positionManager: string,
  tokenId: string,
): Promise<ChainPositionViewRow | null> {
  try {
    const result = await pool.query(
      `SELECT * FROM chain_position WHERE position_manager = $1 AND token_id = $2 LIMIT 1`,
      [positionManager, tokenId],
    );
    const row = result.rows[0] as (PositionRow & Record<string, unknown>) | undefined;
    return row === undefined ? null : mapPosition(row);
  } catch (error) {
    throw toSyncError(error, '按 tokenId 读链上仓位失败');
  }
}

/** 读一笔仓位的滚动状态（monitor 侧）。 */
export async function readChainPositionState(
  pool: Pool,
  positionKey: string,
): Promise<ChainPositionViewRow | null> {
  const all = await listChainPositions(pool);
  return all.find((row) => row.positionKey === positionKey) ?? null;
}

/** 历史采样（控制面侧画曲线用）。 */
export async function listChainSnapshots(
  pool: Pool,
  positionKey: string,
  limit = 200,
): Promise<ChainSnapshotRow[]> {
  let rows: SnapshotRow[];
  try {
    const result = await pool.query(
      `SELECT ts, block, price, amount0, amount1, value_usdt, cost_usdt, realized_usdt,
              pnl_usdt, pnl_pct, fee_usdt, in_range, liquidity
         FROM chain_position_snapshot
        WHERE position_key = $1
        ORDER BY ts DESC, id DESC
        LIMIT $2`,
      [positionKey, limit],
    );
    rows = result.rows as SnapshotRow[];
  } catch (error) {
    throw toSyncError(error, '读链上仓位历史失败');
  }
  return rows
    .map((row) => ({
      ts: ms(row.ts) ?? 0,
      block: row.block,
      price: row.price,
      amount0: row.amount0,
      amount1: row.amount1,
      valueUsdt: row.value_usdt,
      costUsdt: row.cost_usdt,
      realizedUsdt: row.realized_usdt,
      pnlUsdt: row.pnl_usdt,
      pnlPct: row.pnl_pct,
      feeUsdt: row.fee_usdt,
      inRange: row.in_range,
      liquidity: row.liquidity,
    }))
    .reverse();
}

/** 告警记录（控制面侧展示「推过什么」）。 */
export async function listChainAlerts(
  pool: Pool,
  positionKey: string,
  limit = 50,
): Promise<ChainAlertRow[]> {
  try {
    const result = await pool.query(
      `SELECT ts, reasons, sent, detail
         FROM chain_position_alert
        WHERE position_key = $1
        ORDER BY id DESC
        LIMIT $2`,
      [positionKey, limit],
    );
    return result.rows.map((row) => ({
      ts: ms((row['ts'] as string | null) ?? null) ?? 0,
      reasons: row['reasons'] as string,
      sent: row['sent'] as boolean,
      detail: (row['detail'] as Record<string, unknown> | null) ?? null,
    }));
  } catch (error) {
    throw toSyncError(error, '读链上仓位告警记录失败');
  }
}

/** 仓位不存在时抛错（调用方不该把「没这行」当成「一切正常」）。 */
export function requireChainPosition(row: ChainPositionViewRow | null): ChainPositionViewRow {
  if (row === null) {
    throw new SyncError('INTERNAL_ERROR', '链上仓位不存在');
  }
  return row;
}
