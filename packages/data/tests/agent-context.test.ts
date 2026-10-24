import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { defaultConfig, SyncError, type TradeToolConfig } from '@trade-tool/core';
import {
  buildContext,
  loadAgentContext,
  makeMockSymbols,
  startMockExchange,
  type MarketContext,
  type MockExchange,
  type MockSentimentSpec,
} from '../src/index.js';
import { createTestSchema, TEST_PG, type TestSchema } from './helpers/pg.js';

/**
 * 分析师 Agent 的**行情上下文**端到端测试（v1.0.0）。
 *
 * 验的是那条**此前只在替身里跑过**的链路：
 *
 * ```
 * PG 里的派生 K 线 ─┐
 * 假交易所的情绪面 ─┼→ python -m quant_data market-context（**真实 Python 引擎**）
 * 库里的合约规格  ─┘        ↓ stdout 的单个 JSON
 *                    zod 契约校验 → core 的纯映射 → 喂给模型的分析上下文
 * ```
 *
 * 中间任何一环形状对不上，症状都**不会报错**：载荷是拼进提示词的字符串，
 * 字段名一改，模型收到的就是「ATR: undefined」——它照样会给出一个看起来合理的结论。
 * 那是这个仓库最忌讳的一种失败：「看起来成功了，其实什么都没做」。
 *
 * 全程不出网：交易所指向本地假服务器（`TRADE_TOOL_BINANCE_BASE_URL`），
 * Python 子进程继承同一份环境变量。
 */

const HOUR = 3_600_000;
/** 固定时刻：让「最后一段连续 K 线」的边界可预期。 */
const NOW = 1_760_000_000_000;
const SYMBOL = 'TESTAAAUSDC';

const SENTIMENT: MockSentimentSpec = {
  markPrice: 100.5,
  indexPrice: 100,
  lastFundingRate: 0.0001,
  nextFundingTime: NOW + 4 * HOUR,
  openInterest: 1_234.5,
  openInterestHistory: [1_000, 1_100, 1_234.5],
  longShortRatio: 1.5,
  buySellRatio: 1.2,
  quoteVolume: 987_654,
  trades: 4_321,
  priceChangePercent: 2.5,
};

let exchange: MockExchange;
let ctx: TestSchema;
let metaDir: string;
let market: MarketContext;
let config: TradeToolConfig;
const originalBaseUrl = process.env['TRADE_TOOL_BINANCE_BASE_URL'];

/** 往 `klines_1h` 写连续的一小时 K 线。 */
async function insertHourlyBars(count: number, base = 100): Promise<void> {
  const lastOpen = Math.floor(NOW / HOUR) * HOUR - HOUR;
  for (let i = 0; i < count; i += 1) {
    const time = lastOpen - (count - 1 - i) * HOUR;
    // 缓慢上行 + 轻微波动：ATR 为正、均线多头，指标才有意义
    const close = base + i * 0.5;
    await ctx.pool.query(
      `INSERT INTO klines_1h (symbol, time, open, high, low, close, volume, quote_volume, trades)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (symbol, time) DO NOTHING`,
      [SYMBOL, time, close - 0.2, close + 0.6, close - 0.8, close, 100 + i, close * 200, 50 + i],
    );
  }
}

/** 写一条合约规格快照（`raw` 是 exchangeInfo 里那一条，含 filters）。 */
async function insertContractSpec(): Promise<void> {
  await ctx.pool.query(
    `INSERT INTO contract_spec (exchange, symbol, contract_type, status, onboard_date, raw, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (exchange, symbol) DO NOTHING`,
    [
      'binance',
      SYMBOL,
      'PERPETUAL',
      'TRADING',
      NOW - 30 * 24 * HOUR,
      JSON.stringify({
        symbol: SYMBOL,
        contractType: 'PERPETUAL',
        status: 'TRADING',
        onboardDate: NOW - 30 * 24 * HOUR,
        filters: [
          { filterType: 'PRICE_FILTER', tickSize: '0.01000000' },
          { filterType: 'LOT_SIZE', stepSize: '0.00100000', minQty: '0.00100000' },
          { filterType: 'MIN_NOTIONAL', notional: '5.00000000' },
        ],
      }),
      NOW,
    ],
  );
}

beforeAll(async () => {
  exchange = await startMockExchange({
    nowMs: NOW,
    symbols: makeMockSymbols(NOW),
    sentiment: SENTIMENT,
  });
  process.env['TRADE_TOOL_BINANCE_BASE_URL'] = exchange.url;
  metaDir = await mkdtemp(join(tmpdir(), 'tt-agentctx-'));
  ctx = await createTestSchema('agentctx');

  const base = defaultConfig();
  config = {
    ...base,
    market: { ...base.market, exchange: 'binance', source: 'binance' },
    data: { ...base.data, metaDir, metadataTtlMs: 3_600_000 },
    sync: { ...base.sync, weightBudgetPerMinute: 1_920 },
  };
  market = buildContext(ctx.pool, config, {
    overrides: { password: TEST_PG.password, searchPath: ctx.schema },
  });

  await insertHourlyBars(120);
  await insertContractSpec();
});

