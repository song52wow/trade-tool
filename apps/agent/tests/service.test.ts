/**
 * Agent 编排层的测试（v1.0.0）。
 *
 * 判据本身在 core 的纯函数测试里；这里锁的是**编排**这一层：
 *
 *   1. 一轮要**问两次模型**：先分析师、后交易员，顺序不能反；
 *   2. 分析师的立场由程序合成，落库的是合成结果；
 *   3. **失败必须留痕**：模型失败、输出不合法、方案与结论矛盾——都要落一条
 *      `action = 'failed'` 的方案并写明原因（AGENTS.md 约定 9）；
 *   4. 分析师失败 → **没有**报告；交易员失败 → **有**报告（前半段是好的）。
 *
 * 不出网、不连 PG：模型是替身，连接池是记录 SQL 的假池子。
 */

import { agentSchema, type AgentConfig } from '@trade-tool/core';
import type { LlmClient, MarketContext, Pool } from '@trade-tool/data';
import { describe, expect, it } from 'vitest';

import { createAgentService, type AgentContextBundle } from '../src/service.js';

const SYMBOL = 'TESTUSDT';
const NOW = 1_760_000_000_000;

const CONFIG: AgentConfig = agentSchema.parse({
  enabled: true,
  llm: { enabled: true, baseUrl: 'https://example.invalid/v1', model: 'test-model' },
  equitySource: 'config',
  equity: 10_000,
});

