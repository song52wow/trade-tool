import {
  SyncError,
  type GapRecord,
  type RateLimitStatus,
  type SymbolEntry,
  type SymbolSyncState,
} from '@trade-tool/core';

import { toSyncError } from './errors.js';
import type { Pool, QueryResultRow } from './pool.js';

/**
 * 查询层（R-1.4 核心表的读写）。
 *
 * 边界：**本模块只做读**（以及符号集合这种控制面元数据的写）。
 * K 线、缺口水位、`sync_state` 的写入全部在 Python 侧的事务里完成——
 * 那是「批量写入与状态推进必须同事务」（R-19.5）的唯一能成立的地方，
 * 因为 COPY 只发生在 Python 进程内。
 *
 * 所有时间列都是 bigint（epoch ms）。pg 会把 int8 当字符串返回，这里统一转 number，
 * 使「毫秒」这一跨语言契约在读侧同样成立（R-1.6）。
 */

function ms(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function req(value: unknown, column: string): number {
  const n = ms(value);
  if (n === null)
    throw new SyncError(
      'INTERNAL_ERROR',
      `列 ${column} 期望为非空 bigint，实际为 ${String(value)}`,
    );
  return n;
}

function str(value: unknown): string {
  if (typeof value !== 'string') {
    throw new SyncError('INTERNAL_ERROR', `期望 string，实际为 ${String(value)}`);
  }
  return value;
}

/**
 * float8 列的读取校验。
 *
 * PG 的 `double precision` 允许存入 `'NaN'` / `'Infinity'`；`Number('NaN')` 得到 NaN，
 * 而 `JSON.stringify(NaN)` 会写成 `null`——于是「库里是损坏数据」在 CLI 摘要里被
 * 静默洗成「这个字段没有值」，读侧再也区分不出来（README 明确禁止 NaN/Infinity）。
 * 与 NULL 一样：损坏必须报错，不得静默。
 */
function num(value: unknown, column: string, symbol: string, time: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new SyncError(
      'NULL_NOT_ALLOWED',
      `${symbol} time=${String(time)} 的 ${column} 不是有限数（${String(value)}）：库中存在损坏数据`,
      { symbol, time, column },
    );
  }
  return n;
}

// ---------------------------------------------------------------- klines_1m

export interface Watermark {
  symbol: string;
  /** 库内最后一根 bar 的开盘时间；无数据为 null */
  maxTime: number | null;
  rows: number;
}

/** 水位的**权威来源**：直接从数据推导，而不是读 sync_state 的缓存值（R-9.1 / R-9.6）。 */
export async function watermark(pool: Pool, symbol: string): Promise<Watermark> {
  try {
    const result = await pool.query<QueryResultRow>(
      'SELECT max(time) AS max_time, count(*)::bigint AS rows FROM klines_1m WHERE symbol = $1',
      [symbol],
    );
    const row = result.rows[0];
    return {
      symbol,
      maxTime: ms(row?.['max_time']),
      rows: ms(row?.['rows']) ?? 0,
    };
  } catch (error) {
    throw toSyncError(error, `读取 ${symbol} 水位失败`);
  }
}

export interface BarRow {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** 交易所未提供该字段时为 null（R-4.2）。绝不用 0 冒充缺失（R-4.3）。 */
  quoteVolume: number | null;
  trades: number | null;
}

const BAR_COLUMNS = 'time, open, high, low, close, volume, quote_volume, trades';

