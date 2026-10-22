import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { defaultConfig, type AgentConfig, type TradeToolConfig } from '@trade-tool/core';
import {
  buildContext,
  createLlmClient,
  listTradingPlans,
  makeMockSymbols,
  readLatestAnalystReport,
  readLatestTradingPlan,
  startMockExchange,
  type MarketContext,
  type MockExchange,
  type MockSentimentSpec,
} from '@trade-tool/data';

import { createAgentService } from '../src/service.js';
import { createTestSchema, TEST_PG, type TestSchema } from './helpers/pg.js';

/**
 * 分析师 + 交易员 Agent 的**端到端**测试（v1.0.0）。
 *
 * 这一组把整条链路都用**真东西**跑一遍——之前它只在替身里跑过：
 *
 * ```
 * PG（真库，真迁移）── 派生 K 线 ──┐
 * 假交易所（真 HTTP）── 情绪面  ──┼→ python -m quant_data market-context（真 Python 引擎）
 * 假模型服务（真 HTTP，OpenAI 协议）──→ createLlmClient → 提示词 → 解析 → 纯函数算方案
 *                                     ↓
 *                          analyst_report / trading_plan（真 SQL、真 CHECK 约束）
 * ```
 *
 * 它能抓到替身抓不到的那类问题：**接口对不上**。
 * 模型的回包形状、Python 的 stdout 形状、PG 的列名——三者任意一个对不上，
 * 症状都是「方案里某个字段是空的」，而替身版测试照样绿。
 */

const HOUR = 3_600_000;
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

/** 分析师的模型输出：三个面都看多。 */
const ANALYST_OUTPUT = {
  technical: { score: 0.8, notes: ['均线多头排列', 'MACD 在零轴上方'] },
  sentiment: { score: 0.4, notes: ['资金费率为正，多头付钱'] },
  fundamental: { score: 0.1, notes: ['流动性充足'] },
  confidence: 0.8,
  stopAtrMult: 2,
  takeProfitAtrMult: 3,
  rationale: '趋势、情绪、基本面同向偏多。',
};

/** 交易员的模型输出：市价做多，冒 1% 的险。 */
const TRADER_OUTPUT = {
  side: 'BUY',
  entryType: 'market',
  entryOffsetAtrMult: 0,
  riskFraction: 0.01,
  stopAtrMult: 2,
  takeProfitAtrMult: 3,
  rationale: '顺势进场，止损 2 倍 ATR。',
};

let exchange: MockExchange;
let llmServer: Server;
let llmUrl: string;
let ctx: TestSchema;
let metaDir: string;
let market: MarketContext;
let config: TradeToolConfig;
let agentConfig: AgentConfig;
const originalBaseUrl = process.env['TRADE_TOOL_BINANCE_BASE_URL'];

/** 收到的提示词，用来断言「真的问对了模型」。 */
const prompts: string[] = [];

/** 起一个 OpenAI 兼容的假模型服务。按提示词内容区分分析师与交易员。 */
async function startFakeLlm(): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      const parsed = JSON.parse(body) as { messages?: { content?: string }[] };
      const prompt = parsed.messages?.[parsed.messages.length - 1]?.content ?? '';
      prompts.push(prompt);
      const content = prompt.includes('交易员')
        ? JSON.stringify(TRADER_OUTPUT)
        : JSON.stringify(ANALYST_OUTPUT);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content } }],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1`, server };
}

async function insertHourlyBars(count: number): Promise<void> {
  const lastOpen = Math.floor(NOW / HOUR) * HOUR - HOUR;
  for (let i = 0; i < count; i += 1) {
    const time = lastOpen - (count - 1 - i) * HOUR;
    const close = 100 + i * 0.5;
    await ctx.pool.query(
      `INSERT INTO klines_1h (symbol, time, open, high, low, close, volume, quote_volume, trades)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [SYMBOL, time, close - 0.2, close + 0.6, close - 0.8, close, 100 + i, close * 200, 50 + i],
    );
  }
}

