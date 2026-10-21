/**
 * 盈亏的**事实**落库（v0.8.0）。
 *
 * 重点：
 *   * 入场那笔的手续费也要算进这一轮的成本（只扣出场那笔，收益会算虚高）；
 *   * 一轮可能平两段（v0.7.0 的两段模型），成交额与手续费都要**累加**；
 *   * 盈亏金额**不落库**——它由 core 的 `realizedPnl()` 现算，公式只有一份。
 *
 * 跑在随机命名的独立 schema 上（helpers/pg.ts），**绝不连生产库**。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  claimBracket,
  markBracketPartialArmed,
  markBracketSettled,
  markBracketTrailing,
  readBracket,
  recordBracketTp1Fill,
} from '../src/index.js';

import { createTestSchema, type TestSchema } from './helpers/pg.js';

const NOW = 1_760_000_000_000;
const KEY = { exchange: 'binance', symbol: 'PNLUSDT', entryOrderId: '9001' };

let schema: TestSchema;

beforeEach(async () => {
  schema = await createTestSchema('pnl');
});

afterEach(async () => {
  await schema.close();
});

async function claim(entryFeeAmount: number, staged = false): Promise<void> {
  await claimBracket(schema.pool, {
    exchange: KEY.exchange,
    symbol: KEY.symbol,
    entryOrderId: KEY.entryOrderId,
    entryPrice: 100,
    entryTime: NOW - 3600_000,
    filledQty: 2,
    positionSide: 'LONG',
    entryFeeAmount,
    atr: 2,
    atrPeriod: 14,
    atrInterval: '1h',
    atrWindowFrom: NOW - 7200_000,
    atrWindowTo: NOW - 3600_000,
    stopPrice: 96,
    takeProfit: 108,
    // 分批形态：表上的 CHECK 要求 tp1_qty / tp1_price 与 partial_armed 一起齐全。
    ...(staged ? { tp1Qty: 1, tp1Price: 110 } : {}),
    now: NOW,
  });
}

describe('盈亏事实的落库', () => {
  it('入场的手续费先记在账上（它也是这一轮的成本）', async () => {
    await claim(1.5);
    const record = await readBracket(schema.pool, KEY.exchange, KEY.symbol, KEY.entryOrderId);
    expect(record?.feeAmount).toBeCloseTo(1.5, 10);
    expect(record?.closedQty).toBe(0);
    expect(record?.exitNotional).toBe(0);
  });

  it('平掉一段就累加一段：量、成交额、手续费', async () => {
    await claim(1);
    await markBracketSettled(schema.pool, KEY, 'take_profit', NOW, {
      price: 110,
      qty: 2,
      fee: 0.8,
    });

    const record = await readBracket(schema.pool, KEY.exchange, KEY.symbol, KEY.entryOrderId);
    expect(record?.closedQty).toBeCloseTo(2, 10);
    expect(record?.exitNotional).toBeCloseTo(220, 10);
    // 入场 1 + 出场 0.8 = 1.8
    expect(record?.feeAmount).toBeCloseTo(1.8, 10);
    expect(record?.state).toBe('take_profit');
  });

  it('两段模型：两段都要累加（只算最后一段，净盈亏就只算了一半）', async () => {
    await claim(1, true);
    // 两段形态：第一段止盈（带数量）+ 止损两张单都挂上了
    await markBracketPartialArmed(schema.pool, KEY, { slAlgoId: 11, tp1AlgoId: 12 }, NOW);
    // 第一段止盈成交 → **先记这个事实**（v0.9.1：它不再挂在「推进阶段」的副作用上，
    // 否则推进一失败，这一段的成交价 / 数量 / 手续费就整个丢了）。
    await recordBracketTp1Fill(schema.pool, KEY, { price: 110, qty: 1, fee: 0.4 }, NOW);
    // 再推进到移动止损阶段
    await markBracketTrailing(
      schema.pool,
      KEY,
      { extreme: 120, stopPrice: 104, atr: 2, atrFrom: NOW - 3600_000, atrTo: NOW },
      NOW,
    );

    let record = await readBracket(schema.pool, KEY.exchange, KEY.symbol, KEY.entryOrderId);
    expect(record?.state).toBe('trailing');
    expect(record?.closedQty).toBeCloseTo(1, 10);
    expect(record?.exitNotional).toBeCloseTo(110, 10);
    expect(record?.feeAmount).toBeCloseTo(1.4, 10);

    // 移动止损了结剩余仓位
    await markBracketSettled(schema.pool, KEY, 'stop_loss', NOW + 1000, {
      price: 104,
      qty: 1,
      fee: 0.4,
    });

    record = await readBracket(schema.pool, KEY.exchange, KEY.symbol, KEY.entryOrderId);
    expect(record?.closedQty).toBeCloseTo(2, 10);
    expect(record?.exitNotional).toBeCloseTo(214, 10);
    expect(record?.feeAmount).toBeCloseTo(1.8, 10);
  });

  it('事件重放不再累加（行已终结就动不了它）', async () => {
    // 用户数据流会重放事件（续期、重连）。平仓的量与成交额是**累加**的，
    // 重放一次就多算一次——净盈亏直接错一半，比不报还危险。
    await claim(1);
    await markBracketSettled(schema.pool, KEY, 'take_profit', NOW, {
      price: 110,
      qty: 2,
      fee: 0.8,
    });

    const again = await markBracketSettled(schema.pool, KEY, 'take_profit', NOW + 1, {
      price: 110,
      qty: 2,
      fee: 0.8,
    });
    expect(again).toBe(0);

    const record = await readBracket(schema.pool, KEY.exchange, KEY.symbol, KEY.entryOrderId);
    expect(record?.closedQty).toBeCloseTo(2, 10);
    expect(record?.exitNotional).toBeCloseTo(220, 10);
    expect(record?.feeAmount).toBeCloseTo(1.8, 10);
  });

  it('工具外平仓没有我们的成交：事实不编造（量与成交额仍是 0）', async () => {
    await claim(1);
    await markBracketSettled(schema.pool, KEY, 'cancelled', NOW);

    const record = await readBracket(schema.pool, KEY.exchange, KEY.symbol, KEY.entryOrderId);
    expect(record?.state).toBe('cancelled');
    // 出场价我们不知道，就不写——盈亏也就算不出来，如实不算。
    expect(record?.closedQty).toBe(0);
    expect(record?.exitNotional).toBe(0);
  });
});
