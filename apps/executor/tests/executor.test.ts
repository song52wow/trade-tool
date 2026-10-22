/**
 * `apps/executor` 的行为测试。全部用替身：**不连 PG、不出网**（AGENTS.md 测试约定）。
 *
 * 覆盖的是「会真实下单的地方最容易出的那几类错」：
 *   * 把自己的止损成交当成新的买入成交（会再挂一组单，仓位翻倍）；
 *   * 事件重放导致重复挂单；
 *   * 止盈挂上、止损失败 → 必须撤掉止盈（否则仓位裸奔）；
 *   * ATR 取不到 → 留 failed 记录，不回退到别的周期或 0。
 */

import {
  NOTIFY_KINDS,
  NetPositionTracker,
  SyncError,
  configSchema,
  type AlertChannel,
  type AlertDispatcher,
  type AlertItem,
  type TradeToolConfig,
} from '@trade-tool/core';
import type { OrderTradeUpdate, Pool } from '@trade-tool/data';
import type { OrderPlacer } from '../src/service.js';
import {
  bracketClientOrderId,
  createExecutorService,
  parseBracketClientOrderId,
} from '../src/service.js';
import type { AtrProvider, AtrSnapshot } from '../src/atr.js';
import { describe, expect, it, vi } from 'vitest';

/** 假库里一行止盈止损记录。字段名跟真表一致（`state` 已是七态之一）。 */
interface FakeClaim {
  symbol: string;
  positionSide: string;
  /** 落库的止盈价（`take_profit` 列）。页面显示的「止盈价」读的就是它。 */
  takeProfit: number;
  tpOrderId: number | null;
  /** v0.7.0：移动止损换档时新挂的那张止损单号。 */
  slAlgoId?: number;
  slOrderId: number | null;
  state: string;
  lastError: string | null;
  tp1AlgoId?: number | null;
  tp1Qty?: number | null;
  tp1Price?: number | null;
  /** v0.9.1：「第一段止盈已成交」的标记。移动止损定时器靠它认领「等推进」的行。 */
  tp1FilledAt?: number | null;
  trailStopPrice?: number | null;
  trailExtreme?: number | null;
  trailAtr?: number | null;
  trailLastError?: string | null;
  updatedAt?: number;
  /** v0.8.0：入场那笔的手续费。 */
  entryFee?: number;
  /** v0.8.0：平仓事实的累计量。 */
  closedQty?: number;
  exitNotional?: number;
  feeAmount?: number;
}

