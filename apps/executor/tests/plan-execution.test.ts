/**
 * 方案执行器（`apps/executor/src/plan-execution.ts`）的行为测试（v1.0.0 自动下单）。
 *
 * **不连 PG、不出网**：数据库用记录 SQL 的假池子，交易所用替身。
 * 锁的是「这份方案会不会变成订单，以及在什么情况下**不会**」——
 * 后者比前者更要紧：自动下单是唯一一处「程序自己决定要花钱」的地方，
 * 而「多下了一单」比「少下了一单」危险得多。
 *
 * 具体锁住这七条：
 *   1. 批准了的方案 → 认领 → 下市价单 → 回填单号；
 *   2. **只能下一单**：认领是幂等的，第二轮不会重复下；
 *   3. 已有仓位 → 不叠加开仓；
 *   4. 已有未终结的止盈止损 → 不开新仓；
 *   5. 限价方案 → **跳过并写明原因**（不认领、不下单）；
 *   6. 下单失败 → 方案记 `failed` + 原因；
 *   7. 过期的方案 → 作废，不再执行。
 */

import { describe, expect, it } from 'vitest';

import {
  createPlanExecutor,
  resolveAgentPlanDecision,
  type MarketOrderPlacer,
  type PlanExecutorDeps,
} from '../src/plan-execution.js';
import type { Pool } from '@trade-tool/data';

const NOW = 1_760_000_000_000;
const SYMBOL = 'TESTUSDT';

interface PlanRow {
  id: string;
  symbol: string;
  action: 'enter' | 'hold' | 'failed';
  status: 'advisory' | 'approved' | 'executing' | 'executed' | 'rejected' | 'expired' | 'failed';
  side: 'BUY' | 'SELL' | null;
  entryType: 'market' | 'limit' | null;
  entryPrice: number | null;
  stopPrice: number | null;
  takeProfitPrice: number | null;
  quantity: number | null;
  atr: number | null;
  stopAtrMult: number | null;
  takeProfitAtrMult: number | null;
  rationale: string;
  createdAtMs: number;
  attempt: number;
  clientOrderId: string | null;
  entryOrderId: string | null;
  claimedAtMs: number | null;
  executedAtMs: number | null;
  executionFailureReason: string | null;
  reportId: string | null;
  notional: number | null;
  riskAmount: number | null;
  equity: number | null;
  equitySource: 'exchange' | 'config' | null;
  riskFraction: number | null;
  riskReward: number | null;
  stance: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  adjustments: string[];
  failureReason: string | null;
  raw: string | null;
  asOfMs: number;
  exchange: string;
}

function planRow(overrides: Partial<PlanRow> = {}): PlanRow {
  return {
    id: '1',
    symbol: SYMBOL,
    action: 'enter',
    status: 'approved',
    side: 'BUY',
    entryType: 'market',
    entryPrice: 100,
    stopPrice: 96,
    takeProfitPrice: 106,
    quantity: 25,
    atr: 2,
    stopAtrMult: 2,
    takeProfitAtrMult: 3,
    rationale: '回调买。',
    createdAtMs: NOW,
    attempt: 0,
    clientOrderId: null,
    entryOrderId: null,
    claimedAtMs: null,
    executedAtMs: null,
    executionFailureReason: null,
    reportId: null,
    notional: 2500,
    riskAmount: 100,
    equity: 10_000,
    equitySource: 'config',
    riskFraction: 0.01,
    riskReward: 1.5,
    stance: 'bullish',
    confidence: 0.8,
    adjustments: [],
    failureReason: null,
    raw: null,
    asOfMs: NOW,
    exchange: 'binance',
    ...overrides,
  };
}

interface FakeDb {
  pool: Pool;
  plans: PlanRow[];
  /** 认领成功的方案 id（幂等锚点）。 */
  claimed: string[];
  executed: { planId: string; entryOrderId: string }[];
  failed: { planId: string; reason: string }[];
  expired: string[];
  /**
   * 让「回填单号」那一步写不进去（模拟「单下了但回填前崩了」）。
   *
   * 做成假池子自己的开关，而不是在测试里包一层 `pool.query`——
   * `pg` 的 `query` 是重载的，包一层就得跟它的签名较劲，而这里要的是
   * 「这一条 SQL 写不进去」这一个事实。
   */
  failWriteback: boolean;
}

