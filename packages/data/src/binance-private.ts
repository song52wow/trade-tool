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
  computeClockSkew,
  type ClockSample,
  type ClockSkew,
  type Credentials,
  type ExecutionType,
  type ExchangeAlgoOrder,
  type ExchangePosition,
  type OrderSide,
  type OrderStatus,
  type PositionSide,
} from '@trade-tool/core';

/**
 * 用户数据流的事件名。
 *
 * **两个都要处理**：订单事件不带仓位，仓位在账户事件里（详见 `packages/core/src/net-position.ts`）。
 */
export const ORDER_TRADE_UPDATE = 'ORDER_TRADE_UPDATE';
export const ACCOUNT_UPDATE = 'ACCOUNT_UPDATE';

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
  /**
   * 本笔成交的手续费（`n`）。
   *
   * **单位与计价币一致**（USDⓈ-M 永续即 USDT），因此可以直接从毛利里扣。
   * 少了它，「实际盈亏」就只是毛盈亏——那笔账会永远偏乐观。
   */
  commission: number;
  /** 手续费币种（`N`）。不是计价币时**不能**直接扣（汇率未知），必须报出来。 */
  commissionAsset: string;
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
  /** 条件单的自定义号。交易所侧叫 `clientAlgoId`（正则同 `newClientOrderId`）。 */
  clientAlgoId: string;
  /** `MARK_PRICE` 用标记价触发（抗插针），`PRICE` 用最新成交价。缺省 MARK_PRICE。 */
  workingType?: 'MARK_PRICE' | 'CONTRACT_PRICE';
  /** 触发保护：标记价与最新价偏离超过标的 `triggerProtect` 时暂停触发。 */
  priceProtect?: boolean;
  recvWindowMs?: number;
}

/**
 * **带数量**的条件单（v0.7.0 的第一段止盈）。
 *
 * 与 {@link ClosePositionOrderRequest} 的区别就是这一个字段：官方参数表明确
 * `quantity` 与 `closePosition=true` **互斥**（同时发是 `-1106`），因此
 * 「只平一部分」只能走这个形态。
 *
 * 代价必须写在这里而不是藏在别处：`closePosition` 的两个好处里，**仓位归零时自动撤销**
 * 这一条没有了——带数量的单只认数量，仓位已经是 0 时它不会自己消失。
 * 止损单仍然是 `closePosition` 形态，所以减仓不需要重挂它（AGENTS.md §6.8 第 1 条）。
 */
export interface QuantityOrderRequest {
  symbol: string;
  /** 平多 = SELL，平空 = BUY。 */
  side: OrderSide;
  type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
  stopPrice: number;
  /** 数量，必须已按 `LOT_SIZE.stepSize` 对齐。 */
  quantity: number;
  /**
   * 只减不开。单向持仓下官方允许（双向模式明确禁止，而本仓库拒绝双向模式）。
   *
   * 它只是保险：把这条去掉，第一段止盈的语义靠 `quantity` 本身依然成立。
   */
  reduceOnly?: boolean;
  clientAlgoId: string;
  workingType?: 'MARK_PRICE' | 'CONTRACT_PRICE';
  priceProtect?: boolean;
  recvWindowMs?: number;
}

/** 条件单挂成之后的回执。**是 algoId，不是普通 orderId**——两套编号互不通用。 */
export interface PlacedAlgoOrder {
  algoId: number;
  clientAlgoId: string;
  symbol: string;
  side: OrderSide;
  type: string;
  /** 条件单侧叫 triggerPrice。 */
  triggerPrice: number;
  status: string;
}

/**
 * 交易所的错误体：`{ code, msg }`。
 *
 * 判定**只看 code 的值**，不看「有没有 code 这个键」。
 *
 * 为什么不能只看键的存在（2026-10-17 实测踩到）：`DELETE /fapi/v1/algoOrder` **成功**时
 * 回的就是 `{"code": 200, "msg": "success"}`——带 `code` 键。于是「有 code 就是错误」的写法
 * 会把**每一次成功的撤单都报成失败**。后果不是「多一行难看的日志」：
 *   * v0.4.0 的回滚（「撤掉先挂上的那张」）会永远走进失败分支；
 *   * v0.7.0 的移动止损规定「撤旧失败就不推进档位」，于是**档位永远不推进**，
 *     而交易所上早已换成新止损单——账面与实际永久对不上。
 *
 * 真正的错误码一律是**负数**（-1106 / -1121 / -1021 …），成功码是非负（200 / 0）。
 */
