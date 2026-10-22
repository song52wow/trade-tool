import { z } from 'zod';

import { EXCHANGE_ENVIRONMENTS } from './exchange-endpoints.js';
import { llmEndpointSchema, refineLlmEndpoint } from './llm-endpoint.js';
import { NOTIFY_KINDS } from './notify.js';
import { normalizeTakeProfit1Ratio } from './risk-policy.js';
import { INTERVALS } from './types.js';

export const marketSchema = z.object({
  symbol: z.string().min(1),
  /**
   * **回测周期，与行情同步无关。**
   *
   * R-6 要求「周期固定 1m，不提供 `interval` 配置项」。那个约束作用于**行情同步链路**：
   * `data sync` / `data fetch --source binance` / `apps/sync` 全链路不读这个字段，
   * 1m 由 `klines_1m` 表名固化，CLI 也不接受 `--interval`。
   *
   * 之所以保留它：§0.1 明确「本次不动 `packages/backtest`」，而回测
   * （`ma-cross` 等策略）需要按周期取数；删掉它会直接破坏既有回测与 AC-29
   * 「`data fetch --bars 100` 不传新参数行为不变」。因此它只服务于 synthetic 回测链路。
   */
  interval: z.enum(INTERVALS).default('1h'),
  /** 行情来源。`synthetic` 为离线合成（默认，保持既有链路），`binance` 为真实交易所 */
  source: z.enum(['synthetic', 'binance']).default('synthetic'),
  /** 交易所标识，作为 symbols / contract_spec / sync_state 的分区键 */
  exchange: z.string().min(1).default('binance'),
  /** 市场类型：本需求只做 USDⓈ-M 永续（N-2） */
  marketType: z.enum(['usdm']).default('usdm'),
  /** 初始资金 */
  initialCapital: z.number().positive().default(10_000),
  /** 单边手续费率，0.001 = 万一 */
  feeRate: z.number().min(0).max(0.1).default(0.0005),
  /** 滑点，按成交价比例计 */
  slippageRate: z.number().min(0).max(0.1).default(0),
  bars: z.number().int().positive().max(100_000).default(500),
});

export const backtestSchema = z.object({
  strategy: z.string().min(1).default('ma-cross'),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});

