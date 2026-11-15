/**
 * 手动补挂止盈止损的**判据**测试（纯函数，不连 PG、不出网）。
 *
 * 锁的是三件最容易出错、而错了又最贵的事：
 *
 * 1. **认得出「缺哪一张」**：把「缺止损」与「缺止盈」认反，后果是给裸仓补上一张
 *    止盈而仍然没有止损——仓位照样会穿出去。
 * 2. **复现原计划**：已有记录时价格必须**原样取自记录**。重新算一遍会让同一次故障的
 *    两次处置给出不同的止损位，而用户看到的是两个价。
 * 3. **拒绝得明确**：挂上去会不会立刻以市价平掉、取不到现价——这些必须拒，
 *    而不是猜一个方向。
 */

import {
  checkReattachTriggers,
  detectTp1Fill,
  planReattach,
  type ExchangeAlgoOrder,
  type ExchangePosition,
  type ReattachRecord,
} from '@trade-tool/core';
import { describe, expect, it } from 'vitest';

const NOW = 1_760_000_000_000;

function record(overrides: Partial<ReattachRecord> = {}): ReattachRecord {
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
    tp1Qty: null,
    trailStopPrice: null,
    trailStep: 0,
    trailMoves: 0,
    trailStatus: 'idle',
    trailLastError: null,
    state: 'armed',
    lastError: null,
    updatedAt: NOW,
    atr: 2,
    atrPeriod: 14,
    atrInterval: '15m',
    atrWindowFrom: NOW - 3600_000,
    atrWindowTo: NOW,
    decisionSource: 'config',
    decisionStopAtrMult: 2,
    decisionTakeProfitAtrMult: 4,
    decisionTakeProfit1Ratio: 0,
    ...overrides,
  };
}

function algo(overrides: Partial<ExchangeAlgoOrder> = {}): ExchangeAlgoOrder {
  return {
    algoId: 12,
    clientAlgoId: 'rsk-sl-1001',
    algoType: 'CONDITIONAL',
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
    markPrice: 102,
    updateTime: NOW,
    ...overrides,
  };
}

