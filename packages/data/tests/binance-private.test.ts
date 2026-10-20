/**
 * Binance 私有客户端测试。**不出网**：fetch 全部注入假实现。
 *
 * 锁三件事：
 *   1. 签名请求带 `X-MBX-APIKEY` 且 query 里含 `timestamp` / `recvWindow`；
 *   2. `ORDER_TRADE_UPDATE` 解析正确，且 `ap=0` 时退回成交价（而不是当成 0 入场价）；
 *   3. 交易所报错一律抛错带 code，不返回空对象假装成功。
 */

import { SyncError } from '@trade-tool/core';
import {
  BinancePrivateClient,
  ORDER_TRADE_UPDATE,
  parseOrderTradeUpdate,
  parseTickSize,
} from '@trade-tool/data';
import { describe, expect, it } from 'vitest';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function clientWith(fetchImpl: typeof fetch): BinancePrivateClient {
  return new BinancePrivateClient({
    credentials: { apiKey: 'key-123', apiSecret: 'secret-456' },
    baseUrl: 'https://fapi.test',
    fetchImpl,
  });
}

describe('私有 REST', () => {
  it('签名请求带 API key 头，且 query 含时间戳与时间窗', async () => {
    let seenUrl = '';
    let seenHeaders: Record<string, string> = {};
    const client = clientWith((async (url: string, init: RequestInit) => {
      seenUrl = String(url);
      seenHeaders = init.headers as Record<string, string>;
      return jsonResponse({
        algoId: 1,
        clientAlgoId: 'x',
        symbol: 'SYM',
        side: 'SELL',
        orderType: 'STOP_MARKET',
        triggerPrice: '100',
        algoStatus: 'NEW',
      });
    }) as unknown as typeof fetch);

    await client.placeClosePositionOrder({
      symbol: 'SYM',
      side: 'SELL',
      type: 'STOP_MARKET',
      stopPrice: 100,
      clientAlgoId: 'rsk-sl-1',
    });

    expect(seenHeaders['X-MBX-APIKEY']).toBe('key-123');
    // 条件单已迁到 Algo Order API：打老接口会被拒
    // （Order type not supported for this endpoint）。
    expect(seenUrl).toContain('/fapi/v1/algoOrder?');
    expect(seenUrl).toContain('algoType=CONDITIONAL');
    expect(seenUrl).toContain('triggerPrice=100');
    expect(seenUrl).toContain('clientAlgoId=rsk-sl-1');
    expect(seenUrl).toMatch(/[?&]timestamp=\d+/);
    expect(seenUrl).toMatch(/[?&]recvWindow=/);
    expect(seenUrl).toMatch(/[?&]signature=[0-9a-f]{64}$/);
    // closePosition 的条件单不能带 quantity / reduceOnly（官方明确）
    expect(seenUrl).not.toMatch(/[?&]quantity=/);
    expect(seenUrl).not.toMatch(/[?&]reduceOnly=/);
    expect(seenUrl).toContain('closePosition=true');
  });

  // v0.7.0 的契约断言：分批止盈靠的是**另一组参数**。按 AGENTS.md §10.1 第 1 条，
  // 这些「值」必须有对着契约写的断言——今天 listenKeyUrl 从对变错时 122 个测试全绿，
  // 就是因为没有任何用例断言过那个地址。
  it('带数量的条件单：发 quantity 与 reduceOnly，且绝不发 closePosition', async () => {
    let seenUrl = '';
    const client = clientWith(async (url: string) => {
      seenUrl = String(url);
      return jsonResponse({
        algoId: 555,
        clientAlgoId: 'rsk-tp-1',
        algoType: 'CONDITIONAL',
        orderType: 'TAKE_PROFIT_MARKET',
        symbol: 'BNBUSDT',
        side: 'SELL',
        positionSide: 'BOTH',
        algoStatus: 'NEW',
        triggerPrice: '750.000',
        closePosition: false,
        quantity: '0.5',
        createTime: 1750514941540,
        updateTime: 1750514941540,
      });
    });
    const placed = await client.placeQuantityOrder({
      symbol: 'BNBUSDT',
      side: 'SELL',
      type: 'TAKE_PROFIT_MARKET',
      stopPrice: 750,
      quantity: 0.5,
      reduceOnly: true,
      clientAlgoId: 'rsk-tp-1',
    });

    expect(seenUrl).toContain('/fapi/v1/algoOrder?');
    expect(seenUrl).toContain('algoType=CONDITIONAL');
    expect(seenUrl).toMatch(/[?&]quantity=0\.5(&|$)/);
    expect(seenUrl).toMatch(/[?&]reduceOnly=true(&|$)/);
    // 互斥：`quantity` 与 `closePosition` 不能并存（官方明确，同时发是 -1106）
    expect(seenUrl).not.toMatch(/[?&]closePosition=/);
    // 回执：条件单走的是 algoId 编号空间，不是普通 orderId
    expect(placed.algoId).toBe(555);
  });

  // 2026-10-17 实测：撤单**成功**时回的就是 `{"code":200,"msg":"success"}`。
  // 旧判定「有 code 键就是错误」会把每一次成功撤单报成失败——而 v0.7.0 的移动止损
  // 规定「撤旧失败就不推进档位」，那会让档位永远不推进。这条用例锁住修复。
  it('撤单成功（回 {code:200,msg:success}）不算失败', async () => {
    let seenUrl = '';
    const client = clientWith(async (url: string) => {
      seenUrl = String(url);
      return jsonResponse({ code: 200, msg: 'success' });
    });
    await expect(client.cancelAlgoOrder(123456)).resolves.toBeUndefined();
    expect(seenUrl).toContain('/fapi/v1/algoOrder?');
  });

  it('撤单失败（负数码）仍然要报错，且错误信息带上交易所的 msg', async () => {
    const client = clientWith(async () => jsonResponse({ code: -2011, msg: 'Unknown order' }, 400));
    await expect(client.cancelAlgoOrder(123456)).rejects.toThrow(/Unknown order/);
  });

  it('数量非正直接报错，不把 0 发到交易所', async () => {
    let called = false;
    const client = clientWith(async () => {
      called = true;
      return jsonResponse({});
    });
    await expect(
      client.placeQuantityOrder({
        symbol: 'BNBUSDT',
        side: 'SELL',
        type: 'TAKE_PROFIT_MARKET',
        stopPrice: 750,
        quantity: 0,
        clientAlgoId: 'rsk-tp-1',
      }),
    ).rejects.toThrow(SyncError);
    expect(called).toBe(false);
  });

  it('listenKey 请求不签名但仍带 API key 头', async () => {
    let seenUrl = '';
    let seenHeaders: Record<string, string> = {};
    const client = clientWith((async (url: string, init: RequestInit) => {
      seenUrl = String(url);
      seenHeaders = init.headers as Record<string, string>;
      return jsonResponse({ listenKey: 'lk-1' });
    }) as unknown as typeof fetch);

    expect(await client.createListenKey()).toBe('lk-1');
    expect(seenUrl).toBe('https://fapi.test/fapi/v1/listenKey');
    expect(seenUrl).not.toContain('signature=');
    expect(seenHeaders['X-MBX-APIKEY']).toBe('key-123');
  });

  it('交易所报错必须抛错并带上 code，不静默成功', async () => {
    const client = clientWith((async () =>
      jsonResponse(
        { code: -2021, msg: 'Order would immediately trigger.' },
        400,
      )) as unknown as typeof fetch);
    await expect(
      client.placeClosePositionOrder({
        symbol: 'SYM',
        side: 'SELL',
        type: 'STOP_MARKET',
        stopPrice: 1,
        clientOrderId: 'rsk-sl-1',
      }),
    ).rejects.toThrow(/immediately trigger/);
  });

  it('listenKey 缺失时报错而不是返回空串', async () => {
    const client = clientWith((async () => jsonResponse({})) as unknown as typeof fetch);
    await expect(client.createListenKey()).rejects.toThrow(/listenKey/);
  });

  // 旧地址 `${streamUrl}/ws/<listenKey>` **握手照样成功**（onopen 触发、不报错、
  // 不重连），但 Binance 2026-04-23 起已下线它，并且省略 `/private` 不投递账户事件。
  // 后果是买入成交永远不触发挂单，而日志干净得像一切正常——「看起来在跑、实际失明」
  // 比直接崩掉危险得多。这个地址以前没有任何断言，才让问题一直藏着。
  it('用户数据流必须走 /private 路由，旧地址静默收不到事件', () => {
    const client = clientWith((async () => jsonResponse({})) as unknown as typeof fetch);
    const url = client.listenKeyUrl('KEY-123');
    expect(url).toContain('/private/ws');
    expect(url).toContain('listenKey=KEY-123');
    // 旧写法：`${streamUrl}/ws/${listenKey}`。这条断言失败即表示地址回退了。
    expect(url).not.toMatch(/\/ws\/KEY-123$/);
  });
});

