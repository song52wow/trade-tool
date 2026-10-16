/**
 * 指标读侧的用例（v0.3.0 R-9 / AC-12）。
 *
 * 重点全在「不许静默兜底」上：非法周期一次查询都不发、未物化的参数集必须**明确报错**
 * 并给出物化命令（而不是返回空数组假装成功）、回传实际生效的 `implVersion`。
 *
 * 跑在随机命名的独立 schema 上（helpers/pg.ts），**绝不连生产库**。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  INDICATOR_INTERVALS,
  INDICATOR_TABLES,
  PARAM_COLUMNS,
  isIndicatorInterval,
  listMaterializedSpecs,
  materializeHint,
  parseIndicatorInterval,
  readIndicatorSpec,
  readIndicatorTableStats,
  specLabel,
  type IndicatorSpec,
} from '../src/db/indicators.js';
import { SyncError } from '@trade-tool/core';

import { createTestSchema, type TestSchema } from './helpers/pg.js';

const SYMBOL = 'READSIDEUSDC';
const HOUR = 3_600_000;
const T0 = 1_760_000_000_000;

let schema: TestSchema;

beforeEach(async () => {
  schema = await createTestSchema('ind');
});

afterEach(async () => {
  await schema.close();
});

function spec(indicator: IndicatorSpec['indicator'], params: Record<string, number | string>) {
  return { indicator, params };
}

async function insert(
  indicator: IndicatorSpec['indicator'],
  params: Record<string, number | string>,
  rows: Array<{ time: number; values: Record<string, number> }>,
  interval = '1h',
): Promise<void> {
  const cols = PARAM_COLUMNS[indicator] ?? [];
  // 无参数指标（obv）的 `cols` 为空：列清单与占位符都不能因此多出一个逗号，
  // 否则拼出来的是 `impl_version, , time` ——一个当场语法错的 SQL。
  const colsSql = cols.length > 0 ? `${cols.join(', ')}, ` : '';
  const colsPh = cols.map((_, i) => `$${String(i + 3)}`).join(', ');
  const colsPhSql = cols.length > 0 ? `${colsPh}, ` : '';
  const valueCols = Object.keys(rows[0]?.values ?? {});
  const timeAt = String(cols.length + 3);
  const valueAt = (i: number) => `$${String(cols.length + 4 + i)}`;
  for (const row of rows) {
    await schema.pool.query(
      `INSERT INTO ${INDICATOR_TABLES[indicator]}
         (symbol, interval, impl_version, ${colsSql}time, ${valueCols.join(', ')})
       VALUES ($1, $2, 1, ${colsPhSql}$${timeAt}, ${valueCols.map((_, i) => valueAt(i)).join(', ')})`,
      [
        SYMBOL,
        interval,
        ...cols.map((c) => params[c] ?? null),
        row.time,
        ...valueCols.map((c) => row.values[c] ?? 0),
      ],
    );
  }
}

describe('指标周期白名单（AC-12）', () => {
  it('缺省 1h', () => {
    expect(parseIndicatorInterval(undefined)).toBe('1h');
    expect(parseIndicatorInterval('')).toBe('1h');
  });

  it('接受四个已实现的周期', () => {
    for (const interval of INDICATOR_INTERVALS) {
      expect(parseIndicatorInterval(interval)).toBe(interval);
      expect(isIndicatorInterval(interval)).toBe(true);
    }
  });

  it('1m / 5m / 任意未知值一律 CONFIG_INVALID', () => {
    for (const bad of ['1m', '5m', '2h', 'foo', '1H']) {
      expect(() => parseIndicatorInterval(bad)).toThrow(SyncError);
      try {
        parseIndicatorInterval(bad);
      } catch (error) {
        expect((error as SyncError).code).toBe('CONFIG_INVALID');
        // 错误信息要说清「为什么不行」与「能用什么」，而不是只说非法
        expect((error as SyncError).message).toContain('1m 不做指标物化');
      }
    }
  });

  it('1m 确实不在允许集合里', () => {
    expect(isIndicatorInterval('1m')).toBe(false);
    expect(INDICATOR_INTERVALS).not.toContain('1m');
  });
});

describe('specLabel 与物化命令提示', () => {
  it('标签与 Python 侧 `ParamSet.label()` 逐字一致', () => {
    expect(specLabel(spec('ma', { kind: 'sma', bars: 20 }))).toBe('SMA(20)');
    expect(specLabel(spec('macd', { fast: 12, slow: 26, signal: 9 }))).toBe('MACD(12, 26, 9)');
    expect(specLabel(spec('obv', {}))).toBe('OBV()');
    expect(specLabel(spec('kdj', { n: 9, k_period: 3, d_period: 3 }))).toBe('KDJ(9, 3, 3)');
  });

  it('未物化时给出的命令是可直接执行的', () => {
    const hint = materializeHint(SYMBOL, '1h');
    expect(hint).toContain('data indicators');
    expect(hint).toContain('--symbol READSIDEUSDC');
    expect(hint).toContain('--intervals 1h');
  });
});

describe('readIndicatorSpec', () => {
  it('按 time 升序返回，并回传实际生效的 implVersion', async () => {
    await insert('rsi', { period: 14 }, [
      { time: T0 + 2 * HOUR, values: { value: 52 } },
      { time: T0, values: { value: 50 } },
      { time: T0 + HOUR, values: { value: 51 } },
    ]);
    const result = await readIndicatorSpec(schema.pool, SYMBOL, '1h', spec('rsi', { period: 14 }));
    expect(result.implVersion).toBe(1);
    expect(result.rows.map((r) => r.time)).toEqual([T0, T0 + HOUR, T0 + 2 * HOUR]);
    expect(result.rows.map((r) => r.values['value'])).toEqual([50, 51, 52]);
  });

  it('未物化的参数集**明确报错并给出物化命令**，不返回空数组', async () => {
    await expect(
      readIndicatorSpec(schema.pool, SYMBOL, '1h', spec('rsi', { period: 7 })),
    ).rejects.toThrow(/尚未物化/);
    try {
      await readIndicatorSpec(schema.pool, SYMBOL, '1h', spec('rsi', { period: 7 }));
    } catch (error) {
      const err = error as SyncError;
      expect(err.code).toBe('CONFIG_INVALID');
      expect(err.details['materializeCommand']).toContain('data indicators');
    }
  });

  it('参数集不同就是不同的序列，不会串味', async () => {
    await insert('rsi', { period: 14 }, [{ time: T0, values: { value: 60 } }]);
    await insert('rsi', { period: 7 }, [{ time: T0, values: { value: 40 } }]);
    const long = await readIndicatorSpec(schema.pool, SYMBOL, '1h', spec('rsi', { period: 14 }));
    const short = await readIndicatorSpec(schema.pool, SYMBOL, '1h', spec('rsi', { period: 7 }));
    expect(long.rows[0]?.values['value']).toBe(60);
    expect(short.rows[0]?.values['value']).toBe(40);
  });

  it('周期不同也是不同的序列', async () => {
    await insert('obv', {}, [{ time: T0, values: { value: 1 } }], '1h');
    await insert('obv', {}, [{ time: T0, values: { value: 2 } }], '4h');
    const hour = await readIndicatorSpec(schema.pool, SYMBOL, '1h', spec('obv', {}));
    const four = await readIndicatorSpec(schema.pool, SYMBOL, '4h', spec('obv', {}));
    expect(hour.rows[0]?.values['value']).toBe(1);
    expect(four.rows[0]?.values['value']).toBe(2);
  });

  it('缺参数直接报 CONFIG_INVALID，而不是拿默认值去查', async () => {
    await expect(readIndicatorSpec(schema.pool, SYMBOL, '1h', spec('rsi', {}))).rejects.toThrow(
      /缺少参数 period/,
    );
  });

  it('显式指定 implVersion 时读那一版（复现历史买点）', async () => {
    await insert('obv', {}, [{ time: T0, values: { value: 1 } }]);
    await schema.pool.query(
      `INSERT INTO indicator_obv (symbol, interval, impl_version, time, value)
       VALUES ($1, '1h', 2, $2, 99)`,
      [SYMBOL, T0],
    );
    const latest = await readIndicatorSpec(schema.pool, SYMBOL, '1h', spec('obv', {}));
    expect(latest.implVersion).toBe(2);
    const historical = await readIndicatorSpec(schema.pool, SYMBOL, '1h', spec('obv', {}), {
      implVersion: 1,
    });
    expect(historical.implVersion).toBe(1);
    expect(historical.rows[0]?.values['value']).toBe(1);
  });
});

describe('listMaterializedSpecs', () => {
  it('列出库里**实际有什么**，而不是配置里写了什么', async () => {
    await insert('rsi', { period: 14 }, [{ time: T0, values: { value: 50 } }]);
    await insert('ma', { kind: 'sma', bars: 5 }, [{ time: T0, values: { value: 1 } }]);
    const listed = await listMaterializedSpecs(schema.pool, SYMBOL, '1h');
    const keys = listed.map((s) => `${s.indicator}:${JSON.stringify(s.params)}`).sort();
    expect(keys).toEqual(['ma:{"kind":"sma","bars":5}', 'rsi:{"period":14}']);
    expect(listed.every((s) => s.rows === 1)).toBe(true);
  });

  it('一个都没物化时返回空数组（由调用方决定报「未物化」还是「未启用」）', async () => {
    expect(await listMaterializedSpecs(schema.pool, SYMBOL, '1h')).toEqual([]);
  });
});

describe('readIndicatorTableStats', () => {
  it('返回 7 张表的实测行数与体积', async () => {
    await insert('obv', {}, [{ time: T0, values: { value: 1 } }]);
    const stats = await readIndicatorTableStats(schema.pool);
    expect(stats).toHaveLength(7);
    const obv = stats.find((s) => s.table === 'indicator_obv');
    expect(obv?.rows).toBe(1);
    expect(obv?.bytes).toBeGreaterThan(0);
  });
});

describe('schema 侧的硬约束（AC-2）', () => {
  it('interval 的 CHECK 不含 1m —— 直接问 information_schema', async () => {
    const result = await schema.pool.query<{ pg_get_constraintdef: string }>(
      `SELECT pg_get_constraintdef(oid) AS pg_get_constraintdef
         FROM pg_constraint
        WHERE conrelid = 'indicator_obv'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%interval%'`,
    );
    const defs = result.rows.map((r) => r.pg_get_constraintdef).join(' ');
    expect(defs).toContain('1h');
    expect(defs).not.toMatch(/'1m'/);
  });

  it('参数列都是 NOT NULL 且带正数 CHECK', async () => {
    await expect(
      schema.pool.query(
        `INSERT INTO indicator_ma (symbol, interval, impl_version, kind, bars, time, value)
         VALUES ($1, '1h', 1, 'sma', 0, $2, 1.0)`,
        [SYMBOL, T0],
      ),
    ).rejects.toThrow();
  });

  it('k_milli 允许 0、不允许负数', async () => {
    await expect(
      schema.pool.query(
        `INSERT INTO indicator_boll
           (symbol, interval, impl_version, period, k_milli, time, upper, mid, lower)
         VALUES ($1, '1h', 1, 20, -1, $2, 1, 1, 1)`,
        [SYMBOL, T0],
      ),
    ).rejects.toThrow();
    await expect(
      schema.pool.query(
        `INSERT INTO indicator_boll
           (symbol, interval, impl_version, period, k_milli, time, upper, mid, lower)
         VALUES ($1, '1h', 1, 20, 0, $2, 1, 1, 1)`,
        [SYMBOL, T0],
      ),
    ).resolves.toBeDefined();
  });
});