function toBar(row: QueryResultRow, index: number, symbol: string): BarRow {
  // time/open/high/low/close/volume 是 NOT NULL；读出 NULL 即数据损坏，必须报错（R-4.1）。
  const required = ['time', 'open', 'high', 'low', 'close', 'volume'] as const;
  for (const field of required) {
    if (row[field] === null || row[field] === undefined) {
      throw new SyncError(
        'NULL_NOT_ALLOWED',
        `${symbol} time=${String(row['time'])} 的 ${field} 为 NULL：库中存在损坏数据`,
        { symbol, time: row['time'], field, row: index },
      );
    }
  }
  return {
    time: req(row['time'], 'time'),
    open: num(row['open'], 'open', symbol, row['time']),
    high: num(row['high'], 'high', symbol, row['time']),
    low: num(row['low'], 'low', symbol, row['time']),
    close: num(row['close'], 'close', symbol, row['time']),
    volume: num(row['volume'], 'volume', symbol, row['time']),
    quoteVolume:
      row['quote_volume'] === null
        ? null
        : num(row['quote_volume'], 'quote_volume', symbol, row['time']),
    trades: row['trades'] === null ? null : req(row['trades'], 'trades'),
  };
}

/**
 * 读取区间。`from`/`to` 为闭区间（bar 开盘时间）。
 * 读不到行返回空数组——调用方据此区分「区间未同步」与「字段为 NULL」（R-4.4）。
 */
export async function readBars(
  pool: Pool,
  symbol: string,
  range: { from?: number; to?: number; limit?: number },
): Promise<BarRow[]> {
  try {
    const conditions = ['symbol = $1'];
    const values: unknown[] = [symbol];
    if (range.from !== undefined) {
      values.push(range.from);
      conditions.push(`time >= $${values.length}`);
    }
    if (range.to !== undefined) {
      values.push(range.to);
      conditions.push(`time <= $${values.length}`);
    }
    values.push(range.limit ?? 10_000);
    const result = await pool.query<QueryResultRow>(
      `SELECT ${BAR_COLUMNS} FROM klines_1m WHERE ${conditions.join(' AND ')} ORDER BY time ASC LIMIT $${values.length}`,
      values,
    );
    return result.rows.map((row, index) => toBar(row, index, symbol));
  } catch (error) {
    throw toSyncError(error, `读取 ${symbol} K 线失败`);
  }
}

/** 库内最后一根 bar，用于「丢弃最后一根」后的自愈校验（R-10.3）。 */
export async function lastBar(pool: Pool, symbol: string): Promise<BarRow | null> {
  try {
    const result = await pool.query<QueryResultRow>(
      `SELECT ${BAR_COLUMNS} FROM klines_1m WHERE symbol = $1 ORDER BY time DESC LIMIT 1`,
      [symbol],
    );
    const row = result.rows[0];
    return row ? toBar(row, 0, symbol) : null;
  } catch (error) {
    throw toSyncError(error, `读取 ${symbol} 最后一根 bar 失败`);
  }
}

/** 区间内是否已有数据——用于区分 DO NOTHING 是否真的会写入任何东西。 */
export async function hasRange(
  pool: Pool,
  symbol: string,
  from: number,
  to: number,
): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM klines_1m WHERE symbol = $1 AND time >= $2 AND time <= $3) AS exists',
    [symbol, from, to],
  );
  return result.rows[0]?.exists ?? false;
}

// -------------------------------------------------------------- contract_spec

export async function readContractSpec(
  pool: Pool,
  exchange: string,
  symbol: string,
): Promise<{
  contractType: string;
  status: string;
  onboardDate: number;
  updatedAt: number;
} | null> {
  const result = await pool.query<QueryResultRow>(
    'SELECT contract_type, status, onboard_date, updated_at FROM contract_spec WHERE exchange = $1 AND symbol = $2',
    [exchange, symbol],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    contractType: str(row['contract_type']),
    status: str(row['status']),
    onboardDate: req(row['onboard_date'], 'onboard_date'),
    updatedAt: req(row['updated_at'], 'updated_at'),
  };
}

// ----------------------------------------------------------------- sync_state

const STATE_COLUMNS = `exchange, symbol, status, watermark, verified_upto, rows, bytes,
  last_run_at, last_success_at, last_error, error_count, backoff_until, pending_gaps, updated_at,
  plan_bars, plan_requests, plan_weight, plan_estimated_ms, plan_from, plan_to, plan_at`;

