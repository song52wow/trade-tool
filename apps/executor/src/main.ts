#!/usr/bin/env node
import { loadConfigOrDefault, loadProjectEnv, SyncError, type Credentials } from '@trade-tool/core';
import {
  BinancePrivateClient,
  buildContext,
  createPool,
  openUserDataStream,
  parseOrderTradeUpdate,
  readCredentials as readStoredCredentials,
  resolvePolicy,
} from '@trade-tool/data';
import { parseSecretKey, SECRET_KEY_ENV } from '@trade-tool/core';

import type { Pool } from '@trade-tool/data';

import { createAtrProvider } from './atr.js';
import { createExecutorService } from './service.js';

// 必须在 loadConfigOrDefault / createPool 之前：配置路径、数据库密码与 API 密钥
// 都从环境变量来。已存在的变量不会被 .env 覆盖，因此 CI 注入始终优先。
loadProjectEnv();

/** 停止信号。由 SIGINT / SIGTERM 置位，主循环据此退出而不是被强杀。 */
let stopRequested = false;
let closeStream: (() => void) | undefined;

/**
 * 凭据解析。**先读库里加密存的那份，再回落环境变量**。
 *
 * 两条路径的优先级必须写在这里并且只有一处：控制面 v0.5.0 起可以在页面上录入密钥，
 * 加密后落库；但部署环境仍然可以用环境变量注入（CI、临时排障、容器编排）。
 * 谁优先不是偏好问题——两份不一致时，只有明确的那一份算数。
 *
 * 选择「库优先」是因为页面是更近的一步操作：改了之后不必再去改 .env 并重启。
 * 环境变量仍然兜底，是为了不配置控制面的部署方式完全不受影响。
 *
 * 环境变量这一档**缺一即拒**，不做「读到一半先用空密钥试一下」：Binance 会返回 401，
 * 而一个带着空密钥反复重连的进程看起来只是「连不上」，很难定位。
 */
async function loadCredentials(
  config: Awaited<ReturnType<typeof loadConfigOrDefault>>,
  pool: Pool,
): Promise<Credentials> {
  const stored = await readStoredCredentials(
    pool,
    parseSecretKey(process.env[SECRET_KEY_ENV]),
    config.market.exchange,
  );
  if (stored !== null) {
    console.error(`[executor] 使用控制面录入的凭据（${config.market.exchange}）`);
    return stored;
  }

  const key = process.env[config.executor.apiKeyEnv];
  const secret = process.env[config.executor.apiSecretEnv];
  const missing: string[] = [];
  if (!key || key.trim() === '') missing.push(config.executor.apiKeyEnv);
  if (!secret || secret.trim() === '') missing.push(config.executor.apiSecretEnv);
  if (missing.length > 0) {
    throw new SyncError(
      'CONFIG_INVALID',
      `库里没有配置过 ${config.market.exchange} 凭据，且环境变量 ${missing.join(', ')} 也没有设置。` +
        `请在控制面「设置」页录入，或在仓库根 .env 里设置这两个变量。`,
      { missing },
    );
  }
  console.error(`[executor] 使用环境变量注入的凭据（${config.market.exchange}）`);
  return { apiKey: key as string, apiSecret: secret as string };
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
  await pool.end().catch(() => undefined);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.error(`\n收到 ${signal}，停止止盈止损服务…`);
    stopRequested = true;
    closeStream?.();
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
