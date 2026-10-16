/**
 * 技术指标读侧（v0.3.0 R-9）。
 *
 * **纯读**：只打 PG，不出网、不写库、不消耗交易所配额（v0.1.0 R-23.4），因此可以挂在
 * 控制面的刷新节奏上。图上的指标**只能来自物化表**——这是物化不可省略的真正理由，
 * 而不是「算得慢」。
 *
 * 三条硬约束（R-9.2 ~ R-9.5）：
 *
 * 1. **表名与列名不可参数化**：一律先过 :data:`INDICATOR_TABLES` / :data:`PARAM_COLUMNS`
 *    白名单，绝不把字符串拼进 SQL（v0.2.0 R-6.2 继续成立）。`interval` 同理。
 * 2. **未物化的参数集必须明确报错**并给出物化命令：**不得**静默现算、**不得**回落到
 *    缺省参数、**不得**返回空数组假装成功。用户以为在看 EMA(20)、实际拿到的是空数组，
 *    那是最难查的一类界面问题。
 * 3. **回传实际生效的 `implVersion`**（延续 R-23「回传生效值」的精神）。TS 侧**不持有**
 *    `INDICATOR_IMPL_VERSION` 常量——它是 Python 侧实现的单一来源，复制一份就会在
 *    实现递增后静默停在旧版本号上。
 *
 * **参数是列不是哈希**（R-3.3）：本模块直接以 `WHERE window = $2` 这类条件定位，
 * 因此 `SELECT … FROM indicator_ma WHERE window = 20` 在 SQL 里天然可查（AC-4）。
 */

import { SyncError } from '@trade-tool/core';

import { toSyncError } from './errors.js';
import type { Pool } from './pool.js';

/** 七组指标。**必须**与 `sql/005_indicators.sql` 与 `quant_data.indicators` 三方一致（AC-2）。 */
export type IndicatorName = 'ma' | 'macd' | 'rsi' | 'boll' | 'kdj' | 'atr' | 'obv';

/** 指标名 -> 表名。表名只从这里取，绝不把字符串拼进 SQL（R-9.2）。 */
export const INDICATOR_TABLES: Readonly<Record<IndicatorName, string>> = Object.freeze({
  ma: 'indicator_ma',
  macd: 'indicator_macd',
  rsi: 'indicator_rsi',
  boll: 'indicator_boll',
  kdj: 'indicator_kdj',
  atr: 'indicator_atr',
  obv: 'indicator_obv',
});

/**
 * 每个指标的**参数列**（与迁移文件的 PK 顺序一致）。
 *
 * 注意 `ma` 的窗口列在库里叫 `bars` 而不是 `window`：`window` 是 PostgreSQL 的**完全
 * 保留字**（`pg_get_keywords()` 的 `catcode = 'R'`），裸用会直接语法错误，逼得每条 SQL
 * 都要引号包裹——那正是「列名不可参数化」要消除的手工拼装。配置侧仍然叫 `window`
 * （JSON 不受 SQL 关键字约束），两者只经这张表映射。
 */
export const PARAM_COLUMNS: Readonly<Record<IndicatorName, readonly string[]>> = Object.freeze({
  ma: ['kind', 'bars'],
  macd: ['fast', 'slow', 'signal'],
  rsi: ['period'],
  boll: ['period', 'k_milli'],
  kdj: ['n', 'k_period', 'd_period'],
  atr: ['period'],
  obv: [],
});

/** 每个指标的**值列**（与迁移文件一致）。 */
export const VALUE_COLUMNS: Readonly<Record<IndicatorName, readonly string[]>> = Object.freeze({
  ma: ['value'],
  macd: ['dif', 'dea', 'hist'],
  rsi: ['value'],
  boll: ['upper', 'mid', 'lower'],
  kdj: ['k', 'd', 'j'],
  atr: ['value'],
  obv: ['value'],
});

/** 允许读取的指标周期 = 四个派生周期，**不含 1m**（N-2）。 */
export const INDICATOR_INTERVALS = ['15m', '1h', '4h', '1d'] as const;
export type IndicatorInterval = (typeof INDICATOR_INTERVALS)[number];

/** 是否是已实现的**指标**周期。`1m` 明明是合法 K 线周期，但指标层没有它的表。 */
export function isIndicatorInterval(value: string): value is IndicatorInterval {
  return Object.prototype.hasOwnProperty.call(
    Object.fromEntries(INDICATOR_INTERVALS.map((i) => [i, true])),
    value,
  );
}