function toState(row: QueryResultRow, desiredState: string | null): SymbolSyncState {
  const planBars = ms(row['plan_bars']);
  return {
    exchange: str(row['exchange']),
    symbol: str(row['symbol']),
    status: str(row['status']) as SymbolSyncState['status'],
    watermark: ms(row['watermark']),
    verifiedUpTo: ms(row['verified_upto']),
    rows: ms(row['rows']) ?? 0,
    bytes: ms(row['bytes']) ?? 0,
    lastRunAt: ms(row['last_run_at']),
    lastSuccessAt: ms(row['last_success_at']),
    lastError: row['last_error'] === null ? null : String(row['last_error']),
    errorCount: Number(row['error_count'] ?? 0),
    backoffUntil: ms(row['backoff_until']),
    pendingGaps: Number(row['pending_gaps'] ?? 0),
    updatedAt: req(row['updated_at'], 'updated_at'),
    desiredState: (desiredState ?? null) as SymbolSyncState['desiredState'],
    metadataStale: false,
    // plan_* 是一组同写同清的可空列：plan_bars 为 NULL 即「无计划」。
    // 其余列若为 NULL 说明写了半套（迁移/代码不一致），req() 会直接报错而不是编一个 0。
    plan:
      planBars === null
        ? null
        : {
            bars: planBars,
            requests: req(row['plan_requests'], 'plan_requests'),
            weight: req(row['plan_weight'], 'plan_weight'),
            estimatedMs: req(row['plan_estimated_ms'], 'plan_estimated_ms'),
            from: req(row['plan_from'], 'plan_from'),
            to: req(row['plan_to'], 'plan_to'),
            computedAt: req(row['plan_at'], 'plan_at'),
          },
  };
}

const STATE_FROM_SYMBOLS = `
  SELECT s.*, sym.desired_state AS desired_state
  FROM sync_state s
  LEFT JOIN symbols sym ON sym.exchange = s.exchange AND sym.symbol = s.symbol`;

/**
 * 全部标的的同步状态。集合里尚未产生过 sync_state 的标的不出现在这里。
 *
 * `exchange` 可选但**必须传**：不传会把别的交易所的同名标的也列进来，
 * 而全局汇总是按 exchange 过滤的——于是 `sync status` 列出的标的数与汇总的标的数
 * 会对不上（同一份输出里两个「标的数」）。测试与嵌入式调用可省略。
 */
export async function listStates(pool: Pool, exchange?: string): Promise<SymbolSyncState[]> {
  try {
    const result = exchange
      ? await pool.query<QueryResultRow>(
          `${STATE_FROM_SYMBOLS} WHERE s.exchange = $1 ORDER BY s.symbol ASC`,
          [exchange],
        )
      : await pool.query<QueryResultRow>(`${STATE_FROM_SYMBOLS} ORDER BY s.symbol ASC`);
    return result.rows.map((row) => toState(row, (row['desired_state'] as string | null) ?? null));
  } catch (error) {
    throw toSyncError(error, '读取同步状态失败');
  }
}

export async function readState(
  pool: Pool,
  exchange: string,
  symbol: string,
): Promise<SymbolSyncState | null> {
  const result = await pool.query<QueryResultRow>(
    `${STATE_FROM_SYMBOLS} WHERE s.exchange = $1 AND s.symbol = $2`,
    [exchange, symbol],
  );
  const row = result.rows[0];
  if (!row) return null;
  return toState(row, (row['desired_state'] as string | null) ?? null);
}

/**
 * 水位一致性校验（R-19.6 / AC-21）。
 * `sync_state.watermark` 只是可观测缓存，权威水位是 `max(time)`；二者不一致必须报错，
 * **不得二选一**——否则「数据已入库但水位没推进」这类问题会被静默吞掉。
 */
