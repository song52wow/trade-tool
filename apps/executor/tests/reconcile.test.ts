/**
 * 周期对账的定时器与失败语义（v0.6.0）。
 *
 * 落库的用例在 `packages/data/tests/reconcile.test.ts`（那里才有 PG 夹具）；
 * 这里只锁 executor 独有的两条：
 *   1. **失败不许拖垮挂单**。对账是旁观者：它挂了，止盈止损必须照常工作。
 *      因此 `runOnce` 永远返回 null / 报告，**绝不抛错**——抛出去就等于
 *      「对账失败 → 止盈止损服务也停了」，那比不对账糟糕得多。
 *   2. **定时器独立于主循环，且退出能停掉**。挂着的 setInterval 会让进程在
 *      「已收到停止信号」之后继续不退出。
 *
 * 不连 PG、不出网：Pool 与交易所客户端都是纯替身。
 */

import { describe, expect, it } from 'vitest';

import type { TradeToolConfig } from '@trade-tool/core';
import type { BinancePrivateClient, Pool } from '@trade-tool/data';

import { runOnce, startPeriodicReconcile } from '../src/reconcile.js';

const NOW = 1_760_000_000_000;

function configWith(intervalMs: number): TradeToolConfig {
  return {
    market: { exchange: 'binance' },
    executor: { reconcileIntervalMs: intervalMs },
  } as unknown as TradeToolConfig;
}

/** 只需被调用、不需要真的建连接的 Pool 替身。 */
function fakePool(): { pool: Pool; closed: boolean } {
  const state = { closed: false, pool: null as unknown as Pool };
  state.pool = {
    query: (): Promise<unknown> => {
      // 写快照时调用 `BEGIN`；这里不区分语句，只保证可 await。
      if (state.closed) return Promise.reject(new Error('连接已关闭'));
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    connect: () => Promise.reject(new Error('不该被调用')),
    end: () => Promise.resolve(),
  } as unknown as Pool;
  return state;
}

function clientOf(calls: { count: number }, fail = false): BinancePrivateClient {
  return {
    positionRisk: (): Promise<never[]> => {
      calls.count += 1;
      if (fail) return Promise.reject(new Error('交易所私网超时'));
      return Promise.resolve([]);
    },
    openAlgoOrders: (): Promise<never[]> => {
      if (fail) return Promise.reject(new Error('交易所私网超时'));
      return Promise.resolve([]);
    },
  } as unknown as BinancePrivateClient;
}

describe('runOnce', () => {
  it('正常时返回报告', async () => {
    const calls = { count: 0 };
    const report = await runOnce({
      pool: fakePool().pool,
      client: clientOf(calls),
      config: configWith(60_000),
      now: () => NOW,
    });
    expect(calls.count).toBe(1);
    expect(report).not.toBeNull();
    expect(report?.healthy).toBe(true);
    expect(report?.checkedAt).toBe(NOW);
  });

  it('交易所失败时返回 null 而不是抛错', async () => {
    const report = await runOnce({
      pool: fakePool().pool,
      client: clientOf({ count: 0 }, true),
      config: configWith(60_000),
      now: () => NOW,
    });
    expect(report).toBeNull();
  });

  it('写快照失败时仍返回报告（落库失败不能吞掉已经查到的结论）', async () => {
    // 读正常、写失败——这才是真实场景：PG 抖动 / 迁移未应用。
    const writeFails = {
      query: (sql: string): Promise<unknown> => {
        if (/^\s*INSERT/.test(sql)) return Promise.reject(new Error('PG 写不进去'));
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
      connect: () => Promise.reject(new Error('不该被调用')),
      end: () => Promise.resolve(),
    } as unknown as Pool;

    const report = await runOnce({
      pool: writeFails,
      client: clientOf({ count: 0 }),
      config: configWith(60_000),
      now: () => NOW,
    });
    // 对账本身查成了，只是没落库：仍然返回报告，差异照样进日志。
    expect(report?.healthy).toBe(true);
  });

  it('连读都失败时返回 null（对账确实没跑成）', async () => {
    const broken = {
      query: (): Promise<unknown> => Promise.reject(new Error('PG 读不出来')),
      connect: () => Promise.reject(new Error('不该被调用')),
      end: () => Promise.resolve(),
    } as unknown as Pool;
    expect(
      await runOnce({ pool: broken, client: clientOf({ count: 0 }), config: configWith(60_000) }),
    ).toBeNull();
  });
});

describe('startPeriodicReconcile', () => {
  it('启动立刻跑一次，再按周期跑', async () => {
    const calls = { count: 0 };
    const timers: { fn: () => void; ms: number }[] = [];
    let cleared = 0;

    const periodic = startPeriodicReconcile({
      pool: fakePool().pool,
      client: clientOf(calls),
      config: configWith(60_000),
      now: () => NOW,
      setIntervalImpl: ((fn: () => void, ms: number) => {
        timers.push({ fn, ms });
        return 0 as unknown as NodeJS.Timeout;
      }) as never,
      clearIntervalImpl: (() => {
        cleared += 1;
      }) as never,
    });

    // 启动那一次是立即挂起的执行，跑完两个微任务就该落地。
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls.count).toBe(1);
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(60_000);

    timers[0]?.fn();
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls.count).toBe(2);

    periodic.stop();
    expect(cleared).toBe(1);
  });

  it('reconcileIntervalMs = 0 时关闭自动对账，且不留下任何定时器', () => {
    let registered = 0;
    const periodic = startPeriodicReconcile({
      pool: fakePool().pool,
      client: clientOf({ count: 0 }),
      config: configWith(0),
      setIntervalImpl: (() => {
        registered += 1;
        return 0 as unknown as NodeJS.Timeout;
      }) as never,
    });
    expect(registered).toBe(0);
    // stop 必须是空操作而不是抛错：调用点在退出路径上无条件调它。
    expect(() => periodic.stop()).not.toThrow();
  });

  it('周期里的一轮失败不影响下一轮继续跑', async () => {
    const calls = { count: 0 };
    const timers: { fn: () => void }[] = [];
    let failNext = true;

    const flaky = {
      positionRisk: (): Promise<never[]> => {
        calls.count += 1;
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error('一次性抖动'));
        }
        return Promise.resolve([]);
      },
      openAlgoOrders: (): Promise<never[]> => Promise.resolve([]),
    } as unknown as BinancePrivateClient;

    const periodic = startPeriodicReconcile({
      pool: fakePool().pool,
      client: flaky,
      config: configWith(60_000),
      setIntervalImpl: ((fn: () => void) => {
        timers.push({ fn });
        return 0 as unknown as NodeJS.Timeout;
      }) as never,
      clearIntervalImpl: (() => undefined) as never,
    });

    await new Promise((resolve) => setImmediate(resolve));
    timers[0]?.fn();
    await new Promise((resolve) => setImmediate(resolve));
    // 第一轮失败、第二轮成功：定时器没有因为一次异常而哑火。
    expect(calls.count).toBe(2);

    periodic.stop();
  });
});
