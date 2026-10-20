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
  type OrderTradeUpdate,
  type BracketRecord,
  type BracketState,
  type Pool,
} from '@trade-tool/data';

import type { AtrProvider, AtrSnapshot } from './atr.js';
import { applyDecision, type DecideOutput, type RiskDecider } from './decision.js';

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
}

/** 从库里解析出来的一份策略参数。字段名与 `deriveStagedPlan` 入参一一对应。 */
export interface RiskPolicy {
  atrPeriod: number;
  atrInterval: string;
  stopAtrMult: number;
  takeProfitAtrMult: number;
  /** v0.7.0：`[0, 1]`。`0` = 不分批；`1` = 一次性全平；中间值 = 分批。 */
  takeProfit1Ratio: number;
  takeProfit1AtrMult: number;
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
  /** 重连 / 启动播种后的兜底收敛，只处理净仓位确为 0 的标的。 */
  convergeFlatPositions(flat: readonly { symbol: string }[]): Promise<void>;
  /** 最近一次算出的计划，仅供测试与诊断。 */
  readonly lastPlan: StagedPlan | null;
  /** 跑一轮移动止损。定时器与测试都调它。 */
  trailOnce(): Promise<TrailReport>;
}

/**
 * 一轮移动止损的结果。**四项都单独计数**，不合成一个「成功与否」：
 * 「这一轮没有动作」与「这一轮失败了」在处置上完全不同，合成一个就看不出区别。
 */
export interface TrailReport {
  /** 真正换档（含补挂）的条数。 */
  moved: number;
  /** 本轮不需要动的条数。 */
  unchanged: number;
  /** 动失败、保留原档的条数。 */
  failed: number;
  /** 不在配置范围内、跳过的条数。 */
  skipped: number;
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
    try {
      const settled = await markBracketSettled(pool, key, state, now(), {
        price: update.lastFilledPrice,
        qty: update.lastFilledQty,
        fee: update.commission,
      });
      log.info(`${update.symbol} 止盈止损成交（${tag}），记录置为 ${state}`);
      // 只有**真的**结算了那一行才通知：事件重放时行早已终结（settled = 0），
      // 再推一次就会把同一轮的战报发两遍。
      if (settled > 0) await notifySettled(update, record, state);
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
    await pushAlert('bracket-settled', () => ({
      fingerprint: `settled|${after.symbol}|${after.entryOrderId}`,
      // 类型「成交」：一轮买卖走完了。
      category: 'trade',
      // 亏了比赚了更值得看一眼——用「注意」而不是「提示」。
      severity: pnl.net >= 0 ? 'info' : 'warning',
      oneShot: true,
      // 标题带净盈亏：推送预览里直接看到这一轮赚没赚。
      title: `${after.symbol} 净盈亏 ${money(pnl.net)}`,
      lines: [
        `入场 ${after.entryPrice} → 出场 ${update.lastFilledPrice}`,
        `已平 ${after.closedQty}（均价 ${(after.exitNotional / after.closedQty).toFixed(2)}）`,
        `本轮${state === 'take_profit' ? '止盈' : '止损'}成交`,
      ],
      // 金额单独一段并加粗。
      highlights: [
        `毛利 ${money(pnl.gross)}`,
        `手续费 ${money(pnl.fee)}`,
        `净盈亏 ${money(pnl.net)}`,
      ],
    }));
  }

