/**
 * 控制面 DTO —— 前后端唯一的形状契约。
 *
 * 这里的类型是 `import type`，编译后被完全擦除，因此 `ui/` 可以直接从
 * `../src/types.js` 引用而不会把服务端代码拖进前端产物，也不需要重复一份声明。
 */
import type {
  ChainApy,
  ChainPositionLinks,
  ContractSpec,
  DesiredState,
  GapRecord,
  ReconcileDifference,
  ReconcileReport,
  RemovePolicy,
  StoredInterval,
  SyncPlanEstimate,
  SyncSummary,
  SymbolSyncState,
} from '@trade-tool/core';
import type {
  BracketRecord,
  BracketState,
  ExecutorStatusView,
  NotifyStatus,
  SchemaStatus,
} from '@trade-tool/data';

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
  /** 缺口清单（最多 200 条；**总数在 `gapsTotal`**）。 */
  gaps: GapRecord[];
  /** 该标的的缺口**总数**。列表被截断时页面必须能说出「还有多少条没显示」。 */
  gapsTotal: number;
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
/**
 * 止盈止损记录与状态：**形状归 `packages/data` 所有**，这里只转发。
 *
 * 原来这份 DTO 是手抄的（还把 `positionSide` 放宽成了 `string`），后果是
 * `BracketRecord` 加一列时页面不会报错——类型看着对，运行时字段却少一个。
 * 手抄一份就等于给自己留了一条静默漂移的路。
 */
export type BracketStateDto = BracketState;
export type BracketDto = BracketRecord;

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
export type NotifyStatusDto = NotifyStatus & {
  /**
   * **可勾选的内容目录**（服务端下发的唯一来源）。
   *
   * 页面**不自己抄一份**差异类型的清单：抄了就会漂——服务端加了新类型而页面
   * 没跟上，用户就永远勾不到它。
   */
  topics: NotifyKindDto[];
  /** 主密钥是否已注入环境变量。没注入时页面必须**明确说不能保存**，而不是存完失败。 */
  masterKeyReady: boolean;
};

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

/**
 * 模型接入设置的**写入体**。
 *
 * 密钥直接填在这里：它会**密文落库**，不会出现在配置文件、argv 或日志里
 * （与通知 webhook 同一套做法，AGENTS.md 约定 2）。
 */