describe('planReattach', () => {
  it('裸仓：交易所有仓位、本地没有记录 → 补止盈 + 止损', () => {
    const plan = planReattach({
      symbol: 'AAAUSDT',
      records: [],
      position: position(),
      algoOrders: [],
    });
    expect(plan.target?.kind).toBe('naked-position');
    expect(plan.target?.need).toEqual(['tp', 'sl']);
    expect(plan.target?.entryOrderId).toBeNull();
    // 裸仓没有原计划可复现 → 必须现算。
    expect(plan.target?.prices).toBeNull();
    expect(plan.target?.entryPrice).toBe(100);
    expect(plan.target?.quantity).toBe(2);
  });

  it('failed 记录：一张都没挂上 → 补止盈 + 止损，价格原样取自记录', () => {
    const plan = planReattach({
      symbol: 'AAAUSDT',
      records: [record({ state: 'failed', tpAlgoId: null, slAlgoId: null, lastError: '挂单失败' })],
      position: position(),
      algoOrders: [],
    });
    expect(plan.target?.kind).toBe('unprotected-position');
    expect(plan.target?.need).toEqual(['tp', 'sl']);
    // **复现**：价格必须与记录里的一致，不能重新算。
    expect(plan.target?.prices?.stopPrice).toBe(96);
    expect(plan.target?.prices?.takeProfitPrice).toBe(108);
    expect(plan.target?.atr?.atr).toBe(2);
  });

  it('armed 记录缺止损 → 只补止损（止盈还在，别挂第二张）', () => {
    const plan = planReattach({
      symbol: 'AAAUSDT',
      records: [record()],
      position: position(),
      algoOrders: [algo({ algoId: 11, clientAlgoId: 'rsk-tp-1001', orderType: 'TAKE_PROFIT' })],
    });
    expect(plan.target?.kind).toBe('missing-stop-order');
    expect(plan.target?.need).toEqual(['sl']);
  });

  it('armed 记录缺止盈 → 只补止盈', () => {
    const plan = planReattach({
      symbol: 'AAAUSDT',
      records: [record()],
      position: position(),
      algoOrders: [algo()],
    });
    expect(plan.target?.kind).toBe('missing-take-profit-order');
    expect(plan.target?.need).toEqual(['tp']);
  });

  it('本地与交易所一致 → 不补挂', () => {
    const plan = planReattach({
      symbol: 'AAAUSDT',
      records: [record()],
      position: position(),
      algoOrders: [
        algo({ algoId: 11, clientAlgoId: 'rsk-tp-1001', orderType: 'TAKE_PROFIT' }),
        algo(),
      ],
    });
    expect(plan.target).toBeNull();
    expect(plan.skips[0]?.reason).toContain('不需要补挂');
  });

  it('交易所已无该标的仓位 → 不补挂（补了会留下没人认领的单）', () => {
    const plan = planReattach({
      symbol: 'AAAUSDT',
      records: [record()],
      position: position({ positionAmt: 0 }),
      algoOrders: [],
    });
    expect(plan.target).toBeNull();
    expect(plan.skips[0]?.reason).toContain('已无该标的仓位');
  });

  it('partial_armed 且第一段已成交 → 此刻只该有止损', () => {
    const plan = planReattach({
      symbol: 'AAAUSDT',
      records: [
        record({
          state: 'partial_armed',
          tpAlgoId: null,
          tp1AlgoId: 11,
          tp1Price: 106,
          tp1Qty: 1,
          tp1FilledAt: NOW - 1000,
        }),
      ],
      position: position(),
      algoOrders: [],
    });
    // 第一段成交了，那张单本来就会消失——只补止损。
    expect(plan.target?.need).toEqual(['sl']);
    expect(plan.target?.kind).toBe('missing-stop-order');
  });

  it('trailing 行：交易所上只剩止损，缺了就补止损', () => {
    const plan = planReattach({
      symbol: 'AAAUSDT',
      records: [
        record({
          state: 'trailing',
          tpAlgoId: null,
          trailStopPrice: 104,
          trailStep: 1,
          trailMoves: 1,
          trailStatus: 'moved',
        }),
      ],
      position: position(),
      algoOrders: [],
    });
    expect(plan.target?.need).toEqual(['sl']);
    // 补的是**当前生效的那一档**，不是入场时那一档。
    expect(plan.target?.prices?.stopPrice).toBe(104);
  });

  it('入场单号被截断时仍认得出交易所上那张单（不能误判成缺单）', () => {
    // `bracketClientOrderId` 把整串截到 36 字符，交易所回传的是入场单号的**前缀**。
    const longEntry = '9'.repeat(40);
    const plan = planReattach({
      symbol: 'AAAUSDT',
      records: [record({ entryOrderId: longEntry })],
      position: position(),
      algoOrders: [
        algo({
          algoId: 11,
          clientAlgoId: `rsk-tp-${longEntry.slice(0, 28)}`,
          orderType: 'TAKE_PROFIT',
        }),
        algo({ algoId: 12, clientAlgoId: `rsk-sl-${longEntry.slice(0, 28)}` }),
      ],
    });
    // 两张单都在 → 不该报缺单。
    expect(plan.target).toBeNull();
  });

  it('占位记录（当初没算出档位）→ 不复现，要现算', () => {
    const plan = planReattach({
      symbol: 'AAAUSDT',
      records: [
        record({
          state: 'failed',
          atr: Number.MIN_VALUE,
          stopPrice: 100,
          takeProfit: 100,
          tpAlgoId: null,
          slAlgoId: null,
          lastError: 'ATR 不可用',
        }),
      ],
      position: position(),
      algoOrders: [],
    });
    expect(plan.target?.kind).toBe('unprotected-position');
    // 止损价 = 入场价的那种记录**不能**照抄：挂上去就是当场平仓。
    expect(plan.target?.prices).toBeNull();
  });

  it('方向对不上的记录不参与补挂', () => {
    const plan = planReattach({
      symbol: 'AAAUSDT',
      records: [record({ positionSide: 'SHORT' })],
      position: position(),
      algoOrders: [],
    });
    // 本地没有覆盖这个仓位的记录 → 走裸仓那条路；那条反方向的记录单独说明。
    expect(plan.target?.kind).toBe('naked-position');
    expect(plan.skips[0]?.reason).toContain('对不上');
  });

  it('同一标的多条未终结记录 → 只补一条，其余说明原因', () => {
    const plan = planReattach({
      symbol: 'AAAUSDT',
      records: [record({ entryOrderId: '1001' }), record({ entryOrderId: '1002' })],
      position: position(),
      algoOrders: [],
    });
    expect(plan.target?.entryOrderId).toBe('1001');
    expect(plan.skips.some((skip) => skip.reason.includes('多条未终结记录'))).toBe(true);
  });

  it('第一段已成交、而库里没记 → 只补止损，绝不重复挂第一段止盈', () => {
    // 库里 tp1_filled_at 是空的（executor 不在时成交的），但交易所的仓位少了那一段。
    const plan = planReattach({
      symbol: 'AAAUSDT',
      records: [
        record({
          state: 'partial_armed',
          tpAlgoId: null,
          tp1AlgoId: 11,
          tp1Price: 106,
          tp1Qty: 1,
          tp1FilledAt: null,
        }),
      ],
      position: position({ positionAmt: 1 }),
      algoOrders: [],
    });
    // 第一段成交后那张单本来就会消失——**再挂一张就是重复减仓**。
    expect(plan.target?.need).toEqual(['sl']);
    expect(plan.target?.kind).toBe('missing-stop-order');
    expect(plan.refusal).toBeNull();
    // 那个「已成交」的事实要交给编排层补记进库。
    expect(plan.tp1Fill).toEqual({ entryOrderId: '1001', price: 106, qty: 1 });
  });

  it('第一段已成交、止损还在 → 不补挂，但那个事实仍然要补记', () => {
    const plan = planReattach({
      symbol: 'AAAUSDT',
      records: [
        record({
          state: 'partial_armed',
          tpAlgoId: null,
          tp1AlgoId: 11,
          tp1Price: 106,
          tp1Qty: 1,
          tp1FilledAt: null,
        }),
      ],
      position: position({ positionAmt: 1 }),
      algoOrders: [algo({ algoId: 12, clientAlgoId: 'rsk-sl-1001' })],
    });
    expect(plan.target).toBeNull();
    expect(plan.refusal).toBeNull();
    // 保护是完整的，但「第一段成交过」这个事实库里仍然没有——不补记的话，
    // 对账会一直报假警报，移动止损也永远不会接手这一笔。
    expect(plan.tp1Fill).toEqual({ entryOrderId: '1001', price: 106, qty: 1 });
  });

  it('仓位数量与记录对不上 → 拒绝补挂（不猜）', () => {
    const plan = planReattach({
      symbol: 'AAAUSDT',
      records: [
        record({
          state: 'partial_armed',
          tpAlgoId: null,
          tp1AlgoId: 11,
          tp1Price: 106,
          tp1Qty: 1,
          tp1FilledAt: null,
        }),
      ],
      position: position({ positionAmt: 1.5 }),
      algoOrders: [],
    });
    expect(plan.target).toBeNull();
    expect(plan.refusal).toContain('对不上');
    // 说不清的时候**什么都不记**——包括那个「已成交」的事实。
    expect(plan.tp1Fill).toBeNull();
  });

  it('库里已经记了「第一段已成交」→ 事实权威，之后仓位被动过也不拦补挂', () => {
    const plan = planReattach({
      symbol: 'AAAUSDT',
      records: [
        record({
          state: 'partial_armed',
          tpAlgoId: null,
          tp1AlgoId: 11,
          tp1Price: 106,
          tp1Qty: 1,
          tp1FilledAt: NOW - 1000,
        }),
      ],
      position: position({ positionAmt: 3 }),
      algoOrders: [],
    });
    expect(plan.refusal).toBeNull();
    expect(plan.target?.need).toEqual(['sl']);
    // 事实已经在库里 → 不用再补记。
    expect(plan.tp1Fill).toBeNull();
  });

  it('记录说「一张都没挂上」而仓位少了第一段 → 两者矛盾，拒绝补挂', () => {
    // 「挂了第一段止盈、挂止损失败、回滚撤单也失败、那张止盈后来又成交了」
    // 这一串全发生才会走到。照记录补就会重复减仓——所以拒绝。
    const plan = planReattach({
      symbol: 'AAAUSDT',
      records: [
        record({
          state: 'failed',
          tpAlgoId: null,
          slAlgoId: null,
          tp1AlgoId: null,
          tp1Price: 106,
          tp1Qty: 1,
          tp1FilledAt: null,
          lastError: '挂单失败',
        }),
      ],
      position: position({ positionAmt: 1 }),
      algoOrders: [],
    });
    expect(plan.target).toBeNull();
    expect(plan.refusal).toContain('矛盾');
    expect(plan.tp1Fill).toBeNull();
  });
});

