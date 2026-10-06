/**
 * 控制面 DTO —— 前后端唯一的形状契约。
 *
 * 这里的类型是 `import type`，编译后被完全擦除，因此 `ui/` 可以直接从
 * `../src/types.js` 引用而不会把服务端代码拖进前端产物，也不需要重复一份声明。
 */
import type {
  ContractSpec,
  DesiredState,
  GapRecord,
  RemovePolicy,
  StoredInterval,
  SyncPlanEstimate,
  SyncSummary,
  SymbolSyncState,
} from '@trade-tool/core';
import type { SchemaStatus } from '@trade-tool/data';

export type LifecycleAction = 'start' | 'pause' | 'resume';
/**
 * 作业类型：`full` 一轮同步 / `verify` 全表缺口扫描 / `aggregate` 派生重建。
 *
 * `aggregate` 是 v0.2.0 新增的：重建是**几十分钟量级**的重活儿，同样只登记 id、
 * 立即返回（R-7.6 / R-24.1），不许挂在 HTTP 请求上等。
 */
export type JobKind = 'full' | 'verify' | 'aggregate';
export type JobStatus = 'running' | 'succeeded' | 'failed';

/** 作业进度。目标行数只在有规模预估时存在（`verify` 没有行数目标）。 */
export interface JobProgress {
  rows: number | null;
  target: number | null;
  pendingGaps: number | null;
}

export interface JobError {
  code: string;
  message: string;
}

export interface JobDto {
  id: string;
  kind: JobKind;
  symbol: string;
  status: JobStatus;
  startedAt: number;
  finishedAt: number | null;
  progress: JobProgress;
  result: Record<string, unknown> | null;
  error: JobError | null;
}

/** 单个标的的数据覆盖时间线：用于一眼看出「历史起点 / 已验证到哪里 / 水位在哪」。 */
export interface CoverageDto {
  onboardDate: number | null;
  earliest: number | null;
  watermark: number | null;
  verifiedUpTo: number | null;
  now: number;
}

/** 标的列表的一行。
 *
 * 关键：列表取的是 **`symbols` 集合与 `sync_state` 的并集**，与 `readGlobalSummary`
 * 的口径一致。只列 `symbols` 会让「用 `data fetch` 写过数据、但没进集合」的标的
 * 带着几十万行数据从控制面上消失——`inCollection: false` 就是这种情况，
 * 页面据此提示「未加入集合」，而不是假装它不存在。
 */
export interface SymbolRowDto {
  exchange: string;
  symbol: string;
  /** null = 不在集合里（只有状态与数据，尚未被纳管） */
  desiredState: DesiredState | null;
  inCollection: boolean;
  onboardDate: number | null;
  addedAt: number | null;
  state: SymbolSyncState | null;
  coverage: CoverageDto;
  /** 库里有行即视为已完成过首次全量（R-8.1 的「已存在历史」判据）。 */
  hasHistory: boolean;
}

export interface SymbolDetailDto extends SymbolRowDto {
  contract: ContractSpec | null;
  gaps: GapRecord[];
  estimate: SyncPlanEstimate | null;
  /**
   * 每周期的「已入库桶数 / 被扣留桶数 / 扣留原因」（v0.2.0 R-7.5 / AC-15）。
   *
   * 数字由 SQL 从 1m 推导，库里**没有**扣留表（R-3.5）——页面与写库判据同源，
   * 不会出现「页面说少一根、库里其实有」的分裂。
   */
  derived: Record<string, DerivedIntervalDto>;
}

/**
 * 一根 K 线（控制面 K 线图用，R-23）。
 *
 * 时间沿用 Bar 契约的**毫秒时间戳**（跨语言契约就是 schema，列是 bigint 毫秒），不在
 * DTO 层转成 ISO 字符串：图上要按时间算坐标、算缺口，转字符串就得多解析一次。epoch
 * 毫秒远小于 2^53，JSON number 往返无损。
 *
 * 只带画图必需的六列：`quote_volume` / `trades` 在本视图里没有用途，带上只是让每次
 * 首屏响应更大；它们仍在 `klines_1m` 与派生表里，随时可查。
 *
 * 1m 与派生周期**共用同一个形状**（R-6.3）：控制面切换周期时图表组件不该换一套类型。
 */
export interface BarDto {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** 图表取数结果。`limit` 是**实际生效**的上限，页面据此如实说明是否被截断。 */
export interface BarsDto {
  symbol: string;
  /** 本次回包对应的周期（**实际生效值**）。缺省请求即 `1m`（R-7.1）。 */
  interval: StoredInterval;
  /** 桶宽（毫秒）。页面用它把缺口换算成「几根 / 几段 / 最长连续」（R-7.3）。 */
  intervalMs: number;
  limit: number;
  items: BarDto[];
}

/**
 * 单个派生周期在详情页的展示口径（v0.2.0 R-7.5 / AC-15）。
 *
 * `withheldReason: 'disabled'` 表示**未启用派生**（`aggregateIntervals: []`）——
 * 与「启用了、但这个周期一个桶都没有」必须能在界面上分开说（AC-22 / R-8.4）。
 */
export type DerivedIntervalDto =
  | {
      buckets: number;
      withheldNotClosed: number;
      withheldIncomplete: number;
      missingMinutes: number;
    }
  | { withheldReason: 'disabled' };

/** exchangeInfo 概览；不返回全量列表，避免每次轮询都传几百个标的。 */
export interface ExchangeOverviewDto {
  exchange: string;
  count: number;
  cachedAt: number;
  ageMs: number;
  stale: boolean;
}

export interface ExchangeListDto extends ExchangeOverviewDto {
  symbols: ContractSpec[];
}

/**
 * 常驻守护进程（`apps/sync`）的在线状态。
 *
 * 为什么控制面需要它：「开始同步」只写 `symbols.desired_state`，真正拉数据的是独立
 * 进程。没有这个字段，守护进程没启动时页面仍会把状态显示成「同步中」——一个会骗人的
 * 界面。`state` 三态而非布尔，处置方式不同：
 *   * `running`  在线
 *   * `stale`    心跳超时：进程起过但现在不对劲 → 该查日志
 *   * `stopped`  没有心跳：没起，或已优雅退出 → 该去启动
 */
export interface DaemonStatusDto {
  state: 'running' | 'stale' | 'stopped';
  pid: number | null;
  startedAt: number | null;
  lastBeatAt: number | null;
  ageMs: number | null;
  /** 超过这个毫秒数没心跳即判 stale */
  staleAfterMs: number;
}

export interface OverviewDto {
  schema: SchemaStatus;
  summary: SyncSummary;
  exchange: ExchangeOverviewDto;
  daemon: DaemonStatusDto;
  jobs: { active: number; recent: JobDto[] };
  now: number;
}

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/** 增删标的的请求体。删除必须显式给处置策略，不做隐式删除（R-18.3）。 */
export interface AddSymbolBody {
  symbol: string;
}

export interface RemoveSymbolBody {
  policy: RemovePolicy;
}

export interface StartJobBody {
  /** 首次全量时带上规模预估的目标行数，用于校验用户看没看过确认弹窗。 */
  target: number | null;
}
