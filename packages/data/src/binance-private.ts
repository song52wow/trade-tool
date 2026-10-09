/**
 * Binance USDⓈ-M 永续的**私有**接口（v0.4.0）。
 *
 * 仓库此前只接了行情（`market.ts` / Python 侧 `binance.py`），下单与用户数据流是全新
 * 的一块能力，因此这里把「怎么跟交易所说话」这件事收在一处：签名、listenKey、
 * 条件单下单、事件解析。业务判断不在这个文件里。
 *
 * 三条必须守住的口径：
 *
 * 1. **凭据只走环境变量注入**，只经 `X-MBX-APIKEY` 头与 HMAC 签名出现，绝不进 argv、
 *    绝不打日志（`AGENTS.md` 约定 2 的同一原则）。
 * 2. **U 本位永续没有「单请求 OCO」**。`/fapi/v1/order/oco` 已下架，官方口径是 algo
 *    条件单：`STOP_MARKET` / `TAKE_PROFIT_MARKET` 配 `closePosition=true`，
 *    且**仓位平掉后剩余那张由交易所自动撤销**。因此「挂两组单」在本文件里是两次
 *    REST 调用，但撤销关系由交易所保证——本地不轮询、不盯市。
 *    （`closePosition=true` 官方明确：不能带 `quantity`，不能带 `reduceOnly`，
 *    所以这里**不发送**这两个参数。）
 * 3. **失败一律抛错**并带上交易所的 code/msg，不返回空值假装成功（AGENTS.md 约定 9）。
 */

import { createHmac } from 'node:crypto';

import {
  SyncError,
  type Credentials,
  type ExecutionType,
  type OrderSide,
  type OrderStatus,
  type PositionSide,
} from '@trade-tool/core';

/** 用户数据流事件的两种事件名（只关心第一种）。 */
export const ORDER_TRADE_UPDATE = 'ORDER_TRADE_UPDATE';

export type { Credentials, ExecutionType, OrderSide, OrderStatus, PositionSide };

/** 一条成交回报。字段命名与交易所 payload 一致，便于对着文档核对。 */
export interface OrderTradeUpdate {
  eventTime: number;
  transactionTime: number;
  symbol: string;
  clientOrderId: string;
  orderId: number;
  side: OrderSide;
  orderType: string;
  /** 已成交均价。`ap` 为 0 时（刚成交没均价）退回本笔成交价 `p`。 */
  averagePrice: number;
  lastFilledPrice: number;
  lastFilledQty: number;
  /** 该订单的累计成交量 `z`。 */
  cumulativeQty: number;
  /** 原始数量 `q`。 */
  origQty: number;
  executionType: ExecutionType;
  status: OrderStatus;
  /** 成交时间（毫秒）。ATR 的「成交时刻」取的就是它。 */
  tradeTime: number;
  positionSide: PositionSide;
}

export interface PrivateClientOptions {
  credentials: Credentials;
  /** 缺省 `https://fapi.binance.com`，测试指向本地假服务器。 */
  baseUrl?: string;
  /** 客户端数据流地址，缺省 `https://fstream.binance.com`。 */
  streamUrl?: string;
  recvWindowMs?: number;
  /** 注入 fetch：测试用假实现，**测试期间不得访问真实网络**。 */
  fetchImpl?: typeof fetch;
  /** 注入 WebSocket 工厂：测试用假实现。 */
  webSocketFactory?: (url: string) => WebSocket;
}

export interface ClosePositionOrderRequest {
  symbol: string;
  /** 平多 = SELL，平空 = BUY。 */
  side: OrderSide;
  type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
  stopPrice: number;
  clientOrderId: string;
  /** `MARK_PRICE` 用标记价触发（抗插针），`PRICE` 用最新成交价。缺省 MARK_PRICE。 */
  workingType?: 'MARK_PRICE' | 'CONTRACT_PRICE';
  /** 触发保护：标记价与最新价偏离超过标的 `triggerProtect` 时暂停触发。 */
  priceProtect?: boolean;
  recvWindowMs?: number;
}

export interface PlacedOrder {
  orderId: number;
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  type: string;
  stopPrice: number;
  status: string;
}

/** 交易所的错误体：`{ code, msg }`。code < 0 一定是错误。 */
interface BinanceErrorBody {
  code?: number;
  msg?: string;
}

function isErrorBody(value: unknown): value is BinanceErrorBody {
  return typeof value === 'object' && value !== null && 'code' in value;
}

function requirePositive(value: unknown, field: string, where: string): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  throw new SyncError('EXCHANGE_ERROR', `${where} 的 ${field} 不是正数`, {
    field,
    value: String(value),
  });
}

