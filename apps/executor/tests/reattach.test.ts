/**
 * 手动补挂止盈止损的**编排**测试（全部用替身：不连 PG、不出网）。
 *
 * 锁的是四条最容易出错、而错了就会**动真钱**的规矩：
 *
 * 1. **演练不挂单**：`dryRun` 之下不得发出任何下单请求。
 * 2. **占坑在下单之前**：先占坑再动手。反过来的话，交易所上会留下一张没人认领的单。
 * 3. **复现优先**：已有记录时价格**原样取自记录**，不重新算一遍。
 * 4. **会立刻触发就拒绝**：止损/止盈挂错一侧等于用市价平掉仓位，必须拒。
 */

import { configSchema, type TradeToolConfig } from '@trade-tool/core';
import type { BinancePrivateClient, Pool } from '@trade-tool/data';
import { describe, expect, it, vi } from 'vitest';

import type { AtrProvider, AtrSnapshot } from '../src/atr.js';
import { createReattacher } from '../src/reattach.js';

const NOW = 1_760_000_000_000;

/** 配置：只需要补挂用到的那些字段。 */
function makeConfig(): TradeToolConfig {
  const parsed = configSchema.safeParse({
    market: { exchange: 'binance', symbol: 'BTCUSDT' },
    executor: { enabled: true },
  });
  if (!parsed.success) throw new Error(`配置不合法：${parsed.error.message}`);
  return parsed.data;
}

/** 库里的一行（字段名跟真表一致）。 */
interface FakeRow {
  symbol: string;
  entryOrderId: string;
  positionSide: string;
  entryPrice: number;
  entryTime: number;
  filledQty: number;
  atr: number;
  atrPeriod: number;
  atrInterval: string;
  atrWindowFrom: number;
  atrWindowTo: number;
  stopPrice: number;
  takeProfit: number;
  tpAlgoId: number | null;
  slAlgoId: number | null;
  tp1AlgoId: number | null;
  tp1Qty: number | null;
  tp1Price: number | null;
  tp1FilledAt: number | null;
  trailExtreme: number | null;
  trailStopPrice: number | null;
  trailAtr: number | null;
  trailAtrFrom: number | null;
  trailAtrTo: number | null;
  trailStep: number;
  trailMoves: number;
  trailStatus: string;
  state: string;
  lastError: string | null;
  decisionSource: string;
  decisionStopAtrMult: number | null;
  decisionTakeProfitAtrMult: number | null;
  decisionTakeProfit1Ratio: number | null;
}

function row(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    symbol: 'BTCUSDT',
    entryOrderId: '1001',
    positionSide: 'LONG',
    entryPrice: 100,
    entryTime: NOW - 3600_000,
    filledQty: 2,
    atr: 2,
    atrPeriod: 14,
    atrInterval: '15m',
    atrWindowFrom: NOW - 7200_000,
    atrWindowTo: NOW - 3600_000,
    stopPrice: 96,
    takeProfit: 108,
    tpAlgoId: null,
    slAlgoId: null,
    tp1AlgoId: null,
    tp1Qty: null,
    tp1Price: null,
    tp1FilledAt: null,
    trailExtreme: null,
    trailStopPrice: null,
    trailAtr: null,
    trailAtrFrom: null,
    trailAtrTo: null,
    trailStep: 0,
    trailMoves: 0,
    trailStatus: 'idle',
    state: 'failed',
    lastError: '挂单失败',
    decisionSource: 'config',
    decisionStopAtrMult: 2,
    decisionTakeProfitAtrMult: 4,
    decisionTakeProfit1Ratio: 0,
    ...overrides,
  };
}

