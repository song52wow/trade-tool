/**
 * 方案执行的**状态机**落库层测试（v1.0.0 自动下单）。
 *
 * 这里锁的是「认领 → 下单 → 回填」这三步在**库里**的保证：
 *
 *   1. 认领是**幂等锚点**：只有一份 `approved` 方案能被认领走，
 *      而认领之后它停在 `executing`（**不会**被自动重试）；
 *   2. 认领必须带上「这一次的自定义号」，且尝试次数 +1
 *      （重试要用新号，否则撞 Binance 的「重复单号」）；
 *   3. 回填必须带单号——`executed` 的行没有单号**写不进去**
 *      （表上的 CHECK 守着「看起来成功其实什么都没做」）；
 *   4. 失败必须带原因；
 *   5. 卡在 `executing` 的方案能被单独读出来（执行器要报「状态未知」）。
 *
 * 不出网：PG 用随机 schema，迁移从空库跑起。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  claimTradingPlan,
  listApprovedTradingPlans,
  listExecutingTradingPlans,
  markTradingPlanExecutionFailed,
  markTradingPlanExecuted,
  readTradingPlanById,
  recordTradingPlan,
  updateTradingPlanStatus,
  type TradingPlanRecord,
} from '../src/index.js';

import { createTestSchema, type TestSchema } from './helpers/pg.js';

const NOW = 1_760_000_000_000;
const SYMBOL = 'TESTUSDT';

let schema: TestSchema;

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

/** 落一份方案并批准它（批准的方案才等着被执行）。 */
async function approvedPlan(overrides: Partial<TradingPlanRecord> = {}): Promise<string> {
  const id = await recordTradingPlan(schema.pool, plan(overrides));
  await updateTradingPlanStatus(schema.pool, id, 'approved');
  return id;
}

beforeAll(async () => {
  schema = await createTestSchema('agentexec');
});

afterAll(async () => {
  await schema.close();
});

describe('方案执行的认领', () => {
  it('认领成功 → 停在「执行中」，并记下这一次的自定义号', async () => {
    const id = await approvedPlan();

    const claimed = await claimTradingPlan(schema.pool, {
      planId: id,
      expectedAttempt: 0,
      clientOrderId: 'agt-p1-a1',
      nowMs: NOW,
    });

    expect(claimed).toBe(true);
    const row = await readTradingPlanById(schema.pool, 'binance', id);
    expect(row?.status).toBe('executing');
    expect(row?.clientOrderId).toBe('agt-p1-a1');
    expect(row?.attempt).toBe(1);
    expect(row?.claimedAtMs).toBe(NOW);
  });

  it('认领第二次 → 失败（幂等锚点：一份方案只能归一个人）', async () => {
    const id = await approvedPlan();
    await claimTradingPlan(schema.pool, {
      planId: id,
      expectedAttempt: 0,
      clientOrderId: 'agt-p1-a1',
      nowMs: NOW,
    });

    const second = await claimTradingPlan(schema.pool, {
      planId: id,
      expectedAttempt: 0,
      clientOrderId: 'agt-p1-a2',
      nowMs: NOW,
    });

    // 关键：不是抛错，是「没抢到」。两个执行器同时跑是正常情况。
    expect(second).toBe(false);
    const row = await readTradingPlanById(schema.pool, 'binance', id);
    expect(row?.status).toBe('executing');
    // 第一次认领记下的号不能被覆盖——那会让人以为可以拿同一个号重试。
    expect(row?.clientOrderId).toBe('agt-p1-a1');
  });

  it('尝试次数对不上 → 认领失败（乐观锁：读 → 算号 → 认领之间被别人抢了）', async () => {
    const id = await approvedPlan();
    const wrong = await claimTradingPlan(schema.pool, {
      planId: id,
      expectedAttempt: 5,
      clientOrderId: 'agt-p1-a6',
      nowMs: NOW,
    });

    expect(wrong).toBe(false);
    const row = await readTradingPlanById(schema.pool, 'binance', id);
    expect(row?.status).toBe('approved');
    expect(row?.attempt).toBe(0);
  });

  it('只捞 approved 的方案（认领走的不再被捞）', async () => {
    const id = await approvedPlan();
    const before = await listApprovedTradingPlans(schema.pool, 'binance');
    expect(before.some((p) => p.id === id)).toBe(true);

    await claimTradingPlan(schema.pool, {
      planId: id,
      expectedAttempt: 0,
      clientOrderId: 'agt-p1-a1',
      nowMs: NOW,
    });

    const after = await listApprovedTradingPlans(schema.pool, 'binance');
    expect(after.some((p) => p.id === id)).toBe(false);
  });
});

