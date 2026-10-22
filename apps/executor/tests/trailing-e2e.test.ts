/**
 * 移动止损的**端到端**用例：真库 + 真 service，只有行情与交易所是替身。
 *
 * 与 `executor.test.ts`（全替身）的分工：
 *   * `executor.test.ts` 守的是**单轮**的行为：该不该动、动了对不对、失败留不留原因；
 *   * 这里守的是**累积**：止损连着挪好几档之后，库里那一行、交易所上那几张单、
 *     以及「永远只朝有利方向」这条棘轮，是不是**逐轮都还自洽**。
 *
 * 累积这件事替身守不住：替身的 SQL 分支是手写的匹配（`sql.includes('SET trail_stop_price = $4, …')`），
 * 真库的列一改它就悄悄失配，测试还绿。真库跑一遍，`risk_bracket_staged_check`
 * （`trailing` 必须有 `trail_stop_price > 0`）、`risk_bracket_state_check`
 * 与那几条 UPDATE 的 WHERE 才是真的在守。
 *
 * 场景：多头分批形态 → 第一段止盈成交 → 剩余仓位交给 Chandelier 移动止损，
 * 随后行情连续创新高，止损**连挪三档**（要求「至少三层」）。
 *
 * 全程不出网（AGENTS.md §8.2）；库是随机 schema，绝不连生产库（§8.1）。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configSchema, type TradeToolConfig } from '@trade-tool/core';
import {
  createTestSchema,
  readBracket,
  type OrderTradeUpdate,
  type TestSchema,
} from '@trade-tool/data';

import type { AtrProvider, AtrSnapshot } from '../src/atr.js';
import type { OrderPlacer } from '../src/service.js';
import { bracketClientOrderId, createExecutorService } from '../src/service.js';
import { startTrailingTimer } from '../src/trailing.js';

// ---------------------------------------------------------------------------
// 场景常量
// ---------------------------------------------------------------------------

const EXCHANGE = 'binance';
const SYMBOL = 'TRAILE2EUSDC';
const ENTRY_ORDER_ID = '42';

/** 每根 1m K 线的毫秒数。行情脚本按分钟推进，与真实节奏一致。 */
const MINUTE = 60_000;

/** 进场时刻。三轮移动分别落在 T0+2min / +3min / +4min。 */
const T0 = 1_760_000_000_000;

const ENTRY_PRICE = 60_000;
const ATR_VALUE = 100;
/** 进场保护：入场价 − 2×ATR。 */
const ENTRY_STOP = ENTRY_PRICE - 2 * ATR_VALUE;
/** 第一段止盈：入场价 + 3×ATR。 */
const TP1_PRICE = ENTRY_PRICE + 3 * ATR_VALUE;
/** 移动止损：持仓期极值 − 2×ATR。 */
const TRAIL_MULT = 2;

/**
 * 行情脚本：每个时刻的「持仓期极值」与「最后一根已收盘 K 线的收盘价」。
 *
 * `high: null` = **极值取不到**。刚开仓就是这种情况（持仓期内一根已收盘 K 线都没有），
 * 所以第一条必须是它——否则测试从一开始就在一个不存在的世界里跑。
 */
interface MarketMark {
  high: number | null;
  low: number;
  lastClose: number;
}

const MARKS = new Map<number, MarketMark>([
  // 刚开仓：持仓期内没有已收盘 K 线，极值必然取不到。
  [T0, { high: null, low: ENTRY_PRICE, lastClose: ENTRY_PRICE }],
  // 第一段止盈成交：价格涨到 60300。
  [T0 + MINUTE, { high: TP1_PRICE, low: ENTRY_STOP, lastClose: TP1_PRICE }],
  // 随后连续创新高，每一轮都把止损顶上去一档。
  [T0 + 2 * MINUTE, { high: 60_500, low: ENTRY_STOP, lastClose: 60_500 }],
  [T0 + 3 * MINUTE, { high: 60_800, low: ENTRY_STOP, lastClose: 60_800 }],
  [T0 + 4 * MINUTE, { high: 61_100, low: ENTRY_STOP, lastClose: 61_100 }],
  // 回落：现价掉下来了。持仓期**极值**不会变小（它是持仓期的最高价），
  // 所以止损位天然不会放宽——但现价一旦低于当前档位，就触发了「越过现价」。
  [T0 + 5 * MINUTE, { high: 61_100, low: 60_700, lastClose: 60_700 }],
]);

