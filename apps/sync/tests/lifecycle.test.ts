import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  SyncError,
  defaultConfig,
  type SyncRunSummary,
  type TradeToolConfig,
} from '@trade-tool/core';
import {
  buildContext,
  createPool,
  ensureSyncState,
  setDesiredState,
  upsertSymbolEntry,
} from '@trade-tool/data';

import { SyncDaemon } from '../src/daemon.js';
import { SyncControl } from '../src/primitives.js';
import { createSyncService } from '../src/service.js';

import { createTestSchema, TEST_DATABASE_CONFIG, TEST_PG, type TestSchema } from './helpers/pg.js';

const SYMBOLS = ['TESTAAAUSDC', 'TESTBBBUSDC', 'TESTCCCUSDC'] as const;
const NOW = 1_760_000_000_000;

function configWith(overrides: Partial<TradeToolConfig['sync']> = {}): TradeToolConfig {
  const base = defaultConfig();
  return { ...base, sync: { ...base.sync, ...overrides } };
}

function okSummary(symbol: string): SyncRunSummary {
  return {
    symbol,
    added: 0,
    from: null,
    to: null,
    writeStrategy: 'upsert',
    watermark: null,
    gapsFilled: 0,
    gapsPending: 0,
    gapsAbandoned: 0,
    requests: 1,
    weight: 1,
    metadataStale: false,
    // v0.2.0：未启用派生时是 null（与「启用了但没写桶」区分，AC-22）
    aggregated: null,
  };
}

/** 绕开元数据校验直接造集合条目：这些用例只测生命周期，不测网络。 */
async function seedSymbol(pool: TestSchema['pool'], symbol: string): Promise<void> {
  await upsertSymbolEntry(pool, { exchange: 'binance', symbol });
  await ensureSyncState(pool, 'binance', symbol, 'paused');
}

describe('控制原语：生命周期幂等（R-17 / AC-22）', () => {
  let ctx: TestSchema;
  let control: SyncControl;

  beforeAll(async () => {
    ctx = await createTestSchema('prim');
  });
  afterAll(async () => {
    await ctx.close();
  });

  function makeControl(config = configWith()): SyncControl {
    const marketCtx = buildContext(ctx.pool, config, {
      overrides: { password: TEST_PG.password, searchPath: ctx.schema },
    });
    return new SyncControl(marketCtx, { config, syncFn: async (s) => okSummary(s) });
  }

  it('AC-22 重复 pause 不报错、无副作用', async () => {
    await seedSymbol(ctx.pool, 'IDEMPAUSE');
    control = makeControl();
    await setDesiredState(ctx.pool, 'binance', 'IDEMPAUSE', 'running');
    await control.start('IDEMPAUSE');

    const first = await control.pause('IDEMPAUSE');
    const second = await control.pause('IDEMPAUSE');
    expect(first.status).toBe('paused');
    expect(second.status).toBe('paused');
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);

    // 再 pause 一次不应改变 desired_state 的更新时间戳（真的无副作用）
    const before = (await control.listSymbols()).find((e) => e.symbol === 'IDEMPAUSE')?.updatedAt;
    await control.pause('IDEMPAUSE');
    const after = (await control.listSymbols()).find((e) => e.symbol === 'IDEMPAUSE')?.updatedAt;
    expect(after).toBe(before);
  });

  it('AC-22 重复 start / resume 幂等', async () => {
    await seedSymbol(ctx.pool, 'IDEMSTART');
    control = makeControl();
    const a = await control.start('IDEMSTART');
    const b = await control.start('IDEMSTART');
    expect(a.status).toBe('running');
    expect(b.status).toBe('running');
    const c = await control.resume('IDEMSTART');
    const d = await control.resume('IDEMSTART');
    expect(c.status).toBe('running');
    expect(d.status).toBe('running');
  });

  it('R-17.3 状态先落库再生效：直接读库已能看到新状态', async () => {
    await seedSymbol(ctx.pool, 'PERSIST');
    control = makeControl();
    await control.start('PERSIST');
    const row = await ctx.pool.query<{ status: string; desired_state: string }>(
      `SELECT st.status, sym.desired_state FROM sync_state st
       JOIN symbols sym ON sym.exchange = st.exchange AND sym.symbol = st.symbol
       WHERE st.symbol = 'PERSIST'`,
    );
    expect(row.rows[0]?.status).toBe('running');
    expect(row.rows[0]?.desired_state).toBe('running');
  });

  it('R-17.5 暂停不删除任何数据', async () => {
    await seedSymbol(ctx.pool, 'NODEL');
    await ctx.pool.query(
      `INSERT INTO klines_1m (symbol, time, open, high, low, close, volume)
       VALUES ('NODEL', $1, 1, 1, 1, 1, 1), ('NODEL', $2, 1, 1, 1, 1, 1)`,
      [NOW, NOW + 60_000],
    );
    control = makeControl();
    await control.start('NODEL');
    await control.pause('NODEL');
    const count = await ctx.pool.query<{ n: string }>(
      `SELECT count(*)::bigint AS n FROM klines_1m WHERE symbol = 'NODEL'`,
    );
    expect(Number(count.rows[0]?.n)).toBe(2);
  });

  it('R-21.3 resume 清空退避与错误计数', async () => {
    await seedSymbol(ctx.pool, 'RESUMECLR');
    control = makeControl();
    let calls = 0;
    const failing = new SyncControl(
      buildContext(ctx.pool, configWith(), {
        overrides: { password: TEST_PG.password, searchPath: ctx.schema },
      }),
      {
        config: configWith(),
        syncFn: async () => {
          calls += 1;
          throw new SyncError('EXCHANGE_ERROR', 'boom');
        },
      },
    );
    await failing.runOnce('RESUMECLR', NOW);
    expect(failing.slotsSnapshot()['RESUMECLR']?.consecutiveErrors).toBe(1);

    await failing.resume('RESUMECLR');
    const slot = failing.slotsSnapshot()['RESUMECLR'];
    expect(slot?.backoffUntil).toBeNull();
    expect(slot?.consecutiveErrors).toBe(0);
  });

  it('R-22.4 未加入集合的标的报结构化错误，不是字符串', async () => {
    control = makeControl();
    await expect(control.getStatus('GHOST')).rejects.toMatchObject({ code: 'SYMBOL_NOT_FOUND' });
  });
});

