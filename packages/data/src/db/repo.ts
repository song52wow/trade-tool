import {
  DERIVED_INTERVALS,
  INTERVAL_MS,
  INTERVAL_TABLES,
  isStoredInterval,
  SyncError,
  type DerivedInterval,
  type DerivedTableStat,
  type GapRecord,
  type Interval,
  type RateLimitStatus,
  type StoredInterval,
  type SymbolEntry,
  type SymbolSyncState,
} from '@trade-tool/core';

import { toSyncError } from './errors.js';
import {
  INDICATOR_INTERVALS,
  INDICATOR_TABLES,
  readIndicatorTableStats,
  type IndicatorInterval,
  type IndicatorTableStat,
} from './indicators.js';
import type { Pool, QueryResultRow } from './pool.js';

/**
 * 单个派生周期在控制面上的展示口径（v0.2.0 R-7.5 / AC-15）。
 *
 * 两种形态刻意分开：
 *   * 正常：给出已入库桶数与扣留明细；
 *   * `withheldReason: 'disabled'`：**未启用派生**（`aggregateIntervals: []`）。
 * 用全 0 表达「未启用」会让人以为「启用了但还没聚合」，于是反复点重建。
 */
export type DerivedIntervalSummary =
  | {
      buckets: number;
      withheldNotClosed: number;
      withheldIncomplete: number;
      missingMinutes: number;
    }
  | { withheldReason: 'disabled' };

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

/**
 * 解析读请求的周期（v0.2.0 R-6.2 / R-6.5）。
 *
 * 缺省 `1m`；未知或**未实现**的周期（`5m` 明明在 `INTERVALS` 枚举里、这里却没有对应表）
 * 一律抛 `CONFIG_INVALID`。
 *
 * 绝不静默回落到 1m：用户以为在看 4h、实际拿到 1m，那正是最典型的静默兜底——图上看着
 * 「周期不对」，但没人知道是请求被改了。
 */
export function parseStoredInterval(raw: string | undefined | null): StoredInterval {
  if (raw === undefined || raw === null || raw === '') return '1m';
  if (isStoredInterval(raw)) return raw;
  throw new SyncError(
    'CONFIG_INVALID',
    `未实现的周期：${raw}（可读周期为 1m / ${DERIVED_INTERVALS.join(' / ')}；` +
      '5m 属于合成回测链路，派生层没有对应表）',
    { interval: raw, supported: Object.keys(INTERVAL_TABLES) },
  );
}

/**
 * 周期 → 表名（R-6.2）。
 *
 * 表名不可参数化，所以这里只从**白名单**里取值。`isStoredInterval` 已经保证了 key
 * 的存在性，重复校验一次是为了让 TS 收窄出 `StoredInterval`（而不是退化成 string）。
 */
function tableOf(interval: StoredInterval): string {
  if (!isStoredInterval(interval)) {
    throw new SyncError('CONFIG_INVALID', `未实现的周期：${interval}`, { interval });
  }
  return INTERVAL_TABLES[interval];
}

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
 *
 * `interval` 缺省 `1m`，既有调用与行为**逐字节不变**（R-6.1 / AC-13）。派生表与
 * `klines_1m` 共用同一个 `toBar` 与同一组 NULL / NaN 校验——不为派生表另写一份
 * 行映射（R-6.3，「不持影子定义」）。
 */
export async function readBars(
  pool: Pool,
  symbol: string,
  range: { from?: number; to?: number; limit?: number; interval?: Interval | undefined },
): Promise<BarRow[]> {
  const table = tableOf(parseStoredInterval(range.interval));
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
      `SELECT ${BAR_COLUMNS} FROM ${table} WHERE ${conditions.join(' AND ')} ORDER BY time ASC LIMIT $${values.length}`,
      values,
    );
    return result.rows.map((row, index) => toBar(row, index, symbol));
  } catch (error) {
    throw toSyncError(error, `读取 ${symbol} K 线失败`);
  }
}

