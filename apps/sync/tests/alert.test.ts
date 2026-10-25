import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  defaultConfig,
  SyncError,
  type AlertChannel,
  type NotifyEvent,
  type SyncRunSummary,
  type TradeToolConfig,
} from '@trade-tool/core';
import { buildContext, ensureSyncState, upsertSymbolEntry } from '@trade-tool/data';

import { SyncAlerter } from '../src/alert.js';
import { SyncDaemon } from '../src/daemon.js';
import { SyncControl } from '../src/primitives.js';

import { createTestSchema, TEST_PG, type TestSchema } from './helpers/pg.js';

/**
 * 同步器自己的故障 → 飞书告警（2026-10-25）。
 *
 * 背景：目标机 192.168.1.90 上实测到同步静默 **5 小时 55 分**——
 * 三个标的连续失败到上限被钉成 `error` 之后，调度器每 15 秒扫一次、
 * 每次都选不出标的，而 `tick()` 对空批次直接 return、不打日志；
 * 与此同时心跳照刷，控制面显示「在线」。
 *
 * 这几条用例守的就是那个洞：**同步停下来这件事，必须有人被告知**。
 */

const SYMBOL = 'TESTALERTUSDC';
const NOW = 1_760_000_000_000;

/** 记下所有被推出去的消息。 */
function recordingChannel(sent: NotifyEvent[], kinds: string[]): AlertChannel {
  return {
    notifier: {
      enabled: true,
      notify: async (event: NotifyEvent) => {
        sent.push(event);
      },
    },
    kinds,
    repeatCooldownMs: 0,
  };
}

/** 推送必定失败的通道。用来证明「推送坏了不影响同步」。 */
function failingChannel(): AlertChannel {
  return {
    notifier: {
      enabled: true,
      notify: async () => {
        throw new SyncError('RATE_LIMITED', '飞书限频了');
      },
    },
    kinds: ['sync-symbol-error', 'sync-stopped'],
    repeatCooldownMs: 0,
  };
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
    aggregated: null,
    indicators: null,
    implVersion: 1,
  };
}

