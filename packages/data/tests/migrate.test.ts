import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool, migrate, resolveSqlDir, listMigrations, schemaStatus } from '../src/index.js';

import { createTestSchema, TEST_DATABASE_CONFIG, TEST_PG } from './helpers/pg.js';

const MINUTE = 60_000;

describe('迁移（R-1 / AC-1）', () => {
  let ctx: Awaited<ReturnType<typeof createTestSchema>>;

  beforeAll(async () => {
    ctx = await createTestSchema('mig');
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('AC-1 从空库一路迁到最新版本', async () => {
    // createTestSchema 建的是全新空 schema 并已跑完迁移，这里断言结果而非过程。
    const status = await schemaStatus(ctx.pool);
    expect(status.ok).toBe(true);
    expect(status.behind).toEqual([]);
    expect(status.ahead).toEqual([]);
    expect(status.current).toBe(status.latest);

    const recorded = await ctx.pool.query<{ version: string }>(
      'SELECT version FROM schema_migrations',
    );
    expect(recorded.rows.length).toBeGreaterThan(0);
  });

  it('AC-1 重复执行仍成功且无变化（幂等）', async () => {
    const first = await schemaStatus(ctx.pool);
    expect(first.ok).toBe(true);

    // 同一 schema 上再迁一次：applied 应为空。
    const second = await migrate(ctx.pool);
    expect(second.applied).toEqual([]);
    expect(second.skipped.length).toBeGreaterThan(0);

    const after = await schemaStatus(ctx.pool);
    expect(after.applied).toEqual(first.applied);
    expect(after.ok).toBe(true);
  });

  it('核心表与唯一约束都存在', async () => {
    const tables = await ctx.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
      [ctx.schema],
    );
    const names = tables.rows.map((r) => r.table_name);
    for (const expected of [
      'klines_1m',
      'contract_spec',
      'sync_state',
      'gaps',
      'symbols',
      'schema_migrations',
      'weight_budget',
    ]) {
      expect(names, `缺少表 ${expected}`).toContain(expected);
    }
  });

  it('klines_1m 在 (symbol, time) 上有主键/唯一约束', async () => {
    const result = await ctx.pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'klines_1m'`,
      [ctx.schema],
    );
    const defs = result.rows.map((r) => r.indexdef).join('\n');
    // 主键在 pg_indexes 里表现为 UNIQUE INDEX；time 是保留字所以会被加引号。
    expect(defs).toMatch(/CREATE UNIQUE INDEX[\s\S]*\(symbol, "time"\)/);
  });

  it('R-1.6 时间列是 bigint 而不是 timestamptz', async () => {
    const result = await ctx.pool.query<{ data_type: string; column_name: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'klines_1m'`,
      [ctx.schema],
    );
    const types = new Map(result.rows.map((r) => [r.column_name, r.data_type]));
    expect(types.get('time')).toBe('bigint');
    expect(types.get('time')).not.toBe('timestamp with time zone');
  });

  it('R-4.1/R-4.2 NOT NULL 语义：必填列 NOT NULL，可选列可为 NULL', async () => {
    const result = await ctx.pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'klines_1m'`,
      [ctx.schema],
    );
    const nullable = new Map(result.rows.map((r) => [r.column_name, r.is_nullable]));
    for (const column of ['symbol', 'time', 'open', 'high', 'low', 'close', 'volume']) {
      expect(nullable.get(column), `${column} 应为 NOT NULL`).toBe('NO');
    }
    for (const column of ['quote_volume', 'trades']) {
      expect(nullable.get(column), `${column} 应允许 NULL`).toBe('YES');
    }
  });

  it('AC-9 写入 NULL 到必填列会失败', async () => {
    await expect(
      ctx.pool.query(
        `INSERT INTO klines_1m (symbol, time, open, high, low, close, volume)
         VALUES ($1, $2, NULL, 1, 1, 1, 1)`,
        ['X', Date.now()],
      ),
    ).rejects.toThrow();
  });

  it('AC-9 quote_volume / trades 允许 NULL，且 0 与 NULL 可区分', async () => {
    const t = Date.now();
    await ctx.pool.query(
      `INSERT INTO klines_1m (symbol, time, open, high, low, close, volume, quote_volume, trades)
       VALUES ($1, $2, 1, 1, 1, 1, 0, NULL, NULL), ($1, $3, 1, 1, 1, 1, 0, 0, 0)`,
      ['NULLSEM', t, t + MINUTE],
    );
    const result = await ctx.pool.query<{
      quote_volume: number | null;
      trades: string | number | null;
    }>('SELECT quote_volume, trades FROM klines_1m WHERE symbol = $1 ORDER BY time', ['NULLSEM']);
    expect(result.rows[0]?.quote_volume).toBeNull();
    expect(result.rows[0]?.trades).toBeNull();
    // 0 是合法值，绝不能被当成缺失（R-4.3）。
    // trades 是 bigint，pg 默认按字符串返回——这正是 repo 层统一转 number 的原因。
    expect(result.rows[1]?.quote_volume).toBe(0);
    expect(Number(result.rows[1]?.trades)).toBe(0);
  });

  it('R-1.8 1m 大表使用 BRIN 索引（体积优先）', async () => {
    const result = await ctx.pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'klines_1m' AND indexdef ILIKE '%brin%'`,
      [ctx.schema],
    );
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it('weight_budget 是单行表（R-20 全局预算）', async () => {
    const result = await ctx.pool.query<{ n: string }>(
      'SELECT count(*)::bigint AS n FROM weight_budget',
    );
    expect(Number(result.rows[0]?.n)).toBe(1);
  });

  it('R-18.4 重复插入同一标的幂等', async () => {
    const now = Date.now();
    for (let i = 0; i < 3; i += 1) {
      await ctx.pool.query(
        `INSERT INTO symbols (exchange, symbol, desired_state, added_at, updated_at)
         VALUES ($1, $2, 'paused', $3, $3)
         ON CONFLICT (exchange, symbol) DO UPDATE SET updated_at = EXCLUDED.updated_at`,
        ['binance', 'IDEM', now],
      );
    }
    const result = await ctx.pool.query<{ n: string }>(
      'SELECT count(*)::bigint AS n FROM symbols WHERE symbol = $1',
      ['IDEM'],
    );
    expect(Number(result.rows[0]?.n)).toBe(1);
  });
});

describe('迁移文件（R-1.1）', () => {
  it('迁移文件在版本控制目录内，且命名可排序', () => {
    const dir = resolveSqlDir();
    const migrations = listMigrations(dir);
    expect(migrations.length).toBeGreaterThan(0);
    const versions = migrations.map((m) => m.version);
    expect([...versions].sort()).toEqual(versions);
    for (const migration of migrations) {
      expect(migration.sql.length).toBeGreaterThan(0);
    }
  });
});

describe('版本闸门（R-1.3 / AC-1 / R-19.7）', () => {
  it('库落后时报错而不是继续运行', async () => {
    // 一个只有 schema_migrations、没有业务表的空 schema = 迁移未跑
    const pool = createPool(TEST_DATABASE_CONFIG, {
      overrides: { max: 2, searchPath: 'public', password: TEST_PG.password },
    });
    const unique = `tt_stale_${Date.now().toString(36)}`;
    await pool.query(`CREATE SCHEMA ${unique}`);
    await pool.end();

    const stale = createPool(TEST_DATABASE_CONFIG, {
      overrides: { max: 2, searchPath: unique, password: TEST_PG.password },
    });
    try {
      const status = await schemaStatus(stale);
      expect(status.ok).toBe(false);
      expect(status.behind.length).toBeGreaterThan(0);

      const { assertSchemaVersion } = await import('../src/index.js');
      await expect(assertSchemaVersion(stale)).rejects.toMatchObject({
        code: 'SCHEMA_VERSION_MISMATCH',
      });
    } finally {
      await stale.end();
      const cleanup = createPool(TEST_DATABASE_CONFIG, {
        overrides: { max: 2, searchPath: 'public', password: TEST_PG.password },
      });
      await cleanup.query(`DROP SCHEMA IF EXISTS ${unique} CASCADE`);
      await cleanup.end();
    }
  });

  it('已迁移的库通过版本闸门', async () => {
    const ready = await createTestSchema('ok');
    try {
      const { assertSchemaVersion } = await import('../src/index.js');
      const status = await assertSchemaVersion(ready.pool);
      expect(status.ok).toBe(true);
    } finally {
      await ready.close();
    }
  });
});
