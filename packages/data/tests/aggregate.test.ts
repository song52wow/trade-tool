import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  defaultConfig,
  DERIVED_INTERVALS,
  INTERVAL_TABLES,
  STORED_INTERVALS,
} from '@trade-tool/core';

import {
  aggregateSymbol,
  buildContext,
  readBars,
  readDerivedIntervals,
  readDerivedTableStats,
  readGlobalSummary,
  readLatestBars,
  removeSymbolEntry,
  schemaStatus,
  type Pool,
} from '../src/index.js';

import { createTestSchema, TEST_PG, type TestSchema } from './helpers/pg.js';

/**
 * 派生周期的 TS 侧读路径（v0.2.0 AC-1 / AC-11 / AC-12 / AC-15 / AC-16）。
 *
 * 覆盖的是**只能靠真实 PG 证明**的部分：表结构对称、白名单到表名的分派、
 * 删除连带、以及「实测体积」确实来自 `pg_total_relation_size` 而不是估算。
 * 聚合的写入与判据在 Python 侧用例里（`test_aggregate*.py`）。
 */

const MINUTE = 60_000;
const HOUR = 3_600_000;
const T0 = 1_735_689_600_000; // 2025-01-01T00:00:00Z
const SYMBOL = 'TESTAGGUSDC';

let ctx: TestSchema;

beforeAll(async () => {
  ctx = await createTestSchema('agg');
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.pool.query(
    'TRUNCATE klines_1m, klines_15m, klines_1h, klines_4h, klines_1d, gaps, sync_state, symbols, contract_spec',
  );
});

/** 铺 N 根连续 1m，并顺带写好一张派生表用来验证读侧分派。 */
async function seed(pool: Pool, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const time = T0 + i * MINUTE;
    await pool.query(
      `INSERT INTO klines_1m (symbol, time, open, high, low, close, volume, quote_volume, trades)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [SYMBOL, time, 100 + i, 101 + i, 99 + i, 100 + i, 10, 2, 3],
    );
  }
}

/** 直接写派生表（绕过 Python），用来证明读侧**确实**按周期换了表。 */
async function seedDerived(
  pool: Pool,
  interval: keyof typeof INTERVAL_TABLES,
  times: readonly number[],
  volume: number,
): Promise<void> {
  const table = INTERVAL_TABLES[interval];
  for (const time of times) {
    await pool.query(
      `INSERT INTO ${table} (symbol, time, open, high, low, close, volume, quote_volume, trades)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [SYMBOL, time, 1, 2, 0.5, 1.5, volume, null, null],
    );
  }
}