export const dataSchema = z.object({
  /** python 侧使用的解释器运行时 */
  python: z.enum(['uv', 'python3']).default('uv'),
  /** 原始数据落盘目录，相对 TRADE_TOOL_HOME */
  rawDir: z.string().default('data/raw'),
  cacheDir: z.string().default('data/cache'),
  /** exchangeInfo 元数据缓存目录，相对 TRADE_TOOL_HOME */
  metaDir: z.string().default('data/meta'),
  /** exchangeInfo 缓存 TTL（毫秒），默认 1 小时（R-7.1） */
  metadataTtlMs: z.number().int().positive().default(3_600_000),
  /** TTL 过期且拉取失败时，是否允许使用过期缓存（R-7.1，默认允许但会 WARN + 标记 metadataStale） */
  allowStaleMetadata: z.boolean().default(true),
  /** 单次 python 子进程超时（毫秒） */
  timeoutMs: z.number().int().positive().default(60_000),
  /** PG 批量写入的批大小（R-3.2），每批一个事务 */
  batchSize: z.number().int().positive().max(100_000).default(5_000),
  /** 缺口自动回补的尝试次数上限（R-11.9），达上限后该标的进 error */
  maxGapAttempts: z.number().int().positive().default(5),
  /**
   * 启用哪些派生周期（v0.2.0 R-9.1）。
   *
   * 只接受 `15m / 1h / 4h / 1d` 的任意子集；**出现 `1m` / `5m` / 其它一律 CONFIG_INVALID**
   * （`1m` 是基础数据不是派生目标，`5m` 本期未实现）。`[]` = **显式关闭派生**——
   * 那是给「聚合故障、但 1m 同步还要继续」准备的开关（R-4.6），不是运行时静默跳过：
   * 关闭状态必须从 `sync status` / 控制面看得见（R-8.4 / AC-22）。
   *
   * 缺省值必须与 `sql/004_klines_agg.sql` 里的表集合一致，由 AC-1 的测试守住。
   *
   * **不提供**「放宽覆盖判据」「写半截桶」这类开关：未收盘、未全覆盖的桶一律不写
   * （R-3），没有例外。
   */
  aggregateIntervals: z.array(z.enum(['15m', '1h', '4h', '1d'])).default(['15m', '1h', '4h', '1d']),
  /**
   * 补齐 / `--rebuild` 的分批大小（v0.2.0 R-5.3），keyset 分页、每批一个事务。
   * 绝不能把整段历史一次聚合：首次全量下 1d 桶虽少，但 15m 桶有几十万，
   * 单事务会把 WAL 与锁持有时间推到不可接受。
   */
  aggregateBatchBars: z.number().int().positive().max(1_000_000).default(20_000),
  /**
   * 启用哪些**指标周期**（v0.3.0 R-9.5）。
   *
   * 只接受 `15m / 1h / 4h / 1d` 的任意子集；**出现 `1m` / `5m` / 其它一律 CONFIG_INVALID**。
   * `1m` 不做指标物化是**容量结论**不是疏漏：单标的 1m 约 320 万行 × 缺省 10 个行集
   * 约 4.3 GB/标的，而四个高周期合计约 386 MB/标的（N-2 / 附录 B.3）。
   * `[]` = **显式关闭指标周期**，状态里会如实显示「未启用指标」。
   *
   * **不提供**「放宽」的开关：想看别的周期请先在派生层加表。
   */
  indicatorIntervals: z.array(z.enum(['15m', '1h', '4h', '1d'])).default(['15m', '1h', '4h', '1d']),
  /**
   * 要物化的「指标 × 参数集」集合（v0.3.0 R-12.1）。
   *
   * **参数是数据不是 schema**：把 `ma` 的窗口 5 改成 30、或加一组 `MACD(8,17,9)`，
   * 都是「插新行、零 DDL」。因此这里刻意允许任意正整数窗口，不做枚举、不做 schema 校验。
   *
   * `kMilli` 是 BOLL 的 k 的**千分之一整数**（`2000` 表示 `k = 2.0`）：浮点参数不得进
   * 主键，否则会有浮点相等性问题（R-3.2）。它是唯一允许 `0` 的参数（`k = 0` 时三轨重合）。
   *
   * **`{}`（全部为空对象）= 显式关闭指标层**——那是合法配置，用于「指标层故障、
   * 但 1m 同步还要继续」。关闭状态必须从 `sync status` 与控制面**看得见**
   * （R-11.4 / AC-23），而不是显示 0 行让人以为「还没算」。
   *
   * **缺省值就是 `{}`（关闭）**：指标物化挂在 1m 的每批写入出口上（R-5.1），一轮
   * 43k 根的首次全量被切成 216 批，同一批指标于是被 `216 × 4 × 7` 重写一遍。实测
   * 指标占单轮同步耗时的 **72%**（`sync-integration` 698s → 301s），而目前**没有任何
   * 消费方读这些表**：止盈止损的 ATR 走 `quant_data.risk` 直接读派生 K 线
   * （`ATR_TABLES` 里没有 `indicator_atr`），回测只消费 `quant_core` 的指标序列。
   * 因此**默认不物化**；要看得显式写出参数集（见 `.env.example` 的注释）。
   *
   * 打开时参数集要与 `sql/005_indicators.sql` 的表集合一致，由 AC-2 的测试守住。
   */
  indicatorSpecs: z
    .object({
      ma: z
        .array(
          z.object({
            kind: z.enum(['sma', 'ema']).default('sma'),
            window: z.number().int().positive(),
          }),
        )
        .default([]),
      macd: z
        .array(
          z.object({
            fast: z.number().int().positive(),
            slow: z.number().int().positive(),
            signal: z.number().int().positive(),
          }),
        )
        .default([]),
      rsi: z.array(z.object({ period: z.number().int().positive() })).default([]),
      boll: z
        .array(
          z.object({ period: z.number().int().positive(), kMilli: z.number().int().nonnegative() }),
        )
        .default([]),
      kdj: z
        .array(
          z.object({
            n: z.number().int().positive(),
            kPeriod: z.number().int().positive(),
            dPeriod: z.number().int().positive(),
          }),
        )
        .default([]),
      atr: z.array(z.object({ period: z.number().int().positive() })).default([]),
      obv: z.array(z.object({})).default([]),
    })
    // 缺省关闭指标层：见上面 indicatorSpecs 的注释（实测占单轮同步 72% 且无消费方）。
    .default({}),
  /**
   * 指标补齐 / `--rebuild` 的分批大小（v0.3.0 R-6.3），每批一个事务。
   * 单位是**派生 bar 数**而不是时间：按时间推进会让数据稀疏的标的（大量缺口 → 大量
   * 短段）永远达不到批大小而**死循环**。
   */
  indicatorBatchBars: z.number().int().positive().max(1_000_000).default(20_000),
});