export interface AgentLlmWriteBody {
  enabled: boolean;
  /** 空 = 保持原样（第一次保存时必填）。 */
  baseUrl: string;
  /** 空 = 保持原样（第一次保存时必填）。 */
  model: string;
  /** 空 = 保持原样。 */
  apiKey?: string;
  /** 显式清除密钥。 */
  clearApiKey?: boolean;
  timeoutMs: number;
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

/**
 * 止盈止损服务（executor）的状态（2026-11-06）。
 *
 * **两个正交维度**：进程在不在（`state`）、私有接口通不通（`privateApiOk`）。
 * 合成一个「在线」会骗人：私有接口全挂时心跳照跳，页面显示「在线」，
 * 而它一单都挂不出去——2026-10-31 到 11-06 那 6 天静默就是这么来的。
 */
export type ExecutorStatusDto = ExecutorStatusView;

export interface OverviewDto {
  schema: SchemaStatus;
  summary: SyncSummary;
  exchange: ExchangeOverviewDto;
  daemon: DaemonStatusDto;
  executor: ExecutorStatusDto;
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

/**
 * 一条差异 + **服务端下发的文案**。
 *
 * 页面原来自己有一份 `KIND_LABEL`（AGENTS §7 第 6 条登记的已知漂移）：
 * 同一个差异类型在两个地方各起一句中文，改一处另一处不知道。
 * 现在文案的唯一来源是 core 的 `RECONCILE_KIND_INFO`，由服务端随 DTO 带下来——
 * 与通知内容目录（`topics`）同一个做法：**页面不抄判据侧的词表**。
 */
export type ReconcileDifferenceDto = ReconcileDifference & {
  label: string;
  hint: string;
};

export type ReconcileReportDto = Omit<ReconcileReport, 'differences'> & {
  differences: ReconcileDifferenceDto[];
};

/**
 * 手动补挂止盈止损的结果（v1.3.0）。
 *
 * 它是**一次人工干预**的回执：每一笔都有说法（补了什么、为什么、挂没挂上），
 * 没有「无声跳过」这一档。
 */
export interface ReattachDto {
  symbol: string;
  /** 真的挂上了几笔。 */
  placed: number;
  /** 这一轮是演练（只算不挂）。 */
  dryRun: boolean;
  details: {
    kind: string;
    symbol: string;
    /** 本地记录的入场单号；`null` = 本地没有记录（裸仓），补挂时新建了一条。 */
    entryOrderId: string | null;
    outcome: 'placed' | 'dry-run' | 'skipped' | 'failed';
    reason: string;
    tpAlgoId?: number;
    slAlgoId?: number;
  }[];
  /** 不补挂但要让人知道的事。 */
  skips: { symbol: string; entryOrderId: string | null; reason: string }[];
  /**
   * 拒绝补挂的原因。`null` = 没有拒绝。
   *
   * 「拒绝」与「不需要补挂」是两回事：前者是**该补但不敢补**
   * （比如交易所的仓位数量与本地记录对不上，照记录补可能重复减仓），
   * 它必须在页面上显眼地显示出来（约定 9）。
   */
  refusal: string | null;
  /** 补记了「第一段止盈已成交」这个事实时的人话说明。`null` = 没有补记。 */
  tp1FillRecorded: string | null;
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
 * 模型接入的运行期设置（v1.0.0）。
 *
 * **没有明文密钥**：控制面从设计上就没有回显它的能力。
 * 密钥密文落库（与通知 webhook 同一套加密），页面只看得到「配没配」与末 4 位。
 */
export interface AgentLlmStatusDto {
  /** 生效的那一档是否启用模型。 */
  enabled: boolean;
  /** 生效的那一档的 API 基址。 */
  baseUrl: string;
  /** 生效的那一档的模型名。 */
  model: string;
  /** 生效的那一档的单次调用超时（毫秒）。 */
  timeoutMs: number;
  /** 生效来源：`panel` = 控制面录入；`config` = 配置文件 + 环境变量。 */
  source: 'panel' | 'config';
  /** 生效来源是 `config` 时，密钥取自哪个环境变量（排障要看）。 */
  apiKeyEnv: string;
  /**
   * 生效来源是 `config` 时，那个环境变量里的密钥**读到了没有**。
   *
   * `false` = 环境变量里没有密钥——这是最常见的配置错误，
   * 页面要显示出来（并说清去补哪个变量），而不是笼统的「设置操作失败」。
   */
  configKeyAvailable: boolean;
  /**
   * 面板那一档的状态。**无论它是否生效都在这里**——
   * 「面板里配过、但当前生效的是配置文件那一档」必须看得见。
   */
  panel: {
    configured: boolean;
    /** 密钥末 4 位，纯展示用，不是机密。 */
    hint: string | null;
    enabled: boolean;
    baseUrl: string | null;
    model: string | null;
    timeoutMs: number | null;
    updatedAt: number | null;
    /**
     * 有没有配密钥。
     *
     * `null` = **读不到**（主密钥没注入，解不开密文）。这时候必须说「不知道」，
     * 而不能说「没配」——后者是猜测，而页面会照着它显示。
     */
    keyConfigured: boolean | null;
  } | null;
  /** 生效的那一档最后一次写入的时刻。 */
  updatedAt: number | null;
  /** 主密钥是否可用（没注入时控制面录入的那一份读不到、也写不了）。 */
  masterKeyReady: boolean;
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
  /**
   * 方案的生命周期。
   *
   * `executing` = **已认领、正在下单**；`failed` = 下单失败。
   * 这两个态必须显示出来：`executing` 说明「那一单到底下没下还不知道」，
   * `failed` 说明「仓位没有建立、止损也没有挂」。
   */
  status: 'advisory' | 'approved' | 'executing' | 'executed' | 'rejected' | 'expired' | 'failed';
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
  /** 变成真实订单之后的交易所单号。 */
  entryOrderId: string | null;
  /** 下单失败的原因（`status = 'failed'` 时有值）。 */
  executionFailureReason: string | null;
  /**
   * 这份方案**能不能批准**。
   *
   * 判据在 `packages/core/src/agent-plan.ts`（`autoExecutableProblem`），
   * **由服务端算好传过来**：页面不自己判，也不 import core——
   * core 的 barrel 里带着 `node:crypto` / `node:fs`，浏览器构建会直接失败，
   * 而且在页面里再写一遍判据就是**第二份实现**（§5 第 5 条）。
   */
  approvable: boolean;
  /** 不能批准的原因（能批准时为 `null`）。页面上要原样显示，别自己复述。 */
  approvableReason: string | null;
}

/** `/agent` 的回包。`report` / `plan` 各自可能为 `null`（还没分析过）。 */
export interface AgentViewDto {
  symbol: string;
  report: AgentReportDto | null;
  plan: TradingPlanDto | null;
}

// ------------------------------------------------- 链上仓位（v1.2.0）

/**
 * 一笔链上流动性仓位在控制面上的**当前**状态。
 *
 * 来源是 `chain_position` 那一行 LEFT JOIN 出来的**最近一次采样**：
 * 链上事实由 `apps/chain-monitor` 读链后落库，控制面只读本地表，
 * 因此这条接口可以挂在页面的刷新节奏上（纯读，不出网）。
 *
 * ## 为什么这些字段可以是 `null`
 *
 * 「还没采过样」是**正常状态**（仓位刚登记、monitor 还没跑第一轮），
 * 与「采到了但价格是 0」完全不是一回事。因此凡是来自采样的数字都允许为
 * `null`，页面显示成「—」。把它们兜成 0 就是谎报：0 会被当成「这个仓位一文不值」。
 *
 * 代价是页面要处理 null —— 但那是**页面该做的事**，服务端替它编一个数字
 * 只会把「没数据」伪装成「有数据」（AGENTS.md 约定 9：不静默兜底）。
 */
export interface ChainPositionDto {
  /** 链上身份：keccak(仓位管理器, 下界 tick, 上界 tick)。 */
  positionKey: string;
  chain: string;
  /** 两个币的显示符号。库里允许为空（只登记了地址没填符号）。 */
  symbol0: string | null;
  symbol1: string | null;
  /** 仓位 NFT 的 tokenId（十进制字符串）。 */
  tokenId: string;
  /** 仓位持有人地址。 */
  owner: string;
  /** 仓位管理器（PositionManager）合约地址。 */
  positionManager: string;
  /** 池子合约地址。 */
  pool: string;
  /** 区间里 token0 / token1 的合约地址。 */
  token0: string;
  token1: string;
  /**
   * 外部链接（区块浏览器 / 流动性平台）。
   *
   * **服务端算好给页面**：浏览器端不能 import `@trade-tool/core` 的运行时
   * （barrel 带着 node 内置模块，打包会炸），而链接的拼法必须只有一份实现——
   * 页面自己再拼一次，改了域名只改了一边，另一边就成了死链。
   *
   * 链不认识时**全部为 `null`**（不猜域名），页面据此不显示链接。
   */
  links: ChainPositionLinks;
  /**
   * 年化收益率（APY）。
   *
   * 口径在 core 的 `computeChainApy`：**最近 7 天实际收到的手续费** ÷ 投入成本，
   * 按窗口长度年化。算不出来时 `apyPct` 为 `null`，`note` 里说清原因
   * （没采样 / 成本没算出来 / 窗口内手续费被领取过 / 采样不到一天）。
   */
  apy: ChainApy;
  /** 最近一次采样价；还没采过样时为 `null`。 */
  price: number | null;
  /** 区间下界的价格（由下界 tick 换算）。**不依赖采样**，永远有值。 */
  priceLower: number;
  /** 区间上界的价格（由上界 tick 换算）。 */
  priceUpper: number;
  /** 当前价格是否落在区间内；还没采过样时为 `null`（不是 false）。 */
  inRange: boolean | null;
  /** 当前价值（计价币）。 */
  valueUsdt: number | null;
  /** 投入成本（滚动记账；加减仓时随之调整）。 */
  costUsdt: number;
  /** 已实现盈亏（加减仓时结算的那部分）。 */
  realizedUsdt: number;
  /** 浮动盈亏（计价币，含手续费）。 */
  pnlUsdt: number | null;
  /**
   * 浮动盈亏**百分数**（`-0.25` 表示 -0.25%）。
   *
   * ⚠️ 单位是「百分数」而不是「比率」——与 `core` 的口径一致
   * （`computeChainPositionSnapshot` 里乘过 100）。页面直接显示即可，
   * **不要再乘一次 100**。
   */
  pnlPct: number | null;
  /** 累计未领手续费折成计价币后的金额。 */
  feeUsdt: number | null;
  /** 当前持仓构成，**原始单位**（1e18 = 1 个币）的十进制字符串。 */
  amount0: string | null;
  amount1: string | null;
  /**
   * 当前流动性，**链上原始值**的十进制字符串。
   *
   * ⚠️ 它是 Uniswap V3 的 **L 值（Q96 刻度）**，**不是**代币数量——
   * 除以 1e18 会得到一个没有单位的数。页面上原样显示（只加千分位），
   * 用途是让人看出「这笔仓位被加仓 / 减仓了」。
   */
  liquidity: string | null;
  /** 最后一次采样成功/失败的时刻（epoch ms）。 */
  lastPollAt: number | null;
  /** 最后一次**真的推出去**的告警时刻（epoch ms）。 */
  lastAlertAt: number | null;
  /** 最后一次采样的错误原话；成功时为 `null`。 */
  lastError: string | null;
  /** 投入那笔交易的哈希（给人查的）。 */
  depositTx: string | null;
}

/**
 * 一次采样的结果（画曲线与看趋势用）。
 *
 * `ts` 是**毫秒**（仓库约定：时间一律毫秒 bigint，不是 ISO 字符串），
 * 横轴要按时间排布，转字符串就得多解析一次。
 */
export interface ChainSnapshotDto {
  ts: number;
  /** 区块高度（字符串：它可能超出 `Number.MAX_SAFE_INTEGER`）。 */
  block: string;
  price: number;
  valueUsdt: number;
  pnlUsdt: number;
  /** 百分数（`-0.25` 表示 -0.25%），与 `ChainPositionDto.pnlPct` 同口径。 */
  pnlPct: number;
  feeUsdt: number;
  inRange: boolean;
}
