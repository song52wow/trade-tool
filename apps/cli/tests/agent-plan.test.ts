/**
 * 命令行的方案批准（`trade-tool agent plan`）——v1.0.0 自动下单。
 *
 * **真 PG**（真迁移，从空库跑到 018）：批准要落库，而「限价方案被拒绝」
 * 这条判据必须真的走到写库那一步才算数。
 *
 * 锁住两条：
 *   1. **限价方案不能批准**——批准一份永远执行不了的方案，它会永远卡在
 *      「已批准」，每轮被捞出来又跳过，而页面显示「等 executor 消费」，
 *      看上去像是有一单在等着下（AGENTS.md §6.11.1 第 6 条）；
 *   2. **市价方案能批准**——驳回不该被限价那条挡住。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestSchema, recordTradingPlan, type TestSchema } from '@trade-tool/data';

import { applyAgentPlanStatus } from '../src/commands/agent.js';

const NOW = 1_760_000_000_000;
const SYMBOL = 'TESTUSDT';
const EXCHANGE = 'binance';

let schema: TestSchema;

beforeAll(async () => {
  schema = await createTestSchema('cli_plan');
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

describe('agent plan（批准 / 驳回）', () => {
  it('限价方案 → 拒绝批准，并说清为什么', async () => {
    const id = await recordTradingPlan(
      schema.pool,
      plan({ entryType: 'limit', entryPrice: 95, stopPrice: 90 }),
    );

    await expect(
      applyAgentPlanStatus({
        pool: schema.pool,
        exchange: EXCHANGE,
        planId: id,
        status: 'approved',
      }),
    ).rejects.toThrowError(/限价进场暂不支持自动执行/);
  });

  it('市价方案 → 批准成功', async () => {
    const id = await recordTradingPlan(schema.pool, plan({ asOfMs: NOW + 1 }));

    const updated = await applyAgentPlanStatus({
      pool: schema.pool,
      exchange: EXCHANGE,
      planId: id,
      status: 'approved',
    });

    expect(updated?.status).toBe('approved');
  });

  it('驳回限价方案 → 允许（那条限制只管批准）', async () => {
    const id = await recordTradingPlan(
      schema.pool,
      plan({ asOfMs: NOW + 2, entryType: 'limit', entryPrice: 95, stopPrice: 90 }),
    );

    const updated = await applyAgentPlanStatus({
      pool: schema.pool,
      exchange: EXCHANGE,
      planId: id,
      status: 'rejected',
    });

    expect(updated?.status).toBe('rejected');
  });
});
