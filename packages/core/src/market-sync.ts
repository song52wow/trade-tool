/**
 * v0.1.0 行情同步的领域类型。
 *
 * 本文件是 TS 侧的类型契约；**数据库 schema 是跨语言契约的唯一来源**
 * （见 `packages/data/sql/`，需求 R-2.3 / R-2.5）。这里只描述应用层概念。
 *
 * 全部时间字段统一为 **epoch 毫秒（bigint → number）**，与仓库既有 Bar 契约一致，
 * 不使用 Date/timestamptz，避免时区问题。
 */

/** 1m 周期长度（毫秒）。本需求周期固定 1m，不提供 interval 配置项（R-6）。 */
export const ONE_MINUTE_MS = 60_000;

/** 单标的同步状态机：`paused` ↔ `running` → `error`（R-17.1）。 */
export type SyncStatus = 'paused' | 'running' | 'error';

/** 控制面期望状态（`symbols.desired_state`）。error 不在其中，靠显式 resume 恢复（R-21.3）。 */
export type DesiredState = 'paused' | 'running';

/**
 * 写入策略由**请求起点**决定（R-9.3），这是「更早的历史不可被改写」的关键规则。
 *   - `upsert`     起点 = max(time) 的增量续传，唯一会覆盖的是最后一根
 *   - `do-nothing` 起点 < max(time) 的区间补数 / 缺口回补，绝不改已有行
 */
export type WriteStrategy = 'upsert' | 'do-nothing';

/** 结构化错误码。错误一律带 code，不允许只返回字符串（R-22.4）。 */
export type SyncErrorCode =
  // 元数据与标的校验（R-7.2）
  | 'SYMBOL_NOT_FOUND'
  | 'NOT_PERPETUAL'
  | 'NOT_TRADING'
  | 'METADATA_FETCH_FAILED'
  // 写入边界与数据完整性（R-9.4 / R-10.3）
  | 'BACKFILL_BOUNDARY_VIOLATION'
  | 'UNCLOSED_BAR_IN_STORE'
  | 'NULL_NOT_ALLOWED'
  | 'WATERMARK_MISMATCH'
  // 缺口（R-11.9）
  | 'GAP_ATTEMPTS_EXHAUSTED'
  // 数据库（R-21.6 / R-1.3）
  | 'DB_CONNECTION_FAILED'
  | 'DB_UNIQUE_VIOLATION'
  | 'DB_TRANSACTION_ROLLBACK'
  | 'DB_DEADLOCK'
  | 'SCHEMA_VERSION_MISMATCH'
  // 配额与网络（R-20 / R-21.4）
  | 'RATE_LIMITED'
  | 'EXCHANGE_RATE_LIMITED'
  | 'EXCHANGE_ERROR'
  | 'NETWORK_ERROR'
  // 单写者（R-3.3）
  | 'SYNC_ALREADY_RUNNING'
  // 配置与兜底
  | 'CONFIG_INVALID'
  | 'INTERNAL_ERROR';

