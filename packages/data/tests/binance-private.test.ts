/**
 * Binance 私有客户端测试。**不出网**：fetch 全部注入假实现。
 *
 * 锁三件事：
 *   1. 签名请求带 `X-MBX-APIKEY` 且 query 里含 `timestamp` / `recvWindow`；
 *   2. `ORDER_TRADE_UPDATE` 解析正确，且 `ap=0` 时退回成交价（而不是当成 0 入场价）；
 *   3. 交易所报错一律抛错带 code，不返回空对象假装成功。
 */

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
        orderId: 1,
        clientOrderId: 'x',
        symbol: 'SYM',
        side: 'SELL',
        type: 'STOP_MARKET',
        stopPrice: '100',
        status: 'NEW',
      });
    }) as unknown as typeof fetch);

    await client.placeClosePositionOrder({
      symbol: 'SYM',
      side: 'SELL',
      type: 'STOP_MARKET',
      stopPrice: 100,
      clientOrderId: 'rsk-sl-1',
    });

    expect(seenHeaders['X-MBX-APIKEY']).toBe('key-123');
    expect(seenUrl).toContain('/fapi/v1/order?');
    expect(seenUrl).toMatch(/[?&]timestamp=\d+/);
    expect(seenUrl).toMatch(/[?&]recvWindow=/);
    expect(seenUrl).toMatch(/[?&]signature=[0-9a-f]{64}$/);
    // closePosition 的条件单不能带 quantity / reduceOnly（官方明确）
    expect(seenUrl).not.toMatch(/[?&]quantity=/);
    expect(seenUrl).not.toMatch(/[?&]reduceOnly=/);
    expect(seenUrl).toContain('closePosition=true');
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
    },
  };

  it('解析出完整成交', () => {
    const update = parseOrderTradeUpdate(payload);
    expect(update).toMatchObject({
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
