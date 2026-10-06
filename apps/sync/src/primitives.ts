import {
  createLogger,
  SyncError,
  type GapRecord,
  type RemovePolicy,
  type SymbolEntry,
  type SymbolSyncState,
  type SyncRunSummary,
  type SyncSummary,
  type TradeToolConfig,
} from '@trade-tool/core';
import {
  ensureSyncState,
  estimateFirstPull,
  getAllStates,
  getGaps,
  getState,
  getSummary,
  getSymbolEntries,
  removeSymbolEntry,
  requireContract,
  setDesiredState,
  setSyncPlan,
  setSyncStatus,
  syncSymbol,
  upsertSymbolEntry,
  watermark,
  type MarketContext,
} from '@trade-tool/data';

/**
 * 控制原语（R-22）。
 *
 * 这是交付给控制面的**边界**：`apps/web` 的 HTTP API 与看板直接 `import` 这套原语
 * （R-22.6 / R-24.6），因此：
 *   - 不依赖任何 HTTP 框架；
 *   - 错误全部是带 code 的 `SyncError`，不返回字符串；
 *   - 状态先落库再生效（R-17.3），因此跨进程协作不需要新通信机制（R-22.6）。
 *
 * 全部原语**幂等**：控制面可能重复发送请求，对已是目标状态的调用返回当前状态而非报错（R-17.2）。
 */

export interface RuntimeSlot {
  /** 正在同步中的任务（单写者语义，R-3.3 / R-20.5） */
  inflight: boolean;
  /** 退避截止时间；退避期间该标的不参与调度（R-21.2） */
  backoffUntil: number | null;
  /** 本进程内观察到的连续失败次数 */
  consecutiveErrors: number;
}

export interface PrimitivesOptions {
  config: TradeToolConfig;
  exchange?: string | undefined;
  /**
   * 覆盖「跑一轮同步」的实现。
   * 默认走 `@trade-tool/data` → Python 桥接；测试注入假实现后，
   * 生命周期 / 退避 / 错误隔离的用例可以完全脱离网络与子进程（R-16.5）。
   */
  syncFn?: ((symbol: string) => Promise<SyncRunSummary>) | undefined;
}

export interface ControlPrimitives {
  /** 标的集合：增 / 删 / 列（R-18） */
  addSymbol(symbol: string, options?: { start?: boolean }): Promise<SymbolEntry>;
  removeSymbol(
    symbol: string,
    policy?: RemovePolicy,
  ): Promise<{ symbol: string; policy: RemovePolicy; deletedRows: number }>;
  listSymbols(): Promise<SymbolEntry[]>;
  /** 生命周期：全部幂等，立即返回，不阻塞等待回补完成（R-17.6） */
  start(symbol: string): Promise<SymbolSyncState>;
  pause(symbol: string): Promise<SymbolSyncState>;
  resume(symbol: string): Promise<SymbolSyncState>;
  /** 状态查询 */
  getStatus(symbol?: string): Promise<SymbolSyncState | SymbolSyncState[] | SyncSummary>;
  getSummary(): Promise<SyncSummary>;
  /** 缺口清单（控制面可见性，R-11.11） */
  getGaps(symbol?: string): Promise<GapRecord[]>;
}

/**
 * 需要控制面显式人工介入的错误（R-21.5）：不得自动重试掩盖，必须保持 error
 * 并在 lastError 中留下位置信息。
 *
 * 注意这里**不含** `SYNC_ALREADY_RUNNING`：它表示「同一标的已有另一轮在跑」
 * （另一个守护进程、或运维手工执行 `data sync`），是完全良性且瞬时的并发结果。
 * 把它当人工介入会因一次正常竞争就把该标的钉死成 error，而 `resume()` 之后
 * 只要竞争仍在就会再次钉死——那是把可恢复的并发误报成故障（R-21.3 / R-21.5）。
 */