function requireString(value: unknown, field: string, where: string): string {
  if (typeof value === 'string' && value !== '') return value;
  throw new SyncError('EXCHANGE_ERROR', `${where} 的 ${field} 缺失`, {
    field,
    value: String(value),
  });
}

function requireNumber(value: unknown, field: string, where: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  throw new SyncError('EXCHANGE_ERROR', `${where} 的 ${field} 不是数字`, {
    field,
    value: String(value),
  });
}

/**
 * 把 `ORDER_TRADE_UPDATE` 解析成 `OrderTradeUpdate`；不是该事件返回 `null`。
 *
 * 独立成纯函数是为了能脱开网络逐条断言字段口径——解析错一个字段，
 * 症状是「止损挂在错误的仓位上」，而那在日志里完全看不出来。
 */
export function parseOrderTradeUpdate(payload: unknown): OrderTradeUpdate | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const root = payload as Record<string, unknown>;
  if (root['e'] !== ORDER_TRADE_UPDATE) return null;
  const order = root['o'];
  if (typeof order !== 'object' || order === null) {
    throw new SyncError('EXCHANGE_ERROR', 'ORDER_TRADE_UPDATE 缺少 o 字段', {});
  }
  const o = order as Record<string, unknown>;
  const where = `ORDER_TRADE_UPDATE ${String(o['s'])}`;
  const lastFilledPrice = requireNumber(o['p'], 'o.p', where);
  const average = requireNumber(o['ap'], 'o.ap', where);
  return {
    eventTime: requireNumber(root['E'], 'E', where),
    transactionTime: requireNumber(root['T'], 'T', where),
    symbol: requireString(o['s'], 'o.s', where),
    clientOrderId: requireString(o['c'], 'o.c', where),
    orderId: requireNumber(o['i'], 'o.i', where),
    side: requireString(o['S'], 'o.S', where) as OrderSide,
    orderType: requireString(o['o'], 'o.o', where),
    // ap 为 0（刚成交、交易所还没给均价）时退回本笔成交价，而不是当成 0 入场价——
    // 止损位会因此正好等于 0 而直接被拒。
    averagePrice: average > 0 ? average : lastFilledPrice,
    lastFilledPrice,
    lastFilledQty: requireNumber(o['l'], 'o.l', where),
    cumulativeQty: requireNumber(o['z'], 'o.z', where),
    origQty: requireNumber(o['q'], 'o.q', where),
    executionType: requireString(o['x'], 'o.x', where) as ExecutionType,
    status: requireString(o['X'], 'o.X', where) as OrderStatus,
    tradeTime: requireNumber(o['T'], 'o.T', where),
    positionSide: (typeof o['ps'] === 'string' ? o['ps'] : 'BOTH') as PositionSide,
  };
}

/**
 * 从 exchangeInfo 的原始条目里取最小价格变动（`PRICE_FILTER.tickSize`）。
 *
 * 取的是**库里的** `contract_spec.raw`（不是实时再拉一次）：止盈止损要按 tick 对齐，
 * 而对齐的依据必须与同一份快照里的其它规格一致。取不到就抛错——
 * 用「猜一个 0.01」去对齐，止损位会被交易所按自己的规则否掉，而本地看起来毫无异常。
 */
export function parseTickSize(rawExchangeInfoEntry: unknown, symbol: string): number {
  if (typeof rawExchangeInfoEntry !== 'object' || rawExchangeInfoEntry === null) {
    throw new SyncError(
      'CONFIG_INVALID',
      `${symbol} 没有 exchangeInfo 快照，无法确定最小价格变动（tickSize）`,
      { symbol },
    );
  }
  const filters = (rawExchangeInfoEntry as Record<string, unknown>)['filters'];
  if (!Array.isArray(filters)) {
    throw new SyncError('CONFIG_INVALID', `${symbol} 的 exchangeInfo 快照里没有 filters`, {
      symbol,
    });
  }
  for (const filter of filters) {
    if (typeof filter !== 'object' || filter === null) continue;
    const entry = filter as Record<string, unknown>;
    if (entry['filterType'] !== 'PRICE_FILTER') continue;
    const tick = entry['tickSize'];
    if (typeof tick !== 'string' || tick.trim() === '' || !Number.isFinite(Number(tick))) {
      throw new SyncError('CONFIG_INVALID', `${symbol} 的 tickSize 不是合法数字：${String(tick)}`, {
        symbol,
        tickSize: String(tick),
      });
    }
    if (Number(tick) <= 0) {
      throw new SyncError('CONFIG_INVALID', `${symbol} 的 tickSize 必须为正：${tick}`, {
        symbol,
        tickSize: tick,
      });
    }
    return Number(tick);
  }
  throw new SyncError('CONFIG_INVALID', `${symbol} 的 exchangeInfo 快照里没有 PRICE_FILTER`, {
    symbol,
  });
}