/**
 * PG 连接参数。密码**必须经环境变量注入**（R-13 database 段），
 * 这里只接受环境变量名，不接受明文密码。
 */
export const databaseSchema = z.object({
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().positive().max(65_535).default(5432),
  database: z.string().min(1).default('trade_tool'),
  user: z.string().min(1).default('trade'),
  /** 存放密码的环境变量名，默认 TRADE_TOOL_PG_PASSWORD */
  passwordEnv: z.string().min(1).default('TRADE_TOOL_PG_PASSWORD'),
  /** 连接池上限，与并发标的数、批大小一并配置（R-20.7） */
  poolMax: z.number().int().positive().max(200).default(10),
  /** 连接超时（毫秒） */
  connectionTimeoutMs: z.number().int().positive().default(10_000),
  ssl: z.boolean().default(false),
});

/** 标的移除时已入库数据的处置策略（R-18.3），禁止静默删除。 */
export const removePolicySchema = z.enum(['keep', 'archive', 'delete']);

/**
 * `sync.symbols` 的一个条目（R-13「标的集合、**每标的期望状态**」）。
 *
 * 两种写法都支持（示例里的 `<SYMBOL>` 是占位符——源码里不出现任何真实合约名，R-5.1）：
 *   * `"<SYMBOL>"`——等价于 `{ symbol: "<SYMBOL>", desiredState: "paused" }`，
 *     与既有配置向后兼容；新标的默认 paused 是 R-8.4 的硬要求
 *     （一次添加 5 个标的 ≈ 4820 次请求的回补风暴）。
 *   * `{ "symbol": "<SYMBOL>", "desiredState": "running" }`——显式声明「启动后就开启」，
 *     让守护进程重启后能按配置恢复每标的意图，而不必依赖控制面再发一次 start。
 */
export const syncSymbolSchema = z.union([
  z.string().min(1),
  z.object({
    symbol: z.string().min(1),
    desiredState: z.enum(['paused', 'running']).default('paused'),
  }),
]);
export type SyncSymbolEntry = z.infer<typeof syncSymbolSchema>;

/** 把 `sync.symbols` 的两种写法归一成 `{ symbol, desiredState }`。 */
export function normalizeSyncSymbols(
  entries: readonly SyncSymbolEntry[],
): { symbol: string; desiredState: 'paused' | 'running' }[] {
  return entries.map((entry) =>
    typeof entry === 'string'
      ? { symbol: entry, desiredState: 'paused' as const }
      : { symbol: entry.symbol, desiredState: entry.desiredState },
  );
}

/** 常驻同步守护进程配置（R-13 sync 段 / R-17…R-22）。 */
export const syncSchema = z.object({
  /** 标的集合 + 每标的期望状态；新标的默认 paused（R-8.4），需显式 start 才启动首次全量 */
  symbols: z.array(syncSymbolSchema).default([]),
  /** 同时同步的标的数上限（R-20.5） */
  concurrency: z.number().int().positive().max(64).default(4),
  /** 轮询间隔（毫秒）：每轮调度之间休眠多久 */
  pollIntervalMs: z.number().int().positive().default(15_000),
  /** 每分钟权重预算。交易所硬配额 2400/分钟是账号级（R-20.1），预算取其 80% 留余量 */
  weightBudgetPerMinute: z.number().int().positive().max(2_400).default(1_920),
  /** 指数退避的初始间隔（毫秒） */
  backoffBaseMs: z.number().int().positive().default(5_000),
  /** 指数退避上限（毫秒） */
  backoffMaxMs: z.number().int().positive().default(300_000),
  /** 连续失败多少次后进入 error 并停止自动重试（R-21.3） */
  maxConsecutiveErrors: z.number().int().positive().default(5),
  /** removeSymbol 时已入库数据的处置策略 */
  onRemove: removePolicySchema.default('keep'),
});