describe('parseOrderTradeUpdate', () => {
  const payload = {
    e: ORDER_TRADE_UPDATE,
    E: 1_700_000_000_000,
    T: 1_700_000_000_001,
    o: {
      s: 'SYM',
      c: 'client-1',
      S: 'BUY',
      o: 'MARKET',
      f: 'GTC',
      q: '0.1',
      p: '60000',
      ap: '60010.5',
      sp: '0',
      x: 'TRADE',
      X: 'FILLED',
      i: 42,
      l: '0.1',
      z: '0.1',
      T: 1_700_000_000_002,
      ps: 'BOTH',
      // 手续费是必返字段（官方 ORDER_TRADE_UPDATE 的 n / N）。
      n: '0.04',
      N: 'USDT',
    },
  };

  it('解析出完整成交', () => {
    const update = parseOrderTradeUpdate(payload);
    expect(update).toMatchObject({
      // 手续费要能被算进实际盈亏：单位与计价币一致（USDT）
      commission: 0.04,
      commissionAsset: 'USDT',
      symbol: 'SYM',
      orderId: 42,
      side: 'BUY',
      status: 'FILLED',
      executionType: 'TRADE',
      averagePrice: 60010.5,
      cumulativeQty: 0.1,
      tradeTime: 1_700_000_000_002,
    });
  });

  it('ap=0 时退回本笔成交价，不会当成 0 入场价', () => {
    const update = parseOrderTradeUpdate({
      ...payload,
      o: { ...payload.o, ap: '0' },
    });
    expect(update?.averagePrice).toBe(60000);
  });

  it('非该事件返回 null', () => {
    expect(parseOrderTradeUpdate({ e: 'listenKeyExpired' })).toBeNull();
    expect(parseOrderTradeUpdate(null)).toBeNull();
    expect(parseOrderTradeUpdate('x')).toBeNull();
  });

  it('缺字段即报错：解析错字段的症状是止损挂在错误仓位上', () => {
    expect(() => parseOrderTradeUpdate({ e: ORDER_TRADE_UPDATE, o: {} })).toThrow();
  });
});