const MANUAL_INTERVENTION_CODES = new Set([
  'GAP_ATTEMPTS_EXHAUSTED',
  'UNCLOSED_BAR_IN_STORE',
  'BACKFILL_BOUNDARY_VIOLATION',
  'WATERMARK_MISMATCH',
  'NULL_NOT_ALLOWED',
  'SYMBOL_NOT_FOUND',
  'NOT_PERPETUAL',
  'NOT_TRADING',
  'SCHEMA_VERSION_MISMATCH',
  // v0.2.0 R-9.3：聚合失败需人工介入。
  //
  // AGGREGATION_FAILED 意味着**该批 1m 已整批回滚**（连水位都没推进）——自动重试
  // 掩盖它，只会让标的反复失败而没人知道是派生层坏了；正确处置是把
  // `data.aggregateIntervals` 显式设成 `[]` 恢复 1m 同步，再排查派生。
  // AGGREGATION_MISMATCH 来自 `data aggregate --check`，是人工校验的产物。
  'AGGREGATION_FAILED',
  'AGGREGATION_MISMATCH',
]);

const log = createLogger('sync:control');

/** PG 侧可恢复错误：有限重试即可（连接失败 / 死锁 / 事务回滚）。 */
const RECOVERABLE_PG_CODES = new Set([
  'DB_CONNECTION_FAILED',
  'DB_DEADLOCK',
  'DB_TRANSACTION_ROLLBACK',
]);

export class SyncControl implements ControlPrimitives {
  private readonly ctx: MarketContext;
  private readonly exchange: string;
  private readonly config: TradeToolConfig;
  private readonly slots = new Map<string, RuntimeSlot>();
  private readonly syncFn: (symbol: string) => Promise<SyncRunSummary>;

  constructor(ctx: MarketContext, options: PrimitivesOptions) {
    this.ctx = ctx;
    this.exchange = options.exchange ?? ctx.exchange;
    this.config = options.config;
    this.syncFn = options.syncFn ?? ((symbol: string) => syncSymbol(this.ctx, symbol));
  }

  private slot(symbol: string): RuntimeSlot {
    const existing = this.slots.get(symbol);
    if (existing) return existing;
    const created: RuntimeSlot = { inflight: false, backoffUntil: null, consecutiveErrors: 0 };
    this.slots.set(symbol, created);
    return created;
  }

  // ------------------------------------------------------------ 标的集合

  /**
   * 加入标的集合（R-18.2）。
   * 必须**先经运行时元数据校验**，校验失败不得写入集合——这正是「标的不写死」的落点：
   * 合法性永远由交易所数据决定，而不是任何白名单（R-5）。
   */
  async addSymbol(symbol: string, options: { start?: boolean } = {}): Promise<SymbolEntry> {
    if (this.slot(symbol).inflight) {
      throw new SyncError('SYNC_ALREADY_RUNNING', `标的 ${symbol} 正在同步中，无法变更集合`, {
        symbol,
      });
    }
    // 元数据校验顺带把 contract_spec 快照落库。
    const spec = await requireContract(this.ctx, symbol);
    const entry = await upsertSymbolEntry(this.ctx.pool, {
      exchange: this.exchange,
      symbol,
      onboardDate: spec.onboardDate,
    });
    await ensureSyncState(this.ctx.pool, this.exchange, symbol, 'paused');
    // R-8.3：常驻模式下新标的默认 paused，控制面要**先看到代价**才决定是否开启首次全量
    //（一次全量是数百~上千次请求量级）。因此在开启之前就把规模预估写进 sync_state，
    // 由 `sync status` 暴露；它同时是进度的分母（R-8.6）。
    // 只有确实无历史的标的才需要计划：已有历史就是增量，没有「首次全量规模」。
    if ((await watermark(this.ctx.pool, symbol)).maxTime === null) {
      const plan = await estimateFirstPull(this.ctx, symbol);
      await setSyncPlan(this.ctx.pool, this.exchange, symbol, plan);
    }
    // 幂等：已经是目标状态则不重复写（R-18.5 / R-17.2）。
    if (options.start) await this.start(symbol);
    return (await this.listSymbols()).find((item) => item.symbol === symbol) ?? entry;
  }