/**
 * 私有 REST 客户端。
 *
 * 签名 = HMAC-SHA256(queryString, apiSecret) 的 hex。查询串里的键按字典序拼接，
 * `timestamp` / `recvWindow` 一起参与签名——少一个就是 -1021 签名错误。
 */
export class BinancePrivateClient {
  private readonly credentials: Credentials;
  private readonly baseUrl: string;
  private readonly streamUrl: string;
  private readonly recvWindowMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly webSocketFactory: (url: string) => WebSocket;

  constructor(options: PrivateClientOptions) {
    this.credentials = options.credentials;
    this.baseUrl = (options.baseUrl ?? 'https://fapi.binance.com').replace(/\/+$/, '');
    this.streamUrl = (options.streamUrl ?? 'https://fstream.binance.com').replace(/\/+$/, '');
    this.recvWindowMs = options.recvWindowMs ?? 5_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.webSocketFactory =
      options.webSocketFactory ?? ((url: string) => new WebSocket(url) as unknown as WebSocket);
  }

  /** 用当前时间戳签一条请求。签名细节集中在这里，别处不再拼 query。 */
  private sign(params: Record<string, string | number | boolean | undefined>): string {
    const entries = Object.entries(params)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const query = entries.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
    const signature = createHmac('sha256', this.credentials.apiSecret).update(query).digest('hex');
    return `${query}&signature=${signature}`;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    options: {
      signed?: boolean;
      params?: Record<string, string | number | boolean | undefined>;
    } = {},
  ): Promise<T> {
    const useSignature = options.signed ?? false;
    let url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'X-MBX-APIKEY': this.credentials.apiKey,
    };
    if (useSignature) {
      const signed = this.sign({
        ...(options.params ?? {}),
        recvWindow: options.params?.['recvWindow'] ?? this.recvWindowMs,
        timestamp: Date.now(),
      });
      url += `?${signed}`;
    } else if (options.params && Object.keys(options.params).length > 0) {
      const query = Object.entries(options.params)
        .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
        .join('&');
      url += `?${query}`;
    }
    const response = await this.fetchImpl(url, { method, headers });
    const text = await response.text();
    let body: unknown;
    try {
      body = text === '' ? {} : JSON.parse(text);
    } catch {
      throw new SyncError(
        'EXCHANGE_ERROR',
        `${method} ${path} 返回的不是 JSON：${text.slice(0, 200)}`,
        {
          status: response.status,
        },
      );
    }
    if (!response.ok || isErrorBody(body)) {
      const err = isErrorBody(body) ? body : {};
      throw new SyncError(
        'EXCHANGE_ERROR',
        `Binance ${method} ${path} 失败：${err.msg ?? text.slice(0, 200)}`,
        {
          status: response.status,
          exchangeCode: err.code ?? null,
          path,
        },
      );
    }
    return body as T;
  }

  /**
   * 申请 listenKey。**只带 API key 头、不签名**——这是 Binance 的规定，
   * 给它加签名反而会 401。
   */
  async createListenKey(): Promise<string> {
    const body = await this.request<{ listenKey?: string }>('POST', '/fapi/v1/listenKey');
    const key = body.listenKey;
    if (typeof key !== 'string' || key === '') {
      throw new SyncError('EXCHANGE_ERROR', '申请 listenKey 失败：响应里没有 listenKey', {
        body: JSON.stringify(body),
      });
    }
    return key;
  }

  /** 续期。listenKey 有效期 30 分钟，不续期就会静默停止推送——那正是「假装在同步」的另一种形态。 */
  async keepAliveListenKey(listenKey: string): Promise<void> {
    await this.request('PUT', '/fapi/v1/listenKey', { params: { listenKey } });
  }

  async closeListenKey(listenKey: string): Promise<void> {
    await this.request('DELETE', '/fapi/v1/listenKey', { params: { listenKey } });
  }

  /** listenKey 的流地址。 */
  listenKeyUrl(listenKey: string): string {
    return `${this.streamUrl}/ws/${listenKey}`;
  }

  /**
   * 挂一张 `closePosition` 条件单（止盈或止损）。
   *
   * `closePosition=true` 时官方明确**不能**带 `quantity` 与 `reduceOnly`，
   * 因此这里刻意不发这两个参数——发了就是 -1106。
   */
  async placeClosePositionOrder(request: ClosePositionOrderRequest): Promise<PlacedOrder> {
    const body = await this.request<Record<string, unknown>>('POST', '/fapi/v1/order', {
      signed: true,
      params: {
        symbol: request.symbol,
        side: request.side,
        type: request.type,
        stopPrice: request.stopPrice,
        closePosition: true,
        workingType: request.workingType ?? 'MARK_PRICE',
        priceProtect: request.priceProtect ?? true,
        newClientOrderId: request.clientOrderId,
        recvWindow: request.recvWindowMs ?? this.recvWindowMs,
      },
    });
    const where = `placeClosePositionOrder ${request.symbol}`;
    return {
      orderId: requireNumber(body['orderId'], 'orderId', where),
      clientOrderId: requireString(body['clientOrderId'], 'clientOrderId', where),
      symbol: requireString(body['symbol'], 'symbol', where),
      side: requireString(body['side'], 'side', where) as OrderSide,
      type: requireString(body['type'], 'type', where),
      stopPrice: requirePositive(body['stopPrice'], 'stopPrice', where),
      status: requireString(body['status'], 'status', where),
    };
  }

  async cancelOrder(symbol: string, orderId: number): Promise<void> {
    await this.request('DELETE', '/fapi/v1/order', {
      signed: true,
      params: { symbol, orderId },
    });
  }
}

