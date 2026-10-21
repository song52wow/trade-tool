/**
 * 「第一段止盈已成交」与「移动止损的工作集合」（v0.9.1 补）。
 *
 * 重点是三件**曾经坏掉、而且坏了看不出来**的事：
 *
 *  1. **「TP1 成交过」这件事必须落库**。它早先只是「推进到 trailing」的副作用，
 *     于是推进一失败它就整个丢了：成交价 / 数量 / 手续费都没记（盈亏少算一段），
 *     而且没有任何东西能证明「TP1 成交过」→ 推进失败永远不会被重试。
 *  2. **记一次就够**。用户数据流会重投事件，重投不重复累加——
 *     累加两次算出来的净盈亏是错的，而且错得看不出来。
 *  3. **移动止损的工作集合必须包含「TP1 成交了但没推进成功」的行**。
 *     只取 `trailing` 的话，那行永远没人重试，止损位不跟着价格上移，
 *     而人只会看到一行报错。
 *
 * 跑在随机命名的独立 schema 上（helpers/pg.ts），**绝不连生产库**。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  claimBracket,
  listTrailingBrackets,
  markBracketPartialArmed,
  readBracket,
  recordBracketTp1Fill,
} from '../src/index.js';

import { createTestSchema, type TestSchema } from './helpers/pg.js';

const EXCHANGE = 'binance';
const SYMBOL = 'TRAILUSDC';
const NOW = 1_760_000_000_000;

let schema: TestSchema;

beforeEach(async () => {
  schema = await createTestSchema('trail');
});

afterEach(async () => {
  await schema.close();
});

/** 占一条分批形态的记录（`partial_armed`）：第一段的量与价齐全。 */
async function claimPartial(entryOrderId: string, filledQty = 0.1): Promise<void> {
  const claimed = await claimBracket(schema.pool, {
    exchange: EXCHANGE,
    symbol: SYMBOL,
    entryOrderId,
    entryPrice: 60_000,
    entryTime: NOW - 60_000,
    filledQty,
    positionSide: 'LONG',
    atr: 100,
    atrPeriod: 14,
    atrInterval: '1m',
    atrWindowFrom: NOW - 120_000,
    atrWindowTo: NOW - 60_000,
    stopPrice: 59_800,
    takeProfit: 60_300,
    tp1AlgoId: 111,
    tp1Qty: filledQty / 2,
    tp1Price: 60_300,
    now: NOW,
  });
  expect(claimed).not.toBeNull();
  await markBracketPartialArmed(
    schema.pool,
    { exchange: EXCHANGE, symbol: SYMBOL, entryOrderId },
    { tp1AlgoId: 111, slAlgoId: 222 },
    NOW,
  );
}

describe('第一段止盈成交事实（recordBracketTp1Fill）', () => {
  it('落库：标记成交时刻，并把这一段的平仓事实累加进去', async () => {
    await claimPartial('9001');

    const rows = await recordBracketTp1Fill(
      schema.pool,
      { exchange: EXCHANGE, symbol: SYMBOL, entryOrderId: '9001' },
      { price: 60_300, qty: 0.05, fee: 0.02 },
      NOW + 1_000,
    );
    expect(rows).toBe(1);

    const row = await readBracket(schema.pool, EXCHANGE, SYMBOL, '9001');
    expect(row?.tp1FilledQty).toBe(0.05);
    expect(row?.tp1FilledAt).toBe(NOW + 1_000);
    // 平仓事实：量、成交额、手续费。
    expect(row?.closedQty).toBeCloseTo(0.05, 10);
    expect(row?.exitNotional).toBeCloseTo(60_300 * 0.05, 6);
    expect(row?.feeAmount).toBeCloseTo(0.02, 10);
    // **阶段不变**：它记的是事实，不是阶段。
    expect(row?.state).toBe('partial_armed');
  });

  it('幂等：事件重投不重复累加（否则净盈亏会多算一段）', async () => {
    await claimPartial('9002');

    const leg = { price: 60_300, qty: 0.05, fee: 0.02 };
    expect(
      await recordBracketTp1Fill(
        schema.pool,
        { exchange: EXCHANGE, symbol: SYMBOL, entryOrderId: '9002' },
        leg,
        NOW + 1_000,
      ),
    ).toBe(1);
    // 第二次：拿不到行（`WHERE tp1_filled_at IS NULL`）。
    expect(
      await recordBracketTp1Fill(
        schema.pool,
        { exchange: EXCHANGE, symbol: SYMBOL, entryOrderId: '9002' },
        leg,
        NOW + 2_000,
      ),
    ).toBe(0);

    const row = await readBracket(schema.pool, EXCHANGE, SYMBOL, '9002');
    expect(row?.closedQty).toBeCloseTo(0.05, 10);
    expect(row?.exitNotional).toBeCloseTo(60_300 * 0.05, 6);
    expect(row?.feeAmount).toBeCloseTo(0.02, 10);
    // 成交时刻不被第二次覆盖。
    expect(row?.tp1FilledAt).toBe(NOW + 1_000);
  });
});

describe('移动止损的工作集合（listTrailingBrackets）', () => {
  it('包含「TP1 已成交但没推进成功」的行——它必须有人重试', async () => {
    await claimPartial('9003');
    await recordBracketTp1Fill(
      schema.pool,
      { exchange: EXCHANGE, symbol: SYMBOL, entryOrderId: '9003' },
      { price: 60_300, qty: 0.05, fee: 0.02 },
      NOW + 1_000,
    );

    const rows = await listTrailingBrackets(schema.pool, EXCHANGE, NOW + 2_000);
    expect(rows.map((r) => r.entryOrderId)).toEqual(['9003']);
  });

  it('**不**包含「TP1 还没成交」的行——那是进场保护，止损不该被移动', async () => {
    await claimPartial('9004');

    const rows = await listTrailingBrackets(schema.pool, EXCHANGE, NOW + 2_000);
    expect(rows).toHaveLength(0);
  });
});
