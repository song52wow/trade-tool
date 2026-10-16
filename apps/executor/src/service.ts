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
  SyncError,
  NetPositionTracker,
  bracketClientOrderId,
  type FillApplication,
  classifyFill,
  createLogger,
  deriveBracketPlan,
  parseBracketClientOrderId,
  signedFillDelta,
  type BracketPlan,
  type ExecutorConfig,
  type TradeToolConfig,
} from '@trade-tool/core';
import {
  claimBracket,
  listUnsettledBrackets,
  markBracketArmed,
  markBracketFailed,
  markBracketSettled,
  parseTickSize,
  readContractSpecRaw,
  type OrderTradeUpdate,
  type BracketState,
  type Pool,
} from '@trade-tool/data';

import type { AtrProvider } from './atr.js';

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
}

/** 从库里解析出来的一份策略参数。字段名与 `deriveBracketPlan` 入参一一对应。 */
export interface RiskPolicy {
  atrPeriod: number;
  atrInterval: string;
  stopAtrMult: number;
  takeProfitAtrMult: number;
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
  | 'partial-skipped';

export interface ExecutorService {
  handleFill(update: OrderTradeUpdate): Promise<HandleOutcome>;
  /** 用 `ACCOUNT_UPDATE` 校正净仓位（**不收敛记录**，见实现注释）。 */
  correctPositions(
    updates: readonly { symbol: string; positionAmt: number; transactionTime: number }[],
  ): Promise<void>;
  /** 重连 / 启动播种后的兜底收敛，只处理净仓位确为 0 的标的。 */
  convergeFlatPositions(flat: readonly { symbol: string }[]): Promise<void>;
  /** 最近一次算出的计划，仅供测试与诊断。 */
  readonly lastPlan: BracketPlan | null;
}

function reasonOf(error: unknown): string {
  if (error instanceof SyncError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function createExecutorService(deps: ExecutorServiceDeps): ExecutorService {
  const { pool, config, placer, atr } = deps;
  const settings: ExecutorConfig = config.executor;
  const now = deps.now ?? (() => Date.now());
  const exchange = config.market.exchange;
  const positions = deps.positions ?? new NetPositionTracker();
  let lastPlan: BracketPlan | null = null;

  /** 标的过滤：配置为空 = 全部。 */
  function inScope(symbol: string): boolean {
    return settings.symbols.length === 0 || settings.symbols.includes(symbol);
  }

  async function settle(
    update: OrderTradeUpdate,
    entryOrderId: string,
    tag: typeof TP_TAG | typeof SL_TAG,
  ): Promise<HandleOutcome> {
    const state: BracketState = tag === TP_TAG ? 'take_profit' : 'stop_loss';
    try {
      await markBracketSettled(
        pool,
        { exchange, symbol: update.symbol, entryOrderId },
        state,
        now(),
      );
      log.info(`${update.symbol} 止盈止损成交（${tag}），记录置为 ${state}`);
      return 'settled';
    } catch (error) {
      // 状态回填失败**不能**反过来影响交易结果：单已经成交了，
      // 但把异常抛出去会让事件处理器以为处理失败而重试。
      log.error(`${update.symbol} 条件单成交但状态回填失败：${reasonOf(error)}`);
      return 'settled';
    }
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

  async function placePair(update: OrderTradeUpdate, plan: BracketPlan): Promise<HandleOutcome> {
    const entryOrderId = String(update.orderId);
    const key = { exchange, symbol: update.symbol, entryOrderId };
    const workingType = settings.workingType;
    const priceProtect = settings.priceProtect;

    // 先挂**止盈**、再挂**止损**：反过来的话，止盈挂上后止损失败、
    // 我们连一张可以撤的单都没有，仓位直接裸奔。
    let tpAlgoId: number | undefined;
    let slAlgoId: number | undefined;
    try {
      const tp = await placer.placeClosePositionOrder({
        symbol: update.symbol,
        side: plan.exitSide,
        type: 'TAKE_PROFIT_MARKET',
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

    await markBracketArmed(
      pool,
      key,
      { tpAlgoId: tpAlgoId as number, slAlgoId: slAlgoId as number },
      now(),
    );
    log.info(`${update.symbol} 止盈止损已挂上：${describePlan(plan)}`);
    return 'armed';
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
    async function recordRejected(reason: string): Promise<HandleOutcome> {
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
      policy = deps.resolvePolicy
        ? await deps.resolvePolicy(update.symbol)
        : {
            atrPeriod: settings.atrPeriod,
            atrInterval: settings.atrInterval,
            stopAtrMult: settings.stopAtrMult,
            takeProfitAtrMult: settings.takeProfitAtrMult,
          };
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
      snapshot = await atr.atrAt(update.symbol, update.tradeTime, {
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

    const plan = deriveBracketPlan({
      side: update.side,
      entryPrice: update.averagePrice,
      atr: snapshot.atr,
      atrPeriod: snapshot.period,
      stopAtrMult: policy.stopAtrMult,
      takeProfitAtrMult: policy.takeProfitAtrMult,
      tickSize,
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
      atr: snapshot.atr,
      atrPeriod: snapshot.period,
      atrInterval: snapshot.interval,
      atrWindowFrom: snapshot.segmentFrom,
      atrWindowTo: snapshot.segmentTo,
      stopPrice: plan.stopPrice,
      takeProfit: plan.takeProfitPrice,
      now: now(),
    });
    if (claimed === null) {
      log.info(`${update.symbol} 订单 ${entryOrderId} 已有止盈止损记录，跳过（事件重放）`);
      return 'duplicate';
    }

    return placePair(update, plan);
  }

  return {
    get lastPlan(): BracketPlan | null {
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
  };
}

function describePlan(plan: BracketPlan): string {
  return (
    `入场 ${plan.entryPrice} ATR=${plan.atr} 止损 ${plan.stopPrice} 止盈 ${plan.takeProfitPrice} ` +
    `R:R=${plan.riskReward.toFixed(2)}`
  );
}
