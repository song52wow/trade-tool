/**
 * 交易对账的编排层测试（v0.6.0）。
 *
 * 判据本身在 core 的纯函数测试里；这里锁的是**取数与范围**这一层：
 *
 *   1. 本地只查 `armed` / `failed`——已终结记录的两张单本来就该不在交易所，
 *      把它们拉进来会凭空造出一堆「少了止损单」的假警报；
 *   2. **本地与交易所的范围必须一致**。查了 A 标的的本地记录、却拿全账户的交易所
 *      快照去比，会报出一条纯属虚构的「止损单不见了」——那是最容易被当真、
 *      也最经不起推敲的一种假警报；
 *   3. **只读**：跑完对账，`risk_bracket` 一行都不能变。
 *
 * 不出网：交易所侧是纯替身，PG 用随机 schema。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  claimBracket,
  markBracketArmed,
  markBracketFailed,
  markBracketSettled,
  readBracket,
  runReconciliation,
  type BinancePrivateClient,
  type ExchangeAlgoOrder,
  type ExchangePosition,
} from '../src/index.js';

import { createTestSchema, type TestSchema } from './helpers/pg.js';

const NOW = 1_760_000_000_000;

interface Call {
  symbol?: string;
}

/** 记录每次调用的交易所替身：不出网，只回测试给的数据。 */
function fakeClient(input: {
  positions?: ExchangePosition[];
  algoOrders?: ExchangeAlgoOrder[];
}) {
  const calls: Call[] = [];
  const client = {
    positionRisk(options: Call = {}): Promise<ExchangePosition[]> {
      calls.push({ symbol: options.symbol });
      return Promise.resolve(input.positions ?? []);
    },
    openAlgoOrders(options: Call = {}): Promise<ExchangeAlgoOrder[]> {
      calls.push({ symbol: options.symbol });
      return Promise.resolve(input.algoOrders ?? []);
    },
  };
  return { client: client as unknown as BinancePrivateClient, calls };
}

function algo(symbol: string, entryOrderId: string, tag: 'tp' | 'sl', algoId: number, price: number) {
  return {
    algoId,
    clientAlgoId: `rsk-${tag}-${entryOrderId}`,
    algoType: 'CONDITIONAL',
    orderType: tag === 'tp' ? 'TAKE_PROFIT' : 'STOP',
    symbol,
    side: 'SELL' as const,
    positionSide: 'BOTH' as const,
    algoStatus: 'NEW',
    triggerPrice: price,
    closePosition: true,
    createTime: NOW - 1000,
    updateTime: NOW - 1000,
  };
}

/**
 * 造一条本地记录。
 *
 * **每个用例用各自的标的**：整份文件共用一个测试 schema，而对账默认按标的取数，
 * 共用标的会让前一个用例的记录漏进后一个用例的断言。
 */
async function seedArmed(
  pool: TestSchema['pool'],
  symbol: string,
  entryOrderId: string,
  state: 'armed' | 'failed' = 'armed',
): Promise<void> {
  await claimBracket(pool, {
    exchange: 'binance',
    symbol,
    entryOrderId,
    entryPrice: 100,
    entryTime: NOW - 3600_000,
    filledQty: 2,
    positionSide: 'LONG',
    atr: 2,
    atrPeriod: 14,
    atrInterval: '1h',
    atrWindowFrom: NOW - 7200_000,
    atrWindowTo: NOW - 3600_000,
    stopPrice: 96,
    takeProfit: 108,
    now: NOW,
  });
  if (state === 'armed') {
    await markBracketArmed(
      pool,
      { exchange: 'binance', symbol, entryOrderId },
      { tpAlgoId: Number(entryOrderId) + 1, slAlgoId: Number(entryOrderId) + 2 },
      NOW,
    );
  } else {
    // 占坑后下单失败：库里留下 failed 行 + 常驻可见的原因。
    await markBracketFailed(
      pool,
      { exchange: 'binance', symbol, entryOrderId },
      {},
      'ATR 不可用',
      NOW,
    );
  }
}

