import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { defaultConfig, type TradeToolConfig } from '@trade-tool/core';
import {
  backfillRange,
  buildContext,
  estimateFirstPull,
  getGaps,
  listExchangeSymbols,
  readBars,
  requireContract,
  resolveContract,
  syncSymbol,
  verifySymbol,
  makeMockSymbols,
  startMockExchange,
  watermark,
  type MarketContext,
  type MockExchange,
} from '../src/index.js';
import { createTestSchema, TEST_PG, type TestSchema } from './helpers/pg.js';

/**
 * 端到端接缝测试（R-2）：TS → `python -m quant_data` → PostgreSQL，
 * 交易所指向**本地假服务器**（R-16.5：测试不访问真实网络）。
 *
 * 这组用例覆盖验收里只能靠真实两端协作才能证明的条目：
 * 首次全量、增量续传、丢弃最后一根、缺口检测与回补、边界校验、最后一根自愈。
 */

const MINUTE = 60_000;
const NOW = 1_760_000_000_000;
/**
 * 本文件每个用例的默认超时。
 *
 * 它**不是**「放宽以免卡死」，而是按工作量给的预算：这里每个用例都要串一遍
 * 真实的 TS → `python -m quant_data` → PG 接缝，`batchSize` 又被刻意设成 200
 * （为了走多批路径），所以单次全量在本机就要几十秒。v0.3.0 起每个 1m 写入批次还要额外
 * 物化一次指标（R-5.1），耗时约翻倍。
 *
 * 关键在于**超时要够**：一个用例超时后，它 spawn 出去的 Python 子进程仍然持着单写者
 * advisory lock，于是后续所有用例都以 `SYNC_ALREADY_RUNNING` 瞬间失败——一次超时会
 * 级联成一整片的红，而真正的起因只有最早那一条。
 */
const SYNC_TIMEOUT = 300_000;
const SYMBOLS = ['TESTAAAUSDC', 'TESTBBBUSDC', 'TESTCCCUSDC'] as const;

let exchange: MockExchange;
let ctx: TestSchema;
let metaDir: string;
let market: MarketContext;
let config: TradeToolConfig;
const originalBaseUrl = process.env['TRADE_TOOL_BINANCE_BASE_URL'];