/** 记录 SQL 的假池子：只回 `RETURNING id` 需要的那一行。 */
function fakePool() {
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values?: readonly unknown[]) => {
      calls.push({ sql, values: values ?? [] });
      if (sql.includes('RETURNING id')) return { rows: [{ id: '1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  return { pool, calls };
}

function fakeContext(): MarketContext {
  return {
    pool: fakePool().pool,
    config: { agent: CONFIG } as never,
    dsn: 'postgresql://x',
    exchange: 'binance',
    runtime: 'uv',
  } as unknown as MarketContext;
}

const ANALYST_OUTPUT = {
  technical: { score: 0.8, notes: ['均线多头排列'] },
  sentiment: { score: 0.5, notes: ['资金费率为正'] },
  fundamental: { score: 0.2, notes: [] },
  confidence: 0.9,
  stopAtrMult: 2,
  takeProfitAtrMult: 3,
  rationale: '趋势向上。',
};

const TRADER_OUTPUT = {
  side: 'BUY',
  entryType: 'market',
  entryOffsetAtrMult: 0,
  riskFraction: 0.01,
  stopAtrMult: 2,
  takeProfitAtrMult: 3,
  rationale: '回调买。',
};

/**
 * 记录每次调用的模型替身。按调用次序回不同的内容。
 *
 * `outputs` 用**判别式对象**而不是联合类型 + `Array.isArray`：
 * `Array.isArray` 的收窄对 `readonly string[]` 不成立（它不是 `any[]`），
 * 于是 `!Array.isArray(x)` 之后类型没变窄，`x.fail` 就编不过。
 */
type FakeLlmSpec = { outputs: readonly string[] } | { fail: string };

function fakeLlm(spec: FakeLlmSpec) {
  const prompts: string[] = [];
  const client: LlmClient = {
    complete: async (messages) => {
      prompts.push(messages[messages.length - 1]?.content ?? '');
      if ('fail' in spec) throw new Error(spec.fail);
      const next = spec.outputs[prompts.length - 1];
      if (next === undefined) throw new Error('模型被调用次数超出预期');
      return next;
    },
  };
  return { client, prompts };
}

function bundle(): AgentContextBundle {
  return {
    context: {
      symbol: SYMBOL,
      asOfMs: NOW,
      technical: {
        interval: '1h',
        bars: 300,
        lastClose: 100,
        atr: 2,
        atrPeriod: 14,
        atrPercentOfPrice: 0.02,
        ma: [{ kind: 'sma', bars: 20, value: 99 }],
        macd: null,
        rsi: [],
        boll: null,
        kdj: null,
        obv: null,
        recentReturns: [0.1],
        pricePercentile: 0.7,
        objectiveBias: 0.5,
        objectiveNotes: [],
      },
      sentiment: {
        fundingRate: 0.0001,
        fundingRateAnnualized: 0.1,
        nextFundingTimeMs: 0,
        markPrice: 100,
        indexPrice: 100,
        basisBps: 0,
        openInterest: 1000,
        openInterestChangePct: 1,
        longShortRatio: 1.1,
        takerBuySellRatio: 1,
        notes: [],
      },
      fundamental: {
        contractType: 'PERPETUAL',
        onboardDateMs: null,
        tickSize: 0.01,
        stepSize: 0.001,
        minQty: 0.001,
        quoteVolume24h: 1000,
        trades24h: 10,
        priceChangePct24h: 1,
        carryCostAnnualized: 0.1,
        notes: [],
      },
      baseline: { stopAtrMult: 2, takeProfitAtrMult: 3 },
    },
    payload: { technical: { lastClose: 100 } },
    degraded: false,
  };
}

/** 建一个服务，池是假池子，模型是替身。 */
function setup(options: {
  outputs: FakeLlmSpec;
  equity?: () => Promise<{ equity: number; source: 'exchange' | 'config' }>;
  config?: AgentConfig;
}) {
  const { pool, calls } = fakePool();
  const llm = fakeLlm(options.outputs);
  const ctx = { ...fakeContext(), pool } as MarketContext;
  const service = createAgentService({
    ctx,
    llm: llm.client,
    config: options.config ?? CONFIG,
    readEquity: options.equity ?? (async () => ({ equity: 10_000, source: 'config' })),
    loadContext: async () => bundle(),
    now: () => NOW,
  });
  return { service, calls, prompts: llm.prompts };
}

/** 从落库的 SQL 参数里取出 `action` 那一列。 */
function planAction(calls: readonly { sql: string; values: readonly unknown[] }[]): string {
  const insert = calls.find((c) => c.sql.includes('INSERT INTO trading_plan'));
  if (insert === undefined) throw new Error('没有写方案');
  // 列顺序见 db/agent.ts：exchange, symbol, report_id, as_of_ms, created_at_ms, action, …
  return String(insert.values[5]);
}

/** 从落库的 SQL 参数里取出 `failure_reason` 那一列。 */
function planFailureReason(
  calls: readonly { sql: string; values: readonly unknown[] }[],
): string | null {
  const insert = calls.find((c) => c.sql.includes('INSERT INTO trading_plan'));
  if (insert === undefined) throw new Error('没有写方案');
  const value = insert.values[26];
  return value === null || value === undefined ? null : String(value);
}

describe('createAgentService', () => {
  it('正常一轮：先问分析师、再问交易员，落一份报告与一份方案', async () => {
    const { service, calls, prompts } = setup({
      outputs: { outputs: [JSON.stringify(ANALYST_OUTPUT), JSON.stringify(TRADER_OUTPUT)] },
    });
    const result = await service.analyzeSymbol(SYMBOL);

    expect(result.failure).toBeNull();
    expect(result.report).not.toBeNull();
    expect(result.report?.stance).toBe('bullish');
    expect(result.plan?.action).toBe('enter');
    // 两次调用：第一次是分析师（提示词里有「技术面」），第二次是交易员（提示词里有「账户权益」）
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('技术面');
    expect(prompts[1]).toContain('账户权益');
    // 落库：一份报告 + 一份方案
    expect(calls.some((c) => c.sql.includes('INSERT INTO analyst_report'))).toBe(true);
    expect(planAction(calls)).toBe('enter');
  });

  it('分析师失败 → 落一条 failed 方案并写明原因，不落报告', async () => {
    const { service, calls } = setup({ outputs: { fail: '模型超时' } });
    const result = await service.analyzeSymbol(SYMBOL);

    expect(result.failure).toContain('模型超时');
    expect(result.report).toBeNull();
    expect(calls.some((c) => c.sql.includes('INSERT INTO analyst_report'))).toBe(false);
    expect(planAction(calls)).toBe('failed');
    expect(planFailureReason(calls)).toContain('模型超时');
  });

  it('分析师输出不合法 → 同样落 failed 方案，保留模型原文', async () => {
    const { service, calls } = setup({ outputs: { outputs: ['这不是 JSON'] } });
    const result = await service.analyzeSymbol(SYMBOL);

    expect(result.failure).toContain('不合法');
    expect(planAction(calls)).toBe('failed');
    // 原文留痕：排查「模型为什么老说错话」时它是唯一的第一手证据
    const insert = calls.find((c) => c.sql.includes('INSERT INTO trading_plan'));
    expect(String(insert?.values[27])).toBe('这不是 JSON');
  });

  it('交易员与分析师结论矛盾 → 报告照留，方案记 failed', async () => {
    const { service, calls } = setup({
      outputs: {
        outputs: [
          JSON.stringify(ANALYST_OUTPUT),
          JSON.stringify({ ...TRADER_OUTPUT, side: 'SELL' }),
        ],
      },
    });
    const result = await service.analyzeSymbol(SYMBOL);

    expect(result.failure).toContain('矛盾');
    // 分析师那一步是好的，报告必须留下
    expect(calls.some((c) => c.sql.includes('INSERT INTO analyst_report'))).toBe(true);
    expect(planAction(calls)).toBe('failed');
  });

  it('读不到账户权益 → 落 failed 方案并写明原因', async () => {
    const { service, calls } = setup({
      outputs: { outputs: [JSON.stringify(ANALYST_OUTPUT), JSON.stringify(TRADER_OUTPUT)] },
      equity: async () => {
        throw new Error('交易所凭据没配');
      },
    });
    const result = await service.analyzeSymbol(SYMBOL);

    expect(result.failure).toContain('账户权益');
    expect(planAction(calls)).toBe('failed');
    expect(planFailureReason(calls)).toContain('交易所凭据没配');
  });

  it('fallbackToTrade = false 时模型失败会抛错（但仍留痕）', async () => {
    const config: AgentConfig = agentSchema.parse({
      ...CONFIG,
      llm: { ...CONFIG.llm, fallbackToTrade: false },
    });
    const { service, calls } = setup({ outputs: { fail: '模型超时' }, config });
    await expect(service.analyzeSymbol(SYMBOL)).rejects.toThrowError();
    // 抛错不等于不留痕：失败方案照样落库
    expect(planAction(calls)).toBe('failed');
  });
});

describe('自动执行开关（本期未实现）', () => {
  it('execute.enabled = true → 建服务就报错，不是一路跑到「以为在下单」', () => {
    const config: AgentConfig = agentSchema.parse({
      ...CONFIG,
      execute: { ...CONFIG.execute, enabled: true },
    });
    expect(() =>
      createAgentService({
        ctx: fakeContext(),
        llm: { complete: async () => '{}' },
        config,
        readEquity: async () => ({ equity: 10_000, source: 'config' }),
      }),
    ).toThrowError(/自动执行路径本期未实现/);
  });

  it('execute.enabled = false（缺省）→ 正常建服务', () => {
    expect(() =>
      createAgentService({
        ctx: fakeContext(),
        llm: { complete: async () => '{}' },
        config: CONFIG,
        readEquity: async () => ({ equity: 10_000, source: 'config' }),
      }),
    ).not.toThrow();
  });
});
