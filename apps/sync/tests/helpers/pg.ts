import { randomUUID } from 'node:crypto';

import { migrate, createPool, type Pool } from '@trade-tool/data';

/**
 * apps/sync 的测试用 PG。与 packages/data 的 helper 同构：
 * 每次测试跑在独立 schema 上，结束时整段 DROP，**不得碰任何业务库**。
 */

const PG = {
  host: process.env['TRADE_TOOL_TEST_PG_HOST'] ?? '127.0.0.1',
  port: Number(process.env['TRADE_TOOL_TEST_PG_PORT'] ?? 5432),
  database: process.env['TRADE_TOOL_TEST_PG_DATABASE'] ?? 'trade_tool',
  user: process.env['TRADE_TOOL_TEST_PG_USER'] ?? 'trade',
  password: process.env['TRADE_TOOL_TEST_PG_PASSWORD'] ?? 'trade',
};

export const TEST_PG = PG;

export const TEST_DATABASE_CONFIG = {
  host: PG.host,
  port: PG.port,
  database: PG.database,
  user: PG.user,
  passwordEnv: 'TRADE_TOOL_TEST_PG_PASSWORD',
  poolMax: 5,
  connectionTimeoutMs: 5_000,
  ssl: false,
};

export interface TestSchema {
  schema: string;
  pool: Pool;
  close(): Promise<void>;
}

export async function createTestSchema(label = 'sync'): Promise<TestSchema> {
  const schema = `tt_${label}_${randomUUID().slice(0, 8)}`;
  const admin = createPool(TEST_DATABASE_CONFIG, {
    overrides: { max: 2, searchPath: 'public', password: PG.password },
  });
  try {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await admin.end();
  }

  const pool = createPool(TEST_DATABASE_CONFIG, {
    overrides: { max: 5, searchPath: schema, password: PG.password },
  });
  await migrate(pool);
  return {
    schema,
    pool,
    close: async () => {
      await pool.end().catch(() => undefined);
      const cleanup = createPool(TEST_DATABASE_CONFIG, {
        overrides: { max: 2, searchPath: 'public', password: PG.password },
      });
      try {
        await cleanup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await cleanup.end().catch(() => undefined);
      }
    },
  };
}
