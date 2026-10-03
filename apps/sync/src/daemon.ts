import {
  createLogger,
  type SymbolEntry,
  type SymbolSyncState,
  type TradeToolConfig,
} from '@trade-tool/core';
import { getAllStates, type MarketContext } from '@trade-tool/data';

import { SyncControl } from './primitives.js';

/**
 * 常驻调度循环（R-17 … R-21）。
 *
 * 三条不变量：
 *   1. **单标的失败不扩散**：任一标的出错只写进它自己的状态，其它标的继续（R-21.1 / AC-18）。
 *   2. **单写者**：同一标的同一时刻只有一个任务（R-3.3 / AC-19）。
 *   3. **进程只在全局性错误时退出**：配置非法、PG 不可连、元数据无法获取且无缓存、
 *      schema 版本不匹配（Python 侧以 `SCHEMA_VERSION_MISMATCH` 等错误码上报）。单标的错误一律不退出。
 */

const log = createLogger('sync');

/** 只在全局性错误时让进程退出。 */
const GLOBAL_FATAL_CODES = new Set([
  'CONFIG_INVALID',
  'SCHEMA_VERSION_MISMATCH',
  'DB_CONNECTION_FAILED',
  'METADATA_FETCH_FAILED',
]);

export interface DaemonOptions {
  config: TradeToolConfig;
  /** 测试可注入固定时钟 */
  now?: () => number;
  /** 测试可注入的休眠实现 */
  sleep?: (ms: number) => Promise<void>;
}

export class SyncDaemon {
  private readonly control: SyncControl;
  private readonly ctx: MarketContext;
  private readonly config: TradeToolConfig;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private running = false;
  private stopping = false;
  private loopPromise: Promise<void> | null = null;

  constructor(ctx: MarketContext, options: DaemonOptions) {
    this.ctx = ctx;
    this.config = options.config;
    this.control = new SyncControl(ctx, { config: options.config, exchange: ctx.exchange });
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  }

  get primitives(): SyncControl {
    return this.control;
  }

  /**
   * 启动时的状态对账（R-19.4）。
   * 状态本来就持久化在 PG 里，因此这里**不做任何假设**：重启后 running 的继续增量同步，
   * paused 的保持暂停，已登记的 gaps 继续参与自动回补。
   */
  async reconcile(): Promise<SymbolSyncState[]> {
    const states = await getAllStates(this.ctx);
    for (const state of states) {
      if (state.status === 'running') {
        this.control.markInflight(state.symbol, false);
      }
    }
    log.info(
      `启动对账：${states.length} 个标的（running ${states.filter((s) => s.status === 'running').length}，` +
        `paused ${states.filter((s) => s.status === 'paused').length}，error ${states.filter((s) => s.status === 'error').length}）`,
    );
    return states;
  }

  /**
   * 本轮可调度的标的：集合内、期望 running、非 error、不在退避中。
   * **顺序稳定**且经过统一限速器排队，批量回补不会一次性放开全部并发（R-20.6 / AC-24）。
   */
  async selectBatch(nowMs: number): Promise<SymbolEntry[]> {
    const entries = await this.control.listSymbols();
    const states = new Map((await getAllStates(this.ctx)).map((s) => [s.symbol, s]));

    const eligible = entries.filter((entry) => {
      if (entry.desiredState !== 'running') return false;
      const state = states.get(entry.symbol);
      if (state?.status === 'error') return false; // 需显式 resume 才恢复（R-21.3）
      return this.control.isSchedulable(entry.symbol, nowMs);
    });

    const slotsFree = Math.max(0, this.config.sync.concurrency - this.inflightCount());
    return eligible.slice(0, slotsFree);
  }

  private inflightCount(): number {
    return Object.values(this.control.slotsSnapshot()).filter((slot) => slot.inflight).length;
  }

  /** 跑一轮。返回本轮各标的的失败原因，供测试断言。 */
  async tick(): Promise<Map<string, string>> {
    const nowMs = this.now();
    const batch = await this.selectBatch(nowMs);
    if (batch.length === 0) return new Map();

    log.info(`本轮调度 ${batch.length} 个标的：${batch.map((e) => e.symbol).join(', ')}`);
    const failures = new Map<string, string>();

    for (const entry of batch) {
      if (this.stopping) break;
      // 错误隔离：runOnce 自己吞掉异常并返回错误码，这里不 throw。
      const error = await this.control.runOnce(entry.symbol, this.now());
      if (error) {
        failures.set(entry.symbol, error.code);
        log.warn(`${entry.symbol} 同步失败 [${error.code}]：${error.message}`);
      }
    }
    return failures;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopping = false;

    // 全局性错误 → 进程退出；这是「不静默兜底」在常驻形态下的体现。
    try {
      await this.reconcile();
    } catch (error) {
      this.running = false;
      this.exitIfGlobalFatal(error);
      throw error;
    }

    this.loopPromise = this.loop();
    log.info(
      `同步守护进程已启动（并发上限 ${this.config.sync.concurrency}，轮询 ${this.config.sync.pollIntervalMs}ms）`,
    );
  }

  private async loop(): Promise<void> {
    while (this.running && !this.stopping) {
      try {
        const failures = await this.tick();
        for (const [symbol, code] of failures) {
          if (GLOBAL_FATAL_CODES.has(code) && !this.isSymbolLocalFailure(symbol)) {
            throw new Error(`全局性错误 [${code}]，守护进程退出`);
          }
        }
      } catch (error) {
        this.running = false;
        this.exitIfGlobalFatal(error);
        throw error;
      }
      if (!this.running || this.stopping) break;
      await this.sleep(this.config.sync.pollIntervalMs);
    }
  }

  /**
   * 区分「该标的的失败」与「影响全局的失败」。
   * `SYMBOL_NOT_FOUND` / `NOT_PERPETUAL` / `NOT_TRADING` 只影响单个标的，不该拖垮进程。
   */
  private isSymbolLocalFailure(code: string): boolean {
    return code === 'SYMBOL_NOT_FOUND' || code === 'NOT_PERPETUAL' || code === 'NOT_TRADING';
  }

  private exitIfGlobalFatal(error: unknown): void {
    const code = (error as { code?: string })?.code;
    log.error(
      `守护进程因全局性错误退出${code ? ` [${code}]` : ''}：${(error as Error)?.message ?? String(error)}`,
    );
    process.exitCode = 1;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.running = false;
    await this.loopPromise?.catch(() => undefined);
  }
}

export function createDaemon(ctx: MarketContext, options: DaemonOptions): SyncDaemon {
  return new SyncDaemon(ctx, options);
}