/**
 * LLM 参与止盈止损决策的配置（v0.9.0）。
 *
 * ## 为什么整段默认关闭
 *
 * 开启它意味着**每一笔买入成交**都会先问一次模型，而模型的输出会变成真实的
 * 平仓指令（止损价、止盈价）。这是一个「不确定的输入 → 不可逆的动作」的通道，
 * 默认打开等于默认接受这个风险。
 *
 * 关闭时（缺省）行为与 v0.9.0 之前**逐字一致**：档位来自 `risk_policy` 表或配置文件。
 *
 * ## 降级是默认行为，不是例外
 *
 * `fallbackToPolicy = true`（缺省）时，模型超时 / 报错 / 输出越界都**降级**到
 * `risk_policy` 的档位，而不是拒绝下单。
 *
 * 为什么不拒绝：仓位已经成交了，此时不挂止损单就是**裸仓**——价格反向运行时
 * 没有任何保护。「模型没说好」比「按配置挂上」危险得多。
 *
 * 但降级**必须可见**：`risk_bracket` 会记下 `decision_source='config-fallback'`
 * 与降级原因，对账与飞书告警都能查到。约定 9 忌讳的是「静默兜底」——
 * 兜底本身不犯规，**不留痕迹**才犯规。
 */
export const llmSchema = llmEndpointSchema
  .extend({
    /**
     * 模型失败时降级到 `risk_policy` 的档位（而不是拒绝下单）。
     *
     * 缺省 true。关掉它意味着模型失败 → 这笔成交不挂任何单 → 裸仓，
     * 除非你确信模型不可用时**宁可裸仓也不要按旧档位挂**（极少见，但存在这种用法）。
     */
    fallbackToPolicy: z.boolean().default(true),
    /**
     * 喂给模型的近期 K 线根数（用于算收益率序列）。
     *
     * 缺省 20：约等于给模型看一眼最近半小时的走势。太少则看不出趋势，
     * 太多则白白增加 token 与延迟。
     */
    contextBars: z.number().int().min(0).max(200).default(20),
  })
  .superRefine((cfg, ctx) => {
    const result = refineLlmEndpoint(cfg, ['executor', 'llm']);
    if (!result.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.message, path: ['enabled'] });
    }
  });

/**
 * 止盈止损执行服务配置（v0.4.0 `executor` 段）。
 *
 * 每一项都会变成**真实的平仓指令**，因此默认值取保守的一侧：
 *   * `enabled` 缺省 **false**——服务会真实下单，不该因为「装了包」就在跑；
 *   * `workingType` 缺省 `MARK_PRICE`（标记价触发，抗插针）；最新成交价一根针就能
 *     把止损扫掉；
 *   * `onPartialFill` 缺省 `ignore`：部分成交就按均价重算一次，等于让止损位在
 *     建仓过程中被改写两次——要在部分成交上也保护，必须显式打开。
 */
