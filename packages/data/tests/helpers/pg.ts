import { randomUUID } from 'node:crypto';

import { createPool, migrate, type Pool } from '../../src/index.js';

/**
 * 测试用 PostgreSQL（R-16.2）。
 *
 * 约束：测试**不得连生产库**。做法是每次测试跑在一个随机命名的独立 schema 里，
 * 迁移从空 schema 一路跑起，结束时整段 `DROP SCHEMA ... CASCADE`。
 * 这样即使连的是同一台 PG，也不可能碰到业务表。
 *
 * 环境变量（默认值对应本地开发容器）：
 *   TRADE_TOOL_TEST_PG_HOST / _PORT / _DATABASE / _USER / _PASSWORD
 */

export const TEST_PG = {
  host: process.env['TRADE_TOOL_TEST_PG_HOST'] ?? '127.0.0.1',
  port: Number(process.env['TRADE_TOOL_TEST_PG_PORT'] ?? 5432),
  database: process.env['TRADE_TOOL_TEST_PG_DATABASE'] ?? 'trade_tool',
  user: process.env['TRADE_TOOL_TEST_PG_USER'] ?? 'trade',
  password: process.env['TRADE_TOOL_TEST_PG_PASSWORD'] ?? 'trade',
};

export const TEST_DATABASE_CONFIG = {
  host: TEST_PG.host,
  port: TEST_PG.port,
  database: TEST_PG.database,
  user: TEST_PG.user,
  passwordEnv: 'TRADE_TOOL_TEST_PG_PASSWORD',
  poolMax: 5,
  connectionTimeoutMs: 5_000,
  ssl: false,
};

export interface TestSchema {
  schema: string;
  pool: Pool;
  /** 结束测试并清理 */
  close(): Promise<void>;
}

/** 进程退出前必须打印这句，否则 CI 会在用例跑完前就断开。 */
export async function createTestSchema(label = 't'): Promise<TestSchema> {
  const schema = `tt_${label}_${randomUUID().slice(0, 8)}`;
  // 先用一条干净连接建 schema 并**从空库执行迁移**（R-16.2 / AC-1 / AC-26）。
  const admin = createPool(TEST_DATABASE_CONFIG, {
    overrides: { max: 2, searchPath: 'public', password: TEST_PG.password },
  });
  try {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await admin.end();
  }

  const pool = createPool(TEST_DATABASE_CONFIG, {
    overrides: { max: 5, searchPath: schema, password: TEST_PG.password },
  });
  await migrate(pool);

  return {
    schema,
    pool,
    close: async () => {
      await pool.end().catch(() => undefined);
      const cleanup = createPool(TEST_DATABASE_CONFIG, {
        overrides: { max: 2, searchPath: 'public', password: TEST_PG.password },
      });
      try {
        await cleanup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await cleanup.end().catch(() => undefined);
      }
    },
  };
}

/** 固定时钟：让「丢弃最后一根」「closeTime <= now」类断言不依赖真实时间。 */
export const FIXED_NOW_MS = 1_760_000_000_000;

export function closedBarOpen(timeMs: number): number {
  return Math.floor(timeMs / 60_000) * 60_000;
}

/**
 * 直接写入测试数据，绕开 Python 引擎——用于构造「人为删行造成缺口」「重放同一区间」等场景。
 * 用 DO NOTHING，因为重放同一批数据本身就是被测行为之一（幂等，R-12）。
 */
export async function insertBars(
  pool: Pool,
  symbol: string,
  times: readonly number[],
  overrides: Partial<{ close: number; quoteVolume: number | null; trades: number | null }> = {},
): Promise<void> {
  for (const time of times) {
    await pool.query(
      `INSERT INTO klines_1m (symbol, time, open, high, low, close, volume, quote_volume, trades)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (symbol, time) DO NOTHING`,
      [
        symbol,
        time,
        1.5,
        2.5,
        0.5,
        overrides.close ?? 2.0,
        10.5,
        'quoteVolume' in overrides ? overrides.quoteVolume : null,
        'trades' in overrides ? overrides.trades : null,
      ],
    );
  }
}

/** 连续 N 根 1m bar 的开盘时间序列，以 endOpen 为最后一根。 */
export function barTimes(endOpen: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => endOpen - (count - 1 - i) * 60_000);
}