/**
 * 取**最后 N 根**（升序返回），可选 `to` 作为闭区间上界。
 *
 * 为什么不能直接给 `readBars` 传 `limit`：它按 `time ASC LIMIT n` 取，给 limit 拿到的是
 * 区间**最早**的 n 根。看盘要的是最近这一段，所以这里先 DESC 取回再翻正——图表与
 * 「库里最新数据长什么样」都必须看这一端。
 *
 * 与 `readBars` 一样：读不到行返回空数组（调用方据此区分「没同步」与「字段为 NULL」），
 * 且复用同一组列与同一个 `toBar` 映射，不另持影子定义（R-2.5）。
 */
export async function readLatestBars(
  pool: Pool,
  symbol: string,
  range: { limit?: number; to?: number; interval?: Interval | undefined } = {},
): Promise<BarRow[]> {
  const table = tableOf(parseStoredInterval(range.interval));
  try {
    const values: unknown[] = [symbol];
    let upper = '';
    if (range.to !== undefined) {
      values.push(range.to);
      upper = ` AND time <= $${values.length}`;
    }
    values.push(range.limit ?? 10_000);
    const result = await pool.query<QueryResultRow>(
      `SELECT ${BAR_COLUMNS} FROM ${table} WHERE symbol = $1${upper} ORDER BY time DESC LIMIT $${values.length}`,
      values,
    );
    // 倒序取回是为了「取最新」，但对外一律升序：下游（图表、CSV）都按时间正序消费。
    return result.rows.map((row, index) => toBar(row, index, symbol)).reverse();
  } catch (error) {
    throw toSyncError(error, `读取 ${symbol} 最近 K 线失败`);
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

/**
 * 读 exchangeInfo 的**原始条目**（`contract_spec.raw`）。
 *
 * 止盈止损要把价格对齐到最小价格变动（`PRICE_FILTER.tickSize`），而 tickSize 只存在于
 * 原始 JSON 里——`readContractSpec` 那几个解析后的列不包含它。这里读的是库里**同一份
 * 快照**，不重新出网拉 exchangeInfo：对齐依据必须与其它规格自洽。
 *
 * 没有快照返回 `null`（调用方据此报错，而不是拿默认 tickSize 猜一个）。
 */
export async function readContractSpecRaw(
  pool: Pool,
  exchange: string,
  symbol: string,
): Promise<unknown | null> {
  const result = await pool.query<QueryResultRow>(
    'SELECT raw FROM contract_spec WHERE exchange = $1 AND symbol = $2',
    [exchange, symbol],
  );
  const row = result.rows[0];
  if (!row || row['raw'] === null || row['raw'] === undefined) return null;
  return row['raw'];
}

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
        // v0.2.0 R-8.1：派生数据必须**同事务**一并删除。「1m 已删、4h 还画得出」是
        // 自相矛盾的——页面上那根 4h 蜡烛的数据源已经不存在了。
        // keep / archive 不动派生表：那两种策略保留数据，派生数据当然一起留。
        for (const interval of DERIVED_INTERVALS) {
          await client.query(`DELETE FROM ${INTERVAL_TABLES[interval]} WHERE symbol = $1`, [
            symbol,
          ]);
        }
        // v0.3.0 R-11.1：指标表同样必须**同事务**一并删除。「1m 已删、4h 还画得出」
        // 已经自相矛盾；「K 线已删、指标还叠在图上」是同一个矛盾的下一层——
        // 那条指标线的数据源已经不存在了，用户会以为它在描述某个还在的行情。
        for (const table of Object.values(INDICATOR_TABLES)) {
          await client.query(`DELETE FROM ${table} WHERE symbol = $1`, [symbol]);
        }
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
  /** 1m 表的行数（既有语义不变，R-8.2） */
  totalRows: number;
  /** 1m 表的体积（既有语义不变，R-8.2） */
  totalBytes: number;
  pendingGaps: number;
  /** **启用的**派生表行数与**实测**体积（v0.2.0 R-8.2 / AC-16）；未启用派生时为空数组 */
  derived: DerivedTableStat[];
  /**
   * **已启用的**指标表行数与**实测**体积（v0.3.0 R-11.2）。
   *
   * `totalRows` / `totalBytes` 的含义**保持为 1m 不变**（R-11.2）——把它们改成
   * 「全部表」会让既有页面上的 1m 口径数字无声地变大，而没有任何一行代码说它变了。
   *
   * 未启用指标层（`indicatorSpecs: {}`）时是 `null`，与「启用了但一行没写」（`[]`）
   * 分开说：显示 0 行会让人以为「还没算」（R-11.4 / AC-23）。
   */
  indicators: IndicatorTableStat[] | null;
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
 *
 * `derivedIntervals` 是**实际启用的派生周期**（`data.aggregateIntervals`，R-9.1）。
 * 未启用派生时返回 `derived: []`，调用方据此说「未启用派生」；不传则按四个全启用算，
 * 既有调用行为不变。
 */
export async function readGlobalSummary(
  pool: Pool,
  exchange: string,
  derivedIntervals: readonly DerivedInterval[] = DERIVED_INTERVALS,
  /**
   * **实际启用的**指标周期。`null` = 未启用指标层（显式配置，状态里必须如实显示）。
   *
   * 不传时按四个全启用算，既有调用行为不变；未启用时返回 `null` 而不是空数组——
   * 空数组会被读成「启用了但一行都没写」，于是用户反复点重建（R-11.4 / AC-23）。
   */
  indicatorIntervals: readonly IndicatorInterval[] | null = INDICATOR_INTERVALS,
): Promise<GlobalSummary> {
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
      derived: await readDerivedTableStats(pool, derivedIntervals),
      indicators: indicatorIntervals ? await readIndicatorTableStats(pool) : null,
    };
  } catch (error) {
    throw toSyncError(error, '读取全局汇总失败');
  }
}