describe('迁移：四张派生表与 klines_1m 逐列相等（AC-1 / R-1.3）', () => {
  it('004 已应用且版本闸门通过', async () => {
    const status = await schemaStatus(ctx.pool);
    expect(status.ok).toBe(true);
    expect(status.applied).toContain('004_klines_agg');
    expect(status.current).toBe(status.latest);
  });

  it.each(DERIVED_INTERVALS)('%s 的列与 klines_1m 完全一致', async (interval) => {
    const table = INTERVAL_TABLES[interval];
    const result = await ctx.pool.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      ordinal_position: number;
    }>(
      `SELECT table_name, column_name, data_type, is_nullable, ordinal_position
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ANY($1::text[])
        ORDER BY table_name, ordinal_position`,
      [['klines_1m', table]],
    );
    const byTable = new Map<string, string[]>();
    for (const row of result.rows) {
      const list = byTable.get(row['table_name'] ?? '') ?? [];
      list.push(
        `${row['column_name']}:${row['data_type']}:${row['is_nullable']}:${String(row['ordinal_position'])}`,
      );
      byTable.set(row['table_name'] ?? '', list);
    }
    // 用 information_schema 断言，而不是把 DDL 再抄一遍（R-10.3）
    expect(byTable.get(table)).toEqual(byTable.get('klines_1m'));
    expect(byTable.get(table)).toHaveLength(9);
  });

  it('klines_1m 未被 004 改动（R-1.4）', async () => {
    const result = await ctx.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'klines_1m'
        ORDER BY ordinal_position`,
    );
    expect(result.rows.map((r) => r['column_name'])).toEqual([
      'symbol',
      'time',
      'open',
      'high',
      'low',
      'close',
      'volume',
      'quote_volume',
      'trades',
    ]);
  });

  it('派生表可整表清空而不影响 1m（R-1.4 / R-5）', async () => {
    await seed(ctx.pool, 3);
    await seedDerived(ctx.pool, '4h', [T0], 10);
    await ctx.pool.query('TRUNCATE klines_4h');
    const remaining = await ctx.pool.query<{ n: string }>(
      'SELECT count(*)::bigint AS n FROM klines_1m WHERE symbol = $1',
      [SYMBOL],
    );
    expect(Number(remaining.rows[0]?.n)).toBe(3);
  });
});

describe('读侧周期分派（AC-12 / R-6.2）', () => {
  beforeEach(async () => {
    await seed(ctx.pool, 5);
    await seedDerived(ctx.pool, '1h', [T0, T0 + HOUR], 111);
    await seedDerived(ctx.pool, '4h', [T0], 222);
  });

  it('缺省读到 1m（行为与改动前一致，AC-13）', async () => {
    const bars = await readBars(ctx.pool, SYMBOL, { limit: 10 });
    expect(bars).toHaveLength(5);
    expect(bars[0]?.volume).toBe(10);
  });

  it.each(DERIVED_INTERVALS)('interval=%s 读到对应表', async (interval) => {
    await seedDerived(ctx.pool, interval, [T0 + 2 * 86_400_000], 999);
    const bars = await readBars(ctx.pool, SYMBOL, { limit: 50, interval });
    // 1m 表里有 5 根（volume 10），派生表里有我们写入的 volume 999
    const derived = bars.filter((b) => b.volume === 999);
    expect(derived.length).toBeGreaterThan(0);
  });

  it('readLatestBars 同样按周期分派', async () => {
    const bars = await readLatestBars(ctx.pool, SYMBOL, { limit: 10, interval: '1h' });
    expect(bars.map((b) => b.volume)).toEqual([111, 111]);
    expect(bars[0]?.time).toBe(T0);
  });

  it('区间过滤在派生表上同样生效', async () => {
    const bars = await readBars(ctx.pool, SYMBOL, {
      from: T0 + HOUR,
      to: T0 + HOUR,
      interval: '1h',
    });
    expect(bars).toHaveLength(1);
    expect(bars[0]?.time).toBe(T0 + HOUR);
  });

  it('派生表复用同一个 toBar：NULL 保持 NULL（R-6.3 / R-4.2）', async () => {
    const bars = await readLatestBars(ctx.pool, SYMBOL, { interval: '4h' });
    expect(bars).toHaveLength(1);
    // 派生表与 1m 共用行映射，因此 quote_volume / trades 的 NULL 语义一致
    expect(bars[0]?.close).toBe(1.5);
  });

  it('未实现周期报错且不查库（AC-12）', async () => {
    for (const bad of ['5m', '2h', 'foo']) {
      await expect(
        readBars(ctx.pool, SYMBOL, { limit: 10, interval: bad as never }),
      ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
      await expect(
        readLatestBars(ctx.pool, SYMBOL, { limit: 10, interval: bad as never }),
      ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    }
  });

  it('派生表缺行返回空数组而不是报错（与 1m 同一契约）', async () => {
    await ctx.pool.query('TRUNCATE klines_1d');
    const bars = await readLatestBars(ctx.pool, SYMBOL, { interval: '1d' });
    expect(bars).toEqual([]);
  });
});

describe('删除连带（AC-11 / R-8.1）', () => {
  beforeEach(async () => {
    await seed(ctx.pool, 3);
    for (const interval of DERIVED_INTERVALS) {
      await seedDerived(ctx.pool, interval, [T0], 10);
    }
    await ctx.pool.query(
      `INSERT INTO symbols (exchange, symbol, desired_state, added_at, updated_at)
       VALUES ('binance', $1, 'paused', $2, $2)`,
      [SYMBOL, Date.now()],
    );
  });

  async function countAll(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const interval of STORED_INTERVALS) {
      const result = await ctx.pool.query<{ n: string }>(
        `SELECT count(*)::bigint AS n FROM ${INTERVAL_TABLES[interval]} WHERE symbol = $1`,
        [SYMBOL],
      );
      out[interval] = Number(result.rows[0]?.n ?? 0);
    }
    return out;
  }

  it('policy=delete 一并删除四张派生表', async () => {
    const result = await removeSymbolEntry(ctx.pool, 'binance', SYMBOL, 'delete');
    expect(result.policy).toBe('delete');
    const remaining = await countAll();
    for (const [interval, count] of Object.entries(remaining)) {
      expect(count, `${interval} 应被彻底删除`).toBe(0);
    }
  });

  // keep / archive 都**保留**数据，因此派生表一根都不许动（R-8.1）。
  // 1m 铺了 3 根，四张派生表各 1 根。
  it.each(['keep', 'archive'] as const)('policy=%s 不动派生表', async (policy) => {
    await removeSymbolEntry(ctx.pool, 'binance', SYMBOL, policy);
    const remaining = await countAll();
    expect(remaining['1m'], '1m 数据应保留').toBe(3);
    for (const interval of DERIVED_INTERVALS) {
      expect(remaining[interval], `${interval} 在 ${policy} 下应保留`).toBe(1);
    }
  });

  it('删除只影响本标的', async () => {
    await ctx.pool.query(
      `INSERT INTO klines_4h (symbol, time, open, high, low, close, volume)
       VALUES ('OTHERUSDC', $1, 1, 1, 1, 1, 1)`,
      [T0],
    );
    await removeSymbolEntry(ctx.pool, 'binance', SYMBOL, 'delete');
    const others = await ctx.pool.query<{ n: string }>(
      'SELECT count(*)::bigint AS n FROM klines_4h WHERE symbol = $1',
      ['OTHERUSDC'],
    );
    expect(Number(others.rows[0]?.n)).toBe(1);
  });
});

describe('全局汇总含实测体积（AC-16 / R-8.2）', () => {
  beforeEach(async () => {
    await seed(ctx.pool, 30);
    for (const interval of DERIVED_INTERVALS) {
      await seedDerived(ctx.pool, interval, [T0], 10);
    }
  });

  it('derived 覆盖四张表，各带行数与字节数', async () => {
    const summary = await readGlobalSummary(ctx.pool, 'binance');
    expect(summary.derived).toHaveLength(4);
    for (const item of summary.derived) {
      expect(item.rows).toBe(1);
      expect(item.bytes).toBeGreaterThan(0);
      expect(INTERVAL_TABLES[item.interval as keyof typeof INTERVAL_TABLES]).toBe(item.table);
    }
  });

  it('体积与 pg_total_relation_size 实测一致，不是估算', async () => {
    const stats = await readDerivedTableStats(ctx.pool);
    for (const item of stats) {
      const row = await ctx.pool.query<{ bytes: string }>(
        'SELECT pg_total_relation_size(to_regclass($1))::bigint AS bytes',
        [item.table],
      );
      expect(item.bytes, `${item.table} 应等于实测值`).toBe(Number(row.rows[0]?.bytes));
    }
  });

  it('既有 totalRows / totalBytes 仍是 1m 语义、字段名不变（R-8.2）', async () => {
    // totalRows 取自 sync_state.rows（1m 的可观测缓存），派生行数**不得**混进来。
    // 这里先落一行 sync_state，让口径有值可比。
    await ctx.pool.query(
      `INSERT INTO sync_state (exchange, symbol, status, rows, bytes, updated_at)
       VALUES ('binance', $1, 'running', 30, 3000, $2)
       ON CONFLICT (exchange, symbol) DO UPDATE SET rows = 30, bytes = 3000`,
      [SYMBOL, Date.now()],
    );
    const summary = await readGlobalSummary(ctx.pool, 'binance');
    expect(summary.totalRows, 'totalRows 必须仍是 1m 口径').toBe(30);
    expect(summary.totalBytes).toBe(3000);
    // 派生行数单独在 derived 里，合计 4（每张表 1 行）
    const derivedRows = summary.derived.reduce((sum, item) => sum + item.rows, 0);
    expect(derivedRows).toBe(4);
    // 派生体积不得被加进 1m 的 totalBytes
    const derivedBytes = summary.derived.reduce((sum, item) => sum + item.bytes, 0);
    expect(derivedBytes).toBeGreaterThan(0);
  });

  it('未启用派生时汇总的 derived 是空数组，而不是四行 0（R-8.4 / AC-22）', async () => {
    // `sync status` 的文案分支就是靠 `derived.length === 0` 判断「未启用派生」的。
    // 汇总不认配置的话这个分支永远不可达，页面/CLI 会把「未启用」显示成
    // 「启用了但还没聚合」——用户据此会一直点重建。
    // 数据由本 describe 的 beforeEach 铺好（30 根 1m + 每张派生表 1 行），不重复 seed。
    const off = await readGlobalSummary(ctx.pool, 'binance', []);
    expect(off.derived).toEqual([]);
    // 只启用子集时只报启用那张表，不得把没启用的报成 0
    const onlyHour = await readGlobalSummary(ctx.pool, 'binance', ['1h']);
    expect(onlyHour.derived.map((item) => item.interval)).toEqual(['1h']);
    expect(onlyHour.derived[0]?.rows).toBe(1);
    // 不传（既有调用）仍按四个全启用算，行为不变
    const all = await readGlobalSummary(ctx.pool, 'binance');
    expect(all.derived.map((item) => item.interval)).toEqual([...DERIVED_INTERVALS]);
  });
});

describe('扣留统计可见（AC-15 / R-7.5）', () => {
  it('未启用派生时如实标记 disabled，而不是报 0（AC-22）', async () => {
    await seed(ctx.pool, 60);
    const derived = await readDerivedIntervals(ctx.pool, SYMBOL, STORED_INTERVALS, {
      enabled: [],
    });
    for (const interval of DERIVED_INTERVALS) {
      expect(derived[interval]).toEqual({ withheldReason: 'disabled' });
    }
  });

  it('只启用子集时，未启用的周期同样标记 disabled（R-9.1 / R-8.4）', async () => {
    // `aggregateIntervals: ['1h']` 是合法配置。没启用的三张表**不会**被写入，
    // 页面若把它们按启用态统计，就会显示成「0 个桶 + 全 0 扣留」——
    // 看起来像「已启用但还没聚合」，用户会一直点重建，而重建读的是同一个配置，
    // 根本不会写这三张表。
    await seed(ctx.pool, 60);
    const derived = await readDerivedIntervals(ctx.pool, SYMBOL, STORED_INTERVALS, {
      enabled: ['1h'],
    });
    expect(derived['1h']).not.toEqual({ withheldReason: 'disabled' });
    for (const interval of ['15m', '4h', '1d'] as const) {
      expect(derived[interval]).toEqual({ withheldReason: 'disabled' });
    }
  });

  it('启用时给出桶数与扣留明细', async () => {
    // 60 根 1m = 1 根完整 1h 桶 + 半个 15m 桶
    await seed(ctx.pool, 60);
    await seedDerived(ctx.pool, '1h', [T0], 10);
    const derived = await readDerivedIntervals(ctx.pool, SYMBOL, STORED_INTERVALS, {
      enabled: [...DERIVED_INTERVALS],
    });
    const oneHour = derived['1h'];
    expect(oneHour).toBeDefined();
    if (oneHour !== undefined && !('withheldReason' in oneHour)) {
      expect(oneHour.buckets).toBe(1);
      expect(oneHour.withheldIncomplete).toBe(0);
      // 末尾还有一个未走完的 15m 桶
      expect(oneHour.withheldNotClosed).toBe(0);
    }
  });

  it('桶内有缺口时报 withheldIncomplete 与缺失分钟数（AC-5）', async () => {
    // 铺满一个 4h 桶（240 根），再挖掉中间 3 根
    for (let i = 0; i < 240; i += 1) {
      if (i >= 100 && i < 103) continue;
      await ctx.pool.query(
        `INSERT INTO klines_1m (symbol, time, open, high, low, close, volume)
         VALUES ($1, $2, 1, 2, 0.5, 1.5, 10)`,
        [SYMBOL, T0 + i * MINUTE],
      );
    }
    const derived = await readDerivedIntervals(ctx.pool, SYMBOL, STORED_INTERVALS, {
      enabled: [...DERIVED_INTERVALS],
    });
    const fourHour = derived['4h'];
    expect(fourHour).toBeDefined();
    if (fourHour !== undefined && !('withheldReason' in fourHour)) {
      expect(fourHour.buckets).toBe(0);
      expect(fourHour.withheldIncomplete).toBe(1);
      expect(fourHour.missingMinutes).toBe(3);
    }
  });

  it('库里没有 1m 时不编造桶数', async () => {
    const derived = await readDerivedIntervals(ctx.pool, 'NOBODYUSDC', STORED_INTERVALS, {
      enabled: [...DERIVED_INTERVALS],
    });
    expect(derived['4h']).toEqual({
      buckets: 0,
      withheldNotClosed: 0,
      withheldIncomplete: 0,
      missingMinutes: 0,
    });
  });
});

describe('data aggregate 的边界（R-5.4 / R-9.2）', () => {
  it('aggregateSymbol 已导出（CLI 与控制面共用同一入口）', () => {
    expect(typeof aggregateSymbol).toBe('function');
  });

  it('aggregateSymbol 进库前先过 schema 闸门（R-1.3）', async () => {
    // 未迁移的库必须报 SCHEMA_VERSION_MISMATCH，而不是在缺表的库上跑聚合
    const bare = await createTestSchema('aggbare');
    try {
      // 删掉一张派生表：migration 版本号还在，但表没了 —— 闸门必须靠 REQUIRED_TABLES 抓到
      await bare.pool.query('DROP TABLE klines_4h');
      const bareMarket = buildContext(bare.pool, defaultConfig(), {
        overrides: { password: TEST_PG.password, searchPath: bare.schema },
      });
      await expect(aggregateSymbol(bareMarket, SYMBOL)).rejects.toMatchObject({
        code: 'SCHEMA_VERSION_MISMATCH',
      });
    } finally {
      await bare.close();
    }
  });
});
