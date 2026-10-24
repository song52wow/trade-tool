/**
 * 止盈止损服务的中枢（v0.4.0）。
 *
 * 一条成交事件的完整路径：
 *
 * ```
 * 成交事件 ──► 是我们自己的 TP/SL 单吗？ ──是─► 记最终状态（另一张由交易所撤销）
 *      │
 *      否
 *      ▼
 *   看**净仓位**（事件自带 a.P 快照，没有才回落 positionRisk）：
 *      ├── 归零 ────────► 工具外平仓：未终结记录全部收敛为 cancelled
 *      ├── 方向相反 ────► 减仓，忽略（由它自己的单触发）
 *      └── 方向一致 ────► 新开仓（BUY 开多 / SELL 开空），继续往下
 *      ▼
 *   该标的是否已有未终结保护？是 ─► 跳过并留日志（不叠第二套 closePosition）
 *      │否
 *      ▼
 *   达到处理门槛了吗（FILLED，或 accumulate 模式下的部分成交）？否 ─► 忽略
 *      │是
 *      ▼
 *   ┌─► 占坑（幂等锚点：exchange+symbol+entryOrderId）──► 已被处理过 ─► 跳过
 *   ││
 *   │└─► 算 ATR（按成交时刻，只用已收盘连续 K 线）
 *   │      ▼
 *   │   对齐 tick → 挂止盈 → 挂止损 → 回填单号（state=armed）
 *   │      │
 *   │      └─► 任一步失败：撤掉已挂的那张 → 记 failed + 原因
 *   └───────────────────────────────────────────────
 * ```
 *
 * 「撤掉已挂的那张」不是可选的洁癖：止盈挂上了、止损没挂上时，仓位是**裸奔**的——
 * 它有止盈没有止损，最坏情况是价格直接穿过去。一张没有止损的止盈单比什么都不挂更危险。
 */

import {
  QUOTE_ASSET,
  SyncError,
  NetPositionTracker,
  bracketClientOrderId,
  estimateBracketPnl,
  feeInQuoteAsset,
  feePriceSymbol,
  realizedPnl,
  type AlertChannel,
  type AlertDispatcher,
  type AlertItem,
  type FillApplication,
  classifyFill,
  createLogger,
  deriveStagedPlan,
  deriveTrailingPlan,
  parseBracketClientOrderId,
  signedFillDelta,
  type ExecutorConfig,
  type StagedPlan,
  type TradeToolConfig,
  type TrailingReason,
} from '@trade-tool/core';
import {
  claimBracket,
  listTrailingBrackets,
  listUnsettledBrackets,
  markBracketArmed,
  markBracketFailed,
  markBracketPartialArmed,
  markBracketSettled,
  markBracketTrailMoved,
  markBracketTrailNotMoved,
  markBracketTrailing,
  parseStepSize,
  parseTickSize,
  readBracket,
  readContractSpecRaw,
  recordBracketTp1Fill,
  reserveTrailStep,
  type OrderTradeUpdate,
  type BracketRecord,
  type BracketState,
  type Pool,
} from '@trade-tool/data';

import type { AtrProvider, AtrSnapshot } from './atr.js';
import { applyDecision, type DecideOutput, type RiskDecider } from './decision.js';
import type { AgentPlanDecision } from './plan-execution.js';

const log = createLogger('executor');

/**
 * 编号约定**只有一份实现**，在 `@trade-tool/core`（v0.6.0 从这里上移）。
 *
 * 之前它只长在本文件里，而 v0.6.0 的交易对账要靠同一个约定把交易所挂着的条件单认回
 * 本地记录。两处各写一遍前缀解析，漂移的症状是「止损挂在错误的仓位上」——在两边都
 * 看起来正常的日志里。
 *
 * 这里仍然原样导出，`apps/executor` 的对外签名不变。
 */
export {
  bracketClientOrderId,
  parseBracketClientOrderId,
  RISK_CLIENT_ID_PREFIX,
} from '@trade-tool/core';

const TP_TAG = 'tp';
const SL_TAG = 'sl';

/**
 * 下单能力。只声明用到的两个方法，测试可整体替身。
 *
 * 全部走 Algo Order API：`algoId` 与普通 `orderId` 是两套独立编号，撤销也各走各的。
 * 这里刻意用 `algoId` 命名而不用 `orderId`——混用只会在撤单时才暴露。
 */
export interface OrderPlacer {
  placeClosePositionOrder(request: {
    symbol: string;
    side: 'BUY' | 'SELL';
    type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
    stopPrice: number;
    clientAlgoId: string;
    workingType: 'MARK_PRICE' | 'CONTRACT_PRICE';
    priceProtect: boolean;
  }): Promise<{ algoId: number; clientAlgoId: string; symbol: string; status: string }>;
  /**
   * 挂一张**带数量**的条件单（v0.7.0 的第一段止盈）。
   *
   * 与 `placeClosePositionOrder` 互斥：`quantity` 与 `closePosition` 官方明确不能并存。
   * 代价是它**不再享有**「仓位归零时由交易所自动撤销」，撤单改由本地负责。
   */
  placeQuantityOrder(request: {
    symbol: string;
    side: 'BUY' | 'SELL';
    type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
    stopPrice: number;
    quantity: number;
    reduceOnly: boolean;
    clientAlgoId: string;
    workingType: 'MARK_PRICE' | 'CONTRACT_PRICE';
    priceProtect: boolean;
  }): Promise<{ algoId: number; clientAlgoId: string; symbol: string; status: string }>;
  cancelAlgoOrder(algoId: number): Promise<void>;
}

/**
 * 净仓位跟踪器。**不注入 IO 实现**——净额由流内成交增量维护，IO 只在播种那一步。
 *
 * 之所以做成一个可替换的依赖而不是 service 内部私有的 map：它必须能被
 * `main.ts` 在启动与**每次重连**后重新播种，播种是 IO、增量是纯计算，两者的
 * 边界必须显式，否则「重连后沿用断线前的旧净额」会安静地错下去。
 */
export interface PositionState {
  /** 播种一个标的的起始净额。启动与每次重连后都要调。 */
  seed(symbol: string, positionAmt: number): void;
  /** 用 `ACCOUNT_UPDATE` 的权威值校正（只覆盖**这条事件里出现**的标的）。 */
  correct(symbol: string, positionAmt: number, tradeTime: number): void;
  /** 读当前净额；未跟踪过返回 `undefined`。 */
  get(symbol: string): number | undefined;
  /** 记一笔成交，返回成交之后的净仓位与「是否真的累加了」。 */
  applyFill(symbol: string, delta: number, tradeTime: number): FillApplication;
}

export interface ExecutorServiceDeps {
  pool: Pool;
  config: TradeToolConfig;
  placer: OrderPlacer;
  atr: AtrProvider;
  /** 净仓位跟踪器。不传则内部自建一个空表（此时首次成交按 0 起算）。 */
  positions?: PositionState;
  /** 可注入时钟，测试里固定住。 */
  now?: () => number;
  /**
   * 按标的解析止盈止损参数（v0.5.0）。
   *
   * 优先级只有一份实现：`resolvePolicy()`（标的覆盖 > 全局默认 > 配置文件）。
   * **不传就用配置文件**——测试与未接库的场景因此不必改。
   *
   * 注意：它决定的是**之后**的成交。已经挂出去的单不会被改写，也不会撤单重挂：
   * 那会平掉真实仓位，不可逆。
   */
  resolvePolicy?: (symbol: string) => Promise<RiskPolicy & { source: string }>;
  /**
   * LLM 决策器（v0.9.0）。
   *
   * **不传就不参与决策**：档位全部来自 `resolvePolicy`，行为与 v0.9.0 之前逐字一致。
   * 传了就由它决定这一笔成交用哪套档位，模型失败时按 `llm.fallbackToPolicy` 降级。
   */
  decider?: RiskDecider;
  /**
   * 反查这笔成交是不是按 Agent 方案下的（v1.0.0 自动下单）。
   *
   * 返回 `null` = 不是（走配置档位或模型决策）。
   *
   * **不传则整段跳过**，行为与 v1.0.0 之前逐字一致——
   * 这样「没开自动下单」的执行器与之前没有任何区别。
   */
  resolveAgentPlan?: (update: OrderTradeUpdate) => Promise<AgentPlanDecision | null>;
  /**
   * 读最近若干根 K 线的收益率（给模型看走势）。
   *
   * 与 `decider` 配套：没有它就没有喂给模型的近期行情。
   * 缺了不报错——决策器会把 `recentReturns` 留空，模型少一个参考维度而已。
   */
  readRecentReturns?: (symbol: string, limit: number) => Promise<readonly number[]>;
  /**
   * 告警派发器（v0.8.0）。**可选**：不传就只记日志。
   *
   * 与周期对账共用**同一个实例**——去重与冷却的记账因此是同一份，
   * 不会出现「同一件事，对账那边压住了、这边又推一遍」。
   */
  alerts?: AlertDispatcher;
  /**
   * 取标记价（v0.9.3）。**把非计价币的手续费折成计价币时用它**。
   *
   * 币安的手续费不一定用计价币收——开了 BNB 抵扣就用 BNB 收。而盈亏公式
   * （`realizedPnl`）只认计价币，所以不折算就是把「0.00009805 BNB」当成
   * 「0.00009805 USDT」记进去，差着几百倍。
   *
   * **可选**：不传时，遇到非计价币的手续费会**大声报错并跳过那一笔手续费**
   * （宁可少算，也不写一个错的数进去），而**不会**因此拒绝算这一轮的盈亏。
   *
   * @param symbol 交易对，如 `'BNBUSDT'`。
   */
  markPrice?: (symbol: string) => Promise<number>;
}

/** 从库里解析出来的一份策略参数。字段名与 `deriveStagedPlan` 入参一一对应。 */
export interface RiskPolicy {
  atrPeriod: number;
  atrInterval: string;
  stopAtrMult: number;
  /**
   * 止盈倍数。**两种形态都用它**（v0.9.1 起只有这一个止盈倍数）：
   * 不分批时是全平目标，分批时是先兑现那一段的目标。
   */
  takeProfitAtrMult: number;
  /** v0.7.0：`[0, 1)`。`0` = 不分批；中间值 = 分批。`1` 会被归一到 `0`。 */
  takeProfit1Ratio: number;
  trailAtrMult: number;
  breakevenAfterTp1: boolean;
}

/** 一条成交事件的处理结果。控制面与日志都靠它区分「为什么没设单」。 */
export type HandleOutcome =
  | 'ignored'
  | 'settled'
  | 'external-close'
  | 'skipped-existing-bracket'
  | 'duplicate'
  | 'armed'
  | 'failed'
  | 'partial-skipped'
  /** v0.7.0：第一段已成交，已进入移动止损。 */
  | 'trailing';

export interface ExecutorService {
  handleFill(update: OrderTradeUpdate): Promise<HandleOutcome>;
  /** 用 `ACCOUNT_UPDATE` 校正净仓位（**不收敛记录**，见实现注释）。 */
  correctPositions(
    updates: readonly { symbol: string; positionAmt: number; transactionTime: number }[],
  ): Promise<void>;
  /**
   * 重连 / 启动播种后的兜底收敛。
   *
   * `flat` 只是**候选提示**：真正的判据是「交易所说这个标的没有仓位」，
   * 候选集由本方法自己从库里取「有未终结记录的标的」补全（见实现注释）。
   */
  convergeFlatPositions(flat: readonly { symbol: string }[]): Promise<void>;
  /** 最近一次算出的计划，仅供测试与诊断。 */
  readonly lastPlan: StagedPlan | null;
  /** 跑一轮移动止损。定时器与测试都调它。 */
  trailOnce(): Promise<TrailReport>;
}