  /**
   * 移除标的（R-18.3）。数据处置**必须显式**且可配置，禁止静默删除已入库数据。
   * `keep`（默认）只移出调度集合；`delete` 才会真的删 K 线。
   */
  async removeSymbol(
    symbol: string,
    policy: RemovePolicy = this.config.sync.onRemove,
  ): Promise<{ symbol: string; policy: RemovePolicy; deletedRows: number }> {
    const result = await removeSymbolEntry(this.ctx.pool, this.exchange, symbol, policy);
    // 立即停止该标的的调度；暂停不删除任何数据（R-17.5）。
    const slot = this.slot(symbol);
    slot.backoffUntil = null;
    slot.consecutiveErrors = 0;
    // 状态写失败不能吞：吞掉的话控制面会看到一个「已移除却仍是 running」的标的（R-19 / 不静默兜底）。
    await setSyncStatus(this.ctx.pool, this.exchange, symbol, {
      status: 'paused',
      lastError: null,
    });
    return { symbol, policy, deletedRows: result.deletedRows };
  }

  async listSymbols(): Promise<SymbolEntry[]> {
    return getSymbolEntries(this.ctx);
  }

  // -------------------------------------------------------------- 生命周期

  /**
   * 开启：paused → running。幂等；已 running 则直接返回当前状态（R-17.2）。
   *
   * 标的必须**已在集合内**：否则 ``ensureSyncState`` 会凭空造出一行 ``sync_state``，
   * 而 ``setDesiredState`` 因为集合里没有它而更新 0 行——于是控制面收到一个
   * 「running」的返回，但 ``desired_state`` 是 NULL、daemon 永远不会调度它，
   * 汇总里却一直把它算作 running（R-18.4 / R-19.8）。
   */
  async start(symbol: string): Promise<SymbolSyncState> {
    await this.requireMembership(symbol);
    await setDesiredState(this.ctx.pool, this.exchange, symbol, 'running');
    // 先落库再生效（R-17.3）：跨进程的控制面立即就能看到 running。
    return this.markRunning(symbol);
  }

  /** 暂停：running → paused。幂等。**不删除任何数据**（R-17.5）。 */
  async pause(symbol: string): Promise<SymbolSyncState> {
    await this.requireMembership(symbol);
    await setDesiredState(this.ctx.pool, this.exchange, symbol, 'paused');
    return this.markPaused(symbol);
  }

  /**
   * 恢复：error/paused → running，清空退避（R-21.3）。
   * 连续失败达上限后进入 error 并**停止自动重试**，只能靠这里显式恢复。
   */
  async resume(symbol: string): Promise<SymbolSyncState> {
    await this.requireMembership(symbol);
    await setDesiredState(this.ctx.pool, this.exchange, symbol, 'running');
    const slot = this.slot(symbol);
    slot.backoffUntil = null;
    slot.consecutiveErrors = 0;
    return this.markRunning(symbol);
  }

  /** 标的必须在集合内，否则报结构化的 SYMBOL_NOT_FOUND（R-18.4 / R-22.4）。 */
  private async requireMembership(symbol: string): Promise<void> {
    const entries = await this.listSymbols();
    if (!entries.some((entry) => entry.symbol === symbol)) {
      throw new SyncError('SYMBOL_NOT_FOUND', `标的 ${symbol} 不在集合中，请先 addSymbol`, {
        symbol,
      });
    }
  }

  private async markRunning(symbol: string): Promise<SymbolSyncState> {
    const state = await setSyncStatus(this.ctx.pool, this.exchange, symbol, {
      status: 'running',
      lastError: null,
      errorCount: 0,
      backoffUntil: null,
    });
    return state ?? (await this.requireState(symbol));
  }

  private async markPaused(symbol: string): Promise<SymbolSyncState> {
    const state = await setSyncStatus(this.ctx.pool, this.exchange, symbol, { status: 'paused' });
    return state ?? (await this.requireState(symbol));
  }

  private async requireState(symbol: string): Promise<SymbolSyncState> {
    const state = await getState(this.ctx, symbol);
    if (!state) {
      throw new SyncError('SYMBOL_NOT_FOUND', `标的 ${symbol} 不在集合中，请先 addSymbol`, {
        symbol,
      });
    }
    return state;
  }

  // ------------------------------------------------------------ 状态查询

  /** `getStatus()` → 全部；`getStatus(sym)` → 单个；`getStatus('*')` 之外也可传 undefined。 */
  async getStatus(symbol?: string): Promise<SymbolSyncState | SymbolSyncState[] | SyncSummary> {
    if (symbol === undefined) return this.getSummary();
    return this.requireState(symbol);
  }