/**
 * 解析读请求的指标周期（R-9.5）。
 *
 * 缺省 `1h`；`1m` / `5m` / `foo` 一律 `CONFIG_INVALID`。**绝不静默回落到某个周期**：
 * 用户以为在看 4h 的指标、实际拿到 1h，图上看着「周期不对」但没人知道请求被改了。
 */
export function parseIndicatorInterval(raw: string | undefined | null): IndicatorInterval {
  if (raw === undefined || raw === null || raw === '') return '1h';
  if (isIndicatorInterval(raw)) return raw;
  throw new SyncError(
    'CONFIG_INVALID',
    `指标不支持该周期：${raw}（可读周期为 ${INDICATOR_INTERVALS.join(' / ')}；` +
      '1m 不做指标物化——单标的约 4.3 GB/标的；5m 在派生层就没有表）',
    { interval: raw, supported: [...INDICATOR_INTERVALS] },
  );
}

/** 一个参数集。键名与 `PARAM_COLUMNS` 的**数据库列名**一致，值都是整数或 `kind` 字符串。 */
export type IndicatorParams = Readonly<Record<string, number | string>>;
/** 可变副本，仅用于构造返回值。 */
type MutableParams = Record<string, number | string>;

/** 读请求：一个「指标 + 参数集」。 */
export interface IndicatorSpec {
  indicator: IndicatorName;
  params: IndicatorParams;
}

/** 一行指标。`values` 的键与 `VALUE_COLUMNS` 一致（不含 `time`）。 */
export interface IndicatorRow {
  time: number;
  values: Record<string, number>;
}

/**
 * 该参数集的稳定标识，用于报错、图例与「哪些参数集已物化」的回显。
 *
 * **必须与 Python 侧 `ParamSet.label()` 逐字一致**：同一组参数在 CLI 摘要、`--check`
 * 报错与控制面图例里都靠这个字符串被指认，两边不一致就会出现「命令说 `SMA(5)`、
 * 界面说 `SMA(bars=5)`」——用户无从判断说的是不是同一件事。
 */
export function specLabel(spec: IndicatorSpec): string {
  if (spec.indicator === 'ma') {
    return `${String(spec.params['kind']).toUpperCase()}(${String(spec.params['bars'])})`;
  }
  const cols = PARAM_COLUMNS[spec.indicator] ?? [];
  if (cols.length === 0) return 'OBV()';
  return `${spec.indicator.toUpperCase()}(${cols.map((c) => String(spec.params[c] ?? '')).join(', ')})`;
}

/**
 * 物化命令提示。未物化时**必须**给出它（R-9.4）——只说「没有数据」而不说怎么算出来，
 * 用户只能在界面上反复点。
 */
export function materializeHint(symbol: string, interval: string): string {
  return `pnpm --filter @trade-tool/cli start -- data indicators --symbol ${symbol} --intervals ${interval}`;
}

/** float8 列的读取校验：NaN / Infinity 一律报错，不静默变成 null。 */
function readValue(value: unknown, column: string, symbol: string, time: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new SyncError(
      'NULL_NOT_ALLOWED',
      `${symbol} time=${String(time)} 的 ${column} 不是有限数（${String(value)}）：指标表存在损坏数据`,
      { symbol, time, column },
    );
  }
  return n;
}

function readMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

interface ParamFilter {
  sql: string;
  params: unknown[];
}

/**
 * 把参数集编成 WHERE 片段。**列名只来自 :data:`PARAM_COLUMNS`，值全部走占位符**——
 * 参数是用户可配的数据，绝不参与 SQL 拼接。
 */
function paramFilter(spec: IndicatorSpec, placeholderFrom: number): ParamFilter {
  const cols = PARAM_COLUMNS[spec.indicator] ?? [];
  if (cols.length === 0) return { sql: '', params: [] };
  const pieces: string[] = [];
  const params: unknown[] = [];
  for (const col of cols) {
    const value = spec.params[col];
    if (value === undefined) {
      throw new SyncError('CONFIG_INVALID', `${specLabel(spec)} 缺少参数 ${col}`, {
        indicator: spec.indicator,
        missing: col,
      });
    }
    if (typeof value !== 'number' && col !== 'kind') {
      throw new SyncError(
        'CONFIG_INVALID',
        `指标参数 ${col} 必须是整数（因为它是主键列），收到：${String(value)}`,
        { indicator: spec.indicator, column: col, value },
      );
    }
    pieces.push(`${col} = $${String(placeholderFrom + pieces.length)}`);
    params.push(value);
  }
  return { sql: ` AND ${pieces.join(' AND ')}`, params };
}

