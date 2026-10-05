#!/usr/bin/env node
import { loadConfigOrDefault, loadProjectEnv, normalizeSyncSymbols } from '@trade-tool/core';
import { buildContext, createPool } from '@trade-tool/data';

import { createSyncService } from './service.js';

// 必须在 loadConfigOrDefault / createPool 之前：配置路径与数据库密码都从环境变量来。
loadProjectEnv();

/**
 * 守护进程入口。
 *
 * 生命周期变更**不在这里**做：CLI 与控制面通过 `createSyncService()` 拿到的原语操作，
 * 状态落在 PG，因此跨进程协作不需要额外通信机制（R-22.6）。
 */
async function main(): Promise<void> {
  const config = await loadConfigOrDefault();

  // 配置里的标的集合在启动时并入集合（R-8.4 / R-17.4）：
  // 纯字符串条目默认 paused；显式写了 desiredState=running 的才在并入后立即开启。
  const pool = createPool(config.database);
  const ctx = buildContext(pool, config);
  const service = createSyncService(ctx, { config });

  for (const entry of normalizeSyncSymbols(config.sync.symbols)) {
    await service.primitives.addSymbol(entry.symbol, {
      start: entry.desiredState === 'running',
    });
  }

  await service.daemon.start();

  const shutdown = async (signal: string) => {
    console.error(`\n收到 ${signal}，停止同步守护进程…`);
    // 池是这里建的，所以这里关。顺序：先停守护进程（删心跳行、停刷新），再关池。
    await service.close();
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

await main();
