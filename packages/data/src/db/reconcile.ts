/**
 * 对账观测快照的读写（v0.6.0）。
 *
 * **这张表存的是观测结果，不是判据，也不是第二套状态。** 三条边界必须守住：
 *
 * 1. 没有任何写路径会读它。判据只有 core 那一份纯函数，快照不参与任何判断——
 *    删掉整张表，除了让界面变盲，不会改变一笔止损的存亡。
 * 2. 它记录「看到了什么」，因此**可能与当前真实状态过期**。读侧必须把 `checkedAt`
 *    原样返回给界面，让「五分钟前的一致」看起来就是五分钟前的事。
 * 3. 只保留最近 N 次。对账明细每次都带差异列表，不设上限总有一天会拖慢查询。
 *
 * 表结构的唯一来源是 `sql/009_reconcile_run.sql`（AGENTS.md 约定 3）。
 */

import { SyncError, type ReconcileDifference, type ReconcileReport } from '@trade-tool/core';

import { toSyncError } from './errors.js';
import type { Pool } from './pool.js';

const TABLE = 'reconcile_run';

/** 每个 (exchange, scope) 保留的快照数。 */
const KEEP_PER_SCOPE = 50;

export interface ReconcileSnapshot extends ReconcileReport {
  id: string;
}

/**
 * 写入一次对账结果，顺带裁掉超出的旧行。
 *
 * `differences` 整份存 JSONB：它是给人看的报告，形状会随判据演进而变，
 * 拆成列就等于把判据的形状又抄了一份到 schema 里（AGENTS.md 约定 3）。
 */
export async function recordReconciliation(
  pool: Pool,
  report: ReconcileReport,
  now: number,
): Promise<void> {
  const scope = report.symbol ?? '';
  try {
    await pool.query('BEGIN');
    await pool.query(
      `INSERT INTO ${TABLE}
         (exchange, scope, checked_at, healthy, critical, warning,
          local_unsettled, exchange_positions, exchange_algo_orders, differences, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
      [
        report.exchange,
        scope,
        report.checkedAt,
        report.healthy,
        report.counts.critical,
        report.counts.warning,
        report.scope.localUnsettled,
        report.scope.exchangePositions,
        report.scope.exchangeAlgoOrders,
        JSON.stringify(report.differences),
        now,
      ],
    );
    // 裁剪与插入同事务：裁不掉也只是留旧行，不会让写入失败。
    await pool.query(
      `DELETE FROM ${TABLE} WHERE exchange = $1 AND scope = $2 AND id NOT IN (
         SELECT id FROM ${TABLE} WHERE exchange = $1 AND scope = $2
         ORDER BY checked_at DESC LIMIT $3
       )`,
      [report.exchange, scope, KEEP_PER_SCOPE],
    );
    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK').catch(() => undefined);
    throw toSyncError(error, `写入对账快照失败：${report.symbol ?? '全账户'}`);
  }
}

function toSnapshot(row: Record<string, unknown>): ReconcileSnapshot {
  const raw = row['differences'];
  if (!Array.isArray(raw)) {
    // 形状不对就报错。返回空数组会让界面显示「无差异」，而那正是最不能猜的一个结论。
    throw new SyncError('NULL_NOT_ALLOWED', 'reconcile_run.differences 不是数组', {
      value: JSON.stringify(raw).slice(0, 200),
    });
  }
  const where = `reconcile_run#${String(row['id'])}`;
  return {
    id: String(row['id']),
    exchange: String(row['exchange']),
    symbol: row['scope'] === '' ? null : String(row['scope']),
    checkedAt: Number(row['checked_at']),
    healthy: row['healthy'] === true,
    counts: {
      critical: Number(row['critical']),
      warning: Number(row['warning']),
      total: Number(row['critical']) + Number(row['warning']),
    },
    differences: raw as ReconcileDifference[],
    scope: {
      localUnsettled: Number(row['local_unsettled']),
      exchangePositions: Number(row['exchange_positions']),
      exchangeAlgoOrders: Number(row['exchange_algo_orders']),
    },
  };
}

/**
 * 最近一次对账结果。
 *
 * `symbol` 传空串 = 取全账户快照。**从来没跑过时返回 `null`**，不返回空报告：
 * 「还没对过账」与「对过了、一致」在界面上必须能分开说。
 */
export async function readLatestReconciliation(
  pool: Pool,
  exchange: string,
  symbol: string,
): Promise<ReconcileSnapshot | null> {
  try {
    const result = await pool.query<Record<string, unknown>>(
      `SELECT * FROM ${TABLE} WHERE exchange = $1 AND scope = $2 ORDER BY checked_at DESC LIMIT 1`,
      [exchange, symbol],
    );
    const row = result.rows[0];
    return row === undefined ? null : toSnapshot(row);
  } catch (error) {
    throw toSyncError(error, `读取对账快照失败：${symbol || '全账户'}`);
  }
}

/** 最近 N 次，供排查「自动对账一直在报还是从某刻起才报」。倒序。 */
export async function listReconciliations(
  pool: Pool,
  exchange: string,
  symbol: string,
  limit = 20,
): Promise<ReconcileSnapshot[]> {
  try {
    const result = await pool.query<Record<string, unknown>>(
      `SELECT * FROM ${TABLE} WHERE exchange = $1 AND scope = $2
       ORDER BY checked_at DESC LIMIT $3`,
      [exchange, symbol, Math.min(Math.max(limit, 1), KEEP_PER_SCOPE)],
    );
    return result.rows.map(toSnapshot);
  } catch (error) {
    throw toSyncError(error, `读取对账历史失败：${symbol || '全账户'}`);
  }
}