/** 该参数集是否**已经物化**过（至少有一行）。用于「未物化」的明确报错（R-9.4）。 */
export async function isSpecMaterialized(
  pool: Pool,
  symbol: string,
  interval: IndicatorInterval,
  spec: IndicatorSpec,
): Promise<boolean> {
  const table = INDICATOR_TABLES[spec.indicator];
  const filter = paramFilter(spec, 3);
  try {
    const result = await pool.query<{ n: string }>(
      `SELECT count(*)::bigint AS n FROM ${table} WHERE symbol = $1 AND interval = $2${filter.sql}`,
      [symbol, interval, ...filter.params],
    );
    return readMs(result.rows[0]?.n) !== 0;
  } catch (error) {
    throw toSyncError(error, `读取 ${symbol} ${specLabel(spec)} 是否已物化失败`);
  }
}

/**
 * 该 `(symbol, interval, 参数集)` 下**已物化的最大** `implVersion`；没有行返回 null。
 *
 * 读侧据此在 SQL 里锁定版本，而不是「取最新的那一版」——后者会让同一个查询在实现
 * 递增后返回不同的行，而用户看到的是「图自己变了」（R-9.3 / R-3.4）。
 *
 * 显式给 ``implVersion`` 时读那一版，用于**复现历史买点**。TS 侧因此完全不需要知道
 * `INDICATOR_IMPL_VERSION` 是几——那个常量只存在于 Python 侧，复制一份就会在实现递增
 * 后静默停在旧版本号上（R-9.3 / R-3.4）。
 */
async function resolveImplVersion(
  pool: Pool,
  symbol: string,
  interval: IndicatorInterval,
  spec: IndicatorSpec,
  explicit?: number | undefined,
): Promise<number | null> {
  if (explicit !== undefined) return explicit;
  const table = INDICATOR_TABLES[spec.indicator];
  const filter = paramFilter(spec, 3);
  try {
    const result = await pool.query<{ v: string | null }>(
      `SELECT max(impl_version) AS v FROM ${table}
        WHERE symbol = $1 AND interval = $2${filter.sql}`,
      [symbol, interval, ...filter.params],
    );
    return readMs(result.rows[0]?.v);
  } catch (error) {
    throw toSyncError(error, `读取 ${symbol} ${specLabel(spec)} 的 implVersion 失败`);
  }
}

/**
 * 读一个参数集的指标序列。
 *
 * 按 `time` **升序、按时间排布**返回；缺口处是**行缺失**（R-9.1）——不插值、不补 0。
 * 指标序列天然比 K 线短（少的正是预热期与未收盘的最后一根，R-2.4），这不是数据缺失。
 */
export async function readIndicatorSpec(
  pool: Pool,
  symbol: string,
  interval: IndicatorInterval,
  spec: IndicatorSpec,
  options: {
    from?: number | undefined;
    to?: number | undefined;
    limit?: number | undefined;
    implVersion?: number | undefined;
  } = {},
): Promise<{ rows: IndicatorRow[]; implVersion: number | null }> {
  const implVersion = await resolveImplVersion(pool, symbol, interval, spec, options.implVersion);
  if (implVersion === null) {
    // 未物化：明确报错 + 物化命令。返回空数组会让页面显示成「这段没有指标」，
    // 而真相是「这个参数集压根没算过」（R-9.4 / AC-12）。
    throw new SyncError(
      'CONFIG_INVALID',
      `${symbol} ${interval} 的 ${specLabel(spec)} 尚未物化。物化命令：${materializeHint(symbol, interval)}`,
      {
        symbol,
        interval,
        indicator: spec.indicator,
        params: spec.params,
        materializeCommand: materializeHint(symbol, interval),
      },
    );
  }
  const table = INDICATOR_TABLES[spec.indicator];
  const valueCols = VALUE_COLUMNS[spec.indicator] ?? [];
  // 占位符编号**按实际参数个数**生成，而不是写死。无参数指标（obv）的 filter.params
  // 为空，写死的编号会留下一个没人绑定的 `$5`，PostgreSQL 直接报
  // 「could not determine data type of parameter $5」——而它只在 obv 上出现。
  const filter = paramFilter(spec, 4);
  const next = 4 + (PARAM_COLUMNS[spec.indicator] ?? []).length;
  const fromAt = `$${String(next)}`;
  const toAt = `$${String(next + 1)}`;
  const limitAt = `$${String(next + 2)}`;
  try {
    // limit 倒序取最近 N 根再翻正——「最近 N 根」是页面的真实需求，
    // 而 `ORDER BY time ASC LIMIT n` 会返回**最早**的 N 根。
    const result = await pool.query<Record<string, unknown>>(
      `SELECT time, ${valueCols.join(', ')} FROM ${table}
        WHERE symbol = $1 AND interval = $2 AND impl_version = $3${filter.sql}
          AND (${fromAt}::bigint IS NULL OR time >= ${fromAt}::bigint)
          AND (${toAt}::bigint IS NULL OR time <= ${toAt}::bigint)
        ORDER BY time DESC
        LIMIT ${limitAt}::int`,
      [
        symbol,
        interval,
        implVersion,
        ...filter.params,
        options.from ?? null,
        options.to ?? null,
        options.limit ?? 500,
      ],
    );
    const rows = result.rows
      .map((row) => {
        const time = readMs(row['time']);
        if (time === null) {
          throw new SyncError('NULL_NOT_ALLOWED', `指标行 time 为空：${symbol}`, { symbol });
        }
        const values: Record<string, number> = {};
        for (const col of valueCols) values[col] = readValue(row[col], col, symbol, time);
        return { time, values };
      })
      .reverse();
    return { rows, implVersion };
  } catch (error) {
    throw toSyncError(error, `读取 ${symbol} ${interval} ${specLabel(spec)} 指标失败`);
  }
}