export async function assertWatermarkConsistent(
  pool: Pool,
  exchange: string,
  symbol: string,
): Promise<{ watermark: number | null; rows: number }> {
  const truth = await watermark(pool, symbol);
  const state = await readState(pool, exchange, symbol);
  // 没有 sync_state 行就没有「缓存值」，无从比较；这是合法的（例如仅做过 CLI 回补）。
  if (!state) return { watermark: truth.maxTime, rows: truth.rows };

  const cached = state.watermark;
  const drifted =
    cached === null ? truth.maxTime !== null : truth.maxTime === null || cached !== truth.maxTime;

  if (drifted) {
    throw new SyncError(
      'WATERMARK_MISMATCH',
      `${symbol} 水位不一致：sync_state.watermark=${String(cached)}，但 klines_1m 的 max(time)=${String(truth.maxTime)}`,
      { symbol, cached, authoritative: truth.maxTime },
    );
  }
  return { watermark: truth.maxTime, rows: truth.rows };
}

// ---------------------------------------------------------------------- gaps

export async function listGaps(pool: Pool, symbol?: string): Promise<GapRecord[]> {
  try {
    const result = symbol
      ? await pool.query<QueryResultRow>(
          'SELECT symbol, gap_start, gap_end, missing_rows, attempts, last_attempt_at, last_error FROM gaps WHERE symbol = $1 ORDER BY gap_start ASC',
          [symbol],
        )
      : await pool.query<QueryResultRow>(
          'SELECT symbol, gap_start, gap_end, missing_rows, attempts, last_attempt_at, last_error FROM gaps ORDER BY symbol ASC, gap_start ASC',
        );
    return result.rows.map((row) => ({
      symbol: str(row['symbol']),
      gapStart: req(row['gap_start'], 'gap_start'),
      gapEnd: req(row['gap_end'], 'gap_end'),
      missingRows: req(row['missing_rows'], 'missing_rows'),
      attempts: Number(row['attempts'] ?? 0),
      lastAttemptAt: ms(row['last_attempt_at']),
      lastError: row['last_error'] === null ? null : String(row['last_error']),
    }));
  } catch (error) {
    throw toSyncError(error, '读取缺口清单失败');
  }
}

export async function pendingGapCount(pool: Pool, symbol?: string): Promise<number> {
  const result = symbol
    ? await pool.query<{ n: string }>('SELECT count(*)::bigint AS n FROM gaps WHERE symbol = $1', [
        symbol,
      ])
    : await pool.query<{ n: string }>('SELECT count(*)::bigint AS n FROM gaps');
  return ms(result.rows[0]?.n) ?? 0;
}

// ------------------------------------------------------------------- symbols

export async function listSymbolEntries(pool: Pool, exchange: string): Promise<SymbolEntry[]> {
  try {
    const result = await pool.query<QueryResultRow>(
      'SELECT exchange, symbol, desired_state, onboard_date, added_at, updated_at FROM symbols WHERE exchange = $1 ORDER BY symbol ASC',
      [exchange],
    );
    return result.rows.map((row) => ({
      exchange: str(row['exchange']),
      symbol: str(row['symbol']),
      desiredState: str(row['desired_state']) as SymbolEntry['desiredState'],
      onboardDate: ms(row['onboard_date']),
      addedAt: req(row['added_at'], 'added_at'),
      updatedAt: req(row['updated_at'], 'updated_at'),
    }));
  } catch (error) {
    throw toSyncError(error, '读取标的集合失败');
  }
}

/**
 * 幂等写入标的集合条目（R-18.5）：重复添加同一标的不报错也不产生副作用。
 * 新标的默认 `paused`（R-8.4 / R-17.4）——避免一次添加多个标的引发回补风暴。
 * `desired_state` 只在显式切换生命周期时改变，因此这里用 DO UPDATE 保留原值。
 */
