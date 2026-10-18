/**
 * 清理验证脚本可能残留的探针单（一次性）。
 *
 * 背景：`verify-quantity-order.ts` 在对照那一步失败时，早期版本的收尾只打印了一句话、
 * **没有真的撤单**，于是交易所上可能留下一张 `verify-` 前缀的条件单。
 * 本脚本按前缀找出来并撤掉，**只碰自己前缀的单**，不会动你真实的止盈止损。
 *
 * 用法：pnpm --filter @trade-tool/cli exec tsx scripts/cleanup-probe-orders.ts
 */

import {
  createPool,
  exchangeEndpointsFromEnv,
  BinancePrivateClient,
  resolveActiveCredentials,
} from '@trade-tool/data';
import {
  LIVE_REST_BASE_URL,
  loadConfigOrDefault,
  loadProjectEnv,
  parseSecretKey,
  SECRET_KEY_ENV,
} from '@trade-tool/core';

const PREFIX = 'verify-';

async function main(): Promise<number> {
  loadProjectEnv();
  const config = await loadConfigOrDefault();
  const endpoints = exchangeEndpointsFromEnv(config.executor);
  if (endpoints.baseUrl === LIVE_REST_BASE_URL) {
    console.error('拒绝运行：主网。');
    return 2;
  }
  const pool = createPool(config.database);
  try {
    const credentials = await resolveActiveCredentials({
      pool,
      masterKey: parseSecretKey(process.env[SECRET_KEY_ENV]),
      exchange: config.market.exchange,
      apiKeyEnv: config.executor.apiKeyEnv,
      apiSecretEnv: config.executor.apiSecretEnv,
      note: (message) => console.error(`  [凭据] ${message}`),
    });
    const client = new BinancePrivateClient({
      credentials,
      ...endpoints,
      recvWindowMs: config.executor.recvWindowMs,
    });
    await client.measureClockSkew();

    // **全账户查**，不按标的逐个找：只查「有未终结记录」的标的会在账户没有记录时
    // 得出「没发现残留」——而残留单恰恰可能就在一个没有记录的标的上（验证脚本就是
    // 在没有仓位也没有记录的情况下挂的）。这里宁可多花权重，也要把话说准。
    const open = await client.openAlgoOrders({});
    const mine = open.filter((o) => o.clientAlgoId.startsWith(PREFIX));

    let found = 0;
    for (const order of mine) {
      found += 1;
      try {
        await client.cancelAlgoOrder(order.algoId);
        console.error(`  ✓ 已撤 ${order.symbol} algoId=${order.algoId} ${order.clientAlgoId}`);
      } catch (error) {
        console.error(`  ! 撤 ${order.algoId} 失败：${String(error)}`);
        return 1;
      }
    }
    console.error(found === 0 ? '\n没有发现残留的探针单。' : `\n共撤掉 ${found} 张探针单。`);
    return 0;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`清理失败：${String(error)}`);
    process.exit(1);
  });
