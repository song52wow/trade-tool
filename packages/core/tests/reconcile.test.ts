/**
 * 交易对账判据的测试（纯函数，不连 PG、不出网）。
 *
 * 锁的是**每一种漂移各自被认出来，且认成正确的严重度**——判据写错的后果不是报多报少，
 * 而是把「仓位当前没有止损」和「止盈单没了」判成同一件事，于是最要紧的那种被淹掉。
 *
 * 另外锁两条硬约束：
 *   * **纯函数**：同一输入必须给出同一输出（顺序也稳定）；
 *   * **只报告**：判据不产生任何副作用，它连时钟都不读（`checkedAt` 由调用方注入）。
 */

import {
  reconcileBrackets,
  type ExchangeAlgoOrder,
  type ExchangePosition,
  type LocalBracket,
} from '@trade-tool/core';
import { describe, expect, it } from 'vitest';

const NOW = 1_760_000_000_000;

function record(overrides: Partial<LocalBracket> = {}): LocalBracket {
  return {
    symbol: 'AAAUSDT',
    entryOrderId: '1001',
    positionSide: 'LONG',
    entryPrice: 100,
    filledQty: 2,
    stopPrice: 96,
    takeProfit: 108,
    tpAlgoId: 11,
    slAlgoId: 12,
    tp1AlgoId: null,
    tp1Price: null,
    tp1FilledAt: null,
    trailStopPrice: null,
    state: 'armed',
    lastError: null,
    updatedAt: NOW,
    ...overrides,
  };
}

/** `trailing` 记录：只剩一张止损，且它已经挪过档。 */
function trailing(overrides: Partial<LocalBracket> = {}): LocalBracket {
  return record({
    state: 'trailing',
    // 仓位已经只剩第一段剩下的那一半，TP1 成交后交易所不再有止盈单
    filledQty: 1,
    trailStopPrice: 104,
    slAlgoId: 12,
    ...overrides,
  });
}

function algo(overrides: Partial<ExchangeAlgoOrder> = {}): ExchangeAlgoOrder {
  return {
    algoId: 12,
    clientAlgoId: 'rsk-sl-1001',
    algoType: 'CONDITIONAL',
    // 查询侧官方回的就是 TAKE_PROFIT / STOP，不是 *_MARKET。
    orderType: 'STOP',
    symbol: 'AAAUSDT',
    side: 'SELL',
    positionSide: 'BOTH',
    algoStatus: 'NEW',
    triggerPrice: 96,
    closePosition: true,
    quantity: null,
    createTime: NOW - 1000,
    updateTime: NOW - 1000,
    ...overrides,
  };
}

function position(overrides: Partial<ExchangePosition> = {}): ExchangePosition {
  return {
    symbol: 'AAAUSDT',
    positionSide: 'BOTH',
    positionAmt: 2,
    entryPrice: 100,
    markPrice: 101,
    updateTime: NOW,
    ...overrides,
  };
}

/** 取第 n 张单。索引越界就直接炸：夹具写错时立刻失败，而不是静默传 undefined。 */
function nth(orders: ExchangeAlgoOrder[], index: number): ExchangeAlgoOrder {
  const found = orders[index];
  if (found === undefined) throw new Error(`夹具里没有第 ${index} 张单`);
  return found;
}

function report(input: {
  local?: LocalBracket[];
  positions?: ExchangePosition[];
  algoOrders?: ExchangeAlgoOrder[];
  symbol?: string | null;
}) {
  return reconcileBrackets({
    exchange: 'binance',
    symbol: input.symbol ?? 'AAAUSDT',
    checkedAt: NOW,
    local: input.local ?? [],
    positions: input.positions ?? [],
    algoOrders: input.algoOrders ?? [],
  });
}

/** 一组「两边完全对得上」的基线：本地 armed，交易所两张单都在，仓位也在。 */
function consistent() {
  return {
    local: [record()],
    positions: [position()],
    algoOrders: [
      algo(),
      algo({
        algoId: 11,
        clientAlgoId: 'rsk-tp-1001',
        orderType: 'TAKE_PROFIT',
        triggerPrice: 108,
      }),
    ],
  };
}