/**
 * 行情替身：按 `asOfMs` 取**不超过该时刻的最近一条**标记。
 *
 * 「最近一条」而不是「必须精确命中」，是因为取数的语义本来就是「截至此刻的行情」；
 * 而命中不到任何标记时**直接报错**——替身不许悄悄编一个数出来。
 */
function scriptedAtr(): AtrProvider {
  return {
    async atrAt(symbol: string, asOfMs: number, entryTimeMs: number): Promise<AtrSnapshot> {
      let hit: MarketMark | null = null;
      for (const [at, mark] of MARKS) {
        if (at <= asOfMs) hit = mark;
      }
      if (hit === null) {
        throw new Error(`行情脚本里没有 asOf=${String(asOfMs)} 之前的任何行情`);
      }
      return {
        symbol,
        interval: '1m',
        intervalMs: MINUTE,
        period: 14,
        atr: ATR_VALUE,
        barsUsed: 200,
        segmentFrom: entryTimeMs,
        segmentTo: asOfMs,
        asOfMs,
        extreme:
          hit.high === null
            ? null
            : { high: hit.high, low: hit.low, from: entryTimeMs, to: asOfMs },
        lastClose: hit.lastClose,
      };
    },
  };
}

interface LiveOrder {
  algoId: number;
  type: string;
  stopPrice: number;
  quantity?: number;
  /** 交易所侧的自定义号。**同时存在两张同号的挂单会被真交易所拒掉。** */
  clientAlgoId: string;
  /** 标的。`closePosition` 的唯一性是**按标的 + 方向**算的。 */
  symbol: string;
}

/**
 * 交易所替身：额外维护「交易所上**此刻**活着的单」，
 * 这样才能断言「连挪三档之后，止损单始终只有一张、且价就是当前那一档」。
 *
 * 只记动作顺序不够——那看不出「挂新撤旧之间有没有出现两张」或者「撤完有没有剩零张」。
 */
