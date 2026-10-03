import { loadConfigOrDefault, resolveHome, type TradeToolConfig } from '@trade-tool/core';
import { buildContext, createPool, type MarketContext, type Pool } from '@trade-tool/data';
import { resolve } from 'node:path';

/**
 * CLI 的运行时上下文：配置 + 连接池 + MarketContext。
 *
 * 生命周期由调用方控制（命令结束时 `close()`），这样一次进程只建一次池。
 */

export interface CliContext extends MarketContext {
  config: TradeToolConfig;
  close(): Promise<void>;
}

/** 密码缺失时给出一条可执行的提示，而不是让 `pg` 抛出难以理解的连接错误。 */
export async function withContext<T>(
  fn: (ctx: CliContext) => Promise<T>,
  options: { exchange?: string } = {},
): Promise<T> {
  const config = await loadConfigOrDefault();
  const pool: Pool = createPool(config.database);
  const context = buildContext(
    pool,
    config,
    options.exchange ? { exchange: options.exchange } : {},
  );
  try {
    return await fn({
      ...context,
      config,
      close: () => pool.end(),
    });
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/** 把配置里的相对目录解析成绝对路径（相对 TRADE_TOOL_HOME）。 */
export function fromHome(...segments: string[]): string {
  return resolve(resolveHome(), ...segments);
}
