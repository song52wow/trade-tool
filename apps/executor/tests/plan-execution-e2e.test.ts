/**
 * 自动下单的**端到端**用例（v1.0.0）：批准的方案 → 真实订单 → 回填单号。
 *
 * 真 PG（真迁移，从空库跑到 018）+ 假交易所 HTTP 服务（真 HTTP，真签名，真下单接口）。
 *
 * 为什么必须有这一条：`plan-execution.test.ts` 用假池子 + 替身下单，
 * 验的是**编排逻辑**（认领、下限价失败、幂等）。但它验不到接缝那层：
 *   * 真实 SQL 的 WHERE 条件对不对（「捞的是不是真的 approved」）；
 *   * 回填时 UPDATE 的 WHERE 对不对（「会不会把没认领的行也改了」）；
 *   * 表上的 CHECK 拦不拦得住（「executed 却没有单号」写得进去吗）。
 * 这三条全是「替身版绿、真库红」的典型。
 */

import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BinancePrivateClient,
  createTestSchema,
  listApprovedTradingPlans,
  readTradingPlanById,
  recordTradingPlan,
  type TestSchema,
  type TradingPlanRecord,
} from '@trade-tool/data';

import { createPlanExecutor } from '../src/plan-execution.js';

const NOW = 1_760_000_000_000;
const SYMBOL = 'TESTUSDT';
const EXCHANGE = 'binance';

let schema: TestSchema;
let server: Server;
let baseUrl: string;
/** 假交易所收到的下单请求。 */
let placed: { symbol: string; side: string; quantity: string; clientOrderId: string }[] = [];

beforeAll(async () => {
  schema = await createTestSchema('plan_e2e');
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const params = new URLSearchParams(url.search);
      if (req.method === 'POST' && url.pathname === '/fapi/v1/order') {
        placed.push({
          symbol: params.get('symbol') ?? '',
          side: params.get('side') ?? '',
          quantity: params.get('quantity') ?? '',
          clientOrderId: params.get('newClientOrderId') ?? '',
        });
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            orderId: 987654,
            clientOrderId: params.get('newClientOrderId'),
            symbol: params.get('symbol'),
            side: params.get('side'),
            status: 'FILLED',
            avgPrice: '100',
            executedQty: params.get('quantity'),
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('端口拿不到');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await schema.close();
  await new Promise<void>((r) => server.close(() => r()));
});

function plan(overrides: Partial<TradingPlanRecord> = {}): TradingPlanRecord {
  return {
    exchange: EXCHANGE,
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
    status: 'approved',
    ...overrides,
  };
}

function client(): BinancePrivateClient {
  return new BinancePrivateClient({
    credentials: { apiKey: 'test-key', apiSecret: 'test-secret' },
    baseUrl,
    streamUrl: baseUrl,
  });
}

describe('自动下单端到端（真 PG + 假交易所）', () => {
  it('approved 方案 → 真的下出市价单 → 回填单号', async () => {
    const planId = await recordTradingPlan(schema.pool, plan());

    // 认领前：它在「待执行」队列里
    const queued = await listApprovedTradingPlans(schema.pool, EXCHANGE);
    expect(queued.map((p) => p.id)).toContain(planId);

    const executor = createPlanExecutor({
      pool: schema.pool,
      placer: client(),
      exchange: EXCHANGE,
      now: () => NOW + 1000,
    });
    const report = await executor.runOnce();

    // 交易所真的收到了一张市价单
    expect(placed).toHaveLength(1);
    expect(placed[0]?.symbol).toBe(SYMBOL);
    expect(placed[0]?.side).toBe('BUY');
    expect(placed[0]?.quantity).toBe('25');
    // 自定义号带尝试次数
    expect(placed[0]?.clientOrderId).toBe(`agt-p${planId}-a1`);

    // 库里：已执行，且**带单号与时刻**（表上的 CHECK 守着）
    const row = await readTradingPlanById(schema.pool, EXCHANGE, planId);
    expect(row?.status).toBe('executed');
    expect(row?.entryOrderId).toBe('987654');
    expect(row?.executedAtMs).toBe(NOW + 1000);
    expect(row?.clientOrderId).toBe(`agt-p${planId}-a1`);
    expect(row?.attempt).toBe(1);

    expect(report.executed).toBe(1);
    expect(report.failed).toBe(0);
  });

  it('第二轮不会再下一单（幂等锚点）', async () => {
    placed.length = 0;
    const planId = await recordTradingPlan(schema.pool, plan({ asOfMs: NOW + 10 }));

    const executor = createPlanExecutor({
      pool: schema.pool,
      placer: client(),
      exchange: EXCHANGE,
      now: () => NOW + 2000,
    });
    await executor.runOnce();
    expect(placed).toHaveLength(1);

    // 再跑一轮：这一份已经是「已执行」，不该被重新捞起来
    const again = await executor.runOnce();
    expect(placed).toHaveLength(1);
    expect(again.executed).toBe(0);

    const row = await readTradingPlanById(schema.pool, EXCHANGE, planId);
    expect(row?.status).toBe('executed');
    expect(row?.attempt).toBe(1);
  });

  it('限价方案 → 兜底跳过并写明原因（不认领、不下单）', async () => {
    placed.length = 0;
    const planId = await recordTradingPlan(
      schema.pool,
      // 限价进场价 95，止损必须仍在它**下方**（表上的 CHECK 守着「分居两侧」）
      plan({ asOfMs: NOW + 20, entryType: 'limit', entryPrice: 95, stopPrice: 90 }),
    );

    const executor = createPlanExecutor({
      pool: schema.pool,
      placer: client(),
      exchange: EXCHANGE,
      now: () => NOW + 3000,
    });
    const report = await executor.runOnce();

    expect(placed).toHaveLength(0);
    expect(report.failed).toBe(0);
    expect(report.skipped).toBe(1);
    expect(report.details[0]?.reason).toContain('限价进场暂不支持自动执行');

    // ⚠️ **不认领**：方案停在 `approved`，不会卡在 `executing`（那才是「状态未知」）。
    // 正常路径上它压根不该到 `approved`——agent 的自动批准与控制面 / CLI 的人工
    // 批准都拒绝限价。这里是兜底。
    const row = await readTradingPlanById(schema.pool, EXCHANGE, planId);
    expect(row?.status).toBe('approved');
    expect(row?.attempt).toBe(0);
  });
});