export async function upsertSymbolEntry(
  pool: Pool,
  entry: {
    exchange: string;
    symbol: string;
    desiredState?: 'paused' | 'running';
    onboardDate?: number | null;
  },
): Promise<SymbolEntry> {
  const now = Date.now();
  try {
    const result = await pool.query<QueryResultRow>(
      `INSERT INTO symbols (exchange, symbol, desired_state, onboard_date, added_at, updated_at)
       VALUES ($1, $2, COALESCE($3, 'paused'), $4, $5, $5)
       ON CONFLICT (exchange, symbol) DO UPDATE
         SET onboard_date = COALESCE(EXCLUDED.onboard_date, symbols.onboard_date),
             -- 只有内容真的变了才动 updated_at：重复 addSymbol 必须**无副作用**（R-18.5），
             -- 否则控制面无法用 updated_at 判断「这一行是否被碰过」。
             updated_at = CASE
               WHEN symbols.onboard_date IS DISTINCT FROM
                    COALESCE(EXCLUDED.onboard_date, symbols.onboard_date)
                 THEN EXCLUDED.updated_at
               ELSE symbols.updated_at
             END
       RETURNING exchange, symbol, desired_state, onboard_date, added_at, updated_at`,
      [entry.exchange, entry.symbol, entry.desiredState ?? null, entry.onboardDate ?? null, now],
    );
    const row = result.rows[0];
    if (!row) throw new SyncError('INTERNAL_ERROR', '写入标的集合后未返回行');
    return {
      exchange: str(row['exchange']),
      symbol: str(row['symbol']),
      desiredState: str(row['desired_state']) as SymbolEntry['desiredState'],
      onboardDate: ms(row['onboard_date']),
      addedAt: req(row['added_at'], 'added_at'),
      updatedAt: req(row['updated_at'], 'updated_at'),
    };
  } catch (error) {
    throw toSyncError(error, `写入标的集合 ${entry.symbol} 失败`);
  }
}