export interface UserDataStreamOptions {
  listenKey: string;
  url: string;
  /** 每条事件回调。返回的 Promise 会被 await：处理失败不该把连接拖垮。 */
  onEvent: (payload: Record<string, unknown>) => void | Promise<void>;
  onError?: (error: Error) => void;
  /** 连接断开（含服务端关闭）。**重连逻辑挂在��里**——不接就等于静默停推。 */
  onClose?: (reason: string) => void;
  /** keepalive 回调。listenKey 30 分钟过期，不续期就静默停推。 */
  onKeepAlive?: (listenKey: string) => Promise<void> | void;
  keepAliveIntervalMs?: number;
  webSocketFactory: (url: string) => WebSocket;
  setIntervalImpl?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalImpl?: (handle: NodeJS.Timeout) => void;
}

export interface UserDataStreamHandle {
  close(): void;
}

/**
 * 打开用户数据流。
 *
 * 重连是**必需**而不是锦上添花：长连断开后若不重连，页面/日志一切正常，
 * 但服务实际上已经不再收到任何成交——一个「看起来在跑、其实不设止损」的进程，
 * 比直接崩掉危险得多。
 */
export function openUserDataStream(options: UserDataStreamOptions): UserDataStreamHandle {
  const setIntervalImpl =
    options.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms) as unknown as NodeJS.Timeout);
  const clearIntervalImpl =
    options.clearIntervalImpl ?? ((handle) => clearInterval(handle as unknown as number));

  let socket: WebSocket | undefined;
  let keepAlive: NodeJS.Timeout | undefined;
  let closed = false;

  const report = (error: unknown): void => {
    const err = error instanceof Error ? error : new Error(String(error));
    options.onError?.(err);
  };

  const connect = (): void => {
    if (closed) return;
    socket = options.webSocketFactory(options.url);
    socket.onopen = () => {
      keepAlive = setIntervalImpl(
        () => {
          void (async () => {
            try {
              await options.onKeepAlive?.(options.listenKey);
            } catch (error) {
              report(error);
            }
          })();
        },
        options.keepAliveIntervalMs ?? 20 * 60_000,
      );
    };
    socket.onmessage = (event: MessageEvent) => {
      void (async () => {
        try {
          const raw = typeof event.data === 'string' ? event.data : String(event.data);
          const payload = JSON.parse(raw) as Record<string, unknown>;
          await options.onEvent(payload);
        } catch (error) {
          report(error);
        }
      })();
    };
    socket.onerror = (event: unknown) => {
      report(new Error(`用户数据流出错：${JSON.stringify(event)}`));
    };
    socket.onclose = () => {
      if (keepAlive !== undefined) clearIntervalImpl(keepAlive);
      // 主动 close() 不回调 onClose：那是调用方自己在收尾，不该再触发一次重连。
      if (!closed) options.onClose?.('closed');
      else options.onClose?.('local');
    };
  };

  connect();

  return {
    close(): void {
      closed = true;
      if (keepAlive !== undefined) clearIntervalImpl(keepAlive);
      socket?.close();
    },
  };
}
