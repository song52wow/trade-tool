import {
  loadConfigOrDefault,
  type GapRecord,
  type RemovePolicy,
  type SymbolEntry,
  type SymbolSyncState,
  type TradeToolConfig,
} from '@trade-tool/core';
import {
  assertSchemaVersion,
  buildContext,
  createPool,
  estimateFirstPull,
  getAllStates,
  getGaps,
  getState,
  listExchangeSymbols,
  readBars,
  readDaemonHeartbeat,
  readLatestBars,
  resolveContract,
  schemaStatus,
  syncSymbol,
  verifySymbol,
  type MarketContext,
  type Pool,
} from '@trade-tool/data';
import { createSyncService, type SyncService } from '@trade-tool/sync';

import { clampBarLimit } from './bars.js';
import { JobRegistry, type JobRunnerOptions } from './jobs.js';
import { mergeSymbolRows } from './rows.js';
import type { WebDeps } from './server.js';
import type {
  BarDto,
  DaemonStatusDto,
  ExchangeListDto,
  OverviewDto,
  SymbolDetailDto,
  SymbolRowDto,
} from './types.js';

export interface WebRuntime extends WebDeps {
  /** schema 闸门：库与代码版本不一致时抛错，不让页面在旧结构上继续操作（R-1.3 / R-19.7）。 */
  assertSchema(): Promise<void>;
  close(): Promise<void>;
}

/**
 * 用真实依赖装配控制面。
 *
 * 这里刻意**不**内嵌守护进程：R-19 要求状态先落库再生效、R-22.6 说跨进程协作不需要
 * 新通信机制，所以 `apps/sync` 作为独立进程继续跑；本应用只通过原语改意图，
 * 通过作业做一次性拉取。两者写同一张表时由单写者锁（R-3.3）挡住，作业侧再提前用
 * 409 拦一道，让用户看到可执行的提示而不是锁冲突堆栈。
 */
