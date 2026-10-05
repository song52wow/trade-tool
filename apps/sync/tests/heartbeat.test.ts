import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  SyncError,
  defaultConfig,
  type SyncRunSummary,
  type TradeToolConfig,
} from '@trade-tool/core';
import { buildContext, ensureSyncState, upsertSymbolEntry } from '@trade-tool/data';

import { SyncDaemon } from '../src/daemon.js';
import { SyncControl } from '../src/primitives.js';
import { createSyncService } from '../src/service.js';

import { createTestSchema, TEST_PG, type TestSchema } from './helpers/pg.js';

/**
 * 守护进程心跳的生命周期（R-17.6 / R-19.7）。
 *
 * 这两个用例对应两个真实踩过的缺陷，都曾让控制面对着死掉的守护进程显示「在线」：
 *
 *  1. 循环因全局性错误退出，心跳定时器却仍在独立刷新——「进程在」被当成了
 *     「有人在同步」，页面显示在线而数据一动不动。
 *  2. `createSyncService().close()` 只关连接池、从不调 `daemon.stop()`，
 *     于是 SIGTERM 的优雅退出没删掉心跳行，进程已退出而页面读到 stale。
 *
 * 心跳间隔注入成毫秒级，否则「是否真的停了刷新」只能用 10 秒的时间差证明。
 */

const SYMBOL = 'TESTBEATUSDC';
const NOW = 1_760_000_000_000;
/** 心跳刷新间隔：够密到断言不飘，又不至于让时间差测不出差别 */
const BEAT_MS = 20;

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

async function readBeat(pool: TestSchema['pool']): Promise<number | null> {
  const row = await pool.query<{ last_beat: string }>(
    'SELECT last_beat FROM daemon_heartbeat WHERE exchange = $1',
    ['binance'],
  );
  return row.rows[0] === undefined ? null : Number(row.rows[0].last_beat);
}

describe('守护进程心跳：进程在 ≠ 有人在同步', () => {
  let ctx: TestSchema;
  let config: TradeToolConfig;
  const previousExitCode = process.exitCode;

  beforeAll(async () => {
    ctx = await createTestSchema('beat');
    const base = defaultConfig();
    config = { ...base, market: { ...base.market, exchange: 'binance' } };
  });

  afterAll(async () => {
    // exitIfGlobalFatal 会置 process.exitCode = 1，在测试进程里必须还原。
    process.exitCode = previousExitCode;
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.pool.query('TRUNCATE klines_1m, gaps, sync_state, symbols, contract_spec');
    await ctx.pool.query('DELETE FROM daemon_heartbeat');
  });

  function makeCtx() {
    return buildContext(ctx.pool, config, {
      overrides: { password: TEST_PG.password, searchPath: ctx.schema },
    });
  }

  it('循环因全局性错误退出后不再刷心跳，但心跳行保留（让页面报 stale 而非 stopped）', async () => {
    // SCHEMA_VERSION_MISMATCH 在 GLOBAL_FATAL_CODES 里：循环会抛错退出，进程还活着。
    const control = new SyncControl(makeCtx(), {
      config,
      syncFn: async (symbol) => {
        throw new SyncError('SCHEMA_VERSION_MISMATCH', '库内多出 003');
      },
    });
    await upsertSymbolEntry(ctx.pool, { exchange: 'binance', symbol: SYMBOL });
    await ensureSyncState(ctx.pool, 'binance', SYMBOL, 'paused');
    await control.start(SYMBOL);

    const daemon = new SyncDaemon(makeCtx(), {
      config,
      control,
      now: () => NOW,
      sleep: async () => undefined,
      heartbeatIntervalMs: BEAT_MS,
    });
    await daemon.start();

    // 等循环那一轮失败并退出（sleep 被注成立即返回，循环会在第一轮就撞上致命错误）
    await new Promise((r) => setTimeout(r, 200));

    const beatAfterExit = await readBeat(ctx.pool);
    expect(beatAfterExit, '心跳行应在：进程还活着，只是循环死了').not.toBeNull();

    // 关键断言：刷新必须已经停了。再等一段时间差，last_beat 不能再动。
    await new Promise((r) => setTimeout(r, 300));
    expect(await readBeat(ctx.pool), '循环退出后心跳仍在刷新 = 页面会把死循环读成在线').toBe(
      beatAfterExit,
    );

    await daemon.stop();
  });

  it('优雅退出（service.close）删掉心跳行，让「行不存在」就是确切的离线', async () => {
    const service = createSyncService(makeCtx(), {
      config,
      sleep: async () => undefined,
      heartbeatIntervalMs: BEAT_MS,
    });
    await service.daemon.start();
    expect(await readBeat(ctx.pool), '启动后应先落一行心跳').not.toBeNull();

    // 这正是 SIGTERM 的路径。close() 必须走到 daemon.stop()，否则行会留在库里。
    await service.close();
    expect(await readBeat(ctx.pool), '优雅退出后心跳行应被删除').toBeNull();
  });
});