/** 设置期望状态。幂等：目标状态相同则不写（R-17.2）。 */
export async function setDesiredState(
  pool: Pool,
  exchange: string,
  symbol: string,
  desiredState: 'paused' | 'running',
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE symbols SET desired_state = $3, updated_at = $4
     WHERE exchange = $1 AND symbol = $2 AND desired_state IS DISTINCT FROM $3`,
    [exchange, symbol, desiredState, Date.now()],
  );
  return (result.rowCount ?? 0) > 0;
}

/** 保证 sync_state 行存在，返回该标的的状态（R-3.3 的单写者行锁就锁在这行上）。 */
export async function ensureSyncState(
  pool: Pool,
  exchange: string,
  symbol: string,
  status: SymbolSyncState['status'] = 'paused',
): Promise<SymbolSyncState> {
  const now = Date.now();
  try {
    const result = await pool.query<QueryResultRow>(
      `INSERT INTO sync_state (exchange, symbol, status, updated_at)
       VALUES ($1, $2, $3, $4)
       -- 行已存在就**完全不碰**：重复 ensureSyncState 必须无副作用（R-18.5），
       -- 也不能顺手把 status 改回 paused。
       ON CONFLICT (exchange, symbol) DO UPDATE SET exchange = EXCLUDED.exchange
       RETURNING ${STATE_COLUMNS.replace(/\s+/g, ' ')}`,
      [exchange, symbol, status, now],
    );
    const row = result.rows[0];
    if (!row) throw new SyncError('INTERNAL_ERROR', '确保 sync_state 行存在后未返回行');
    return toState(row, null);
  } catch (error) {
    throw toSyncError(error, `初始化 ${symbol} 同步状态失败`);
  }
}

/**
 * 移除标的（R-18.3）。数据处置策略必须**显式**且可配置，禁止静默删除已入库数据。
 *   keep   保留 klines_1m 数据，只移出调度集合
 *   delete 连同 klines_1m 一起删除（仍保留 sync_state 以便审计）
 *   archive 保留数据并打上归档标记（本 schema 无归档列，等价于 keep）
 *
 * **必须整段跑在同一条连接上**：``pg.Pool`` 的每次 ``query`` 各自借还连接，
 * 用 ``pool.query('BEGIN')`` 拿到的连接与后续业务语句所在的连接并不是同一条——
 * 于是语句根本不在同一个事务里，``ROLLBACK`` 也撤不掉已执行的 DELETE，
 * 更糟的是那条带未提交事务的连接会回到池里，被之后任意无关查询复用并顺带提交。
 * 因此这里用 ``pool.connect()`` 独占一条 client，finally 里一定 release。
 */
export async function removeSymbolEntry(
  pool: Pool,
  exchange: string,
  symbol: string,
  policy: 'keep' | 'archive' | 'delete',
): Promise<{ removed: boolean; policy: 'keep' | 'archive' | 'delete'; deletedRows: number }> {
  const client = await pool.connect();
  let advisoryHeld = false;
  // 与 Python 侧 `pg.SymbolLock` **完全一致**的键（schema/exchange/symbol）。
  // 锁表达式只写一次，避免两边漂移导致锁形同虚设。
  const advisoryKey = (placeholderFrom: number): string =>
    `hashtextextended(current_schema() || '/' || $${placeholderFrom} || '/' || $${placeholderFrom + 1}, 0)`;
  try {
    if (policy === 'delete') {
      // policy=delete 是**唯一**从 TS 侧删 klines_1m 的路径。Python 每轮同步会整轮持有
      // 这个 session 级 advisory lock（批与批之间不持行锁），所以不加锁就会交错：
      // DELETE 提交后，正在跑的那一轮会把行重新写回来、收尾还把 status 写回 running——
      // 「已删除/已移除」的标的复活。R-3.3 要求在应用层保证单写者。
      const locked = await client.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_lock(${advisoryKey(1)}) AS locked`,
        [exchange, symbol],
      );
      if (!locked.rows[0]?.locked) {
        throw new SyncError(
          'SYNC_ALREADY_RUNNING',
          `${symbol} 正在同步中，不能删除其已入库数据：请先暂停并等本轮同步结束`,
          { exchange, symbol, policy },
        );
      }
      advisoryHeld = true;
    }
    await client.query('BEGIN');
    try {
      if (policy === 'delete') {
        const deleted = await client.query('DELETE FROM klines_1m WHERE symbol = $1', [symbol]);
        await client.query('DELETE FROM gaps WHERE symbol = $1', [symbol]);
        const count = deleted.rowCount ?? 0;
        // 数据已删，**所有由数据推导出来的缓存列必须一起清掉**。
        // 只把 status 改成 paused 是不够的：残留的 watermark 会在该标的下一次同步时
        // 与 max(time)=NULL 冲突，直接抛 WATERMARK_MISMATCH；那个错误码属「需人工介入」，
        // 于是重新加入的标的每轮都失败、resume 也修不掉（R-18.3 / R-19.6 / AC-21）。
        await client.query(
          `UPDATE sync_state SET status = $3, watermark = NULL, verified_upto = NULL,
             rows = 0, bytes = 0, pending_gaps = 0, last_error = NULL,
             error_count = 0, backoff_until = NULL, updated_at = $4
           WHERE exchange = $1 AND symbol = $2`,
          [exchange, symbol, 'paused', Date.now()],
        );
        await client.query('DELETE FROM symbols WHERE exchange = $1 AND symbol = $2', [
          exchange,
          symbol,
        ]);
        await client.query('COMMIT');
        return { removed: true, policy, deletedRows: count };
      }
      // keep / archive：数据与状态全部保留，只移出调度集合。
      // 注意：移出集合后该标的的 desired_state 变为 NULL，不再被调度，
      // 但它仍会出现在 `sync status` 列表里（sync_state 行保留用于审计）。
      const removed = await client.query(
        'DELETE FROM symbols WHERE exchange = $1 AND symbol = $2',
        [exchange, symbol],
      );
      await client.query('COMMIT');
      return { removed: (removed.rowCount ?? 0) > 0, policy, deletedRows: 0 };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  } catch (error) {
    throw toSyncError(error, `移除标的 ${symbol} 失败`);
  } finally {
    if (advisoryHeld) {
      // 必须显式解锁再还连接：advisory lock 是 session 级的，直接 release 会把锁
      // 留在池里的那条连接上，之后任何复用它的查询都还在持锁。
      await client
        .query(`SELECT pg_advisory_unlock(${advisoryKey(1)})`, [exchange, symbol])
        .catch(() => undefined);
    }
    client.release();
  }
}