describe('错误隔离与退避（R-21 / AC-18）', () => {
  let ctx: TestSchema;

  beforeAll(async () => {
    ctx = await createTestSchema('err');
  });
  afterAll(async () => {
    await ctx.close();
  });

  function makeControl(
    syncFn: (symbol: string) => Promise<SyncRunSummary>,
    sync: Partial<TradeToolConfig['sync']> = {},
  ): SyncControl {
    const config = configWith(sync);
    return new SyncControl(
      buildContext(ctx.pool, config, {
        overrides: { password: TEST_PG.password, searchPath: ctx.schema },
      }),
      { config, syncFn },
    );
  }

  it('R-21.1 单标的失败被隔离：runOnce 不抛，其它标的照常', async () => {
    const control = makeControl(async (symbol) => {
      if (symbol === 'TESTBBBUSDC') throw new SyncError('EXCHANGE_ERROR', 'only B fails');
      return okSummary(symbol);
    });
    for (const symbol of SYMBOLS) await seedSymbol(ctx.pool, symbol);

    const bError = await control.runOnce('TESTBBBUSDC', NOW);
    expect(bError?.code).toBe('EXCHANGE_ERROR');

    const aError = await control.runOnce('TESTAAAUSDC', NOW);
    expect(aError).toBeNull();
    const row = await ctx.pool.query<{ status: string; last_error: string | null }>(
      `SELECT status, last_error FROM sync_state WHERE symbol = 'TESTAAAUSDC'`,
    );
    expect(row.rows[0]?.status).toBe('running');
  });

  it('R-21.2 指数退避：连续失败次数越多，退避越久', () => {
    const control = makeControl(async () => okSummary('X'));
    expect(control.backoffDelay(1)).toBe(5_000);
    expect(control.backoffDelay(2)).toBe(10_000);
    expect(control.backoffDelay(3)).toBe(20_000);
    // 上限封顶，不能无限增长
    expect(control.backoffDelay(20)).toBe(300_000);
  });

  it('R-21.2 退避期间该标的不参与调度', async () => {
    const control = makeControl(async () => {
      throw new SyncError('EXCHANGE_ERROR', 'flaky');
    });
    await seedSymbol(ctx.pool, 'TESTAAAUSDC');
    await control.runOnce('TESTAAAUSDC', NOW);
    expect(control.isSchedulable('TESTAAAUSDC', NOW)).toBe(false);
    // 退避到期后恢复可调度
    expect(control.isSchedulable('TESTAAAUSDC', NOW + 5_001)).toBe(true);
  });

  it('R-21.3 连续失败达阈值进入 error 并停止自动重试', async () => {
    const config = configWith({ maxConsecutiveErrors: 3 });
    const control = new SyncControl(
      buildContext(ctx.pool, config, {
        overrides: { password: TEST_PG.password, searchPath: ctx.schema },
      }),
      {
        config,
        syncFn: async () => {
          throw new SyncError('EXCHANGE_ERROR', 'always fails');
        },
      },
    );
    const daemon = new SyncDaemon(
      buildContext(ctx.pool, config, {
        overrides: { password: TEST_PG.password, searchPath: ctx.schema },
      }),
      { config, now: () => NOW, sleep: async () => undefined },
    );
    await seedSymbol(ctx.pool, 'TESTCCCUSDC');
    await setDesiredState(ctx.pool, 'binance', 'TESTCCCUSDC', 'running');
    await control.start('TESTCCCUSDC');

    for (let i = 0; i < 3; i += 1) {
      // 每次推进时钟，绕开退避
      await control.runOnce('TESTCCCUSDC', NOW + i * 400_000);
    }
    const row = await ctx.pool.query<{ status: string; error_count: number }>(
      `SELECT status, error_count FROM sync_state WHERE symbol = 'TESTCCCUSDC'`,
    );
    expect(row.rows[0]?.status).toBe('error');
    expect(row.rows[0]?.error_count).toBe(3);

    // 「停止自动重试」的可观测判据：调度器不再选中该标的，必须显式 resume（R-21.3）
    expect((await daemon.selectBatch(NOW + 10_000_000)).map((e) => e.symbol)).not.toContain(
      'TESTCCCUSDC',
    );
  });

  it('R-21.5 需人工介入的错误立即进 error，不做退避重试', async () => {
    const control = makeControl(async () => {
      throw new SyncError('UNCLOSED_BAR_IN_STORE', 'last bar is not closed at 1760000000000');
    });
    await seedSymbol(ctx.pool, 'TESTBBBUSDC');
    const error = await control.runOnce('TESTBBBUSDC', NOW);
    expect(error?.code).toBe('UNCLOSED_BAR_IN_STORE');
    const row = await ctx.pool.query<{ status: string; last_error: string }>(
      `SELECT status, last_error FROM sync_state WHERE symbol = 'TESTBBBUSDC'`,
    );
    expect(row.rows[0]?.status).toBe('error');
    // lastError 必须带位置信息，便于人工介入（R-21.5）
    expect(row.rows[0]?.last_error).toContain('1760000000000');
    expect(control.slotsSnapshot()['TESTBBBUSDC']?.backoffUntil).toBeNull();
  });

  it('R-21.6 PG 连接失败走退避重试而不进 error', async () => {
    const control = makeControl(async () => {
      throw new SyncError('DB_CONNECTION_FAILED', 'server closed the connection unexpectedly');
    });
    await seedSymbol(ctx.pool, 'TESTAAAUSDC');
    const error = await control.runOnce('TESTAAAUSDC', NOW);
    expect(error?.code).toBe('DB_CONNECTION_FAILED');
    const slot = control.slotsSnapshot()['TESTAAAUSDC'];
    expect(slot?.backoffUntil).toBe(NOW + 5_000);
    const row = await ctx.pool.query<{ status: string }>(
      `SELECT status FROM sync_state WHERE symbol = 'TESTAAAUSDC'`,
    );
    expect(row.rows[0]?.status).not.toBe('error');
  });

  it('R-3.3 / AC-19 同一标的并发发起两次同步被串行化', async () => {
    let active = 0;
    let maxConcurrent = 0;
    const control = makeControl(async () => {
      active += 1;
      maxConcurrent = Math.max(maxConcurrent, active);
      await new Promise((r) => setTimeout(r, 50));
      active -= 1;
      return okSummary('TESTAAAUSDC');
    });
    await seedSymbol(ctx.pool, 'TESTAAAUSDC');

    const [first, second] = await Promise.all([
      control.runOnce('TESTAAAUSDC', NOW),
      control.runOnce('TESTAAAUSDC', NOW),
    ]);
    expect(first).toBeNull();
    expect(second).toBeNull();
    // 第二次直接被拒绝而不是并行写
    expect(maxConcurrent).toBe(1);
  });
});

