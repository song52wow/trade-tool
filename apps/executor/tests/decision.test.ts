/**
 * LLM 决策在 executor 里的行为测试（v0.9.0）。**不连 PG、不出网**。
 *
 * 锁的是「模型不可靠时系统会不会做出危险的事」这四类：
 *   * 模型给了**越界**的档位 → 不能变成真实的平仓指令；
 *   * 模型**超时/报错** → 降级到配置档位，仓位仍然受保护（不能裸仓）；
 *   * 模型给的档位**自相矛盾**（分批的第一段比整段还远）→ 拒绝这一份；
 *   * 模型决定生效时 → 挂出去的价格**确实**按模型的倍数算（而不是仍按配置算）。
 *
 * 另有一条：**决策来源必须落库**（`decision_source`）——降级与正常两条路径
 * 都要能事后查出「这次是模型定的还是配置定的」。
 */

import { configSchema, type TradeToolConfig } from '@trade-tool/core';
import type { OrderTradeUpdate, Pool } from '@trade-tool/data';
import { describe, expect, it, vi } from 'vitest';

import { createRiskDecider } from '../src/decision.js';
import { createExecutorService, type OrderPlacer } from '../src/service.js';
import type { AtrProvider } from '../src/atr.js';

const BASE_CONFIG = configSchema.parse({
  market: { symbol: 'BTCUSDT', interval: '1h' },
  executor: { enabled: true },
});

/** 假 ATR：固定值，测试只看倍数怎么变成价格。 */
const atrProvider: AtrProvider = {
  atrAt: async () => ({
    symbol: 'BTCUSDT',
    interval: '1m',
    intervalMs: 60_000,
    period: 14,
    atr: 10,
    barsUsed: 100,
    segmentFrom: 1,
    segmentTo: 2,
    asOfMs: 1_000,
    extreme: { high: 110, low: 90, from: 1, to: 2 },
    lastClose: 100,
  }),
};

/** 记录挂单参数的替身。 */
function fakePlacer(): OrderPlacer & { calls: { stopPrice: number; tp: number }[] } {
  const calls: { stopPrice: number; tp: number }[] = [];
  let nextId = 1;
  return {
    calls,
    async placeClosePositionOrder(request) {
      if (request.type === 'STOP_MARKET') calls.push({ stopPrice: request.stopPrice, tp: 0 });
      else calls.push({ stopPrice: 0, tp: request.stopPrice });
      return {
        algoId: nextId++,
        clientAlgoId: request.clientAlgoId,
        symbol: request.symbol,
        status: 'NEW',
      };
    },
    async placeQuantityOrder(request) {
      calls.push({ stopPrice: 0, tp: request.stopPrice });
      return {
        algoId: nextId++,
        clientAlgoId: request.clientAlgoId,
        symbol: request.symbol,
        status: 'NEW',
      };
    },
    async cancelAlgoOrder() {
      /* 替身不真撤 */
    },
  };
}

/**
 * 记 claim 的 PG 替身。只需要认得 `INSERT INTO risk_bracket`，
 * 并把决策相关的那几列记下来供断言。
 */
function fakePool() {
  const claimed: {
    symbol: string;
    decisionSource: string | null;
    stopAtrMult: number | null;
    fallbackReason: string | null;
    rationale: string | null;
  }[] = [];
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes('INSERT INTO risk_bracket')) {
      const p = params as unknown[];
      // 列顺序与 db/risk.ts 的 INSERT 一致：
      // 0-6 基本七列，7-13 ATR 与窗口，14-16 tp1 三列，17 手续费，
      // 18 起是 v0.9.0 的决策列（来源 + 四个倍数 + 理由 + 降级原因 + 原文 + 时刻）。
      // v0.9.1 合并成一个止盈倍数后，决策列少了一列——下标也跟着前移。
      claimed.push({
        symbol: String(p[1]),
        decisionSource: p[18] === null ? null : String(p[18]),
        stopAtrMult: p[19] === null ? null : Number(p[19]),
        fallbackReason: p[25] === null ? null : String(p[25]),
        rationale: p[24] === null ? null : String(p[24]),
      });
      // RETURNING 必须给出**完整一行**：读侧逐列校验，缺列会报 NULL_NOT_ALLOWED。
      return { rows: [returningRow(p)], rowCount: 1 };
    }
    // listUnsettledBrackets：没有未终结记录（这一组用例都是新开仓）。
    if (sql.includes('FROM risk_bracket')) return { rows: [], rowCount: 0 };
    // 合约规格：tickSize 决定价格怎么对齐。
    if (sql.includes('FROM contract_spec')) {
      return {
        rows: [
          {
            raw: {
              filters: [
                { filterType: 'PRICE_FILTER', tickSize: '0.10' },
                { filterType: 'LOT_SIZE', stepSize: '0.001' },
              ],
            },
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 1 };
  });
  return { pool: { query } as unknown as Pool, claimed };
}