/**
 * 写入 / 清空首次全量的规模预估（迁移 002 的 plan_* 列，R-8.3 / R-8.6）。
 *
 * 常驻模式下新增标的默认 `paused`，控制面需要先看到「这次全量要拉多少」才能决策，
 * 因此规模必须在**开启之前**就落到 `sync_state`，由 `sync status` 暴露；
 * 它同时是首次全量进度的分母（已入库行数 / 目标行数）。
 *
 * `plan = null` 表示清空（首次全量已完成；继续留着会让进度读成「差一根没跑完」）。
 */
export async function setSyncPlan(
  pool: Pool,
  exchange: string,
  symbol: string,
  plan: {
    bars: number;
    requests: number;
    weight: number;
    estimatedMs: number;
    from: number;
    to: number;
  } | null,
): Promise<void> {
  const now = Date.now();
  try {
    await pool.query(
      `UPDATE sync_state SET
         plan_bars = $3, plan_requests = $4, plan_weight = $5, plan_estimated_ms = $6,
         plan_from = $7, plan_to = $8, plan_at = $9, updated_at = $10
       WHERE exchange = $1 AND symbol = $2`,
      [
        exchange,
        symbol,
        plan?.bars ?? null,
        plan?.requests ?? null,
        plan?.weight ?? null,
        plan?.estimatedMs ?? null,
        plan?.from ?? null,
        plan?.to ?? null,
        plan === null ? null : now,
        now,
      ],
    );
  } catch (error) {
    throw toSyncError(error, `写入 ${symbol} 首次全量规模预估失败`);
  }
}

/**
 * 设置同步状态与错误信息（R-21 的退避落点）。
 *
 * **不触碰** watermark / verified_upto / rows：那些是数据推进的结果，
 * 只允许在写入该批数据的事务里推进（Python 侧 COPY 事务），否则会出现
 * 「数据已入库但水位没推进」的裂缝（R-19.5）。
 */
export async function setSyncStatus(
  pool: Pool,
  exchange: string,
  symbol: string,
  patch: {
    status?: SymbolSyncState['status'];
    lastError?: string | null;
    errorCount?: number;
    backoffUntil?: number | null;
    lastRunAt?: number | null;
    lastSuccessAt?: number | null;
  },
): Promise<SymbolSyncState | null> {
  try {
    const result = await pool.query<QueryResultRow>(
      `UPDATE sync_state SET
         status          = CASE WHEN $3::boolean THEN $4 ELSE status END,
         last_error      = CASE WHEN $5::boolean THEN $6 ELSE last_error END,
         error_count     = CASE WHEN $7::boolean THEN $8 ELSE error_count END,
         backoff_until   = CASE WHEN $9::boolean THEN $10 ELSE backoff_until END,
         last_run_at     = CASE WHEN $11::boolean THEN $12 ELSE last_run_at END,
         last_success_at = CASE WHEN $13::boolean THEN $14 ELSE last_success_at END,
         updated_at      = $15
       WHERE exchange = $1 AND symbol = $2
       RETURNING ${STATE_COLUMNS.replace(/\s+/g, ' ')}`,
      [
        exchange,
        symbol,
        'status' in patch,
        patch.status ?? null,
        'lastError' in patch,
        patch.lastError ?? null,
        'errorCount' in patch,
        patch.errorCount ?? null,
        'backoffUntil' in patch,
        patch.backoffUntil ?? null,
        'lastRunAt' in patch,
        patch.lastRunAt ?? null,
        'lastSuccessAt' in patch,
        patch.lastSuccessAt ?? null,
        Date.now(),
      ],
    );
    const row = result.rows[0];
    if (!row) return null;
    return toState(row, null);
  } catch (error) {
    throw toSyncError(error, `更新 ${symbol} 同步状态失败`);
  }
}