export const executorSchema = z.object({
  enabled: z.boolean().default(false),
  /** ATR 周期长度。 */
  atrPeriod: z.number().int().positive().max(200).default(14),
  /** 算 ATR 的周期。`5m` / `2h` 等未实现周期由解析层报错，**不回落**到 1m。 */
  atrInterval: z.enum(['1m', '15m', '1h', '4h', '1d']).default('1m'),
  /** 参与计算的连续 K 根数上限。 */
  atrWindowBars: z.number().int().positive().max(5_000).default(240),
  /** 止损 = 入场价 ∓ 该倍数 × ATR。 */
  stopAtrMult: z.number().positive().max(20).default(2),
  /**
   * 止盈 = 入场价 ± 该倍数 × ATR。
   *
   * **两种形态都用它**（v0.9.1 起只有这一个止盈倍数）：不分批时它是全平目标，
   * 分批时它是「先兑现那一段」的目标，剩下仓位交给移动止损。
   */
  takeProfitAtrMult: z.number().positive().max(50).default(3),
  /**
   * 第一段止盈减仓的比例（v0.7.0），`[0, 1]`。**0 = 关闭分批**，此时行为与 v0.4.0
   * 逐字一致。
   *
   * 两个取值走两种形态，只有 `(0, 1)` 会启用剩余仓位的移动止损：
   *   * `0`      到价一次全平；
   *   * `(0, 1)` 先按这个比例减仓，剩下的交给移动止损。
   *
   * `1` 与 `0` 逐字等价（都是一次全平、都用 `takeProfitAtrMult` 算价），
   * 因此**归一到 `0`**——归一只有一份实现（`normalizeTakeProfit1Ratio`），
   * 这里直接用它，不另写一遍 `v >= 1 ? 0 : v`。
   *
   * 控制面上以 **0–100 的百分数**呈现，换算只有一处实现（`ratioToPercent` /
   * `percentToRatio`），前端不许自己 `÷ 100` 了事。
   */
  takeProfit1Ratio: z.number().min(0).max(1).default(0).transform(normalizeTakeProfit1Ratio),
  /**
   * 移动止损的 Chandelier 倍数：`止损 = 持仓期极值 ∓ 该倍数 × ATR(最新)`，
   * **只朝有利方向移动、永不放宽**。
   *
   * 为什么不跟着 `stopAtrMult` 走：两者是**不同阶段**的参数（进场保护 vs 移动止损），
   * 让它们联动就会出现「改了进场止损倍数、移动止损悄悄跟着变」这种查不出来的行为。
   * 配置里没写时由 `resolvePolicy` 显式取 `stopAtrMult` 的值（同一个参数的两个名字），
   * 库里的 `risk_policy` 永远存具体数值。
   */
  trailAtrMult: z.number().positive().max(20).default(2),
  /** 第一段兑现后，剩余仓位的止损是否上移到保本位。 */
  breakevenAfterTp1: z.boolean().default(true),
  /**
   * 移动止损的重算周期（毫秒）。**0 = 关闭自动重算**。
   *
   * 缺省 60 秒的依据不是「越快越好」，而是限频：一轮里每条 `trailing` 记录最多
   * 1 挂 + 1 撤，而「价未变就不动」让绝大多数轮次是零动作。取值再小也只是让
   * 同一批单反复撤挂，对保护效果没有额外收益。
   */
  trailIntervalMs: z.number().int().min(0).default(60_000),
  /** 只服务这些标的；空数组 = 全部（**含库里出现但集合外的标的**）。 */
  symbols: z.array(z.string().min(1)).default([]),
  /** 买入成交只部分成交时怎么办。`ignore` = 等它全成交再设一次止盈止损。 */
  onPartialFill: z.enum(['ignore', 'accumulate']).default('ignore'),
  workingType: z.enum(['MARK_PRICE', 'CONTRACT_PRICE']).default('MARK_PRICE'),
  /** 触发保护：标记价与最新价偏离过大时暂停触发。 */
  priceProtect: z.boolean().default(true),
  /** 单笔买入成交的成交金额上限（quote 计），超过则跳过并报错。0 = 不限。 */
  maxEntryNotional: z.number().min(0).default(0),
  /** 私钥的**环境变量名**。配置文件里不写密钥本身。 */
  apiKeyEnv: z.string().min(1).default('TRADE_TOOL_BINANCE_API_KEY'),
  apiSecretEnv: z.string().min(1).default('TRADE_TOOL_BINANCE_API_SECRET'),
  /**
   * 请求时间戳容忍窗口（毫秒）。
   *
   * ⚠️ **它挡不住本机时钟不准**。本仓库实测（2026-10-16，demo 端点）：
   * `recvWindow` 取 5000 / 15000 / 60000 三档，报的都是同一句
   * `Timestamp ... was 1000ms ahead of the server's time`——端点对未来时间戳的
   * 容差是硬的 ~1000ms，调大这个参数没有用。
   *
   * 时钟偏差由 `packages/core/src/clock-skew.ts` 在进程启动时测量并补偿，
   * 那个才是真正起作用的地方；这里保留是给**网络延迟**留的余量。
   */
  recvWindowMs: z.number().int().positive().max(60_000).default(5_000),
  /** 重连退避：初始 / 上限。断线必须重连，否则服务会「看起来在跑」而实际不再设单。 */
  reconnectBaseMs: z.number().int().positive().default(2_000),
  reconnectMaxMs: z.number().int().positive().default(60_000),
  /**
   * 交易对账的周期（毫秒）。**0 = 关闭自动对账**，只留 CLI / 控制面手动触发。
   *
   * 为什么默认开着：止盈止损的「单已挂上、单号没回填」只在崩溃那一瞬间发生，
   * 迟到几小时再查也来得及；但**在交易所 App 上手动开的仓**是持续形成的漂移，
   * 只靠人想起来跑一次命令等于没有对账。
   *
   * 默认 5 分钟的依据是权重：全账户一次 `positionRisk`（5）+ 一次
   * `openAlgoOrders`（40）= 45 权重，折合 9 权重/分钟，相对限频可以忽略。
   * 逐标的跑反而更贵（每标的 6），因此默认全账户。
   */
  reconcileIntervalMs: z
    .number()
    .int()
    .min(0)
    .default(5 * 60_000),
  /**
   * 交易所环境：`live` 主网 / `demo` Binance Demo Trading（`demo.binance.com`）。
   *
   * 它**同时**决定 REST 基址与用户数据流地址（`resolveExchangeEndpoints`），不是两个
   * 各自独立的开关——只改一个就会复现「下单进沙箱、成交事件从主网来、于是永远等不到
   * 挂单」这个静默分叉。
   *
   * 缺省 `live`。它是会**真实下单**的开关之一，改成 `demo` 时应当清楚：这是让本地
   * 跑在虚拟资金上，不是把生产环境改成安全的。
   */
  environment: z.enum(EXCHANGE_ENVIRONMENTS).default('live'),
  /**
   * LLM 参与止盈止损决策（v0.9.0）。
   *
   * **默认关闭**。理由与 `executor.enabled` 同一类：开启它意味着每一笔买入成交
   * 都会先问一次模型，而模型的输出会变成真实的平仓指令。
   *
   * 关闭时的行为与 v0.9.0 之前**逐字一致**：档位全部来自 `risk_policy` 表或配置文件，
   * 决策来源记为 `'policy'`。
   */
  llm: llmSchema.default({}),
});

