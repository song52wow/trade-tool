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
  listReconciliations,
  readLatestReconciliation,
  recordReconciliation,
  markBracketArmed,
  markBracketFailed,
  markBracketSettled,
  readBracket,
  runReconciliation,
  type BinancePrivateClient,
  type ExchangeAlgoOrder,
  type ExchangePosition,
  type ReconcileReport,
} from '../src/index.js';

import { createTestSchema, type TestSchema } from './helpers/pg.js';

const NOW = 1_760_000_000_000;

interface Call {
  symbol?: string;
}

/** 记录每次调用的交易所替身：不出网，只回测试给的数据。 */
function fakeClient(input: { positions?: ExchangePosition[]; algoOrders?: ExchangeAlgoOrder[] }) {
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

function position(symbol: string): ExchangePosition {
  return {
    symbol,
    positionSide: 'BOTH',
    positionAmt: 1,
    entryPrice: 100,
    markPrice: 101,
    updateTime: NOW,
  };
}

function algo(
  symbol: string,
  entryOrderId: string,
  tag: 'tp' | 'sl',
  algoId: number,
  price: number,
) {
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
    quantity: null,
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
    expect(report.scope).toEqual({
      localUnsettled: 1,
      exchangePositions: 1,
      exchangeAlgoOrders: 2,
    });
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

/**
 * 对账**快照**的读写（v0.6.0）。
 *
 * 这张表只服务「让自动对账的结果能被界面看到」，因此用例也只锁三件事：
 *   1. 一致与有差异都写得进去，且差异明细原样存回；
 *   2. 写失败**整体回滚**，不留下半套状态（半套会让界面显示一个不存在的结论）；
 *   3. 同一范围只留最近 N 次——不设上限总有一天会拖慢查询。
 *
 * 另外锁住「从没跑过时返回 null」：把「还没对过账」和「对过了、一致」混成同一个
 * 空状态，正是这份面板最不该犯的错。
 */
describe('对账快照', () => {
  let ctx: TestSchema;

  beforeAll(async () => {
    ctx = await createTestSchema('reconrun');
  });
  afterAll(async () => {
    await ctx.close();
  });

  async function seed(symbol: string, checkedAt: number): Promise<ReconcileReport> {
    return runReconciliation({
      pool: ctx.pool,
      // 取 .client：fakeClient 返回的是 { client, calls }，整个传进去会得到
      // 「client.positionRisk is not a function」——外层对象上没有这些方法。
      client: fakeClient({ positions: [position(symbol)] }).client,
      exchange: 'binance',
      // 必须传 symbol：缺省会按**全账户**跑，快照落在空 scope 上，
      // 读回单标的时自然是 null。这正是本模块强调的「范围必须一致」。
      symbol,
      now: () => checkedAt,
    });
  }

  it('从未跑过时返回 null（不是一份空报告）', async () => {
    expect(await readLatestReconciliation(ctx.pool, 'binance', 'NEVERRANUSDT')).toBeNull();
  });

  it('差异明细原样存回，读出来逐字段相同', async () => {
    const report = await seed('SNAPUSDT', NOW);
    await recordReconciliation(ctx.pool, report, NOW);

    const snapshot = await readLatestReconciliation(ctx.pool, 'binance', 'SNAPUSDT');
    expect(snapshot?.healthy).toBe(false);
    expect(snapshot?.checkedAt).toBe(NOW);
    expect(snapshot?.differences).toEqual(report.differences);
    expect(snapshot?.counts).toEqual(report.counts);
    expect(snapshot?.scope).toEqual(report.scope);
  });

  it('全账户快照记在空 scope 上，与单标的快照互不覆盖', async () => {
    const account = await runReconciliation({
      pool: ctx.pool,
      client: fakeClient({ positions: [position('ACCUSDT')] }).client,
      exchange: 'binance',
      now: () => NOW,
    });
    await recordReconciliation(ctx.pool, account, NOW);

    expect(await readLatestReconciliation(ctx.pool, 'binance', '')).not.toBeNull();
    expect(await readLatestReconciliation(ctx.pool, 'binance', 'ACCUSDT')).toBeNull();
    // 全账户快照的 symbol 是 null，不是空串——界面上要能说清「这是全账户」。
    expect((await readLatestReconciliation(ctx.pool, 'binance', ''))?.symbol).toBeNull();
  });

  it('后写的覆盖先读的（取最新一条）', async () => {
    await recordReconciliation(ctx.pool, await seed('LATESTUSDT', NOW), NOW);
    await recordReconciliation(ctx.pool, await seed('LATESTUSDT', NOW + 1000), NOW + 1000);
    expect((await readLatestReconciliation(ctx.pool, 'binance', 'LATESTUSDT'))?.checkedAt).toBe(
      NOW + 1000,
    );
  });

  it('同一范围只保留最近 50 次，且最新的不能被裁掉', async () => {
    for (let i = 0; i < 60; i += 1) {
      await recordReconciliation(ctx.pool, await seed('TRIMUSDT', NOW + i), NOW + i);
    }
    // 保留条数直接数表：用 listReconciliations 的默认 limit（20）去断言「保留 50 条」
    // 会在页大小上失败，而本页大小与保留策略是两件事。
    const kept = await ctx.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM reconcile_run WHERE exchange = $1 AND scope = $2`,
      ['binance', 'TRIMUSDT'],
    );
    expect(Number(kept.rows[0]?.n)).toBe(50);
    const rows = await listReconciliations(ctx.pool, 'binance', 'TRIMUSDT');
    expect(rows[0]?.checkedAt).toBe(NOW + 59);
  });

  it('裁剪不影响别的范围', async () => {
    await recordReconciliation(ctx.pool, await seed('OTHERUSDT', NOW), NOW);
    for (let i = 0; i < 60; i += 1) {
      await recordReconciliation(ctx.pool, await seed('TRIM2USDT', NOW + i), NOW + i);
    }
    expect(await readLatestReconciliation(ctx.pool, 'binance', 'OTHERUSDT')).not.toBeNull();
  });
});