describe('detectTp1Fill', () => {
  it('不分批：没有「第一段」这回事', () => {
    expect(detectTp1Fill({ filledQty: 2, tp1Qty: null, positionQty: 2 })).toBe('not-staged');
  });

  it('仓位还是满的 → 第一段还没成交', () => {
    expect(detectTp1Fill({ filledQty: 2, tp1Qty: 1, positionQty: 2 })).toBe('tp1-open');
  });

  it('仓位少了一段 → 第一段已成交', () => {
    expect(detectTp1Fill({ filledQty: 2, tp1Qty: 1, positionQty: 1 })).toBe('tp1-filled');
  });

  it('仓位与两种预期都对不上 → 说不清，不猜', () => {
    // 减了一半：第一段只成交了一部分。
    expect(detectTp1Fill({ filledQty: 2, tp1Qty: 1, positionQty: 1.5 })).toBe('unknown');
    // 加了仓：仓位比记录的还多。
    expect(detectTp1Fill({ filledQty: 2, tp1Qty: 1, positionQty: 3 })).toBe('unknown');
  });

  it('第一段小到两个预期分不开 → 说不清', () => {
    expect(detectTp1Fill({ filledQty: 2, tp1Qty: 1e-9, positionQty: 2 })).toBe('unknown');
  });

  it('数量有浮点误差也认得出来', () => {
    // 0.3 - 0.1 在浮点里是 0.19999999999999998，与 0.2 差 2.8e-17。
    expect(detectTp1Fill({ filledQty: 0.3, tp1Qty: 0.1, positionQty: 0.2 })).toBe('tp1-filled');
  });

  it('数据坏掉时判「说不清」，而不是硬凑一个结论', () => {
    expect(detectTp1Fill({ filledQty: 0, tp1Qty: 1, positionQty: 1 })).toBe('unknown');
    expect(detectTp1Fill({ filledQty: 2, tp1Qty: 5, positionQty: 1 })).toBe('unknown');
    expect(detectTp1Fill({ filledQty: 2, tp1Qty: 0, positionQty: 1 })).toBe('unknown');
  });
});