/** 带错误码的异常。跨语言桥接与控制原语都以此为准，不静默降级成字符串。 */
export class SyncError extends Error {
  readonly code: SyncErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: SyncErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(`[${code}] ${message}`);
    this.name = 'SyncError';
    this.code = code;
    this.details = details;
  }

  toJSON(): { code: SyncErrorCode; message: string; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function isSyncError(error: unknown): error is SyncError {
  return error instanceof SyncError;
}

/** 合约元数据快照。本需求只依赖这三个字段（R-7.3），其余仅作快照留存。 */
export interface ContractSpec {
  exchange: string;
  symbol: string;
  /** PERPETUAL / CURRENT_QUARTER / NEXT_QUARTER …，一律运行时解析 */
  contractType: string;
  /** TRADING / HALT / DELIVERING … */
  status: string;
  /** 首次全量拉取的起点（R-8.2），跨标的可差一年以上，严禁硬编码 */
  onboardDate: number;
}

/** 交易所元数据缓存的命中情况（R-7.1）。 */
export interface MetadataCacheInfo {
  /** 缓存写入时间（epoch ms） */
  savedAt: number;
  /** 命中时的缓存年龄（ms） */
  ageMs: number;
  /** TTL 过期且拉取失败而回退到过期缓存时为 true（R-7.1） */
  stale: boolean;
}

/** 一个待回补缺口（R-11.B5）。闭区间 [gapStart, gapEnd] 内的 1m bar 缺失。 */
export interface GapRecord {
  symbol: string;
  gapStart: number;
  gapEnd: number;
  missingRows: number;
  attempts: number;
  lastAttemptAt: number | null;
  lastError: string | null;
}

/** 每标的可持久化、可查询的完整状态（R-19.1）。 */
export interface SymbolSyncState {
  exchange: string;
  symbol: string;
  status: SyncStatus;
  /** 可观测缓存；权威水位始终是 max(time)（R-9.6） */
  watermark: number | null;
  /** 已知连续到的时间点（含），缺口增量检测基线（R-11.A2） */
  verifiedUpTo: number | null;
  rows: number;
  bytes: number;
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  errorCount: number;
  backoffUntil: number | null;
  pendingGaps: number;
  updatedAt: number;
  /** 标的是否仍在集合内（R-18） */
  desiredState: DesiredState | null;
  /** 元数据是否取自过期缓存（R-7.1） */
  metadataStale: boolean;
  /**
   * 首次全量的规模预估（R-8.3），由 `sync status` 暴露给控制面；
   * 首次全量跑完或本来就有历史时为 null。存在时它同时是进度的**分母**（R-8.6）。
   */
  plan: FirstPullPlan | null;
}

/**
 * 首次全量的规模预估（R-8.3 / R-8.6）。
 *
 * `sync_state` 的 plan_* 列（迁移 002）在 TS 侧的映射：常驻模式下新增标的默认 paused，
 * 控制面要先看到「这次全量约多少根 / 多少次请求 / 约多久」才能决定是否开启。
 */
export interface FirstPullPlan {
  /** 目标 bar 数（进度分母） */
  bars: number;
  requests: number;
  weight: number;
  estimatedMs: number;
  /** 预估区间（闭区间，epoch 毫秒） */
  from: number;
  to: number;
  /** 预估计算时刻 */
  computedAt: number;
}

/** 标的集合条目（R-18）。 */
export interface SymbolEntry {
  exchange: string;
  symbol: string;
  desiredState: DesiredState;
  onboardDate: number | null;
  addedAt: number;
  updatedAt: number;
}

/** 移除标的时已入库数据的处置策略（R-18.3）。禁止静默删除，必须显式声明。 */
export type RemovePolicy = 'keep' | 'archive' | 'delete';

/** 全局限速器当前窗口状态（R-20.4）。 */
export interface RateLimitStatus {
  /** 每分钟权重上限（预算，不是交易所硬配额） */
  budgetPerMinute: number;
  windowFrom: number;
  used: number;
  /** 429/418 触发的全局暂停截止时间（R-21.4） */
  pauseUntil: number | null;
  /** used / budget，1 表示已打满 */
  utilization: number;
}

/** 全局汇总（R-19.8）。 */
export interface SyncSummary {
  symbols: number;
  countsByStatus: Record<SyncStatus, number>;
  totalRows: number;
  totalBytes: number;
  pendingGaps: number;
  rateLimit: RateLimitStatus;
}

/** 首次全量的规模预估（R-8.3），执行前必须先算给人看。 */
export interface SyncPlanEstimate {
  symbol: string;
  /** 预计 bar 数 */
  bars: number;
  /** 预计请求数（单次 limit 上限 1500） */
  requests: number;
  /** 预计权重消耗（每次 limit>1000 为 10） */
  weight: number;
  /** 按限速预算折算的预计耗时（毫秒） */
  estimatedMs: number;
  from: number;
  to: number;
}

/** 单次同步的结果摘要。**这是跨语言桥接允许传输的全部内容**（R-2.1）。 */
export interface SyncRunSummary {
  symbol: string;
  /** 本次拉取并写入的 bar 数 */
  added: number;
  from: number | null;
  to: number | null;
  /** 实际采用的写入策略 */
  writeStrategy: WriteStrategy;
  /** 该标的水位推进到的位置 */
  watermark: number | null;
  /** 本次回补掉的缺口数 */
  gapsFilled: number;
  /** 本次发现但未解决的缺口数 */
  gapsPending: number;
  /** 本次因尝试达上限而放弃的缺口数 */
  gapsAbandoned: number;
  requests: number;
  weight: number;
  metadataStale: boolean;
  /** 规模预估；仅首次全量返回 */
  estimate?: SyncPlanEstimate;
}

/** 库内最后一根 bar 的自愈校验结果（R-10.3）。 */
export interface ClosedBarCheck {
  time: number;
  closeTime: number;
  /** closeTime <= now_ms */
  closed: boolean;
}