/**
 * 通知配置（v0.8.0）。
 *
 * 通道是**飞书自定义机器人的 webhook**。webhook 地址本身就是一个凭据
 * （拿到它就能往群里发消息，官方文档明确要求不要外泄），因此这里**只写环境变量名**，
 * 地址本身留在 `.env` 里——与 `executor.apiKeyEnv` 同一套做法。
 *
 * 默认**关闭**：通知是给人看的辅助出口，不该因为「装了包」就往群里发东西。
 * 打开它要显式做两件事：配置里 `enabled = true`，且环境变量里填上地址。
 */
export const notifySchema = z.object({
  /** 关闭时完全不推送。 */
  enabled: z.boolean().default(false),
  /** webhook 地址所在的**环境变量名**。 */
  webhookEnv: z.string().min(1).default('TRADE_TOOL_FEISHU_WEBHOOK_URL'),
  /** 签名密钥所在的**环境变量名**。机器人的「安全设置」选了「签名校验」时才需要。 */
  secretEnv: z.string().min(1).default('TRADE_TOOL_FEISHU_WEBHOOK_SECRET'),
  /**
   * **要通知哪些内容**（v0.8.0）。
   *
   * 取值是**通知内容类型**（`NOTIFY_KINDS`），也就是「哪种事发生时才叫我」——
   * 交易对账的差异类型（8 种）加上交易生命周期事件（止盈止损挂上、一轮走完）。
   * 缺省 = 全部都要。
   *
   * 为什么不用「最低严重度」一刀切：严重度对同一个类型是固定的，粗暴的阈值等于
   * 「全都要」或「只要三个紧急的」，用户真正想做的是「我只想知道哪几种事」——
   * 比如「止盈单没了」这种噪音就别烦我了，但「仓位没有止损保护」一定要说。
   * 逐项勾选能表达，而阈值表达不了。
   */
  kinds: z.array(z.enum(NOTIFY_KINDS)).default([...NOTIFY_KINDS]),
  /**
   * 同一条告警的重复推送冷却时间（毫秒）。
   *
   * 对账默认每 5 分钟跑一次；一个一直存在的裸仓若每轮都推，群里三天就没人看了。
   * 缺省 30 分钟：既不会刷屏，又不至于让人以为「服务已经不管这事了」。
   */
  repeatCooldownMs: z
    .number()
    .int()
    .min(0)
    .default(30 * 60_000),
});

/**
 * LLM 接入配置（Agent 段，v1.0.0）。
 *
 * 与 `executor.llm` 共用接入字段（见 [`llm-endpoint.ts`](./llm-endpoint.ts)），
 * 差别在**失败时怎么办**：
 *
 * - `executor.llm.fallbackToPolicy = false` → 拒绝挂单 → **裸仓**（仓位已成交）；
 * - `agent.llm.fallbackToTrade = true` → 这一轮**不出方案** → 不开新仓。
 *
 * 后者没有裸仓风险，所以缺省是 `true`（降级）。降级会**落库**并留下原因，
 * 不会静默跳过（AGENTS.md 约定 9）。
 */
