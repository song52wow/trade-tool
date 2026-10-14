#!/usr/bin/env node
import { loadConfigOrDefault, loadProjectEnv, SyncError, type Credentials } from '@trade-tool/core';
import {
  BinancePrivateClient,
  buildContext,
  createPool,
  openUserDataStream,
  parseOrderTradeUpdate,
  resolveActiveCredentials,
  resolvePolicy,
  exchangeEndpointsFromEnv,
} from '@trade-tool/data';
import { parseSecretKey, SECRET_KEY_ENV } from '@trade-tool/core';

import type { Pool } from '@trade-tool/data';

import { createAtrProvider } from './atr.js';
import { startPeriodicReconcile, type PeriodicReconcile } from './reconcile.js';
import { createExecutorService } from './service.js';

// 必须在 loadConfigOrDefault / createPool 之前：配置路径、数据库密码与 API 密钥
// 都从环境变量来。已存在的变量不会被 .env 覆盖，因此 CI 注入始终优先。
loadProjectEnv();

/** 停止信号。由 SIGINT / SIGTERM 置位，主循环据此退出而不是被强杀。 */
let stopRequested = false;
let closeStream: (() => void) | undefined;
/** 周期对账的定时器。退出时必须停掉，否则进程挂着一个 setInterval 不会结束。 */
let reconcileTimer: PeriodicReconcile | undefined;

/**
 * 凭据解析：走 `resolveActiveCredentials()`（**库里优先、环境变量兜底**）。
 *
 * 优先级只有一份实现（v0.6.0 从这里抽到 `packages/data`），因为 v0.6.0 的交易对账
 * 也要解析同一份凭据。两处各判一次的话，「哪一份在生效」就有两个答案。
 *
 * 唯一差异是 executor **要求主密钥存在**：它本来就在持续下单，凭据配置错了必须立刻
 * 失败，而不是悄悄用环境变量里的另一份跑起来。
 */
async function loadCredentials(
  config: Awaited<ReturnType<typeof loadConfigOrDefault>>,
  pool: Pool,
): Promise<Credentials> {
  return resolveActiveCredentials({
    pool,
    masterKey: parseSecretKey(process.env[SECRET_KEY_ENV]),
    exchange: config.market.exchange,
    apiKeyEnv: config.executor.apiKeyEnv,
    apiSecretEnv: config.executor.apiSecretEnv,
    note: (message) => console.error(`[executor] ${message}`),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const config = await loadConfigOrDefault();

  // 服务会**真实下单**，因此默认关闭。必须显式打开，不靠「装了包就在跑」。
  if (!config.executor.enabled) {
    console.error('executor.enabled = false，本服务不会启动（它会真实下单）');
    process.exit(2);
  }

  const pool = createPool(config.database);
  const credentials = await loadCredentials(config, pool);
  const ctx = buildContext(pool, config);
  const client = new BinancePrivateClient({
    credentials,
    // 端点来自 `executor.environment`（live / demo）。以前这里不传，
    // 于是不管配置写什么私有侧一律打主网——本地想跑沙箱根本无从下手。
    ...exchangeEndpointsFromEnv(config.executor),
    recvWindowMs: config.executor.recvWindowMs,
  });
  const atr = createAtrProvider({
    runtime: ctx.runtime,
    dsn: ctx.dsn,
    config: config.executor,
    timeoutMs: config.data.timeoutMs,
  });
  // 策略按标的解析：标的覆盖 > 全局默认 > 配置文件。优先级只有 resolvePolicy 一份实现，
  // 控制面预览与这里用的是同一个函数，避免「页面显示的」和「实际挂单的」分叉。
  const service = createExecutorService({
    pool,
    config,
    placer: client,
    atr,
    resolvePolicy: async (symbol) => resolvePolicy(pool, ctx.exchange, symbol, config.executor),
  });

  // 自动对账与用户数据流**并行**：它跑得慢或挂掉都不影响挂单（见 reconcile.ts）。
  reconcileTimer = startPeriodicReconcile({ pool, client, config });

  let delay = config.executor.reconnectBaseMs;

  /**
   * 主循环：拿 listenKey → 开流 → 断开就退避重连。
   *
   * 重连是硬要求：listenKey 30 分钟过期、长连随时可能断，而用户数据流**不会**
   * 重放断线期间的事件。不重连的后果是「进程活着、日志干净、但新的买入成交
   * 一个都没有保护」——恰恰是这个服务最不该出现的状态。
   */
  while (!stopRequested) {
    try {
      const listenKey = await client.createListenKey();
      delay = config.executor.reconnectBaseMs;
      console.error(`用户数据流已连接（listenKey ${listenKey.slice(0, 6)}…）`);

      await new Promise<void>((resolve) => {
        const handle = openUserDataStream({
          listenKey,
          url: client.listenKeyUrl(listenKey),
          webSocketFactory: (url) => new WebSocket(url) as unknown as WebSocket,
          keepAliveIntervalMs: 20 * 60_000,
          onKeepAlive: async (key) => {
            await client.keepAliveListenKey(key);
          },
          onEvent: async (payload) => {
            const update = parseOrderTradeUpdate(payload);
            if (update === null) return;
            await service.handleFill(update);
          },
          onError: (error) => {
            console.error(`[executor] ${error.message}`);
          },
          onClose: (reason) => {
            console.error(`[executor] 用户数据流断开（${reason}）`);
            resolve();
          },
        });
        closeStream = () => handle.close();
      });
      closeStream = undefined;
    } catch (error) {
      console.error(`[executor] 用户数据流不可用：${(error as Error).message}`);
    }

    if (stopRequested) break;
    console.error(`[executor] ${delay}ms 后重连…`);
    await sleep(delay);
    delay = Math.min(delay * 2, config.executor.reconnectMaxMs);
  }

  closeStream?.();
  reconcileTimer?.stop();
  await pool.end().catch(() => undefined);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.error(`\n收到 ${signal}，停止止盈止损服务…`);
    stopRequested = true;
    closeStream?.();
    // 定时器也要停：挂着的 setInterval 会让进程在「已收到停止信号」之后继续不退出。
    reconcileTimer?.stop();
  });
}

try {
  await main();
  process.exit(0);
} catch (error) {
  const message = error instanceof SyncError ? `${error.code}: ${error.message}` : String(error);
  console.error(`[executor] 启动失败：${message}`);
  process.exit(1);
}