/**
 * 派生表的行数与**实测**体积（v0.2.0 R-8.2 / AC-16）。
 *
 * 体积走 `pg_total_relation_size`（含索引摊销与 TOAST），**不沿用**附录 B.2 的
 * 单行估算：那条估算至今未实测，而 `sync_state.bytes` 一直按它推进，谁都没量过真表。
 * 本次要求就是把估算换成实测。
 *
 * `intervals` 是**实际启用的周期**（`data.aggregateIntervals`）：未启用派生时返回空数组，
 * 调用方据此显示「未启用派生」而不是「0 个桶」——后者会让人以为「还没聚合」（R-8.4 /
 * AC-22）。只启用一个子集时同理：只报启用那几张表，不把没启用的报成 0。
 */
export async function readDerivedTableStats(
  pool: Pool,
  intervals: readonly DerivedInterval[] = DERIVED_INTERVALS,
): Promise<DerivedTableStat[]> {
  const tables = intervals.map((interval) => ({
    interval,
    table: INTERVAL_TABLES[interval],
  }));
  try {
    // 逐表两条查询：一条数行（要过表的统计信息）、一条量体积（走 pg_class）。
    // 合成一条动态 SQL 看着更省事，但表名只能来自白名单拼进语句——为了四个数字引入
    // 一处字符串拼接不划算，R-6.2 的白名单精神是「表名不参与字符串构造」。
    const stats: DerivedTableStat[] = [];
    for (const { interval, table } of tables) {
      const count = await pool.query<{ n: string }>(`SELECT count(*)::bigint AS n FROM ${table}`);
      const size = await pool.query<{ bytes: string | null }>(
        'SELECT pg_total_relation_size(to_regclass($1))::bigint AS bytes',
        [table],
      );
      stats.push({
        interval,
        table,
        rows: ms(count.rows[0]?.n) ?? 0,
        bytes: ms(size.rows[0]?.bytes) ?? 0,
      });
    }
    return stats;
  } catch (error) {
    throw toSyncError(error, '读取派生表统计失败');
  }
}

// ------------------------------------------------------------------ 派生周期