describe('调度器（R-20.5 / R-20.6 / AC-23 / AC-24 / AC-24）', () => {
  let ctx: TestSchema;

  beforeAll(async () => {
    ctx = await createTestSchema('sched');
  });
  afterAll(async () => {
    await ctx.close();
  });

  function makeCtx(config: TradeToolConfig) {
    return buildContext(ctx.pool, config, {
      overrides: { password: TEST_PG.password, searchPath: ctx.schema },
    });
  }

  it('AC-23 运行中新增标的：无需重启即被调度', async () => {
    const config = configWith({ concurrency: 2 });
    const control = new SyncControl(makeCtx(config), {
      config,
      syncFn: async (s) => okSummary(s),
    });
    const daemon = new SyncDaemon(makeCtx(config), {
      config,
      now: () => NOW,
      sleep: async () => undefined,
    });

    await seedSymbol(ctx.pool, 'TESTAAAUSDC');
    await control.start('TESTAAAUSDC');

    // 运行时新增第二个标的
    await seedSymbol(ctx.pool, 'TESTBBBUSDC');
    await control.start('TESTBBBUSDC');

    const batch = await daemon.selectBatch(NOW);
    expect(batch.map((e) => e.symbol).sort()).toEqual(['TESTAAAUSDC', 'TESTBBBUSDC']);
  });

  it('AC-23 removeSymbol 后立即停止调度', async () => {
    const config = configWith({ concurrency: 4 });
    const control = new SyncControl(makeCtx(config), { config, syncFn: async (s) => okSummary(s) });
    const daemon = new SyncDaemon(makeCtx(config), {
      config,
      now: () => NOW,
      sleep: async () => undefined,
    });
    await seedSymbol(ctx.pool, 'TESTCCCUSDC');
    await control.start('TESTCCCUSDC');
    expect((await daemon.selectBatch(NOW)).map((e) => e.symbol)).toContain('TESTCCCUSDC');

    await control.removeSymbol('TESTCCCUSDC', 'keep');
    expect((await daemon.selectBatch(NOW)).map((e) => e.symbol)).not.toContain('TESTCCCUSDC');
  });

  it('AC-24 并发上限生效，不会一次性放开全部标的', async () => {
    const config = configWith({ concurrency: 2 });
    const daemon = new SyncDaemon(makeCtx(config), {
      config,
      now: () => NOW,
      sleep: async () => undefined,
    });
    for (const symbol of SYMBOLS) {
      await seedSymbol(ctx.pool, symbol);
      await setDesiredState(ctx.pool, 'binance', symbol, 'running');
    }
    const batch = await daemon.selectBatch(NOW);
    expect(batch.length).toBeLessThanOrEqual(2);
  });

  it('paused / error 的标的不参与调度', async () => {
    const config = configWith({ concurrency: 4 });
    const daemon = new SyncDaemon(makeCtx(config), {
      config,
      now: () => NOW,
      sleep: async () => undefined,
    });
    for (const symbol of SYMBOLS) {
      await seedSymbol(ctx.pool, symbol);
      await setDesiredState(ctx.pool, 'binance', symbol, 'running');
      await ctx.pool.query(`UPDATE sync_state SET status = 'error' WHERE symbol = $1`, [symbol]);
    }
    expect(await daemon.selectBatch(NOW)).toEqual([]);
  });
});