/** 记录调用顺序的 PG 替身：把 claimBracket 的幂等语义原样模拟出来。 */
function fakePool() {
  const state = {
    claims: new Map<string, FakeClaim>(),
  };
  const key2 = (symbol: unknown, entryOrderId: unknown): string =>
    `binance/${String(symbol)}/${String(entryOrderId)}`;
  /** 更新一行；不存在就忽略（真库会 rowCount=0，而替身不需要区分）。 */
  const patch = (key: string, fields: Partial<FakeClaim>): void => {
    const row = state.claims.get(key);
    if (row) Object.assign(row, fields);
  };
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes('INSERT INTO risk_bracket')) {
      const p = params as unknown[];
      const [exchange, symbol, entryOrderId, entryPrice, entryTime, filledQty] = p as (
        string | number
      )[];
      const [positionSide, atr, atrPeriod, atrInterval, windowFrom, windowTo, stop, takeProfit] =
        p.slice(6, 14) as (string | number)[];
      // v0.7.0：占坑时插入 tp1_algo_id / tp1_qty / tp1_price 三列；
      // v0.8.0：再插入 fee_amount（入场那笔的手续费）一列。
      // 因此 created_at / updated_at 的位置又后移了 1。索引与 INSERT 的列顺序一一对应。
      const tp1AlgoId = p[14] as number | null;
      const tp1Qty = p[15] as number | null;
      const tp1Price = p[16] as number | null;
      const entryFee = p[17] as number;
      // created_at / updated_at 是**最后**两个参数：后面还会加列（v0.9.0 的决策列），
      // 按固定下标取会在每次加列时错位——错位的样子是「created_at 不是整数」。
      const now = p[p.length - 1] as number;
      void entryFee;
      const key = `${exchange}/${symbol}/${entryOrderId}`;
      if (state.claims.has(key)) return { rows: [], rowCount: 0 };
      state.claims.set(key, {
        symbol: String(symbol),
        positionSide: String(positionSide),
        takeProfit: Number(takeProfit),
        tpOrderId: null,
        slOrderId: null,
        state: 'failed',
        lastError: null,
        tp1AlgoId,
        tp1Qty,
        tp1Price,
        entryFee,
      });
      // 入场那笔的手续费也是这一轮的成本。
      state.claims.get(key)!.feeAmount = entryFee;
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
            tp_algo_id: null,
            sl_algo_id: null,
            tp1_algo_id: tp1AlgoId,
            tp1_qty: tp1Qty,
            tp1_price: tp1Price,
            tp1_filled_qty: null,
            tp1_filled_at: null,
            trail_extreme: null,
            trail_stop_price: null,
            trail_atr: null,
            trail_atr_from: null,
            trail_atr_to: null,
            trail_updated_at: null,
            trail_last_error: null,
            // v0.8.0：盈亏的事实（累计）。盈亏金额本身不存，由 core 现算。
            closed_qty: 0,
            exit_notional: 0,
            fee_amount: 0,
            // v0.9.0：LLM 决策的记录列（本用例走的是「没有决策」的路径）。
            decision_source: 'config',
            decision_stop_atr_mult: null,
            decision_take_profit_atr_mult: null,
            decision_take_profit1_ratio: null,
            decision_trail_atr_mult: null,
            decision_breakeven_after_tp1: null,
            decision_rationale: null,
            decision_fallback_reason: null,
            decision_raw: null,
            decision_at: null,
            state: 'failed',
            last_error: null,
            created_at: now,
            updated_at: now,
          },
        ],
        rowCount: 1,
      };
    }
    // listUnsettledBrackets：只取 armed / failed，形状与 INSERT 的 RETURNING 保持一致。
    if (sql.includes('FROM risk_bracket')) {
      // 三个参数 = 按 entry_order_id 读**一行**（readBracket）：任何状态都要读得到——
      // 结算之后读的是「已终结」的那一行，它正是要算实际盈亏的那一行。
      if (params.length >= 3) {
        const [exchange, symbol, entryOrderId] = params as string[];
        const row = state.claims.get(`${exchange}/${symbol}/${entryOrderId}`);
        if (row === undefined) return { rows: [], rowCount: 0 };
        return {
          rows: [
            {
              exchange,
              symbol: row.symbol,
              entry_order_id: entryOrderId,
              entry_price: 60_000,
              entry_time: 1_000,
              filled_qty: 0.1,
              position_side: row.positionSide,
              atr: 100,
              atr_period: 14,
              atr_interval: '1m',
              atr_window_from: 1,
              atr_window_to: 2,
              stop_price: 59_800,
              take_profit: 60_300,
              tp_algo_id: row.tpOrderId,
              sl_algo_id: row.slOrderId,
              tp1_algo_id: row.tp1AlgoId ?? null,
              tp1_qty: row.tp1Qty ?? null,
              tp1_price: row.tp1Price ?? null,
              tp1_filled_qty: null,
              tp1_filled_at: null,
              trail_extreme: row.trailExtreme ?? null,
              trail_stop_price: row.trailStopPrice ?? null,
              trail_atr: row.trailAtr ?? null,
              trail_atr_from: null,
              trail_atr_to: null,
              trail_updated_at: null,
              trail_last_error: row.trailLastError ?? null,
              closed_qty: row.closedQty ?? 0,
              exit_notional: row.exitNotional ?? 0,
              fee_amount: row.feeAmount ?? 0,
              decision_source: 'config',
              decision_stop_atr_mult: null,
              decision_take_profit_atr_mult: null,
              decision_take_profit1_ratio: null,
              decision_trail_atr_mult: null,
              decision_breakeven_after_tp1: null,
              decision_rationale: null,
              decision_fallback_reason: null,
              decision_raw: null,
              decision_at: null,
              state: row.state,
              last_error: row.lastError,
              created_at: 1_000,
              updated_at: 1_000,
            },
          ],
          rowCount: 1,
        };
      }
      const [exchange, maybeSymbol] = params as string[];
      const rows = [...state.claims.entries()]
        .filter(
          ([key, row]) =>
            key.startsWith(`${exchange}/${row.symbol}/`) &&
            (row.state === 'armed' ||
              row.state === 'partial_armed' ||
              row.state === 'trailing' ||
              row.state === 'failed') &&
            (maybeSymbol === undefined || row.symbol === maybeSymbol),
        )
        .map(([key, row]) => {
          const [, , entryOrderId] = key.split('/');
          return {
            exchange,
            symbol: row.symbol,
            entry_order_id: entryOrderId,
            entry_price: 60_000,
            entry_time: 1_000,
            filled_qty: 0.1,
            position_side: row.positionSide,
            atr: 100,
            atr_period: 14,
            atr_interval: '1m',
            atr_window_from: 1,
            atr_window_to: 2,
            stop_price: 59_800,
            take_profit: 60_300,
            tp_algo_id: row.tpOrderId,
            sl_algo_id: row.slOrderId,
            tp1_algo_id: row.tp1AlgoId ?? null,
            tp1_qty: row.tp1Qty ?? null,
            tp1_price: row.tp1Price ?? null,
            tp1_filled_qty: null,
            tp1_filled_at: row.tp1FilledAt ?? null,
            trail_extreme: row.trailExtreme ?? null,
            trail_stop_price: row.trailStopPrice ?? null,
            trail_atr: row.trailAtr ?? null,
            trail_atr_from: null,
            trail_atr_to: null,
            trail_updated_at: null,
            trail_last_error: row.trailLastError ?? null,
            closed_qty: row.closedQty ?? 0,
            exit_notional: row.exitNotional ?? 0,
            fee_amount: row.feeAmount ?? 0,
            decision_source: 'config',
            decision_stop_atr_mult: null,
            decision_take_profit_atr_mult: null,
            decision_take_profit1_ratio: null,
            decision_trail_atr_mult: null,
            decision_breakeven_after_tp1: null,
            decision_rationale: null,
            decision_fallback_reason: null,
            decision_raw: null,
            decision_at: null,
            state: row.state,
            last_error: row.lastError,
            created_at: 1_000,
            updated_at: 1_000,
          };
        });
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('SET tp_algo_id')) {
      const [exchange, symbol, entryOrderId, tp, sl] = params as (string | number)[];
      const row = state.claims.get(`${exchange}/${symbol}/${entryOrderId}`);
      if (row) Object.assign(row, { tpOrderId: tp, slOrderId: sl, state: 'armed' });
      return { rows: [], rowCount: 1 };
    }
    // v0.9.1：记「第一段止盈已成交」这个事实（幂等：`tp1_filled_at` 非空就不再写）。
    if (sql.includes('tp1_filled_qty = $4')) {
      const [, symbol, entryOrderId, qty, filledAt, , notional, fee] = params as unknown[];
      const row = state.claims.get(key2(symbol, entryOrderId));
      if (row && (row.tp1FilledAt ?? null) === null) {
        Object.assign(row, {
          tp1FilledAt: filledAt as number,
          closedQty: (row.closedQty ?? 0) + Number(qty),
          exitNotional: (row.exitNotional ?? 0) + Number(notional),
          feeAmount: (row.feeAmount ?? 0) + Number(fee),
        });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('SET state = $4')) {
      const [exchange, symbol, entryOrderId, nextState, , qty, notional, fee] = params as (
        string | number
      )[];
      const row = state.claims.get(`${exchange}/${symbol}/${entryOrderId}`);
      if (row) {
        row.state = String(nextState);
        // v0.8.0：平仓的事实要**累加**（实际盈亏从它算）。
        row.closedQty = (row.closedQty ?? 0) + Number(qty ?? 0);
        row.exitNotional = (row.exitNotional ?? 0) + Number(notional ?? 0);
        row.feeAmount = (row.feeAmount ?? 0) + Number(fee ?? 0);
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET state = 'failed'")) {
      return { rows: [], rowCount: 1 };
    }
    // v0.7.0 的阶段流转：把 state 推进并把单号回填，让后续读得到正确形态。
    //
    // ⚠️ 匹配必须盯住 **SET 子句**，不能盯住「SQL 里出现过这个 state 字面量」：
    // 每条 UPDATE 的 WHERE 里也有 state 字面量（`AND state = 'partial_armed'`），
    // 盯字面量会让「推进到 trailing」那条语句被「置为 partial_armed」的分支截走。
    if (sql.includes('SET sl_algo_id = $4, tp1_algo_id = $5')) {
      const [, symbol, entryOrderId, slAlgoId, tp1AlgoId, now] = params as unknown[];
      patch(key2(symbol, entryOrderId), {
        state: 'partial_armed',
        slOrderId: slAlgoId as number,
        tp1AlgoId: tp1AlgoId as number,
        updatedAt: now as number,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET state = 'trailing'")) {
      // from / to 是取数窗口的回传，本替身只记账用得到的字段。
      const [, symbol, entryOrderId, extreme, stopPrice, atr, , , now, slAlgoId] =
        params as unknown[];
      const row = state.claims.get(key2(symbol, entryOrderId));
      // 真库的 WHERE 是 `state = 'partial_armed'`：**只有**还停在这一态才推进。
      if (!row || row.state !== 'partial_armed') return { rows: [], rowCount: 0 };
      patch(key2(symbol, entryOrderId), {
        state: 'trailing',
        trailExtreme: extreme as number,
        trailStopPrice: stopPrice as number,
        trailAtr: atr as number,
        // 真库是 `COALESCE($10, sl_algo_id)`：**没给单号就沿用旧的**。
        ...(slAlgoId === null || slAlgoId === undefined ? {} : { slOrderId: slAlgoId as number }),
        // 真库同时清掉两个错误位（阶段推进了，之前那条失败原因就不成立了）。
        lastError: null,
        trailLastError: null,
        updatedAt: now as number,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('SET trail_stop_price = $4, trail_extreme = $5')) {
      const [, symbol, entryOrderId, stopPrice, extreme, atr, , , now, slAlgoId] =
        params as unknown[];
      const row = state.claims.get(key2(symbol, entryOrderId));
      // 真库的 WHERE 是 `state = 'trailing'`。
      if (!row || row.state !== 'trailing') return { rows: [], rowCount: 0 };
      patch(key2(symbol, entryOrderId), {
        trailStopPrice: stopPrice as number,
        trailExtreme: extreme as number,
        trailAtr: atr as number,
        slOrderId: slAlgoId as number,
        updatedAt: now as number,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('SET trail_last_error = $4')) {
      const [, symbol, entryOrderId, reason, now] = params as unknown[];
      patch(key2(symbol, entryOrderId), {
        trailLastError: String(reason),
        updatedAt: now as number,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('FROM contract_spec')) {
      return {
        rows: [
          {
            raw: {
              filters: [
                { filterType: 'PRICE_FILTER', tickSize: '0.10' },
                // v0.7.0 分批止盈要按数量对齐，缺了 LOT_SIZE 会在算价时就报错。
                { filterType: 'LOT_SIZE', stepSize: '0.001' },
              ],
            },
          },
        ],
        rowCount: 1,
      };
    }
    throw new Error(`未预期的 SQL：${sql}`);
  });
  // pool 只用到 `query`；其余方法用不到也不实现。
  return { state, query, pool: { query } as unknown as Pool };
}

function makeConfig(executor: Record<string, unknown> = {}): TradeToolConfig {
  return configSchema.parse({
    market: { symbol: 'BTCUSDT' },
    executor: { enabled: true, ...executor },
  });
}

/**
 * ATR 夹具。**显式标成 `AtrSnapshot`**：不标的话 `extreme` 会被推断成「非空对象」，
 * 于是「极值取不到」（`extreme: null`）这个用例在类型上就写不出来。
 */
const ATR: AtrSnapshot = {
  symbol: 'BTCUSDT',
  interval: '1m',
  intervalMs: 60_000,
  period: 14,
  atr: 100,
  barsUsed: 200,
  segmentFrom: 1,
  segmentTo: 2,
  asOfMs: 1_000,
  /** 持仓期极值（v0.7.0）。夹具里取「一路涨上去」，于是移动止损只会上移。 */
  extreme: { high: 500, low: 400, from: 1, to: 2 },
  /** 取数范围内最后一根已收盘 K 线的收盘价。 */
  lastClose: 480,
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
    // 手续费（必返字段）：实际盈亏要从毛利里扣它。
    commission: 0.04,
    commissionAsset: 'USDT',
    positionSide: 'BOTH',
    ...overrides,
  };
}

function fakeAtr(overrides: Partial<typeof ATR> = {}): AtrProvider & {
  calls: { symbol: string; asOfMs: number; entryTimeMs: number }[];
} {
  const calls: { symbol: string; asOfMs: number; entryTimeMs: number }[] = [];
  return {
    calls,
    async atrAt(symbol: string, asOfMs: number, entryTimeMs: number) {
      calls.push({ symbol, asOfMs, entryTimeMs });
      return { ...ATR, ...overrides, symbol, asOfMs };
    },
  };
}

interface PlacedOrder {
  type: string;
  stopPrice: number;
  clientAlgoId: string;
  /** 带数量的单才有：分批止盈的第一段。 */
  quantity?: number;
  closePosition: boolean;
}

/**
 * 记录派发出去的告警条目（派发器替身）。
 *
 * 真实的派发器会去解析通道、过滤、去重、推送；这里只关心**「发了什么」**，
 * 过滤与去重的行为由 core 的用例守住。
 */
function fakeAlerts(kinds: string[] = [...NOTIFY_KINDS]): {
  alerts: AlertDispatcher;
  items: AlertItem[];
} {
  const items: AlertItem[] = [];
  const alerts = {
    dispatch: async (build: (channel: AlertChannel) => readonly AlertItem[]) => {
      const channel: AlertChannel = {
        notifier: { enabled: true, notify: async () => undefined },
        kinds,
        repeatCooldownMs: 30 * 60_000,
      };
      items.push(...build(channel));
      return { sent: items.length, suppressed: 0, failed: 0, recovered: 0 };
    },
  } as unknown as AlertDispatcher;
  return { alerts, items };
}

function fakePlacer(overrides: Partial<OrderPlacer> = {}): OrderPlacer & {
  placed: PlacedOrder[];
  cancelled: number[];
  /** 动作发生顺序，用来断言「先挂新、再撤旧」。 */
  actions: string[];
} {
  const placed: PlacedOrder[] = [];
  const cancelled: number[] = [];
  const actions: string[] = [];
  let seq = 900;
  return {
    placed,
    cancelled,
    actions,
    async placeClosePositionOrder(request) {
      placed.push({
        type: request.type,
        stopPrice: request.stopPrice,
        clientAlgoId: request.clientAlgoId,
        closePosition: true,
      });
      actions.push(`place:${request.type}:${request.stopPrice}`);
      seq += 1;
      return {
        algoId: seq,
        clientAlgoId: request.clientAlgoId,
        symbol: request.symbol,
        status: 'NEW',
      };
    },
    async placeQuantityOrder(request) {
      placed.push({
        type: request.type,
        stopPrice: request.stopPrice,
        clientAlgoId: request.clientAlgoId,
        quantity: request.quantity,
        closePosition: false,
      });
      actions.push(`placeQuantity:${request.type}:${request.stopPrice}:${request.quantity}`);
      seq += 1;
      return {
        algoId: seq,
        clientAlgoId: request.clientAlgoId,
        symbol: request.symbol,
        status: 'NEW',
      };
    },
    async cancelAlgoOrder(algoId: number) {
      cancelled.push(algoId);
      actions.push(`cancel:${algoId}`);
    },
    ...overrides,
  };
}

describe('通知：止盈止损挂上与一轮完成（v0.8.0）', () => {
  it('挂上止盈止损 → 通知带预估收益与预估亏损（计价币）', async () => {
    const { alerts, items } = fakeAlerts();
    const service = createExecutorService({
      pool: fakePool().pool,
      config: makeConfig(),
      placer: fakePlacer(),
      atr: fakeAtr(),
      alerts,
    });

    await service.handleFill(fill());

    expect(items).toHaveLength(1);
    // 类型进标题（消息列表里只看得到标题）
    expect(items[0]?.category).toBe('risk');
    expect(items[0]?.title).toContain('止盈 60300');
    expect(items[0]?.title).toContain('止损 59800');
    // 金额单独一段（卡片里加粗）
    const money = (items[0]?.highlights ?? []).join('\n');
    // ATR=100，止损 2 倍、止盈 3 倍，入场 60000 × 0.1 → 收益 30 USDT / 亏损 20 USDT
    expect(money).toContain('预估收益 +30.00 USDT');
    expect(money).toContain('预估亏损 -20.00 USDT');
  });

  it('一轮完成 → 通知带实际盈亏，且**已扣手续费**', async () => {
    const { alerts, items } = fakeAlerts();
    const pool = fakePool();
    const service = createExecutorService({
      pool: pool.pool,
      config: makeConfig(),
      placer: fakePlacer(),
      atr: fakeAtr(),
      alerts,
    });

    await service.handleFill(fill());
    // 我们的止损成交：59800 × 0.1，手续费 0.04
    await service.handleFill(
      fill({
        clientOrderId: bracketClientOrderId('sl', '42'),
        side: 'SELL',
        lastFilledPrice: 59_800,
        lastFilledQty: 0.1,
        commission: 0.04,
      }),
    );

    const settled = items.find((item) => item.category === 'trade');
    expect(settled).toBeDefined();
    // 净盈亏直接进标题：推送预览里就能看到这一轮赚没赚
    expect(settled?.title).toContain('净盈亏 -20.08 USDT');
    const money = (settled?.highlights ?? []).join('\n');
    // 毛利 (59800−60000)×0.1 = −20；手续费 0.04（入场）+ 0.04（出场）= 0.08
    expect(money).toContain('毛利 -20.00 USDT');
    expect(money).toContain('手续费 0.08 USDT');
    expect(money).toContain('净盈亏 -20.08 USDT');
  });

  it('没勾的内容类型不推（过滤用的是这一轮生效的设置）', async () => {
    const { alerts, items } = fakeAlerts(['missing-stop-order']);
    const service = createExecutorService({
      pool: fakePool().pool,
      config: makeConfig(),
      placer: fakePlacer(),
      atr: fakeAtr(),
      alerts,
    });

    await service.handleFill(fill());
    expect(items).toHaveLength(0);
  });
});

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

  it('卖出成交且净仓位仍为多 → 是减仓，不建保护', async () => {
    const placer = fakePlacer();
    const service = createExecutorService({
      pool: fakePool().pool,
      config: makeConfig(),
      placer,
      atr: fakeAtr(),
    });
    // 关键：判据是**净仓位的符号**，不是成交方向。SELL 之后仓位还是正的，
    // 说明这笔只是减了多仓，并没有开出空仓。
    // 先建 0.2 的多仓，再卖 0.1：净额 +0.1 仍为正 → 减仓，不是平仓也不是开空。
    await service.handleFill(fill({ lastFilledQty: 0.2, cumulativeQty: 0.2 }));
    const placedBefore = placer.placed.length;
    expect(await service.handleFill(fill({ side: 'SELL', orderId: 42 }))).toBe('ignored');
    expect(placer.placed).toHaveLength(placedBefore);
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

describe('仓位事实决定开仓 / 减仓 / 平仓', () => {
  it('卖出成交且净仓位转负 → 当作新开空仓，止损止盈挂在入场价上方', async () => {
    const pool = fakePool();
    const placer = fakePlacer();
    const service = createExecutorService({
      pool: pool.pool,
      config: makeConfig({ stopAtrMult: 2, takeProfitAtrMult: 3 }),
      placer,
      atr: fakeAtr(),
    });
    expect(await service.handleFill(fill({ side: 'SELL', orderId: 42 }))).toBe('armed');
    // 平空 = BUY。止损 60000+2×100 = 60200，止盈 60000−3×100 = 59700，
    // 两者都朝远离入场价的方向，与多头完全镜像。
    expect(placer.placed).toEqual([
      expect.objectContaining({ type: 'TAKE_PROFIT_MARKET', stopPrice: 59_700 }),
      expect.objectContaining({ type: 'STOP_MARKET', stopPrice: 60_200 }),
    ]);
    // 入场方向记为 SHORT
    expect(pool.state.claims.get('binance/BTCUSDT/42')?.positionSide).toBe('SHORT');
  });

  it('净持仓归零 → 工具外平仓，未终结记录收敛为 cancelled', async () => {
    const pool = fakePool();
    const service = createExecutorService({
      pool: pool.pool,
      config: makeConfig(),
      placer: fakePlacer(),
      atr: fakeAtr(),
    });
    await service.handleFill(fill());
    expect(pool.state.claims.get('binance/BTCUSDT/42')?.state).toBe('armed');

    // 用户在交易所 App 上按了平仓：SELL 成交，净持仓归零，clientOrderId 不是我们的。
    const outcome = await service.handleFill(
      fill({ side: 'SELL', orderId: 999, clientOrderId: 'manual-close' }),
    );
    expect(outcome).toBe('external-close');
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('SET state = $4'),
      expect.arrayContaining(['cancelled']),
    );
  });

  it('空仓但本地没有未终结记录 → 只是忽略，不凭空造状态', async () => {
    const placer = fakePlacer();
    const positions = new NetPositionTracker();
    const service = createExecutorService({
      pool: fakePool().pool,
      config: makeConfig(),
      placer,
      atr: fakeAtr(),
      positions,
    });
    // 种子已经是 +0.1（模拟重启后从 positionRisk 播种到既有仓位），卖 0.1 后归零。
    // 本地没有任何未终结记录 → 什么都不该写。
    positions.seed('BTCUSDT', 0.1);
    expect(await service.handleFill(fill({ side: 'SELL', orderId: 999 }))).toBe('ignored');
    expect(placer.placed).toHaveLength(0);
  });

  it('同一标的已有未终结保护 → 跳过，不叠第二套 closePosition', async () => {
    const pool = fakePool();
    const placer = fakePlacer();
    const service = createExecutorService({
      pool: pool.pool,
      config: makeConfig(),
      placer,
      atr: fakeAtr(),
    });
    await service.handleFill(fill());
    // 加仓：另一笔订单号，仓位方向一致 → 本该是新开仓，但同一仓位已有保护。
    expect(await service.handleFill(fill({ orderId: 43 }))).toBe('skipped-existing-bracket');
    expect(placer.placed).toHaveLength(2);
  });

  it('ACCOUNT_UPDATE 把本地净额拉到交易所的值，之后的成交以此为基线', async () => {
    const pool = fakePool();
    const service = createExecutorService({
      pool: pool.pool,
      config: makeConfig(),
      placer: fakePlacer(),
      atr: fakeAtr(),
    });
    await service.handleFill(fill());
    // 校正：交易所说是空的（断线期间漏了一笔平仓）。
    await service.correctPositions([{ symbol: 'BTCUSDT', positionAmt: 0, transactionTime: 1_000 }]);
    // 校正只改净额、不动记录：那条 armed 仍在——这是刻意的，
    // 因为「归零」还分不清是止损成交还是手动平仓，抢先收敛会抹掉前者的语义。
    expect(pool.state.claims.get('binance/BTCUSDT/42')?.state).toBe('armed');
    // 重连兜底发生在无在途事件的时刻，这才收敛。
    await service.convergeFlatPositions([{ symbol: 'BTCUSDT' }]);
    expect(pool.state.claims.get('binance/BTCUSDT/42')?.state).toBe('cancelled');
    // 之后的成交以 0 为基线：SELL 0.1 → 净空 0.1 → 新开空仓。
    expect(await service.handleFill(fill({ side: 'SELL', orderId: 77, tradeTime: 2_000 }))).toBe(
      'armed',
    );
    expect(pool.state.claims.get('binance/BTCUSDT/77')?.positionSide).toBe('SHORT');
  });

  it('ACCOUNT_UPDATE 显示归零时**不抢**收敛——那可能是我们自己的止损成交', async () => {
    const pool = fakePool();
    const service = createExecutorService({
      pool: pool.pool,
      config: makeConfig(),
      placer: fakePlacer(),
      atr: fakeAtr(),
    });
    await service.handleFill(fill());

    // 仓位归零了，但**还不知道是谁平的**。若此时抢先置 cancelled，
    // 就会与下面那笔结算并发写同一行，把「止损成交」抹成「工具外平仓」。
    await service.correctPositions([{ symbol: 'BTCUSDT', positionAmt: 0, transactionTime: 1_000 }]);
    expect(pool.state.claims.get('binance/BTCUSDT/42')?.state).toBe('armed');

    // 结算事件随后到达 → 终态必须是 stop_loss，不能是 cancelled。
    const outcome = await service.handleFill(
      fill({
        side: 'SELL',
        orderId: 901,
        clientOrderId: bracketClientOrderId('sl', '42'),
        tradeTime: 1_000,
      }),
    );
    expect(outcome).toBe('settled');
    expect(pool.state.claims.get('binance/BTCUSDT/42')?.state).toBe('stop_loss');
  });

  it('重连兜底：净仓位确为 0 且无在途事件时，才收敛未终结记录', async () => {
    const pool = fakePool();
    const service = createExecutorService({
      pool: pool.pool,
      config: makeConfig(),
      placer: fakePlacer(),
      atr: fakeAtr(),
    });
    await service.handleFill(fill());
    await service.correctPositions([{ symbol: 'BTCUSDT', positionAmt: 0, transactionTime: 1_000 }]);
    expect(pool.state.claims.get('binance/BTCUSDT/42')?.state).toBe('armed');

    await service.convergeFlatPositions([{ symbol: 'BTCUSDT' }]);
    expect(pool.state.claims.get('binance/BTCUSDT/42')?.state).toBe('cancelled');
  });

  it('兜底只处理净仓位确为 0 的标的', async () => {
    const pool = fakePool();
    const service = createExecutorService({
      pool: pool.pool,
      config: makeConfig(),
      placer: fakePlacer(),
      atr: fakeAtr(),
    });
    await service.handleFill(fill());
    await service.convergeFlatPositions([{ symbol: 'BTCUSDT' }]);
    expect(pool.state.claims.get('binance/BTCUSDT/42')?.state).toBe('armed');
  });

  it('ACCOUNT_UPDATE 只覆盖它推了的标的，不当成全量快照', async () => {
    const placer = fakePlacer();
    const service = createExecutorService({
      pool: fakePool().pool,
      config: makeConfig(),
      placer,
      atr: fakeAtr(),
    });
    await service.handleFill(fill({ symbol: 'BTCUSDT' }));
    await service.handleFill(fill({ symbol: 'ETHUSDT', orderId: 43 }));
    // 只校正 BTC：ETH 的本地净额必须原样保留，不能被「重置」掉。
    await service.correctPositions([
      { symbol: 'BTCUSDT', positionAmt: 0.1, transactionTime: 1_000 },
    ]);
    expect(await service.handleFill(fill({ symbol: 'ETHUSDT', orderId: 44 }))).toBe(
      'skipped-existing-bracket',
    );
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

  it('极值取不到（null）时**照样**挂出保护单：刚开仓就是这种情况', async () => {
    // 持仓期里一根已收盘 K 线都没有时极值取不到（Python 侧如实回 null）。
    // 它与「ATR 取不到」严重度不同：ATR 在，价就能算，保护单必须挂出去。
    // 早期实现把两者混成一个码 → 整次取数被当成 ATR 不可用 → **新开仓永远挂不上保护单**。
    const placer = fakePlacer();
    const service = createExecutorService({
      pool: fakePool().pool,
      config: makeConfig({ stopAtrMult: 2, takeProfitAtrMult: 3 }),
      placer,
      atr: fakeAtr({ extreme: null }),
    });
    expect(await service.handleFill(fill())).toBe('armed');
    expect(placer.placed.map((p) => p.type)).toEqual(['TAKE_PROFIT_MARKET', 'STOP_MARKET']);
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
          algoId: 777,
          clientAlgoId: request.clientAlgoId,
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

// ---------------------------------------------------------------------------
// v0.7.0 两段止盈 + 移动止损
// ---------------------------------------------------------------------------

/** 造一份带新策略字段的 resolvePolicy 替身。 */
function stagedPolicy(over: Record<string, number | boolean> = {}) {
  return async () => ({
    atrPeriod: 14,
    atrInterval: '1m',
    stopAtrMult: 2,
    takeProfitAtrMult: 3,
    takeProfit1Ratio: 0.5,
    trailAtrMult: 2,
    breakevenAfterTp1: true,
    source: 'symbol',
    ...over,
  });
}

describe('v0.7.0 两段形态', () => {
  /** 每个用例一份独立依赖：共用假池会让同一笔成交被下一次当成事件重放。 */
  const deps = (
    executor: Record<string, unknown> = {},
    policy: Record<string, number | boolean> = {},
  ) => ({
    pool: fakePool().pool,
    config: makeConfig(executor),
    placer: fakePlacer(),
    atr: fakeAtr(),
    resolvePolicy: stagedPolicy(policy),
  });

  it('比例 0（缺省）：两张 closePosition 单，与 v0.4.0 逐字一致', async () => {
    const d = deps({}, { takeProfit1Ratio: 0 });
    const service = createExecutorService(d);
    expect(await service.handleFill(fill())).toBe('armed');
    const cp = d.placer;
    expect(cp.placed).toHaveLength(2);
    expect(cp.placed.every((o) => o.closePosition)).toBe(true);
    expect(cp.placed.some((o) => o.quantity !== undefined)).toBe(false);
  });

  it('比例 100%：一次性全平，仍用 closePosition（交易所继续自动撤单）', async () => {
    const d = deps({ takeProfit1Ratio: 1 }, { takeProfit1Ratio: 1 });
    const { placer } = d;
    const service = createExecutorService(d);
    expect(await service.handleFill(fill())).toBe('armed');
    expect(placer.placed).toHaveLength(2);
    // 关键：100% **不**用带数量的单，因此自动撤单的保证一分不丢
    expect(placer.placed.every((o) => o.closePosition)).toBe(true);
    expect(placer.placed.some((o) => o.quantity !== undefined)).toBe(false);
  });

  it('比例 100%：归一到 0，因此与「不分批」逐字相同（一次全平）', async () => {
    const fake = fakePool();
    const d = { ...deps({ takeProfit1Ratio: 1 }, { takeProfit1Ratio: 1 }), pool: fake.pool };
    const { placer } = d;
    const service = createExecutorService(d);
    expect(await service.handleFill(fill())).toBe('armed');

    const tp = placer.placed.find((o) => o.type === 'TAKE_PROFIT_MARKET');
    // 归一到「不分批」：全平单，价格 = 入场 60000 + 3×ATR(100) = 60300。
    expect(tp?.stopPrice).toBe(60_300);
    expect(tp?.closePosition).toBe(true);
    // 落库的 `take_profit` 必须是**同一个价**：页面显示的「止盈价」要能拿去和交易所
    // 对照，显示一个从没挂出去的价格会让人以为仓位其实没保护。
    expect(fake.state.claims.get('binance/BTCUSDT/42')?.takeProfit).toBe(60_300);
  });

  it('比例 50%：止盈带数量 + reduceOnly，止损仍是 closePosition 且不带数量', async () => {
    const d = deps();
    const { placer } = d;
    const service = createExecutorService(d);
    expect(await service.handleFill(fill())).toBe('armed');
    expect(placer.placed).toHaveLength(2);
    const tp = placer.placed.find((o) => o.type === 'TAKE_PROFIT_MARKET');
    const sl = placer.placed.find((o) => o.type === 'STOP_MARKET');
    expect(tp?.closePosition).toBe(false);
    expect(tp?.quantity).toBeGreaterThan(0);
    expect(sl?.closePosition).toBe(true);
    expect(sl?.quantity).toBeUndefined();
  });

  it('两张单要么都挂上要么都不挂：分批形态下第一张失败就回滚', async () => {
    const d = deps();
    const placer = d.placer;
    const service = createExecutorService({
      ...d,
      placer: fakePlacer({
        async placeQuantityOrder() {
          throw new SyncError('EXCHANGE_ERROR', '模拟第一段挂单失败');
        },
      }),
    });
    expect(await service.handleFill(fill())).toBe('failed');
    expect(placer.cancelled).toEqual([]);
  });
});

describe('移动止损：极值取不到时（R-6.5）', () => {
  it('本轮**不移动**止损，保留上一档，并留下可见原因——它不是「本轮失败」', async () => {
    const fake = fakePool();
    fake.state.claims.set('binance/BTCUSDT/42', {
      symbol: 'BTCUSDT',
      positionSide: 'LONG',
      takeProfit: 60_300,
      tpOrderId: 11,
      slOrderId: 12,
      state: 'trailing',
      lastError: null,
      trailStopPrice: 59_800,
      trailExtreme: 60_000,
      trailAtr: 100,
    });
    const placer = fakePlacer();
    const service = createExecutorService({
      pool: fake.pool,
      config: makeConfig(),
      placer,
      atr: fakeAtr({ extreme: null }),
    });

    const report = await service.trailOnce();
    // 不动 ≠ 失败：仓位仍受上一档止损保护，只是这一轮不调整。
    expect(report.unchanged).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.moved).toBe(0);
    expect(placer.placed).toHaveLength(0);

    const row = fake.state.claims.get('binance/BTCUSDT/42');
    // 原因必须可见（trail_last_error）：「看起来正常、而移动止损其实没动过」是同一件事的两面。
    expect(row?.trailLastError).toContain('极值取不到');
    // 档位没动
    expect(row?.trailStopPrice).toBe(59_800);
  });
});

// ---------------------------------------------------------------------------
// v0.9.1：第一段止盈成交之后——成交事实、阶段推进、止损真的挪档
// ---------------------------------------------------------------------------

/**
 * 一个「行情涨了一点」的 ATR 夹具。
 *
 * 默认夹具的 `lastClose` 是 480（比入场价低太多），于是每一档算出来的止损位都会
 * 「越过现价」，移动止损永远不动。要测「往上挪」，现价必须**高于**入场价。
 */
const ATR_UP = {
  extreme: { high: 60_100, low: 59_500, from: 1, to: 2 },
  lastClose: 60_100,
} as const;

describe('v0.9.1：第一段止盈成交之后', () => {
  it('成交事实落库 + 阶段推进 + 止损真的挪到保本位（先挂新、再撤旧）', async () => {
    const fake = fakePool();
    const placer = fakePlacer();
    const service = createExecutorService({
      pool: fake.pool,
      config: makeConfig(),
      placer,
      atr: fakeAtr(ATR_UP),
      resolvePolicy: stagedPolicy(),
    });

    // 先开仓：分批形态 → 两张单挂上，记录停在 `partial_armed`。
    expect(await service.handleFill(fill())).toBe('armed');
    const before = fake.state.claims.get('binance/BTCUSDT/42');
    expect(before?.state).toBe('partial_armed');
    const entrySlId = before?.slOrderId;
    expect(entrySlId).not.toBeNull();

    // 第一段止盈成交（带数量的那张）。
    const outcome = await service.handleFill(
      fill({
        clientOrderId: bracketClientOrderId('tp', '42'),
        side: 'SELL',
        lastFilledPrice: 60_300,
        lastFilledQty: 0.05,
        commission: 0.02,
      }),
    );
    expect(outcome).toBe('trailing');

    const row = fake.state.claims.get('binance/BTCUSDT/42');
    // ① 成交这个**事实**落库了（盈亏要靠它算，重投事件不会重复算）。
    expect(row?.tp1FilledAt).not.toBeNull();
    expect(row?.closedQty).toBeCloseTo(0.05, 10);
    expect(row?.exitNotional).toBeCloseTo(60_300 * 0.05, 6);
    expect(row?.feeAmount).toBeCloseTo(0.06, 10); // 入场 0.04 + 这一段 0.02
    // ② 阶段推进到移动止损。
    expect(row?.state).toBe('trailing');
    // ③ 止损**真的挪到了保本位**（入场价 60000），并回填了新的单号。
    expect(row?.trailStopPrice).toBe(60_000);
    expect(row?.slOrderId).not.toBe(entrySlId);
    // 顺序：先挂新、再撤旧（R-4.1）。
    expect(placer.actions.slice(-2)).toEqual(['place:STOP_MARKET:60000', `cancel:${entrySlId}`]);
  });

  it('定时器把「TP1 成交了但没推进成功」的行推进成 trailing，并把止损挪到保本位', async () => {
    const fake = fakePool();
    fake.state.claims.set('binance/BTCUSDT/42', {
      symbol: 'BTCUSDT',
      positionSide: 'LONG',
      takeProfit: 60_300,
      tpOrderId: 11,
      slOrderId: 12,
      state: 'partial_armed',
      lastError: null,
      tp1AlgoId: 11,
      tp1Qty: 0.05,
      tp1Price: 60_300,
      // 关键：第一段**已经成交**（当时推进失败，卡在这一态）。
      tp1FilledAt: 1_500,
      trailLastError: '推进移动止损失败：持仓期极值取不到',
    });
    const placer = fakePlacer();
    const service = createExecutorService({
      pool: fake.pool,
      config: makeConfig(),
      placer,
      atr: fakeAtr(ATR_UP),
      resolvePolicy: stagedPolicy(),
    });

    const report = await service.trailOnce();
    expect(report.advanced).toBe(1);
    expect(report.moved).toBe(1);
    expect(report.failed).toBe(0);

    const row = fake.state.claims.get('binance/BTCUSDT/42');
    expect(row?.state).toBe('trailing');
    // 挪到保本位 60000（原来停在进场的 59800）。
    expect(row?.trailStopPrice).toBe(60_000);
    // 进场那张止损单被撤掉，换成新的那张。
    expect(placer.cancelled).toEqual([12]);
    expect(placer.actions).toEqual(['place:STOP_MARKET:60000', 'cancel:12']);
    // 这一格补上了，之前那条失败原因就不该再挂着。
    expect(row?.trailLastError).toBeNull();
  });

  it('「TP1 还没成交」的行不动：那是进场保护，不是移动止损该管的', async () => {
    const fake = fakePool();
    fake.state.claims.set('binance/BTCUSDT/42', {
      symbol: 'BTCUSDT',
      positionSide: 'LONG',
      takeProfit: 60_300,
      tpOrderId: 11,
      slOrderId: 12,
      state: 'partial_armed',
      lastError: null,
      tp1AlgoId: 11,
      tp1Qty: 0.05,
      tp1Price: 60_300,
      // 第一段**还没成交** → `tp1_filled_at` 为空。
    });
    const placer = fakePlacer();
    const service = createExecutorService({
      pool: fake.pool,
      config: makeConfig(),
      placer,
      atr: fakeAtr(ATR_UP),
      resolvePolicy: stagedPolicy(),
    });

    const report = await service.trailOnce();
    expect(report.advanced).toBe(0);
    expect(report.moved).toBe(0);
    expect(placer.placed).toHaveLength(0);
    expect(fake.state.claims.get('binance/BTCUSDT/42')?.state).toBe('partial_armed');
  });

  it('撤旧失败：不推进档位（账面以旧档为准），但原因常驻可见', async () => {
    const fake = fakePool();
    fake.state.claims.set('binance/BTCUSDT/42', {
      symbol: 'BTCUSDT',
      positionSide: 'LONG',
      takeProfit: 60_300,
      tpOrderId: 11,
      slOrderId: 12,
      state: 'partial_armed',
      lastError: null,
      tp1AlgoId: 11,
      tp1Qty: 0.05,
      tp1Price: 60_300,
      tp1FilledAt: 1_500,
    });
    const placer = fakePlacer({
      async cancelAlgoOrder(): Promise<void> {
        throw new SyncError('EXCHANGE_ERROR', '模拟撤单失败');
      },
    });
    const service = createExecutorService({
      pool: fake.pool,
      config: makeConfig(),
      placer,
      atr: fakeAtr(ATR_UP),
      resolvePolicy: stagedPolicy(),
    });

    const report = await service.trailOnce();
    expect(report.failed).toBe(1);
    expect(report.moved).toBe(0);

    const row = fake.state.claims.get('binance/BTCUSDT/42');
    // 阶段推进了（可修），但档位没推进（保守：账面以旧档为准）。
    expect(row?.state).toBe('trailing');
    expect(row?.trailStopPrice).toBe(59_800);
    // 「新单已挂上、旧单撤不掉」这件事必须看得见。
    expect(row?.trailLastError).toContain('撤旧止损失败');
  });
});