describe('交易对账的取数与范围', () => {
  let ctx: TestSchema;

  beforeAll(async () => {
    ctx = await createTestSchema('recon');
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('两边一致时报告 healthy', async () => {
    await seedArmed(ctx.pool, 'AAAUSDT', '1001');
    const { client } = fakeClient({
      positions: [
        {
          symbol: 'AAAUSDT',
          positionSide: 'BOTH',
          positionAmt: 2,
          entryPrice: 100,
          markPrice: 101,
          updateTime: NOW,
        },
      ],
      algoOrders: [
        // 单号必须与 seedArmed 回填的 tpAlgoId / slAlgoId 一致（entryOrderId + 1 / +2），
        // 否则会凭空多出一条「交易所挂着我方单但本地没引用它」的孤儿告警。
        algo('AAAUSDT', '1001', 'sl', 1003, 96),
        algo('AAAUSDT', '1001', 'tp', 1002, 108),
      ],
    });

    const report = await runReconciliation({
      pool: ctx.pool,
      client,
      exchange: 'binance',
      symbol: 'AAAUSDT',
    });
    expect(report.differences).toEqual([]);
    expect(report.healthy).toBe(true);
    expect(report.scope).toEqual({ localUnsettled: 1, exchangePositions: 1, exchangeAlgoOrders: 2 });
  });

  it('本地记为已挂单、交易所没有止损单 → critical', async () => {
    await seedArmed(ctx.pool, 'BBBUSDT', '2002');
    const { client } = fakeClient({
      algoOrders: [algo('BBBUSDT', '2002', 'tp', 22, 108)],
    });

    const report = await runReconciliation({
      pool: ctx.pool,
      client,
      exchange: 'binance',
      symbol: 'BBBUSDT',
    });
    const item = report.differences.find((d) => d.kind === 'missing-stop-order');
    expect(item?.severity).toBe('critical');
    expect(item?.entryOrderId).toBe('2002');
  });

  it('已终结的记录不进对账（单已被交易所自动撤销，不该报缺失）', async () => {
    const entryOrderId = '3003';
    await seedArmed(ctx.pool, 'CCCUSDT', entryOrderId);
    await markBracketSettled(
      ctx.pool,
      { exchange: 'binance', symbol: 'CCCUSDT', entryOrderId },
      'take_profit',
      NOW,
    );
    const { client } = fakeClient({ algoOrders: [] });

    const report = await runReconciliation({
      pool: ctx.pool,
      client,
      exchange: 'binance',
      symbol: 'CCCUSDT',
    });
    // 只查未终结记录 → 这一条不该被算成「止损单不见了」。
    expect(report.differences).toEqual([]);
    expect(report.scope.localUnsettled).toBe(0);
  });

  it('failed 记录同样进对账，且带出失败原因', async () => {
    await seedArmed(ctx.pool, 'DDDUSDT', '4004', 'failed');
    const { client } = fakeClient({});

    const report = await runReconciliation({
      pool: ctx.pool,
      client,
      exchange: 'binance',
      symbol: 'DDDUSDT',
    });
    const item = report.differences.find((d) => d.kind === 'unprotected-position');
    expect(item?.evidence['lastError']).toBe('ATR 不可用');
  });

  it('指定标的时，本地与交易所查的是同一个标的（范围必须一致）', async () => {
    await seedArmed(ctx.pool, 'EEEUSDT', '5005');
    const { client, calls } = fakeClient({
      algoOrders: [algo('EEEUSDT', '5005', 'sl', 57, 96)],
    });

    await runReconciliation({
      pool: ctx.pool,
      client,
      exchange: 'binance',
      symbol: 'EEEUSDT',
    });

    // 两次调用必须带同一个 symbol：拿全账户的快照去比单标的记录，会报出一条
    // 纯属虚构的「止损单不见了」。
    expect(calls).toEqual([{ symbol: 'EEEUSDT' }, { symbol: 'EEEUSDT' }]);
  });

  it('全账户对账时不带 symbol 参数（由调用方决定权重）', async () => {
    const { client, calls } = fakeClient({});
    await runReconciliation({ pool: ctx.pool, client, exchange: 'binance' });
    expect(calls).toEqual([{}, {}]);
  });

  it('对账是只读的：跑完之后 risk_bracket 一行未改', async () => {
    const before = await readBracket(ctx.pool, 'binance', 'BBBUSDT', '2002');
    const { client } = fakeClient({});
    await runReconciliation({ pool: ctx.pool, client, exchange: 'binance' });
    const after = await readBracket(ctx.pool, 'binance', 'BBBUSDT', '2002');
    expect(after).toEqual(before);
  });
});