  async getSummary(): Promise<SyncSummary> {
    return getSummary(this.ctx);
  }

  /** 缺口清单：缺口不得静默存在，控制面必须能看到待回补的量（R-11.11）。 */
  async getGaps(symbol?: string): Promise<GapRecord[]> {
    return getGaps(this.ctx, symbol);
  }

  // -------------------------------------------------------------- 调度器

  /** 该标的是否可以参与本轮调度。导出供 daemon 与测试共用。 */
  isSchedulable(symbol: string, nowMs: number): boolean {
    const slot = this.slot(symbol);
    if (slot.inflight) return false;
    if (slot.backoffUntil !== null && slot.backoffUntil > nowMs) return false;
    return true;
  }

  markInflight(symbol: string, inflight: boolean): void {
    this.slot(symbol).inflight = inflight;
  }

  /**
   * 从持久化状态恢复运行时槽位（R-19.4 / R-21.2）。
   * 调度判断只看内存槽位，因此重启后必须把 `backoff_until` 与 `error_count` 灌回来，
   * 否则退避中的标的会被立刻重新调度、连续失败阈值也被清零。
   */
  restoreRuntimeSlot(
    symbol: string,
    values: { backoffUntil: number | null; consecutiveErrors: number },
  ): void {
    const slot = this.slot(symbol);
    slot.backoffUntil = values.backoffUntil;
    slot.consecutiveErrors = values.consecutiveErrors;
  }

  /**
   * 执行一轮同步。**单标的失败绝不抛出**——调用方（daemon）必须继续处理其它标的（R-21.1）。
   * 返回 null 表示成功，非 null 是结构化错误。
   */
  async runOnce(symbol: string, nowMs: number = Date.now()): Promise<SyncError | null> {
    const slot = this.slot(symbol);
    if (slot.inflight) return null; // 同一标的同时只允许一个任务（R-3.3）
    slot.inflight = true;
    try {
      // 本轮开始时控制面的意图。一轮首次全量可以跑好几分钟，期间完全可能 pause / removeSymbol；
      // 没有这份快照就分不清「一直想跑」与「中途被叫停」（R-17.3 / AC-16）。
      //
      // **必须在 try 之内**：这一步会查库，查库失败（PG 抖动）若发生在 try 之外，
      // `finally` 就不会执行——inflight 永久为 true（该标的此后永不被调度，
      // 还永久占着一个并发名额），异常还会逃出 runOnce 把整个守护进程带走
      //（R-14.4「单标的失败不得终止进程」/ R-21.1）。
      const wantedAtStart = await this.stillWanted(symbol);
      await setSyncStatus(this.ctx.pool, this.exchange, symbol, {
        lastRunAt: nowMs,
        status: 'running',
      });
      await this.syncFn(symbol);
      slot.consecutiveErrors = 0;
      slot.backoffUntil = null;
      // 收尾时若意图在本轮内被改掉（pause 或移出集合），就写 paused。
      // 无条件写 running 会把暂停状态盖掉，造成「desired_state=paused 但 status=running」。
      const wantedNow = await this.stillWanted(symbol);
      await setSyncStatus(this.ctx.pool, this.exchange, symbol, {
        status: wantedAtStart && !wantedNow ? 'paused' : 'running',
        lastError: null,
        errorCount: 0,
        backoffUntil: null,
        lastSuccessAt: Date.now(),
      });
      return null;
    } catch (error) {
      return await this.handleFailure(symbol, error, nowMs);
    } finally {
      slot.inflight = false;
    }
  }

  /**
   * 该标的此刻是否仍「在集合内且期望 running」。
   * 只用于**收尾**判断：一轮首次全量可以跑好几分钟，期间运维完全可能 pause 或 removeSymbol，
   * 无条件写回 running 会把暂停状态盖掉，造成「desired_state=paused 但 status=running」的
   * 自相矛盾（R-17.3 / AC-16）。
   */
  private async stillWanted(symbol: string): Promise<boolean> {
    const entries = await this.listSymbols();
    return entries.some((entry) => entry.symbol === symbol && entry.desiredState === 'running');
  }

