import { SyncError } from './market-sync.js';

/**
 * 交易所端点的解析：**REST 基址与用户数据流地址必须来自同一次选择**。
 *
 * 为什么不做成两个独立变量：历史上 `listenKeyUrl` 就是这么坏的——地址本身写错了，
 * 而「握手成功、一个事件都收不到」的失败模式没有任何日志能暴露。若允许
 * 「REST 指 demo、流还留主网」，就会**原样**复现同一个分叉：下单打到沙箱，
 * 成交事件从主网流过来，于是永远等不到挂单，而界面一切正常。
 * 把它们绑成一个原子选择，配置层就不可能只改一半（AGENTS.md §6.3 第 5 条的同源思路）。
 */

/** 主网 REST 基址。核对于 2026-10-14，未变动。 */
export const LIVE_REST_BASE_URL = 'https://fapi.binance.com';

/** 主网用户数据流基址（`/private/ws` 路由见 `BinancePrivateClient.listenKeyUrl`）。 */
export const LIVE_STREAM_URL = 'https://fstream.binance.com';

/**
 * Demo Trading（`https://demo.binance.com/en/futures`）的 REST 基址。
 *
 * 核对于 2026-10-14。Binance 于 2025-08-27 关停老的 Futures Testnet
 * （`testnet.binancefuture.com`）并统一到 Demo Trading；官方 General Info 是权威来源，
 * 而**大量单endpoint 文档页至今仍印着已废弃的旧地址**——照抄单个页面就会配出一个死基址。
 */
export const DEMO_REST_BASE_URL = 'https://demo-fapi.binance.com';

export const EXCHANGE_ENVIRONMENTS = ['live', 'demo'] as const;

export type ExchangeEnvironment = (typeof EXCHANGE_ENVIRONMENTS)[number];

export interface ExchangeEndpoints {
  /** REST 基址，不带结尾斜杠。 */
  baseUrl: string;
  /** 用户数据流基址，**用 `https://`** 写（WebSocket 构造器会把 http(s) 升级成 ws(s)）。 */
  streamUrl: string;
}

export interface ResolveExchangeEndpointsOptions {
  environment: ExchangeEnvironment;
  /**
   * Demo 环境的用户数据流地址。`environment = 'demo'` 时**必填**，缺它直接抛错。
   *
   * 仍然不给代码默认值——**理由已经变了**：2026-10-15 核对官方 USDⓈ-M Futures
   * General Info 的 "Testnet API Information"，host 已确认是
   * `wss://demo-fstream.binance.com`（此前记录的「两个说法互相矛盾」已作废）。
   * 不给默认值是为了让**切换环境这件事必须显式发生**：`environment = demo` 与地址
   * 同时出现在配置里，比一个隐式默认值更容易在事后回答「这笔单去了哪个环境」。
   * 宁可在启动时报错，也不让一个没被确认过的 host 悄悄接上一条
   * 「握手成功但不投递事件」的流（AGENTS.md §10 第 1 条）。
   */
  demoStreamUrl?: string | undefined;
}

function normalize(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * 按环境解析出 REST 基址与用户数据流地址。
 *
 * `live` 两个地址都是已知常量；`demo` 的 REST 是已知常量，而 WS 必须由调用方显式给出。
 * 两条路径都不做「拿不到就回落主网」的兜底——那正是把沙箱配置悄悄指回真实资金的方向。
 */
export function resolveExchangeEndpoints(
  options: ResolveExchangeEndpointsOptions,
): ExchangeEndpoints {
  if (options.environment === 'live') {
    return { baseUrl: LIVE_REST_BASE_URL, streamUrl: LIVE_STREAM_URL };
  }

  const given = (options.demoStreamUrl ?? '').trim();
  if (given === '') {
    throw new SyncError(
      'CONFIG_INVALID',
      'exchange.environment = demo 但没有给 Demo 用户数据流地址。请设置环境变量 ' +
        'TRADE_TOOL_BINANCE_DEMO_STREAM_URL（基址，不含 /private/ws?listenKey=），' +
        '或把 exchange.environment 改回 live。' +
        '本仓库不内置 demo 的默认值：各来源对该 host 的说法不一致，写死会连上一条' +
        '「握手成功但不投递账户事件」的流。地址请查 https://demo.binance.com/en/futures 的官方文档。',
      { environment: options.environment, variable: 'TRADE_TOOL_BINANCE_DEMO_STREAM_URL' },
    );
  }

  if (!/^https:\/\//.test(given) && !/^wss:\/\//.test(given)) {
    throw new SyncError(
      'CONFIG_INVALID',
      `TRADE_TOOL_BINANCE_DEMO_STREAM_URL 必须是绝对地址（https:// 或 wss:// 开头的基址），收到：${given}`,
      { value: given },
    );
  }

  // wss:// 归一成 https://：WebSocket 构造器接受 http(s) 并等价升级，两种写法结果相同，
  // 但统一存一种可以让 listenKeyUrl 拼出来的地址在任何调用点都长得一样。
  return {
    baseUrl: DEMO_REST_BASE_URL,
    streamUrl: normalize(given.replace(/^wss:\/\//, 'https://')),
  };
}