/**
 * 一份方案 → **数据库行**（蛇形列名）。
 *
 * 必须转成蛇形：数据层的 `toPlanRow` 是按**列名**读的，
 * 直接把驼峰对象塞回去的话，每个字段都读成 `undefined`——
 * 而 `undefined === null` 为假，于是「没有方向」这类检查全部落空，
 * 一份缺字段的方案会被当成可执行的。
 */
function toDbRow(plan: PlanRow): Record<string, unknown> {
  return {
    id: plan.id,
    exchange: plan.exchange,
    symbol: plan.symbol,
    report_id: plan.reportId,
    as_of_ms: plan.asOfMs,
    created_at_ms: plan.createdAtMs,
    action: plan.action,
    status: plan.status,
    side: plan.side,
    entry_type: plan.entryType,
    entry_price: plan.entryPrice,
    stop_price: plan.stopPrice,
    take_profit_price: plan.takeProfitPrice,
    quantity: plan.quantity,
    notional: plan.notional,
    risk_amount: plan.riskAmount,
    equity: plan.equity,
    equity_source: plan.equitySource,
    risk_fraction: plan.riskFraction,
    atr: plan.atr,
    stop_atr_mult: plan.stopAtrMult,
    take_profit_atr_mult: plan.takeProfitAtrMult,
    risk_reward: plan.riskReward,
    stance: plan.stance,
    confidence: plan.confidence,
    rationale: plan.rationale,
    adjustments: plan.adjustments,
    failure_reason: plan.failureReason,
    raw: plan.raw,
    entry_order_id: plan.entryOrderId,
    client_order_id: plan.clientOrderId,
    attempt: plan.attempt,
    claimed_at_ms: plan.claimedAtMs,
    executed_at_ms: plan.executedAtMs,
    execution_failure_reason: plan.executionFailureReason,
  };
}

/**
 * 记录 SQL 的假池子。
 *
 * 它**真的实现了状态机**：认领会把方案从 `approved` 挪到 `executing`，
 * 回填会把它挪到 `executed`。只返回固定值的话，「第二轮会不会重复下」这条就测不到。
 */
