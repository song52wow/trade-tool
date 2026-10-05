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
  SyncPlanEstimate,
  SyncSummary,
  SymbolSyncState,
} from '@trade-tool/core';
import type { SchemaStatus } from '@trade-tool/data';

export type LifecycleAction = 'start' | 'pause' | 'resume';
export type JobKind = 'full' | 'verify';
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
}

/**
 * 一根 1m K 线（控制面 K 线图用，R-23）。
 *
 * 时间沿用 Bar 契约的**毫秒时间戳**（跨语言契约就是 schema，列是 bigint 毫秒），不在
 * DTO 层转成 ISO 字符串：图上要按时间算坐标、算缺口，转字符串就得多解析一次。epoch
 * 毫秒远小于 2^53，JSON number 往返无损。
 *
 * 只带画图必需的六列：`quote_volume` / `trades` 在本视图里没有用途，带上只是让每次
 * 首屏响应更大；它们仍在 `klines_1m` 里，随时可查。
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
  limit: number;
  items: BarDto[];
}

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