describe('同步器的告警出口：同步停下来必须有人知道', () => {
  let ctx: TestSchema;
  let config: TradeToolConfig;
  const previousExitCode = process.exitCode;

  beforeAll(async () => {
    ctx = await createTestSchema('alert');
    const base = defaultConfig();
    config = {
      ...base,
      market: { ...base.market, exchange: 'binance' },
      // 一次失败就钉死：让用例不必等 5 次退避（默认 5 次要好几分钟）。
      sync: { ...base.sync, maxConsecutiveErrors: 1 },
    };
  });

  afterAll(async () => {
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

  it('标的一直失败到上限 → 推一条「标的同步失败」，并说清连续失败次数', async () => {
    const sent: NotifyEvent[] = [];
    const alerter = new SyncAlerter({
      channel: () => recordingChannel(sent, ['sync-symbol-error']),
    });

    await alerter.reportHealth({
      pinned: [{ symbol: SYMBOL, message: '[NETWORK_ERROR] 请求交易所失败', consecutiveErrors: 5 }],
      stopped: null,
    });

    expect(sent, '被钉死的标的必须被推出去').toHaveLength(1);
    expect(sent[0]?.title).toContain(SYMBOL);
    expect(sent[0]?.lines?.join('\n')).toContain('NETWORK_ERROR');
    expect(sent[0]?.lines?.join('\n')).toContain('5');
  });

  it('所有在跑的标的都被钉死 → 推一条「同步停摆」', async () => {
    const sent: NotifyEvent[] = [];
    const alerter = new SyncAlerter({ channel: () => recordingChannel(sent, ['sync-stopped']) });

    await alerter.reportHealth({
      pinned: [{ symbol: SYMBOL, message: 'x', consecutiveErrors: 5 }],
      stopped: 'all-pinned',
    });

    expect(sent, '整个同步停摆必须被推出去').toHaveLength(1);
    expect(sent[0]?.title).toContain('停摆');
    expect(sent[0]?.severity).toBe('critical');
  });

  it('没勾选的内容不推（尊重用户在控制面的勾选）', async () => {
    const sent: NotifyEvent[] = [];
    // 只勾了「同步停摆」：标的那条就不该推。
    const alerter = new SyncAlerter({ channel: () => recordingChannel(sent, ['sync-stopped']) });

    await alerter.reportHealth({
      pinned: [{ symbol: SYMBOL, message: 'x', consecutiveErrors: 5 }],
      stopped: 'all-pinned',
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.title).toContain('停摆');
    expect(sent[0]?.title).not.toContain(SYMBOL);
  });

  it('推送失败不影响同步：守护进程照跑，不抛错', async () => {
    const alerter = new SyncAlerter({ channel: () => failingChannel() });
    // 推送必然抛错 —— 这一条必须被吞掉（AGENTS.md 约定 9 与 notify.ts 文件头第 2 条）。
    await expect(
      alerter.reportHealth({
        pinned: [{ symbol: SYMBOL, message: 'x', consecutiveErrors: 5 }],
        stopped: 'all-pinned',
      }),
    ).resolves.toBeUndefined();
  });

  it('守护进程：标的被钉死 → 推「标的失败」+「同步停摆」，且心跳不再刷新', async () => {
    const sent: NotifyEvent[] = [];
    const control = new SyncControl(makeCtx(), {
      config,
      syncFn: async () => {
        // **真错误**（交易所明确说不行）才会把标的钉死；网络错误不会（见下面那条用例）。
        throw new SyncError('EXCHANGE_ERROR', '交易所返回 HTTP 400');
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
      heartbeatIntervalMs: 20,
      alerter: new SyncAlerter({
        channel: () => recordingChannel(sent, ['sync-symbol-error', 'sync-stopped']),
      }),
    });
    await daemon.start();

    // 让它跑几轮：失败 → 被钉死 → 下一轮的健康度判定就该看到「全被钉死」。
    await new Promise((r) => setTimeout(r, 300));

    const titles = sent.map((event) => event.title);
    expect(
      titles.some((title) => title.includes(SYMBOL)),
      `应当有一条「标的同步失败」的告警，实际收到：${JSON.stringify(titles)}`,
    ).toBe(true);
    expect(
      titles.some((title) => title.includes('停摆')),
      `应当有一条「同步停摆」的告警，实际收到：${JSON.stringify(titles)}`,
    ).toBe(true);

    // 心跳必须停刷：停摆时继续刷，控制面就会显示「在线」而实际上一条数据都没进。
    const beat = await ctx.pool.query<{ last_beat: string }>(
      'SELECT last_beat FROM daemon_heartbeat WHERE exchange = $1',
      ['binance'],
    );
    const stopped = beat.rows[0] === undefined ? null : Number(beat.rows[0].last_beat);
    await new Promise((r) => setTimeout(r, 200));
    const later = await ctx.pool.query<{ last_beat: string }>(
      'SELECT last_beat FROM daemon_heartbeat WHERE exchange = $1',
      ['binance'],
    );
    expect(later.rows[0] === undefined ? null : Number(later.rows[0].last_beat)).toBe(stopped);

    await daemon.stop();
  });

  it('守护进程：全局性错误退出 → 推一条「守护进程退出」', async () => {
    const sent: NotifyEvent[] = [];
    const control = new SyncControl(makeCtx(), {
      config,
      syncFn: async () => {
        // SCHEMA_VERSION_MISMATCH 在 GLOBAL_FATAL_CODES 里：循环会抛错退出。
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
      heartbeatIntervalMs: 20,
      alerter: new SyncAlerter({ channel: () => recordingChannel(sent, ['sync-stopped']) }),
    });
    await daemon.start();

    await new Promise((r) => setTimeout(r, 300));

    expect(
      sent.some((event) => event.title.includes('守护进程')),
      `应当有一条「守护进程退出」的告警，实际收到：${JSON.stringify(sent.map((e) => e.title))}`,
    ).toBe(true);

    await daemon.stop();
  });

  it('网络错误不钉死标的，但「很久没进展」照样会推一条「同步停摆」', async () => {
    // 网络错误不再钉死标的（用户 2026-10-25 定的口径），于是「全被钉死」那条判据
    // 在代理彻底断掉时**不会**触发。必须另有一条判据接手，否则就是「没人知道」。
    const sent: NotifyEvent[] = [];
    let clock = NOW;
    const control = new SyncControl(makeCtx(), {
      config,
      syncFn: async () => {
        throw new SyncError('NETWORK_ERROR', '请求交易所失败');
      },
    });
    await upsertSymbolEntry(ctx.pool, { exchange: 'binance', symbol: SYMBOL });
    await ensureSyncState(ctx.pool, 'binance', SYMBOL, 'paused');
    await control.start(SYMBOL);

    const daemon = new SyncDaemon(makeCtx(), {
      config,
      control,
      now: () => clock,
      sleep: async () => undefined,
      heartbeatIntervalMs: 20,
      alerter: new SyncAlerter({ channel: () => recordingChannel(sent, ['sync-stopped']) }),
    });
    await daemon.start();

    // 时间快进 11 分钟：这期间没有任何标的同步成功过
    clock = NOW + 11 * 60_000;
    await new Promise((r) => setTimeout(r, 200));

    expect(
      sent.some((event) => event.title.includes('停摆')),
      `很久没进展必须被推出去，实际收到：${JSON.stringify(sent.map((e) => e.title))}`,
    ).toBe(true);
    // 而且标的**没有**被钉死（网络错误不算连续失败）
    const row = await ctx.pool.query<{ status: string }>(
      `SELECT status FROM sync_state WHERE symbol = $1`,
      [SYMBOL],
    );
    expect(row.rows[0]?.status).not.toBe('error');

    await daemon.stop();
  });

  it('一切正常时不推任何东西（不刷屏）', async () => {
    const sent: NotifyEvent[] = [];
    const control = new SyncControl(makeCtx(), {
      config,
      syncFn: async (symbol) => okSummary(symbol),
    });
    await upsertSymbolEntry(ctx.pool, { exchange: 'binance', symbol: SYMBOL });
    await ensureSyncState(ctx.pool, 'binance', SYMBOL, 'paused');
    await control.start(SYMBOL);

    const daemon = new SyncDaemon(makeCtx(), {
      config,
      control,
      now: () => NOW,
      sleep: async () => undefined,
      heartbeatIntervalMs: 20,
      alerter: new SyncAlerter({
        channel: () => recordingChannel(sent, ['sync-symbol-error', 'sync-stopped']),
      }),
    });
    await daemon.start();

    await new Promise((r) => setTimeout(r, 300));
    expect(sent, '一切正常时一条都不该推').toHaveLength(0);

    await daemon.stop();
  });
});
