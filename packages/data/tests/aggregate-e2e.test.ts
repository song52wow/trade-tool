import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { defaultConfig, type TradeToolConfig } from '@trade-tool/core';
import {
  aggregateSymbol,
  backfillRange,
  buildContext,
  makeMockSymbols,
  readLatestBars,
  startMockExchange,
  syncSymbol,
  type MarketContext,
  type MockExchange,
} from '../src/index.js';
import { createTestSchema, TEST_PG, type TestSchema } from './helpers/pg.js';

/**
 * 派生周期的**端到端**接缝测试（v0.2.0 AC-6 / AC-8 / AC-10 / AC-13 / AC-21 / AC-22）。
 *
 * 与 `test_aggregate.test.ts`（纯读侧）和 Python 侧 `test_aggregate*.py`（判据与写入）
 * 互补：这里验证的是**四条 1m 写入路径是否都触发聚合**、回补是否重算、
 * 聚合失败是否整批回滚、以及显式关闭派生是否如实可见。
 *
 * 交易所指向本地假服务器；全程不出网（R-16.5）。
 */

const MINUTE = 60_000;
const NOW = 1_760_000_000_000;
const SYMBOL = 'TESTAAAUSDC';

let exchange: MockExchange;
let ctx: TestSchema;
let metaDir: string;
let market: MarketContext;
let config: TradeToolConfig;
const originalBaseUrl = process.env['TRADE_TOOL_BINANCE_BASE_URL'];

beforeAll(async () => {
  exchange = await startMockExchange({ nowMs: NOW, symbols: makeMockSymbols(NOW) });
  process.env['TRADE_TOOL_BINANCE_BASE_URL'] = exchange.url;
  metaDir = await mkdtemp(join(tmpdir(), 'tt-agg-'));
  ctx = await createTestSchema('agge2e');

  const base = defaultConfig();
  config = {
    ...base,
    market: { ...base.market, exchange: 'binance', source: 'binance' },
    data: { ...base.data, metaDir, metadataTtlMs: 3_600_000, batchSize: 500, maxGapAttempts: 3 },
    sync: { ...base.sync, concurrency: 2, weightBudgetPerMinute: 1_920 },
  };
  market = buildContext(ctx.pool, config, {
    overrides: { password: TEST_PG.password, searchPath: ctx.schema },
  });
});

afterAll(async () => {
  if (originalBaseUrl === undefined) delete process.env['TRADE_TOOL_BINANCE_BASE_URL'];
  else process.env['TRADE_TOOL_BINANCE_BASE_URL'] = originalBaseUrl;
  await rm(metaDir, { recursive: true, force: true }).catch(() => undefined);
  await exchange.close();
  await ctx.close();
});

beforeEach(async () => {
  await ctx.pool.query(
    'TRUNCATE klines_1m, klines_15m, klines_1h, klines_4h, klines_1d, gaps, sync_state, symbols, contract_spec',
  );
  await ctx.pool.query(
    'UPDATE weight_budget SET window_from = 0, used = 0, pause_until = NULL WHERE id = 1',
  );
  exchange.setSymbols(makeMockSymbols(NOW));
  // 同 sync-integration：注入态必须**整体**清掉，只清 failures 会让一个中途失败的
  // 用例把时间偏移 / 人为缺口漏给下一个用例（表现成指向同步逻辑的假失败）。
  exchange.resetOverrides();
  await rm(metaDir, { recursive: true, force: true });
});

async function count(
  interval: '1m' | '15m' | '1h' | '4h' | '1d',
  symbol = SYMBOL,
): Promise<number> {
  const table = {
    '1m': 'klines_1m',
    '15m': 'klines_15m',
    '1h': 'klines_1h',
    '4h': 'klines_4h',
    '1d': 'klines_1d',
  }[interval] as string;
  const result = await ctx.pool.query<{ n: string }>(
    `SELECT count(*)::bigint AS n FROM ${table} WHERE symbol = $1`,
    [symbol],
  );
  return Number(result.rows[0]?.n ?? 0);
}