/**
 * 一轮移动止损的结果。**五项都单独计数**，不合成一个「成功与否」：
 * 「这一轮没有动作」与「这一轮失败了」在处置上完全不同，合成一个就看不出区别。
 */
export interface TrailReport {
  /**
   * 本轮把「等推进」的行推进到 `trailing` 的条数。
   *
   * 它与 {@link TrailReport.moved} 是**两件事**：阶段推进了不等于止损挪了
   * （价位没变时只推进阶段、不动交易所上的单）。
   */
  advanced: number;
  /** 真正换档（含补挂）的条数。 */
  moved: number;
  /** 本轮不需要动的条数。 */
  unchanged: number;
  /** 动失败、保留原档的条数。 */
  failed: number;
  /** 本轮跳过、不动任何单的条数（不在配置范围内 / 记录已不在移动止损阶段）。 */
  skipped: number;
}

/** 一次算好的移动止损档位。 */
export interface TrailPlan {
  /** 要挂上去的那一档。 */
  stopPrice: number;
  /** 是否需要撤旧挂新。`false` 时调用方**必须**跳过一切下单动作。 */
  changed: boolean;
  /** 没动的原因（`unchanged` / `beyond-price` / `breakeven` / `moved`）。 */
  reason: TrailingReason;
  /** 这一轮用到的持仓期极值。 */
  extreme: number;
  /** 极值取数窗口的起点 / 终点。 */
  atrFrom: number;
  atrTo: number;
}

