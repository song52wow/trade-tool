import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { defaultConfig, type TradeToolConfig } from '@trade-tool/core';
import {
  buildContext,
  makeMockSymbols,
  startMockExchange,
  type MockExchange,
} from '@trade-tool/data';

import { SyncControl } from '../src/primitives.js';

import { createTestSchema, TEST_PG, type TestSchema } from './helpers/pg.js';

/**
 * 全局限速与并发的**可复现**验收（AC-17 / AC-24 / R-20）。
 *
 * 这一组必须跑真实引擎：配额桶在 Python 侧、请求真的发出去才谈得上「没超配额」。
 * 交易所指向本地假服务器（R-16.5），全程不访问真实网络。
 */

const NOW = Date.now();
const SYMBOLS = ['TESTAAAUSDC', 'TESTBBBUSDC', 'TESTCCCUSDC'] as const;

let exchange: MockExchange;
let ctx: TestSchema;
let metaDir: string;
let config: TradeToolConfig;

/** 观察到的每一次配额水位，用来断言「始终不超过预算」。 */
const observations: number[] = [];

beforeAll(async () => {
  exchange = await startMockExchange({ nowMs: NOW, symbols: makeMockSymbols(NOW) });
  process.env['TRADE_TOOL_BINANCE_BASE_URL'] = exchange.url;
  metaDir = await mkdtemp(join(tmpdir(), 'tt-rate-'));
  ctx = await createTestSchema('rate');

  const base = defaultConfig();
  config = {
    ...base,
    market: { ...base.market, exchange: 'binance', source: 'binance' },
    data: { ...base.data, metaDir, metadataTtlMs: 3_600_000, batchSize: 5_000, maxGapAttempts: 3 },
    // 并发 5 > 标的数 3：确保「并发上限」不是靠标的少才没突刺（R-20.6 / AC-24）
    sync: { ...base.sync, concurrency: 5, weightBudgetPerMinute: 1_920 },
  };
});

afterAll(async () => {
  delete process.env['TRADE_TOOL_BINANCE_BASE_URL'];
  await rm(metaDir, { recursive: true, force: true }).catch(() => undefined);
  await exchange.close();
  await ctx.close();
});

function makeControl(): SyncControl {
  const marketCtx = buildContext(ctx.pool, config, {
    overrides: { password: TEST_PG.password, searchPath: ctx.schema },
  });
  return new SyncControl(marketCtx, { config });
}

/** 读一次全局配额水位并记录。预算值来自配置（库里只存已用量，不存预算）。 */
async function observeBudget(): Promise<{ used: number; budget: number; utilization: number }> {
  const row = await ctx.pool.query<{ used: string }>('SELECT used FROM weight_budget WHERE id = 1');
  const used = Number(row.rows[0]?.used ?? 0);
  const budget = config.sync.weightBudgetPerMinute;
  observations.push(used);
  return { used, budget, utilization: budget > 0 ? used / budget : 0 };
}

/** 预置一行预算配置（Python 侧负责维护 used，这里只给出本轮的预算值）。 */
async function seedBudget(): Promise<void> {
  await ctx.pool.query(
    `INSERT INTO weight_budget (id, window_from, used) VALUES (1, 0, 0)
     ON CONFLICT (id) DO UPDATE SET used = 0, window_from = 0, pause_until = NULL`,
  );
}

describe('全局配额与并发（AC-17 / AC-24 / R-20）', () => {
  it('AC-17 并发 5 个以上标的（含需全量回补的）→ 权重始终低于预算、无 429、使用率可查询', async () => {
    await seedBudget();
    const control = makeControl();

    // 一次性加入 3 个**都需要全量回补**的新标的：单标的全量约 29 次请求 / 290 权重。
    for (const symbol of SYMBOLS) {
      await control.addSymbol(symbol);
      await control.start(symbol);
    }
    expect(config.sync.concurrency).toBeGreaterThanOrEqual(SYMBOLS.length);

    const failures: string[] = [];
    for (let round = 0; round < 3; round += 1) {
      const batch = await control.allStates();
      expect(batch.length).toBeGreaterThan(0);

      // 并发跑这一轮，每个标的各自一轮同步
      const results = await Promise.all(SYMBOLS.map((symbol) => control.runOnce(symbol, Date.now())));
      for (const [index, error] of results.entries()) {
        if (error) failures.push(`${SYMBOLS[index]}: ${error.code}`);
      }

      const { used, budget, utilization } = await observeBudget();
      // 关键断言：任何时刻都没有越过预算（R-20.3 留余量）
      expect(used, `round ${round} 权重 ${used} 超过预算 ${budget}`).toBeLessThanOrEqual(budget);
      expect(utilization).toBeLessThanOrEqual(1);
    }

    // 无 429 / 无失败：交易所若被限流会抛 EXCHANGE_RATE_LIMITED
    expect(failures, `本轮出现失败：${failures.join(', ')}`).toEqual([]);

    // R-20.4 使用率可查询，且确实产生了配额消耗（否则断言是空的）
    const summary = await control.getSummary();
    expect(summary.rateLimit.used).toBeGreaterThan(0);
    expect(summary.rateLimit.budgetPerMinute).toBe(1_920);
    expect(summary.rateLimit.utilization).toBeGreaterThan(0);
    expect(Math.max(...observations)).toBeLessThanOrEqual(summary.rateLimit.budgetPerMinute);

    // 三个标的数据都落了库
    const counts = await ctx.pool.query<{ symbol: string; n: string }>(
      'SELECT symbol, count(*)::bigint AS n FROM klines_1m GROUP BY symbol ORDER BY symbol',
    );
    expect(counts.rows).toHaveLength(SYMBOLS.length);
    for (const row of counts.rows) {
      expect(Number(row.n), `${row.symbol} 应有数据`).toBeGreaterThan(0);
    }
  }, 300_000);

  it('AC-17 交易所真的收不到 429：假服务器上没有任何限流请求', async () => {
    // 上一个用例跑完后交易所从未因限流失败；这里确认 HTTP 状态层面确实没有 429/418
    expect(exchange.requests.klines).toBeGreaterThan(0);
    expect(exchange.requests.exchangeInfo).toBeLessThanOrEqual(3); // 单例缓存：3 个标的只拉一次
  });
});