describe('重启后状态仍准确（R-19.4 / AC-20）', () => {
  let ctx: TestSchema;

  beforeAll(async () => {
    ctx = await createTestSchema('restart');
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('AC-20 状态在库里，重启后 running/paused 分布与水位不变', async () => {
    const config = configWith();
    const first = new SyncControl(
      buildContext(ctx.pool, config, {
        overrides: { password: TEST_PG.password, searchPath: ctx.schema },
      }),
      { config, syncFn: async (s) => okSummary(s) },
    );

    for (const symbol of ['TESTAAAUSDC', 'TESTBBBUSDC'] as const) {
      await seedSymbol(ctx.pool, symbol);
      await first.start(symbol);
    }
    await first.pause('TESTBBBUSDC');
    await ctx.pool.query(
      `UPDATE sync_state SET watermark = $2, verified_upto = $2 WHERE symbol = $1`,
      ['TESTAAAUSDC', NOW],
    );
    const before = await first.allStates();
    const beforeWatermark = before.find((s) => s.symbol === 'TESTAAAUSDC')?.watermark;

    // 「重启」：全新的 control / daemon 对象，状态全部从库里读
    const restarted = new SyncControl(
      buildContext(ctx.pool, config, {
        overrides: { password: TEST_PG.password, searchPath: ctx.schema },
      }),
      { config, syncFn: async (s) => okSummary(s) },
    );
    const after = await restarted.allStates();
    expect(after.find((s) => s.symbol === 'TESTAAAUSDC')?.status).toBe('running');
    expect(after.find((s) => s.symbol === 'TESTBBBUSDC')?.status).toBe('paused');
    expect(after.find((s) => s.symbol === 'TESTAAAUSDC')?.watermark).toBe(beforeWatermark);

    const summary = await restarted.getSummary();
    expect(summary.countsByStatus.running).toBe(1);
    expect(summary.countsByStatus.paused).toBe(1);
  });
});

describe('缺陷回归（本轮审计发现并修复）', () => {
  let ctx: TestSchema;

  beforeAll(async () => {
    ctx = await createTestSchema('regress');
  });
  afterAll(async () => {
    await ctx.close();
  });

  function make(
    config = configWith(),
    syncFn?: (s: string) => Promise<SyncRunSummary>,
  ): SyncControl {
    return new SyncControl(
      buildContext(ctx.pool, config, {
        overrides: { password: TEST_PG.password, searchPath: ctx.schema },
      }),
      { config, syncFn: syncFn ?? (async (s) => okSummary(s)) },
    );
  }

  it('start 未入集合的标的报错，不造孤儿 sync_state 行（R-18.4 / R-19.8）', async () => {
    const control = make();
    await expect(control.start('TESTGHOSTUSDC')).rejects.toMatchObject({
      code: 'SYMBOL_NOT_FOUND',
    });
    // 关键：不能凭空留下一行 running 的状态去污染汇总
    const row = await ctx.pool.query<{ n: string }>(
      `SELECT count(*)::bigint AS n FROM sync_state WHERE symbol = 'TESTGHOSTUSDC'`,
    );
    expect(Number(row.rows[0]?.n)).toBe(0);
  });

  it('回补进行中被 pause：本轮收尾写回 paused，不复活成 running（AC-16 / R-17.3）', async () => {
    const control = make();
    await seedSymbol(ctx.pool, 'TESTPAUSEUSDC');
    await control.start('TESTPAUSEUSDC');

    // 同步函数执行期间模拟运维 pause
    const pausing = make(configWith(), async (symbol) => {
      await control.pause(symbol);
      return okSummary(symbol);
    });
    await pausing.runOnce('TESTPAUSEUSDC', NOW);

    const row = await ctx.pool.query<{ status: string }>(
      `SELECT status FROM sync_state WHERE symbol = 'TESTPAUSEUSDC'`,
    );
    expect(row.rows[0]?.status).toBe('paused');
    const entry = (await control.listSymbols()).find((e) => e.symbol === 'TESTPAUSEUSDC');
    expect(entry?.desiredState).toBe('paused');
  });

  it('重启后从库里恢复退避与连续失败计数（R-19.4 / R-21.2）', async () => {
    const config = configWith({ backoffBaseMs: 5_000 });
    const first = make(config, async () => {
      throw new SyncError('EXCHANGE_ERROR', 'down');
    });
    await seedSymbol(ctx.pool, 'TESTBACKOFFUSDC');
    await first.start('TESTBACKOFFUSDC');
    await first.runOnce('TESTBACKOFFUSDC', NOW);

    // 重启：新对象，运行时槽位是空的，必须靠 reconcile 从库里把退避灌回来
    const daemon = new SyncDaemon(
      buildContext(ctx.pool, config, {
        overrides: { password: TEST_PG.password, searchPath: ctx.schema },
      }),
      { config, now: () => NOW, sleep: async () => undefined },
    );
    await daemon.reconcile();
    expect(daemon.primitives.isSchedulable('TESTBACKOFFUSDC', NOW)).toBe(false);
    expect(daemon.primitives.isSchedulable('TESTBACKOFFUSDC', NOW + 10_000)).toBe(true);
  });

  it('PG 可恢复错误达到阈值也进 error，不无限重试（R-21.6 / R-21.3）', async () => {
    const config = configWith({ maxConsecutiveErrors: 2 });
    const control = make(config, async () => {
      throw new SyncError('DB_DEADLOCK', 'deadlock');
    });
    await seedSymbol(ctx.pool, 'TESTDEADLOCKUSDC');
    await control.start('TESTDEADLOCKUSDC');

    let last = await control.runOnce('TESTDEADLOCKUSDC', NOW);
    expect(last?.code).toBe('DB_DEADLOCK');
    // 第一次仍是退避重试
    let row = await ctx.pool.query<{ status: string }>(
      `SELECT status FROM sync_state WHERE symbol = 'TESTDEADLOCKUSDC'`,
    );
    expect(row.rows[0]?.status).toBe('running');

    await control.runOnce('TESTDEADLOCKUSDC', NOW + 60_000);
    row = await ctx.pool.query<{ status: string }>(
      `SELECT status FROM sync_state WHERE symbol = 'TESTDEADLOCKUSDC'`,
    );
    expect(row.rows[0]?.status).toBe('error');
    // 进 error 后停止自动重试：调度器按库里的 status 过滤，即使退避已过期也不再捞它
    const daemon = new SyncDaemon(
      buildContext(ctx.pool, config, {
        overrides: { password: TEST_PG.password, searchPath: ctx.schema },
      }),
      { config, now: () => NOW + 600_000, sleep: async () => undefined },
    );
    const batch = await daemon.selectBatch(NOW + 600_000);
    expect(batch.map((e) => e.symbol)).not.toContain('TESTDEADLOCKUSDC');
  });

  it('重复 addSymbol 真正无副作用：updated_at 不变（R-18.5）', async () => {
    const before = await ctx.pool.query<{ updated_at: string }>(
      `SELECT updated_at FROM symbols WHERE symbol = 'TESTIDEMUSDC'`,
    );
    const entry = await upsertSymbolEntry(ctx.pool, {
      exchange: 'binance',
      symbol: 'TESTIDEMUSDC',
    });
    const firstAt = entry.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    await upsertSymbolEntry(ctx.pool, { exchange: 'binance', symbol: 'TESTIDEMUSDC' });
    const after = await ctx.pool.query<{ updated_at: string }>(
      `SELECT updated_at FROM symbols WHERE symbol = 'TESTIDEMUSDC'`,
    );
    expect(Number(after.rows[0]?.updated_at)).toBe(Number(firstAt));
    expect(before.rows).toBeDefined();
  });
});

describe('第二轮缺陷回归（R-1.3 / R-3.3 / R-14.4 / R-20.5 / R-21.5 / R-22）', () => {
  let ctx: TestSchema;

  beforeAll(async () => {
    ctx = await createTestSchema('regress2');
  });
  afterAll(async () => {
    await ctx.close();
  });

  function makeCtx(config: TradeToolConfig, pool = ctx.pool) {
    return buildContext(pool, config, {
      overrides: { password: TEST_PG.password, searchPath: ctx.schema },
    });
  }

  function make(
    config = configWith(),
    syncFn?: (s: string) => Promise<SyncRunSummary>,
    pool = ctx.pool,
  ): SyncControl {
    return new SyncControl(makeCtx(config, pool), {
      config,
      syncFn: syncFn ?? (async (s) => okSummary(s)),
    });
  }

  /**
   * runOnce 开头的 `stillWanted()` 也要查库。若它在 try 之外抛出：
   *   ① `finally` 不执行 → inflight 永久为 true，该标的再不被调度、还占着并发名额；
   *   ② 异常逃出 runOnce → daemon 的 worker → tick → loop → unhandled rejection，
   *      单标的的一次 PG 抖动直接杀掉整个守护进程（R-14.4 / R-21.1）。
   */
  it('R-14.4 / R-21.1 状态读取失败既不泄漏 inflight 也不抛出 runOnce', async () => {
    let failNextQuery = true;
    const flaky = new Proxy(ctx.pool, {
      get(target, prop, receiver) {
        if (prop === 'query') {
          return async (...args: unknown[]) => {
            if (failNextQuery) {
              failNextQuery = false;
              throw new SyncError('DB_CONNECTION_FAILED', 'injected');
            }
            return (target.query as unknown as (...a: unknown[]) => unknown)(...args);
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as typeof ctx.pool;

    const config = configWith();
    const control = make(config, undefined, flaky);
    await seedSymbol(ctx.pool, 'TESTFLAKYUSDC');

    const error = await control.runOnce('TESTFLAKYUSDC', NOW);
    expect(error?.code).toBe('DB_CONNECTION_FAILED');
    // 槽位必须释放；退避是刻意的（可恢复错误），但退避结束后必须能再调度
    expect(control.slotsSnapshot()['TESTFLAKYUSDC']?.inflight).toBe(false);
    expect(control.isSchedulable('TESTFLAKYUSDC', NOW)).toBe(false);
    expect(control.isSchedulable('TESTFLAKYUSDC', NOW + 60_000)).toBe(true);
  });

  /** listSymbols 按 symbol 升序，固定 slice 会让 concurrency 之外的标的永远轮不到（G-9 / R-20.5）。 */
  it('R-20.5 公平轮转：并发上限之外的标的不被永久饿死', async () => {
    const config = configWith({ concurrency: 2 });
    const control = make(config);
    const daemon = new SyncDaemon(makeCtx(config), {
      config,
      control,
      now: () => NOW,
      sleep: async () => undefined,
    });
    const symbols = ['TESTFAIR1USDC', 'TESTFAIR2USDC', 'TESTFAIR3USDC'];
    for (const symbol of symbols) {
      await seedSymbol(ctx.pool, symbol);
      await setDesiredState(ctx.pool, 'binance', symbol, 'running');
    }

    const seen = new Set<string>();
    for (let round = 0; round < 4; round += 1) {
      const batch = await daemon.selectBatch(NOW + round);
      expect(batch.length).toBeLessThanOrEqual(2);
      for (const entry of batch) {
        seen.add(entry.symbol);
        // 模拟「这一轮跑过了」：`runOnce` 会写 last_run_at，调度据此轮转
        await ctx.pool.query('UPDATE sync_state SET last_run_at = $2 WHERE symbol = $1', [
          entry.symbol,
          NOW + round,
        ]);
      }
    }
    expect([...seen].sort()).toEqual([...symbols].sort());
  });

  /** delete 策略只把 status 改成 paused，数据派生的缓存列会残留（R-18.3 / R-19.6 / AC-21）。 */
  it('R-18.3 / AC-21 removeSymbol(delete) 清空数据派生的缓存列，重新加入不会永久 error', async () => {
    await seedSymbol(ctx.pool, 'TESTDELUSDC');
    await ctx.pool.query(
      `INSERT INTO klines_1m (symbol, time, open, high, low, close, volume)
       VALUES ('TESTDELUSDC', $1, 1, 1, 1, 1, 1)`,
      [NOW],
    );
    await ctx.pool.query(
      `UPDATE sync_state SET watermark = $1, verified_upto = $1, rows = 1, bytes = 100,
         pending_gaps = 1 WHERE symbol = 'TESTDELUSDC'`,
      [NOW],
    );

    const control = make();
    const result = await control.removeSymbol('TESTDELUSDC', 'delete');
    expect(result.deletedRows).toBe(1);

    const row = await ctx.pool.query<{
      watermark: string | null;
      verified_upto: string | null;
      rows: string;
      bytes: string;
      pending_gaps: number;
    }>(
      `SELECT watermark, verified_upto, rows, bytes, pending_gaps FROM sync_state
        WHERE exchange = 'binance' AND symbol = 'TESTDELUSDC'`,
    );
    expect(row.rows[0]?.watermark).toBeNull();
    expect(row.rows[0]?.verified_upto).toBeNull();
    expect(Number(row.rows[0]?.rows)).toBe(0);
    expect(Number(row.rows[0]?.bytes)).toBe(0);
    expect(Number(row.rows[0]?.pending_gaps)).toBe(0);

    // 重新加入并同步：残留水位会让本轮抛 WATERMARK_MISMATCH（且该码属人工介入 → 永久 error）
    await seedSymbol(ctx.pool, 'TESTDELUSDC');
    const error = await make().runOnce('TESTDELUSDC', NOW);
    expect(error).toBeNull();
  });

  /** R-21.5 只把「缺口耗尽 / 未收盘 bar」列为需人工介入；并发竞争不该钉死标的。 */
  it('R-21.5 SYNC_ALREADY_RUNNING 不把标的钉成 error', async () => {
    const config = configWith();
    const control = make(config, async () => {
      throw new SyncError('SYNC_ALREADY_RUNNING', '另一轮在跑');
    });
    await seedSymbol(ctx.pool, 'TESTBUSYUSDC');
    await control.start('TESTBUSYUSDC');

    const error = await control.runOnce('TESTBUSYUSDC', NOW);
    expect(error?.code).toBe('SYNC_ALREADY_RUNNING');
    const row = await ctx.pool.query<{ status: string }>(
      `SELECT status FROM sync_state WHERE symbol = 'TESTBUSYUSDC'`,
    );
    expect(row.rows[0]?.status).not.toBe('error');
    // 走退避重试，而不是「停止自动重试」
    expect(control.slotsSnapshot()['TESTBUSYUSDC']?.backoffUntil).toBe(NOW + 5_000);
    expect(control.isSchedulable('TESTBUSYUSDC', NOW + 10_000)).toBe(true);
  });

  /**
   * createSyncService 若给控制面与守护进程各造一个 SyncControl，两边各持一份**实例私有**的
   * 运行时槽位：addSymbol 的并发守卫成死代码，resume() 也清不掉守护进程的退避（R-21.3 / R-22）。
   */
  it('R-22 控制面与守护进程共用同一个控制原语实例', async () => {
    const config = configWith();
    const service = createSyncService(makeCtx(config), { config });
    expect(service.daemon.primitives).toBe(service.primitives);
  });

  /** R-1.3 / R-14.5：守护进程启动时必须先过 schema 版本闸门，而不是等第一次写库炸 UndefinedTable。 */
  it('R-1.3 / R-14.5 守护进程启动时 schema 不匹配必须报 SCHEMA_VERSION_MISMATCH', async () => {
    const config = configWith();
    const schema = `tt_nomig_${randomUUID().slice(0, 8)}`;
    const admin = createPool(TEST_DATABASE_CONFIG, {
      overrides: { max: 2, searchPath: 'public', password: TEST_PG.password },
    });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();

    const pool = createPool(TEST_DATABASE_CONFIG, {
      overrides: { max: 2, searchPath: schema, password: TEST_PG.password },
    });
    const previousExitCode = process.exitCode;
    try {
      const daemon = new SyncDaemon(
        buildContext(pool, config, {
          overrides: { password: TEST_PG.password, searchPath: schema },
        }),
        { config },
      );
      await expect(daemon.start()).rejects.toMatchObject({ code: 'SCHEMA_VERSION_MISMATCH' });
    } finally {
      // exitIfGlobalFatal 会置 process.exitCode = 1（那正是「全局性错误 → 退出」的语义），
      // 在测试进程里必须还原，否则整个 vitest 进程会被判失败。
      process.exitCode = previousExitCode;
      await pool.end().catch(() => undefined);
      const cleanup = createPool(TEST_DATABASE_CONFIG, {
        overrides: { max: 2, searchPath: 'public', password: TEST_PG.password },
      });
      try {
        await cleanup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await cleanup.end().catch(() => undefined);
      }
    }
  });
});