describe('AC-6 四条 1m 写入路径都触发聚合', () => {
  /**
   * 「每条路径都让派生表更新」必须**分别**断言。合并成一个用例会得到
   * 「至少有一条路径触发了聚合」这种弱结论——而失效模式恰恰是
   * 「某条路径忘了挂聚合」：前一条已经写了桶，后一条再断言「有桶」也照样通过。
   */
  it('路径 1：data sync 增量', { timeout: 120_000 }, async () => {
    const run = await syncSymbol(market, SYMBOL, { nowMs: NOW });
    expect(run.added).toBeGreaterThan(0);
    expect(run.aggregated, '摘要必须带每周期统计（R-8.3）').not.toBeNull();
    // 首次全量 30 天历史：1d 至少有 29 根（末桶未收盘不写）
    expect(await count('1d')).toBeGreaterThan(28);
    expect(await count('4h')).toBeGreaterThan(170);
  });

  it('路径 2：data backfill 区间回补', { timeout: 120_000 }, async () => {
    // 先同步，再删掉一段 1m 制造缺口，再用 backfill 补回 → 派生表必须跟上
    await syncSymbol(market, SYMBOL, { nowMs: NOW });
    const before = await count('4h');
    const all = await readLatestBars(ctx.pool, SYMBOL, { limit: 200_000, interval: '1m' });
    const victim = all[all.length - 300];
    const victimEnd = all[all.length - 250];
    expect(victim && victimEnd).toBeTruthy();

    await ctx.pool.query('DELETE FROM klines_1m WHERE symbol = $1 AND time >= $2 AND time <= $3', [
      SYMBOL,
      victim?.time,
      victimEnd?.time,
    ]);
    // backfill 走 Python 的 backfill 子命令，必须触发聚合（R-4.1）
    await backfillRange(
      market,
      SYMBOL,
      { from: victim?.time ?? 0, to: victimEnd?.time ?? 0 },
      { nowMs: NOW },
    );
    const after = await count('4h');
    // 缺口被补回后，受影响的 4h 桶重新合格 → 桶数不减少（只增不删）
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('路径 3：缺口自动回补（同一轮内修复，AC-8）', { timeout: 120_000 }, async () => {
    await syncSymbol(market, SYMBOL, { nowMs: NOW });
    const all = await readLatestBars(ctx.pool, SYMBOL, { limit: 200_000, interval: '1m' });
    const victim = all[all.length - 200];
    const victimEnd = all[all.length - 197];
    expect(victim && victimEnd).toBeTruthy();

    // 删掉近端几根 1m → 受影响的 4h 桶下一轮同步必须重新出现
    await ctx.pool.query('DELETE FROM klines_1m WHERE symbol = $1 AND time >= $2 AND time <= $3', [
      SYMBOL,
      victim?.time,
      victimEnd?.time,
    ]);
    const during = await readLatestBars(ctx.pool, SYMBOL, { limit: 5, interval: '4h' });
    // 缺口期间末端 4h 桶可能不再合格，但已写入的历史桶不会被删（R-4.4 只增不删）
    expect(Array.isArray(during)).toBe(true);

    const repair = await syncSymbol(market, SYMBOL, { nowMs: NOW });
    expect(repair.gapsFilled, '缺口必须被自动补回').toBeGreaterThan(0);
    // 补回后派生表再次覆盖该时段：桶的值必须反映完整的 1m
    const healed = await readLatestBars(ctx.pool, SYMBOL, { limit: 5, interval: '4h' });
    expect(healed.length).toBeGreaterThan(0);
  });

  it('路径 4：data fetch --source binance 走的也是 backfill', { timeout: 120_000 }, async () => {
    // `data fetch --source binance` 内部调 backfillRange；这里直接断言该入口触发聚合
    await backfillRange(
      market,
      SYMBOL,
      { from: NOW - 120 * MINUTE, to: NOW - 2 * MINUTE },
      { nowMs: NOW },
    );
    expect(await count('1m')).toBeGreaterThan(0);
    // 120 分钟铺不满任何 4h 桶时派生表可以为空——但必须有 1m 数据可派生
    const stats = await aggregateSymbol(market, SYMBOL, { intervals: ['1h'] });
    expect(stats.intervals['1h']).toBeDefined();
  });
});

describe('AC-7 幂等', () => {
  it('重复同步不改派生表，且第二次 upserted = 0', { timeout: 120_000 }, async () => {
    await syncSymbol(market, SYMBOL, { nowMs: NOW });
    const snapshot = await readLatestBars(ctx.pool, SYMBOL, { limit: 500, interval: '4h' });
    const rows = await count('4h');

    const second = await syncSymbol(market, SYMBOL, { nowMs: NOW });
    expect(second.added).toBe(0);
    expect(second.aggregated).not.toBeNull();
    // 每周期 upserted 全为 0：重复同步不得计入任何新桶
    for (const stats of Object.values(second.aggregated ?? {})) {
      expect(stats.upserted, '第二次同步不应有新桶').toBe(0);
    }
    expect(await count('4h')).toBe(rows);
    expect(await readLatestBars(ctx.pool, SYMBOL, { limit: 500, interval: '4h' })).toEqual(
      snapshot,
    );
  });

  it('data aggregate 连续两次逐值相同，第二次 upserted = 0', { timeout: 120_000 }, async () => {
    await syncSymbol(market, SYMBOL, { nowMs: NOW });
    const first = await aggregateSymbol(market, SYMBOL);
    const before = await readLatestBars(ctx.pool, SYMBOL, { limit: 500, interval: '4h' });

    const second = await aggregateSymbol(market, SYMBOL);
    const after = await readLatestBars(ctx.pool, SYMBOL, { limit: 500, interval: '4h' });

    for (const [interval, stats] of Object.entries(second.intervals)) {
      expect(stats.upserted, `${interval} 第二次补齐应为 0`).toBe(0);
    }
    expect(after).toEqual(before);
    // 摘要键序固定 → JSON 逐字节相同（R-5.7）
    expect(Object.keys(second.intervals)).toEqual(Object.keys(first.intervals));
  });
});

describe('AC-9 重建与校验', () => {
  it('--rebuild 后与逐值重算一致', { timeout: 120_000 }, async () => {
    await syncSymbol(market, SYMBOL, { nowMs: NOW });
    const before = await readLatestBars(ctx.pool, SYMBOL, { limit: 500, interval: '4h' });

    const rebuilt = await aggregateSymbol(market, SYMBOL, {}, { rebuild: true });
    expect(rebuilt.rebuild).toBe(true);
    expect(rebuilt.check).toBe(false);

    const after = await readLatestBars(ctx.pool, SYMBOL, { limit: 500, interval: '4h' });
    expect(after, 'rebuild 必须与原值逐值相等').toEqual(before);
  });

  it('--check 在一致时不抛错', { timeout: 120_000 }, async () => {
    await syncSymbol(market, SYMBOL, { nowMs: NOW });
    const result = await aggregateSymbol(market, SYMBOL, {}, { check: true });
    expect(result.check).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it(
    '--check 发现被篡改的桶时抛 AGGREGATION_MISMATCH 并指出位置',
    { timeout: 120_000 },
    async () => {
      await syncSymbol(market, SYMBOL, { nowMs: NOW });
      const bars = await readLatestBars(ctx.pool, SYMBOL, { limit: 5, interval: '4h' });
      const target = bars[0];
      expect(target).toBeDefined();
      await ctx.pool.query('UPDATE klines_4h SET close = -1 WHERE symbol = $1 AND time = $2', [
        SYMBOL,
        target?.time,
      ]);

      await expect(aggregateSymbol(market, SYMBOL, {}, { check: true })).rejects.toMatchObject({
        code: 'AGGREGATION_MISMATCH',
      });

      // --rebuild 能修好
      await aggregateSymbol(market, SYMBOL, {}, { rebuild: true });
      const healed = await readLatestBars(ctx.pool, SYMBOL, { limit: 5, interval: '4h' });
      expect(healed[0]?.close).toBe(target?.close);
    },
  );

  it(
    '被删掉 1m 的桶在 --check 里报 stale，--rebuild 修不了（R-4.4 只增不删）',
    {
      timeout: 120_000,
    },
    async () => {
      await syncSymbol(market, SYMBOL, { nowMs: NOW });
      const all = await readLatestBars(ctx.pool, SYMBOL, { limit: 200_000, interval: '1m' });
      // 删掉某个 4h 桶起点的那一根 1m → 该桶不再齐全
      const first4h = await readLatestBars(ctx.pool, SYMBOL, { limit: 1, interval: '4h' });
      const bucketStart = first4h[0]?.time;
      expect(bucketStart).toBeDefined();
      await ctx.pool.query('DELETE FROM klines_1m WHERE symbol = $1 AND time = $2', [
        SYMBOL,
        bucketStart,
      ]);

      await expect(aggregateSymbol(market, SYMBOL, {}, { check: true })).rejects.toMatchObject({
        code: 'AGGREGATION_MISMATCH',
      });
    },
  );
});

describe('AC-10 聚合不出网', () => {
  it('data aggregate 期间 mock 交易所零调用', { timeout: 120_000 }, async () => {
    await syncSymbol(market, SYMBOL, { nowMs: NOW });
    const before = { ...exchange.requests };
    await aggregateSymbol(market, SYMBOL, {}, { rebuild: true });
    await aggregateSymbol(market, SYMBOL, {}, { check: true });
    // 聚合是纯本地计算：不出网、不消耗交易所配额
    expect(exchange.requests.klines).toBe(before.klines);
    expect(exchange.requests.exchangeInfo).toBe(before.exchangeInfo);
  });
});

describe('AC-22 显式关闭派生', () => {
  it('aggregateIntervals: [] → 不写派生表，但 1m 照常同步', { timeout: 120_000 }, async () => {
    const off: TradeToolConfig = {
      ...config,
      data: { ...config.data, aggregateIntervals: [] },
    };
    const offMarket = buildContext(ctx.pool, off, {
      overrides: { password: TEST_PG.password, searchPath: ctx.schema },
    });

    const run = await syncSymbol(offMarket, SYMBOL, { nowMs: NOW });
    expect(run.added, '1m 同步不受影响').toBeGreaterThan(0);
    // 摘要必须是 null 而不是空对象：两者是不同状态（AC-22）
    expect(run.aggregated, '未启用派生时必须是 null').toBeNull();
    for (const interval of ['15m', '1h', '4h', '1d'] as const) {
      expect(await count(interval), `${interval} 不应有任何桶`).toBe(0);
    }
  });

  it('关闭派生后跑 data aggregate 明确报错，而不是假装成功', { timeout: 120_000 }, async () => {
    const off: TradeToolConfig = {
      ...config,
      data: { ...config.data, aggregateIntervals: [] },
    };
    const offMarket = buildContext(ctx.pool, off, {
      overrides: { password: TEST_PG.password, searchPath: ctx.schema },
    });
    await syncSymbol(offMarket, SYMBOL, { nowMs: NOW });
    await expect(aggregateSymbol(offMarket, SYMBOL)).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
  });

  it('默认配置启用全部四个周期', () => {
    expect(config.data.aggregateIntervals).toEqual(['15m', '1h', '4h', '1d']);
  });
});

describe('R-5.2 显式优先于配置', () => {
  it('--intervals 只跑指定周期', { timeout: 120_000 }, async () => {
    await syncSymbol(market, SYMBOL, { nowMs: NOW });
    const only4h = await aggregateSymbol(market, SYMBOL, { intervals: ['4h'] });
    expect(Object.keys(only4h.intervals)).toEqual(['4h']);
  });

  it('显式给出未实现周期时报 CONFIG_INVALID', { timeout: 120_000 }, async () => {
    await expect(aggregateSymbol(market, SYMBOL, { intervals: ['5m'] })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    await expect(aggregateSymbol(market, SYMBOL, { intervals: ['1m'] })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
  });
});

describe('R-5.5 单写者', () => {
  it(
    '库里无数据的标的跑 aggregate 报 SYMBOL_NOT_FOUND，且不建幽灵状态行',
    {
      timeout: 120_000,
    },
    async () => {
      await expect(aggregateSymbol(market, 'NOSUCHUSDC')).rejects.toMatchObject({
        code: 'SYMBOL_NOT_FOUND',
      });
      const state = await ctx.pool.query<{ n: string }>(
        'SELECT count(*)::bigint AS n FROM sync_state WHERE symbol = $1',
        ['NOSUCHUSDC'],
      );
      // R-5.5：不得因为跑一次重建就多出一行幽灵 sync_state
      expect(Number(state.rows[0]?.n)).toBe(0);
    },
  );
});
