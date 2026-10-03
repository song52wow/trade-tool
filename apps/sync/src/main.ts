#!/usr/bin/env node
import { loadConfigOrDefault } from '@trade-tool/core';
import { buildContext, createPool } from '@trade-tool/data';

import { createSyncService } from './service.js';

/**
 * 守护进程入口。
 *
 * 生命周期变更**不在这里**做：CLI 与控制面通过 `createSyncService()` 拿到的原语操作，
 * 状态落在 PG，因此跨进程协作不需要额外通信机制（R-22.6）。
 */
async function main(): Promise<void> {
  const config = await loadConfigOrDefault();

  // 配置里的标的集合在启动时并入集合，默认为 paused（R-8.4 / R-17.4）。
  const pool = createPool(config.database);
  const ctx = buildContext(pool, config);
  const service = createSyncService(ctx, { config });

  for (const symbol of config.sync.symbols) {
    await service.primitives.addSymbol(symbol);
  }

  await service.daemon.start();

  const shutdown = async (signal: string) => {
    console.error(`\n收到 ${signal}，停止同步守护进程…`);
    await service.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

await main();