/** 占坑时 RETURNING 的那一行（字段名与真表一致）。 */
function returningRow(p: unknown[]): Record<string, unknown> {
  return {
    exchange: p[0],
    symbol: p[1],
    entry_order_id: p[2],
    entry_price: p[3],
    entry_time: p[4],
    filled_qty: p[5],
    position_side: p[6],
    atr: p[7],
    atr_period: p[8],
    atr_interval: p[9],
    atr_window_from: p[10],
    atr_window_to: p[11],
    stop_price: p[12],
    take_profit: p[13],
    tp_algo_id: null,
    sl_algo_id: null,
    tp1_algo_id: p[14],
    tp1_qty: p[15],
    tp1_price: p[16],
    tp1_filled_qty: null,
    tp1_filled_at: null,
    trail_extreme: null,
    trail_stop_price: null,
    trail_atr: null,
    trail_atr_from: null,
    trail_atr_to: null,
    trail_updated_at: null,
    trail_last_error: null,
    closed_qty: 0,
    exit_notional: 0,
    fee_amount: p[17] ?? 0,
    decision_source: p[18],
    decision_stop_atr_mult: p[19],
    decision_take_profit_atr_mult: p[20],
    decision_take_profit1_ratio: p[21],
    decision_trail_atr_mult: p[22],
    decision_breakeven_after_tp1: p[23],
    decision_rationale: p[24],
    decision_fallback_reason: p[25],
    decision_raw: p[26],
    decision_at: p[27],
    state: 'failed',
    last_error: null,
    created_at: p[28],
    updated_at: p[29],
  };
}

function fillEvent(): OrderTradeUpdate {
  return {
    eventTime: 1_000,
    transactionTime: 1_000,
    symbol: 'BTCUSDT',
    clientOrderId: 'user-order-1',
    orderId: 12_345,
    side: 'BUY',
    orderType: 'MARKET',
    averagePrice: 100,
    lastFilledPrice: 100,
    lastFilledQty: 1,
    cumulativeQty: 1,
    origQty: 1,
    executionType: 'TRADE',
    status: 'FILLED',
    tradeTime: 1_000,
    positionSide: 'LONG',
    commission: 0,
    commissionAsset: 'USDT',
  };
}

/** 建一个「模型返回固定内容」的客户端替身。 */
function llmReturning(content: string): DeciderStub {
  return {
    complete: async () => content,
  };
}

function llmFailing(message: string): DeciderStub {
  return {
    complete: async () => {
      throw new Error(message);
    },
  };
}

const VALID_DECISION = {
  stopAtrMult: 2.5,
  takeProfitAtrMult: 4,
  takeProfit1Ratio: 0,
  trailAtrMult: 2,
  breakevenAfterTp1: true,
};

interface DeciderStub {
  complete: (messages: readonly { role: string; content: string }[]) => Promise<string>;
}

function makeService(
  deps: {
    llm?: DeciderStub;
    fallbackToPolicy?: boolean;
  } = {},
): {
  service: ReturnType<typeof createExecutorService>;
  placer: ReturnType<typeof fakePlacer>;
  pool: ReturnType<typeof fakePool>;
} {
  const placer = fakePlacer();
  const poolStub = fakePool();
  const pool = poolStub.pool;
  const config: TradeToolConfig = {
    ...BASE_CONFIG,
    executor: {
      ...BASE_CONFIG.executor,
      llm: {
        ...BASE_CONFIG.executor.llm,
        enabled: deps.llm !== undefined,
        baseUrl: 'https://example.invalid/v1',
        model: 'test-model',
        fallbackToPolicy: deps.fallbackToPolicy ?? true,
      },
    },
  };
  const decider =
    deps.llm === undefined
      ? undefined
      : createRiskDecider({
          llm: deps.llm as unknown as NonNullable<Parameters<typeof createRiskDecider>[0]['llm']>,
          config: config.executor.llm,
        });
  const service = createExecutorService({
    pool,
    config,
    placer,
    atr: atrProvider,
    positions: {
      seed: () => {},
      correct: () => {},
      get: () => 1,
      applyFill: () => ({ positionAfter: 1, applied: true }),
    },
    ...(decider === undefined ? {} : { decider }),
    resolvePolicy: async () => ({
      atrPeriod: 14,
      atrInterval: '1m',
      stopAtrMult: 2,
      takeProfitAtrMult: 3,
      takeProfit1Ratio: 0,
      trailAtrMult: 2,
      breakevenAfterTp1: true,
      source: 'global',
    }),
  });
  return { service, placer, pool: poolStub };
}