interface BinanceErrorBody {
  code?: number | string;
  msg?: string;
}

function isErrorBody(value: unknown): value is BinanceErrorBody {
  if (typeof value !== 'object' || value === null || !('code' in value)) return false;
  const code = (value as { code?: unknown }).code;
  // 没有 code 值、或 code 是拿不到数字的字符串：无法判定为错误，交给上层按缺字段处理
  // （那会让错误信息指向「响应缺字段」而不是「撤单失败」，是更准确的指向）。
  if (typeof code !== 'number' && typeof code !== 'string') return false;
  const numeric = typeof code === 'number' ? code : Number(code);
  if (!Number.isFinite(numeric)) return false;
  return numeric < 0;
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
    // 手续费是**必返**字段（官方 ORDER_TRADE_UPDATE 的 `n` / `N`）。
    // 缺了就报错，不要当成 0——「假装没收手续费」的盈亏正是最不能出错的那个数。
    commission: requireNumber(o['n'], 'o.n', where),
    commissionAsset: requireString(o['N'], 'o.N', where),
  };
}

/** `ACCOUNT_UPDATE` 里的一个仓位条目。 */
export interface AccountPositionUpdate {
  symbol: string;
  positionSide: PositionSide;
  /** 净仓位。正 = 多，负 = 空，0 = 空仓。 */
  positionAmt: number;
  /** 入场价。 */
  entryPrice: number;
  /**
   * 撮合时间（事件根节点的 `T`）。
   *
   * **必须带出来**：它划定了「哪些成交的效果已经包含在这条校正里」。
   * 撮合时间 `<= T` 的成交若再被累加一次，就是把同一笔事实算两遍——
   * 实测会让平仓凭空变成反向开仓。
   */
  transactionTime: number;
}

/**
 * 把 `ACCOUNT_UPDATE` 解析成**它这次推了几个标的的仓位**；不是该事件返回 `null`。
 *
 * **只包含「本次变动了的标的」**——官方明确「仅当 symbol 仓位有变动时推送」，
 * 而且资金费的简略事件可能完全不带 `P`。因此返回的是增量视图，**不是账户全量快照**：
 * 调用方必须按条目逐个覆盖本地净额，绝不能拿它当全量重置。
 *
 * 解析失败抛错而不是跳过：`pa` 改名成非数字时静默忽略，症状是
 * 「本地净仓位悄悄失准，几笔成交之后才开始挂错方向的止损」。
 */
export function parseAccountUpdate(payload: unknown): AccountPositionUpdate[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const root = payload as Record<string, unknown>;
  if (root['e'] !== ACCOUNT_UPDATE) return null;
  const account = root['a'];
  if (typeof account !== 'object' || account === null) return [];
  const list = (account as Record<string, unknown>)['P'];
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) {
    throw new SyncError('EXCHANGE_ERROR', 'ACCOUNT_UPDATE 的 a.P 不是数组', {});
  }

  const positions: AccountPositionUpdate[] = [];
  for (const [index, item] of list.entries()) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as Record<string, unknown>;
    const symbol = requireString(entry['s'], 'a.P[].s', `ACCOUNT_UPDATE[${index}]`);
    const rawAmt = entry['pa'];
    const positionAmt = typeof rawAmt === 'string' ? Number(rawAmt) : rawAmt;
    if (typeof positionAmt !== 'number' || !Number.isFinite(positionAmt)) {
      throw new SyncError('EXCHANGE_ERROR', `ACCOUNT_UPDATE ${symbol} 的 a.P[].pa 不是有限数字`, {
        pa: rawAmt,
      });
    }
    const rawEntryPrice = entry['ep'];
    const entryPrice = typeof rawEntryPrice === 'string' ? Number(rawEntryPrice) : rawEntryPrice;
    positions.push({
      symbol,
      positionSide: (typeof entry['ps'] === 'string' ? entry['ps'] : 'BOTH') as PositionSide,
      positionAmt,
      entryPrice: typeof entryPrice === 'number' && Number.isFinite(entryPrice) ? entryPrice : 0,
      transactionTime: requireNumber(root['T'], 'T', `ACCOUNT_UPDATE ${symbol}`),
    });
  }
  return positions;
}