function reasonOf(error: unknown): string {
  if (error instanceof SyncError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 金额一律用计价币（USDT）呈现，四舍五入到两位。 */
function money(amount: number): string {
  return `${amount.toFixed(2)} ${QUOTE_ASSET}`;
}

/**
 * 一次手续费折算的结果（v0.9.3）。
 *
 * `amount` 永远是**计价币**的金额；`asset` / `fxRate` 是折算的痕迹。
 */
interface FeeInQuote {
  /** 折成计价币的金额。折算失败时是 `0`——那一笔**没有**计入。 */
  amount: number;
  /** 原币种（非计价币时才有，比如 `'BNB'`）。 */
  asset: string | null;
  /** 折算用的汇率（1 个原币种值多少计价币）。折算失败时是 `null`。 */
  fxRate: number | null;
  /** 折算失败的原因（人可读）。成功时是 `null`。 */
  error: string | null;
}

export function createExecutorService(deps: ExecutorServiceDeps): ExecutorService {
  const { pool, config, placer, atr } = deps;
  const settings: ExecutorConfig = config.executor;
  const now = deps.now ?? (() => Date.now());
  const exchange = config.market.exchange;
  const positions = deps.positions ?? new NetPositionTracker();
  let lastPlan: StagedPlan | null = null;

  /** 标的过滤：配置为空 = 全部。 */
  function inScope(symbol: string): boolean {
    return settings.symbols.length === 0 || settings.symbols.includes(symbol);
  }

  /**
   * 把一笔手续费折成**计价币**（v0.9.3）。
   *
   * 币安的手续费不一定用计价币收——开了 BNB 抵扣就用 BNB 收。而盈亏公式只认
   * 计价币，于是不折算就是把「0.00009805 BNB」当成「0.00009805 USDT」记，
   * 差着几百倍（2026-10-23 实测踩到，净盈亏因此虚高）。
   *
   * **折算失败时怎么办**：**跳过那一笔手续费，但绝不拒绝算这一轮的盈亏**。
   *
   * 这条边界是刻意画的：
   *   * 拒绝算 → 出场事实整个丢了，账面上「这一轮没结束」，而仓位可能已经平了——
   *     那是最坏的一种错（「看起来还在跑，实际没人管」）；
   *   * 按原数量硬记 → 又回到「差几百倍」的错，而且看不出来。
   *
   * 所以：**少算 + 大声报错**。少算的那一笔会在库里留下痕迹
   * （`fee_asset` 有值而 `fee_fx_rate` 为空），错误也会打到日志与飞书通知里。
   */
  async function commissionInQuote(update: OrderTradeUpdate): Promise<FeeInQuote> {
    const asset = update.commissionAsset.trim().toUpperCase();
    if (asset === '') {
      // 币种都没有 = 交易所没给。这是**形状不对**，不能猜（猜成计价币就是那个 bug）。
      const error = '成交事件没有带手续费币种';
      log.error(
        `${update.symbol} ${error}（手续费 ${update.commission}）：这一笔不计入。` +
          `宁可少算，也不写一个错的数进去。`,
      );
      return { amount: 0, asset: null, fxRate: null, error };
    }
    if (asset === QUOTE_ASSET) {
      // 本来就是计价币，不用折算，也不用取价。
      return { amount: update.commission, asset: null, fxRate: null, error: null };
    }
    const provider = deps.markPrice;
    if (provider === undefined) {
      const error = '没有取价能力，无法把非计价币手续费折成计价币';
      log.error(
        `${update.symbol} ${update.commission} ${asset} → ${QUOTE_ASSET}：${error}。` +
          `这一笔不计入。宁可少算，也不写一个错的数进去。`,
      );
      return { amount: 0, asset, fxRate: null, error };
    }
    try {
      const price = await markPriceOf(feePriceSymbol(asset));
      const amount = feeInQuoteAsset(update.commission, asset, price);
      log.info(
        `${update.symbol} 手续费折算：${update.commission} ${asset} × ${price} = ${amount} ${QUOTE_ASSET}`,
      );
      return { amount, asset, fxRate: price, error: null };
    } catch (error) {
      const reason = reasonOf(error);
      log.error(
        `${update.symbol} ${update.commission} ${asset} → ${QUOTE_ASSET} 折算失败：${reason}。` +
          `这一笔不计入。宁可少算，也不写一个错的数进去。`,
      );
      return { amount: 0, asset, fxRate: null, error: reason };
    }
  }

  /**
   * 取标记价，带一个**短缓存**。
   *
   * 为什么要有缓存：开了 BNB 抵扣之后，**每一笔成交**都要折算，于是每一笔成交
   * 都要问交易所一次价。成交是连续发生的（入场那笔与出场那笔常常只隔几秒），
   * 而标记价在几十秒内基本不动——为同一秒里的两个数跑两趟交易所纯属浪费，
   * 也会让出网路径多一个可能卡住的地方。
   *
   * 缓存还有个好处：**同一笔交易里的几笔手续费会用同一个价**，
   * 于是「这一轮的手续费是多少」这个问题只有一个答案。
   *
   * TTL 取 30 秒：够覆盖「入场那笔与出场那笔之间」的间隔，又短到不会拿着
   * 一分钟前的价去折算后来的成交。
   */
  const MARK_PRICE_TTL_MS = 30_000;
  const markPriceCache = new Map<string, { price: number; at: number }>();

  async function markPriceOf(symbol: string): Promise<number> {
    const cached = markPriceCache.get(symbol);
    if (cached !== undefined && now() - cached.at < MARK_PRICE_TTL_MS) {
      return cached.price;
    }
    const provider = deps.markPrice;
    if (provider === undefined) {
      throw new SyncError('CONFIG_INVALID', '没有取价能力，无法把非计价币手续费折成计价币');
    }
    const price = await provider(symbol);
    markPriceCache.set(symbol, { price, at: now() });
    return price;
  }

  /**
   * 把折算结果拼成落库用的手续费字段。
   *
   * `feeAsset` 与 `feeFxRate` 是**可选**的：折算失败时前者要记（那是「有一笔
   * 没折算」的痕迹），后者不记（没有价就没有汇率）。
   */
  function feeFields(fee: FeeInQuote): { fee: number; feeAsset?: string; feeFxRate?: number } {
    return {
      fee: fee.amount,
      ...(fee.asset === null ? {} : { feeAsset: fee.asset }),
      ...(fee.fxRate === null ? {} : { feeFxRate: fee.fxRate }),
    };
  }

  /**
   * 我方条件单成交后的处理。
   *
   * v0.7.0 之后这里有**三条**路，而不是一条（改动原因见下方 `trailing` 分支的注释）：
   *
   * | tag | 记录当时的状态 | 动作                                            |
   * | --- | -------------- | ----------------------------------------------- |
   * | sl  | 任意未终结     | 收敛为终态 `stop_loss`                          |
   * | tp  | `armed`        | 收敛为终态 `take_profit`（不分批形态）           |
   * | tp  | `partial_armed`| 推进到 `trailing`，不再终结                     |
   * | tp  | 已 `trailing`  | **什么都不做**（事件重放）                       |
   */
  async function settle(
    update: OrderTradeUpdate,
    entryOrderId: string,
    tag: typeof TP_TAG | typeof SL_TAG,
  ): Promise<HandleOutcome> {
    const key = { exchange, symbol: update.symbol, entryOrderId };

    // 先读状态再决定写什么。**不读就写**是把 `trailing` 抹成终态的直接原因（v0.7.0 E.5）。
    let record;
    try {
      record = await readBracket(pool, exchange, update.symbol, entryOrderId);
    } catch (error) {
      log.error(`${update.symbol} 读取止盈止损记录失败（成交 ${tag}）：${reasonOf(error)}`);
      return 'ignored';
    }
    if (record === null) {
      // 「这条记录不存在」：可能是事件重放时记录已被收敛。无事可做，也**不**当成错误。
      log.info(`${update.symbol} 收到 ${tag} 成交但本地没有对应记录，跳过（可能已收敛）`);
      return 'ignored';
    }

    if (tag === TP_TAG && record.state === 'partial_armed') {
      return armTrailing(update, record);
    }

    if (tag === TP_TAG && record.state === 'trailing') {
      // 事件重放（listenKey 续期、断线重连都会重投）。**这里必须直接返回**：
      // 再走一次结算会把记录抹成终态 `take_profit`，移动止损就再也不会启动，
      // 而账面上显示「这笔交易已经了结」——最该被看见的一次交易被抹掉了。
      log.info(`${update.symbol} 第一段止盈成交事件重放（记录已是 trailing），不做任何改动`);
      return 'settled';
    }

    const state: BracketState = tag === TP_TAG ? 'take_profit' : 'stop_loss';
    // 手续费先折算（v0.9.3）。**折算失败也不拦着结算**——这一轮必须了结，
    // 少算的那一笔由 `feeFields` 里的 0 与 `fee_asset` 痕迹来交代。
    const fee = await commissionInQuote(update);
    try {
      const settled = await markBracketSettled(pool, key, state, now(), {
        price: update.lastFilledPrice,
        qty: update.lastFilledQty,
        ...feeFields(fee),
      });
      log.info(`${update.symbol} 止盈止损成交（${tag}），记录置为 ${state}`);
      // 只有**真的**结算了那一行才通知：事件重放时行早已终结（settled = 0），
      // 再推一次就会把同一轮的战报发两遍。
      if (settled > 0) await notifySettled(update, record, state, fee.error);
      return 'settled';
    } catch (error) {
      // 状态回填失败**不能**反过来影响交易结果：单已经成交了，
      // 但把异常抛出去会让事件处理器以为处理失败而重试。
      log.error(`${update.symbol} 条件单成交但状态回填失败：${reasonOf(error)}`);
      return 'settled';
    }
  }

  /**
   * 一轮走完 → 通知（附**实际盈亏**，已扣手续费，计价币）。
   *
   * 盈亏由 `core` 的 `realizedPnl()` 算，公式只有一份；库里存的是**事实**
   * （累计平了多少、累计成交额、累计手续费），不是算好的金额。
   *
   * 「工具外平仓」（`cancelled`）**不通知**：那笔平仓没有我们的成交价，
   * 算不出盈亏——如实不算，比报一个假数字强。
   */
  async function notifySettled(
    update: OrderTradeUpdate,
    record: BracketRecord,
    state: 'take_profit' | 'stop_loss',
    /** v0.9.3：手续费折算失败的原因。有值时通知里要**说人话**，不能假装一切正常。 */
    feeError?: string | null,
  ): Promise<void> {
    const after = await readBracket(pool, exchange, record.symbol, record.entryOrderId);
    if (after === null) return;
    const pnl = realizedPnl({
      positionSide: after.positionSide,
      entryPrice: after.entryPrice,
      closedQty: after.closedQty,
      exitNotional: after.exitNotional,
      feeAmount: after.feeAmount,
    });
    // 「出场价」与「均价」都只在**真的有成交额**时才有意义。
    // 成交额是 0 时显示 0 是最糟的写法：它看起来像个真实的数，而不是「没拿到」。
    const avgExitPrice = after.closedQty > 0 ? after.exitNotional / after.closedQty : 0;
    const priceLine =
      update.lastFilledPrice > 0
        ? `入场 ${after.entryPrice} → 出场 ${update.lastFilledPrice}`
        : `入场 ${after.entryPrice} → 出场价没拿到`;
    const qtyLine =
      avgExitPrice > 0
        ? `已平 ${after.closedQty}（均价 ${avgExitPrice.toFixed(2)}）`
        : `已平 ${after.closedQty}（成交额没拿到，算不出均价）`;
    const round = `本轮${state === 'take_profit' ? '止盈' : '止损'}成交`;
    // 订单号是**排查用的钥匙**：出问题时拿着它去交易所的订单记录里查，
    // 不用靠「哪个标的、什么时候」去猜是哪一张单。
    // 入场单号是这一轮的锚（库里那一行的主键），出场单号是真正成交的那张。
    const orderLine = `订单号：入场 ${after.entryOrderId}，出场 ${update.orderId}`;
    // v0.9.3：折算失败时，通知里必须**说清楚**「有一笔手续费没算进去」。
    // 不说的话，看板上那个偏高的净盈亏就是骗人的。
    const feeNote =
      feeError === null || feeError === undefined
        ? null
        : `有一笔手续费没折算成${QUOTE_ASSET}（${feeError}），没计入本轮：净盈亏偏高`;

    await pushAlert('bracket-settled', () => {
      // 盈亏**算不出来**时如实说算不出来，绝不拿 0 去凑一个「看起来精确」的数字。
      if (pnl === null) {
        return {
          fingerprint: `settled|${after.symbol}|${after.entryOrderId}`,
          category: 'trade',
          // 算不出盈亏比亏了更值得看一眼：用「注意」。
          severity: 'warning',
          oneShot: true,
          title: `${after.symbol} 一轮完成（盈亏算不出）`,
          lines: [
            priceLine,
            qtyLine,
            orderLine,
            round,
            '没拿到出场成交额，这一轮的盈亏暂时算不出来',
            ...(feeNote === null ? [] : [feeNote]),
          ],
          highlights: [`已计手续费 ${money(after.feeAmount)}`],
        };
      }
      return {
        fingerprint: `settled|${after.symbol}|${after.entryOrderId}`,
        // 类型「成交」：一轮买卖走完了。
        category: 'trade',
        // 亏了比赚了更值得看一眼——用「注意」而不是「提示」。
        // 手续费没折算成功也算「有问题」，哪怕这一轮是赚的。
        severity: pnl.net >= 0 && feeNote === null ? 'info' : 'warning',
        oneShot: true,
        // 标题带净盈亏：推送预览里直接看到这一轮赚没赚。
        title: `${after.symbol} 净盈亏 ${money(pnl.net)}`,
        lines: [priceLine, qtyLine, orderLine, round, ...(feeNote === null ? [] : [feeNote])],
        // 金额单独一段并加粗。
        highlights: [
          `毛利 ${money(pnl.gross)}`,
          `手续费 ${money(pnl.fee)}`,
          `净盈亏 ${money(pnl.net)}`,
        ],
      };
    });
  }

  /**
   * 第一段已成交 → 进入移动止损（v0.7.0）。
   *
   * **为什么止损单此时还是有效的**：第一段止盈带数量、止损是 `closePosition`，
   * 而 `closePosition` 的语义是「触发时平掉当时剩余的全部仓位」。减仓之后仓位还在，
   * 所以那张止损单**继续保护剩余仓位**。
   *
   * **三步，顺序固定**：
   *
   * 1. **落「TP1 已成交」这个事实**（`recordBracketTp1Fill`）。它不依赖「能不能算出
   *    移动止损」——成交了就是成交了。少了这一步，推进失败时这一段就**整个没影了**：
   *    成交价、数量、手续费都没记（盈亏少算一段），而且**没有任何东西能证明
   *    「TP1 成交过」**，于是推进失败 → 永远不会被重试 → 记录卡在 `partial_armed`。
   * 2. **落阶段**（`partial_armed` → `trailing`，见 {@link advanceStage}）。
   * 3. **把止损挪到新的一档**（见 {@link moveTrailStop}）：撤旧 → 挂新 → 回填。
   *    （顺序是**撤旧在前**：Binance 不允许同方向同时存在两张 `closePosition` 条件单，
   *    「先挂新」必然被拒——见 {@link moveTrailStop} 的说明。）
   *
   * **先落库再动交易所**：进程死在「已置 `trailing`、还没挪止损」时，记录停在
   * `trailing`、止损还在进场那一档——移动止损定时器下一轮会接着挪
   * （它认领 `tp1_filled_at` 非空的行）。反过来先挪单后落库，
   * 崩在中间就是「交易所挂着新档位、库里记着旧档位」，两者永久对不上。
   *
   * **幂等**：`markBracketTrailing` 的 WHERE 只认 `partial_armed`，
   * 事件重放时第二次拿不到行，不会重复推进、也不会重复挂单。
   */
  async function armTrailing(
    update: OrderTradeUpdate,
    record: BracketRecord,
  ): Promise<HandleOutcome> {
    const key = { exchange, symbol: record.symbol, entryOrderId: record.entryOrderId };
    // 手续费先折算（v0.9.3）。折算失败也不拦着记事实——**成交了就是成交了**，
    // 少算的那一笔由 `feeFields` 里的 0 与 `fee_asset` 痕迹来交代。
    const fee = await commissionInQuote(update);
    // **先落「TP1 已成交」这个事实**，再算移动止损。
    //
    // 幂等（`WHERE tp1_filled_at IS NULL`）：用户数据流会重投事件，重投不重复累加。
    await recordBracketTp1Fill(
      pool,
      key,
      { price: update.lastFilledPrice, qty: update.lastFilledQty, ...feeFields(fee) },
      now(),
    ).catch((error: unknown) => {
      log.error(`${record.symbol} 记录第一段止盈成交事实失败：${reasonOf(error)}`);
    });
    // 通知：第一段止盈成交。
    //
    // **为什么必须有这一条**：分批形态下这一段成交之后，仓位只走了一半。
    // 而「第一段已经兑现」这件事此前**没有任何出口**——`bracket-armed` 是挂单时推的，
    // `bracket-settled` 是**整轮走完**才推的（这一轮还没走完：剩下一半由移动止损了结）。
    // 于是「一半的仓位已经落袋」只存在于库里与日志里，人看不到。
    await notifyTp1Filled(update, record);
    try {
      const policy = await resolvePolicyFor(record.symbol);
      const snapshot = await atr.atrAt(record.symbol, update.tradeTime, record.entryTime, {
        interval: policy.atrInterval,
        period: policy.atrPeriod,
      });
      const plan = await planTrail(record, policy, snapshot);
      const advanced = await advanceStage(record, plan, snapshot);
      if (!advanced) {
        log.info(`${record.symbol} 第一段止盈已在处理中（记录已被推进过），不重复执行`);
        return 'settled';
      }
      log.info(
        `${record.symbol} 第一段止盈已成交，进入移动止损` +
          `（极值 ${plan.extreme}，ATR ${snapshot.atr}）`,
      );

      // 阶段已经落库，接着把止损**真的挪到新的一档**（R-5.4 的后半段）。
      //
      // 挪不动也不影响阶段：记录已经是 `trailing`，移动止损定时器下一轮会接着挪
      // （「阶段推进了、价位还没挪」是**可修**的，而反过来不可修）。
      if (plan.changed) {
        try {
          const result = await moveTrailStop(record, plan, snapshot);
          if (result.moved) {
            log.info(`${record.symbol} 止损已挪到 ${plan.stopPrice}`);
          }
        } catch (error) {
          const reason = `${record.symbol} 推进后换档失败：${reasonOf(error)}`;
          await markBracketTrailNotMoved(pool, key, reason, now(), 'failed').catch(() => undefined);
          log.error(`${reason}（移动止损定时器下一轮会重试）`);
        }
      }
      return 'trailing';
    } catch (error) {
      // 取不到极值 / ATR 时**不能**把记录置成终态：那会留下「账面上已了结、
      // 实际仓位无人跟踪」的一笔仓位，正是 v0.4.0 反复在治的那种分裂。
      // 保留 `partial_armed` 并留下可见原因——**移动止损定时器会重试**：
      // 它认领「TP1 已成交但还没推进」的行（`tp1_filled_at` 非空）。
      const reason = `推进移动止损失败：${reasonOf(error)}`;
      // 「本轮算不出来」不是「换档失败」：极值取不到时定时器会重试，仓位仍受上一档保护。
      // 把它记成 failed，对账就会报一条「移动止损坏了」——而它没坏。
      await markBracketTrailNotMoved(pool, key, reason, now(), 'not-moved').catch(() => undefined);
      log.error(`${record.symbol} ${reason}`);
      return 'failed';
    }
  }

  /**
   * 第一段止盈成交 → 通知（附这一段的成交价与**到目前为止**的净盈亏）。
   *
   * 盈亏由 `core` 的 `realizedPnl()` 算，公式只有一份；库里存的是**事实**
   * （累计平了多少、成交额、手续费），不是算好的金额。
   *
   * 手续费是**整轮**的（入场那笔也算，§6.9.2 第 3 条），所以这里给的是
   * 「这一轮到目前为止」的净盈亏，而不是「这一段单独赚了多少」——
   * 后者要把入场那笔拆开摊，而入场那笔的成本本来就属于这一轮。
   */
  async function notifyTp1Filled(update: OrderTradeUpdate, record: BracketRecord): Promise<void> {
    const after = await readBracket(pool, exchange, record.symbol, record.entryOrderId);
    const pnl =
      after === null
        ? null
        : realizedPnl({
            positionSide: after.positionSide,
            entryPrice: after.entryPrice,
            closedQty: after.closedQty,
            exitNotional: after.exitNotional,
            feeAmount: after.feeAmount,
          });
    const lines = [
      `第一段成交 ${update.lastFilledQty}（${update.lastFilledPrice}）`,
      `入场 ${record.entryPrice}，剩余仓位由移动止损了结`,
      `订单号：入场 ${record.entryOrderId}，出场 ${update.orderId}`,
    ];
    await pushAlert('tp1-filled', () => {
      if (pnl === null) {
        return {
          fingerprint: `tp1-filled|${record.symbol}|${record.entryOrderId}`,
          category: 'trade',
          severity: 'info',
          oneShot: true,
          title: `${record.symbol} 第一段止盈成交`,
          lines: [...lines, '这一段的盈亏暂时算不出来（成交额没拿到）'],
        };
      }
      return {
        fingerprint: `tp1-filled|${record.symbol}|${record.entryOrderId}`,
        // 类型「成交」：这一段确实平掉了。
        category: 'trade',
        // 亏了比赚了更值得看一眼——与「一轮买卖完成」同一口径。
        severity: pnl.net >= 0 ? 'info' : 'warning',
        oneShot: true,
        title: `${record.symbol} 第一段止盈成交，净盈亏 ${money(pnl.net)}`,
        lines,
        highlights: [
          `毛利 ${money(pnl.gross)}`,
          `手续费 ${money(pnl.fee)}`,
          `净盈亏 ${money(pnl.net)}`,
        ],
      };
    });
  }

  /**
   * 移动止损换档 → 通知（附新旧两档的价）。
   *
   * 指纹**只由「哪一笔仓位」决定**，不含档位序号：换档可以发生很多次，
   * 而每一次都算「新指纹」的话，冷却就形同虚设——群里会被同一件事刷屏
   * （§6.9 第 2 条）。于是同一笔仓位在冷却期内只推一次（默认 30 分钟），
   * 冷却期过后再挪，会带上**最新**的价再推一次。
   */
  async function notifyTrailMoved(
    record: BracketRecord,
    plan: TrailPlan,
    snapshot: AtrSnapshot,
    step: number,
    algoId: number,
  ): Promise<void> {
    const prevStop = record.trailStopPrice ?? record.stopPrice;
    await pushAlert('trail-moved', () => ({
      fingerprint: `trail-moved|${record.symbol}|${record.entryOrderId}`,
      // 类型「止盈止损」：这是保护位的变化，不是成交也不是报错。
      category: 'risk',
      severity: 'info',
      // 事件型：换档推过即忘，它下一轮不在了**不代表**出了别的问题。
      oneShot: true,
      title: `${record.symbol} 止损挪到 ${plan.stopPrice}`,
      lines: [
        `${prevStop} → ${plan.stopPrice}`,
        `持仓期极值 ${plan.extreme}，ATR ${snapshot.atr}`,
        `订单号：入场 ${record.entryOrderId}，止损 ${algoId}（第 ${String(step)} 档）`,
      ],
    }));
  }

  /**
   * 由持仓期极值与当前 ATR 算移动止损该挂在哪。
   *
   * 形态检查与算价都在 `deriveTrailingPlan`（纯函数，core）里；这里只负责把
   * 「多空选哪个极值」这个判断翻译进去。**不在这里写第二份公式**——
   * 两份实现的分歧症状是「回测里不亏、实盘亏」，且几乎无法定位。
   */
  async function planTrail(
    record: Pick<
      BracketRecord,
      'symbol' | 'positionSide' | 'entryPrice' | 'entryTime' | 'stopPrice' | 'trailStopPrice'
    >,
    policy: RiskPolicy,
    snapshot: AtrSnapshot,
  ): Promise<TrailPlan> {
    const isLong = record.positionSide === 'LONG';
    const extremeObj = snapshot.extreme;
    if (extremeObj === null) {
      // 极值取不到 → **本轮不移动止损、保留上一档**（v0.7.0 R-6.5）。
      // 它与「ATR 不可用要拒绝下单」严重度不同，所以这里抛的是另一个码。
      //
      // 两条调用路径各自处置：推进到移动止损那条会落进 catch（记录留在 partial_armed，
      // 等移动止损定时器重试）；定时器那条在调用前就判掉 null，走「本轮不调整 + 可见原因」。
      throw new SyncError(
        'RISK_TRAIL_EXTREME_UNAVAILABLE',
        `${record.symbol} 持仓期内还没有已收盘的 ${policy.atrInterval} K 线，持仓期极值取不到；` +
          '本轮不移动止损，保留上一档',
        {
          symbol: record.symbol,
          atrInterval: policy.atrInterval,
          entryTime: record.entryTime,
          segmentTo: snapshot.segmentTo,
        },
      );
    }
    const extreme = isLong ? extremeObj.high : extremeObj.low;
    // 规格现读现用：它与算价必须来自**同一份**快照，而这一层没有可靠的缓存约定。
    const raw = await readContractSpecRaw(pool, exchange, record.symbol);
    const plan = deriveTrailingPlan({
      side: isLong ? 'BUY' : 'SELL',
      prevStop: record.trailStopPrice ?? record.stopPrice,
      extreme,
      atr: snapshot.atr,
      entryPrice: record.entryPrice,
      tickSize: parseTickSize(raw, record.symbol),
      trailAtrMult: policy.trailAtrMult,
      applyBreakeven: policy.breakevenAfterTp1,
      referencePrice: snapshot.lastClose,
    });
    return {
      stopPrice: plan.stopPrice,
      changed: plan.changed,
      reason: plan.reason,
      extreme,
      atrFrom: extremeObj.from,
      atrTo: extremeObj.to,
    };
  }

  /**
   * 交易所上那张止损单**现在的价**。
   *
   * `trail_stop_price` 记的就是这个价——不是「打算挪到的那一档」。
   * 这条口径让「库里记的」与「交易所挂着的」永远是同一件事：
   * 对账（§6.5）直接拿它比价才不会一直报价格不符，
   * 而「阶段推进了、价位还没挪」这一格是**可修**的（定时器下一轮接着挪）。
   */
  function liveStopPrice(record: Pick<BracketRecord, 'stopPrice' | 'trailStopPrice'>): number {
    return record.trailStopPrice ?? record.stopPrice;
  }

  /**
   * 推进阶段：`partial_armed` → `trailing`，同时落**这一轮观测到的**极值与 ATR 快照。
   *
   * 只在**还停在这一态**时推进（`WHERE state = 'partial_armed'`），
   * 所以事件重放不会重复推进、也不会重复挂单。返回 `false` = 「已经有人推进过了」。
   *
   * `stopPrice` 传的是**交易所上那张单的价**，不是这一轮算出来的新档：
   * 新档要等订单真的挂上之后才写（见 {@link moveTrailStop}）。
   *
   * 早先这里直接写新档，于是「库里写着新档、交易所还挂着旧档」那一格**没人能修**：
   * 定时器拿它当基准，算出来「没变」就不动了；而对账会一直报价格不符。
   * 「阶段推进了但价位还没挪」是**可修**的，「价位写了但单没挂」不是。
   */
  async function advanceStage(
    record: BracketRecord,
    plan: TrailPlan,
    snapshot: AtrSnapshot,
  ): Promise<boolean> {
    const key = { exchange, symbol: record.symbol, entryOrderId: record.entryOrderId };
    const advanced = await markBracketTrailing(
      pool,
      key,
      {
        extreme: plan.extreme,
        stopPrice: liveStopPrice(record),
        atr: snapshot.atr,
        atrFrom: plan.atrFrom,
        atrTo: plan.atrTo,
        // **不给 `slAlgoId`**：沿用进场那张止损单（它还在交易所上挂着，仍在保护仓位）。
      },
      now(),
    );
    return advanced > 0;
  }

  /**
   * 把止损挪到新的一档：**撤旧 → 挂新 → 回填**。
   *
   * ## 为什么是「先撤旧」
   *
   * Binance **不允许同一标的、同一方向同时存在两张 `closePosition` 条件单**。
   * 2026-10-22 实测（Demo Trading）：
   *
   * > `An open stop or take profit order with GTE and closePosition in the direction is existing.`
   *
   * 也就是说「先挂新、再撤旧」这条顺序**在 Binance 上根本执行不了**——
   * 挂新那一步必然被拒（旧的还在挂着）。而条件单**没有改价接口**
   * （`PUT /fapi/v1/order` 只支持 LIMIT，条件单已迁到 Algo 端点），
   * 所以想换价只能「撤一张、挂一张」。
   *
   * 代价是两次调用之间的**短暂无保护窗口**（一次 API 往返量级）。
   * 与「止损永远停在入场那一档、移动止损整条线空转」相比，这个代价小得多。
   *
   * ## 三条兜底
   *
   * 1. **撤单失败不中断**：旧单可能还在（撤单本身出错），也可能已经没了
   *    （上一轮撤成功但新单没挂上）。继续往下走，让挂单的成败来裁决。
   * 2. **挂新失败 → 立刻用旧价挂回去**：撤旧已成功而新单没挂上时，仓位是**裸的**。
   *    恢复用的就是刚才那个被接受的价，所以它几乎不会失败。
   * 3. **恢复也失败 → 裸仓**：记下可见原因；对账的 `missing-stop-order`（紧急）
   *    会在下一轮把它报出来。
   */
  async function moveTrailStop(
    record: BracketRecord,
    plan: TrailPlan,
    snapshot: AtrSnapshot,
  ): Promise<{ moved: boolean; failed: boolean }> {
    const key = { exchange, symbol: record.symbol, entryOrderId: record.entryOrderId };
    const observed = {
      extreme: plan.extreme,
      atr: snapshot.atr,
      atrFrom: plan.atrFrom,
      atrTo: plan.atrTo,
    };

    // **先占一个档位号，再挂单**。
    //
    // 为什么必须占：Binance 不允许同时存在两张 `clientAlgoId` 相同的挂单。
    // 2026-10-22 实测踩到：号只由入场单号派生时，**第一次挪就被拒**
    // （`ClientOrderId is duplicated.`），于是止损价永远停在入场那一档，
    // 而账面、交易所、对账三方全绿——移动止损整条线是空转的，且无人能看见。
    //
    // 为什么**先占后用**：换档失败时下一轮要重挂，若沿用同一个号会再撞「重复」，
    // 于是**重试永远失败**，那条线就此卡死。号一旦占掉就作废，哪怕那次下单最终失败。
    const step = await reserveTrailStep(pool, key, now());
    if (step === null) {
      // 拿不到号 = 记录已经不在移动止损阶段（多半是止损刚成交、记录已收敛）。
      // 此时**不许再挂单**：给一个已经平掉的仓位挂止损，会在交易所上
      // 留下一张没人认领的单。
      log.info(`${record.symbol} 记录已不在移动止损阶段，本轮不再挂止损单`);
      return { moved: false, failed: false };
    }

    const oldStop = record.trailStopPrice ?? record.stopPrice;

    // ① 撤旧。**失败不中断**——旧单可能还在（撤单本身出错），也可能已经没了
    //    （上一轮撤成功但新单没挂上）。继续往下走，让挂单的成败来裁决。
    let cancelError: unknown = null;
    if (record.slAlgoId !== null) {
      try {
        await placer.cancelAlgoOrder(record.slAlgoId);
      } catch (caught) {
        cancelError = caught;
        log.warn(
          `${record.symbol} 撤旧止损（${record.slAlgoId}）失败，继续尝试挂新：${reasonOf(caught)}`,
        );
      }
    }

    // ② 挂新。
    let placed: { algoId: number };
    try {
      placed = await placer.placeClosePositionOrder({
        symbol: record.symbol,
        side: record.positionSide === 'LONG' ? 'SELL' : 'BUY',
        type: 'STOP_MARKET',
        stopPrice: plan.stopPrice,
        clientAlgoId: bracketClientOrderId(SL_TAG, record.entryOrderId, step),
        workingType: settings.workingType,
        priceProtect: settings.priceProtect,
      });
    } catch (placeError) {
      return await recoverFromFailedMove(record, plan, observed, oldStop, cancelError, placeError);
    }

    // ③ 撤旧失败过、而新单挂上了：交易所上现在有两张止损单。
    //    旧单撤不掉就只能留着——它仍在保护仓位，但账面指向哪一张要说清楚。
    if (cancelError !== null) {
      const reason =
        `${record.symbol} 撤旧止损（${record.slAlgoId}）失败，新档 ${plan.stopPrice} 的单 ` +
        `${placed.algoId} 已挂上（交易所上可能有两张止损单）：${reasonOf(cancelError)}`;
      await markBracketTrailNotMoved(pool, key, reason, now(), 'failed', {
        ...observed,
        slAlgoId: placed.algoId,
      });
      log.warn(reason);
      await notifyTrailMoved(record, plan, snapshot, step, placed.algoId);
      return { moved: false, failed: true };
    }

    await markBracketTrailMoved(
      pool,
      key,
      { stopPrice: plan.stopPrice, slAlgoId: placed.algoId, ...observed },
      now(),
    );
    // 通知：止损挪了。附新旧两档的价——「挪到哪了」比「挪了」有用得多。
    await notifyTrailMoved(record, plan, snapshot, step, placed.algoId);
    return { moved: true, failed: false };
  }

  /**
   * 挂新单失败后的恢复：**立刻用旧价把止损挂回去**。
   *
   * 什么时候会走到这里：撤旧成功了、而新单没挂上——此时仓位**当前没有止损**，
   * 是这个仓库里最危险的一种状态（「裸仓」）。恢复用的就是刚才被交易所接受的旧价，
   * 所以它几乎不会失败。
   *
   * 恢复也失败时：要么旧单其实还在（撤单报错、没撤掉），仓位仍受保护；
   * 要么真的裸了。对账的 `missing-stop-order`（紧急）会在下一轮把后者报出来。
   */
  async function recoverFromFailedMove(
    record: BracketRecord,
    plan: TrailPlan,
    observed: { extreme: number; atr: number; atrFrom: number; atrTo: number },
    oldStop: number,
    cancelError: unknown,
    placeError: unknown,
  ): Promise<{ moved: boolean; failed: boolean }> {
    const key = { exchange, symbol: record.symbol, entryOrderId: record.entryOrderId };
    const reason =
      `${record.symbol} 换档失败（目标 ${plan.stopPrice} 的单没挂上）：${reasonOf(placeError)}` +
      (cancelError === null ? '' : `；撤旧也失败：${reasonOf(cancelError)}`);

    // 恢复用的号也要新的：刚才那个号可能已经被交易所记下了。
    const restoreStep = await reserveTrailStep(pool, key, now());
    let restoredAlgoId: number | null = null;
    if (restoreStep !== null) {
      try {
        const restored = await placer.placeClosePositionOrder({
          symbol: record.symbol,
          side: record.positionSide === 'LONG' ? 'SELL' : 'BUY',
          type: 'STOP_MARKET',
          stopPrice: oldStop,
          clientAlgoId: bracketClientOrderId(SL_TAG, record.entryOrderId, restoreStep),
          workingType: settings.workingType,
          priceProtect: settings.priceProtect,
        });
        restoredAlgoId = restored.algoId;
        log.warn(`${reason}；已把旧档 ${oldStop} 挂回去（条件单 ${restored.algoId}）`);
      } catch (restoreError) {
        log.error(
          `${reason}；**恢复旧档 ${oldStop} 也失败了**（${reasonOf(restoreError)}）——` +
            '仓位当前可能没有止损单，需要人工确认',
        );
      }
    }

    await markBracketTrailNotMoved(pool, key, reason, now(), 'failed', {
      ...observed,
      ...(restoredAlgoId === null ? {} : { slAlgoId: restoredAlgoId }),
    });
    return { moved: false, failed: true };
  }

  /**
   * 本次要用哪一套策略参数。解析失败**不静默回落**到配置值：那会让用户以为页面上的
   * 设置生效了，实际挂出去的是另一套倍数（AGENTS.md 约定 9）。调用方负责处理抛出的错。
   */
  async function resolvePolicyFor(symbol: string): Promise<RiskPolicy> {
    if (!deps.resolvePolicy) {
      return {
        atrPeriod: settings.atrPeriod,
        atrInterval: settings.atrInterval,
        stopAtrMult: settings.stopAtrMult,
        takeProfitAtrMult: settings.takeProfitAtrMult,
        takeProfit1Ratio: settings.takeProfit1Ratio,
        trailAtrMult: settings.trailAtrMult,
        breakevenAfterTp1: settings.breakevenAfterTp1,
      };
    }
    return deps.resolvePolicy(symbol);
  }

  /**
   * 这笔成交后的净持仓：**流内增量**，不出网。
   *
   * 种子来自启动时的 `positionRisk`（`main.ts` 播种），之后每笔成交按 `lastFilledQty`
   * 加减。单向持仓模式下这与交易所的净额**逐笔等价**，因为账户上的每一笔成交
   * （手动下的也包括）都会出现在用户数据流里。
   *
   * 为什么不每笔都查 `positionRisk`：那条路慢、吃配额，而且实测会被本机时钟偏差
   * 整个打挂（见 `packages/core/src/clock-skew.ts`）——三笔真实成交曾因此一笔保护都没挂上。
   *
   * 标的**没播种过**时按 0 起算：这是唯一可辩护的初值（没有历史成交 ⇒ 净额为 0），
   * 且 `main.ts` 在每次重连后都会重新播种，把「断线期间漏掉成交」的窗口压到最小。
   */
  function netPosition(update: OrderTradeUpdate): FillApplication {
    return positions.applyFill(
      update.symbol,
      signedFillDelta(update.side, update.lastFilledQty),
      update.tradeTime,
    );
  }

  /**
   * 推一条告警。
   *
   * **绝不抛错**：通知是辅助出口，它挂了不许影响下单与记账（AGENTS.md 约定 9）。
   * 失败只记日志——但要**看得见**，不静默吞掉。
   *
   * 「推不推」由**当前生效的设置**决定（`channel.kinds`）：用户没勾的内容类型
   * 一律不推，过滤与周期对账走的是同一套机制。
   */
  async function pushAlert(
    topic: 'bracket-armed' | 'bracket-settled' | 'llm-fallback' | 'tp1-filled' | 'trail-moved',
    build: () => AlertItem,
  ): Promise<void> {
    const alerts = deps.alerts;
    if (alerts === undefined) return;
    try {
      const result = await alerts.dispatch(
        (channel: AlertChannel) => {
          if (!channel.kinds.includes(topic)) return [];
          return [build()];
        },
        // 作用域 = 内容类型：各类型的记账分开，
        // 推「移动止损换档」不会把对账差异当成「问题消失了」。
        topic,
      );
      // **成功也记一笔**：此前只有失败才留痕，于是「推没推出去」从日志里看不出来——
      // 而「以为推了其实没推」正是这个仓库最忌讳的那种状态。
      if (result.sent > 0) {
        log.info(`告警已推送（${topic}）：发出 ${String(result.sent)} 条`);
      }
    } catch (error) {
      log.error(`告警推送失败（不影响下单）：${reasonOf(error)}`);
    }
  }

  /**
   * 仓位被**工具外**平掉：把这个标的未终结的记录收敛成 `cancelled`。
   *
   * 为什么必须有这条：`cancelled` 在 DDL、类型和界面上都存在，却没有任何写入方
   * （`markBracketSettled` 此前只接受 `take_profit` / `stop_loss`）。于是在交易所
   * App 上按一次平仓，本地就永远停在 `armed`，之后每 5 分钟报一次
   * `missing-stop-order`（紧急），而且这条僵尸记录还会在反向仓位存在时替它「顶包」，
   * 把 `record-without-position` 一并掩盖掉——账面看起来正常，仓位其实无人跟踪。
   *
   * 行**不删**：`(exchange, symbol, entry_order_id)` 是幂等锚点，删了行，
   * 万一该入场订单的事件被重放，`claimBracket` 的 `ON CONFLICT DO NOTHING` 就挡不住重复挂单。
   */
  async function closeOutside(symbol: string, source: string): Promise<HandleOutcome> {
    const records = await listUnsettledBrackets(pool, exchange, symbol);
    if (records.length === 0) return 'ignored';
    for (const record of records) {
      await markBracketSettled(
        pool,
        { exchange, symbol: record.symbol, entryOrderId: record.entryOrderId },
        'cancelled',
        now(),
      );
    }
    log.info(
      `${symbol} 仓位已被工具外平掉（${source}），` +
        `${records.length} 条未终结记录置为 cancelled`,
    );
    return 'external-close';
  }

  async function placePair(update: OrderTradeUpdate, plan: StagedPlan): Promise<HandleOutcome> {
    const entryOrderId = String(update.orderId);
    const key = { exchange, symbol: update.symbol, entryOrderId };
    const workingType = settings.workingType;
    const priceProtect = settings.priceProtect;

    // 先挂**止盈**、再挂**止损**：反过来的话，止盈挂上后止损失败、
    // 我们连一张可以撤的单都没有，仓位直接裸奔。
    let tpAlgoId: number | undefined;
    let slAlgoId: number | undefined;
    try {
      // 止盈单的三种形态只在这一处分叉（`mode` 是纯函数给的，不在这里判断比例）：
      //   * single —— 全平 `closePosition`，v0.4.0 行为，交易所负责自动撤单；
      //   * full   —— 全平 `closePosition`，但用第一段的价；同样不需要本地撤单；
      //   * partial—— 带数量 + reduceOnly，**放弃**自动撤单，由本地在净额归零时撤。
      const tp =
        plan.mode === 'partial' && plan.tp1Qty !== null
          ? await placer.placeQuantityOrder({
              symbol: update.symbol,
              side: plan.exitSide,
              type: 'TAKE_PROFIT_MARKET',
              stopPrice: plan.takeProfitPrice,
              quantity: plan.tp1Qty,
              reduceOnly: true,
              clientAlgoId: bracketClientOrderId(TP_TAG, entryOrderId),
              workingType,
              priceProtect,
            })
          : await placer.placeClosePositionOrder({
              symbol: update.symbol,
              side: plan.exitSide,
              type: 'TAKE_PROFIT_MARKET',
              // `takeProfitPrice` 就是这一形态**实际挂出去**的价：
              // single 用整段倍数算，full 用第一段倍数算（纯函数里已统一）。
              stopPrice: plan.takeProfitPrice,
              clientAlgoId: bracketClientOrderId(TP_TAG, entryOrderId),
              workingType,
              priceProtect,
            });
      tpAlgoId = tp.algoId;
      const sl = await placer.placeClosePositionOrder({
        symbol: update.symbol,
        side: plan.exitSide,
        type: 'STOP_MARKET',
        stopPrice: plan.stopPrice,
        clientAlgoId: bracketClientOrderId(SL_TAG, entryOrderId),
        workingType,
        priceProtect,
      });
      slAlgoId = sl.algoId;
    } catch (error) {
      // 撤掉可能已经挂上的那张：留一张没有对单的止盈/止损，比两张都没有更糟。
      let cancelNote = '';
      const algoId = tpAlgoId ?? slAlgoId;
      if (algoId !== undefined) {
        try {
          await placer.cancelAlgoOrder(algoId);
          cancelNote = `；已撤掉先挂上的条件单 ${algoId}`;
        } catch (cancelError) {
          cancelNote = `；**撤单也失败了**（条件单 ${algoId} 可能仍在交易所挂着）：${reasonOf(cancelError)}`;
        }
      }
      const reason = `${reasonOf(error)}${cancelNote}`;
      await markBracketFailed(
        pool,
        key,
        {
          ...(tpAlgoId !== undefined ? { tpAlgoId } : {}),
          ...(slAlgoId !== undefined ? { slAlgoId } : {}),
        },
        reason,
        now(),
      );
      log.error(`${update.symbol} 挂止盈止损失败：${reason}`);
      return 'failed';
    }

    if (plan.mode === 'partial') {
      await markBracketPartialArmed(
        pool,
        key,
        { tp1AlgoId: tpAlgoId as number, slAlgoId: slAlgoId as number },
        now(),
      );
    } else {
      await markBracketArmed(
        pool,
        key,
        { tpAlgoId: tpAlgoId as number, slAlgoId: slAlgoId as number },
        now(),
      );
    }
    log.info(`${update.symbol} 止盈止损已挂上：${describeStaged(plan)}`);

    // 通知：挂上了。附**预估**收益与预估亏损（计价币）。
    //
    // 预估口径随形态而变：`single` / `full` 是整段打到止盈；`partial` 只有第一段
    // 有确定的价格，剩余仓位由移动止损了结——那一段的价格会随行情上移，因此
    // 这里只报「第一段的收益」与「整段打到当前止损的亏损」。
    //
    // 两种形态挂出去的止盈价都是 `takeProfitPrice`：`partial` 下它是第一段的价
    // （带数量的那张单），`single` 下它是全平那张单的价。
    const takeProfitPrice = plan.takeProfitPrice;
    const takeProfitQty = plan.mode === 'partial' ? (plan.tp1Qty ?? 0) : update.cumulativeQty;
    const estimate = estimateBracketPnl({
      positionSide: plan.positionSide,
      entryPrice: update.averagePrice,
      quantity: takeProfitQty,
      takeProfitPrice,
      stopPrice: plan.stopPrice,
    });
    const stopEstimate = estimateBracketPnl({
      positionSide: plan.positionSide,
      entryPrice: update.averagePrice,
      quantity: update.cumulativeQty,
      takeProfitPrice,
      stopPrice: plan.stopPrice,
    });
    await pushAlert('bracket-armed', () => ({
      fingerprint: `armed|${update.symbol}|${entryOrderId}`,
      // 类型「止盈止损」：消息列表里只看得到标题，这一眼要能分清是哪种推送。
      category: 'risk',
      severity: 'info',
      // 一次性事件：下一轮它不在了，**不代表**「问题恢复了」，因此不参与恢复判定。
      oneShot: true,
      // 标题带上止盈/止损价：推送预览里就能看到关键数字，不用点开。
      title: `${update.symbol} 止盈 ${takeProfitPrice} / 止损 ${plan.stopPrice}`,
      lines: [
        `入场 ${update.averagePrice} × ${update.cumulativeQty}（${
          plan.positionSide === 'LONG' ? '多头' : '空头'
        }）`,
        // 订单号是**排查用的钥匙**：出问题时拿着它去交易所的订单记录里查，
        // 不用靠「哪个标的、什么时候」去猜是哪一张单。
        `订单号：入场 ${entryOrderId}，止盈 ${tpAlgoId}，止损 ${slAlgoId}`,
        ...(plan.mode === 'partial' ? ['剩余仓位由移动止损了结，止损位只上移不放宽'] : []),
      ],
      // 金额单独一段并加粗。
      highlights: [
        `预估收益 +${money(estimate.expectedProfit)}`,
        `预估亏损 -${money(stopEstimate.expectedLoss)}`,
      ],
    }));

    return 'armed';
  }

  /**
   * LLM 决策（v0.9.0）。返回 `null` 表示「按用户要求，不挂单」。
   *
   * 三条路径：
   *   * 没配 `decider` → 返回 `source='config'` 的结果，**不做任何 IO**，
   *     行为与 v0.9.0 之前逐字一致。
   *   * 模型给出可用档位 → `source='llm'`。
   *   * 模型失败 / 越界 / 自相矛盾 → `source='config-fallback'` + 原因。
   *     降级时**同时**告警，让「模型连续不生效」这件事不必翻日志才能发现。
   */
  /**
   * 反查这笔成交是不是按 Agent 方案下的（v1.0.0 自动下单）。
   *
   * **查不到不抛错**：查失败时继续往下走，用配置档位挂单。
   *
   * 为什么不是「抛错不挂单」：挂不上单意味着**仓位裸奔**——那是这个仓库
   * 最贵的一种状态。而查失败只是「档位可能不是批准时那一套」。
   * 仓位有保护比档位完全对得上更要紧，因此选前者，但**必须留一条显眼的错误日志**：
   * 人会看到「这笔按方案下的单挂的止损不是方案里的档位」。
   */
  async function resolveAgentPlan(update: OrderTradeUpdate): Promise<AgentPlanDecision | null> {
    if (deps.resolveAgentPlan === undefined) return null;
    try {
      return await deps.resolveAgentPlan(update);
    } catch (error) {
      log.error(
        `${update.symbol} 反查 Agent 方案失败（本次按配置档位挂单，与批准的方案可能不一致）：` +
          reasonOf(error),
      );
      return null;
    }
  }

  async function decideForBracket(
    update: OrderTradeUpdate,
    policy: RiskPolicy,
    snapshot: AtrSnapshot,
  ): Promise<DecideOutput> {
    /**
     * Agent 方案（v1.0.0 自动下单）**优先于**配置与模型。
     *
     * 为什么优先：这份成交是**人批准过的方案**下的，方案里的档位是批准时
     * 看到的（而配置档位随时会被改）。让人批准的数和实际挂单的数不是同一个，
     * 那批准就等于没批准。
     *
     * 价格的算法仍然一样：这里给的是**倍数**，价格由 `deriveStagedPlan`
     * 按**实际成交价**算。方案里的进场价是估算值，用它算会把止损挂在错的位置。
     */
    const agentPlan = await resolveAgentPlan(update);
    if (agentPlan !== null) {
      log.info(
        `${update.symbol} 这笔成交按 Agent 方案 #${agentPlan.planId} 的档位挂单：` +
          `止损 ${String(agentPlan.stopAtrMult)}×ATR、止盈 ${String(agentPlan.takeProfitAtrMult)}×ATR`,
      );
      return {
        decision: {
          stopAtrMult: agentPlan.stopAtrMult,
          takeProfitAtrMult: agentPlan.takeProfitAtrMult,
          // 方案不分批：它只给了一个止盈价，没有「第一段减仓」这回事。
          takeProfit1Ratio: 0,
          // 移动止损的档位与「第一段成交后保本」都由配置决定：
          // 方案没提这两件事，而不分批形态下它们本来也不参与。
          trailAtrMult: policy.trailAtrMult,
          breakevenAfterTp1: policy.breakevenAfterTp1,
        },
        source: 'agent-plan',
        refuse: false,
        rationale: agentPlan.rationale,
      };
    }

    if (deps.decider === undefined) {
      return {
        decision: {
          stopAtrMult: policy.stopAtrMult,
          takeProfitAtrMult: policy.takeProfitAtrMult,
          takeProfit1Ratio: policy.takeProfit1Ratio,
          trailAtrMult: policy.trailAtrMult,
          breakevenAfterTp1: policy.breakevenAfterTp1,
        },
        source: 'config',
        refuse: false,
      };
    }

    // 近期收益率：喂给模型看走势。读不到**不影响**决策——
    // 它只是一个参考维度，不是必需输入（AGENTS.md 约定 8 的边界：
    // 缺的是「必需输入」，不是「锦上添花的上下文」）。
    //
    // LLM 没开时**不去读**：那是一次白费的数据库查询，而没有模型要喂。
    let recentReturns: readonly number[] = [];
    if (deps.readRecentReturns !== undefined && settings.llm.enabled) {
      try {
        recentReturns = await deps.readRecentReturns(update.symbol, settings.llm.contextBars);
      } catch (error) {
        log.warn(`${update.symbol} 读近期 K 线失败，模型少一个参考维度：${reasonOf(error)}`);
        recentReturns = [];
      }
    }

    const outcome = await deps.decider.decide({
      symbol: update.symbol,
      side: update.side,
      entryPrice: update.averagePrice,
      atr: snapshot.atr,
      atrPeriod: snapshot.period,
      atrInterval: snapshot.interval,
      baseline: {
        stopAtrMult: policy.stopAtrMult,
        takeProfitAtrMult: policy.takeProfitAtrMult,
        takeProfit1Ratio: policy.takeProfit1Ratio,
        trailAtrMult: policy.trailAtrMult,
        breakevenAfterTp1: policy.breakevenAfterTp1,
      },
      recentReturns,
    });

    // 降级必须可见：除了落库（`decision_fallback_reason`），还要能被告警看到。
    if (outcome.source === 'config-fallback') {
      // 两种降级的**后果完全不同**，告警文案必须说清是哪一种：
      //   * 兜底挂单 → 仓位仍受保护（降级成功）；
      //   * 拒绝挂单 → **仓位是裸的**（`fallbackToPolicy=false`）。
      // 混成一句话就等于没告警——读到「仓位仍受保护」的人不会去查仓位。
      await pushAlert('llm-fallback', () => ({
        fingerprint: `llm-fallback|${update.symbol}`,
        // 类型「报错」：这一轮是决策没能用上（降级或拒绝），不是成交也不是止盈止损。
        category: 'error',
        severity: outcome.refuse ? 'critical' : 'warning',
        // **事件型**：降级是「这一轮发生的事」，推过即忘。
        // 不设 oneShot 的话，下一次推别的事件时它会被当成「问题消失了」而补一条
        // 「已恢复：…降级」——那是纯属虚构的消息（派发器按指纹记账，不按事件）。
        oneShot: true,
        title: outcome.refuse
          ? `${update.symbol} LLM 决策失败且不降级：本次没有挂任何保护单`
          : `${update.symbol} LLM 决策降级到配置档位`,
        lines: [
          `原因：${outcome.fallbackReason ?? '未知'}`,
          // 单号：降级这一轮对应的是哪一笔入场，查仓位时用得上。
          `订单号：入场 ${String(update.orderId)}`,
          outcome.refuse
            ? '按配置 llm.fallbackToPolicy=false，本次**没有挂单**——仓位当前是裸的，需要人工处理。'
            : '本次止盈止损按 risk_policy 的档位挂出，仓位仍受保护。',
        ],
      }));
    }

    return outcome;
  }

  async function openBracket(update: OrderTradeUpdate): Promise<HandleOutcome> {
    const entryOrderId = String(update.orderId);
    const key = { exchange, symbol: update.symbol, entryOrderId };

    /**
     * 记一笔「因为拿不到可用参数而没挂上」的成交。
     *
     * 之所以占坑而不是只写日志：用户数据流不重放历史，只看日志会以为
     * 「这笔成交没发生」。库里留下一条 `failed` 行，才是**看得见的失败**
     *（AGENTS.md 约定 9）。`atr` 落占位值是因为表上有 `atr > 0` 的 CHECK——
     * 没有 ATR 就不能声称算出了止盈止损，权威信息在 `last_error` 里。
     */
    async function recordRejected(reason: string, decision?: DecideOutput): Promise<HandleOutcome> {
      const claimed = await claimBracket(pool, {
        exchange,
        symbol: update.symbol,
        entryOrderId,
        entryPrice: update.averagePrice,
        entryTime: update.tradeTime,
        filledQty: update.cumulativeQty,
        positionSide: 'LONG',
        atr: Number.MIN_VALUE,
        atrPeriod: settings.atrPeriod,
        atrInterval: settings.atrInterval,
        atrWindowFrom: update.tradeTime,
        atrWindowTo: update.tradeTime,
        stopPrice: update.averagePrice,
        takeProfit: update.averagePrice,
        // v0.9.0：把**这次为什么没挂上**也记下来。拒绝下单时那次决策的来源与
        // 原因要一起落库，否则「模型失败导致裸仓」这件事在库里看不出来。
        ...(decision === undefined
          ? {}
          : {
              decision: {
                source: decision.source,
                ...(decision.rationale === undefined ? {} : { rationale: decision.rationale }),
                ...(decision.fallbackReason === undefined
                  ? {}
                  : { fallbackReason: decision.fallbackReason }),
                ...(decision.raw === undefined ? {} : { raw: decision.raw }),
                at: now(),
              },
            }),
        now: now(),
      });
      if (claimed === null) return 'duplicate';
      await markBracketFailed(pool, key, {}, reason, now());
      return 'failed';
    }

    if (!inScope(update.symbol)) return 'ignored';

    /**
     * 本次成交要用哪一套参数。解析失败**不静默回落**到配置值：那会让用户以为
     * 页面上的设置生效了，实际挂出去的是另一套倍数。宁可这笔成交被拒并留下
     * 一条看得见的 failed 行（AGENTS.md 约定 9）。
     */
    let policy: RiskPolicy;
    try {
      policy = await resolvePolicyFor(update.symbol);
    } catch (error) {
      const outcome = await recordRejected(`策略解析失败：${reasonOf(error)}`);
      log.error(`${update.symbol} 策略解析失败：${reasonOf(error)}`);
      return outcome;
    }
    if (settings.maxEntryNotional > 0) {
      const notional = update.averagePrice * update.cumulativeQty;
      if (notional > settings.maxEntryNotional) {
        const reason = `成交金额 ${notional} 超过上限 ${settings.maxEntryNotional}`;
        const outcome = await recordRejected(reason);
        log.warn(`${update.symbol} 跳过：${reason}`);
        return outcome;
      }
    }

    // ATR 取不到（库里的 K 线还不够 / 有缺口）。先留记录再返回，
    // 绝不换个周期或拿 0 顶替——止损位等于入场价就是当场平仓。
    let snapshot;
    try {
      snapshot = await atr.atrAt(update.symbol, update.tradeTime, update.tradeTime, {
        interval: policy.atrInterval,
        period: policy.atrPeriod,
      });
    } catch (error) {
      const outcome = await recordRejected(`ATR 不可用：${reasonOf(error)}`);
      log.error(`${update.symbol} ATR 不可用：${reasonOf(error)}`);
      return outcome;
    }

    const raw = await readContractSpecRaw(pool, exchange, update.symbol);
    const tickSize = parseTickSize(raw, update.symbol);

    /**
     * LLM 决策（v0.9.0）。**在算价之前**，因为它决定的是「用哪几个倍数」。
     *
     * 位置很要紧：这个调用会占用「成交 → 挂单」之间的裸仓窗口（模型响应时间）。
     * 它必须发生在**算价之前**（算价要用倍数），也必须发生在**占坑之前**——
     * 占坑是幂等锚点，在那之前出岔子还可以干净地失败重试。
     *
     * 没配 `decider` 时整段跳过，行为与 v0.9.0 之前逐字一致。
     */
    const decision = await decideForBracket(update, policy, snapshot);
    if (decision.refuse) {
      // `fallbackToPolicy=false` 且模型这一轮没给出可用档位：
      // 用户明确选择了「宁可不挂也不要按配置挂」。照做，留一条看得见的 failed 行，
      // 并把这次失败的决策也记进去（否则事后查不出「是模型失败导致没挂单」）。
      const reason =
        decision.fallbackReason !== undefined
          ? `LLM 决策未产出可用档位，且配置要求不降级（llm.fallbackToPolicy=false）：${
              decision.fallbackReason
            }`
          : 'LLM 决策未产出可用档位，且配置要求不降级（llm.fallbackToPolicy=false）';
      const outcome = await recordRejected(reason, decision);
      log.error(`${update.symbol} ${reason}`);
      return outcome;
    }
    // 把决策合并进策略：模型覆盖倍数，方法与取数口径保持不变。
    const effective = applyDecision(policy, decision);

    // 分批形态要按 `stepSize` 对齐数量，而止损/止盈价仍按 `tickSize`。
    // 两个步长取自**同一份** exchangeInfo 快照（`raw`），不做两次查询。
    const plan = deriveStagedPlan({
      side: update.side,
      entryPrice: update.averagePrice,
      atr: snapshot.atr,
      atrPeriod: snapshot.period,
      stopAtrMult: effective.stopAtrMult,
      takeProfitAtrMult: effective.takeProfitAtrMult,
      takeProfit1Ratio: effective.takeProfit1Ratio,
      tickSize,
      // 只在分批形态才读 LOT_SIZE；不分批时止盈单不带数量，不需要这个步长。
      ...(effective.takeProfit1Ratio > 0 && effective.takeProfit1Ratio < 1
        ? { stepSize: parseStepSize(raw, update.symbol) }
        : {}),
      filledQty: update.cumulativeQty,
    });
    lastPlan = plan;

    /**
     * 同一标的**已经有未终结的保护**时不再挂第二套。
     *
     * `claimBracket` 的幂等键是 `(exchange, symbol, entry_order_id)`，它防的是
     * 「同一个入场订单被重复处理」，**不防**「同一个仓位被挂了两套保护」。而两张单都是
     * `closePosition=true`、不带数量——它们保护的不是各自那一笔，而是**当时全部净仓位**。
     * 于是加仓或反手会得到两套触发价重叠的保护：同一仓位上有 2–4 个触发价，
     * 且它们互相撤销、互相触发。
     *
     * 这里选择**跳过并留下可见的记录**而不是自动改写旧记录，理由与 §6.3 一致：
     * 挂单与撤单都不可逆，而「加仓之后止损该不该移动」是策略决策，不是程序该擅自做的
     * （AGENTS.md 约定 9）。旧记录仍留在库里，对账会照常把它算作未终结，
     * 不会因为这次跳过就消失。
     *
     * **必须排除同一笔入场订单自己**：事件重放走的是 `entryOrderId` 相同的那条路，
     * 那是幂等（下游 `claimBracket` 的 `ON CONFLICT DO NOTHING` 才是它的唯一实现点），
     * 不是「这个仓位已经有别的保护了」。把它一并拦掉会把重放报成跳过，掩盖真正的原因。
     */
    const unsettled = await listUnsettledBrackets(pool, exchange, update.symbol);
    const conflicting = unsettled.filter((r) => r.entryOrderId !== entryOrderId);
    if (conflicting.length > 0) {
      const ids = conflicting.map((r) => r.entryOrderId).join('、');
      log.warn(
        `${update.symbol} 订单 ${entryOrderId} 是新开仓（净持仓方向 ${plan.positionSide}），` +
          `但该标的存在未终结的止盈止损记录 ${ids}：跳过挂单。` +
          `条件单保护的是整个净仓位，重复挂会让同一仓位出现多组触发价。`,
      );
      return 'skipped-existing-bracket';
    }

    // 入场这笔的手续费也是这一轮的成本：只扣出场那笔，收益会算虚高。
    // 先折成计价币（v0.9.3）：BNB 计价的手续费按原数量记进去会差几百倍。
    const fee = await commissionInQuote(update);
    // 占坑。冲突 = 已处理过，直接跳过——幂等的唯一实现点。
    const claimed = await claimBracket(pool, {
      exchange,
      symbol: update.symbol,
      entryOrderId,
      entryPrice: update.averagePrice,
      entryTime: update.tradeTime,
      filledQty: update.cumulativeQty,
      positionSide: plan.positionSide,
      entryFeeAmount: fee.amount,
      ...(fee.asset === null ? {} : { entryFeeAsset: fee.asset }),
      ...(fee.fxRate === null ? {} : { entryFeeFxRate: fee.fxRate }),
      atr: snapshot.atr,
      atrPeriod: snapshot.period,
      atrInterval: snapshot.interval,
      atrWindowFrom: snapshot.segmentFrom,
      atrWindowTo: snapshot.segmentTo,
      stopPrice: plan.stopPrice,
      takeProfit: plan.takeProfitPrice,
      // 决策留痕（v0.9.0）：这次挂单用的档位是从哪来的、具体是哪些倍数。
      // 落了它，事后才能回答「当时为什么止损在那个价」——而 `risk_policy`
      // 是可变的，不留这份快照就永远答不出来。
      decision: {
        source: decision.source,
        decision: decision.decision,
        ...(decision.rationale === undefined ? {} : { rationale: decision.rationale }),
        ...(decision.fallbackReason === undefined
          ? {}
          : { fallbackReason: decision.fallbackReason }),
        ...(decision.raw === undefined ? {} : { raw: decision.raw }),
        at: now(),
      },
      // 分批形态才带；其余形态这三项保持 undefined → 落库 NULL，
      // 而 `partial_armed` 的 CHECK 会要求它们齐全（漏了写不进去）。
      // `tp1Price` 与 `takeProfitPrice` 同值：合并成一个止盈倍数之后只有一种止盈价，
      // 这一列记的是「第一段那张单的触发价」，`take_profit` 记的是「这个仓位的止盈价」。
      ...(plan.mode === 'partial' && plan.tp1Qty !== null
        ? { tp1Qty: plan.tp1Qty, tp1Price: plan.takeProfitPrice }
        : {}),
      now: now(),
    });
    if (claimed === null) {
      log.info(`${update.symbol} 订单 ${entryOrderId} 已有止盈止损记录，跳过（事件重放）`);
      return 'duplicate';
    }

    return placePair(update, plan);
  }

  return {
    get lastPlan(): StagedPlan | null {
      return lastPlan;
    },

    async handleFill(update: OrderTradeUpdate): Promise<HandleOutcome> {
      // 1) 只认真撮合（TRADE）；状态类事件（NON_TRADE）不代表成交。
      if (update.executionType !== 'TRADE') return 'ignored';

      // 2) 我们自己的止盈/止损成交 → 落最终状态。这条判断必须在方向判断**之前**：
      //    止盈止损单的方向与入场方向相反，先判方向会把自己的平仓当成别人的开仓。
      const own = parseBracketClientOrderId(update.clientOrderId);
      if (own) return settle(update, own.entryOrderId, own.tag);

      // 3) 仓位事实决定这一笔是「开仓 / 减仓 / 平仓」。
      //
      //    v0.4.0 只看方向（`side !== 'BUY'` 即忽略），那在只做多时成立，因为 SELL
      //    一定是减仓。**支持做空之后它就错了**：开空仓也是 SELL。于是方向必须让位给
      //    净仓位的符号——交易所的事实，而不是我们对方向的猜测。
      const { positionAfter, applied } = netPosition(update);
      if (!applied) {
        // 这笔成交的效果已经包含在一次 ACCOUNT_UPDATE 校正里（撮合时间不晚于它）。
        // 净额不能再动——实測中正是这里凭空造出了反向仓位。
        log.info(
          `${update.symbol} 订单 ${update.orderId} 的成交已计入先前的一次 ACCOUNT_UPDATE 校正，` +
            `不再重复累加（净额维持 ${positionAfter}）`,
        );
      }
      const verdict = classifyFill({
        side: update.side,
        delta: signedFillDelta(update.side, update.lastFilledQty),
        positionAfter,
      });

      //    净持仓归零 = 仓位没了。而第 2 步已排除我方 TP/SL，所以只能是工具外平仓。
      if (verdict === 'closed') return closeOutside(update.symbol, `订单 ${update.orderId} 成交`);

      //    减仓：在原有仓位上加仓，由它自己的单触发。
      if (verdict === 'reduced') return 'ignored';

      // 4) 成交门槛。全额成交总是处理；部分成交只在 accumulate 模式下处理，
      //    否则「建仓到一半、止损位按半个仓位的均价算一次」会把仓位保护在半路上。
      if (update.status === 'PARTIALLY_FILLED') {
        if (settings.onPartialFill !== 'accumulate') return 'partial-skipped';
      } else if (update.status !== 'FILLED') {
        return 'ignored';
      }

      return openBracket(update);
    },

    /**
     * 用 `ACCOUNT_UPDATE` 校正本地净仓位。
     *
     * 这是**校正**不是**来源**：官方只保证同一事件类型内部有序，`ACCOUNT_UPDATE`
     * 与 `ORDER_TRADE_UPDATE` 之间没有顺序保证，因此成交处理不能等它。
     * 但它带的是权威值，会把任何漂移（尤其是断线期间漏成交造成的）拉回来。
     *
     * 注意它是**增量视图**——只包含本次变动了的标的，所以逐条覆盖，
     * 绝不能当成账户全量快照去重置没出现的标的。
     *
     * 仓位归零时**顺手收敛未终结记录**：那条路径等价于「仓位没了」，而记录还停在
     * `armed` 的话，它会一直报紧急，还会挡住这个标的后续所有新开仓
     * （同标的不叠第二套的规则正是这么判的）。两种事件到达顺序都收敛到正确终态——
     * 账户事件先到则先置 `cancelled`，成交事件后到会覆盖成 `take_profit` / `stop_loss`；
     * 反过来则那条记录已不在未终结集合里，本方法什么都不做。
     */
    async correctPositions(
      updates: readonly { symbol: string; positionAmt: number; transactionTime: number }[],
    ): Promise<void> {
      // **只校正净额，绝不在这里收敛记录。**
      //
      // 原因（实测踩到）：仓位归零既可能来自**我们自己的条件单成交**，
      // 也可能来自工具外平仓。若这里抢先置成 `cancelled`，而同一时刻
      // `settle()` 正要把记录置成 `stop_loss`，两条路径并发写同一行——
      // 实测结果是止损成交被记成「工具外平仓」，最该被看见的一次交易被抹掉了。
      //
      // 平仓收敛一律交给成交事件判定：交易所的**每一笔成交**都会推
      // `ORDER_TRADE_UPDATE`，包含条件单成交与手动平仓，因此不需要抢。
      // 成交事件万一丢失，由重连后的 `convergeFlatPositions()` 兜底。
      for (const item of updates) {
        positions.correct(item.symbol, item.positionAmt, item.transactionTime);
        log.debug(
          `${item.symbol} 净仓位已按 ACCOUNT_UPDATE 校正为 ${item.positionAmt}（撮合时间 ${item.transactionTime}）`,
        );
      }
    },

    /**
     * 重连 / 启动播种之后的兜底收敛。
     *
     * 只在这个时刻调用：**此刻没有任何在途事件**，所以不存在与 `settle()`
     * 并发竞争的可能。作用是接住「断线期间成交事件整个丢了」的情形——
     * 仓位已在库里归零，而记录还停在 `armed`。
     *
     * 拿不到净仓位就不猜：宁可留着 `armed` 让对账报 critical，
     * 也不要把一条仍受保护的仓位误标成已结清。
     *
     * ⚠️ **判据在「交易所说这个标的没有仓位」，不在「调用方传了哪些标的」**（2026-10-23
     * 实测踩到，账户在主网、仓位早就平了、本地那条 `armed` 记录却永远收不掉，
     * 对账每 5 分钟报一次紧急差异）。两处都要改，缺一个就照样失效：
     *
     * 1. **候选集**：本方法自己从库里取「有未终结记录的标的」，而不是只信调用方给的那份。
     *    币安在一个完全没有仓位的账户上 `positionRisk` 返回**空数组**，于是调用方
     *    「交易所说空仓的标的」是空集——收敛根本没被触发。
     *    **交易所没给行 = 该标的没有仓位**，这是明确的答复，不是「拿不到」；
     *    拿不到时（请求失败）播种会抛错，压根走不到这里，两件事必须分开。
     * 2. **判定**：`positions.get()` 对没跟踪过的标的返回 `undefined`，而 `undefined`
     *    同样意味着「没有仓位」。早先写的是 `!== 0`，于是 undefined 被判成「不是 0」
     *    而跳过——与第 1 点叠在一起，账户完全没有仓位时收敛**完全**失效。
     */
    async convergeFlatPositions(flat: readonly { symbol: string }[]): Promise<void> {
      const candidates = new Set(flat.map((item) => item.symbol));
      for (const record of await listUnsettledBrackets(pool, exchange)) {
        candidates.add(record.symbol);
      }
      for (const symbol of candidates) {
        // `?? 0`：跟踪器刚被交易所的 positionRisk 快照重置并播种过，
        // 它没跟踪的标的**就是**没有仓位（`undefined` 与 0 同义）。
        if ((positions.get(symbol) ?? 0) !== 0) continue;
        await closeOutside(symbol, '重连后核对：交易所已无该标的仓位');
      }
    },

    /**
     * 跑一轮移动止损（v0.7.0）。定时器调用它，**必须先跑一次再进周期**。
     *
     * 五条纪律（AGENTS.md §6.8）：
     *
     * 1. **只动 `trailing` 行**，外加「TP1 已成交但没推进成功」的 `partial_armed` 行。
     *    `armed` 与「TP1 还没成交」的 `partial_armed` 的止损不该被移动——
     *    那是进场保护，动了就变成另一套策略。
     * 2. **价没变就不挂撤**。绝大多数轮次是零动作，这是限频的主要来源。
     * 3. **先挂新、再撤旧**（R-4.1）。反过来会造出无保护窗口；两张 `closePosition`
     *    单在重叠期内最多是一次「无仓可平」的拒绝，不会反向开仓。
     * 4. **本轮不动 / 失败都要留下原因**（`trail_last_error`）。它与「看起来正常、
     *    而追踪其实已经停了三天」是同一件事的两面。
     * 5. **「等推进」的行只推进它自己该推进的部分**：阶段往前挪，止损换不换档
     *    仍按第 2 条判断（价位没变就不动交易所上的单）。
     *
     * 它**不修复**自己在对账里发现的漂移（例如「交易所有仓位、本地无记录」）：
     * 那类处置是人工决定（§6.5 第 1 条）。补挂只做「自己已经提交、只是没做完」的意图。
     */
    async trailOnce(): Promise<TrailReport> {
      const report: TrailReport = { advanced: 0, moved: 0, unchanged: 0, failed: 0, skipped: 0 };
      let records;
      try {
        records = await listTrailingBrackets(pool, exchange, now());
      } catch (error) {
        log.error(`读取移动止损记录失败（本轮不动任何单）：${reasonOf(error)}`);
        return report;
      }

      for (const record of records) {
        if (!inScope(record.symbol)) {
          report.skipped += 1;
          continue;
        }
        const key = { exchange, symbol: record.symbol, entryOrderId: record.entryOrderId };
        /**
         * 「等推进」的行：第一段止盈**已经成交**（`tp1_filled_at` 非空），
         * 但当时没能推进到 `trailing`（多半是极值取不到——行情没同步到开仓之后）。
         *
         * 它要做的**只是把阶段推进过去**，外加必要的换档；**不是**去动进场保护那张止损单
         * （那是 `armed` / 未成交的 `partial_armed` 才有的事，见 §6.8 第 3 条）。
         */
        const pending = record.state === 'partial_armed';
        try {
          const policy = await resolvePolicyFor(record.symbol);
          const snapshot = await atr.atrAt(record.symbol, now(), record.entryTime, {
            interval: policy.atrInterval,
            period: policy.atrPeriod,
          });
          // 极值取不到 → **本轮不移动止损、保留上一档**（v0.7.0 R-6.5）。
          // 它**不是**失败：仓位仍受上一档止损保护，只是不动它。
          // 所以这里单独判，不落进下面的 catch（catch 是「本轮失败」语义）。
          if (snapshot.extreme === null) {
            report.unchanged += 1;
            const reason =
              `${record.symbol} 持仓期极值取不到（持仓期内还没有已收盘的 ${policy.atrInterval} K 线）：` +
              '本轮不移动止损，保留上一档';
            await markBracketTrailNotMoved(pool, key, reason, now(), 'not-moved').catch(
              () => undefined,
            );
            log.warn(reason);
            continue;
          }
          const plan = await planTrail(record, policy, snapshot);
          const observed = {
            extreme: plan.extreme,
            atr: snapshot.atr,
            atrFrom: plan.atrFrom,
            atrTo: plan.atrTo,
          };

          // ① 「等推进」的行：先把**阶段**推进过去。
          //
          // 这一步只写阶段与观测（极值 / ATR），**不动交易所上的单**——
          // 换档在下面统一做，免得两个地方各挂一次。
          if (pending) {
            const advanced = await advanceStage(record, plan, snapshot);
            if (!advanced) {
              // 已经有人推进过了（事件重放 / 另一条路径）。这轮不重复动单。
              report.unchanged += 1;
              continue;
            }
            report.advanced += 1;
            log.info(
              `${record.symbol} 第一段止盈已成交，推进到移动止损` +
                `（极值 ${plan.extreme}，ATR ${snapshot.atr}）`,
            );
          }

          // ② 换档：价没变就不挂撤。
          //
          // `slAlgoId` 为空 = 崩在「已置 trailing、还没挂止损」那一格。
          // 这种情况下**即使价位没变也必须挂**，否则这一格永远补不上。
          const mustPlace = record.slAlgoId === null;
          if (!plan.changed && !mustPlace) {
            // 「等推进」且这一档没变：进场那张止损单**正好就在这一档上**，
            // 所以交易所上不用动，阶段也已经在上面推进过了。
            if (!pending) {
              report.unchanged += 1;
            }
            if (plan.reason !== 'unchanged') {
              // 越过现价这类「本轮不动」必须可见；`unchanged` 本身不是事件，不写。
              // **推进了阶段也一样要写**：这一行刚被接管，「为什么没挪」正是
              // 下一个人要看的第一件事。
              await markBracketTrailNotMoved(
                pool,
                key,
                `${record.symbol} 移动止损本轮未调整：${describeTrailReason(plan.reason)}`,
                now(),
                'not-moved',
                observed,
              );
              log.warn(`${record.symbol} 移动止损本轮未调整：${describeTrailReason(plan.reason)}`);
            }
            continue;
          }

          const result = await moveTrailStop(record, plan, snapshot);
          if (result.failed) {
            report.failed += 1;
            continue;
          }
          // 「没挪成、但也没失败」= 记录已经不在移动止损阶段（多半是止损刚成交）。
          // 那不是「挪了一档」，别把它记成 moved。
          if (!result.moved) {
            report.skipped += 1;
            continue;
          }
          report.moved += 1;
          log.info(
            `${record.symbol} 移动止损 ${
              pending
                ? '推进到'
                : mustPlace
                  ? '补挂'
                  : record.trailStopPrice !== null
                    ? '上移'
                    : '初始化'
            } ${plan.stopPrice}（极值 ${plan.extreme}，ATR ${snapshot.atr}）`,
          );
        } catch (error) {
          report.failed += 1;
          const reason = `${record.symbol} 移动止损本轮失败：${reasonOf(error)}`;
          // 失败一律留下可见原因，**不推进档位**：旧止损仍在交易所，仓位仍受保护。
          // 状态记成 `failed`：对账据此报「移动止损换档失败」——这类故障此前无处可见。
          await markBracketTrailNotMoved(pool, key, reason, now(), 'failed').catch(() => undefined);
          log.error(reason);
        }
      }
      return report;
    },
  };
}

/** 移动止损本轮不动 / 失败的人话原因。 */
function describeTrailReason(reason: TrailingReason): string {
  switch (reason) {
    case 'beyond-price':
      return '算出的止损位已越过现价（极值回撤已吃掉浮盈），本轮不调整，保留原档';
    case 'unchanged':
      return '价位未变，无需调整';
    case 'breakeven':
    case 'moved':
      return '无需调整';
  }
}

/**
 * 人话摘要。两种形态的日志必须让人一眼看出「挂的是全平还是减仓」——
 * 「两套保护看起来一样」正是分批止盈最容易出事的地方。
 */
function describeStaged(plan: StagedPlan): string {
  const head = `入场 ${plan.entryPrice} ATR=${plan.atr} 止损 ${plan.stopPrice}`;
  if (plan.mode === 'partial') {
    return (
      `${head} 第一段止盈 ${plan.takeProfitPrice} × ${plan.tp1Qty}` +
      `（${(plan.ratio * 100).toFixed(2)}% 仓位），剩余由移动止损了结`
    );
  }
  return `${head} 止盈 ${plan.takeProfitPrice}（全平）`;
}
