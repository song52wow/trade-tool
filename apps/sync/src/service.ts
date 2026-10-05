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
    // **共享同一个控制原语实例**：否则控制面拿到的 primitives 与守护进程内部的是两份
    // 实例私有的运行时槽位，addSymbol 的并发守卫成死代码、resume() 也清不掉守护进程的退避，
    // 显式恢复要等最长 backoffMaxMs（默认 5 分钟）才生效（R-21.3 / R-22）。
    control: primitives,
    ...(options.now ? { now: options.now } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });
  return {
    primitives,
    daemon,
    // 只停守护进程，**不关连接池**——池是调用方传进来的（ctx.pool），不是这里建的。
    // 擅自关掉别人的池，会让调用方在 close() 之后任何一次查询都撞上
    // 「Cannot use a pool after calling end」（apps/web 与测试都踩过）。
    //
    // 顺序也不能反：删心跳行、停心跳定时器都在 daemon.stop() 里，只关池的话 SIGTERM 的
    // 「优雅退出」什么也没做，库里会留下一个永远不再刷新的心跳行，页面把它读成 stale
    // （「进程还在但不对劲，查日志」），而进程其实已经退出了——该报的是 stopped。
    close: () => daemon.stop(),
  };
}

/**
 * 便捷入口：**自行建池**，因此 `close()` 负责连池一起关掉。
 * 用 `createSyncService` 的调用方自己建池，也就自己负责 `pool.end()`。
 */
export function createSyncServiceFromConfig(
  config: TradeToolConfig,
  options: Omit<SyncServiceOptions, 'config'> = {},
): SyncService {
  const pool = createPool(config.database);
  const ctx = buildContext(pool, config, options.exchange ? { exchange: options.exchange } : {});
  const service = createSyncService(ctx, { config, ...options });
  return {
    ...service,
    close: async () => {
      await service.close();
      await pool.end();
    },
  };
}
