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
/**
 * 七个状态（v0.7.0 追加 `partial_armed` / `trailing`）。
 *
 * 页面必须能分开显示它们：`trailing` 表示「第一段已成交、只剩一张止损且在移动」，
 * 而 `armed` 是两张单都在——把这两种显示成同一个「已保护」，页面上就看不出
 * 「止盈已经走了一半」这件要紧事。
 */
export type BracketStateDto =
  'armed' | 'partial_armed' | 'trailing' | 'take_profit' | 'stop_loss' | 'cancelled' | 'failed';

/**
 * 一条止盈止损记录（`risk_bracket` 表的一行）。
 *
 * `tpAlgoId` / `slAlgoId` 可为 null：**两张单要么都挂上要么都不挂**（v0.4.0 规则 5），
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
  tpAlgoId: number | null;
  slAlgoId: number | null;
  /**
   * v0.7.0 第一段与移动止损的档位（NULL = 未进入该阶段）。
   *
   * 页面必须能把 `trailing` 行的「当前那一档」显示出来：只显示 `stopPrice`
   * （入场时的原始止损）会让人以为移动止损根本没动过。
   */
  tp1AlgoId: number | null;
  tp1Price: number | null;
  trailStopPrice: number | null;
  /** 本轮没有移动（或移动失败）的原因。常驻可见，不静默跳过。 */
  trailLastError: string | null;
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

// ------------------------------------------------- 飞书通知设置（v0.8.0）

/**
 * 通知设置状态。**没有明文地址，也没有密文**——与凭据那条线同一套规矩：
 * 控制面从设计上就没有把凭据显示出来的能力。
 */
export interface NotifyStatusDto {
  /** 生效的那一档是否启用推送。 */
  enabled: boolean;
  /** 生效的那一档**要通知哪些内容**（交易对账的差异类型 id）。 */
  kinds: readonly string[];
  repeatCooldownMs: number;
  /** 生效的那一档有没有地址。 */
  configured: boolean;
  /** 地址末 4 位，纯展示用，不是机密。 */
  hint: string | null;
  /** 有没有配签名密钥。 */
  secretConfigured: boolean;
  /** 生效来源：`panel` = 控制面录入；`config` = 配置文件 + 环境变量。 */
  source: 'panel' | 'config';
  /** 生效来源是 `config` 时，地址取自哪个环境变量（排障要看）。 */
  webhookEnv: string;
  secretEnv: string;
  /**
   * **可勾选的内容目录**（服务端下发的唯一来源）。
   *
   * 页面**不自己抄一份**差异类型的清单：抄了就会漂——服务端加了新类型而页面
   * 没跟上，用户就永远勾不到它。
   */
  topics: NotifyKindDto[];
  /**
   * 面板那一档的状态。**无论它是否生效都在这里**——
   * 「面板里配过、但当前生效的是配置文件那一档」必须看得见。
   */
  panel: {
    configured: boolean;
    hint: string | null;
    enabled: boolean;
    kinds: readonly string[];
    repeatCooldownMs: number;
    updatedAt: number | null;
    /** `null` = 读不到（主密钥没注入，解不开密文）——不是「没配」。 */
    secretConfigured: boolean | null;
  } | null;
  updatedAt: number | null;
  /** 主密钥是否已注入环境变量。没注入时页面必须**明确说不能保存**，而不是存完失败。 */
  masterKeyReady: boolean;
}

/**
 * 一项「要通知的内容」。
 *
 * `kind` 是交易对账的差异类型（机器值，落库用）；`label` / `hint` 是给人看的
 * 文案——**由服务端下发**，页面不自己抄一份（抄一份就会漂）。
 */
export interface NotifyKindDto {
  kind: string;
  label: string;
  hint: string;
}

export interface NotifyWriteBody {
  enabled: boolean;
  /** 空 = 保持原样（第一次保存时必填）。 */
  webhookUrl: string;
  /** 空 = 保持原样。 */
  secret?: string;
  /** 显式清除签名密钥。 */
  clearSecret?: boolean;
  /** 要通知哪些内容。空数组 = 一样都不推。 */
  kinds: string[];
  repeatCooldownMs: number;
}

/** 止盈止损策略的**作用域**。`global` 是默认，`symbol` 是单标的覆盖。 */
export type RiskPolicyScopeDto = 'global' | 'symbol';