/**
 * 单标的每周期的「已入库桶数 + 被扣留桶数 + 缺失分钟数」（v0.2.0 R-7.5 / AC-15）。
 *
 * **桶数由 SQL 从 1m 推导**，不落「扣留表」——那是第二套状态（R-3.5）。判据与
 * `quant_data.aggregate.judge_bucket` 同源：`closed = (b + W) <= (L + 60_000)`、
 * 有效窗口取桶与该标的 1m 区间的交集。两处各写一套判据的风险是「页面说少一根、
 * 写库时其实写进去了」，而那种不一致排查起来要跨两个语言。
 *
 * `options.enabled` 是**实际启用的派生周期集合**（`data.aggregateIntervals`），不是
 * 布尔开关：R-9.1 允许只启用四个周期的一个子集，此时**没启用的周期必须显示成
 * 「未启用派生」**。把它们按启用态统计会得到一份「0 个桶 + 全 0 扣留」——
 * 看起来像「已启用但还没聚合」，用户会一直点重建，而重建（读的是同一个配置）
 * 根本不会写这几张表（AC-22 / R-8.4）。
 */
export async function readDerivedIntervals(
  pool: Pool,
  symbol: string,
  intervals: readonly StoredInterval[],
  options: { enabled: readonly DerivedInterval[] },
): Promise<Record<string, DerivedIntervalSummary>> {
  const derived = intervals.filter((interval): interval is DerivedInterval => interval !== '1m');
  if (derived.length === 0) return {};
  const enabled = new Set<DerivedInterval>(options.enabled);
  const active = derived.filter((interval) => enabled.has(interval));
  const disabled: Record<string, DerivedIntervalSummary> = Object.fromEntries(
    derived
      .filter((interval) => !enabled.has(interval))
      .map((interval) => [interval, { withheldReason: 'disabled' as const }]),
  );
  if (active.length === 0) return disabled;

  try {
    const bounds = await pool.query<{ first_ms: string | null; last_ms: string | null }>(
      'SELECT min(time) AS first_ms, max(time) AS last_ms FROM klines_1m WHERE symbol = $1',
      [symbol],
    );
    const firstMs = ms(bounds.rows[0]?.first_ms);
    const lastMs = ms(bounds.rows[0]?.last_ms);
    if (firstMs === null || lastMs === null) {
      // 库里没有 1m：派生表也不该有行，「无数据」本身就是答案。
      return Object.fromEntries(
        derived.map((interval) => [
          interval,
          enabled.has(interval) ? emptySummary() : { withheldReason: 'disabled' as const },
        ]),
      );
    }

    // 一次查询覆盖全部周期：按宽度分别算，桶起点用取模而不是 date_trunc（R-2.1）。
    // `date_trunc('day', …)` 的结果依赖会话 TimeZone，换个连接参数同一条 SQL 就会给出
    // 另一组边界，而取模永远只有一种结果。
    //
    // **每个周期一条 LATERAL 分支，而不是 CROSS JOIN 一张 VALUES 表。**
    //
    // 旧写法把 `klines_1m` 与 4 行 VALUES 做 CROSS JOIN：每根 1m 被复制 4 份再排序
    // 分组，而 `GROUP BY` 里含 `time - (time % width_ms)` 这个非单调表达式、CROSS JOIN
    // 又打断了索引顺序，planner 只能 external merge sort。实测 SOLUSDT（319 万根 1m）
    // 单 worker 溢出 172MB、三 worker 合计约 516MB，直接跑要 26.1s。
    //
    // LATERAL 让每个周期各自做一次 HashAggregate。哈希聚合**不需要有序输入**，那条巨大
    // 的排序整个消失（并行哈希，溢出 61MB）：同一份数据上 4.6s，快 5.7 倍。桶宽由
    // `INTERVAL_MS` 参数化传入，SQL 里不再硬编码周期宽度——新增派生周期只需在 core
    // 加一列映射。
    //
    // 判据一个字都没动：桶起点取模（R-2.1）、closed、win_end、win_start、expected
    // 的公式与 Python 侧 `judge_bucket`（R-3.4）仍逐字对应。
    //   * win_start 两种情形：桶内**最早一根 1m 就等于该标的第一根**（onboard 首日，
    //     附录 C.1）→ 从 F 起算，于是首日 1d 桶的期望是 675 而不是 1440，该桶应当写入；
    //     否则从 bucket 起算。若一律用 `max(bucket, first)`，删掉该标的最早一根会让 F
    //     右移、expected 随之减少，桶「自动变回合格」——而它的值早就是按 240 根算出来的。
    const result = await pool.query<{
      interval: string;
      not_closed: string;
      incomplete: string;
      missing_minutes: string;
    }>(
      `SELECT w.interval,
              count(*) FILTER (
                WHERE (s.bucket + w.width_ms) > ($2::bigint + 60000))::bigint AS not_closed,
              count(*) FILTER (
                WHERE (s.bucket + w.width_ms) <= ($2::bigint + 60000)
                  AND s.actual < ((least(s.bucket + w.width_ms - 60000, $2::bigint)
                                - CASE WHEN s.bucket_first = $3::bigint THEN $3::bigint
                                       ELSE s.bucket END) / 60000) + 1
              )::bigint AS incomplete,
              COALESCE(sum(GREATEST(0, ((least(s.bucket + w.width_ms - 60000, $2::bigint)
                                - CASE WHEN s.bucket_first = $3::bigint THEN $3::bigint
                                       ELSE s.bucket END) / 60000) + 1 - s.actual))
                FILTER (WHERE (s.bucket + w.width_ms) <= ($2::bigint + 60000)), 0)::bigint
                AS missing_minutes
         FROM unnest($4::text[], $5::bigint[]) AS w(interval, width_ms)
         CROSS JOIN LATERAL (
           SELECT k.time - (k.time % w.width_ms) AS bucket,
                  count(*) AS actual,
                  min(k.time) AS bucket_first
             FROM klines_1m k
            WHERE k.symbol = $1
            GROUP BY 1
         ) s
        WHERE least(s.bucket + w.width_ms - 60000, $2::bigint)
              >= CASE WHEN s.bucket_first = $3::bigint THEN $3::bigint ELSE s.bucket END
        GROUP BY w.interval, w.width_ms
        ORDER BY w.width_ms`,
      // $1 symbol、$2 该标的 1m 的 max(time)、$3 min(time)、$4 本次要统计的周期、
      // $5 与 $4 一一对应的桶宽（毫秒）
      [symbol, lastMs, firstMs, active, active.map((interval) => INTERVAL_MS[interval])],
    );
    const withheld = new Map(
      result.rows.map((row) => [
        row['interval'],
        {
          notClosed: ms(row['not_closed']) ?? 0,
          incomplete: ms(row['incomplete']) ?? 0,
          missingMinutes: ms(row['missing_minutes']) ?? 0,
        },
      ]),
    );

    const out: Record<string, DerivedIntervalSummary> = { ...disabled };
    for (const interval of active) {
      const counts = withheld.get(interval) ?? { notClosed: 0, incomplete: 0, missingMinutes: 0 };
      const stored = await pool.query<{ n: string }>(
        `SELECT count(*)::bigint AS n FROM ${INTERVAL_TABLES[interval]} WHERE symbol = $1`,
        [symbol],
      );
      out[interval] = {
        buckets: ms(stored.rows[0]?.n) ?? 0,
        withheldNotClosed: counts.notClosed,
        withheldIncomplete: counts.incomplete,
        missingMinutes: counts.missingMinutes,
      };
    }
    return out;
  } catch (error) {
    throw toSyncError(error, `读取 ${symbol} 派生周期统计失败`);
  }
}

