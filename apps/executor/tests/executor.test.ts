/**
 * `apps/executor` 的行为测试。全部用替身：**不连 PG、不出网**（AGENTS.md 测试约定）。
 *
 * 覆盖的是「会真实下单的地方最容易出的那几类错」：
 *   * 把自己的止损成交当成新的买入成交（会再挂一组单，仓位翻倍）；
 *   * 事件重放导致重复挂单；
 *   * 止盈挂上、止损失败 → 必须撤掉止盈（否则仓位裸奔）；
 *   * ATR 取不到 → 留 failed 记录，不回退到别的周期或 0。
 */

import { configSchema, type TradeToolConfig } from '@trade-tool/core';
import type { OrderTradeUpdate, Pool } from '@trade-tool/data';
import type { OrderPlacer } from '../src/service.js';
import {
  bracketClientOrderId,
  createExecutorService,
  parseBracketClientOrderId,
} from '../src/service.js';
import type { AtrProvider } from '../src/atr.js';
import { describe, expect, it, vi } from 'vitest';

/** 记录调用顺序的 PG 替身：把 claimBracket 的幂等语义原样模拟出来。 */
function fakePool() {
  const state = {
    claims: new Map<
      string,
      {
        tpOrderId: number | null;
        slOrderId: number | null;
        state: string;
        lastError: string | null;
      }
    >(),
  };
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes('INSERT INTO risk_bracket')) {
      const p = params as unknown[];
      const [exchange, symbol, entryOrderId, entryPrice, entryTime, filledQty] = p as (
        string | number
      )[];
      const [positionSide, atr, atrPeriod, atrInterval, windowFrom, windowTo, stop, takeProfit] =
        p.slice(6, 14) as (string | number)[];
      const now = p[14] as number;
      const key = `${exchange}/${symbol}/${entryOrderId}`;
      if (state.claims.has(key)) return { rows: [], rowCount: 0 };
      state.claims.set(key, { tpOrderId: null, slOrderId: null, state: 'failed', lastError: null });
      // RETURNING 的是完整一行，读侧会逐列校验（NULL_NOT_ALLOWED），因此必须给全
      return {
        rows: [
          {
            exchange,
            symbol,
            entry_order_id: entryOrderId,
            entry_price: entryPrice,
            entry_time: entryTime,
            filled_qty: filledQty,
            position_side: positionSide,
            atr,
            atr_period: atrPeriod,
            atr_interval: atrInterval,
            atr_window_from: windowFrom,
            atr_window_to: windowTo,
            stop_price: stop,
            take_profit: takeProfit,
            tp_order_id: null,
            sl_order_id: null,
            state: 'failed',
            last_error: null,
            created_at: now,
            updated_at: now,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes('SET tp_order_id')) {
      const [exchange, symbol, entryOrderId, tp, sl] = params as (string | number)[];
      const row = state.claims.get(`${exchange}/${symbol}/${entryOrderId}`);
      if (row) Object.assign(row, { tpOrderId: tp, slOrderId: sl, state: 'armed' });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('SET state = $4') || sql.includes("SET state = 'failed'")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('FROM contract_spec')) {
      return {
        rows: [{ raw: { filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.10' }] } }],
        rowCount: 1,
      };
    }
    throw new Error(`未预期的 SQL：${sql}`);
  });
  // pool 只用到 `query`；其余方法用不到也不实现。
  return { state, pool: { query } as unknown as Pool };
}

function makeConfig(executor: Record<string, unknown> = {}): TradeToolConfig {
  return configSchema.parse({
    market: { symbol: 'BTCUSDT' },
    executor: { enabled: true, ...executor },
  });
}

const ATR = {
  symbol: 'BTCUSDT',
  interval: '1m',
  intervalMs: 60_000,
  period: 14,
  atr: 100,
  barsUsed: 200,
  segmentFrom: 1,
  segmentTo: 2,
  asOfMs: 1_000,
};

function fill(overrides: Partial<OrderTradeUpdate> = {}): OrderTradeUpdate {
  return {
    eventTime: 1_000,
    transactionTime: 1_000,
    symbol: 'BTCUSDT',
    clientOrderId: 'user-entry-1',
    orderId: 42,
    side: 'BUY',
    orderType: 'MARKET',
    averagePrice: 60_000,
    lastFilledPrice: 60_000,
    lastFilledQty: 0.1,
    cumulativeQty: 0.1,
    origQty: 0.1,
    executionType: 'TRADE',
    status: 'FILLED',
    tradeTime: 1_000,
    positionSide: 'BOTH',
    ...overrides,
  };
}

function fakeAtr(): AtrProvider & { calls: [string, number][] } {
  const calls: [string, number][] = [];
  return {
    calls,
    async atrAt(symbol: string, asOfMs: number) {
      calls.push([symbol, asOfMs]);
      return { ...ATR, symbol, asOfMs };
    },
  };
}

function fakePlacer(overrides: Partial<OrderPlacer> = {}): OrderPlacer & {
  placed: { type: string; stopPrice: number; clientOrderId: string }[];
  cancelled: number[];
} {
  const placed: { type: string; stopPrice: number; clientOrderId: string }[] = [];
  const cancelled: number[] = [];
  let seq = 900;
  return {
    placed,
    cancelled,
    async placeClosePositionOrder(request) {
      placed.push({
        type: request.type,
        stopPrice: request.stopPrice,
        clientOrderId: request.clientOrderId,
      });
      seq += 1;
      return {
        orderId: seq,
        clientOrderId: request.clientOrderId,
        symbol: request.symbol,
        status: 'NEW',
      };
    },
    async cancelOrder(_symbol: string, orderId: number) {
      cancelled.push(orderId);
    },
    ...overrides,
  };
}

describe('clientOrderId 往返', () => {
  it('认得出自己挂的单与它属于哪一笔入场', () => {
    const id = bracketClientOrderId('sl', '123456789');
    expect(parseBracketClientOrderId(id)).toEqual({ tag: 'sl', entryOrderId: '123456789' });
  });

  it('用户自己的单不被误认', () => {
    expect(parseBracketClientOrderId('web_abc123')).toBeNull();
    expect(parseBracketClientOrderId('rsk-xx-1')).toBeNull();
  });

  it('长度被交易所上限截断', () => {
    expect(bracketClientOrderId('tp', 'x'.repeat(60))).toHaveLength(36);
  });
});

describe('事件判定', () => {
  it('只认真撮合事件', async () => {
    const service = createExecutorService({
      pool: fakePool().pool,
      config: makeConfig(),
      placer: fakePlacer(),
      atr: fakeAtr(),
    });
    const outcome = await service.handleFill(fill({ executionType: 'NON_TRADE' }));
    expect(outcome).toBe('ignored');
  });

  it('卖出成交不建保护（减仓由它自己的单触发）', async () => {
    const placer = fakePlacer();
    const service = createExecutorService({
      pool: fakePool().pool,
      config: makeConfig(),
      placer,
      atr: fakeAtr(),
    });
    expect(await service.handleFill(fill({ side: 'SELL' }))).toBe('ignored');
    expect(placer.placed).toHaveLength(0);
  });

  it('自己的止损成交被认成结算而不是新买入', async () => {
    const pool = fakePool();
    const placer = fakePlacer();
    const atr = fakeAtr();
    await createExecutorService({ pool: pool.pool, config: makeConfig(), placer, atr }).handleFill(
      fill(),
    );
    const stopId = bracketClientOrderId('sl', '42');
    const outcome = await createExecutorService({
      pool: pool.pool,
      config: makeConfig(),
      placer,
      atr,
    }).handleFill(
      fill({
        side: 'SELL',
        clientOrderId: stopId,
        orderId: 901,
        status: 'FILLED',
      }),
    );
    expect(outcome).toBe('settled');
    // 关键：不得因为它是 SELL 就当成减仓，更不得再挂一组单
    expect(placer.placed).toHaveLength(2);
    expect(atr.calls).toHaveLength(1);
  });

  it('部分成交默认跳过（等于只保护半个仓位）', async () => {
    const placer = fakePlacer();
    const service = createExecutorService({
      pool: fakePool().pool,
      config: makeConfig(),
      placer,
      atr: fakeAtr(),
    });
    expect(await service.handleFill(fill({ status: 'PARTIALLY_FILLED' }))).toBe('partial-skipped');
    expect(placer.placed).toHaveLength(0);
  });

  it('accumulate 模式下部分成交也处理', async () => {
    const placer = fakePlacer();
    const service = createExecutorService({
      pool: fakePool().pool,
      config: makeConfig({ onPartialFill: 'accumulate' }),
      placer,
      atr: fakeAtr(),
    });
    expect(await service.handleFill(fill({ status: 'PARTIALLY_FILLED' }))).toBe('armed');
    expect(placer.placed).toHaveLength(2);
  });

  it('标的不在名单内直接忽略', async () => {
    const placer = fakePlacer();
    const service = createExecutorService({
      pool: fakePool().pool,
      config: makeConfig({ symbols: ['ETHUSDT'] }),
      placer,
      atr: fakeAtr(),
    });
    expect(await service.handleFill(fill())).toBe('ignored');
    expect(placer.placed).toHaveLength(0);
  });
});

describe('下单', () => {
  it('按 ATR 倍数挂出止盈与止损，方向为平仓方向', async () => {
    const placer = fakePlacer();
    const service = createExecutorService({
      pool: fakePool().pool,
      config: makeConfig({ stopAtrMult: 2, takeProfitAtrMult: 3 }),
      placer,
      atr: fakeAtr(),
    });
    expect(await service.handleFill(fill())).toBe('armed');
    expect(placer.placed.map((p) => p.type)).toEqual(['TAKE_PROFIT_MARKET', 'STOP_MARKET']);
    // entry 60000, atr 100, 止损 2×ATR、止盈 3×ATR → sl 59800.0 / tp 60300.0（tick 0.10）
    expect(placer.placed[0]?.stopPrice).toBeCloseTo(60_300, 6);
    expect(placer.placed[1]?.stopPrice).toBeCloseTo(59_800, 6);
  });

  it('止盈挂上、止损失败时撤掉止盈：不能留下裸奔仓位', async () => {
    const placer = fakePlacer({
      async placeClosePositionOrder(request) {
        if (request.type === 'STOP_MARKET') {
          throw new Error('交易所拒单 -2021 Order would immediately trigger');
        }
        return {
          orderId: 777,
          clientOrderId: request.clientOrderId,
          symbol: request.symbol,
          status: 'NEW',
        };
      },
    });
    const service = createExecutorService({
      pool: fakePool().pool,
      config: makeConfig(),
      placer,
      atr: fakeAtr(),
    });
    expect(await service.handleFill(fill())).toBe('failed');
    expect(placer.cancelled).toEqual([777]);
  });

  it('两张单都没挂上时不撤单', async () => {
    const placer = fakePlacer({
      async placeClosePositionOrder() {
        throw new Error('网络断了');
      },
    });
    const service = createExecutorService({
      pool: fakePool().pool,
      config: makeConfig(),
      placer,
      atr: fakeAtr(),
    });
    expect(await service.handleFill(fill())).toBe('failed');
    expect(placer.cancelled).toEqual([]);
  });

  it('同一笔成交重复投递只挂一次', async () => {
    const pool = fakePool();
    const placer = fakePlacer();
    const service = createExecutorService({
      pool: pool.pool,
      config: makeConfig(),
      placer,
      atr: fakeAtr(),
    });
    expect(await service.handleFill(fill())).toBe('armed');
    expect(await service.handleFill(fill())).toBe('duplicate');
    expect(placer.placed).toHaveLength(2);
  });
});

describe('取不到 ATR', () => {
  it('记失败而不是回退到别的周期或 0', async () => {
    const pool = fakePool();
    const placer = fakePlacer();
    const atr: AtrProvider = {
      async atrAt() {
        throw new Error('[RISK_ATR_UNAVAILABLE] 库里没有足够的已收盘 K 线');
      },
    };
    const service = createExecutorService({
      pool: pool.pool,
      config: makeConfig(),
      placer,
      atr,
    });
    expect(await service.handleFill(fill())).toBe('failed');
    expect(placer.placed).toHaveLength(0);
    expect(pool.state.claims.size).toBe(1);
  });

  it('成交金额超上限时留可见的失败记录', async () => {
    const pool = fakePool();
    const placer = fakePlacer();
    const service = createExecutorService({
      pool: pool.pool,
      config: makeConfig({ maxEntryNotional: 1_000 }),
      placer,
      atr: fakeAtr(),
    });
    expect(await service.handleFill(fill())).toBe('failed');
    expect(placer.placed).toHaveLength(0);
    expect(pool.state.claims.has('binance/BTCUSDT/42')).toBe(true);
  });
});
