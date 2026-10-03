import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  SyncError,
  defaultConfig,
  type SyncRunSummary,
  type TradeToolConfig,
} from '@trade-tool/core';
import {
  buildContext,
  ensureSyncState,
  setDesiredState,
  upsertSymbolEntry,
} from '@trade-tool/data';

import { SyncDaemon } from '../src/daemon.js';
import { SyncControl } from '../src/primitives.js';

import { createTestSchema, TEST_PG, type TestSchema } from './helpers/pg.js';

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
