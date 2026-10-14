import {
  resolveExchangeEndpoints,
  type ExchangeEndpoints,
  type ExecutorConfig,
} from '@trade-tool/core';

/**
 * Demo 用户数据流地址的环境变量名。
 *
 * 刻意**只**在 `environment = 'demo'` 时读：`live` 下设置它是无效配置，
 * 而留着不管等于允许「以为自己在跑沙箱、其实连着主网流」这种状态被无声忽略。
 */
export const DEMO_STREAM_URL_ENV = 'TRADE_TOOL_BINANCE_DEMO_STREAM_URL';

/**
 * 读环境变量得到私有交易侧（REST + 用户数据流）的端点。
 *
 * 这是**唯一**给 `BinancePrivateClient` 传端点的地方：四处调用点（executor、
 * 对账 CLI、控制面手动对账、测试）以前都不传，于是永远打主网——配置层改不动。
 *
 * 解析逻辑本身在 core（`resolveExchangeEndpoints`），这里只负责把环境变量接上去，
 * 保证「哪些值来自配置、哪些来自环境」这条边界只有一处。
 */
export function exchangeEndpointsFromEnv(config: ExecutorConfig): ExchangeEndpoints {
  return resolveExchangeEndpoints({
    environment: config.environment,
    demoStreamUrl: process.env[DEMO_STREAM_URL_ENV],
  });
}

/**
 * Python 侧（行情 / exchangeInfo）要用的 REST 基址。
 *
 * 行情链路走 `python -m quant_data`，基址从**子进程环境**读（`quant_data/http.py`
 * 的 `TRADE_TOOL_BINANCE_BASE_URL`）。因此 demo 模式必须显式把它注入子进程，
 * 否则会出现同一个进程里「下单在 demo、行情仍在主网」的又一处分叉。
 *
 * `live` 时返回空对象：让子进程沿用自己那份缺省，主网路径不受任何影响。
 */
export function pythonEnvFromEnv(config: ExecutorConfig): Record<string, string> {
  if (config.environment !== 'demo') return {};
  return { TRADE_TOOL_BINANCE_BASE_URL: exchangeEndpointsFromEnv(config).baseUrl };
}
