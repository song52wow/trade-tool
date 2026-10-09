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
import type { IndicatorInterval } from '@trade-tool/data';

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

// ---------------------------------------------------------------- 技术指标（v0.3.0）

/**
 * 一个「已物化的参数集」（R-10.1）。
 *
 * `params` 的键是**数据库列名**（`window` 记作 `bars`，因为 `window` 是 PG 保留字），
 * 因此页面可以直接把它渲染成图例，不需要前端再维护一张「指标 → 参数名」的映射表——
 * 多一份映射就多一处会漂移的地方。
 */
export interface IndicatorSpecDto {
  indicator: string;
  params: Record<string, number | string>;
  /** 该参数集实际生效的实现版本（R-9.3「回传生效值」） */
  implVersion: number;
  /** 该参数集已物化的行数 */
  rows: number;
}

/** 一行指标。`values` 的键与该指标的值列一致（`value` / `dif,dea,hist` / …）。 */
export interface IndicatorRowDto {
  time: number;
  values: Record<string, number>;
}

/** 一条指标线。缺口处**行缺失**，因此线在图上必须断开（R-10.4）。 */
export interface IndicatorSeriesDto {
  spec: IndicatorSpecDto;
  /** 服务端给的稳定标签，如 `MA(window=20)`、`MACD(fast=12, slow=26, signal=9)` */
  label: string;
  rows: IndicatorRowDto[];
}

/** `/indicators` 的回包。 */
export interface IndicatorsDto {
  symbol: string;
  interval: IndicatorInterval;
  /** 桶宽（毫秒）。页面用它把「指标比 K 线短」换算成根数——**不能写死 60_000**。 */
  intervalMs: number;
  limit: number;
  /** **实际生效**的实现版本；库里一个参数集都没物化时为 null */
  implVersion: number | null;
  specs: IndicatorSeriesDto[];
  /**
   * 指标序列比 K 线短是**正常**的（R-2.4）：少的正是预热期与未收盘的最后一根。
   * `shortBy` 把它量化写明，否则用户会以为哪里丢了数据。
   */
  shortBy: {
    bars: number;
    reason: 'warmup' | 'not-closed' | 'mixed' | null;
  };
  /** 未物化 / 未启用时的说明与物化命令（R-10.4：空状态要给原因与下一步） */
  state: 'ok' | 'not-materialized' | 'disabled';
  message: string | null;
  materializeCommand: string | null;
}

// ---------------------------------------------------------------- 止盈止损（v0.4.0）

/**
 * 一笔止盈止损的状态（五态，不是布尔）。
 *
 * 五态各有各的处置方式，合成「有没有问题」会把最要紧的那种盖掉：
 *   * `armed`       两张单都挂上了，仓位由交易所接管；
 *   * `take_profit` 止盈成交（另一张由交易所自动撤销）；
 *   * `stop_loss`   止损成交；
 *   * `cancelled`   仓位已平，两张单随之作废；
 *   * `failed`      **占坑成功但下单没成功**——`lastError` 常驻可见。
 *
 * 单独列出 `failed` 是因为它最容易出事故：库里有一条 `failed` 就意味着这次买入成交
 * 的保护单没挂上，而仓位是真实存在的（v0.4.0 规则 3 / 5）。
 */
export type BracketStateDto = 'armed' | 'take_profit' | 'stop_loss' | 'cancelled' | 'failed';

/**
 * 一条止盈止损记录（`risk_bracket` 表的一行）。
 *
 * `tpOrderId` / `slOrderId` 可为 null：**两张单要么都挂上要么都不挂**（v0.4.0 规则 5），
 * 所以出现「有止盈单号、无止损单号」本身就是一条 `failed` 记录，页面要把这种不完整
 * 如实显示成异常，而不是把 null 悄悄渲染成「—」当作正常。
 */
export interface BracketDto {
  /** 幂等锚点：同一笔买入成交只处理一次（v0.4.0 规则 4）。 */
  entryOrderId: string;
  exchange: string;
  symbol: string;
  entryPrice: number;
  entryTime: number;
  filledQty: number;
  positionSide: string;
  /** 计算止损用的 ATR 值。atr = 0 是非法的（止损会正好落在入场价上），页面要能看出异常。 */
  atr: number;
  atrPeriod: number;
  atrInterval: string;
  /** ATR 取数窗口的毫秒时间戳区间——已收盘 bar 的尾段（v0.4.0 规则 1 / 2）。 */
  atrWindowFrom: number;
  atrWindowTo: number;
  stopPrice: number;
  takeProfit: number;
  tpOrderId: number | null;
  slOrderId: number | null;
  state: BracketStateDto;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

/** `/brackets` 的回包。`limit` 是**实际生效**的上限，页面据此说明是否被截断。 */
export interface BracketsDto {
  symbol: string;
  limit: number;
  items: BracketDto[];
  /**
   * 五态计数（含未显示的那些行）。**不等于** `items.length`：
   * `items` 只带最近 N 条，而 `failed` 可能在更早的记录里被淹掉。
   * 页面用它决定要不要显式提醒，而不是从当前列表里数——「这条没显示但有失败单」
   * 正是最不该被漏掉的情况。
   */
  countsByState: Record<BracketStateDto, number>;
}

// ------------------------------------------------- 交易所凭据与止盈止损策略（v0.5.0）

/**
 * 凭据状态（v0.5.0）。
 *
 * **这个形状里没有 secret，也没有密文**，而且是刻意的：控制面从设计上就没有能力
 * 把密钥显示出来。一旦存在一条能回显明文的读取路径，任何一次 XSS、误开的日志、
 * 一张截图就都成了凭据泄露，而「配没配 + 末 4 位」已经足够让人确认状态。
 */
export interface CredentialStatusDto {
  exchange: string;
  configured: boolean;
  /** api_key 末 4 位，纯展示用，不是机密。 */
  hint: string | null;
  updatedAt: number | null;
  /** 主密钥是否已注入环境变量。没注入时页面必须**明确说不能保存**，而不是存完失败。 */
  masterKeyReady: boolean;
}

export interface CredentialWriteBody {
  apiKey: string;
  apiSecret: string;
}

/** 止盈止损策略的**作用域**。`global` 是默认，`symbol` 是单标的覆盖。 */
export type RiskPolicyScopeDto = 'global' | 'symbol';

export interface RiskPolicyDto {
  atrPeriod: number;
  atrInterval: string;
  stopAtrMult: number;
  takeProfitAtrMult: number;
}

export interface RiskPolicyEntryDto extends RiskPolicyDto {
  scope: RiskPolicyScopeDto;
  exchange: string;
  /** `global` 行为空串——schema 的 CHECK 强制了这一点，页面不用再猜。 */
  symbol: string;
  updatedAt: number;
}

/**
 * `/api/settings/risk-policy` 的回包。
 *
 * `resolved` 是该标的**最终会生效**的那一套，来源三选一。
 * 页面直接显示 `source`：库里有标的覆盖却在看全局配置，差异必须一眼可见。
 */
export interface RiskPolicyViewDto {
  exchange: string;
  global: RiskPolicyEntryDto | null;
  overrides: RiskPolicyEntryDto[];
  resolved: RiskPolicyDto & { source: 'symbol' | 'global' | 'config' };
}

export interface RiskPolicyWriteBody {
  scope: RiskPolicyScopeDto;
  symbol?: string;
  atrPeriod: number;
  atrInterval: string;
  stopAtrMult: number;
  takeProfitAtrMult: number;
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