describe('LLM 决策：模型给出的档位会真的变成挂单价', () => {
  it('模型给了新倍数 → 挂出去的价格按模型的倍数算', async () => {
    const { service, placer } = makeService({
      llm: llmReturning(JSON.stringify(VALID_DECISION)),
    });
    const outcome = await service.handleFill(fillEvent());
    expect(outcome).toBe('armed');
    // ATR = 10：止损 2.5×10 = 25 → 100 - 25 = 75；止盈 4×10 = 40 → 140。
    const stop = placer.calls.find((c) => c.stopPrice !== 0);
    const take = placer.calls.find((c) => c.tp !== 0);
    expect(stop?.stopPrice).toBe(75);
    expect(take?.tp).toBe(140);
  });

  it('模型没开 → 行为与之前一致（按配置：止损 2×ATR = 80、止盈 3×ATR = 130）', async () => {
    const { service, placer } = makeService();
    const outcome = await service.handleFill(fillEvent());
    expect(outcome).toBe('armed');
    expect(placer.calls.find((c) => c.stopPrice !== 0)?.stopPrice).toBe(80);
    expect(placer.calls.find((c) => c.tp !== 0)?.tp).toBe(130);
  });

  it('决策来源落库：模型定的记 llm', async () => {
    const { service, pool } = makeService({
      llm: llmReturning(JSON.stringify(VALID_DECISION)),
    });
    await service.handleFill(fillEvent());
    expect(pool.claimed[0]?.decisionSource).toBe('llm');
    expect(pool.claimed[0]?.stopAtrMult).toBe(2.5);
  });
});

describe('LLM 决策：模型不可靠时不能做出危险的事', () => {
  it('模型调用失败 → 降级到配置档位，仓位仍然受保护', async () => {
    const { service, placer, pool } = makeService({ llm: llmFailing('连接超时') });
    const outcome = await service.handleFill(fillEvent());
    // 关键：**仍然挂上了**（不是裸仓）。
    expect(outcome).toBe('armed');
    expect(placer.calls.find((c) => c.stopPrice !== 0)?.stopPrice).toBe(80);
    // 降级必须留痕。
    expect(pool.claimed[0]?.decisionSource).toBe('config-fallback');
    expect(pool.claimed[0]?.fallbackReason).toContain('模型调用失败');
  });

  it('模型输出越界 → 不采用，降级', async () => {
    const { service, placer, pool } = makeService({
      llm: llmReturning(JSON.stringify({ ...VALID_DECISION, stopAtrMult: 99 })),
    });
    const outcome = await service.handleFill(fillEvent());
    expect(outcome).toBe('armed');
    // 越界的 99 倍**没有**变成挂单价：按配置挂。
    expect(placer.calls.find((c) => c.stopPrice !== 0)?.stopPrice).toBe(80);
    expect(pool.claimed[0]?.decisionSource).toBe('config-fallback');
  });

  it('模型输出的不是 JSON → 不采用，降级', async () => {
    const { service, placer, pool } = makeService({
      llm: llmReturning('我觉得止损放在 2.5 倍 ATR 附近比较合适'),
    });
    const outcome = await service.handleFill(fillEvent());
    expect(outcome).toBe('armed');
    expect(placer.calls.find((c) => c.stopPrice !== 0)?.stopPrice).toBe(80);
    expect(pool.claimed[0]?.decisionSource).toBe('config-fallback');
  });

  it('分批形态的决策照常采纳（合并成一个倍数后，不再有「两段比远近」的自相矛盾）', async () => {
    const { service, placer, pool } = makeService({
      llm: llmReturning(
        JSON.stringify({
          ...VALID_DECISION,
          takeProfit1Ratio: 0.5,
          takeProfitAtrMult: 3,
        }),
      ),
    });
    const outcome = await service.handleFill(fillEvent());
    expect(outcome).toBe('armed');
    // 止损按模型给的 2.5×ATR = 75
    expect(placer.calls.find((c) => c.stopPrice !== 0)?.stopPrice).toBe(75);
    // 止盈按模型给的 3×ATR = 130：只有一个止盈倍数，第一段与「整段」是同一个数
    expect(placer.calls.find((c) => c.tp !== 0)?.tp).toBe(130);
    expect(pool.claimed[0]?.decisionSource).toBe('llm');
  });

  it('fallbackToPolicy=false 且模型失败 → 不挂单（用户明确选了宁可不挂）', async () => {
    const { service, placer } = makeService({
      llm: llmFailing('连接超时'),
      fallbackToPolicy: false,
    });
    const outcome = await service.handleFill(fillEvent());
    expect(outcome).toBe('failed');
    // 一张单都没挂：宁可裸着，也不要在模型不可用时按不明档位挂。
    expect(placer.calls).toHaveLength(0);
  });
});