function fakeDb(plans: PlanRow[]): FakeDb {
  const db: FakeDb = {
    pool: undefined as unknown as Pool,
    plans,
    claimed: [],
    executed: [],
    failed: [],
    expired: [],
    failWriteback: false,
  };
  db.pool = {
    query: async (sql: string, values?: readonly unknown[]) => {
      const v = values ?? [];
      if (sql.includes('FROM trading_plan') && sql.includes("status = 'approved'")) {
        return { rows: db.plans.filter((p) => p.status === 'approved').map(toDbRow), rowCount: 1 };
      }
      if (sql.includes('FROM trading_plan') && sql.includes("status = 'executing'")) {
        return { rows: db.plans.filter((p) => p.status === 'executing').map(toDbRow), rowCount: 1 };
      }
      if (sql.includes('FROM trading_plan') && sql.includes('AND id =')) {
        const plan = db.plans.find((p) => p.id === String(v[1] ?? v[0]));
        return {
          rows: plan === undefined ? [] : [toDbRow(plan)],
          rowCount: plan === undefined ? 0 : 1,
        };
      }
      // 认领：`SET status = 'executing'`。注意必须匹配 SET 而不是 WHERE——
      // 回填那条 SQL 的 WHERE 里也有 `status = 'executing'`。
      if (sql.includes('UPDATE trading_plan') && sql.includes("SET status = 'executing'")) {
        const plan = db.plans.find((p) => p.id === String(v[0]));
        if (plan === undefined) return { rows: [], rowCount: 0 };
        if (plan.status !== 'approved' || plan.attempt !== Number(v[1])) {
          return { rows: [], rowCount: 0 };
        }
        plan.status = 'executing';
        plan.attempt += 1;
        plan.clientOrderId = String(v[2]);
        plan.claimedAtMs = Number(v[3]);
        db.claimed.push(plan.id);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE trading_plan') && sql.includes("SET status = 'executed'")) {
        // 回填写不进去：单已经下了，但库里没有单号。
        if (db.failWriteback) return { rows: [], rowCount: 0 };
        const plan = db.plans.find((p) => p.id === String(v[0]));
        if (plan === undefined || plan.status !== 'executing') return { rows: [], rowCount: 0 };
        plan.status = 'executed';
        plan.entryOrderId = String(v[1]);
        plan.executedAtMs = Number(v[2]);
        db.executed.push({ planId: plan.id, entryOrderId: String(v[1]) });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE trading_plan') && sql.includes("SET status = 'failed'")) {
        const plan = db.plans.find((p) => p.id === String(v[0]));
        if (plan === undefined || plan.status !== 'executing') return { rows: [], rowCount: 0 };
        plan.status = 'failed';
        plan.executionFailureReason = String(v[1]);
        db.failed.push({ planId: plan.id, reason: String(v[1]) });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE trading_plan') && sql.includes('SET status = $2')) {
        const plan = db.plans.find((p) => p.id === String(v[0]));
        if (plan === undefined) return { rows: [], rowCount: 0 };
        plan.status = String(v[1]) as PlanRow['status'];
        db.expired.push(plan.id);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  return db;
}

interface FakePlacer extends MarketOrderPlacer {
  calls: { symbol: string; side: string; quantity: number; clientOrderId: string }[];
}

function fakePlacer(options: { fail?: string } = {}): FakePlacer {
  const calls: FakePlacer['calls'] = [];
  let nextId = 1000;
  return {
    calls,
    async placeMarketOrder(request) {
      if (options.fail !== undefined) {
        throw new Error(options.fail);
      }
      calls.push({ ...request });
      nextId += 1;
      return {
        orderId: nextId,
        clientOrderId: request.clientOrderId,
        symbol: request.symbol,
        status: 'FILLED',
        avgPrice: 100,
        executedQty: request.quantity,
      };
    },
  };
}

function makeExecutor(
  db: FakeDb,
  placer: FakePlacer,
  overrides: Partial<PlanExecutorDeps> = {},
): ReturnType<typeof createPlanExecutor> {
  return createPlanExecutor({
    pool: db.pool,
    placer,
    exchange: 'binance',
    now: () => NOW,
    ...overrides,
  });
}

describe('方案执行器', () => {
  it('批准的方案 → 认领 → 下市价单 → 回填单号', async () => {
    const db = fakeDb([planRow()]);
    const placer = fakePlacer();
    const executor = makeExecutor(db, placer);

    const report = await executor.runOnce();

    expect(report.executed).toBe(1);
    expect(report.failed).toBe(0);
    expect(placer.calls).toHaveLength(1);
    expect(placer.calls[0]?.symbol).toBe(SYMBOL);
    expect(placer.calls[0]?.side).toBe('BUY');
    expect(placer.calls[0]?.quantity).toBe(25);
    // 自定义号带方案号与尝试次数——每次尝试一个新号（否则撞「重复单号」）。
    expect(placer.calls[0]?.clientOrderId).toBe('agt-p1-a1');
    expect(db.executed).toHaveLength(1);
    expect(db.executed[0]?.entryOrderId).toBe('1001');
  });

  it('跑第二遍 → 不再下单（认领已经把方案挪走了）', async () => {
    const db = fakeDb([planRow()]);
    const placer = fakePlacer();
    const executor = makeExecutor(db, placer);

    await executor.runOnce();
    const second = await executor.runOnce();

    expect(placer.calls).toHaveLength(1);
    expect(second.executed).toBe(0);
  });

  it('已有仓位 → 不叠加开仓', async () => {
    const db = fakeDb([planRow()]);
    const placer = fakePlacer();
    const executor = makeExecutor(db, placer, { hasOpenPosition: () => true });

    const report = await executor.runOnce();

    expect(report.executed).toBe(0);
    expect(report.skipped).toBe(1);
    expect(placer.calls).toHaveLength(0);
    expect(report.details[0]?.reason).toContain('已有未平掉的仓位');
  });

  it('已有未终结的止盈止损 → 不开新仓', async () => {
    const db = fakeDb([planRow()]);
    const placer = fakePlacer();
    const executor = makeExecutor(db, placer, { hasUnsettledBracket: async () => true });

    const report = await executor.runOnce();

    expect(report.executed).toBe(0);
    expect(placer.calls).toHaveLength(0);
    expect(report.details[0]?.reason).toContain('未终结的止盈止损');
  });

  it('限价方案 → 跳过并写明原因（不认领、不下单）', async () => {
    const db = fakeDb([planRow({ entryType: 'limit' })]);
    const placer = fakePlacer();
    const executor = makeExecutor(db, placer);

    const report = await executor.runOnce();

    expect(report.executed).toBe(0);
    expect(report.skipped).toBe(1);
    expect(placer.calls).toHaveLength(0);
    expect(report.details[0]?.reason).toContain('限价进场暂不支持自动执行');
  });

  it('下单失败 → 方案记「失败」+ 原因', async () => {
    const db = fakeDb([planRow()]);
    const placer = fakePlacer({ fail: '交易所拒绝：数量不合规' });
    const executor = makeExecutor(db, placer);

    const report = await executor.runOnce();

    expect(report.failed).toBe(1);
    expect(report.executed).toBe(0);
    expect(db.failed).toHaveLength(1);
    expect(db.failed[0]?.reason).toContain('数量不合规');
    expect(db.plans[0]?.status).toBe('failed');
  });

  it('过期的方案 → 作废，不再执行', async () => {
    const db = fakeDb([planRow({ createdAtMs: NOW - 60 * 60_000 })]);
    const placer = fakePlacer();
    const executor = makeExecutor(db, placer, { planTtlMs: 30 * 60_000 });

    const report = await executor.runOnce();

    expect(report.executed).toBe(0);
    expect(placer.calls).toHaveLength(0);
    expect(db.expired).toContain('1');
    expect(db.plans[0]?.status).toBe('expired');
  });

  it('同时最多几笔：超出额度的不再开新的', async () => {
    const db = fakeDb([planRow({ id: '1' }), planRow({ id: '2' })]);
    const placer = fakePlacer();
    const executor = makeExecutor(db, placer, { maxOpenPlans: 1 });

    const report = await executor.runOnce();

    expect(report.executed).toBe(1);
    expect(placer.calls).toHaveLength(1);
    expect(report.skipped).toBe(1);
    expect(report.details[1]?.reason).toContain('同时最多 1 笔');
  });

  it('卡在「执行中」的方案 → 报成「状态未知」，不重试', async () => {
    const db = fakeDb([planRow({ status: 'executing' })]);
    const placer = fakePlacer();
    const executor = makeExecutor(db, placer);

    const report = await executor.runOnce();

    expect(report.stuck).toBe(1);
    expect(placer.calls).toHaveLength(0);
    expect(report.details[0]?.reason).toContain('执行中断');
  });
});

describe('从成交反查方案', () => {
  it('自定义号不是 Agent 格式 → 返回 null（不是我们的单）', async () => {
    const db = fakeDb([]);
    const resolved = await resolveAgentPlanDecision(db.pool, 'binance', {
      symbol: SYMBOL,
      clientOrderId: 'rsk-sl-123',
    });
    expect(resolved).toBeNull();
  });

  it('自定义号是 Agent 格式但库里没这份方案 → 返回 null 并留下错误日志', async () => {
    const db = fakeDb([]);
    const resolved = await resolveAgentPlanDecision(db.pool, 'binance', {
      symbol: SYMBOL,
      clientOrderId: 'agt-p99-a1',
    });
    expect(resolved).toBeNull();
  });

  it('认出方案 → 给出它的两个 ATR 倍数', async () => {
    const db = fakeDb([
      planRow({ id: '7', status: 'executed', stopAtrMult: 2.5, takeProfitAtrMult: 4 }),
    ]);
    const resolved = await resolveAgentPlanDecision(db.pool, 'binance', {
      symbol: SYMBOL,
      clientOrderId: 'agt-p7-a1',
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.planId).toBe('7');
    expect(resolved?.stopAtrMult).toBe(2.5);
    expect(resolved?.takeProfitAtrMult).toBe(4);
  });
});

describe('下单失败不能被吞掉', () => {
  it('交易所报错时既记失败，也把原因带出去', async () => {
    const db = fakeDb([planRow()]);
    const placer = fakePlacer({ fail: '网络断了' });
    const executor = makeExecutor(db, placer);

    const report = await executor.runOnce();

    expect(report.details[0]?.outcome).toBe('failed');
    expect(report.details[0]?.reason).toContain('网络断了');
  });

  it('回填失败时单已经下了 → 方案停在「执行中」（下一轮报状态未知）', async () => {
    const db = fakeDb([planRow()]);
    db.failWriteback = true;
    const placer = fakePlacer();

    const executor = makeExecutor(db, placer);
    const report = await executor.runOnce();

    // 单下了，但库里没单号：方案停在「执行中」，下一轮会被报成状态未知。
    expect(placer.calls).toHaveLength(1);
    expect(db.plans[0]?.status).toBe('executing');
    // ⚠️ **不算「已执行」**：库里那行还停在 `executing`，只看汇总数字的人
    // 会以为这事办完了（约定 9）。单列一个 outcome 把它标出来。
    expect(report.executed).toBe(0);
    expect(report.details[0]?.outcome).toBe('executed-unrecorded');
    expect(report.details[0]?.reason).toContain('没回填');
  });
});