export function createWebRuntime(config: TradeToolConfig): WebRuntime {
  const pool: Pool = createPool(config.database);
  // 用底层 createSyncService 而非 createSyncServiceFromConfig：后者会再建一个连接池，
  // 于是同一进程两个池、各自 10 条连接上限（database.poolMax）。
  const ctx: MarketContext = buildContext(pool, config);
  const service: SyncService = createSyncService(ctx, { config });

  const states = async (): Promise<SymbolSyncState[]> => getAllStates(ctx);

  const entries = (): Promise<SymbolEntry[]> => service.primitives.listSymbols();

  /** 升序返回，limit 1 即最早一根；空表返回 0 行（无历史），不是错误。 */
  async function earliestBar(symbol: string): Promise<number | null> {
    const rows = await readBars(pool, symbol, { limit: 1 });
    return rows[0]?.time ?? null;
  }

  const allRows = async (now: number) =>
    mergeSymbolRows({
      entries: await entries(),
      states: await states(),
      earliestOf: earliestBar,
      fallbackExchange: ctx.exchange,
      now,
    });

  const jobs = new JobRegistry({
    runFull: async (symbol) => ({ ...(await syncSymbol(ctx, symbol, {})) }),
    runVerify: async (symbol) => ({ ...(await verifySymbol(ctx, symbol)) }),
    readProgress: async (symbol) => {
      const state = await getState(ctx, symbol);
      return { rows: state?.rows ?? null, pendingGaps: state?.pendingGaps ?? null };
    },
    isDaemonOwned: async (symbol) => {
      const entry = (await entries()).find((e) => e.symbol === symbol);
      return entry?.desiredState === 'running';
    },
  } satisfies JobRunnerOptions);

  /**
   * 心跳超阈值的下限 60s。
   *
   * 上限跟着守护进程的心跳间隔（10s）走，取 3 倍留出抖动余量；下限则保证即便有人把
   * `pollIntervalMs` 配得极小，阈值也不会小到一次网络抖动就误报离线。
   */
  const daemonStaleMs = Math.max(60_000, config.sync.pollIntervalMs * 3);

  const daemonStatus = async (now: number): Promise<DaemonStatusDto> => {
    const beat = await readDaemonHeartbeat(pool, ctx.exchange, daemonStaleMs, now);
    return { ...beat, staleAfterMs: daemonStaleMs };
  };

  return {
    // assertSchemaVersion 在版本不匹配时抛错；匹配时返回值对调用方没有意义。
    assertSchema: async () => {
      await assertSchemaVersion(pool);
    },

    async getOverview(): Promise<OverviewDto> {
      const now = Date.now();
      const [schema, summary, exchange, daemon] = await Promise.all([
        schemaStatus(pool),
        service.primitives.getSummary(),
        listExchangeSymbols(ctx),
        daemonStatus(now),
      ]);
      return {
        schema,
        summary,
        exchange: {
          exchange: exchange.exchange,
          count: exchange.count,
          cachedAt: exchange.cachedAt,
          ageMs: exchange.ageMs,
          stale: exchange.stale,
        },
        daemon,
        jobs: { active: jobs.activeCount(), recent: jobs.list().slice(0, 5) },
        now,
      };
    },

    async listSymbols(): Promise<SymbolRowDto[]> {
      return allRows(Date.now());
    },

    async getSymbol(symbol): Promise<SymbolDetailDto | null> {
      const row = (await allRows(Date.now())).find((r) => r.symbol === symbol) ?? null;
      if (row === null) return null;
      // 合约规格是快照：拿不到（缓存过期且出网失败）不该让整个详情页打不开，
      // 但必须显式是 null 让页面显示「未知」，不拿旧值假装有。
      const contract = await resolveContract(ctx, symbol).catch(() => null);
      return { ...row, contract, gaps: await getGaps(ctx, symbol), estimate: null };
    },

    async listExchangeSymbols(options): Promise<ExchangeListDto> {
      return listExchangeSymbols(ctx, options ?? {});
    },

    async addSymbol(symbol): Promise<SymbolRowDto> {
      await service.primitives.addSymbol(symbol);
      const row = (await allRows(Date.now())).find((r) => r.symbol === symbol);
      if (row === undefined) throw new Error(`添加 ${symbol} 后仍读不到该标的，状态无法确定`);
      return row;
    },

    async removeSymbol(symbol, policy: RemovePolicy): Promise<void> {
      await service.primitives.removeSymbol(symbol, policy);
    },

    async lifecycle(symbol, action) {
      if (action === 'start') await service.primitives.start(symbol);
      else if (action === 'pause') await service.primitives.pause(symbol);
      else await service.primitives.resume(symbol);
      const row = (await allRows(Date.now())).find((r) => r.symbol === symbol);
      if (row === undefined) {
        throw new Error(`生命周期变更后 ${symbol} 读不到，状态无法确定`);
      }
      return row;
    },

    async listGaps(symbol): Promise<GapRecord[]> {
      return getGaps(ctx, symbol);
    },

    /**
     * 最近 N 根 1m K 线（R-23）。
     *
     * 只读本地 `klines_1m`，不出网也不写库——所以它能挂在页面的刷新节奏上，代价只是一
     * 次走主键的倒序 LIMIT。这里再夹一次上限：路由已经夹过，但 `WebRuntime` 也会被
     * 直接调用（测试、将来的其它前端），上限不能只长在 HTTP 那一层。
     *
     * `quote_volume` / `trades` 读出来但不进 DTO：图上用不到，白白撑大每次响应。
     */
    async listBars(symbol, options): Promise<BarDto[]> {
      const limit = clampBarLimit(options?.limit);
      const bars = await readLatestBars(pool, symbol, { limit });
      return bars.map(({ time, open, high, low, close, volume }) => ({
        time,
        open,
        high,
        low,
        close,
        volume,
      }));
    },

    // 预估要出网读元数据但**不写库**（R-8.3），所以由确认弹窗按需单独触发。
    estimate: (symbol) => estimateFirstPull(ctx, symbol),

    startJob: (input) => jobs.start(input),
    listJobs: async () => jobs.list(),
    getJob: async (id) => jobs.get(id),

    async close(): Promise<void> {
      await service.close();
      await pool.end().catch(() => undefined);
    },
  };
}

export { loadConfigOrDefault };