  /**
   * 失败分类与退避（R-21）。区分「可重试」与「需人工介入」是这段代码的全部意义。
   *
   * 状态写库是**同步等待**的：`runOnce` 返回时状态必须已经落库，
   * 否则控制面读到的会是上一轮的陈旧状态，「状态可查」（R-19）就不成立。
   */
  private async handleFailure(symbol: string, error: unknown, nowMs: number): Promise<SyncError> {
    const syncError =
      error instanceof SyncError
        ? error
        : new SyncError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error));

    const slot = this.slot(symbol);
    slot.consecutiveErrors += 1;

    // PG 连接失败不消耗交易所配额，但需要退避重试（R-21.6）。
    // 「有限重试」同样适用于这一支：持续死锁的标的不能以最长 5 分钟的退避永远重试，
    // 那正是 R-21.6 要避免的形态——到阈值就进 error，停下等人工介入（R-21.3）。
    if (RECOVERABLE_PG_CODES.has(syncError.code)) {
      if (slot.consecutiveErrors >= this.config.sync.maxConsecutiveErrors) {
        slot.backoffUntil = null;
        await this.writeStatusSafely(symbol, {
          status: 'error',
          lastError: syncError.message,
          errorCount: slot.consecutiveErrors,
          backoffUntil: null,
        });
        return syncError;
      }
      const delay = this.backoffDelay(slot.consecutiveErrors);
      slot.backoffUntil = nowMs + delay;
      await this.writeStatusSafely(symbol, {
        lastError: syncError.message,
        errorCount: slot.consecutiveErrors,
        backoffUntil: slot.backoffUntil,
      });
      return syncError;
    }

    // 需人工介入 / 其它错误：达到阈值即进 error 并停止自动重试（R-21.3 / R-21.5）。
    const exhausted = MANUAL_INTERVENTION_CODES.has(syncError.code);
    if (exhausted || slot.consecutiveErrors >= this.config.sync.maxConsecutiveErrors) {
      slot.backoffUntil = null;
      await this.writeStatusSafely(symbol, {
        status: 'error',
        lastError: syncError.message,
        errorCount: slot.consecutiveErrors,
        backoffUntil: null,
      });
      return syncError;
    }

    const delay = this.backoffDelay(slot.consecutiveErrors);
    slot.backoffUntil = nowMs + delay;
    await this.writeStatusSafely(symbol, {
      lastError: syncError.message,
      errorCount: slot.consecutiveErrors,
      backoffUntil: slot.backoffUntil,
    });
    return syncError;
  }

  /**
   * 写失败状态，**永不抛出**。
   *
   * 原因：handleFailure 是 runOnce 的收尾路径，而 runOnce 向 daemon 承诺
   * 「单标的失败绝不抛出」（R-21.1）。如果这里再抛（比如 PG 恰好也挂了），
   * 异常会从 runOnce 逃到 worker → `Promise.all` → `tick()` → `loop()`，
   * 最终以 unhandled rejection 直接杀掉守护进程——单标的的状态写失败
   * 不该有这种后果。写不进去就记录，状态由下一轮或控制面修正。
   */
  private async writeStatusSafely(
    symbol: string,
    patch: Parameters<typeof setSyncStatus>[3],
  ): Promise<void> {
    try {
      await setSyncStatus(this.ctx.pool, this.exchange, symbol, patch);
    } catch (error) {
      log.error(
        `${symbol} 同步状态写库失败（本轮已按失败处理，状态待下一轮修正）：` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 指数退避 + 上限（R-21.2）。 */
  backoffDelay(consecutiveErrors: number): number {
    const { backoffBaseMs, backoffMaxMs } = this.config.sync;
    const raw = backoffBaseMs * 2 ** Math.max(0, consecutiveErrors - 1);
    return Math.min(backoffMaxMs, raw);
  }

  /** 全部标的的运行时槽位快照，测试用。 */
  slotsSnapshot(): Record<string, RuntimeSlot> {
    const out: Record<string, RuntimeSlot> = {};
    for (const [symbol, slot] of this.slots) out[symbol] = { ...slot };
    return out;
  }

  /** 全部状态（含没有 sync_state 但在集合里的标的），供 `getStatus()` 汇总使用。 */
  async allStates(): Promise<SymbolSyncState[]> {
    return getAllStates(this.ctx);
  }
}