afterAll(async () => {
  if (originalBaseUrl === undefined) delete process.env['TRADE_TOOL_BINANCE_BASE_URL'];
  else process.env['TRADE_TOOL_BINANCE_BASE_URL'] = originalBaseUrl;
  await rm(metaDir, { recursive: true, force: true }).catch(() => undefined);
  await exchange.close();
  await ctx.close();
});

describe('loadAgentContext（真实 Python 引擎 + 真实 PG）', () => {
  it('技术面：ATR 为正、均线有值、客观倾向分在 [-1, 1]', async () => {
    const result = await loadAgentContext(market, {
      symbol: SYMBOL,
      interval: '1h',
      bars: 120,
    });

    expect(result.context.technical.atr).toBeGreaterThan(0);
    expect(result.context.technical.atrPeriod).toBeGreaterThan(0);
    expect(result.context.technical.lastClose).toBeGreaterThan(0);
    expect(result.context.technical.ma.length).toBeGreaterThan(0);
    expect(result.context.technical.objectiveBias).toBeGreaterThanOrEqual(-1);
    expect(result.context.technical.objectiveBias).toBeLessThanOrEqual(1);
    // 上下文里的数据时刻就是最后一段连续 K 线的末尾
    expect(result.context.asOfMs).toBeGreaterThan(0);
  });

  it('情绪面：资金费率、基差、持仓量、多空比都对得上假交易所给的值', async () => {
    const result = await loadAgentContext(market, {
      symbol: SYMBOL,
      interval: '1h',
      bars: 120,
    });

    const s = result.context.sentiment;
    expect(s.fundingRate).toBeCloseTo(0.0001, 10);
    expect(s.markPrice).toBeCloseTo(100.5, 6);
    expect(s.indexPrice).toBeCloseTo(100, 6);
    // 基差 = (标记价 − 指数价) / 指数价 × 10000 = 50 个基点
    expect(s.basisBps).toBeCloseTo(50, 3);
    expect(s.openInterest).toBeCloseTo(1_234.5, 6);
    expect(s.longShortRatio).toBeCloseTo(1.5, 6);
    expect(s.takerBuySellRatio).toBeCloseTo(1.2, 6);
    // 有数据就不该降级
    expect(result.degraded).toBe(false);
  });

  it('基本面：合约规格取自库里的快照，不是实时拉的', async () => {
    const result = await loadAgentContext(market, {
      symbol: SYMBOL,
      interval: '1h',
      bars: 120,
    });

    expect(result.context.fundamental.tickSize).toBe(0.01);
    expect(result.context.fundamental.stepSize).toBe(0.001);
    expect(result.context.fundamental.minQty).toBe(0.001);
    expect(result.context.fundamental.contractType).toBe('PERPETUAL');
    expect(result.context.fundamental.onboardDateMs).toBe(NOW - 30 * 24 * HOUR);
    expect(result.context.fundamental.quoteVolume24h).toBeCloseTo(987_654, 6);
  });

  it('情绪面取不到时：降级但可见（degraded=true + notes），**不是 0 冒充**', async () => {
    exchange.setSentiment(null);
    try {
      const result = await loadAgentContext(market, {
        symbol: SYMBOL,
        interval: '1h',
        bars: 120,
      });

      expect(result.degraded).toBe(true);
      expect(result.context.sentiment.notes.length).toBeGreaterThan(0);
      // 关键：缺项是 null，**不是 0**——「资金费率是 0」与「没取到」是两件事
      expect(result.context.sentiment.fundingRate).toBeNull();
      expect(result.context.sentiment.openInterest).toBeNull();
      expect(result.context.sentiment.longShortRatio).toBeNull();
      // 技术面照常有值：情绪面缺项不该把整轮分析带崩
      expect(result.context.technical.atr).toBeGreaterThan(0);
    } finally {
      exchange.setSentiment(SENTIMENT);
    }
  });

  it('库里没有合约规格：报错并说清怎么修（不是拿默认值顶替）', async () => {
    await ctx.pool.query('DELETE FROM contract_spec WHERE symbol = $1', ['TESTBBBUSDC']);
    await expect(
      loadAgentContext(market, { symbol: 'TESTBBBUSDC', interval: '1h', bars: 120 }),
    ).rejects.toMatchObject({
      code: 'AGENT_CONTEXT_UNAVAILABLE',
    });
  });

  it('派生 K 线为空：技术面缺失直接报错（不是降级）', async () => {
    await expect(
      loadAgentContext(market, { symbol: 'TESTCCCUSDC', interval: '1h', bars: 120 }),
    ).rejects.toMatchObject({
      code: 'AGENT_CONTEXT_UNAVAILABLE',
    });
  });

  it('周期不在白名单：报错并说清支持哪些', async () => {
    await expect(
      loadAgentContext(market, { symbol: SYMBOL, interval: '1m', bars: 120 }),
    ).rejects.toThrowError(/派生周期|15m/);
  });

  it('Python 侧的错误码能被 TS 侧原样接住（跨语言契约的一一对应）', async () => {
    const error = await loadAgentContext(market, {
      symbol: 'TESTCCCUSDC',
      interval: '1h',
      bars: 120,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyncError);
    expect((error as SyncError).code).toBe('AGENT_CONTEXT_UNAVAILABLE');
  });
});
