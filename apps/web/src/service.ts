import {
  INTERVAL_MS,
  loadConfigOrDefault,
  STORED_INTERVALS,
  type GapRecord,
  type RemovePolicy,
  type SymbolEntry,
  type SymbolSyncState,
  type TradeToolConfig,
} from '@trade-tool/core';
import {
  aggregateSymbol,
  assertSchemaVersion,
  buildContext,
  createPool,
  estimateFirstPull,
  getAllStates,
  getGaps,
  getState,
  listExchangeSymbols,
  listMaterializedSpecs,
  materializeHint,
  readDaemonHeartbeat,
  readDerivedIntervals,
  readIndicatorSpec,
  readLatestBars,
  resolveContract,
  schemaStatus,
  specLabel,
  syncSymbol,
  verifySymbol,
  type IndicatorInterval,
  type IndicatorSpec,
  type MarketContext,
  type Pool,
} from '@trade-tool/data';
import { createSyncService, HEARTBEAT_INTERVAL_MS, type SyncService } from '@trade-tool/sync';

import { clampBarLimit } from './bars.js';
import { JobRegistry, type JobRunnerOptions } from './jobs.js';
import { mergeSymbolRows } from './rows.js';
import type { WebDeps } from './server.js';
import type {
  BarDto,
  DaemonStatusDto,
  IndicatorsDto,
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

  const allRows = async () =>
    mergeSymbolRows({
      entries: await entries(),
      states: await states(),
      fallbackExchange: ctx.exchange,
    });

  const jobs = new JobRegistry({
    runFull: async (symbol) => ({ ...(await syncSymbol(ctx, symbol, {})) }),
    runVerify: async (symbol) => ({ ...(await verifySymbol(ctx, symbol)) }),
    // v0.2.0 R-7.6：重建派生表。走 --rebuild（先删后算），因为作业的用途就是
    // 「修复不一致」，而补齐对已被篡改的桶无效。
    runAggregate: async (symbol) => ({
      ...(await aggregateSymbol(ctx, symbol, {}, { rebuild: true })),
    }),
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
   * 上界跟着守护进程的**心跳间隔**（`HEARTBEAT_INTERVAL_MS`，10s）走，取 3 倍留出抖动
   * 余量——判超时用的是「心跳年龄」，节拍当然要按心跳，而不是按同步轮次的
   * `pollIntervalMs`（默认 15s；拿它去乘会把阈值算歪，且默认值下永远被 60s 下限盖住）。
   * 下限保证即便有人把心跳间隔调得极小，阈值也不会小到一次调度延迟就误报离线。
   */
  const daemonStaleMs = Math.max(60_000, HEARTBEAT_INTERVAL_MS * 3);

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
      return allRows();
    },

    async getSymbol(symbol): Promise<SymbolDetailDto | null> {
      const row = (await allRows()).find((r) => r.symbol === symbol) ?? null;
      if (row === null) return null;
      // 合约规格是快照：拿不到（缓存过期且出网失败）不该让整个详情页打不开，
      // 但必须显式是 null 让页面显示「未知」，不拿旧值假装有。
      const contract = await resolveContract(ctx, symbol).catch(() => null);
      // 派生统计（R-7.5 / AC-15）：让用户能回答「为什么没有 4h 蜡烛」。
      // 传**实际启用的周期集合**而不是布尔：R-9.1 允许只启用一个子集，没启用的周期
      // 必须如实返回 withheldReason='disabled'，而不是报 0 个桶（AC-22）。
      const derived = await readDerivedIntervals(pool, symbol, STORED_INTERVALS, {
        enabled: config.data.aggregateIntervals,
      });
      return { ...row, contract, gaps: await getGaps(ctx, symbol), estimate: null, derived };
    },

    async listExchangeSymbols(options): Promise<ExchangeListDto> {
      return listExchangeSymbols(ctx, options ?? {});
    },

    async addSymbol(symbol): Promise<SymbolRowDto> {
      await service.primitives.addSymbol(symbol);
      const row = (await allRows()).find((r) => r.symbol === symbol);
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
      const row = (await allRows()).find((r) => r.symbol === symbol);
      if (row === undefined) {
        throw new Error(`生命周期变更后 ${symbol} 读不到，状态无法确定`);
      }
      return row;
    },

    async listGaps(symbol): Promise<GapRecord[]> {
      return getGaps(ctx, symbol);
    },

    /**
     * 最近 N 根 K 线（R-23 / R-7.1），按所选周期。
     *
     * 只读本地表，不出网也不写库——所以它能挂在页面的刷新节奏上，代价只是一次走主键的
     * 倒序 LIMIT。这里再夹一次上限：路由已经夹过，但 `WebRuntime` 也会被直接调用
     * （测试、将来的其它前端），上限不能只长在 HTTP 那一层。
     *
     * `quote_volume` / `trades` 读出来但不进 DTO：图上用不到，白白撑大每次响应。
     */
    async listBars(symbol, options): Promise<BarDto[]> {
      const limit = clampBarLimit(options?.limit);
      const bars = await readLatestBars(pool, symbol, { limit, interval: options?.interval });
      return bars.map(({ time, open, high, low, close, volume }) => ({
        time,
        open,
        high,
        low,
        close,
        volume,
      }));
    },

    /**
     * 指标序列（R-10.1）：返回该 `(symbol, interval)` 下**全部已物化**的参数集。
     *
     * 取的是「库里实际有什么」而不是「配置里写了什么」——配置可以随时改，而库里是改动
     * 之前物化的那一版；用配置去猜会让页面画出一条库里根本没有的线（R-10.1 / R-9.3）。
     *
     * **一个参数集都��物化时返回 200 + `state: 'not-materialized'`**，而不是 404 也不是
     * 空数组：`not-materialized` 是完全正常的状态（刚建好标的还没物化指标），页面要能
     * 显示空状态 + 物化命令，而不是报错。
     */
    async listIndicators(symbol, options): Promise<IndicatorsDto> {
      const interval = options.interval;
      const limit = clampBarLimit(options?.limit);
      const intervalMs = INTERVAL_MS[interval];
      const specs = await listMaterializedSpecs(pool, symbol, interval);
      if (specs.length === 0) {
        return {
          symbol,
          interval,
          intervalMs,
          limit,
          implVersion: null,
          specs: [],
          shortBy: { bars: 0, reason: null },
          state: config.data.indicatorIntervals.includes(interval) ? 'not-materialized' : 'disabled',
          message:
            config.data.indicatorIntervals.includes(interval)
              ? `${interval} 的指标尚未物化。图上还没有指标线，不代表数据有问题。`
              : `未启用 ${interval} 的指标（不在 data.indicatorIntervals 里）。`,
          materializeCommand: config.data.indicatorIntervals.includes(interval)
            ? materializeHint(symbol, interval)
            : null,
        };
      }

      // 每个参数集一条查询：不同指标在不同表里，而 `interval` / `implVersion` 各不相同，
      // 合成一条动态 SQL 需要把表名与列名拼进语句——那正是 R-9.2 禁止的。
      const series = await Promise.all(
        specs.map(async (entry) => {
          const spec: IndicatorSpec = { indicator: entry.indicator, params: entry.params };
          const result = await readIndicatorSpec(pool, symbol, interval, spec, { limit });
          return {
            spec: {
              indicator: entry.indicator,
              params: entry.params,
              implVersion: result.implVersion ?? entry.implVersion,
              rows: result.rows.length,
            },
            label: specLabel(spec),
            rows: result.rows,
          };
        }),
      );

      // 「指标比 K 线短多少根」必须量化写明（R-10.4）：少的是预热期与未收盘的最后一根，
      // 不是数据缺失。桶宽来自服务端回传的 intervalMs，**不在前端写死**。
      const barCount = await readLatestBars(pool, symbol, { limit, interval });
      const latestBar = barCount[barCount.length - 1]?.time ?? null;
      const firstBar = barCount[0]?.time ?? null;
      const coverage = series.map((s) => s.rows[0]?.time).filter((t): t is number => t !== undefined);
      const coverageStart = coverage.length > 0 ? Math.max(...coverage) : null;
      const shortByBars =
        firstBar !== null && coverageStart !== null ? Math.round((coverageStart - firstBar) / intervalMs) : 0;
      const shortByLast =
        latestBar !== null && series.every((s) => (s.rows[s.rows.length - 1]?.time ?? null) !== latestBar)
          ? 1
          : 0;

      return {
        symbol,
        interval,
        intervalMs,
        limit,
        implVersion: series[0]?.spec.implVersion ?? null,
        specs: series,
        shortBy: {
          bars: shortByBars + shortByLast,
          reason: shortByBars > 0 && shortByLast > 0 ? 'mixed' : shortByBars > 0 ? 'warmup' : shortByLast > 0 ? 'not-closed' : null,
        },
        state: 'ok',
        message: null,
        materializeCommand: null,
      };
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
