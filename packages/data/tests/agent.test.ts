/**
 * Agent 报告与执行方案的落库层测试（v1.0.0）。
 *
 * 判据本身在 core 的纯函数测试里；这里锁的是**落库与读回**这一层：
 *
 *   1. 同一份数据时刻的同一标的只留**一份**报告（重跑一轮不产生第二条）；
 *   2. 方案与报告的**完整性约束**真的生效——缺字段的 `enter` 方案写不进去；
 *   3. 止损必须与进场价**分居两侧**（否则「止损」会在进场的同时把仓位平掉）；
 *   4. `failed` 必须带原因，`hold` 不许带原因（决定 vs 故障）；
 *   5. 状态只能从 `advisory` / `approved` 往前走。
 *
 * 不出网：PG 用随机 schema，迁移从空库跑起。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  claimTradingPlan,
  listAnalystReports,
  listTradingPlans,
  markTradingPlanExecuted,
  readLatestAnalystReport,
  readLatestTradingPlan,
  recordAnalystReport,
  recordTradingPlan,
  updateTradingPlanStatus,
  type AnalystReportRecord,
  type TradingPlanRecord,
} from '../src/index.js';

import { createTestSchema, type TestSchema } from './helpers/pg.js';

const NOW = 1_760_000_000_000;
const SYMBOL = 'TESTUSDT';

let schema: TestSchema;

function report(overrides: Partial<AnalystReportRecord> = {}): AnalystReportRecord {
  return {
    exchange: 'binance',
    symbol: SYMBOL,
    interval: '1h',
    asOfMs: NOW,
    createdAtMs: NOW,
    verdict: {
      stance: 'bullish',
      confidence: 0.8,
      bias: 0.6,
      agreement: 0.9,
      facets: {
        technical: { score: 0.7, notes: ['均线多头排列'] },
        sentiment: { score: 0.5, notes: ['资金费率为正'] },
        fundamental: { score: 0.2, notes: ['流动性正常'] },
      },
      stopAtrMult: 2,
      takeProfitAtrMult: 3,
      rationale: '趋势向上。',
    },
    atr: 2,
    lastClose: 100,
    context: { technical: { lastClose: 100 } },
    raw: '{"technical":{"score":0.7,"notes":[]}}',
    degraded: false,
    ...overrides,
  };
}

function plan(overrides: Partial<TradingPlanRecord> = {}): TradingPlanRecord {
  return {
    exchange: 'binance',
    symbol: SYMBOL,
    reportId: null,
    asOfMs: NOW,
    createdAtMs: NOW,
    action: 'enter',
    side: 'BUY',
    entryType: 'market',
    entryPrice: 100,
    stopPrice: 96,
    takeProfitPrice: 106,
    quantity: 25,
    notional: 2500,
    riskAmount: 100,
    equity: 10_000,
    equitySource: 'config',
    riskFraction: 0.01,
    atr: 2,
    stopAtrMult: 2,
    takeProfitAtrMult: 3,
    riskReward: 1.5,
    stance: 'bullish',
    confidence: 0.8,
    rationale: '回调买。',
    adjustments: [],
    failureReason: null,
    raw: null,
    ...overrides,
  };
}

beforeAll(async () => {
  schema = await createTestSchema('agent');
});

afterAll(async () => {
  await schema.close();
});

describe('analyst_report', () => {
  it('写入后能原样读回', async () => {
    const id = await recordAnalystReport(schema.pool, report());
    const row = await readLatestAnalystReport(schema.pool, 'binance', SYMBOL);
    expect(row).not.toBeNull();
    expect(row?.id).toBe(id);
    expect(row?.stance).toBe('bullish');
    expect(row?.technical.notes).toEqual(['均线多头排列']);
    expect(row?.degraded).toBe(false);
  });

  it('同一份数据时刻重写 → 还是一条（不产生第二个答案）', async () => {
    await recordAnalystReport(schema.pool, report({ asOfMs: NOW + 1 }));
    await recordAnalystReport(
      schema.pool,
      report({
        asOfMs: NOW + 1,
        verdict: { ...report().verdict, stance: 'bearish' },
      }),
    );
    const rows = await listAnalystReports(schema.pool, 'binance', { symbol: SYMBOL });
    const same = rows.filter((r) => r.asOfMs === NOW + 1);
    expect(same).toHaveLength(1);
    expect(same[0]?.stance).toBe('bearish');
  });
});

describe('trading_plan', () => {
  it('写入后能原样读回', async () => {
    const id = await recordTradingPlan(schema.pool, plan());
    const row = await readLatestTradingPlan(schema.pool, 'binance', SYMBOL);
    expect(row?.id).toBe(id);
    expect(row?.action).toBe('enter');
    expect(row?.status).toBe('advisory');
    expect(row?.quantity).toBe(25);
  });

  it('缺三件套的 enter 方案写不进去（完整性约束）', async () => {
    await expect(recordTradingPlan(schema.pool, plan({ quantity: null }))).rejects.toThrowError();
  });

  it('止损没与进场价分居两侧 → 写不进去', async () => {
    await expect(recordTradingPlan(schema.pool, plan({ stopPrice: 101 }))).rejects.toThrowError();
  });

  it('failed 必须带原因', async () => {
    await expect(
      recordTradingPlan(
        schema.pool,
        plan({
          action: 'failed',
          side: null,
          entryType: null,
          entryPrice: null,
          stopPrice: null,
          takeProfitPrice: null,
          quantity: null,
          notional: null,
          riskAmount: null,
          riskFraction: null,
          riskReward: null,
          failureReason: null,
        }),
      ),
    ).rejects.toThrowError();
  });

  it('hold 不许带失败原因（决定 ≠ 故障）', async () => {
    await expect(
      recordTradingPlan(
        schema.pool,
        plan({
          action: 'hold',
          side: null,
          entryType: null,
          entryPrice: null,
          stopPrice: null,
          takeProfitPrice: null,
          quantity: null,
          notional: null,
          riskAmount: null,
          riskFraction: null,
          riskReward: null,
          failureReason: '不该有',
        }),
      ),
    ).rejects.toThrowError();
  });

  it('状态只能往前走：已执行的方案不能改回 advisory', async () => {
    const id = await recordTradingPlan(schema.pool, plan({ asOfMs: NOW + 10 }));
    await updateTradingPlanStatus(schema.pool, id, 'approved');
    await claimTradingPlan(schema.pool, {
      planId: id,
      expectedAttempt: 0,
      clientOrderId: 'agt-p1-a1',
      nowMs: NOW,
    });
    await markTradingPlanExecuted(schema.pool, { planId: id, entryOrderId: '777', nowMs: NOW });
    const row = await readLatestTradingPlan(schema.pool, 'binance', SYMBOL);
    expect(row?.status).toBe('executed');
    // 已执行是**终点**：改回 advisory / approved / rejected 都不许。
    await expect(updateTradingPlanStatus(schema.pool, id, 'advisory')).rejects.toThrowError();
    await expect(updateTradingPlanStatus(schema.pool, id, 'approved')).rejects.toThrowError();
    await expect(updateTradingPlanStatus(schema.pool, id, 'rejected')).rejects.toThrowError();
  });
});