describe('parseTickSize', () => {
  it('从 PRICE_FILTER 取 tickSize', () => {
    expect(
      parseTickSize(
        {
          filters: [
            { filterType: 'LOT_SIZE', stepSize: '0.001' },
            { filterType: 'PRICE_FILTER', tickSize: '0.10' },
          ],
        },
        'SYM',
      ),
    ).toBe(0.1);
  });

  it('缺快照 / 缺 PRICE_FILTER 一律报错，不猜默认值', () => {
    expect(() => parseTickSize(null, 'SYM')).toThrow(/tickSize/);
    expect(() => parseTickSize({ filters: [] }, 'SYM')).toThrow(/PRICE_FILTER/);
    expect(() => parseTickSize({ filters: [{ filterType: 'PRICE_FILTER' }] }, 'SYM')).toThrow();
  });
});

/**
 * 只读查询端点的**契约断言**（v0.6.0）。
 *
 * AGENTS.md「交易所接缝必须核对契约」第 1 条：接缝的**值**必须有对着契约写的断言，
 * 而不是对着自己的实现复述。`listenKeyUrl` 从对变错时 122 个测试全绿，就是因为没有任何
 * 用例断言过那个地址——这里的每一条都对着 **2026-10-11 核对**过的官方文档。
 *
 * 锁住的「值」：
 *   * `GET /fapi/v3/positionRisk` —— **v3**，v2 已被官方列入待下线；
 *   * `GET /fapi/v1/openAlgoOrders` —— 条件单查询走 Algo Order API 家族；
 *   * 数量字段在 payload 里是**字符串**，必须转成数字；
 *   * `orderType` 查询侧回 `TAKE_PROFIT` / `STOP`（**不是**下单侧的 `*_MARKET`）。
 */