export const agentLlmSchema = llmEndpointSchema
  .extend({
    /**
     * 模型失败 / 输出不合法时，这一轮**降级成「不出方案」**而不是让整轮失败。
     *
     * 缺省 true。关掉它意味着模型不可用时 Agent 直接报错退出——
     * 只有在「宁可没有方案也不要一份来路不明的方案」时才需要。
     */
    fallbackToTrade: z.boolean().default(true),
  })
  .superRefine((cfg, ctx) => {
    const result = refineLlmEndpoint(cfg, ['agent', 'llm']);
    if (!result.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.message, path: ['enabled'] });
    }
  });

/**
 * 分析师 / 交易员 Agent 的配置（v1.0.0）。
 *
 * ## 整段默认关闭
 *
 * 开启它意味着**模型会参与决定真金白银下多少、止损放哪**。
 * 这是「不确定的输入 → 不可逆的动作」的通道，默认打开等于默认接受这个风险
 * （与 `executor.enabled` 同一类理由）。
 *
 * 关闭时（缺省）整个 Agent 进程不会发起任何模型调用，也不会出任何方案。
 */
export const agentSchema = z.object({
  /** 是否让 Agent 跑起来。缺省 false。 */
  enabled: z.boolean().default(false),
  /**
   * 参与分析的标的。
   *
   * `[]` = **库里的全部标的**（`symbols` 表里有的都算）。写死一批标的会让
   * 「加了一个新标的却没人分析它」变成静默的事。
   */
  symbols: z.array(z.string().min(1)).default([]),
  /**
   * 分析用的**派生周期**。
   *
   * 只接受 `15m / 1h / 4h / 1d`：技术面靠派生 K 线算，
   * 而 `1m` 上做指标物化是容量结论（单标的约 4.3 GB）。
   */
  interval: z.enum(['15m', '1h', '4h', '1d']).default('1h'),
  /** 每轮之间的间隔（毫秒）。缺省 15 分钟。 */
  intervalMs: z
    .number()
    .int()
    .positive()
    .min(60_000)
    .default(15 * 60_000),
  /**
   * 技术面计算用多少根已收盘 K 线。
   *
   * 缺省 300：够算出 MA60 与 KDJ 的预热，又不至于让单次分析太慢。
   */
  bars: z.number().int().positive().max(1_500).default(300),
  /**
   * 三个面的权重。
   *
   * 缺省基本面 0.5：基本面（合约规格、流动性、持有成本）变化**慢**，
   * 而技术面与情绪面变化快，因此权重低一档。不必和为 1——合成时会归一。
   */
  weights: z
    .object({
      technical: z.number().positive().default(1),
      sentiment: z.number().positive().default(1),
      fundamental: z.number().positive().default(0.5),
    })
    .default({}),
  /**
   * 「中性带」的宽度：综合分落在 `(-band, band)` 里就算中性。
   *
   * 缺省 0.2：综合分不到两成时三个面基本在互相抵消，
   * 这时候硬给一个方向比给「观望」更危险。
   */
  neutralBand: z.number().min(0).max(1).default(0.2),
  /**
   * 风控上限。**这些上限来自配置，不来自模型**——
   * 模型说什么只影响「用掉上限的多少」，影响不了「上限是多少」。
   */
  risk: z
    .object({
      /** 单笔最大风险占权益的比例。缺省 1%（0.01）。 */
      maxRiskFraction: z.number().positive().max(0.05).default(0.01),
      /** 单笔最大名义金额（计价币）。`0` = 不限。 */
      maxNotional: z.number().min(0).default(0),
      /** 最小盈亏比。低于它就抬高止盈倍数到达标。 */
      minRiskReward: z.number().positive().default(1.5),
      /**
       * 分析师结论为**中性**时，风险敞口的打折系数。缺省 0.5（减半）。
       *
       * 没有方向性确认时仓位就该小。必须是 `(0, 1]`：`0` 等于「中性时一笔都不做」，
       * 那是另一种设计（用 `executor.enabled` 之外的手段关掉整段）。
       */
      neutralRiskFactor: z.number().positive().max(1).default(0.5),
    })
    .default({}),
  /** 模型接入。见 {@link agentLlmSchema}。 */
  llm: agentLlmSchema.default({}),
  /**
   * 账户权益从哪来。
   *
   * 仓位大小是「愿意亏多少钱 ÷ 每股亏多少」算出来的，而分母是**账户权益**——
   * 因此算仓位就必须知道权益是多少。两条路，**显式选一条**（不做「优先级解析」）：
   *
   * - `exchange`：从交易所读实时余额。准，但要凭据（`executor.apiKeyEnv` /
   *   `apiSecretEnv` 或控制面里加密存的那份）。
   * - `config`：用 `equity` 里写的数。适合「只做分析、不碰账户」的场景，
   *   但它是**手动维护**的——账户变大变小都要人记得改。
   *
   * 缺省 `exchange`：权益写错会直接变成仓位算错，而仓位算错就是真钱。
   */
  equitySource: z.enum(['exchange', 'config']).default('exchange'),
  /**
   * 账户权益（计价币）。**只在 `equitySource = 'config'` 时用**。
   *
   * 缺省 0 = 没配。用 `equitySource = 'config'` 却没填这个数时，
   * 交易员这一步会**明确失败**（而不是拿 0 去算仓位——那会算出 0 数量，
   * 一个看起来正常、实际什么都不做的方案）。
   */
  equity: z.number().min(0).default(0),
  /**
   * 自动执行。**默认关闭**：方案只落库、只在页面与 CLI 里看，
   * 不会变成真实订单。
   *
   * 打开它意味着「模型决定的这笔方案会真的开仓」——那是真钱，
   * 因此要显式打开，且受 `risk` 段的全部上限约束。
   *
   * ⚠️ **本期没有实现自动执行路径**：`apps/executor` 还不消费
   * `trading_plan.status = 'approved'` 的方案。因此把这个开关打开时，
   * `apps/agent` 会**启动即报错**而不是「开着却什么也不做」——
   * 后者是 AGENTS.md 约定 9 点名的最危险的一种失败。
   */
  execute: z
    .object({
      /**
       * 是否把方案变成真实订单。缺省 false。
       *
       * **本期未实现**：打开会让 `apps/agent` 启动即报错（见上一段）。
       */
      enabled: z.boolean().default(false),
      /** 同时最多挂多少笔未终结的方案。缺省 1。 */
      maxOpenPlans: z.number().int().positive().max(20).default(1),
      /**
       * 方案的有效期（毫秒）。超时的方案不再执行。
       *
       * 缺省 30 分钟：一份方案的依据是「刚才那批行情」，
       * 半小时后行情都换了，拿旧方案下单是拿旧信息冒险。
       */
      planTtlMs: z
        .number()
        .int()
        .positive()
        .default(30 * 60_000),
    })
    .default({}),
});