async function insertContractSpec(): Promise<void> {
  await ctx.pool.query(
    `INSERT INTO contract_spec (exchange, symbol, contract_type, status, onboard_date, raw, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
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

  const fake = await startFakeLlm();
  llmServer = fake.server;
  llmUrl = fake.url;

  metaDir = await mkdtemp(join(tmpdir(), 'tt-agentint-'));
  ctx = await createTestSchema('agentint');

  const base = defaultConfig();
  config = {
    ...base,
    market: { ...base.market, exchange: 'binance', source: 'binance' },
    data: { ...base.data, metaDir, metadataTtlMs: 3_600_000 },
    sync: { ...base.sync, weightBudgetPerMinute: 1_920 },
  };
  agentConfig = {
    ...base.agent,
    enabled: true,
    interval: '1h',
    bars: 120,
    weights: { technical: 1, sentiment: 1, fundamental: 0.5 },
    neutralBand: 0.2,
    risk: {
      maxRiskFraction: 0.01,
      maxNotional: 0,
      minRiskReward: 1.5,
      neutralRiskFactor: 0.5,
    },
    llm: {
      ...base.agent.llm,
      enabled: true,
      baseUrl: llmUrl,
      model: 'fake-model',
      apiKeyEnv: 'TRADE_TOOL_TEST_LLM_KEY',
      timeoutMs: 5_000,
      fallbackToTrade: true,
    },
    equitySource: 'config',
    equity: 10_000,
  };
  // 假模型服务的密钥：只经环境变量给，**不进配置文件**（AGENTS.md 约定 2）。
  process.env['TRADE_TOOL_TEST_LLM_KEY'] = 'test-key-not-a-real-secret';

  market = buildContext(ctx.pool, config, {
    overrides: { password: TEST_PG.password, searchPath: ctx.schema },
  });

  await insertHourlyBars(120);
  await insertContractSpec();
});

afterAll(async () => {
  delete process.env['TRADE_TOOL_TEST_LLM_KEY'];
  if (originalBaseUrl === undefined) delete process.env['TRADE_TOOL_BINANCE_BASE_URL'];
  else process.env['TRADE_TOOL_BINANCE_BASE_URL'] = originalBaseUrl;
  await rm(metaDir, { recursive: true, force: true }).catch(() => undefined);
  await new Promise<void>((resolve) => llmServer.close(() => resolve()));
  await exchange.close();
  await ctx.close();
});

describe('Agent 端到端（真 PG + 真 Python + 真 HTTP 模型）', () => {
  it('一轮跑完：报告与方案都真的落库，且方案的价与数量是程序算的', async () => {
    const llm = createLlmClient({
      baseUrl: agentConfig.llm.baseUrl,
      model: agentConfig.llm.model,
      apiKeyEnv: agentConfig.llm.apiKeyEnv,
      timeoutMs: agentConfig.llm.timeoutMs,
    });
    const service = createAgentService({
      ctx: market,
      llm,
      config: agentConfig,
      readEquity: async () => ({ equity: 10_000, source: 'config' }),
    });

    const result = await service.analyzeSymbol(SYMBOL);

    expect(result.failure).toBeNull();
    expect(result.report).not.toBeNull();
    expect(result.plan?.action).toBe('enter');

    // 真的问了两轮模型，而且问的是对的人
    expect(prompts.length).toBe(2);
    expect(prompts[0]).toContain('分析师');
    expect(prompts[1]).toContain('交易员');

    // 报告落库了，立场是**程序合成**的（三个面都看多 → 看多）
    const report = await readLatestAnalystReport(market.pool, 'binance', SYMBOL);
    expect(report).not.toBeNull();
    expect(report?.stance).toBe('bullish');
    expect(report?.technical.score).toBeCloseTo(0.8, 6);
    expect(report?.degraded).toBe(false);
    // 上下文留痕也存了：只存结论的话，模型改了提示词就再也复现不了
    expect(report?.context).toBeTruthy();

    // 方案落库了
    const plan = await readLatestTradingPlan(market.pool, 'binance', SYMBOL);
    expect(plan).not.toBeNull();
    expect(plan?.action).toBe('enter');
    expect(plan?.side).toBe('BUY');
    expect(plan?.status).toBe('advisory');
    expect(plan?.equitySource).toBe('config');

    // **价格与数量是程序算的**，不是模型给的：
    // 数量 = 风险金额 ÷ 止损距离 = (10000 × 1%) ÷ (2 × ATR)
    const atr = plan?.atr ?? 0;
    expect(atr).toBeGreaterThan(0);
    const stopDistance = Math.abs((plan?.entryPrice ?? 0) - (plan?.stopPrice ?? 0));
    expect(stopDistance).toBeCloseTo(2 * atr, 1);
    expect(plan?.quantity).toBeCloseTo((10000 * 0.01) / stopDistance, 3);
    expect(plan?.riskAmount).toBeCloseTo(100, 1);
    // 价格落在 tick 网格上（tick = 0.01）
    expect(((plan?.entryPrice ?? 0) * 100) % 1).toBeCloseTo(0, 6);
    // 方案上的止损价与止盈价分居进场价两侧
    expect(plan?.stopPrice).toBeLessThan(plan?.entryPrice ?? 0);
    expect(plan?.takeProfitPrice).toBeGreaterThan(plan?.entryPrice ?? 0);
  });

  it('两轮落库的顺序对：先报告、后方案，且方案指回那份报告', async () => {
    const plans = await listTradingPlans(market.pool, 'binance', { limit: 10 });
    expect(plans.length).toBeGreaterThan(0);
    const plan = plans[0];
    expect(plan?.reportId).not.toBeNull();

    const reports = await readLatestAnalystReport(market.pool, 'binance', SYMBOL);
    expect(plan?.reportId).toBe(String(reports?.id));
  });
});