function fakeExchange() {
  const live = new Map<number, LiveOrder>();
  const actions: string[] = [];
  /** 被撤掉的单连同它当时的价——用来断言「撤的确实是**旧档**那一张」。 */
  const cancelled: { algoId: number; stopPrice: number }[] = [];
  let seq = 900;
  /**
   * **正在挂着的单的自定义号**。
   *
   * Binance 不允许同时存在两张 `clientAlgoId` 相同的挂单（重复直接被拒：
   * `ClientOrderId is duplicated.`）。这个替身**必须也守这条规则**——
   * 2026-10-22 实测踩到：止损单的自定义号只由入场单号派生，于是每次挪止损
   * 用的都是同一个号，而进场那张还在挂着，于是**第一次挪就被拒**，
   * 止损价永远停在入场那一档，而三方全绿、无人能看见。
   *
   * 替身不守这条规则时，那条端到端用例一直是绿的——它守不住真交易所会拒的东西。
   */
  const liveClientIds = new Set<string>();
  /** 挂单时用过的**每一个**自定义号（含已撤掉的）。 */
  const allClientIds: string[] = [];

  const placer: OrderPlacer = {
    async placeClosePositionOrder(request) {
      if (liveClientIds.has(request.clientAlgoId)) {
        throw new Error('ClientOrderId is duplicated.');
      }
      // **同标的同方向只能有一张 `closePosition` 条件单**。
      //
      // 2026-10-22 实测（Demo Trading）：
      // `An open stop or take profit order with GTE and closePosition in the direction is existing.`
      //
      // 这条规则决定了挪止损的顺序**只能是「先撤旧、再挂新」**——
      // 「先挂新」必然被拒（旧的还挂着）。替身不守这条规则时，
      // 端到端用例会一直绿，而真交易所上第一挪就被拒。
      const sameSymbol = [...live.values()].some(
        (order) => order.symbol === request.symbol && order.quantity === undefined,
      );
      if (sameSymbol) {
        throw new Error(
          'An open stop or take profit order with GTE and closePosition in the direction is existing.',
        );
      }
      seq += 1;
      liveClientIds.add(request.clientAlgoId);
      allClientIds.push(request.clientAlgoId);
      live.set(seq, {
        algoId: seq,
        type: request.type,
        stopPrice: request.stopPrice,
        clientAlgoId: request.clientAlgoId,
        symbol: request.symbol,
      });
      actions.push(`place:${request.type}:${request.stopPrice}`);
      return {
        algoId: seq,
        clientAlgoId: request.clientAlgoId,
        symbol: request.symbol,
        status: 'NEW',
      };
    },
    async placeQuantityOrder(request) {
      if (liveClientIds.has(request.clientAlgoId)) {
        throw new Error('ClientOrderId is duplicated.');
      }
      seq += 1;
      liveClientIds.add(request.clientAlgoId);
      allClientIds.push(request.clientAlgoId);
      live.set(seq, {
        algoId: seq,
        type: request.type,
        stopPrice: request.stopPrice,
        quantity: request.quantity,
        clientAlgoId: request.clientAlgoId,
        symbol: request.symbol,
      });
      actions.push(`placeQuantity:${request.type}:${request.stopPrice}:${request.quantity}`);
      return {
        algoId: seq,
        clientAlgoId: request.clientAlgoId,
        symbol: request.symbol,
        status: 'NEW',
      };
    },
    async cancelAlgoOrder(algoId: number) {
      const order = live.get(algoId);
      if (order !== undefined) {
        cancelled.push({ algoId, stopPrice: order.stopPrice });
        // 撤掉之后这个号就释放了（Binance 的唯一性约束只对**还挂着**的单生效）。
        liveClientIds.delete(order.clientAlgoId);
      }
      live.delete(algoId);
      actions.push(`cancel:${String(algoId)}`);
    },
  };

  return {
    placer,
    live,
    actions,
    cancelled,
    /**
     * 挂单时用过的**全部**自定义号（按顺序，含已撤掉的）。
     *
     * Binance 不允许同时存在两张同号的挂单，所以这些号必须两两不同——
     * 而这条规则由替身在挂单那一刻守住（见上面的 `liveClientIds`）。
     */
    placedClientIds: (): string[] => [...allClientIds],
    /**
     * 交易所上此刻活着的**止损单**。
     *
     * 只数止损单，不数全部单：分批形态下第一段止盈是**带数量**的条件单，
     * 它成交后**不会**被交易所自动撤销（`closePosition` 才有那个保证），
     * 要等本地撤——这是 v0.7.0 明确接受的取舍，由对账的
     * `unexpected-take-profit-order` 报告（AGENTS.md §6.8）。
     */
    liveStops: (): LiveOrder[] => [...live.values()].filter((o) => o.type === 'STOP_MARKET'),
  };
}

function makeConfig(): TradeToolConfig {
  return configSchema.parse({
    market: { symbol: SYMBOL, exchange: EXCHANGE },
    executor: {
      enabled: true,
      // 分批形态：先兑现一半，剩下的交给移动止损。
      takeProfit1Ratio: 0.5,
      trailAtrMult: TRAIL_MULT,
      breakevenAfterTp1: true,
    },
  });
}