/** 假库：只实现补挂这条路用到的几条 SQL。 */
function fakePool(initial: FakeRow[] = []) {
  const rows = new Map<string, FakeRow>();
  for (const r of initial) rows.set(`${r.symbol}/${r.entryOrderId}`, r);

  const query = vi.fn(async (sql: string, params: unknown[]) => {
    const p = params as unknown[];
    if (sql.includes('INSERT INTO risk_bracket')) {
      const symbol = String(p[1]);
      const entryOrderId = String(p[2]);
      const key = `${symbol}/${entryOrderId}`;
      if (rows.has(key)) return { rows: [], rowCount: 0 };
      const created: FakeRow = row({
        symbol,
        entryOrderId,
        positionSide: String(p[6]),
        entryPrice: Number(p[3]),
        entryTime: Number(p[4]),
        filledQty: Number(p[5]),
        atr: Number(p[7]),
        atrPeriod: Number(p[8]),
        atrInterval: String(p[9]),
        atrWindowFrom: Number(p[10]),
        atrWindowTo: Number(p[11]),
        stopPrice: Number(p[12]),
        takeProfit: Number(p[13]),
        state: 'failed',
        lastError: null,
      });
      rows.set(key, created);
      return { rows: [toDbRow(created)], rowCount: 1 };
    }
    if (sql.includes('SELECT') && sql.includes('FROM contract_spec')) {
      // 合约规格的原始条目：算价要按 tick 对齐。
      return {
        rows: [
          {
            raw: {
              symbol: 'BTCUSDT',
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
    if (sql.includes('SELECT') && sql.includes('FROM risk_bracket')) {
      const symbol = p.length >= 2 ? String(p[1]) : null;
      const list = [...rows.values()].filter((r) => symbol === null || r.symbol === symbol);
      return { rows: list.map(toDbRow), rowCount: list.length };
    }
    if (sql.includes('tp1_filled_qty = $4')) {
      // recordBracketTp1Fill：落「第一段止盈已成交」这个事实（幂等）。
      const r = rows.get(`${String(p[1])}/${String(p[2])}`);
      if (r === undefined || r.tp1FilledAt !== null) return { rows: [], rowCount: 0 };
      r.tp1FilledAt = Number(p[4]);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('trail_step = trail_step + 1')) {
      const key = `${String(p[1])}/${String(p[2])}`;
      const r = rows.get(key);
      if (r === undefined) return { rows: [], rowCount: 0 };
      r.trailStep += 1;
      return { rows: [{ trail_step: r.trailStep }], rowCount: 1 };
    }
    if (sql.includes("state = 'armed'")) {
      const r = rows.get(`${String(p[1])}/${String(p[2])}`);
      if (r === undefined) return { rows: [], rowCount: 0 };
      r.tpAlgoId = Number(p[3]);
      r.slAlgoId = Number(p[4]);
      r.state = 'armed';
      r.lastError = null;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("state = 'partial_armed'")) {
      const r = rows.get(`${String(p[1])}/${String(p[2])}`);
      if (r === undefined) return { rows: [], rowCount: 0 };
      r.slAlgoId = Number(p[3]);
      r.tp1AlgoId = Number(p[4]);
      r.state = 'partial_armed';
      r.lastError = null;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("state = 'failed'")) {
      const r = rows.get(`${String(p[1])}/${String(p[2])}`);
      if (r === undefined) return { rows: [], rowCount: 0 };
      r.state = 'failed';
      r.lastError = String(p[3]);
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('stop_price = $4')) {
      // updateBracketPlan：把新算出来的计划写回去。
      const r = rows.get(`${String(p[1])}/${String(p[2])}`);
      if (r === undefined) return { rows: [], rowCount: 0 };
      r.stopPrice = Number(p[3]);
      r.takeProfit = Number(p[4]);
      r.tp1Price = p[5] === null ? null : Number(p[5]);
      r.tp1Qty = p[6] === null ? null : Number(p[6]);
      r.atr = Number(p[7]);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  return { rows, query, pool: { query } as unknown as Pool };
}

/** 一行 → 读侧认识的列形状。 */
function toDbRow(r: FakeRow): Record<string, unknown> {
  return {
    exchange: 'binance',
    symbol: r.symbol,
    entry_order_id: r.entryOrderId,
    entry_price: r.entryPrice,
    entry_time: r.entryTime,
    filled_qty: r.filledQty,
    position_side: r.positionSide,
    atr: r.atr,
    atr_period: r.atrPeriod,
    atr_interval: r.atrInterval,
    atr_window_from: r.atrWindowFrom,
    atr_window_to: r.atrWindowTo,
    stop_price: r.stopPrice,
    take_profit: r.takeProfit,
    tp_algo_id: r.tpAlgoId,
    sl_algo_id: r.slAlgoId,
    state: r.state,
    last_error: r.lastError,
    tp1_algo_id: r.tp1AlgoId,
    tp1_qty: r.tp1Qty,
    tp1_price: r.tp1Price,
    tp1_filled_qty: null,
    tp1_filled_at: r.tp1FilledAt,
    trail_extreme: r.trailExtreme,
    trail_stop_price: r.trailStopPrice,
    trail_atr: r.trailAtr,
    trail_atr_from: r.trailAtrFrom,
    trail_atr_to: r.trailAtrTo,
    trail_updated_at: null,
    trail_last_error: null,
    trail_step: r.trailStep,
    trail_moves: r.trailMoves,
    trail_status: r.trailStatus,
    decision_source: r.decisionSource,
    decision_stop_atr_mult: r.decisionStopAtrMult,
    decision_take_profit_atr_mult: r.decisionTakeProfitAtrMult,
    decision_take_profit1_ratio: r.decisionTakeProfit1Ratio,
    decision_trail_atr_mult: null,
    decision_breakeven_after_tp1: null,
    decision_rationale: null,
    decision_fallback_reason: null,
    decision_raw: null,
    decision_at: null,
    closed_qty: 0,
    exit_notional: 0,
    fee_amount: 0,
    fee_asset: null,
    fee_fx_rate: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

const ATR: AtrSnapshot = {
  symbol: 'BTCUSDT',
  interval: '15m',
  intervalMs: 900_000,
  period: 14,
  atr: 2,
  barsUsed: 100,
  segmentFrom: NOW - 7200_000,
  segmentTo: NOW - 3600_000,
  asOfMs: NOW,
  extreme: null,
  lastClose: 102,
};

function fakeAtr(): AtrProvider {
  return {
    atrAt: vi.fn(async () => ATR),
  };
}

/** 交易所私有接口的替身。 */
function fakeClient(options: {
  positionAmt?: number;
  entryPrice?: number;
  markPrice?: number | null;
  algoOrders?: { clientAlgoId: string; orderType: string; algoId: number; triggerPrice: number }[];
}) {
  const positionAmt = options.positionAmt ?? 2;
  return {
    positionRisk: vi.fn(async () => [
      {
        symbol: 'BTCUSDT',
        positionSide: 'BOTH',
        positionAmt,
        entryPrice: options.entryPrice ?? 100,
        markPrice: options.markPrice === undefined ? 102 : options.markPrice,
        updateTime: NOW,
      },
    ]),
    openAlgoOrders: vi.fn(async () =>
      (options.algoOrders ?? []).map((o) => ({
        algoId: o.algoId,
        clientAlgoId: o.clientAlgoId,
        algoType: 'CONDITIONAL',
        orderType: o.orderType,
        symbol: 'BTCUSDT',
        side: 'SELL',
        positionSide: 'BOTH',
        algoStatus: 'NEW',
        triggerPrice: o.triggerPrice,
        closePosition: true,
        quantity: null,
        createTime: NOW,
        updateTime: NOW,
      })),
    ),
    markPrice: vi.fn(async () => (options.markPrice === undefined ? 102 : options.markPrice)),
  };
}

/** 下单替身：记下每一次调用。 */
function fakePlacer(options: { failOn?: 'tp' | 'sl' } = {}) {
  const calls: { kind: string; price: number; clientAlgoId: string }[] = [];
  let seq = 100;
  const placer = {
    placeClosePositionOrder: vi.fn(
      async (req: { type: string; stopPrice: number; clientAlgoId: string }) => {
        const kind = req.type === 'STOP_MARKET' ? 'sl' : 'tp';
        if (options.failOn === kind) throw new Error('交易所拒绝了这张单');
        calls.push({ kind, price: req.stopPrice, clientAlgoId: req.clientAlgoId });
        seq += 1;
        return { algoId: seq, clientAlgoId: req.clientAlgoId, symbol: 'BTCUSDT', status: 'NEW' };
      },
    ),
    placeQuantityOrder: vi.fn(
      async (req: { type: string; stopPrice: number; clientAlgoId: string; quantity: number }) => {
        calls.push({ kind: 'tp1', price: req.stopPrice, clientAlgoId: req.clientAlgoId });
        seq += 1;
        return { algoId: seq, clientAlgoId: req.clientAlgoId, symbol: 'BTCUSDT', status: 'NEW' };
      },
    ),
    cancelAlgoOrder: vi.fn(async () => undefined),
  };
  return { placer, calls };
}

function depsOf(options: {
  pool: ReturnType<typeof fakePool>;
  client: ReturnType<typeof fakeClient>;
  placer: ReturnType<typeof fakePlacer>['placer'];
}) {
  return {
    pool: options.pool.pool,
    config: makeConfig(),
    client: options.client as unknown as BinancePrivateClient,
    placer: options.placer,
    atr: fakeAtr(),
    now: () => NOW,
  };
}

describe('createReattacher', () => {
  it('演练：一单都不挂，但要说清楚会挂什么', async () => {
    const pool = fakePool();
    const client = fakeClient({});
    const { placer, calls } = fakePlacer();
    const reattacher = createReattacher(depsOf({ pool, client, placer }));

    const report = await reattacher.run('BTCUSDT', { dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.placed).toBe(0);
    expect(calls).toHaveLength(0);
    expect(report.details[0]?.outcome).toBe('dry-run');
    // 裸仓：本地没有记录 → 要补止盈 + 止损。
    expect(report.details[0]?.reason).toContain('止盈');
  });

  it('裸仓：先占坑再挂单，挂上后回填单号', async () => {
    const pool = fakePool();
    const client = fakeClient({});
    const { placer, calls } = fakePlacer();
    const reattacher = createReattacher(depsOf({ pool, client, placer }));

    const report = await reattacher.run('BTCUSDT');
    expect(report.placed).toBe(1);
    expect(calls.map((c) => c.kind).sort()).toEqual(['sl', 'tp']);
    // 占坑的那一行：状态已经是 armed，单号已回填。
    const claimed = [...pool.rows.values()][0];
    expect(claimed?.state).toBe('armed');
    expect(claimed?.tpAlgoId).not.toBeNull();
    expect(claimed?.slAlgoId).not.toBeNull();
    // 入场单号是人工补挂自己起的（不会与真实订单号撞上）。
    expect(claimed?.entryOrderId).toMatch(/^manual-/);
  });

  it('failed 记录：价格原样复现记录里的，不重新算', async () => {
    const pool = fakePool([row({ stopPrice: 91, takeProfit: 115 })]);
    const client = fakeClient({});
    const { placer, calls } = fakePlacer();
    const reattacher = createReattacher(depsOf({ pool, client, placer }));

    const report = await reattacher.run('BTCUSDT');
    expect(report.placed).toBe(1);
    // 记录里写的是 91 / 115；ATR 若被重新算过（ATR=2、2×/4×）会得到别的价。
    const stop = calls.find((c) => c.kind === 'sl');
    const tp = calls.find((c) => c.kind === 'tp');
    expect(stop?.price).toBe(91);
    expect(tp?.price).toBe(115);
  });

  it('挂上去会立刻以市价平掉 → 拒绝，一单都不挂', async () => {
    const pool = fakePool([row({ stopPrice: 96, takeProfit: 108 })]);
    // 现价 95 已经跌穿止损 96：那张单挂上去会立刻市价平仓。
    const client = fakeClient({ markPrice: 95 });
    const { placer, calls } = fakePlacer();
    const reattacher = createReattacher(depsOf({ pool, client, placer }));

    const report = await reattacher.run('BTCUSDT');
    expect(calls).toHaveLength(0);
    expect(report.placed).toBe(0);
    // 「拒绝补挂」走**专门的** `refusal` 字段（与「不需要补挂」是两回事），
    // 而且它必须是人能读懂的理由。
    expect(report.refusal).toContain('错误一侧');
    expect(report.details).toHaveLength(0);
  });

  it('下单失败 → 记录记 failed 并留下原因（不留痕最坑）', async () => {
    const pool = fakePool([row()]);
    const client = fakeClient({});
    const { placer } = fakePlacer({ failOn: 'sl' });
    const reattacher = createReattacher(depsOf({ pool, client, placer }));

    const report = await reattacher.run('BTCUSDT');
    expect(report.placed).toBe(0);
    expect(report.details[0]?.outcome).toBe('failed');
    const claimed = [...pool.rows.values()][0];
    expect(claimed?.state).toBe('failed');
    expect(claimed?.lastError).toContain('交易所拒绝了这张单');
  });

  it('交易所上没有仓位 → 不补挂（补了会留下没人认领的单）', async () => {
    const pool = fakePool([row()]);
    const client = fakeClient({ positionAmt: 0 });
    const { placer, calls } = fakePlacer();
    const reattacher = createReattacher(depsOf({ pool, client, placer }));

    const report = await reattacher.run('BTCUSDT');
    expect(calls).toHaveLength(0);
    expect(report.placed).toBe(0);
    expect(report.skips[0]?.reason).toContain('已无该标的仓位');
  });

  it('armed 记录只缺止损 → 只挂止损那张，另一张的单号**沿用记录里的**', async () => {
    // 止盈单还在交易所上（clientAlgoId 'rsk-tp-1001'），止损不见了。
    const pool = fakePool([row({ state: 'armed', tpAlgoId: 11, slAlgoId: null, lastError: null })]);
    const client = fakeClient({
      algoOrders: [
        { clientAlgoId: 'rsk-tp-1001', orderType: 'TAKE_PROFIT', algoId: 11, triggerPrice: 108 },
      ],
    });
    const { placer, calls } = fakePlacer();
    const reattacher = createReattacher(depsOf({ pool, client, placer }));

    const report = await reattacher.run('BTCUSDT');
    // **只挂止损**：止盈已经挂着了，再挂一张就是两套保护互相触发。
    expect(calls.map((c) => c.kind)).toEqual(['sl']);
    expect(report.placed).toBe(1);
    const stored = [...pool.rows.values()][0];
    expect(stored?.state).toBe('armed');
    // 止盈的单号不能被抹掉——它还在交易所上保护仓位。
    expect(stored?.tpAlgoId).toBe(11);
    expect(stored?.slAlgoId).not.toBeNull();
  });

  it('第一段止盈已成交、而库里没记 → 只补止损，并把「已成交」这个事实补记进库', async () => {
    // 库里 tp1_filled_at 是空的（executor 不在时成交的），交易所的仓位少了那一段。
    const pool = fakePool([
      row({
        state: 'partial_armed',
        tpAlgoId: null,
        slAlgoId: null,
        tp1AlgoId: 11,
        tp1Price: 106,
        tp1Qty: 1,
        tp1FilledAt: null,
        lastError: null,
      }),
    ]);
    const client = fakeClient({ positionAmt: 1 });
    const { placer, calls } = fakePlacer();
    const reattacher = createReattacher(depsOf({ pool, client, placer }));

    const report = await reattacher.run('BTCUSDT');
    // **绝不重复挂第一段止盈**（它成交后本来就会消失，再挂一张就是重复减仓）。
    expect(calls.map((c) => c.kind)).toEqual(['sl']);
    expect(report.placed).toBe(1);
    // 「第一段成交过」这个事实补记进库 —— 不补记的话，对账一直报假警报，
    // 而移动止损也永远不会接手这一笔（它只认 tp1_filled_at 非空的行）。
    const stored = [...pool.rows.values()][0];
    expect(stored?.tp1FilledAt).not.toBeNull();
    expect(report.tp1FillRecorded).toContain('第一段止盈确实成交过');
  });

  it('演练：已成交的事实**不补记**（演练不改任何状态）', async () => {
    const pool = fakePool([
      row({
        state: 'partial_armed',
        tpAlgoId: null,
        slAlgoId: null,
        tp1AlgoId: 11,
        tp1Price: 106,
        tp1Qty: 1,
        tp1FilledAt: null,
        lastError: null,
      }),
    ]);
    const client = fakeClient({ positionAmt: 1 });
    const { placer, calls } = fakePlacer();
    const reattacher = createReattacher(depsOf({ pool, client, placer }));

    const report = await reattacher.run('BTCUSDT', { dryRun: true });
    expect(calls).toHaveLength(0);
    expect(report.tp1FillRecorded).toBeNull();
    const stored = [...pool.rows.values()][0];
    expect(stored?.tp1FilledAt).toBeNull();
  });

  it('仓位数量与记录对不上 → 拒绝补挂，一单都不挂，也不改任何状态', async () => {
    const pool = fakePool([
      row({
        state: 'partial_armed',
        tpAlgoId: null,
        slAlgoId: null,
        tp1AlgoId: 11,
        tp1Price: 106,
        tp1Qty: 1,
        tp1FilledAt: null,
        lastError: null,
      }),
    ]);
    const client = fakeClient({ positionAmt: 1.5 });
    const { placer, calls } = fakePlacer();
    const reattacher = createReattacher(depsOf({ pool, client, placer }));

    const report = await reattacher.run('BTCUSDT');
    expect(calls).toHaveLength(0);
    expect(report.placed).toBe(0);
    // 「拒绝补挂」走专门的字段，与「不需要补挂」是两回事。
    expect(report.refusal).toContain('对不上');
    const stored = [...pool.rows.values()][0];
    expect(stored?.tp1FilledAt).toBeNull();
  });
});