export interface RiskPolicyDto {
  atrPeriod: number;
  atrInterval: string;
  stopAtrMult: number;
  /**
   * 止盈倍数。**两种形态都用它**（v0.9.1 起只有这一个止盈倍数）：
   * 不分批时是全平目标，分批时是先兑现那一段的目标。
   */
  takeProfitAtrMult: number;
  /**
   * 第一段减仓的**百分数**（v0.7.0），`0`–`100`。库里存的是 `[0, 1]` 的比例，
   * 换算只在服务端用 `@trade-tool/core` 的 `percentToRatio` / `ratioToPercent`
   * ——**浏览器端不引 core**（它带 node 内置模块，打包进 UI 会炸），
   * 也不在前端自己 `÷ 100` 了事再让后端与库各存一份口径。
   *
   * `100` 与 `0` 逐字等价（都是一次全平），服务端会归一到 `0`。
   */
  takeProfit1Percent: number;
  trailAtrMult: number;
  breakevenAfterTp1: boolean;
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
  takeProfit1Percent: number;
  trailAtrMult: number;
  breakevenAfterTp1: boolean;
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

// ------------------------------------------------- 交易对账（v0.6.0）

/**
 * 对账结果的形状直接用 core 判据的那一份，**不另立 DTO**。
 *
 * 判据是纯函数、报告是它的输出，两侧共用一个类型就意味着控制面不可能「显示的差异」
 * 与 CLI「报出的差异」在字段上分叉——那正是两份口径必然漂移的地方。
 */
export type {
  ExchangeAlgoOrder,
  ExchangePosition,
  ReconcileDifference,
  ReconcileKind,
  ReconcileReport,
  ReconcileSeverity,
} from '@trade-tool/core';

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

// ------------------------------------------------- 分析师 / 交易员 Agent（v1.0.0）

/** 分析师报告里的一个面。 */
export interface AgentFacetDto {
  /** `-1`（极空）… `+1`（极多）。 */
  score: number;
  /** 支撑这个分数的理由。 */
  notes: string[];
}

/**
 * 分析师报告（v1.0.0）。
 *
 * `stance` / `confidence` 是**程序合成**的结果（`aggregateAnalystReport`），
 * 不是模型直接给的——页面上显示的立场与库里存的、CLI 打的是同一个值。
 */
export interface AgentReportDto {
  id: string;
  symbol: string;
  interval: string;
  /** 数据的时刻（epoch ms）。 */
  asOfMs: number;
  /** 报告生成的时刻（epoch ms）。 */
  createdAtMs: number;
  stance: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  /** 加权综合分，`[-1, 1]`。 */
  bias: number;
  /** 三个面之间的一致性 `[0, 1]`。 */
  agreement: number;
  technical: AgentFacetDto;
  sentiment: AgentFacetDto;
  fundamental: AgentFacetDto;
  atr: number | null;
  lastClose: number | null;
  rationale: string;
  /** 情绪面有接口没取到——这一轮的情绪面分数仅供参考。 */
  degraded: boolean;
}

/**
 * 交易员执行方案（v1.0.0）。
 *
 * 价格与数量**不是模型给的**：模型只给比例，它们由 `deriveExecutionPlan` 算出来，
 * 因此这里的每个价都与「真正挂出去的那张单」逐字一致。
 */
export interface TradingPlanDto {
  id: string;
  symbol: string;
  /** 这份方案基于哪份分析师报告。报告按数据时刻 upsert（id 不变），方案每轮新建。 */
  reportId: string | null;
  createdAtMs: number;
  /** `enter` = 有可执行方案；`hold` = 这一轮不做；`failed` = 出不了方案。 */
  action: 'enter' | 'hold' | 'failed';
  status: 'advisory' | 'approved' | 'executed' | 'rejected' | 'expired';
  side: 'BUY' | 'SELL' | null;
  entryType: 'market' | 'limit' | null;
  entryPrice: number | null;
  stopPrice: number | null;
  takeProfitPrice: number | null;
  quantity: number | null;
  notional: number | null;
  riskAmount: number | null;
  equity: number | null;
  equitySource: 'exchange' | 'config' | null;
  riskFraction: number | null;
  riskReward: number | null;
  stance: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  rationale: string;
  /** 为了合规而做的调整（风险被夹住、止盈被抬高、量被缩小…）。 */
  adjustments: string[];
  /** 出不了方案的原因。 */
  failureReason: string | null;
}

/** `/agent` 的回包。`report` / `plan` 各自可能为 `null`（还没分析过）。 */
export interface AgentViewDto {
  symbol: string;
  report: AgentReportDto | null;
  plan: TradingPlanDto | null;
}
