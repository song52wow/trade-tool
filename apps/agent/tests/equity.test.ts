/**
 * 账户权益读取的测试（v1.0.0）。
 *
 * 这里锁的是**一条最要命的判据**：读不到权益就抛错，**绝不返回 0**。
 *
 * 0 会被当成「账户没钱」，于是仓位算成 0，出一份「数量 0、看起来完全正常」的
 * 方案——那种错最难发现：方案在库里、页面显示正常、但一笔单都开不出来。
 * 约定 9 忌讳的正是这种「看起来成功了，其实什么都没做」。
 *
 * 另外锁住「显式二选一」：`equitySource = 'config'` 时**根本不碰交易所**
 * （不需要凭据），`exchange` 时**只**读交易所不回落配置。
 */

import { agentSchema, type AgentConfig, type ExecutorConfig } from '@trade-tool/core';
import type { BinancePrivateClient, Pool } from '@trade-tool/data';
import { describe, expect, it } from 'vitest';

import { createEquityReader } from '../src/equity.js';

const EXECUTOR = { environment: 'live' } as unknown as ExecutorConfig;

/** 假私有客户端：只回一个余额。 */
function clientOf(balance: number, calls: { count: number }): BinancePrivateClient {
  return {
    accountBalance: async (): Promise<number> => {
      calls.count += 1;
      return balance;
    },
  } as unknown as BinancePrivateClient;
}

/** 假池子：权益读取用不到它，但 `resolveActiveCredentials` 需要。 */
function fakePool(): Pool {
  return {
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: () => Promise.reject(new Error('不该被调用')),
    end: () => Promise.resolve(),
  } as unknown as Pool;
}

function configOf(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return agentSchema.parse({
    enabled: true,
    equitySource: 'config',
    equity: 10_000,
    ...overrides,
  });
}

describe('createEquityReader', () => {
  it('equitySource = config：直接用配置里的数，**根本不碰交易所**', async () => {
    const calls = { count: 0 };
    const read = createEquityReader({
      pool: fakePool(),
      config: configOf({ equitySource: 'config', equity: 12_345 }),
      exchange: 'binance',
      executor: EXECUTOR,
      createClient: async () => clientOf(999, calls),
    });

    const reading = await read();

    expect(reading).toEqual({ equity: 12_345, source: 'config' });
    // 没建客户端 = 不需要凭据，也不发出任何请求
    expect(calls.count).toBe(0);
  });

  it('equitySource = config 但 equity = 0：报错，不拿 0 去算仓位', async () => {
    const read = createEquityReader({
      pool: fakePool(),
      config: configOf({ equitySource: 'config', equity: 0 }),
      exchange: 'binance',
      executor: EXECUTOR,
    });

    await expect(read()).rejects.toThrowError(/算不出仓位|equity/);
  });

  it('equitySource = exchange：只读交易所，不回落配置', async () => {
    const calls = { count: 0 };
    const read = createEquityReader({
      pool: fakePool(),
      // 配置里也写了一个数，但显式选了 exchange —— 配置那个**不生效**
      config: configOf({ equitySource: 'exchange', equity: 99_999 }),
      exchange: 'binance',
      executor: EXECUTOR,
      createClient: async () => clientOf(8_888, calls),
    });

    const reading = await read();

    expect(reading).toEqual({ equity: 8_888, source: 'exchange' });
    expect(calls.count).toBe(1);
  });

  it('交易所返回 0：抛错，**不是返回 0**', async () => {
    const calls = { count: 0 };
    const read = createEquityReader({
      pool: fakePool(),
      config: configOf({ equitySource: 'exchange' }),
      exchange: 'binance',
      executor: EXECUTOR,
      createClient: async () => clientOf(0, calls),
    });

    await expect(read()).rejects.toThrowError(/算不出仓位/);
  });

  it('交易所读不到（抛错）：原样抛出，不回落配置', async () => {
    const read = createEquityReader({
      pool: fakePool(),
      config: configOf({ equitySource: 'exchange', equity: 99_999 }),
      exchange: 'binance',
      executor: EXECUTOR,
      createClient: async () => {
        throw new Error('交易所私网超时');
      },
    });

    await expect(read()).rejects.toThrowError('交易所私网超时');
  });

  it('客户端只建一次：多轮分析不会反复解析凭据', async () => {
    const calls = { count: 0 };
    let built = 0;
    const read = createEquityReader({
      pool: fakePool(),
      config: configOf({ equitySource: 'exchange' }),
      exchange: 'binance',
      executor: EXECUTOR,
      createClient: async () => {
        built += 1;
        return clientOf(5_000, calls);
      },
    });

    await read();
    await read();

    expect(built).toBe(1);
    expect(calls.count).toBe(2);
  });
});
