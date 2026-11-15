import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool, migrate, resolveSqlDir, listMigrations, schemaStatus } from '../src/index.js';

import { createTestSchema, TEST_DATABASE_CONFIG, TEST_PG } from './helpers/pg.js';

const MINUTE = 60_000;
/** 存量行的时间戳。`updated_at` 是 NOT NULL，插入时必须给。 */
const NOW_MS = 1_760_000_000_000;

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

  it('2026-11-06 executor_status 表在，列与语义对得上', async () => {
    const result = await ctx.pool.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'executor_status'`,
      [ctx.schema],
    );
    const cols = new Map(result.rows.map((r) => [r.column_name, r]));
    expect(cols.size, 'executor_status 表没建出来').toBeGreaterThan(0);
    // 「进程还活着」这一组：心跳与启动时刻，时间列一律 bigint（R-1.6）。
    for (const column of ['exchange', 'pid', 'started_at', 'last_beat']) {
      expect(cols.has(column), `缺列 ${column}`).toBe(true);
    }
    expect(cols.get('started_at')?.data_type).toBe('bigint');
    expect(cols.get('last_beat')?.data_type).toBe('bigint');
    // 「服务还能不能用」这一组：与心跳**分开**——合成一个「在线」就是骗人。
    expect(cols.has('private_api_ok')).toBe(true);
    expect(cols.has('last_private_ok_at')).toBe(true);
    expect(cols.has('last_error_code')).toBe(true);
    expect(cols.has('last_error_message')).toBe(true);
  });

  it('2026-11-06 通知内容类型扩枚举：旧值一个不少 + 新值在白名单里', async () => {
    const rows = await ctx.pool.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
       WHERE conrelid = 'notify_settings'::regclass`,
    );
    const byName = new Map(rows.rows.map((r) => [r.conname, r.def]));
    const kinds = byName.get('notify_settings_kinds_check') ?? '';
    // 扩枚举，不是换枚举：旧值一个都不能少（少了，历史行当场写不进去）。
    for (const value of [
      'missing-stop-order',
      'unprotected-position',
      'position-without-record',
      'missing-take-profit-order',
      'unexpected-take-profit-order',
      'price-mismatch',
      'record-without-position',
      'orphan-algo-order',
      'trail-move-failed',
      'bracket-armed',
      'bracket-settled',
      'llm-fallback',
      'tp1-filled',
      'trail-moved',
      'agent-plan-executed',
      'agent-plan-failed',
      'agent-prompt',
      'decision-prompt',
      'sync-symbol-error',
      'sync-stopped',
      'executor-unavailable',
      // v1.2.0：链上仓位异动。**扩枚举**：旧值一个都不能少（少了，历史行当场写不进去）。
      'chain-position-alert',
    ]) {
      expect(kinds, `kinds 的取值范围里少了 ${value}`).toContain(`'${value}'::text`);
    }
  });

  it('v1.2.0 链上仓位的三张表在，列与语义对得上', async () => {
    const result = await ctx.pool.query<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE table_schema = $1 AND table_name LIKE 'chain_%'`,
      [ctx.schema],
    );
    const byTable = new Map<string, Map<string, string>>();
    for (const row of result.rows) {
      const cols = byTable.get(row.table_name) ?? new Map<string, string>();
      cols.set(row.column_name, row.data_type);
      byTable.set(row.table_name, cols);
    }
    expect([...byTable.keys()].sort(), '链上仓位的表没建出来').toEqual([
      'chain_position',
      'chain_position_alert',
      'chain_position_snapshot',
    ]);

    const position = byTable.get('chain_position');
    expect(position, 'chain_position 表没建出来').toBeDefined();
    // 链上身份是主键：同一笔仓位在多次启动之间是同一个键。
    expect(position?.has('position_key')).toBe(true);
    // 金额用 numeric：18 位小数的代币数量是 1e18 量级，double precision 装不下。
    expect(position?.get('deposit_amount0')).toBe('numeric');
    expect(position?.get('deposit_amount1')).toBe('numeric');
    // 「上一轮的流动性」与「这一轮」是**两件事**，必须有各自的列。
    expect(position?.has('last_liquidity')).toBe(true);
    // 价格与盈亏给人看，用 double precision（与本仓库其它表一致）。
    expect(position?.get('cost_usdt')).toBe('double precision');
    // 时间一律毫秒 bigint（跨语言契约：不用 timestamptz）。
    expect(position?.get('created_at')).toBe('bigint');
    expect(position?.get('last_poll_at')).toBe('bigint');

    const snapshot = byTable.get('chain_position_snapshot');
    expect(snapshot?.get('liquidity')).toBe('numeric');
    expect(snapshot?.get('amount0')).toBe('numeric');
    expect(snapshot?.get('ts')).toBe('bigint');
    expect(snapshot?.get('price')).toBe('double precision');

    const alert = byTable.get('chain_position_alert');
    // 推送失败也要留记录（sent = false），否则「群里没消息」会变成无头案。
    expect(alert?.has('sent')).toBe(true);
    expect(alert?.has('reasons')).toBe(true);
  });

  it('2026-11-06 通知内容类型的列默认值含新类型（不补勾就等于默认不发）', async () => {
    const result = await ctx.pool.query<{ column_default: string }>(
      `SELECT column_default FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'notify_settings' AND column_name = 'kinds'`,
      [ctx.schema],
    );
    const def = result.rows[0]?.column_default ?? '';
    expect(def).toContain('executor-unavailable');
    // v1.2.0 新增的链上仓位异动：默认开着（不补勾就等于默认不发）。
    expect(def).toContain('chain-position-alert');
    // 旧值一个都不能少（默认值也是「扩」出来的）。
    for (const value of ['missing-stop-order', 'sync-stopped', 'bracket-armed']) {
      expect(def, `默认值里少了 ${value}`).toContain(value);
    }
    // ⚠️ 两种提示词镜像**默认不勾**（带着行情与账户权益，默认发等于自动泄露）。
    expect(def).not.toContain('agent-prompt');
    expect(def).not.toContain('decision-prompt');
  });

  it('2026-11-06 存量行补勾：升级后这一条推送不会一声不吭地不发生', async () => {
    // 照 022 的做法：已配好的那一份要把新类型补上。
    // 这里模拟「升级前就配好了、且没勾这一条」的那一行，再跑一次 025 的 SQL。
    await ctx.pool.query(
      `INSERT INTO notify_settings (id, enabled, iv, auth_tag, ciphertext, key_hint, kinds, updated_at)
       VALUES (1, false, decode('00', 'hex'), decode('00', 'hex'), decode('00', 'hex'), '',
               ARRAY['missing-stop-order']::text[], $1)
       ON CONFLICT (id) DO UPDATE SET kinds = EXCLUDED.kinds`,
      [NOW_MS],
    );
    const migration = listMigrations(resolveSqlDir()).find(
      (m) => m.version === '025_executor_notify',
    );
    expect(migration, '找不到 025_executor_notify 迁移文件').toBeDefined();
    await ctx.pool.query(migration?.sql ?? '');

    const row = await ctx.pool.query<{ kinds: string[] }>(
      'SELECT kinds FROM notify_settings WHERE id = 1',
    );
    const kinds = row.rows[0]?.kinds ?? [];
    expect(kinds, '存量行没有补勾新类型').toContain('executor-unavailable');
    expect(kinds, '补勾时把用户原有的勾选弄丢了').toContain('missing-stop-order');
  });

  it('v1.2.0 存量行补勾：链上仓位异动不会一声不吭地不发生', async () => {
    // 照 025 的做法：已配好的那一份要把新类型补上。
    // 2026-11-11 实测踩过：控制面存的是**一份勾选清单**，新增通知种类时
    // 清单不会自动多出这一项 → 监控判定「该推」、通道按「没勾」静默跳过，
    // 一条也发不出去，而监控那侧只留下 sent = false 的记录。
    await ctx.pool.query(
      `INSERT INTO notify_settings (id, enabled, iv, auth_tag, ciphertext, key_hint, kinds, updated_at)
       VALUES (1, false, decode('00', 'hex'), decode('00', 'hex'), decode('00', 'hex'), '',
               ARRAY['missing-stop-order']::text[], $1)
       ON CONFLICT (id) DO UPDATE SET kinds = EXCLUDED.kinds`,
      [NOW_MS],
    );
    const migration = listMigrations(resolveSqlDir()).find((m) => m.version === '027_chain_notify');
    expect(migration, '找不到 027_chain_notify 迁移文件').toBeDefined();
    await ctx.pool.query(migration?.sql ?? '');

    const row = await ctx.pool.query<{ kinds: string[] }>(
      'SELECT kinds FROM notify_settings WHERE id = 1',
    );
    const kinds = row.rows[0]?.kinds ?? [];
    expect(kinds, '存量行没有补勾链上仓位异动').toContain('chain-position-alert');
    expect(kinds, '补勾时把用户原有的勾选弄丢了').toContain('missing-stop-order');
    // ⚠️ 两种提示词镜像默认不勾，补勾时也**不许**顺手带上。
    expect(kinds, '不该顺手补上提示词镜像').not.toContain('agent-prompt');
    expect(kinds, '不该顺手补上提示词镜像').not.toContain('decision-prompt');
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

  it('决策来源覆盖 llm-trend，且没把别的守门人顺带删掉（v1.1.0 / AGENTS.md §5 第 12 条）', async () => {
    const rows = await ctx.pool.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
       WHERE conrelid = 'risk_bracket'::regclass`,
    );
    const byName = new Map(rows.rows.map((r) => [r.conname, r.def]));
    // 扩枚举，不是换枚举：旧值一个都不能少（少了，历史行当场写不进去）。
    const source = byName.get('risk_bracket_decision_source_check') ?? '';
    for (const value of ['llm', 'llm-trend', 'config', 'config-fallback', 'agent-plan']) {
      expect(source, `decision_source 的取值范围里少了 ${value}`).toContain(`'${value}'::text`);
    }
    // 「模型给的档位不能残缺」这条要同时管住**两种**模型来源。
    const llmParams = byName.get('risk_bracket_decision_llm_params_check') ?? '';
    expect(llmParams).toContain(`'llm'::text`);
    expect(llmParams).toContain(`'llm-trend'::text`);
    // ⚠️ 这两条是**不同语义**的守门人（Agent 方案 / 降级各管各的）。
    // 少了任何一条，症状都是「悄无声息」——所以在这里点名核对。
    for (const name of [
      'risk_bracket_decision_agent_params_check',
      'risk_bracket_decision_fallback_check',
    ]) {
      expect(byName.has(name), `守门人 ${name} 不在了`).toBe(true);
    }
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

describe('并发迁移（部署实测踩到）', () => {
  it('两个入口同时跑迁移不会撞 duplicate key', async () => {
    // 生产现场：docker compose up -d 让 web / sync / executor 三个容器同时启动，
    // 三个容器各自在入口里跑一遍迁移。没有锁时必然有一个撞
    // `duplicate key value violates unique constraint "pg_type_typname_nsp_index"`。
    const schema = `tt_conc_${Date.now().toString(36)}`;
    const admin = createPool(TEST_DATABASE_CONFIG, {
      overrides: { max: 2, searchPath: 'public', password: TEST_PG.password },
    });
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();

    const poolA = createPool(TEST_DATABASE_CONFIG, {
      overrides: { max: 2, searchPath: schema, password: TEST_PG.password },
    });
    const poolB = createPool(TEST_DATABASE_CONFIG, {
      overrides: { max: 2, searchPath: schema, password: TEST_PG.password },
    });
    try {
      const [a, b] = await Promise.all([migrate(poolA), migrate(poolB)]);

      // 每个版本恰好被应用一次：两个进程不能都以为是自己建的那张表。
      const known = listMigrations(resolveSqlDir()).map((m) => m.version);
      expect(a.applied.length + b.applied.length).toBe(known.length);
      expect(new Set([...a.applied, ...b.applied]).size).toBe(known.length);

      const recorded = await poolA.query<{ version: string }>(
        'SELECT version FROM schema_migrations',
      );
      expect(recorded.rows.length).toBe(known.length);

      const status = await schemaStatus(poolA);
      expect(status.ok).toBe(true);
    } finally {
      await poolA.end();
      await poolB.end();
      const cleanup = createPool(TEST_DATABASE_CONFIG, {
        overrides: { max: 2, searchPath: 'public', password: TEST_PG.password },
      });
      await cleanup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await cleanup.end();
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