/**
 * 从 exchangeInfo 的原始条目里取最小价格变动（`PRICE_FILTER.tickSize`）。
 *
 * 取的是**库里的** `contract_spec.raw`（不是实时再拉一次）：止盈止损要按 tick 对齐，
 * 而对齐的依据必须与同一份快照里的其它规格一致。取不到就抛错——
 * 用「猜一个 0.01」去对齐，止损位会被交易所按自己的规则否掉，而本地看起来毫无异常。
 */
export function parseTickSize(rawExchangeInfoEntry: unknown, symbol: string): number {
  for (const filter of requireFilters(rawExchangeInfoEntry, symbol)) {
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
 * 从 exchangeInfo 的原始条目里取最小下单数量（`LOT_SIZE.stepSize`）。
 *
 * v0.7.0 的分批止盈要按数量挂单，而数量必须对齐 `stepSize`——不对齐的单会被交易所
 * 按自己的规则否掉，本地看起来毫无异常（同 `parseTickSize` 的道理）。
 *
 * 与 `parseTickSize` 共用同一份遍历：`filters` 的形状只有一个理解，
 * 两处各写一遍 JSON 查找，交易所改字段名时只会漏掉其中一处。
 */
export function parseStepSize(rawExchangeInfoEntry: unknown, symbol: string): number {
  for (const filter of requireFilters(rawExchangeInfoEntry, symbol)) {
    if (typeof filter !== 'object' || filter === null) continue;
    const entry = filter as Record<string, unknown>;
    if (entry['filterType'] !== 'LOT_SIZE') continue;
    const step = entry['stepSize'];
    if (typeof step !== 'string' || step.trim() === '' || !Number.isFinite(Number(step))) {
      throw new SyncError('CONFIG_INVALID', `${symbol} 的 stepSize 不是合法数字：${String(step)}`, {
        symbol,
        stepSize: String(step),
      });
    }
    if (Number(step) <= 0) {
      throw new SyncError('CONFIG_INVALID', `${symbol} 的 stepSize 必须为正：${step}`, {
        symbol,
        stepSize: step,
      });
    }
    return Number(step);
  }
  throw new SyncError('CONFIG_INVALID', `${symbol} 的 exchangeInfo 快照里没有 LOT_SIZE`, {
    symbol,
  });
}

/** `parseTickSize` / `parseStepSize` 共用：取到 `filters` 数组，或明确报错。 */
function requireFilters(rawExchangeInfoEntry: unknown, symbol: string): unknown[] {
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
  return filters;
}

/**
 * 私有 REST 客户端。
 *
 * 签名 = HMAC-SHA256(queryString, apiSecret) 的 hex。查询串里的键按字典序拼接，
 * `timestamp` / `recvWindow` 一起参与签名——少一个就是 -1021 签名错误。
 */
/** 数量字段的可选解析。空串 / 0 / 非有限数字一律记 `null`，不记 0 冒充。 */
function parseOptionalQty(raw: unknown, where: string): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

export class BinancePrivateClient {
  private readonly credentials: Credentials;
  private readonly baseUrl: string;
  private readonly streamUrl: string;
  private readonly recvWindowMs: number;
  /**
   * 时钟补偿量（毫秒）。由 `measureClockSkew()` 写入，签名时从 `Date.now()` 里减掉。
   *
   * 默认 0 = 不补偿。这**不是**「认为时钟是准的」，而是「还没测过」——
   * 因此每个进程入口都必须先 `measureClockSkew()`，否则私有请求会直接 -1021。
   */
  private clockOffsetMs = 0;
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

  /**
   * 测量本机时钟与交易所的偏差。
   *
   * 调 `/fapi/v1/time`（**无签名**，所以不依赖时钟是否准——它是无签名的，
   * 恰好是唯一在时钟偏时仍然可用的接口）。
   *
   * 调用方**必须**把结果打到日志里：补偿是「拿测量值纠正已知误差」，
   * 不看见它就等于凭空改写了时间戳（AGENTS.md 约定 9）。
   */
  async measureClockSkew(sampleCount = 3): Promise<ClockSkew> {
    const samples: ClockSample[] = [];
    for (let i = 0; i < sampleCount; i++) {
      const sentAt = Date.now();
      const body = await this.request<{ serverTime?: unknown }>('GET', '/fapi/v1/time');
      if (typeof body?.serverTime !== 'number') {
        throw new SyncError('EXCHANGE_ERROR', '/fapi/v1/time 没有返回数字 serverTime', {
          body: JSON.stringify(body).slice(0, 200),
        });
      }
      samples.push({ sentAt, serverTime: body.serverTime });
    }
    const skew = computeClockSkew(samples);
    this.clockOffsetMs = skew.offsetMs;
    return skew;
  }

  /** 当前生效的时钟补偿量（毫秒），未测量时为 0。 */
  get clockOffset(): number {
    return this.clockOffsetMs;
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
        // 扣掉测量到的时钟偏差。**不要**改成 `Date.now() + …`：
        // 那是把一个已知的偏移换个方向再叠一次。
        timestamp: Date.now() - this.clockOffsetMs,
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

  /**
   * listenKey 的流地址。
   *
   * **必须走 `/private` 路由**：Binance 于 2026-03-06 公告拆分 USDⓈ-M 合约的 WS
   * 架构（public / market / private 三条独立入口），并于 **2026-04-23 永久下线旧地址**。
   * 官方明确：用户数据走 `wss://fstream.binance.com/private/ws?listenKey=<key>`，
   * **省略 `/private` 不会投递账户事件**。
   *
   * 这一点踩过坑：旧地址**握手仍然成功**（`onopen` 正常触发、连接不报错、不重连），
   * 但一个事件也收不到——于是买入成交永远不触发挂单，`risk_bracket` 一行不落，
   * 日志干净得像一切正常，而服务实际上完全失明。这比直接崩掉危险得多。
   */
  listenKeyUrl(listenKey: string): string {
    return `${this.streamUrl}/private/ws?listenKey=${encodeURIComponent(listenKey)}`;
  }

  /**
   * 挂一张 `closePosition` 条件单（止盈或止损）。
   *
   * **必须走 Algo Order API**：`STOP_MARKET` / `TAKE_PROFIT_MARKET` 已从
   * `POST /fapi/v1/order` 迁走，打老接口会被拒
   * （`Order type not supported for this endpoint. Please use the Algo Order API endpoints instead.`）。
   *
   * `algoType=CONDITIONAL` 是必填；`closePosition=true` 仍然只支持这两种类型，
   * 且官方明确**不能**带 `quantity` 与 `reduceOnly`——发了就是 -1106。
   *
   * 返回的是 **algoId**，不是普通 orderId：条件单走的是另一套编号与撤销接口，
   * 混用会在撤单时拿到「订单不存在」。
   */
  async placeClosePositionOrder(request: ClosePositionOrderRequest): Promise<PlacedAlgoOrder> {
    return this.placeAlgoOrder(
      {
        algoType: 'CONDITIONAL',
        symbol: request.symbol,
        side: request.side,
        type: request.type,
        // 条件单侧叫 triggerPrice，不是 stopPrice。
        triggerPrice: request.stopPrice,
        closePosition: 'true',
        workingType: request.workingType ?? 'MARK_PRICE',
        priceProtect: String(request.priceProtect ?? true),
        clientAlgoId: request.clientAlgoId,
        recvWindow: request.recvWindowMs ?? this.recvWindowMs,
      },
      `placeClosePositionOrder ${request.symbol}`,
    );
  }

  /**
   * 挂一张**带数量**的条件单（分批止盈用）。
   *
   * 刻意不发 `closePosition`：官方明确 `quantity` 与它互斥。也不要在这里偷偷补
   * `closePosition`「万一填了」，那会让两种形态在请求里混起来，
   * 而它们在交易所侧是**不同的撤销语义**（见 {@link QuantityOrderRequest}）。
   *
   * 口径核对：**2026-10-17** 官方参数表 `New UM Algo Order (TRADE)`，
   * `quantity` / `reduceOnly` 均为合法参数，`quantity` 只禁与 `closePosition=true` 并存。
   */
  async placeQuantityOrder(request: QuantityOrderRequest): Promise<PlacedAlgoOrder> {
    if (!Number.isFinite(request.quantity) || request.quantity <= 0) {
      throw new SyncError(
        'CONFIG_INVALID',
        `带数量的条件单数量必须为正：${String(request.quantity)}`,
        { symbol: request.symbol, quantity: request.quantity },
      );
    }
    return this.placeAlgoOrder(
      {
        algoType: 'CONDITIONAL',
        symbol: request.symbol,
        side: request.side,
        type: request.type,
        triggerPrice: request.stopPrice,
        quantity: String(request.quantity),
        reduceOnly: String(request.reduceOnly ?? true),
        workingType: request.workingType ?? 'MARK_PRICE',
        priceProtect: String(request.priceProtect ?? true),
        clientAlgoId: request.clientAlgoId,
        recvWindow: request.recvWindowMs ?? this.recvWindowMs,
      },
      `placeQuantityOrder ${request.symbol}`,
    );
  }

  /**
   * 两个下单形态的**唯一**实现：拼参数、发请求、解析回执。
   *
   * 回执解析只有一份，是因为 `orderType` 的取值差异（查询侧 `TAKE_PROFIT` / `STOP`，
   * 下单侧 `TAKE_PROFIT_MARKET` / `STOP_MARKET`）必须原样透传给 `algoOrderTag()`——
   * 两处各解析一次，早晚会有一处「顺手统一」掉那个差异，而差异正是判据的依据
   * （AGENTS.md §6.3）。
   */
  private async placeAlgoOrder(
    params: Record<string, string | number>,
    where: string,
  ): Promise<PlacedAlgoOrder> {
    const body = await this.request<Record<string, unknown>>('POST', '/fapi/v1/algoOrder', {
      signed: true,
      params,
    });
    return {
      algoId: requireNumber(body['algoId'], 'algoId', where),
      clientAlgoId: requireString(body['clientAlgoId'], 'clientAlgoId', where),
      symbol: requireString(body['symbol'], 'symbol', where),
      side: requireString(body['side'], 'side', where) as OrderSide,
      type: requireString(body['orderType'], 'orderType', where),
      triggerPrice: requirePositive(body['triggerPrice'], 'triggerPrice', where),
      status: requireString(body['algoStatus'], 'algoStatus', where),
    };
  }

  /**
   * 撤条件单。
   *
   * 与普通订单不同：条件单**不需要 symbol**，只认 `algoId`（或 `clientAlgoId`）。
   * 拿普通 orderId 来撤会得到「订单不存在」——因为那是两套独立的编号空间。
   */
  async cancelAlgoOrder(algoId: number): Promise<void> {
    await this.request('DELETE', '/fapi/v1/algoOrder', {
      signed: true,
      params: { algoId },
    });
  }

  // ------------------------------------------------- 只读查询（v0.6.0 交易对账）
  //
  // 下面两个端点**只读不写**，因此可以安全地挂在页面上由人手动触发。但它们是
  // **私有接口**：要签名、消耗请求权重，且走的是出网路径——这正是对账不能挂在 5s 刷新
  // 节奏上的原因（`/bars` 可以，因为它只打 PG）。
  //
  // 口径核对日期 **2026-10-11**，官方文档 + 变更日志交叉确认：
  //
  // * `GET /fapi/v3/positionRisk`（权重 5）。**是 v3 不是 v2**：v2 已被官方列入待下线
  //   清单（2024-07-17 变更日志），v3 是替代端点。v3 **只返回有持仓或挂单的交易对**，
  //   因此「某标的没出现在结果里」= 无仓位也无挂单，这恰好是对账要用的语义。
  // * `GET /fapi/v1/openAlgoOrders`（带 symbol 权重 1，不带 **40**）。条件单查询走的是
  //   Algo Order API 这一套，与下单 / 撤单同一个家族（`/fapi/v1/algoOrder`）。

  /**
   * 当前持仓。
   *
   * **数量类字段在 payload 里是字符串**（`"positionAmt": "30"`）——按字符串塞进查询里
   * 或者用 `parseFloat` 随手处理都会在空仓上翻车，因此统一走 `requireNumber`，
   * 形状不对就抛错（AGENTS.md 约定 9）。
   */
  async positionRisk(options: { symbol?: string } = {}): Promise<ExchangePosition[]> {
    const body = await this.request<unknown[]>('GET', '/fapi/v3/positionRisk', {
      signed: true,
      // exactOptionalPropertyTypes：不能显式传 undefined，用空对象表达「不带这个参数」。
      params: options.symbol === undefined ? {} : { symbol: options.symbol },
    });
    if (!Array.isArray(body)) {
      throw new SyncError('EXCHANGE_ERROR', 'positionRisk 返回的不是数组', {
        body: JSON.stringify(body).slice(0, 200),
      });
    }
    return body.map((raw, index) => {
      if (typeof raw !== 'object' || raw === null) {
        throw new SyncError('EXCHANGE_ERROR', `positionRisk 第 ${index} 条不是对象`);
      }
      const row = raw as Record<string, unknown>;
      const symbol = requireString(row['symbol'], 'symbol', `positionRisk[${index}]`);
      const where = `positionRisk ${symbol}`;
      return {
        symbol,
        positionSide: (typeof row['positionSide'] === 'string'
          ? row['positionSide']
          : 'BOTH') as PositionSide,
        positionAmt: requireNumber(row['positionAmt'], 'positionAmt', where),
        entryPrice: requireNumber(row['entryPrice'], 'entryPrice', where),
        // 空仓时交易所给 "0.00000"，合法数字；解析不了说明字段改名了，必须报出来。
        markPrice: requireNumber(row['markPrice'], 'markPrice', where),
        updateTime: requireNumber(row['updateTime'], 'updateTime', where),
      };
    });
  }

  /**
   * 当前挂着的条件单（止盈 / 止损 / 追踪止损）。
   *
   * ⚠️ 不带 `symbol` 的权重是 **40**（带 symbol 只要 1）。因此全账户对账要显式提醒
   * 这一点，别让人在页面上无脑点。
   *
   * `orderType` 的取值**不唯一**：官方文档示例回 `TAKE_PROFIT` / `STOP`，而下单侧发的是
   * `TAKE_PROFIT_MARKET` / `STOP_MARKET`——**2026-10-11 实测真实账户回的也是
   * `*_MARKET`**，即文档示例本身就不能当契约。两种都原样透传，由 core 的
   * `algoOrderTag()` 按前缀统一归类——不要在这里「顺手统一」，那会让差异从代码里消失，
   * 而一旦交易所再改一次命名，本地连「这张单是止损还是止盈」都答不出来。
   */
  async openAlgoOrders(options: { symbol?: string } = {}): Promise<ExchangeAlgoOrder[]> {
    const body = await this.request<unknown[]>('GET', '/fapi/v1/openAlgoOrders', {
      signed: true,
      // exactOptionalPropertyTypes：不能显式传 undefined，用空对象表达「不带这个参数」。
      params: options.symbol === undefined ? {} : { symbol: options.symbol },
    });
    if (!Array.isArray(body)) {
      throw new SyncError('EXCHANGE_ERROR', 'openAlgoOrders 返回的不是数组', {
        body: JSON.stringify(body).slice(0, 200),
      });
    }
    return body.map((raw, index) => {
      if (typeof raw !== 'object' || raw === null) {
        throw new SyncError('EXCHANGE_ERROR', `openAlgoOrders 第 ${index} 条不是对象`);
      }
      const row = raw as Record<string, unknown>;
      const where = `openAlgoOrders[${index}]`;
      return {
        algoId: requireNumber(row['algoId'], 'algoId', where),
        clientAlgoId: requireString(row['clientAlgoId'], 'clientAlgoId', where),
        algoType: requireString(row['algoType'], 'algoType', where),
        orderType: requireString(row['orderType'], 'orderType', where),
        symbol: requireString(row['symbol'], 'symbol', where),
        side: requireString(row['side'], 'side', where) as OrderSide,
        positionSide: (typeof row['positionSide'] === 'string'
          ? row['positionSide']
          : 'BOTH') as PositionSide,
        algoStatus: requireString(row['algoStatus'], 'algoStatus', where),
        triggerPrice: requirePositive(row['triggerPrice'], 'triggerPrice', where),
        closePosition: row['closePosition'] === true,
        // 带数量的单才有；closePosition 单回的是 0/缺省，按「没有数量」记 null 而不是 0。
        quantity: parseOptionalQty(row['quantity'], where),
        createTime: requireNumber(row['createTime'], 'createTime', where),
        updateTime: requireNumber(row['updateTime'], 'updateTime', where),
      };
    });
  }
}

export interface UserDataStreamOptions {
  listenKey: string;
  url: string;
  /** 每条事件回调。返回的 Promise 会被 await：处理失败不该把连接拖垮。 */
  onEvent: (payload: Record<string, unknown>) => void | Promise<void>;
  onError?: (error: Error) => void;
  /** 连接断开（含服务端关闭）。**重连逻辑挂在这里**——不接就等于静默停推。 */
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