describe('回填与失败', () => {
  it('回填单号 → 变成「已执行」', async () => {
    const id = await approvedPlan();
    await claimTradingPlan(schema.pool, {
      planId: id,
      expectedAttempt: 0,
      clientOrderId: 'agt-p1-a1',
      nowMs: NOW,
    });

    await markTradingPlanExecuted(schema.pool, {
      planId: id,
      entryOrderId: '123456',
      nowMs: NOW + 1,
    });

    const row = await readTradingPlanById(schema.pool, 'binance', id);
    expect(row?.status).toBe('executed');
    expect(row?.entryOrderId).toBe('123456');
    expect(row?.executedAtMs).toBe(NOW + 1);
  });

  it('「已执行」但没有单号 → 写不进去（表上的 CHECK 守着）', async () => {
    const id = await approvedPlan();
    await claimTradingPlan(schema.pool, {
      planId: id,
      expectedAttempt: 0,
      clientOrderId: 'agt-p1-a1',
      nowMs: NOW,
    });

    // 直接改库，绕过数据层：CHECK 必须自己挡住
    await expect(
      schema.pool.query(
        `UPDATE trading_plan SET status = 'executed', executed_at_ms = $2 WHERE id = $1`,
        [id, NOW],
      ),
    ).rejects.toThrow();
  });

  it('下单失败 → 记「失败」与原因', async () => {
    const id = await approvedPlan();
    await claimTradingPlan(schema.pool, {
      planId: id,
      expectedAttempt: 0,
      clientOrderId: 'agt-p1-a1',
      nowMs: NOW,
    });

    await markTradingPlanExecutionFailed(schema.pool, {
      planId: id,
      reason: '交易所拒绝：数量不合规',
      nowMs: NOW + 1,
    });

    const row = await readTradingPlanById(schema.pool, 'binance', id);
    expect(row?.status).toBe('failed');
    expect(row?.executionFailureReason).toContain('数量不合规');
  });

  it('「失败」但没有原因 → 写不进去', async () => {
    const id = await approvedPlan();
    await claimTradingPlan(schema.pool, {
      planId: id,
      expectedAttempt: 0,
      clientOrderId: 'agt-p1-a1',
      nowMs: NOW,
    });

    await expect(
      schema.pool.query(`UPDATE trading_plan SET status = 'failed' WHERE id = $1`, [id]),
    ).rejects.toThrow();
  });

  it('卡在「执行中」的方案能被单独读出来（执行器要报「状态未知」）', async () => {
    const id = await approvedPlan();
    await claimTradingPlan(schema.pool, {
      planId: id,
      expectedAttempt: 0,
      clientOrderId: 'agt-p1-a1',
      nowMs: NOW,
    });

    const stuck = await listExecutingTradingPlans(schema.pool, 'binance');
    expect(stuck.some((p) => p.id === id)).toBe(true);
  });
});

describe('落库时的初始状态', () => {
  it('缺省是「建议」（advisory）', async () => {
    const id = await recordTradingPlan(schema.pool, plan());
    const row = await readTradingPlanById(schema.pool, 'binance', id);
    expect(row?.status).toBe('advisory');
  });

  it('自动执行开关打开时直接落「已批准」', async () => {
    const id = await recordTradingPlan(schema.pool, plan({ status: 'approved' }));
    const row = await readTradingPlanById(schema.pool, 'binance', id);
    expect(row?.status).toBe('approved');
  });

  it('控制面**不能**把方案改成「已执行」——那要真的下过单', async () => {
    // `updateTradingPlanStatus` 只接受 approved / rejected / expired。
    // 允许它置 `executed` 的话，页面上点一下就能造出一条「已下单」的假记录。
    const id = await recordTradingPlan(schema.pool, plan());
    await expect(updateTradingPlanStatus(schema.pool, id, 'executed')).rejects.toThrow(
      /不允许把方案状态改成/,
    );
  });
});