  /**
   * 第一段已成交 → 进入移动止损（v0.7.0）。
   *
   * **为什么止损单此时还是有效的**：第一段止盈带数量、止损是 `closePosition`，
   * 而 `closePosition` 的语义是「触发时平掉当时剩余的全部仓位」。减仓之后仓位还在，
   * 所以那张止损单**继续保护剩余仓位**，这里只把档位推进，不重挂（重挂才会造出
   * 无保护窗口）。
   *
   * **为什么先落库再动交易所**：进程死在「已置 `trailing`、还没挪止损」时，对账会看到
   * `trailing` 却查不到止损单（紧急），定时器下一轮补；反过来先挪单后落库，
   * 崩在中间就是「交易所挂着新档位、库里记着旧档位」，两者永久对不上。
   *
   * **幂等**：`markBracketTrailing` 的 WHERE 只认 `partial_armed`，
   * 事件重放时第二次拿不到行，不会重复推进。
   */
  async function armTrailing(
    update: OrderTradeUpdate,
    record: BracketRecord,
  ): Promise<HandleOutcome> {
    const key = { exchange, symbol: record.symbol, entryOrderId: record.entryOrderId };
    try {
      const policy = await resolvePolicyFor(record.symbol);
      const snapshot = await atr.atrAt(record.symbol, update.tradeTime, record.entryTime, {
        interval: policy.atrInterval,
        period: policy.atrPeriod,
      });
      const plan = await planTrail(record, policy, snapshot);
      const moved = await markBracketTrailing(
        pool,
        key,
        {
          extreme: plan.extreme,
          stopPrice: plan.stopPrice,
          atr: snapshot.atr,
          atrFrom: snapshot.extreme.from,
          atrTo: snapshot.extreme.to,
        },
        now(),
        // 第一段成交的事实：两段模型下这一轮会平两段，不累加它，
        // 最后算出来的净盈亏就只算了一半。
        {
          price: update.lastFilledPrice,
          qty: update.lastFilledQty,
          fee: update.commission,
        },
      );
      if (moved === 0) {
        log.info(`${record.symbol} 第一段止盈已在处理中（记录已被推进过），不重复执行`);
        return 'settled';
      }
      log.info(
        `${record.symbol} 第一段止盈已成交，进入移动止损：当前档 ${plan.stopPrice}` +
          `（极值 ${plan.extreme}，ATR ${snapshot.atr}）`,
      );
      return 'trailing';
    } catch (error) {
      // 取不到极值 / ATR 时**不能**把记录置成终态：那会留下「账面上已了结、
      // 实际仓位无人跟踪」的一笔仓位，正是 v0.4.0 反复在治的那种分裂。
      // 保留 `partial_armed` 并留下可见原因，等移动止损定时器重试。
      const reason = `推进移动止损失败：${reasonOf(error)}`;
      await markBracketTrailNotMoved(pool, key, reason, now()).catch(() => undefined);
      log.error(`${record.symbol} ${reason}`);
      return 'failed';
    }
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
      'symbol' | 'positionSide' | 'entryPrice' | 'stopPrice' | 'trailStopPrice'
    >,
    policy: RiskPolicy,
    snapshot: AtrSnapshot,
  ): Promise<{ stopPrice: number; changed: boolean; reason: TrailingReason; extreme: number }> {
    const isLong = record.positionSide === 'LONG';
    const extreme = isLong ? snapshot.extreme.high : snapshot.extreme.low;
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
    };
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
        takeProfit1AtrMult: settings.takeProfit1AtrMult,
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
    topic: 'bracket-armed' | 'bracket-settled' | 'llm-fallback',
    build: () => AlertItem,
  ): Promise<void> {
    const alerts = deps.alerts;
    if (alerts === undefined) return;
    try {
      await alerts.dispatch((channel: AlertChannel) => {
        if (!channel.kinds.includes(topic)) return [];
        return [build()];
      });
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
              stopPrice: plan.tp1Price,
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
              stopPrice: plan.mode === 'full' ? plan.tp1Price : plan.takeProfitPrice,
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
    const takeProfitPrice = plan.mode === 'single' ? plan.takeProfitPrice : plan.tp1Price;
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
  async function decideForBracket(
    update: OrderTradeUpdate,
    policy: RiskPolicy,
    snapshot: AtrSnapshot,
  ): Promise<DecideOutput> {
    if (deps.decider === undefined) {
      return {
        decision: {
          stopAtrMult: policy.stopAtrMult,
          takeProfitAtrMult: policy.takeProfitAtrMult,
          takeProfit1Ratio: policy.takeProfit1Ratio,
          takeProfit1AtrMult: policy.takeProfit1AtrMult,
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
        takeProfit1AtrMult: policy.takeProfit1AtrMult,
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
        title: outcome.refuse
          ? `${update.symbol} LLM 决策失败且不降级：本次没有挂任何保护单`
          : `${update.symbol} LLM 决策降级到配置档位`,
        lines: [
          `原因：${outcome.fallbackReason ?? '未知'}`,
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
      takeProfit1AtrMult: effective.takeProfit1AtrMult,
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

    // 占坑。冲突 = 已处理过，直接跳过——幂等的唯一实现点。
    const claimed = await claimBracket(pool, {
      exchange,
      symbol: update.symbol,
      entryOrderId,
      entryPrice: update.averagePrice,
      entryTime: update.tradeTime,
      filledQty: update.cumulativeQty,
      positionSide: plan.positionSide,
      // 入场这笔的手续费也是这一轮的成本：只扣出场那笔，收益会算虚高。
      entryFeeAmount: update.commission,
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
      ...(plan.mode === 'partial' && plan.tp1Qty !== null
        ? { tp1Qty: plan.tp1Qty, tp1Price: plan.tp1Price }
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
     */
    async convergeFlatPositions(flat: readonly { symbol: string }[]): Promise<void> {
      for (const item of flat) {
        if (positions.get(item.symbol) !== 0) continue;
        await closeOutside(item.symbol, '重连后核对：仓位已空且本地无未终结记录');
      }
    },

    /**
     * 跑一轮移动止损（v0.7.0）。定时器调用它，**必须先跑一次再进周期**。
     *
     * 四条纪律（AGENTS.md §6.8）：
     *
     * 1. **只动 `trailing` 行**。`armed` / `partial_armed` 的止损不该被移动——
     *    那是进场保护，动了就变成另一套策略。
     * 2. **价没变就不挂撤**。绝大多数轮次是零动作，这是限频的主要来源。
     * 3. **先挂新、再撤旧**（R-4.1）。反过来会造出无保护窗口；两张 `closePosition`
     *    单在重叠期内最多是一次「无仓可平」的拒绝，不会反向开仓。
     * 4. **本轮不动 / 失败都要留下原因**（`trail_last_error`）。它与「看起来正常、
     *    而追踪其实已经停了三天」是同一件事的两面。
     *
     * 它**不修复**自己在对账里发现的漂移（例如「交易所有仓位、本地无记录」）：
     * 那类处置是人工决定（§6.5 第 1 条）。补挂只做「自己已经提交、只是没做完」的意图。
     */
    async trailOnce(): Promise<TrailReport> {
      const report: TrailReport = { moved: 0, unchanged: 0, failed: 0, skipped: 0 };
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
        try {
          const policy = await resolvePolicyFor(record.symbol);
          const snapshot = await atr.atrAt(record.symbol, now(), record.entryTime, {
            interval: policy.atrInterval,
            period: policy.atrPeriod,
          });
          const plan = await planTrail(record, policy, snapshot);
          const observed = {
            extreme: plan.extreme,
            atr: snapshot.atr,
            atrFrom: snapshot.extreme.from,
            atrTo: snapshot.extreme.to,
          };

          // `slAlgoId` 为空 = 崩在「已置 trailing、还没挂止损」那一格。
          // 这种情况下**即使价位没变也必须挂**，否则这一格永远补不上。
          const mustPlace = record.slAlgoId === null;
          if (!plan.changed && !mustPlace) {
            report.unchanged += 1;
            if (plan.reason !== 'unchanged') {
              // 越过现价这类「本轮不动」必须可见；`unchanged` 本身不是事件，不写。
              await markBracketTrailNotMoved(
                pool,
                key,
                `${record.symbol} 移动止损本轮未调整：${describeTrailReason(plan.reason)}`,
                now(),
                observed,
              );
              log.warn(`${record.symbol} 移动止损本轮未调整：${describeTrailReason(plan.reason)}`);
            }
            continue;
          }

          const placed = await placer.placeClosePositionOrder({
            symbol: record.symbol,
            side: record.positionSide === 'LONG' ? 'SELL' : 'BUY',
            type: 'STOP_MARKET',
            stopPrice: plan.stopPrice,
            clientAlgoId: bracketClientOrderId(SL_TAG, record.entryOrderId),
            workingType: settings.workingType,
            priceProtect: settings.priceProtect,
          });
          if (record.slAlgoId !== null) {
            try {
              await placer.cancelAlgoOrder(record.slAlgoId);
            } catch (cancelError) {
              // 撤旧失败：**不推进档位**。新单已挂上、旧的也还在，账面上以旧档为准
              // （保守），下一轮重试。把原因写下来，否则这处重叠会安静地存在。
              await markBracketTrailNotMoved(
                pool,
                key,
                `${record.symbol} 撤旧止损失败（条件单 ${record.slAlgoId} 可能仍在交易所挂着，` +
                  `新档 ${plan.stopPrice} 的单 ${placed.algoId} 已挂上）：${reasonOf(cancelError)}`,
                now(),
                observed,
              );
              log.warn(
                `${record.symbol} 撤旧止损 ${record.slAlgoId} 失败，新档 ${plan.stopPrice} 已挂上但未推进档位`,
              );
              report.failed += 1;
              continue;
            }
          }
          await markBracketTrailMoved(
            pool,
            key,
            { stopPrice: plan.stopPrice, slAlgoId: placed.algoId, ...observed },
            now(),
          );
          report.moved += 1;
          log.info(
            `${record.symbol} 移动止损 ${
              mustPlace ? '补挂' : record.trailStopPrice !== null ? '上移' : '初始化'
            }到 ${plan.stopPrice}（极值 ${plan.extreme}，ATR ${snapshot.atr}）`,
          );
        } catch (error) {
          report.failed += 1;
          const reason = `${record.symbol} 移动止损本轮失败：${reasonOf(error)}`;
          // 失败一律留下可见原因，**不推进档位**：旧止损仍在交易所，仓位仍受保护。
          await markBracketTrailNotMoved(pool, key, reason, now()).catch(() => undefined);
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
 * 人话摘要。三种形态的日志必须让人一眼看出「挂的是全平还是减仓」——
 * 「两套保护看起来一样」正是分批止盈最容易出事的地方。
 */
function describeStaged(plan: StagedPlan): string {
  const head = `入场 ${plan.entryPrice} ATR=${plan.atr} 止损 ${plan.stopPrice}`;
  if (plan.mode === 'partial') {
    return (
      `${head} 第一段止盈 ${plan.tp1Price} × ${plan.tp1Qty}` +
      `（${(plan.ratio * 100).toFixed(2)}% 仓位），剩余由移动止损了结`
    );
  }
  if (plan.mode === 'full') {
    return `${head} 一次性止盈 ${plan.tp1Price}（全平）`;
  }
  return `${head} 止盈 ${plan.takeProfitPrice}（全平）`;
}