beforeAll(async () => {
  exchange = await startMockExchange({ nowMs: NOW, symbols: makeMockSymbols(NOW) });
  process.env['TRADE_TOOL_BINANCE_BASE_URL'] = exchange.url;
  metaDir = await mkdtemp(join(tmpdir(), 'tt-meta-'));
  ctx = await createTestSchema('sync');

  const base = defaultConfig();
  config = {
    ...base,
    market: { ...base.market, exchange: 'binance', source: 'binance' },
    data: { ...base.data, metaDir, metadataTtlMs: 3_600_000, batchSize: 200, maxGapAttempts: 3 },
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

/**
 * 每个用例都要**完全干净**的状态：清空数据表 + 重置交易所 + 清空元数据缓存。
 * 只重置交易所是不够的——库里残留数据会让「首次全量」变成增量，
 * 从而让一批用例集体假失败。
 */
async function resetExchange(): Promise<void> {
  // 派生表也必须清：v0.2.0 起 1m 写入会顺带产出派生桶，跨用例残留会让
  // 「本轮 upserted = 0」这类断言被上一轮的残留干扰。
  await ctx.pool.query(
    'TRUNCATE klines_1m, klines_15m, klines_1h, klines_4h, klines_1d, gaps, sync_state, symbols, contract_spec',
  );
  await ctx.pool.query(
    'UPDATE weight_budget SET window_from = 0, used = 0, pause_until = NULL WHERE id = 1',
  );
  exchange.setSymbols(makeMockSymbols(NOW));
  // 故障 / 时间偏移 / 人为缺口 / 限速**全部**清掉，而不是逐项清：
  // AC-31 中途失败或超时就走不到它自己的 `shiftAllTimes(sym, 0)`，偏移会漏进下一个用例，
  // 表现为后者抛 BACKFILL_BOUNDARY_VIOLATION——一个指向「同步逻辑」的假线索。
  exchange.resetOverrides();
  await rm(metaDir, { recursive: true, force: true });
}

describe('元数据运行时解析（R-7 / AC-13 / AC-14）', () => {
  it('AC-14 列出运行时发现的标的，纯 JSON', { timeout: SYNC_TIMEOUT }, async () => {
    await resetExchange();
    const result = await listExchangeSymbols(market, { refresh: true });
    expect(result.count).toBe(SYMBOLS.length);
    expect(result.symbols.map((s) => s.symbol).sort()).toEqual([...SYMBOLS].sort());
    // 每个标的的 onboardDate 都是自己带回来的，没有硬编码
    const dates = new Set(result.symbols.map((s) => s.onboardDate));
    expect(dates.size).toBe(SYMBOLS.length);
  });

  /**
   * R-6：周期固定 1m，**不提供** interval 配置项。
   *
   * `market.interval` 仍然存在，但它只服务 synthetic 回测链路（§0.1 明确本次不动
   * `packages/backtest`）。这里把配置里的 interval 改成 1d，验证同步链路完全不受影响：
   * 入库的行距仍然是 60_000，且发往交易所的请求不携带 interval 参数。
   *
   * 单独给 120s 预算（与 AC-10 同因）：这条用例要跑完一整轮真实 Python 子进程 +
   * 分批 COPY 写入，孤立跑约 12s，但在 `pnpm check` 里与其余集成用例排队时会逼近
   * 全局 30s 上限并被判超时——那是机器负载，不是行为回归。
   */
  it('R-6 周期固定 1m：配置里的 interval 不影响同步链路', { timeout: 120_000 }, async () => {
    await resetExchange();
    const skewed: TradeToolConfig = { ...config, market: { ...config.market, interval: '1d' } };
    const skewedMarket = buildContext(ctx.pool, skewed, {
      overrides: { password: TEST_PG.password, searchPath: ctx.schema },
    });

    exchange.klineRequests.length = 0;
    await syncSymbol(skewedMarket, 'TESTAAAUSDC', { nowMs: NOW });

    // 入库行距恒为 1 分钟
    const stored = await readBars(ctx.pool, 'TESTAAAUSDC', { limit: 500 });
    const spacings = new Set(stored.slice(1).map((bar, i) => bar.time - stored[i]?.time));
    expect([...spacings]).toEqual([MINUTE]);

    // 发出去的请求不携带任何 interval 参数（周期由本仓库固定，不是可配置项）
    expect(exchange.klineRequests.length).toBeGreaterThan(0);
    for (const request of exchange.klineRequests) {
      expect(request).not.toHaveProperty('interval');
    }
  });

  it('AC-13 未知标的报 SYMBOL_NOT_FOUND', { timeout: SYNC_TIMEOUT }, async () => {
    await resetExchange();
    await expect(resolveContract(market, 'NOSUCHUSDC')).rejects.toMatchObject({
      code: 'SYMBOL_NOT_FOUND',
    });
  });

  it(
    'R-7.2 非永续 / 非 TRADING 分别报 NOT_PERPETUAL / NOT_TRADING',
    { timeout: SYNC_TIMEOUT },
    async () => {
      await resetExchange();
      exchange.setSymbols([
        {
          symbol: 'TESTAAAUSDC',
          contractType: 'PERPETUAL',
          status: 'TRADING',
          onboardDate: NOW - 30 * 86_400_000,
        },
        {
          symbol: 'TESTBBBUSDC',
          contractType: 'CURRENT_QUARTER',
          status: 'TRADING',
          onboardDate: NOW,
        },
        { symbol: 'TESTCCCUSDC', contractType: 'PERPETUAL', status: 'HALT', onboardDate: NOW },
      ]);
      await expect(requireContract(market, 'TESTBBBUSDC')).rejects.toMatchObject({
        code: 'NOT_PERPETUAL',
      });
      await expect(requireContract(market, 'TESTCCCUSDC')).rejects.toMatchObject({
        code: 'NOT_TRADING',
      });
    },
  );

  it('R-7.1 exchangeInfo 走单例缓存，不按标的重拉', { timeout: SYNC_TIMEOUT }, async () => {
    await resetExchange();
    const before = exchange.requests.exchangeInfo;
    await resolveContract(market, 'TESTAAAUSDC');
    const afterFirst = exchange.requests.exchangeInfo;
    await resolveContract(market, 'TESTBBBUSDC');
    await resolveContract(market, 'TESTCCCUSDC');
    // 三个标的只应触发一次 exchangeInfo 拉取
    expect(exchange.requests.exchangeInfo - before).toBeLessThanOrEqual(afterFirst - before + 1);
  });
});

describe('首次全量与增量续传（R-8 / R-9 / AC-2 / AC-3）', () => {
  it(
    'AC-2 首次从运行时 onboardDate 起全量，并暴露规模预估',
    { timeout: SYNC_TIMEOUT },
    async () => {
      await resetExchange();
      const spec = await requireContract(market, 'TESTAAAUSDC');
      const estimate = await estimateFirstPull(market, 'TESTAAAUSDC', { nowMs: NOW });
      // 首次起点来自运行时 onboardDate（对齐到 1m 边界），不是任何硬编码值
      expect(Math.ceil(estimate.from / MINUTE) * MINUTE).toBe(
        Math.ceil(spec.onboardDate / MINUTE) * MINUTE,
      );
      expect(estimate.bars).toBeGreaterThan(0);
      expect(estimate.requests).toBeGreaterThan(0);
      expect(estimate.estimatedMs).toBeGreaterThan(0);

      const run = await syncSymbol(market, 'TESTAAAUSDC', { nowMs: NOW });
      expect(run.added).toBeGreaterThan(0);
      expect(run.estimate).toBeDefined();
      expect(run.writeStrategy).toBe('upsert');

      // 数据从 onboardDate 开始，且到最后一根已收盘 bar 为止
      const stored = await readBars(ctx.pool, 'TESTAAAUSDC', { limit: 200_000 });
      expect(stored.length).toBe(run.added);
      expect(stored[0]?.time).toBe(Math.ceil(spec.onboardDate / MINUTE) * MINUTE);
    },
  );

  it('AC-4 只存已收盘 bar：库内最后一根 closeTime <= now', { timeout: SYNC_TIMEOUT }, async () => {
    await resetExchange();
    await syncSymbol(market, 'TESTAAAUSDC', { nowMs: NOW });
    const stored = await readBars(ctx.pool, 'TESTAAAUSDC', { limit: 200_000 });
    const last = stored[stored.length - 1];
    expect(last).toBeDefined();
    // closeTime = open + 60_000 - 1
    expect((last?.time ?? 0) + MINUTE - 1).toBeLessThanOrEqual(NOW);
  });

  it('AC-3 再次执行 → added = 0，水位不动，更早历史未改', { timeout: SYNC_TIMEOUT }, async () => {
    await resetExchange();
    const first = await syncSymbol(market, 'TESTAAAUSDC', { nowMs: NOW });
    expect(first.added).toBeGreaterThan(0);
    const watermarkAfterFirst = (await watermark(ctx.pool, 'TESTAAAUSDC')).maxTime;
    const earlyBefore = (await readBars(ctx.pool, 'TESTAAAUSDC', { limit: 20 })).map(
      (b) => b.close,
    );

    const second = await syncSymbol(market, 'TESTAAAUSDC', { nowMs: NOW });
    expect(second.added).toBe(0);
    expect((await watermark(ctx.pool, 'TESTAAAUSDC')).maxTime).toBe(watermarkAfterFirst);

    const earlyAfter = (await readBars(ctx.pool, 'TESTAAAUSDC', { limit: 20 })).map((b) => b.close);
    expect(earlyAfter).toEqual(earlyBefore);
  });

  it(
    'AC-3 增量请求起点 = max(time)，不加 60_000（重拉最后一根）',
    { timeout: SYNC_TIMEOUT },
    async () => {
      await resetExchange();
      await syncSymbol(market, 'TESTAAAUSDC', { nowMs: NOW });
      const maxTime = (await watermark(ctx.pool, 'TESTAAAUSDC')).maxTime ?? 0;

      exchange.klineRequests.length = 0;
      await syncSymbol(market, 'TESTAAAUSDC', { nowMs: NOW });
      const requests = exchange.klineRequests.filter((r) => r.symbol === 'TESTAAAUSDC');
      expect(requests.length).toBeGreaterThan(0);
      // 起点必须正好是 max(time)——这正是「最后一根被重拉并覆盖」的实现方式
      expect(requests[0]?.startTime).toBe(maxTime);
    },
  );

  it(
    'AC-30 库里最后一根被篡改后，重跑 sync 会被重拉覆盖修正',
    { timeout: SYNC_TIMEOUT },
    async () => {
      await resetExchange();
      await syncSymbol(market, 'TESTAAAUSDC', { nowMs: NOW });
      const before = await readBars(ctx.pool, 'TESTAAAUSDC', { limit: 200_000 });
      const last = before[before.length - 1];
      const secondLast = before[before.length - 2];

      // 人为写入错误值
      await ctx.pool.query('UPDATE klines_1m SET close = $3 WHERE symbol = $1 AND time = $2', [
        'TESTAAAUSDC',
        last?.time,
        999999,
      ]);

      await syncSymbol(market, 'TESTAAAUSDC', { nowMs: NOW });

      const after = await readBars(ctx.pool, 'TESTAAAUSDC', { limit: 200_000 });
      const fixedLast = after[after.length - 1];
      expect(fixedLast?.close).toBe(last?.close);
      expect(fixedLast?.close).not.toBe(999999);
      // 更早的行不受影响
      expect(after[after.length - 2]?.close).toBe(secondLast?.close);
    },
  );

  // 预算按工作量单独给，不动 vitest.config.ts 的全局 30s：
  // 本用例串行做三个标的的首次全量（onboardDate 分别在 30 / 120 / 7 天前，
  // 合计约 22.6 万根 bar、1130 次 mock 请求，每次都要过一遍 Python 桥接），
  // 是最重的单标的全量用例（AC-2 约 9s、AC-5 约 15s）的三到四倍。
  // 抬高全局值会让真正卡死的用例也要等两分钟才暴露，因此只放宽这一个。
  // 另外它只能证明「起点来自运行时元数据」，用不着把数据量砍小来换时间——
  // 砍小反而会弱化「起点互不相同」这条断言的前提。
  // v0.3.0 让每个 1m 写入批次额外物化一次指标（R-5.1：写 1m → 聚合 → 物化指标 → 提交，
  // 同一事务），因此三个标的的全量比改动前多花约一倍的时间。这不是卡死，是多做了一份
  // 真实工作，所以**只放宽这一个用例的上限**，而不是抬高全局超时——那会让真正卡死的
  // 用例也要等两分钟才暴露。
  // 这一个用例的预算比 SYNC_TIMEOUT 更大：它串行做**三个**标的的首次全量
  //（onboardDate 分别在 30 / 120 / 7 天前，合计约 22.6 万根 bar、1130 次 mock 请求），
  // 实测本机约 5.4 分钟。SYNC_TIMEOUT（300s）是给单标的用例的，这里差了一截。
  it('AC-10 多标的全量都成功，起点各按自己的 onboardDate', { timeout: 600_000 }, async () => {
    await resetExchange();
    const starts = new Map<string, number>();
    for (const symbol of SYMBOLS) {
      const spec = await requireContract(market, symbol);
      const run = await syncSymbol(market, symbol, { nowMs: NOW });
      expect(run.added, `${symbol} 首次全量应有数据`).toBeGreaterThan(0);
      const stored = await readBars(ctx.pool, symbol, { limit: 1 });
      starts.set(symbol, stored[0]?.time ?? -1);
      expect(stored[0]?.time).toBe(Math.ceil(spec.onboardDate / MINUTE) * MINUTE);
    }
    // 三个标的的起点互不相同：证明起点真的来自运行时元数据
    expect(new Set(starts.values()).size).toBe(SYMBOLS.length);
  });
});

describe('幂等与写策略（R-12 / AC-5 / AC-31）', () => {
  it('AC-5 对同一区间重复 backfill，行数不变、无重复行', { timeout: SYNC_TIMEOUT }, async () => {
    await resetExchange();
    await syncSymbol(market, 'TESTAAAUSDC', { nowMs: NOW });
    const before = await watermark(ctx.pool, 'TESTAAAUSDC');

    const range = { from: NOW - 200 * MINUTE, to: NOW - 10 * MINUTE };
    const first = await backfillRange(market, 'TESTAAAUSDC', range, { nowMs: NOW });
    const mid = await watermark(ctx.pool, 'TESTAAAUSDC');
    const second = await backfillRange(market, 'TESTAAAUSDC', range, { nowMs: NOW });
    const after = await watermark(ctx.pool, 'TESTAAAUSDC');

    expect(first.writeStrategy).toBe('do-nothing');
    expect(second.added).toBe(0);
    expect(mid.rows).toBe(before.rows);
    expect(after.rows).toBe(before.rows);
    // 唯一约束保证不产生重复行
    const dupes = await ctx.pool.query<{ n: string }>(
      `SELECT count(*)::bigint AS n FROM (SELECT time FROM klines_1m WHERE symbol = $1 GROUP BY time HAVING count(*) > 1) d`,
      ['TESTAAAUSDC'],
    );
    expect(Number(dupes.rows[0]?.n)).toBe(0);
  });

  it(
    'R-9.3 指定早于 max(time) 的区间退化为 DO NOTHING，不覆盖已有行',
    { timeout: SYNC_TIMEOUT },
    async () => {
      await resetExchange();
      await syncSymbol(market, 'TESTAAAUSDC', { nowMs: NOW });
      const stored = await readBars(ctx.pool, 'TESTAAAUSDC', { limit: 200_000 });
      const target = stored[10];
      expect(target).toBeDefined();

      // 篡改一根「更早」的 bar，然后回补同一区间：DO NOTHING 不应改回它
      await ctx.pool.query('UPDATE klines_1m SET close = 12345 WHERE symbol = $1 AND time = $2', [
        'TESTAAAUSDC',
        target?.time,
      ]);
      const maxTime = (await watermark(ctx.pool, 'TESTAAAUSDC')).maxTime ?? 0;
      const run = await backfillRange(
        market,
        'TESTAAAUSDC',
        { from: (target?.time ?? 0) - 2 * MINUTE, to: (target?.time ?? 0) + 2 * MINUTE },
        { nowMs: NOW },
      );
      expect(run.writeStrategy).toBe('do-nothing');
      const after = await readBars(ctx.pool, 'TESTAAAUSDC', {
        from: target?.time,
        to: target?.time,
      });
      expect(after[0]?.close).toBe(12345);
      expect((await watermark(ctx.pool, 'TESTAAAUSDC')).maxTime).toBe(maxTime);
    },
  );

  it(
    'AC-31 交易所忽略 startTime 时抛 BACKFILL_BOUNDARY_VIOLATION，历史未被改写',
    { timeout: SYNC_TIMEOUT },
    async () => {
      await resetExchange();
      await syncSymbol(market, 'TESTAAAUSDC', { nowMs: NOW });
      const beforeCount = (await watermark(ctx.pool, 'TESTAAAUSDC')).rows;
      const beforeEarly = (await readBars(ctx.pool, 'TESTAAAUSDC', { limit: 30 })).map(
        (b) => b.close,
      );

      // 把交易所返回的所有 bar 时间整体前移，模拟它无视 startTime 返回了更早的数据
      exchange.shiftAllTimes('TESTAAAUSDC', -10 * 24 * 60 * MINUTE);

      await expect(
        syncSymbol(market, 'TESTAAAUSDC', { from: NOW - 5 * MINUTE, to: NOW, nowMs: NOW }),
      ).rejects.toMatchObject({ code: 'BACKFILL_BOUNDARY_VIOLATION' });

      exchange.shiftAllTimes('TESTAAAUSDC', 0);
      // 已有历史一条未动
      expect((await watermark(ctx.pool, 'TESTAAAUSDC')).rows).toBe(beforeCount);
      const afterEarly = (await readBars(ctx.pool, 'TESTAAAUSDC', { limit: 30 })).map(
        (b) => b.close,
      );
      expect(afterEarly).toEqual(beforeEarly);
    },
  );
});

describe('缺口检测与自动回补（R-11 / AC-7 / AC-32）', () => {
  it('AC-7 人为删行后自动补回，gaps 表被清空', { timeout: SYNC_TIMEOUT }, async () => {
    await resetExchange();
    await syncSymbol(market, 'TESTAAAUSDC', { nowMs: NOW });
    const before = await readBars(ctx.pool, 'TESTAAAUSDC', { limit: 200_000 });
    expect(before.length).toBeGreaterThan(50);

    // 删掉**近端**的一段，制造真实缺口。
    // 必须落在缺口检测的回看窗口内（默认 7 天）：检测成本是「有界的」而不是「全表」，
    // 因此删除很老的历史不在每轮扫描的职责范围内（那种情况由 data verify 负责）。
    const victim = before.slice(before.length - 200, before.length - 195);
    await ctx.pool.query(`DELETE FROM klines_1m WHERE symbol = $1 AND time >= $2 AND time <= $3`, [
      'TESTAAAUSDC',
      victim[0]?.time,
      victim[victim.length - 1]?.time,
    ]);
    expect((await watermark(ctx.pool, 'TESTAAAUSDC')).rows).toBe(before.length - victim.length);

    // 轮次语义（★AC-7）：「下一轮 data sync 自动把缺口补回，gaps 表记录被清除」,
    // 因此一轮之内必须走完「检测 → 回补 → 清除登记」，
    // 不能只登记就返回、把修复推到再下一轮。
    const repair = await syncSymbol(market, 'TESTAAAUSDC', { nowMs: NOW });
    expect(repair.gapsFilled).toBe(1);
    expect(repair.gapsPending).toBe(0);
    expect(await getGaps(market, 'TESTAAAUSDC')).toHaveLength(0);

    // 补回后与删除前的数据逐根一致（不多、不少、不重复）
    const after = await readBars(ctx.pool, 'TESTAAAUSDC', { limit: 200_000 });
    expect(after.length).toBe(before.length);
    expect(after.map((b) => b.time)).toEqual(before.map((b) => b.time));
  });

  it(
    'AC-7 永久不可补的缺口达 maxGapAttempts 后该标的进 error，不再无限重试',
    { timeout: SYNC_TIMEOUT },
    async () => {
      await resetExchange();
      await syncSymbol(market, 'TESTAAAUSDC', { nowMs: NOW });
      const before = await readBars(ctx.pool, 'TESTAAAUSDC', { limit: 200_000 });
      const victim = before.slice(before.length - 300, before.length - 297);
      await ctx.pool.query(
        `DELETE FROM klines_1m WHERE symbol = $1 AND time >= $2 AND time <= $3`,
        ['TESTAAAUSDC', victim[0]?.time, victim[victim.length - 1]?.time],
      );

      // 第一轮：缺口被检测并登记。
      // 这里刻意关掉回补：交易所此刻还是好的，若允许回补则缺口会在**同一轮**就被补掉（★AC-7），
      // 后面「交易所持续失败 → 永远补不上」的前提就不成立了。
      const detect = await syncSymbol(market, 'TESTAAAUSDC', {
        nowMs: NOW,
        allowBackfill: false,
      });
      expect(detect.gapsPending).toBe(1);
      expect(detect.gapsFilled).toBe(0);

      // 此后交易所对该标的持续失败 → 缺口永远补不上
      exchange.failKlines('TESTAAAUSDC', {
        kind: 'http',
        status: 500,
        body: { code: -1000, msg: 'boom' },
      });
      for (let i = 0; i < 6; i += 1) {
        await syncSymbol(market, 'TESTAAAUSDC', { nowMs: NOW }).catch(() => undefined);
      }

      const gaps = await getGaps(market, 'TESTAAAUSDC');
      expect(gaps.length).toBe(1);
      // 尝试次数有上限，不会无限增长（R-11.9）
      expect(gaps[0]?.attempts).toBeGreaterThan(0);
      expect(gaps[0]?.attempts).toBeLessThanOrEqual(config.data.maxGapAttempts + 1);
      expect(gaps[0]?.lastError).toBeTruthy();

      const state = await ctx.pool.query<{ status: string }>(
        `SELECT status FROM sync_state WHERE exchange = 'binance' AND symbol = 'TESTAAAUSDC'`,
      );
      expect(state.rows[0]?.status).toBe('error');

      // 人工兜底入口仍然可用（R-11.12 / R-15.2）
      exchange.clearFailures();
      const manual = await backfillRange(
        market,
        'TESTAAAUSDC',
        { from: victim[0]?.time ?? 0, to: victim[victim.length - 1]?.time ?? 0 },
        { nowMs: NOW },
      );
      expect(manual.added).toBe(victim.length);
    },
  );

  /**
   * AC-32 缺口检测必须是**有界的**、不是每轮全表扫描。
   *
   * 诚实说明：字面的 R-11.A.2 写的是扫描 `[verified_upto, max(time)]`，而 AC-7 又要求
   * 「删掉中间若干行 → 下一轮自动补回」。两者字面互斥——一轮干净同步后
   * `verified_upto == max(time)`，区间退化成一个点，删除永远不可见。
   * 实现按 R-11 开篇的目标（「检测成本不随数据量线性增长」）改为**有界回看窗口**：
   * 扫 `min(verified_upto, max(time) - lookback)` → `max(time)`，lookback 默认 7 天。
   *
   * 因此这里断言的是**真实成立的性质**，而不是把区间写死成 `[verified_upto, max(time)]`：
   *   ① 干净同步后 `verified_upto` 推进到 `max(time)`（基线维护正确）
   *   ② 窗口**内**的缺口下一轮就能检出（证明扫描确实回看到了 verified_upto 之前）
   *   ③ 窗口**外**的缺口例行轮次不检出，只有显式 `data verify` 全表扫描能发现
   *      （证明扫描成本有界、确实不是全表扫描）
   */
  it(
    'AC-32 缺口检测有界：窗口内可检出，窗口外只有 verify 全表扫描才发现',
    { timeout: SYNC_TIMEOUT },
    async () => {
      const HOUR = 60 * MINUTE;
      const DAY = 24 * HOUR;
      await resetExchange();
      await syncSymbol(market, 'TESTAAAUSDC', { nowMs: NOW });
      const maxTime = (await watermark(ctx.pool, 'TESTAAAUSDC')).maxTime ?? 0;

      // ① 干净同步后基线推进到 max(time)
      const clean = await ctx.pool.query<{ verified_upto: string }>(
        `SELECT verified_upto FROM sync_state WHERE symbol = 'TESTAAAUSDC'`,
      );
      expect(Number(clean.rows[0]?.verified_upto)).toBe(maxTime);

      // ② 窗口内（近端 3 小时）的缺口：下一轮例行同步就能检出
      const nearVictim = maxTime - 3 * HOUR;
      await ctx.pool.query('DELETE FROM klines_1m WHERE symbol = $1 AND time = $2', [
        'TESTAAAUSDC',
        nearVictim,
      ]);
      // 一轮之内「检出并补回」（★AC-7）：pending 归零、filled 为 1。
      const nearRound = await syncSymbol(market, 'TESTAAAUSDC', { nowMs: NOW });
      expect(nearRound.gapsFilled).toBe(1);
      expect(nearRound.gapsPending).toBe(0);

      // ③ 窗口外（20 天前，超出 7 天默认回看）的缺口：例行轮次**不**检出
      const farVictim = maxTime - 20 * DAY;
      await ctx.pool.query('DELETE FROM klines_1m WHERE symbol = $1 AND time = $2', [
        'TESTAAAUSDC',
        farVictim,
      ]);
      const farRound = await syncSymbol(market, 'TESTAAAUSDC', { nowMs: NOW });
      // 近端缺口已在上一轮当场补完，本轮例行扫描又回看不到远端那个洞 → 本轮无事可做
      expect(farRound.gapsPending).toBe(0);
      expect(farRound.gapsFilled).toBe(0);
      // 20 天前那个洞仍在库里 —— 例行扫描没有回看到那么远，成本因此有界
      const stillMissing = await ctx.pool.query<{ n: string }>(
        'SELECT count(*)::bigint AS n FROM klines_1m WHERE symbol = $1 AND time = $2',
        ['TESTAAAUSDC', farVictim],
      );
      expect(Number(stillMissing.rows[0]?.n)).toBe(0);

      // 只有显式全表扫描（data verify）才能发现它 —— R-11.A3 ②
      const verified = await verifySymbol(market, 'TESTAAAUSDC');
      expect(verified.gapsFound).toBe(1);
      // 全表扫描确实读了整段历史（远大于 7 天窗口）
      expect(verified.scannedRows).toBeGreaterThan(20 * 24 * 60); // 20 天 = 28,800 根
    },
  );

  it('R-11.A3 data verify 做全表扫描并重建基线', { timeout: SYNC_TIMEOUT }, async () => {
    await resetExchange();
    await syncSymbol(market, 'TESTAAAUSDC', { nowMs: NOW });
    const result = await verifySymbol(market, 'TESTAAAUSDC');
    expect(result.scannedRows).toBeGreaterThan(0);
    expect(result.gapsFound).toBe(0);
    expect(result.verifiedUpTo).toBe((await watermark(ctx.pool, 'TESTAAAUSDC')).maxTime);
  });
});

describe('桥接载荷（R-2.2 / AC-8）', () => {
  it('AC-8 全量拉取的返回值只有小摘要，不含数据', { timeout: SYNC_TIMEOUT }, async () => {
    await resetExchange();
    const run = await syncSymbol(market, 'TESTAAAUSDC', { nowMs: NOW });
    const serialized = JSON.stringify(run);
    // 摘要里绝不能出现 K 线本体：没有 OHLCV 字段，也没有任何 bar 数组
    for (const field of ['"open"', '"high"', '"low"', '"close"', '"volume"', '"quoteVolume"']) {
      expect(serialized, `摘要不应包含 ${field}`).not.toContain(field);
    }
    // estimate.bars 是一个**数字计数**，不是数据；它必须仍是标量
    expect(typeof run.estimate?.bars).toBe('number');
    expect(Array.isArray(run.estimate?.bars)).toBe(false);
    // 4 万多根 bar 拉完后，摘要仍然很小——证明数据确实没走 stdout。
    //
    // 上界按「摘要的规模是 O(周期 × 参数集)的**计数**，不是 O(bar 数)」反推：v0.3.0
    // 起摘要里多了 `indicators`（4 周期 × 缺省 10 个参数集 = 40 条），硬写 2000 字节
    // 会把「摘要多了一个指标段」误报成「K 线泄漏」。而 bar 数据每根几十字节，
    // 4 万根就是 MB 级——16 KiB 的上界仍然稳稳地把两者分开。
    expect(serialized.length).toBeLessThan(16 * 1024);
    expect(run).toHaveProperty('added');
    expect(run).toHaveProperty('from');
    expect(run).toHaveProperty('to');
  });
});