describe('一致的场景', () => {
  it('两边对得上时不报任何差异', () => {
    const result = report(consistent());
    expect(result.differences).toEqual([]);
    expect(result.healthy).toBe(true);
    expect(result.counts).toEqual({ critical: 0, warning: 0, total: 0 });
    expect(result.scope).toEqual({
      localUnsettled: 1,
      exchangePositions: 1,
      exchangeAlgoOrders: 2,
    });
  });

  it('已终结的记录不参与对账（它们的两张单本来就该不在交易所）', () => {
    // 取数侧只查 armed/failed，因此「本地空 + 交易所空 + 无仓位」是最干净的基线：
    // 仓位已平、单已被交易所自动撤销，两边都没有东西，自然没有差异。
    const result = report({ local: [], positions: [], algoOrders: [] });
    expect(result.differences).toEqual([]);
  });
});

describe('仓位没有止损保护（critical）', () => {
  it('本地记为已挂单，但交易所没有止损单', () => {
    const base = consistent();
    const result = report({ ...base, algoOrders: [nth(base.algoOrders, 1)] });
    const item = result.differences.find((d) => d.kind === 'missing-stop-order');
    expect(item?.severity).toBe('critical');
    expect(item?.entryOrderId).toBe('1001');
    expect(result.healthy).toBe(false);
  });

  it('本地 failed（占坑成功但没挂上）且仓位还在', () => {
    const result = report({
      local: [
        record({
          state: 'failed',
          tpAlgoId: null,
          slAlgoId: null,
          lastError: 'ATR 不可用：缺 3 根',
        }),
      ],
      positions: [position()],
      algoOrders: [],
    });
    expect(result.differences.map((d) => d.kind)).toEqual(['unprotected-position']);
    expect(result.differences[0]?.severity).toBe('critical');
    // 原因必须带出来，否则用户只知道「有裸仓」却不知道为什么。
    expect(result.differences[0]?.message).toContain('ATR 不可用');
  });

  it('交易所有仓位、本地一条未终结记录都没有', () => {
    const result = report({ local: [], positions: [position()], algoOrders: [] });
    const item = result.differences.find((d) => d.kind === 'position-without-record');
    expect(item?.severity).toBe('critical');
    expect(item?.entryOrderId).toBeNull();
  });

  it('同一笔裸仓只报一次，不会被「缺止损单」与「有仓位没记录」各报一遍', () => {
    const result = report({
      local: [record({ state: 'failed', tpAlgoId: null, slAlgoId: null })],
      positions: [position()],
      algoOrders: [],
    });
    expect(result.differences).toHaveLength(1);
  });
});

describe('价格与单号的漂移（warning）', () => {
  it('触发价与本地不一致', () => {
    const base = consistent();
    const result = report({
      ...base,
      algoOrders: [algo({ triggerPrice: 90 }), nth(base.algoOrders, 1)],
    });
    const item = result.differences.find((d) => d.kind === 'price-mismatch');
    expect(item?.severity).toBe('warning');
    expect(item?.evidence['exchangeTriggerPrice']).toBe(90);
    expect(item?.evidence['localStopPrice']).toBe(96);
  });

  it('浮点误差不算不一致（否则整份报告会开始被忽略）', () => {
    const base = consistent();
    const result = report({
      ...base,
      algoOrders: [algo({ triggerPrice: 96.0000000001 }), nth(base.algoOrders, 1)],
    });
    expect(result.differences).toEqual([]);
  });

  it('止损还在、止盈没了时，报 warning 而不是 critical', () => {
    // 严重度分档的意义就在这一条：仓位**有**止损保护，缺止盈不致命，
    // 与「本地记着已挂单却没有止损」必须分开说。
    const base = consistent();
    const result = report({ ...base, algoOrders: [nth(base.algoOrders, 0)] });
    const item = result.differences.find((d) => d.kind === 'missing-take-profit-order');
    expect(item?.severity).toBe('warning');
    expect(result.counts.critical).toBe(0);
  });

  it('只剩止盈时，缺的是止损 → critical', () => {
    const base = consistent();
    const result = report({ ...base, algoOrders: [nth(base.algoOrders, 1)] });
    expect(result.differences.map((d) => d.kind)).toEqual(['missing-stop-order']);
    expect(result.counts.critical).toBe(1);
  });

  it('本地 armed 但交易所已无仓位', () => {
    const base = consistent();
    const result = report({ ...base, positions: [] });
    const item = result.differences.find((d) => d.kind === 'record-without-position');
    expect(item?.severity).toBe('warning');
  });

  it('交易所挂着我方单但本地没有记录引用它', () => {
    const base = consistent();
    const result = report({
      ...base,
      local: [record({ tpAlgoId: null, slAlgoId: null })],
    });
    const item = result.differences.find((d) => d.kind === 'orphan-algo-order');
    expect(item?.severity).toBe('warning');
    expect(item?.entryOrderId).toBe('1001');
  });
});