function emptySummary(): DerivedIntervalSummary {
  return { buckets: 0, withheldNotClosed: 0, withheldIncomplete: 0, missingMinutes: 0 };
}

// ---------------------------------------------------------------- 守护进程心跳

/** 心跳行。只读出来用于展示与判定，不参与任何写入决策。 */
export interface DaemonHeartbeat {
  exchange: string;
  pid: number;
  startedAt: number;
  lastBeatAt: number;
}

/**
 * 写入 / 刷新心跳（守护进程侧）。
 *
 * `started_at` 用 COALESCE 保留首次启动时刻：定时器每轮都调它，若无脑覆盖，
 * 页面上的「已运行」就会永远是几秒。
 */
export async function upsertDaemonHeartbeat(
  pool: Pool,
  exchange: string,
  nowMs: number = Date.now(),
  pid: number = process.pid,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO daemon_heartbeat (exchange, pid, started_at, last_beat)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (exchange) DO UPDATE
         SET pid = EXCLUDED.pid,
             last_beat = EXCLUDED.last_beat,
             -- 只在进程身份变化时重置启动时刻，避免换进程后沿用旧的 started_at
             started_at = CASE WHEN daemon_heartbeat.pid IS DISTINCT FROM EXCLUDED.pid
                               THEN EXCLUDED.started_at ELSE daemon_heartbeat.started_at END`,
      [exchange, pid, nowMs],
    );
  } catch (error) {
    throw toSyncError(error, '写入守护进程心跳失败');
  }
}

/**
 * 删除心跳（优雅退出时调用）。
 *
 * 删掉而不是只停止刷新：这样「行不存在」就是**确切**的离线，而不是「还得靠阈值猜」。
 * 被 kill -9 时不会走到这里，那类崩溃由 `readDaemonHeartbeat` 的阈值兜底。
 */
export async function deleteDaemonHeartbeat(pool: Pool, exchange: string): Promise<void> {
  try {
    await pool.query('DELETE FROM daemon_heartbeat WHERE exchange = $1', [exchange]);
  } catch (error) {
    throw toSyncError(error, '删除守护进程心跳失败');
  }
}

/**
 * 读心跳并判定在线（控制面侧）。
 *
 * 三种结果，不要压成两个：
 *   * `running`  —— 心跳存在且在阈值内；
 *   * `stale`    —— 心跳存在但超阈值，进程被强杀或卡死（心跳不再刷新）；
 *   * `stopped`  —— 没有心跳行，守护进程从未启动或已优雅退出。
 *
 * `stopped` 与 `stale` 必须分开：前者是「没开」，用户该去启动它；后者是「开了但
 * 不对劲」，用户该去查日志。合成一个「离线」会把两种处置混成同一句话。
 */
export async function readDaemonHeartbeat(
  pool: Pool,
  exchange: string,
  staleAfterMs: number,
  nowMs: number = Date.now(),
): Promise<
  | { state: 'running'; pid: number; startedAt: number; lastBeatAt: number; ageMs: number }
  | { state: 'stale'; pid: number; startedAt: number; lastBeatAt: number; ageMs: number }
  | { state: 'stopped'; pid: null; startedAt: null; lastBeatAt: null; ageMs: null }
> {
  try {
    const result = await pool.query<{
      pid: number;
      started_at: string;
      last_beat: string;
    }>('SELECT pid, started_at, last_beat FROM daemon_heartbeat WHERE exchange = $1', [exchange]);
    const row = result.rows[0];
    if (!row) {
      return { state: 'stopped', pid: null, startedAt: null, lastBeatAt: null, ageMs: null };
    }
    const lastBeatAt = req(row['last_beat'], 'daemon_heartbeat.last_beat');
    const ageMs = Math.max(0, nowMs - lastBeatAt);
    const base = {
      pid: row['pid'],
      startedAt: req(row['started_at'], 'daemon_heartbeat.started_at'),
      lastBeatAt,
      ageMs,
    };
    return ageMs > staleAfterMs ? { state: 'stale', ...base } : { state: 'running', ...base };
  } catch (error) {
    throw toSyncError(error, '读取守护进程心跳失败');
  }
}