/**
 * 该 `(symbol, interval)` 下**全部已物化**的参数集清单。
 *
 * 存在的意义：控制面要能说清「现在图上画的是哪几组参数」以及「缺哪几组」。用配置里的
 * 缺省集合去猜是不行的——配置可以随时改，而库里是**改之前**物化的那一版。
 */
export async function listMaterializedSpecs(
  pool: Pool,
  symbol: string,
  interval: IndicatorInterval,
): Promise<
  Array<{ indicator: IndicatorName; params: IndicatorParams; implVersion: number; rows: number }>
> {
  const out: Array<{
    indicator: IndicatorName;
    params: IndicatorParams;
    implVersion: number;
    rows: number;
  }> = [];
  try {
    for (const indicator of Object.keys(INDICATOR_TABLES) as IndicatorName[]) {
      const table = INDICATOR_TABLES[indicator];
      const cols = PARAM_COLUMNS[indicator] ?? [];
      // 计数别名刻意**不叫** `n`：`kdj` 的参数列里就有一列叫 `n`，两者同在
      // GROUP BY / ORDER BY 的作用域里，`ORDER BY n` 会报 ambiguous——而这个错误
      // 只在 kdj 那张表上出现，其余六张表一切正常。
      const selectCols = [...cols, 'impl_version', 'count(*)::bigint AS row_count'];
      // `impl_version` **始终**进 GROUP BY：无参数指标（obv）的 cols 为空，
      // 少了它 PostgreSQL 会要求该列出现在聚合里——而它是逐版本分组的依据。
      const groupBy = ` GROUP BY ${[...cols, 'impl_version'].join(', ')}`;
      const orderBy = cols.length > 0 ? `${cols.join(', ')}, impl_version` : 'impl_version';
      const result = await pool.query<Record<string, unknown>>(
        `SELECT ${selectCols.join(', ')} FROM ${table}
          WHERE symbol = $1 AND interval = $2${groupBy}
          ORDER BY ${orderBy}`,
        [symbol, interval],
      );
      for (const row of result.rows) {
        const params: MutableParams = {};
        for (const col of cols) params[col] = row[col] as number | string;
        out.push({
          indicator,
          params,
          implVersion: readMs(row['impl_version']) ?? 1,
          rows: readMs(row['row_count']) ?? 0,
        });
      }
    }
    return out;
  } catch (error) {
    throw toSyncError(error, `读取 ${symbol} ${interval} 已物化参数集失败`);
  }
}

/** 7 张指标表的行数与**实测**体积（v0.3.0 R-11.2）。 */
export interface IndicatorTableStat {
  table: string;
  rows: number;
  /** `pg_total_relation_size` 实测值（含索引摊销），不是估算 */
  bytes: number;
}

export async function readIndicatorTableStats(
  pool: Pool,
  tables: readonly string[] = Object.values(INDICATOR_TABLES),
): Promise<IndicatorTableStat[]> {
  const stats: IndicatorTableStat[] = [];
  try {
    for (const table of tables) {
      const count = await pool.query<{ n: string }>(`SELECT count(*)::bigint AS n FROM ${table}`);
      const size = await pool.query<{ bytes: string | null }>(
        'SELECT pg_total_relation_size(to_regclass($1))::bigint AS bytes',
        [table],
      );
      stats.push({
        table,
        rows: readMs(count.rows[0]?.n) ?? 0,
        bytes: readMs(size.rows[0]?.bytes) ?? 0,
      });
    }
    return stats;
  } catch (error) {
    throw toSyncError(error, '读取指标表统计失败');
  }
}