describe('不该被算成差异的东西', () => {
  it('用户自己下的单（不是 rsk- 前缀）不算漂移', () => {
    const base = consistent();
    const result = report({
      ...base,
      algoOrders: [
        ...base.algoOrders,
        algo({ algoId: 99, clientAlgoId: 'web_manual_order', orderType: 'TRAILING_STOP_MARKET' }),
      ],
    });
    expect(result.differences).toEqual([]);
  });

  it('范围外的标的一律不看（symbol 缺省才是全账户）', () => {
    const result = report({
      symbol: 'BBBUSDT',
      local: [record({ symbol: 'AAAUSDT', state: 'failed' })],
      positions: [position({ symbol: 'AAAUSDT' })],
      algoOrders: [],
    });
    expect(result.differences).toEqual([]);
    expect(result.scope.localUnsettled).toBe(0);
  });

  it('symbol = null 时全账户对账', () => {
    const result = report({
      symbol: null,
      local: [record({ state: 'failed' })],
      positions: [position()],
      algoOrders: [],
    });
    expect(result.differences.length).toBeGreaterThan(0);
    expect(result.scope.exchangePositions).toBe(1);
  });
});

describe('输出稳定性与未知类型', () => {
  it('同一输入两次调用结果完全相同（含顺序）', () => {
    const input = {
      local: [
        record({ entryOrderId: '2002' }),
        record({ entryOrderId: '1001', state: 'failed' as const }),
      ],
      positions: [position()],
      algoOrders: [],
    };
    expect(JSON.stringify(report(input))).toBe(JSON.stringify(report(input)));
  });

  it('critical 排在 warning 之前', () => {
    const result = report({
      local: [record()],
      positions: [position({ symbol: 'ZZZUSDT' })],
      algoOrders: [],
    });
    const severities = result.differences.map((d) => d.severity);
    expect(severities[0]).toBe('critical');
    expect(severities.indexOf('critical')).toBeLessThan(severities.lastIndexOf('warning'));
  });

  it('我方单出现没见过的 orderType 时抛错，不静默当成止损', () => {
    expect(() =>
      report({
        local: [record()],
        algoOrders: [algo({ orderType: 'SOMETHING_NEW' })],
      }),
    ).toThrow();
  });
});