describe('checkReattachTriggers', () => {
  it('多头：止损在现价下方、止盈在上方 → 放行', () => {
    expect(
      checkReattachTriggers({
        positionSide: 'LONG',
        currentPrice: 102,
        orders: [
          { tag: 'sl', price: 96 },
          { tag: 'tp', price: 108 },
        ],
      }),
    ).toBeNull();
  });

  it('多头：止损已经越过现价 → 拒绝（挂上去会立刻市价平仓）', () => {
    const reason = checkReattachTriggers({
      positionSide: 'LONG',
      currentPrice: 95,
      orders: [{ tag: 'sl', price: 96 }],
    });
    expect(reason).toContain('错误一侧');
  });

  it('空头：止盈已经越过现价 → 拒绝', () => {
    // 空头的止盈在**现价下方**才是对的。108 高于现价 105 → 挂上去立刻市价平仓。
    const reason = checkReattachTriggers({
      positionSide: 'SHORT',
      currentPrice: 105,
      orders: [{ tag: 'tp', price: 108 }],
    });
    expect(reason).toContain('错误一侧');
  });

  it('取不到现价 → 拒绝，不猜', () => {
    const reason = checkReattachTriggers({
      positionSide: 'LONG',
      currentPrice: null,
      orders: [{ tag: 'sl', price: 96 }],
    });
    expect(reason).toContain('取不到现价');
  });

  it('只检查真正要挂的那几张（已成交的第一段止盈不参与）', () => {
    // 第一段的止盈价 108 已经高于现价 102（它早就成交了），但它不在要挂的清单里，
    // 因此不该把整次补挂拒掉。
    expect(
      checkReattachTriggers({
        positionSide: 'LONG',
        currentPrice: 102,
        orders: [{ tag: 'sl', price: 96 }],
      }),
    ).toBeNull();
  });
});
