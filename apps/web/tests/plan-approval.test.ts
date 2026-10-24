/**
 * 控制面批准 / 驳回执行方案（v1.0.0 自动下单）。
 *
 * **真 PG**（真迁移，从空库跑到 018）：批准要落库。
 *
 * 锁住三条：
 *   1. **限价方案不能批准**——批准一份永远执行不了的方案，它会永远卡在
 *      「已批准」，每轮被捞出来又跳过，而页面显示「等 executor 消费」，
 *      看上去像是有一单在等着下（AGENTS.md §6.11.1 第 6 条）；
 *   2. **市价方案能批准**；
 *   3. **标的对不上就拒绝**——拿 A 标的的 URL 改 B 标的的方案是不可逆的
 *      （它会变成真实订单），这是**防手滑**，不是安全边界。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestSchema, recordTradingPlan, type TestSchema } from '@trade-tool/data';

import { applyTradingPlanStatus } from '../src/service.js';

const NOW = 1_760_000_000_000;
const SYMBOL = 'TESTUSDT';
const EXCHANGE = 'binance';

let schema: TestSchema;

beforeAll(async () => {
  schema = await createTestSchema('web_plan');
});

afterAll(async () => {
  await schema.close();
});

function plan(overrides: Partial<Parameters<typeof recordTradingPlan>[1]> = {}) {
  return {
    exchange: EXCHANGE,
    symbol: SYMBOL,
    reportId: null,
    asOfMs: NOW,
    createdAtMs: NOW,
    action: 'enter' as const,
    side: 'BUY' as const,
    entryType: 'market' as const,
    entryPrice: 100,
    stopPrice: 96,
    takeProfitPrice: 106,
    quantity: 25,
    notional: 2500,
    riskAmount: 100,
    equity: 10_000,
    equitySource: 'config' as const,
    riskFraction: 0.01,
    atr: 2,
    stopAtrMult: 2,
    takeProfitAtrMult: 3,
    riskReward: 1.5,
    stance: 'bullish' as const,
    confidence: 0.8,
    rationale: '回调买。',
    adjustments: [],
    failureReason: null,
    raw: null,
    status: 'advisory' as const,
    ...overrides,
  };
}

describe('控制面批准执行方案', () => {
  it('限价方案 → 拒绝批准，并说清为什么', async () => {
    const id = await recordTradingPlan(
      schema.pool,
      plan({ entryType: 'limit', entryPrice: 95, stopPrice: 90 }),
    );

    await expect(
      applyTradingPlanStatus({
        pool: schema.pool,
        exchange: EXCHANGE,
        symbol: SYMBOL,
        planId: id,
        status: 'approved',
      }),
    ).rejects.toThrowError(/限价进场暂不支持自动执行/);
  });

  it('市价方案 → 批准成功', async () => {
    const id = await recordTradingPlan(schema.pool, plan({ asOfMs: NOW + 1 }));

    const dto = await applyTradingPlanStatus({
      pool: schema.pool,
      exchange: EXCHANGE,
      symbol: SYMBOL,
      planId: id,
      status: 'approved',
    });

    expect(dto.status).toBe('approved');
    // 「能不能批准」要随方案一起回给页面：页面不自己判（那是第二份实现）
    expect(dto.approvable).toBe(true);
    expect(dto.approvableReason).toBeNull();
  });

  it('标的对不上 → 拒绝（防手滑）', async () => {
    const id = await recordTradingPlan(schema.pool, plan({ asOfMs: NOW + 2 }));

    await expect(
      applyTradingPlanStatus({
        pool: schema.pool,
        exchange: EXCHANGE,
        symbol: 'OTHERUSDT',
        planId: id,
        status: 'approved',
      }),
    ).rejects.toThrowError(/不是 OTHERUSDT/);
  });

  it('驳回限价方案 → 允许（那条限制只管批准）', async () => {
    const id = await recordTradingPlan(
      schema.pool,
      plan({ asOfMs: NOW + 3, entryType: 'limit', entryPrice: 95, stopPrice: 90 }),
    );

    const dto = await applyTradingPlanStatus({
      pool: schema.pool,
      exchange: EXCHANGE,
      symbol: SYMBOL,
      planId: id,
      status: 'rejected',
    });

    expect(dto.status).toBe('rejected');
    // 限价方案**不能批准**：这个事实要跟着方案回到页面上，
    // 否则页面只能自己再判一遍（判据就有两份了）
    expect(dto.approvable).toBe(false);
    expect(dto.approvableReason).toMatch(/限价进场暂不支持自动执行/);
  });
});
