/**
 * 止盈止损服务自己的健康监控（2026-11-06）。
 *
 * 守的是三件会重复咬人的事：
 *   1. **私有接口不可用要推得出告警**——2026-10-31 到 11-06 那 6 天静默，
 *      止盈止损一单都挂不出去而没人知道；
 *   2. **业务失败不算「服务不可用」**——余额不足、参数非法是这一笔的问题，
 *      说成服务不可用会把处置方向带偏；
 *   3. **推送坏了不影响挂单**——通知是给人看的，挂单是活干。
 *
 * 不连 PG、不出网：Pool 与飞书通道都是纯替身。
 */

import { describe, expect, it } from 'vitest';

import {
  AlertDispatcher,
  PRIVATE_API_UNAVAILABLE_THRESHOLD_MS,
  SyncError,
  type AlertChannel,
  type NotifyEvent,
} from '@trade-tool/core';
import type { Pool } from '@trade-tool/data';

import { buildExecutorUnavailableAlert, ExecutorHealthMonitor } from '../src/health.js';

const NOW = 1_760_000_000_000;

/** 记录所有发出的 SQL，状态行写没写、写成了什么样都看得见。 */
function fakePool(): { pool: Pool; queries: string[] } {
  const queries: string[] = [];
  const pool = {
    query: (sql: string): Promise<unknown> => {
      queries.push(sql.replace(/\s+/g, ' ').trim());
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    connect: () => Promise.reject(new Error('不该被调用')),
    end: () => Promise.resolve(),
  } as unknown as Pool;
  return { pool, queries };
}

/** 飞书通道替身：把发出去的消息收下来。 */
function channelOf(sent: NotifyEvent[], kinds: string[] = ['executor-unavailable']): AlertChannel {
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

/** 币安把私有接口拒了的那一种错误（2026-11-06 在目标机上实测到的原话）。 */
function rejectedByExchange(): SyncError {
  return new SyncError(
    'EXCHANGE_ERROR',
    'Binance POST /fapi/v1/listenKey 失败：Invalid API-key, IP, or permissions for action.',
    { status: 401, exchangeCode: -2015, path: '/fapi/v1/listenKey' },
  );
}

describe('止盈止损服务的健康监控', () => {
  it('私有接口持续不可用 → 推一条告警，内容里有交易所的原话', async () => {
    const sent: NotifyEvent[] = [];
    const { pool } = fakePool();
    let now = NOW;
    const monitor = new ExecutorHealthMonitor({
      pool,
      exchange: 'binance',
      alerts: new AlertDispatcher({ channel: channelOf(sent) }),
      now: () => now,
    });

    // 第一次失败：还不够久，不推。
    await monitor.markPrivateApiFailure(rejectedByExchange());
    await monitor.report();
    expect(sent).toHaveLength(0);

    // 拖过阈值：推。
    now += PRIVATE_API_UNAVAILABLE_THRESHOLD_MS + 1;
    await monitor.markPrivateApiFailure(rejectedByExchange());
    await monitor.report();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.title).toContain('止盈止损服务不可用');
    expect(sent[0]?.severity).toBe('critical');
    expect((sent[0]?.lines ?? []).join('\n')).toContain('-2015');
  });

  it('恢复之后推一条「已恢复」', async () => {
    const sent: NotifyEvent[] = [];
    const { pool } = fakePool();
    let now = NOW;
    const monitor = new ExecutorHealthMonitor({
      pool,
      exchange: 'binance',
      alerts: new AlertDispatcher({ channel: channelOf(sent) }),
      now: () => now,
    });

    await monitor.markPrivateApiFailure(rejectedByExchange());
    now += PRIVATE_API_UNAVAILABLE_THRESHOLD_MS + 1;
    await monitor.markPrivateApiFailure(rejectedByExchange());
    await monitor.report();
    expect(sent).toHaveLength(1);

    now += 1_000;
    await monitor.markPrivateApiSuccess();
    await monitor.report();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.title).toContain('已恢复');
  });

  it('业务失败（余额不足）不算「服务不可用」', async () => {
    const sent: NotifyEvent[] = [];
    const { pool } = fakePool();
    let now = NOW;
    const monitor = new ExecutorHealthMonitor({
      pool,
      exchange: 'binance',
      alerts: new AlertDispatcher({ channel: channelOf(sent) }),
      now: () => now,
    });

    // -2019 Margin is insufficient：这一笔的问题，接口本身好得很。
    const business = new SyncError('EXCHANGE_ERROR', 'Binance 挂单失败：Margin is insufficient.', {
      status: 400,
      exchangeCode: -2019,
      path: '/fapi/v1/algoOrder',
    });
    const recorded = await monitor.markPrivateApiFailure(business);
    expect(recorded).toBe(false);

    now += PRIVATE_API_UNAVAILABLE_THRESHOLD_MS * 2;
    await monitor.report();
    expect(sent).toHaveLength(0);
    expect(monitor.snapshot().failureCount).toBe(0);
  });

  it('用户没勾这一种 → 不推（尊重勾选）', async () => {
    const sent: NotifyEvent[] = [];
    const { pool } = fakePool();
    let now = NOW;
    const monitor = new ExecutorHealthMonitor({
      pool,
      exchange: 'binance',
      alerts: new AlertDispatcher({ channel: channelOf(sent, []) }),
      now: () => now,
    });

    await monitor.markPrivateApiFailure(rejectedByExchange());
    now += PRIVATE_API_UNAVAILABLE_THRESHOLD_MS + 1;
    await monitor.markPrivateApiFailure(rejectedByExchange());
    await monitor.report();
    expect(sent).toHaveLength(0);
  });

  it('状态行会被写进去：心跳 + 私有接口结果', async () => {
    const sent: NotifyEvent[] = [];
    const { pool, queries } = fakePool();
    const monitor = new ExecutorHealthMonitor({
      pool,
      exchange: 'binance',
      alerts: new AlertDispatcher({ channel: channelOf(sent) }),
      now: () => NOW,
    });

    await monitor.beat();
    await monitor.markPrivateApiFailure(rejectedByExchange());
    await monitor.markPrivateApiSuccess();

    expect(queries.some((q) => q.includes('INSERT INTO executor_status'))).toBe(true);
    expect(queries.some((q) => q.includes('private_api_ok = false'))).toBe(true);
    expect(queries.some((q) => q.includes('private_api_ok = true'))).toBe(true);
  });

  it('推送坏了不影响服务（记日志，不抛）', async () => {
    const { pool } = fakePool();
    const failing: AlertChannel = {
      notifier: {
        enabled: true,
        notify: async () => {
          throw new SyncError('RATE_LIMITED', '飞书限频了');
        },
      },
      kinds: ['executor-unavailable'],
      repeatCooldownMs: 0,
    };
    let now = NOW;
    const monitor = new ExecutorHealthMonitor({
      pool,
      exchange: 'binance',
      alerts: new AlertDispatcher({ channel: failing }),
      now: () => now,
    });

    await monitor.markPrivateApiFailure(rejectedByExchange());
    now += PRIVATE_API_UNAVAILABLE_THRESHOLD_MS + 1;
    await monitor.markPrivateApiFailure(rejectedByExchange());
    await expect(monitor.report()).resolves.toBeUndefined();
  });
});

describe('「止盈止损服务不可用」这条告警本身', () => {
  it('指纹只由「是什么事」决定：错误原文变了也不换指纹', () => {
    const a = buildExecutorUnavailableAlert({
      unavailableMs: 60_000,
      failureCount: 3,
      lastErrorCode: '-2015',
      lastErrorMessage: 'Invalid API-key',
    });
    const b = buildExecutorUnavailableAlert({
      unavailableMs: 120_000,
      failureCount: 9,
      lastErrorCode: '-2015',
      lastErrorMessage: 'Invalid API-key, IP, or permissions for action',
    });
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('文案里带上排查那三样（key / IP 白名单 / 环境）', () => {
    const item = buildExecutorUnavailableAlert({
      unavailableMs: 360_000,
      failureCount: 5,
      lastErrorCode: '-2015',
      lastErrorMessage: 'Invalid API-key, IP, or permissions for action',
    });
    const text = (item.lines ?? []).join('\n');
    expect(text).toContain('API key');
    expect(text).toContain('IP');
    expect(text).toContain('executor.environment');
    expect(item.resolvedTitle).toContain('已恢复');
  });
});
