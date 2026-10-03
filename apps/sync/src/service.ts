import type { TradeToolConfig } from '@trade-tool/core';
import { buildContext, createPool, type MarketContext } from '@trade-tool/data';

import { SyncDaemon } from './daemon.js';
import { SyncControl, type ControlPrimitives } from './primitives.js';

/**
 * 把「原语 + 守护进程 + 连接池」组装成一个控制面可直接持有的对象。
 *
 * 页面 / HTTP API 不在本期（N-7），但控制面应该已经能直接 import 这套原语（R-22.2），
 * 所以本工厂是本期真正的交付面。
 */

export interface SyncServiceOptions {
  config: TradeToolConfig;
  exchange?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SyncService {
  /** 控制原语：addSymbol / removeSymbol / listSymbols / start / pause / resume / getStatus / getSummary */
  primitives: ControlPrimitives;
  /** 常驻调度器 */
  daemon: SyncDaemon;
  close(): Promise<void>;
}

export function createSyncService(ctx: MarketContext, options: SyncServiceOptions): SyncService {
  const primitives = new SyncControl(ctx, { config: options.config, exchange: options.exchange });
  const daemon = new SyncDaemon(ctx, {
    config: options.config,
    ...(options.now ? { now: options.now } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });
  return {
    primitives,
    daemon,
    close: () => ctx.pool.end(),
  };
}

/** 便捷入口：自行建池，调用方只负责 `close()`。 */
export function createSyncServiceFromConfig(
  config: TradeToolConfig,
  options: Omit<SyncServiceOptions, 'config'> = {},
): SyncService {
  const pool = createPool(config.database);
  const ctx = buildContext(pool, config, options.exchange ? { exchange: options.exchange } : {});
  return createSyncService(ctx, { config, ...options });
}
