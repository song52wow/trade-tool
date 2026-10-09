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
 *   是买入成交吗？不是 ─► 忽略（卖出是减仓，由自己的单触发）
 *      │是
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
  createLogger,
  deriveBracketPlan,
  type BracketPlan,
  type ExecutorConfig,
  type TradeToolConfig,
} from '@trade-tool/core';
import {
  claimBracket,
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

/** 我们自己下的两张条件单的 `clientOrderId` 前缀。用来把自己的成交认出来。 */
export const RISK_CLIENT_ID_PREFIX = 'rsk';
const TP_TAG = 'tp';
const SL_TAG = 'sl';
/** Binance 的 clientOrderId 长度上限。 */
const CLIENT_ID_MAX = 36;

/**
 * 由入场订单号派生条件单的 clientOrderId。
 *
 * 带前缀是为了在事件流里一眼认出「这是止盈止损成交，不是新的入场」——
 * 认错了会把一笔止损平仓当成新的买入成交，再挂一组单，仓位直接翻倍。
 */
export function bracketClientOrderId(tag: 'tp' | 'sl', entryOrderId: string): string {
  return `${RISK_CLIENT_ID_PREFIX}-${tag}-${entryOrderId}`.slice(0, CLIENT_ID_MAX);
}

/** 反解：这是不是我们挂的单？是的话返回是哪一张与对应的入场订单号。 */
export function parseBracketClientOrderId(
  clientOrderId: string,
): { tag: 'tp' | 'sl'; entryOrderId: string } | null {
  if (!clientOrderId.startsWith(`${RISK_CLIENT_ID_PREFIX}-`)) return null;
  const rest = clientOrderId.slice(RISK_CLIENT_ID_PREFIX.length + 1);
  const dash = rest.indexOf('-');
  if (dash < 0) return null;
  const tag = rest.slice(0, dash);
  const entryOrderId = rest.slice(dash + 1);
  if ((tag !== TP_TAG && tag !== SL_TAG) || entryOrderId === '') return null;
  return { tag, entryOrderId };
}

/** 下单能力。只声明用到的两个方法，测试可整体替身。 */
export interface OrderPlacer {
  placeClosePositionOrder(request: {
    symbol: string;
    side: 'BUY' | 'SELL';
    type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
    stopPrice: number;
    clientOrderId: string;
    workingType: 'MARK_PRICE' | 'CONTRACT_PRICE';
    priceProtect: boolean;
  }): Promise<{ orderId: number; clientOrderId: string; symbol: string; status: string }>;
  cancelOrder(symbol: string, orderId: number): Promise<void>;
}

export interface ExecutorServiceDeps {
  pool: Pool;
  config: TradeToolConfig;
  placer: OrderPlacer;
  atr: AtrProvider;
  /** 可注入时钟，测试里固定住。 */
  now?: () => number;
}

/** 一条成交事件的处理结果。控制面与日志都靠它区分「为什么没设单」。 */
export type HandleOutcome =
  'ignored' | 'settled' | 'duplicate' | 'armed' | 'failed' | 'partial-skipped';

export interface ExecutorService {
  handleFill(update: OrderTradeUpdate): Promise<HandleOutcome>;
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
  let lastPlan: BracketPlan | null = null;

  /** 标的过滤：配置为空 = 全部。 */
  function inScope(symbol: string): boolean {
    return settings.symbols.length === 0 || settings.symbols.includes(symbol);
  }

  async function settle(
    update: OrderTradeUpdate,
    entryOrderId: string,
    tag: 'tp' | 'sl',
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

  async function placePair(update: OrderTradeUpdate, plan: BracketPlan): Promise<HandleOutcome> {
    const entryOrderId = String(update.orderId);
    const key = { exchange, symbol: update.symbol, entryOrderId };
    const workingType = settings.workingType;
    const priceProtect = settings.priceProtect;

    // 先挂**止盈**、再挂**止损**：反过来的话，止盈挂上后止损失败、
    // 我们连一张可以撤的单都没有，仓位直接裸奔。
    let tpOrderId: number | undefined;
    let slOrderId: number | undefined;
    try {
      const tp = await placer.placeClosePositionOrder({
        symbol: update.symbol,
        side: plan.exitSide,
        type: 'TAKE_PROFIT_MARKET',
        stopPrice: plan.takeProfitPrice,
        clientOrderId: bracketClientOrderId('tp', entryOrderId),
        workingType,
        priceProtect,
      });
      tpOrderId = tp.orderId;
      const sl = await placer.placeClosePositionOrder({
        symbol: update.symbol,
        side: plan.exitSide,
        type: 'STOP_MARKET',
        stopPrice: plan.stopPrice,
        clientOrderId: bracketClientOrderId('sl', entryOrderId),
        workingType,
        priceProtect,
      });
      slOrderId = sl.orderId;
    } catch (error) {
      // 撤掉可能已经挂上的那张：留一张没有对单的止盈/止损，比两张都没有更糟。
      let cancelNote = '';
      if (tpOrderId !== undefined || slOrderId !== undefined) {
        const orderId = tpOrderId ?? slOrderId;
        if (orderId !== undefined) {
          try {
            await placer.cancelOrder(update.symbol, orderId);
            cancelNote = `；已撤掉先挂上的订单 ${orderId}`;
          } catch (cancelError) {
            cancelNote = `；**撤单也失败了**（订单 ${orderId} 可能仍在交易所挂着）：${reasonOf(cancelError)}`;
          }
        }
      }
      const reason = `${reasonOf(error)}${cancelNote}`;
      await markBracketFailed(
        pool,
        key,
        { ...(tpOrderId ? { tpOrderId } : {}), ...(slOrderId ? { slOrderId } : {}) },
        reason,
        now(),
      );
      log.error(`${update.symbol} 挂止盈止损失败：${reason}`);
      return 'failed';
    }

    await markBracketArmed(
      pool,
      key,
      { tpOrderId: tpOrderId as number, slOrderId: slOrderId as number },
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
      snapshot = await atr.atrAt(update.symbol, update.tradeTime);
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
      stopAtrMult: settings.stopAtrMult,
      takeProfitAtrMult: settings.takeProfitAtrMult,
      tickSize,
    });
    lastPlan = plan;

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

      // 3) 只在**买入**成交上建保护。卖出成交是减仓，由它自己的单触发。
      if (update.side !== 'BUY') return 'ignored';

      // 4) 成交门槛。全额成交总是处理；部分成交只在 accumulate 模式下处理，
      //    否则「建仓到一半、止损位按半个仓位的均价算一次」会把仓位保护在半路上。
      if (update.status === 'PARTIALLY_FILLED') {
        if (settings.onPartialFill !== 'accumulate') return 'partial-skipped';
      } else if (update.status !== 'FILLED') {
        return 'ignored';
      }

      return openBracket(update);
    },
  };
}

function describePlan(plan: BracketPlan): string {
  return (
    `入场 ${plan.entryPrice} ATR=${plan.atr} 止损 ${plan.stopPrice} 止盈 ${plan.takeProfitPrice} ` +
    `R:R=${plan.riskReward.toFixed(2)}`
  );
}