describe('只读查询端点（v0.6.0 对账用）', () => {
  /** 官方 positionRisk 示例，字段值原样照抄。 */
  const POSITION_PAYLOAD = [
    {
      symbol: 'ADAUSDT',
      positionSide: 'BOTH',
      positionAmt: '30',
      entryPrice: '0.385',
      markPrice: '0.41047590',
      unRealizedProfit: '0.76427700',
      updateTime: 1720736417660,
    },
  ];

  /** 官方 openAlgoOrders 示例。`orderType` 是 `TAKE_PROFIT`，与下单侧不同。 */
  const ALGO_PAYLOAD = [
    {
      algoId: 2148627,
      clientAlgoId: 'rsk-sl-1001',
      algoType: 'CONDITIONAL',
      orderType: 'TAKE_PROFIT',
      symbol: 'BNBUSDT',
      side: 'SELL',
      positionSide: 'BOTH',
      algoStatus: 'NEW',
      triggerPrice: '750.000',
      closePosition: true,
      // 带数量的条件单才有这个字段（v0.7.0）；closePosition 单解析成 null。
      quantity: null,
      createTime: 1750514941540,
      updateTime: 1750514941540,
    },
  ];

  it('positionRisk 走 v3（不是已被列入待下线的 v2），且带 symbol', async () => {
    const urls: string[] = [];
    const client = clientWith((async (url: string) => {
      urls.push(String(url));
      return jsonResponse(POSITION_PAYLOAD);
    }) as unknown as typeof fetch);

    const rows = await client.positionRisk({ symbol: 'ADAUSDT' });

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/fapi/v3/positionRisk');
    expect(urls[0]).not.toContain('/v2/positionRisk');
    expect(urls[0]).toContain('symbol=ADAUSDT');
    expect(rows[0]).toEqual({
      symbol: 'ADAUSDT',
      positionSide: 'BOTH',
      // 字符串必须转成数字：直接透传会让「positionAmt === 0」永远不成立。
      positionAmt: 30,
      entryPrice: 0.385,
      markPrice: 0.4104759,
      updateTime: 1720736417660,
    });
  });

  it('openAlgoOrders 走 /fapi/v1/openAlgoOrders，并原样保留查询侧的 orderType', async () => {
    const urls: string[] = [];
    const client = clientWith((async (url: string) => {
      urls.push(String(url));
      return jsonResponse(ALGO_PAYLOAD);
    }) as unknown as typeof fetch);

    const rows = await client.openAlgoOrders({ symbol: 'BNBUSDT' });

    expect(urls[0]).toContain('/fapi/v1/openAlgoOrders');
    expect(rows[0]?.algoId).toBe(2148627);
    // 这里**不能**「顺手统一」成 TAKE_PROFIT_MARKET：两侧取值本来就不同，
    // 统一掉差异就从代码里消失了，而 core 的 algoOrderTag 正是靠这个差异认类型。
    expect(rows[0]?.orderType).toBe('TAKE_PROFIT');
    expect(rows[0]?.triggerPrice).toBe(750);
    expect(rows[0]?.closePosition).toBe(true);
  });

  it('不带 symbol 时**不发送** symbol 参数（不是发送空串）', async () => {
    const urls: string[] = [];
    const client = clientWith((async (url: string) => {
      urls.push(String(url));
      return jsonResponse(POSITION_PAYLOAD);
    }) as unknown as typeof fetch);

    await client.positionRisk();
    expect(urls[0]).not.toContain('symbol=');
  });

  it('返回的不是数组就抛错，不返回空数组假装「没有仓位」', async () => {
    const client = clientWith((async () =>
      jsonResponse({ code: -1, msg: 'nope' })) as unknown as typeof fetch);
    await expect(client.positionRisk()).rejects.toThrow();
    await expect(client.openAlgoOrders()).rejects.toThrow();
  });

  it('字段缺失 / 类型不对一律抛错带字段名', async () => {
    const client = clientWith((async () =>
      jsonResponse([{ symbol: 'ADAUSDT', positionAmt: 'abc' }])) as unknown as typeof fetch);
    await expect(client.positionRisk()).rejects.toThrow(/positionAmt/);
  });
});