function fill(overrides: Partial<OrderTradeUpdate> = {}): OrderTradeUpdate {
  return {
    eventTime: T0,
    transactionTime: T0,
    symbol: SYMBOL,
    clientOrderId: 'user-entry-1',
    orderId: 42,
    side: 'BUY',
    orderType: 'MARKET',
    averagePrice: ENTRY_PRICE,
    lastFilledPrice: ENTRY_PRICE,
    lastFilledQty: 0.1,
    cumulativeQty: 0.1,
    origQty: 0.1,
    executionType: 'TRADE',
    status: 'FILLED',
    tradeTime: T0,
    commission: 0.04,
    commissionAsset: 'USDT',
    positionSide: 'BOTH',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 真库
// ---------------------------------------------------------------------------

let schema: TestSchema;

beforeAll(async () => {
  schema = await createTestSchema('traile2e');
  // 合约规格：止盈止损要对齐到最小价格变动，而 tickSize 只存在于 exchangeInfo 原始条目里。
  // 不插这一行，真实实现会直接抛 CONFIG_INVALID（不许拿默认 tickSize 猜一个）。
  await schema.pool.query(
    `INSERT INTO contract_spec (exchange, symbol, contract_type, status, onboard_date, raw, updated_at)
     VALUES ($1, $2, 'PERPETUAL', 'TRADING', $3, $4::jsonb, $5)
     ON CONFLICT (exchange, symbol) DO NOTHING`,
    [
      EXCHANGE,
      SYMBOL,
      T0 - 30 * 24 * 60 * MINUTE,
      JSON.stringify({
        symbol: SYMBOL,
        filters: [
          { filterType: 'PRICE_FILTER', tickSize: '0.10' },
          { filterType: 'LOT_SIZE', stepSize: '0.001' },
        ],
      }),
      T0,
    ],
  );
});

afterAll(async () => {
  await schema.close();
});

beforeEach(async () => {
  // 一个 schema 多个用例：业务表清干净，合约规格留着。
  await schema.pool.query('TRUNCATE risk_bracket');
});

/**
 * 走完「开仓 → 第一段止盈成交」，把仓位交到移动止损手里。
 *
 * 返回时钟、交易所替身与 service，供用例接着往下推。
 */
async function enterAndFillTp1(): Promise<{
  clock: { value: number };
  exchange: ReturnType<typeof fakeExchange>;
  service: ReturnType<typeof createExecutorService>;
}> {
  const clock = { value: T0 };
  const exchange = fakeExchange();
  const service = createExecutorService({
    pool: schema.pool,
    config: makeConfig(),
    placer: exchange.placer,
    atr: scriptedAtr(),
    now: () => clock.value,
  });

  // ① 开仓成交 → 挂出第一段止盈（带数量）与进场止损，记录停在 `partial_armed`。
  expect(await service.handleFill(fill())).toBe('armed');

  // ② 第一段止盈成交（带数量的那张）。
  clock.value = T0 + MINUTE;
  expect(
    await service.handleFill(
      fill({
        clientOrderId: bracketClientOrderId('tp', ENTRY_ORDER_ID),
        side: 'SELL',
        lastFilledPrice: TP1_PRICE,
        lastFilledQty: 0.05,
        commission: 0.02,
        tradeTime: T0 + MINUTE,
      }),
    ),
  ).toBe('trailing');

  return { clock, exchange, service };
}

async function readRow() {
  const row = await readBracket(schema.pool, EXCHANGE, SYMBOL, ENTRY_ORDER_ID);
  if (row === null) throw new Error('库里没有这一行止盈止损记录');
  return row;
}

/**
 * 等库里的档位变成期望值。
 *
 * 定时器那一轮是**异步**的（`void service.trailOnce().then(…)`），所以不能写死
 * 「触发回调 → 立刻断言」。用轮询等结果，而不是猜它要几个微任务才落地——
 * 猜错的话，这个用例会在「跑得慢一点的机器上」变成随机失败。
 */
async function waitForStop(expected: number): Promise<void> {
  await vi.waitFor(
    async () => {
      const row = await readRow();
      expect(row.trailStopPrice).toBe(expected);
    },
    { timeout: 5_000, interval: 50 },
  );
}

// ---------------------------------------------------------------------------

describe('移动止损端到端：连挪三档', () => {
  it('开仓 → 第一段止盈成交 → 止损连挪三档，每一档都真的落库、真的撤旧挂新', async () => {
    const { clock, exchange, service } = await enterAndFillTp1();

    // 第一段成交后：阶段是 `trailing`，止损已经挪到「极值 − 2×ATR」。
    const afterTp1 = await readRow();
    expect(afterTp1.state).toBe('trailing');
    expect(afterTp1.trailStopPrice).toBe(TP1_PRICE - TRAIL_MULT * ATR_VALUE);
    expect(afterTp1.trailLastError).toBeNull();

    // 进场那张止损单已被换掉，交易所上只剩**一张**止损单。
    expect(exchange.liveStops()).toHaveLength(1);

    // ---- 连挪三档 ----
    const movedStops: number[] = [];
    const rounds = [
      { at: T0 + 2 * MINUTE, expectStop: 60_300 },
      { at: T0 + 3 * MINUTE, expectStop: 60_600 },
      { at: T0 + 4 * MINUTE, expectStop: 60_900 },
    ];

    for (const round of rounds) {
      clock.value = round.at;
      const report = await service.trailOnce();

      expect(report.moved).toBe(1);
      expect(report.failed).toBe(0);
      // 阶段早就推进过了，这一轮不该再推进。
      expect(report.advanced).toBe(0);

      const row = await readRow();
      // 档位真的落在库里，而且就是这一轮算出来的那一档。
      const stop = row.trailStopPrice;
      if (stop === null) throw new Error('这一轮挪了档，档位却还是空的');
      expect(stop).toBe(round.expectStop);
      movedStops.push(stop);

      // 交易所上**始终只有一张**止损单，价就是当前那一档。
      const stops = exchange.liveStops();
      expect(stops).toHaveLength(1);
      expect(stops[0]?.stopPrice).toBe(round.expectStop);
      // 账面的单号就是交易所上那一张的编号（对账靠它比价）。
      expect(row.slAlgoId).toBe(stops[0]?.algoId);
      // 这一轮没有留下任何「没挪成」的原因。
      expect(row.trailLastError).toBeNull();
    }

    // **至少挪了三层**：三次都往有利方向走，一层都没回头。
    expect(movedStops).toHaveLength(3);
    expect(movedStops).toEqual([60_300, 60_600, 60_900]);
    for (let i = 1; i < movedStops.length; i += 1) {
      expect(movedStops[i]!).toBeGreaterThan(movedStops[i - 1]!);
    }

    // 每一轮都是「先撤旧、再挂新」，而且撤掉的**正是上一档那一张**。
    //
    // 顺序不是随意的：Binance 不允许同标的同方向同时存在两张 `closePosition` 条件单
    // （2026-10-22 实测），所以「先挂新」必然被拒——只能先撤旧的。
    //
    // 动作序列是全量断言（不按类型筛）：进场那一次 place 后面没有 cancel 是对的——
    // 那时还没有旧单可撤。从第一段成交开始，每次换档都是「撤旧、紧接着挂新」两连动作。
    expect(exchange.actions.slice(-8)).toEqual([
      expect.stringMatching(/^cancel:\d+$/),
      'place:STOP_MARKET:60100',
      expect.stringMatching(/^cancel:\d+$/),
      'place:STOP_MARKET:60300',
      expect.stringMatching(/^cancel:\d+$/),
      'place:STOP_MARKET:60600',
      expect.stringMatching(/^cancel:\d+$/),
      'place:STOP_MARKET:60900',
    ]);

    // 被撤掉的四张依次是 59800 / 60100 / 60300 / 60600——
    // **每一张都是旧档**，最后一张才是当前这一档。撤错档 = 保护落在错误的价位。
    expect(exchange.cancelled.map((c) => c.stopPrice)).toEqual([
      ENTRY_STOP,
      60_100,
      60_300,
      60_600,
    ]);
  });

  // v0.9.2：Binance 不允许同时存在两张 `clientAlgoId` 相同的挂单，
  // 而挪单是「先挂新、再撤旧」——旧单此刻还在交易所上。
  // 2026-10-22 实测踩到：号只由入场单号派生，于是**第一次挪就被拒**，
  // 止损价永远停在入场那一档，而账面、交易所、对账三方全绿。
  it('每一档止损单都有自己的号：号复用会被交易所拒（2026-10-22 实测的那个坑）', async () => {
    const { clock, exchange, service } = await enterAndFillTp1();

    // 先挪三档。**每挪一档都成功**这件事本身就是证据：
    // 替身与真交易所同一条规则（同号挂第二次会被拒），号复用的话第一次挪就失败。
    for (const at of [T0 + 2 * MINUTE, T0 + 3 * MINUTE, T0 + 4 * MINUTE]) {
      clock.value = at;
      const report = await service.trailOnce();
      expect(report.moved).toBe(1);
      expect(report.failed).toBe(0);
    }

    // 挂过的每一个自定义号都不同：
    // 进场那两张（第一段止盈 + 进场止损）+ 第一段成交后挪的那张 + 三轮定时器各一张 = 6。
    const ids = exchange.placedClientIds();
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    // 其中止损单是五张：进场那张 + 第一段成交后挪的那张（挪到保本位）+ 三轮定时器各一张。
    // 而它们的号必须各不相同。
    const stopIds = ids.filter((id) => id.startsWith('rsk-sl'));
    expect(stopIds).toHaveLength(5);
    expect(new Set(stopIds).size).toBe(5);
    // 号带档位序号，且**逐档递增**——号永不复用。
    expect(stopIds).toEqual(['rsk-sl-42', 'rsk-sl1-42', 'rsk-sl2-42', 'rsk-sl3-42', 'rsk-sl4-42']);

    // 库里记着「占用了几个号」与「成功换过几档」：两者相等 = 没有失败的尝试。
    const row = await readRow();
    expect(row.trailStep).toBe(4);
    expect(row.trailMoves).toBe(4);
    // 止损价真的挪过（不是一直停在入场那一档）。
    expect(row.trailStopPrice).toBe(60_900);
  });

  it('价格回落：档位**不放宽**（棘轮），越过现价时本轮不动且原因可见', async () => {
    const { clock, exchange, service } = await enterAndFillTp1();

    // 先涨一波，把止损顶上去。
    clock.value = T0 + 4 * MINUTE;
    expect((await service.trailOnce()).moved).toBe(1);
    const before = await readRow();
    expect(before.trailStopPrice).toBe(60_900);
    const liveBefore = exchange.liveStops();

    // 再回落：现价掉到 60700，**低于**当前那一档 60900。
    //
    // 此时若还按「极值 − 2×ATR」算，算出来的还是 60900（极值是持仓期最高价，回落不会变小），
    // 但它已经**越过现价**——挂上去会立刻触发，等于用市价平仓。
    // 所以本轮不动、保留原档，并把原因常驻可见。
    clock.value = T0 + 5 * MINUTE;
    const report = await service.trailOnce();
    expect(report.moved).toBe(0);
    expect(report.unchanged).toBe(1);
    expect(report.failed).toBe(0);

    const after = await readRow();
    // 档位**没有后退**（棘轮：永不放宽）。
    expect(after.trailStopPrice).toBe(60_900);
    // 「为什么没挪」必须看得见，不能只打一行日志就过去。
    expect(after.trailLastError).toContain('越过现价');
    // 交易所上的止损单一张没多、也一张没少，价还是那一档。
    expect(exchange.liveStops()).toEqual(liveBefore);
  });

  it('定时器驱动：启动就挪第一档，之后每周期再挪一档——连挪三档', async () => {
    // 生产环境里驱动移动止损的**唯一**入口是定时器（`apps/executor/src/trailing.ts`），
    // 而不是谁去手动调 `trailOnce()`。这一档必须从定时器走一遍，
    // 否则「定时器没在跑」这类故障根本测不出来。
    const { clock, exchange, service } = await enterAndFillTp1();

    // 手动驱动：把定时器的回调收集起来，一轮一轮放出来。
    const ticks: (() => void)[] = [];
    const timer = startTrailingTimer(service, 60_000, {
      setIntervalImpl: (fn) => {
        ticks.push(fn);
        return 0 as unknown as NodeJS.Timeout;
      },
      clearIntervalImpl: () => undefined,
    });

    try {
      // 定时器**启动立刻跑第一轮**（这是有意设计的：重启往往正是需要补挂的时刻）。
      clock.value = T0 + 2 * MINUTE;
      await waitForStop(60_300);

      // 之后每个周期再挪一档。
      clock.value = T0 + 3 * MINUTE;
      ticks[0]?.();
      await waitForStop(60_600);

      clock.value = T0 + 4 * MINUTE;
      ticks[0]?.();
      await waitForStop(60_900);

      // 三档都到位，一层都没回头。
      const row = await readRow();
      expect(row.trailStopPrice).toBe(60_900);
      expect(row.state).toBe('trailing');
      // 交易所上仍然只有一张止损单，价就是当前那一档。
      const stops = exchange.liveStops();
      expect(stops).toHaveLength(1);
      expect(stops[0]?.stopPrice).toBe(60_900);
    } finally {
      timer.stop();
    }
  });

  it('第一段还没成交的行：移动止损不碰它（那是进场保护）', async () => {
    // 只开仓，不推进第一段。
    const clock = { value: T0 };
    const exchange = fakeExchange();
    const service = createExecutorService({
      pool: schema.pool,
      config: makeConfig(),
      placer: exchange.placer,
      atr: scriptedAtr(),
      now: () => clock.value,
    });
    expect(await service.handleFill(fill())).toBe('armed');

    clock.value = T0 + 4 * MINUTE;
    const report = await service.trailOnce();
    expect(report.moved).toBe(0);
    expect(report.advanced).toBe(0);
    expect(report.unchanged).toBe(0);

    // 档位还是空：止损没有被移动过。
    const row = await readRow();
    expect(row.state).toBe('partial_armed');
    expect(row.trailStopPrice).toBeNull();
  });
});