// ------------------------------------------------------------- weight_budget

/** 权重窗口长度（毫秒），与 Python 侧 `ratelimit.WINDOW_MS` 一致。 */
const WEIGHT_WINDOW_MS = 60_000;

export async function readWeightBudget(
  pool: Pool,
  budgetPerMinute: number,
): Promise<RateLimitStatus> {
  const result = await pool.query<QueryResultRow>(
    'SELECT window_from, used, pause_until FROM weight_budget WHERE id = 1',
  );
  const row = result.rows[0];
  const windowFrom = ms(row?.['window_from']) ?? 0;
  const stored = Number(row?.['used'] ?? 0);
  // 窗口已滚动但还没有新请求触发重置：行里的 used 属于**上一个窗口**，
  // 直接报出去会让 `sync status` 显示一个早就过期的使用率（R-20.4 要的是「当前窗口」）。
  const expired = Date.now() - windowFrom >= WEIGHT_WINDOW_MS;
  const used = expired ? 0 : stored;
  return {
    budgetPerMinute,
    windowFrom,
    used,
    pauseUntil: ms(row?.['pause_until']),
    utilization: budgetPerMinute > 0 ? used / budgetPerMinute : 0,
  };
}

// -------------------------------------------------------------------- summary

export interface GlobalSummary {
  symbols: number;
  countsByStatus: Record<'paused' | 'running' | 'error', number>;
  totalRows: number;
  totalBytes: number;
  pendingGaps: number;
}

/**
 * 全局汇总（R-19.8）。
 *
 * 总体 = **标的集合 ∪ 已有同步状态的标的**。只取 `symbols` 表会漏掉那些
 * 经 `data fetch` / `data sync` 直接同步过、但还没被 `addSymbol` 收进集合的标的，
 * 于是 `sync status` 列出某个标的、汇总却显示「标的 0 个」——控制面读到的是自相矛盾的数字。
 *
 * 三个数字（标的数 / 状态计数 / 缺口数）必须描述同一总体：状态取自
 * `symbols ⋈ sync_state`，集合内还没有 sync_state 的标的按 `paused` 计，
 * 已有数据但不在集合里的按其 `sync_state.status` 计。
 *
 * `pendingGaps` 统计**库里全部**缺口，不按集合过滤：「缺口不得静默存在」（R-11.11），
 * 把集合外的缺口从汇总里藏起来正是静默。
 */
export async function readGlobalSummary(pool: Pool, exchange: string): Promise<GlobalSummary> {
  try {
    const rows = await pool.query<QueryResultRow>(
      `WITH universe AS (
         SELECT exchange, symbol FROM symbols
         UNION
         SELECT exchange, symbol FROM sync_state
       )
       SELECT COALESCE(st.status, 'paused') AS status,
              COALESCE(st.rows, 0)::bigint AS rows,
              COALESCE(st.bytes, 0)::bigint AS bytes
         FROM universe u
         LEFT JOIN sync_state st ON st.exchange = u.exchange AND st.symbol = u.symbol
        WHERE u.exchange = $1`,
      [exchange],
    );

    const countsByStatus: GlobalSummary['countsByStatus'] = { paused: 0, running: 0, error: 0 };
    let totalRows = 0;
    let totalBytes = 0;
    for (const row of rows.rows) {
      const status = str(row['status']) as keyof GlobalSummary['countsByStatus'];
      if (status in countsByStatus) countsByStatus[status] += 1;
      totalRows += ms(row['rows']) ?? 0;
      totalBytes += ms(row['bytes']) ?? 0;
    }

    const gaps = await pool.query<{ n: string }>('SELECT count(*)::bigint AS n FROM gaps');
    return {
      symbols: rows.rows.length,
      countsByStatus,
      totalRows,
      totalBytes,
      pendingGaps: ms(gaps.rows[0]?.n) ?? 0,
    };
  } catch (error) {
    throw toSyncError(error, '读取全局汇总失败');
  }
}