export const configSchema = z.object({
  version: z.literal(1).default(1),
  market: marketSchema,
  // 整段可省略：只写要改的字段，其余走各字段自身的默认值
  backtest: backtestSchema.default({}),
  data: dataSchema.default({}),
  database: databaseSchema.default({}),
  sync: syncSchema.default({}),
  executor: executorSchema.default({}),
  notify: notifySchema.default({}),
  agent: agentSchema.default({}),
});

export type MarketConfig = z.infer<typeof marketSchema>;
export type BacktestConfig = z.infer<typeof backtestSchema>;
export type DataConfig = z.infer<typeof dataSchema>;
export type DatabaseConfig = z.infer<typeof databaseSchema>;
export type SyncConfig = z.infer<typeof syncSchema>;
export type ExecutorConfig = z.infer<typeof executorSchema>;
export type LlmConfig = z.infer<typeof llmSchema>;
export type NotifyConfig = z.infer<typeof notifySchema>;
export type AgentConfig = z.infer<typeof agentSchema>;
export type AgentLlmConfig = z.infer<typeof agentLlmSchema>;
// 注意：`RemovePolicy` 这个类型名归 market-sync.ts 所有，config 只导出 zod schema，
// 避免同一概念在两个模块各有一个类型名。
export type RemovePolicySchema = z.infer<typeof removePolicySchema>;
export type TradeToolConfig = z.infer<typeof configSchema>;

export function defaultConfig(): TradeToolConfig {
  return configSchema.parse({
    market: { symbol: 'BTCUSDT', interval: '1h' },
    backtest: { strategy: 'ma-cross', params: { fast: 20, slow: 60 } },
    data: {},
    database: {},
    sync: {},
  });
}