describe('v0.7.0 两段形态的判据', () => {
  it('trailing：交易所只剩一张止损时是一致的（不报「止盈单不见了」）', () => {
    const base = {
      local: [trailing()],
      positions: [position({ positionAmt: 1 })],
      algoOrders: [algo({ algoId: 12, clientAlgoId: 'rsk-sl-1001', triggerPrice: 104 })],
    };
    const result = report(base);
    // 这条断言是 AC-10 的核心：按旧判据这里必然报一条 missing-take-profit-order，
    // 而它是**假的**——trailing 阶段本来就不该有止盈单。
    expect(result.differences).toEqual([]);
    expect(result.healthy).toBe(true);
  });

  it('trailing：交易所还挂着止盈单 → unexpected-take-profit-order（warning）', () => {
    const result = report({
      local: [trailing()],
      positions: [position({ positionAmt: 1 })],
      algoOrders: [
        algo({ algoId: 12, clientAlgoId: 'rsk-sl-1001', triggerPrice: 104 }),
        algo({
          algoId: 11,
          clientAlgoId: 'rsk-tp-1001',
          orderType: 'TAKE_PROFIT',
          triggerPrice: 108,
        }),
      ],
    });
    const item = result.differences.find((d) => d.kind === 'unexpected-take-profit-order');
    expect(item?.severity).toBe('warning');
    // 它不该同时被报成 orphan：本地仍引用着 tp1AlgoId
    expect(result.differences.some((d) => d.kind === 'orphan-algo-order')).toBe(false);
  });

  it('trailing：比价用 trail_stop_price 而不是入场那一档', () => {
    // 止损单停在 104（移动后的档位）→ 一致。若判据错拿 stopPrice=96 去比，
    // 移动止损每调一档就会多报一条价格不符。
    const ok = report({
      local: [trailing()],
      positions: [position({ positionAmt: 1 })],
      algoOrders: [algo({ triggerPrice: 104 })],
    });
    expect(ok.differences).toEqual([]);

    const mismatch = report({
      local: [trailing()],
      positions: [position({ positionAmt: 1 })],
      algoOrders: [algo({ triggerPrice: 103 })],
    });
    expect(mismatch.differences.some((d) => d.kind === 'price-mismatch')).toBe(true);
  });

  it('trailing：止损单不见了仍然是 critical（仓位此刻真的裸了）', () => {
    const result = report({
      local: [trailing()],
      positions: [position({ positionAmt: 1 })],
      algoOrders: [],
    });
    const item = result.differences.find((d) => d.kind === 'missing-stop-order');
    expect(item?.severity).toBe('critical');
  });

  it('partial_armed：两张单都在时一致，且 TP1 不被当成 orphan', () => {
    const result = report({
      local: [
        record({
          state: 'partial_armed',
          tp1AlgoId: 13,
          tp1Price: 102,
          slAlgoId: 12,
        }),
      ],
      positions: [position()],
      algoOrders: [
        algo({ algoId: 12, clientAlgoId: 'rsk-sl-1001', triggerPrice: 96 }),
        algo({
          algoId: 13,
          clientAlgoId: 'rsk-tp-1001',
          orderType: 'TAKE_PROFIT',
          triggerPrice: 102,
        }),
      ],
    });
    expect(result.differences).toEqual([]);
  });

  it('partial_armed：第一段价与本地记录对不上时报价格不符（比 tp1Price 不是 takeProfit）', () => {
    const result = report({
      local: [record({ state: 'partial_armed', tp1AlgoId: 13, tp1Price: 102 })],
      positions: [position()],
      algoOrders: [
        algo(),
        algo({
          algoId: 13,
          clientAlgoId: 'rsk-tp-1001',
          orderType: 'TAKE_PROFIT',
          triggerPrice: 102,
        }),
      ],
    });
    // 本地 takeProfit=108 而交易所是 102，正解是**没有**差异（比的是 tp1Price）
    expect(result.differences).toEqual([]);
  });

  it('partial_armed：第一段单不见了 → missing-take-profit-order', () => {
    const result = report({
      local: [record({ state: 'partial_armed', tp1AlgoId: 13, tp1Price: 102 })],
      positions: [position()],
      algoOrders: [algo()],
    });
    const item = result.differences.find((d) => d.kind === 'missing-take-profit-order');
    expect(item?.severity).toBe('warning');
  });

  it('partial_armed 但**第一段已成交**：那张单消失是正常的，不报假警报', () => {
    // 第一段止盈成交后，交易所上那张单就没了（成交即撤）。
    // `tp1_filled_at` 有值就是证据——没有它，对账只能把「止盈单不见了」一律报成差异。
    const result = report({
      local: [
        record({ state: 'partial_armed', tp1AlgoId: 13, tp1Price: 102, tp1FilledAt: NOW - 1000 }),
      ],
      positions: [position()],
      algoOrders: [algo()],
    });
    expect(result.differences.find((d) => d.kind === 'missing-take-profit-order')).toBeUndefined();
  });

  it('partial_armed 却缺第一段价 → 抛错，不静默拿整段价顶上', () => {
    expect(() =>
      report({
        local: [record({ state: 'partial_armed', tp1AlgoId: 13, tp1Price: null })],
        positions: [position()],
        algoOrders: [algo()],
      }),
    ).toThrow(/第一段止盈价/);
  });

  it('trailing / partial_armed 也要参与「本地记着有仓位」的检查', () => {
    const result = report({
      local: [trailing()],
      positions: [position({ positionAmt: 0 })],
      algoOrders: [algo({ triggerPrice: 104 })],
    });
    expect(result.differences.some((d) => d.kind === 'record-without-position')).toBe(true);
  });
});
