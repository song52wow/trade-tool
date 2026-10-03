import {
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
  getAllStates,
  getGaps,
  getState,
  getSummary,
  getSymbolEntries,
  removeSymbolEntry,
  requireContract,
  setDesiredState,
  setSyncStatus,
  syncSymbol,
  upsertSymbolEntry,
  type MarketContext,
} from '@trade-tool/data';

/**
 * 控制原语（R-22）。
 *
 * 这是本期交付给控制面的**边界**：页面与 HTTP API 不在本期（N-7），
 * 但原语必须已经可以被直接 import。因此：
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
  'SYNC_ALREADY_RUNNING',
]);

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
    await setSyncStatus(this.ctx.pool, this.exchange, symbol, {
      status: 'paused',
      lastError: null,
    }).catch(() => null);
    return { symbol, policy, deletedRows: result.deletedRows };
  }

  async listSymbols(): Promise<SymbolEntry[]> {
    return getSymbolEntries(this.ctx);
  }

  // -------------------------------------------------------------- 生命周期

  /** 开启：paused → running。幂等；已 running 则直接返回当前状态（R-17.2）。 */
  async start(symbol: string): Promise<SymbolSyncState> {
    await ensureSyncState(this.ctx.pool, this.exchange, symbol, 'paused');
    await setDesiredState(this.ctx.pool, this.exchange, symbol, 'running');
    // 先落库再生效（R-17.3）：跨进程的控制面立即就能看到 running。
    return this.markRunning(symbol);
  }

  /** 暂停：running → paused。幂等。**不删除任何数据**（R-17.5）。 */
  async pause(symbol: string): Promise<SymbolSyncState> {
    await setDesiredState(this.ctx.pool, this.exchange, symbol, 'paused');
    return this.markPaused(symbol);
  }

  /**
   * 恢复：error/paused → running，清空退避（R-21.3）。
   * 连续失败达上限后进入 error 并**停止自动重试**，只能靠这里显式恢复。
   */
  async resume(symbol: string): Promise<SymbolSyncState> {
    await ensureSyncState(this.ctx.pool, this.exchange, symbol, 'paused');
    await setDesiredState(this.ctx.pool, this.exchange, symbol, 'running');
    const slot = this.slot(symbol);
    slot.backoffUntil = null;
    slot.consecutiveErrors = 0;
    return this.markRunning(symbol);
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
   * 执行一轮同步。**单标的失败绝不抛出**——调用方（daemon）必须继续处理其它标的（R-21.1）。
   * 返回 null 表示成功，非 null 是结构化错误。
   */
  async runOnce(symbol: string, nowMs: number = Date.now()): Promise<SyncError | null> {
    const slot = this.slot(symbol);
    if (slot.inflight) return null; // 同一标的同时只允许一个任务（R-3.3）
    slot.inflight = true;
    try {
      await setSyncStatus(this.ctx.pool, this.exchange, symbol, {
        lastRunAt: nowMs,
        status: 'running',
      });
      await this.syncFn(symbol);
      slot.consecutiveErrors = 0;
      slot.backoffUntil = null;
      await setSyncStatus(this.ctx.pool, this.exchange, symbol, {
        status: 'running',
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
    if (RECOVERABLE_PG_CODES.has(syncError.code)) {
      const delay = this.backoffDelay(slot.consecutiveErrors);
      slot.backoffUntil = nowMs + delay;
      await setSyncStatus(this.ctx.pool, this.exchange, symbol, {
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
      await setSyncStatus(this.ctx.pool, this.exchange, symbol, {
        status: 'error',
        lastError: syncError.message,
        errorCount: slot.consecutiveErrors,
        backoffUntil: null,
      });
      return syncError;
    }

    const delay = this.backoffDelay(slot.consecutiveErrors);
    slot.backoffUntil = nowMs + delay;
    await setSyncStatus(this.ctx.pool, this.exchange, symbol, {
      lastError: syncError.message,
      errorCount: slot.consecutiveErrors,
      backoffUntil: slot.backoffUntil,
    });
    return syncError;
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
