/**
 * 账户权益的读取（v1.0.0）。
 *
 * ## 为什么单独一个模块
 *
 * 仓位大小是「愿意亏多少钱 ÷ 每股亏多少」算出来的，而分母是**账户权益**。
 * 因此「权益从哪来」这件事在两个地方都要用：常驻的 `apps/agent` 与一次性的
 * `trade-tool agent run`。两处各写一遍的话，「CLI 看到的权益」与「守护进程算仓位的权益」
 * 可能不是同一个数——而那会让「页面上显示的方案」与「实际下的单」对不上。
 *
 * ## 两条路，显式选一条
 *
 * | `equitySource` | 权益从哪来                | 需要什么            |
 * | ------------- | ------------------------- | ------------------- |
 * | `exchange`    | 交易所的实时账户余额       | 交易所凭据          |
 * | `config`      | 配置里写的 `agent.equity`  | 什么都不需要        |
 *
 * **不做「优先级解析」**（不像通知设置那样 DB 优先、文件兜底）：两者的差别不是
 * 「哪个更新」，而是「哪个是对的」。用户显式选的那一条就是唯一生效的那一条。
 *
 * ## 读不到就抛错
 *
 * **不返回 0**：0 会被当成「账户没钱」，于是仓位算成 0，出一份「数量 0、
 * 看起来完全正常」��方案——那是最难发现的一种错。
 */

import {
  describeClockSkew,
  parseSecretKey,
  SECRET_KEY_ENV,
  SyncError,
  type AgentConfig,
  type ExecutorConfig,
  type Logger,
} from '@trade-tool/core';
import {
  BinancePrivateClient,
  exchangeEndpointsFromEnv,
  resolveActiveCredentials,
  type Pool,
} from '@trade-tool/data';

import type { EquityReading } from './service.js';

/** 建权益读取器需要的参数。 */
export interface EquityReaderOptions {
  pool: Pool;
  config: AgentConfig;
  exchange: string;
  /** 交易所端点相关的配置（环境、凭据变量名、recvWindow）。用 executor 段——同一个账户。 */
  executor: ExecutorConfig;
  /** 日志出口。 */
  log?: Logger;
  /**
   * 建私有客户端的工厂。**测试用**。
   *
   * 为什么需要它：私有客户端的 REST 基址是**写死的主网地址**
   * （`resolveExchangeEndpoints`），没法指向本地假服务器——于是「交易所返回 0 时
   * 必须抛错」这条最要紧的判据就没法直接验。留一个注入点，
   * 那条判据才有测试守着。
   *
   * 缺省走「解析凭据 → 建客户端 → 校时钟」那条路。
   */
  createClient?: () => Promise<BinancePrivateClient>;
}

/**
 * 建一个「读账户权益」的函数。
 *
 * 私有客户端**懒建**：只有真的要读权益时才建，也才需要凭据。
 * `equitySource = 'config'` 的部署因此完全不需要交易所凭据。
 */
export function createEquityReader(options: EquityReaderOptions): () => Promise<EquityReading> {
  const { pool, config, exchange, executor } = options;
  const log = options.log;

  let clientPromise: Promise<BinancePrivateClient> | null = null;
  async function privateClient(): Promise<BinancePrivateClient> {
    if (clientPromise === null) {
      clientPromise = options.createClient
        ? options.createClient()
        : (async () => {
            const credentials = await resolveActiveCredentials({
              pool,
              masterKey: parseSecretKey(process.env[SECRET_KEY_ENV]),
              exchange,
              // 沿用 executor 的环境变量名：**同一个交易所账户**的凭据。
              // Agent 与 executor 用的是同一个账户，因此不该有两套变量名。
              apiKeyEnv: executor.apiKeyEnv,
              apiSecretEnv: executor.apiSecretEnv,
              note: (message: string) => log?.info(message),
            });
            const client = new BinancePrivateClient({
              credentials,
              ...exchangeEndpointsFromEnv(executor),
              recvWindowMs: executor.recvWindowMs,
            });
            // 先校时钟再发签名请求：本机时钟差几百毫秒就会让每个请求吃 -1021。
            const skew = await client.measureClockSkew();
            log?.info(describeClockSkew(skew));
            return client;
          })();
    }
    return clientPromise;
  }

  return async function readEquity(): Promise<EquityReading> {
    if (config.equitySource === 'config') {
      if (config.equity <= 0) {
        throw new SyncError(
          'CONFIG_INVALID',
          'agent.equitySource = "config" 但 agent.equity = 0：没有权益算不出仓位',
          { equitySource: 'config', equity: config.equity },
        );
      }
      return { equity: config.equity, source: 'config' };
    }
    const client = await privateClient();
    const equity = await client.accountBalance();
    if (equity <= 0) {
      throw new SyncError(
        'CONFIG_INVALID',
        `交易所返回的账户权益为 ${String(equity)}：算不出仓位`,
        { equity },
      );
    }
    return { equity, source: 'exchange' };
  };
}
