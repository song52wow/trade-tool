/**
 * 挂「一对保护单」的**唯一实现**（v1.3.0 抽出）。
 *
 * 止盈与止损是**一对**：两张都是 `closePosition` 的市价条件单，触发即平掉当时剩余的
 * 全部仓位。挂与不挂必须一致——
 *
 * - 两张都挂上 → 仓位有保护；
 * - 只挂上一张 → **比什么都不挂更危险**（§6.3 第 5 条）：一张没有对单的止盈/止损
 *   会在该平仓的时候把仓位平掉，而另一侧的损失没有任何拦截。
 *
 * 因此这里的顺序是硬约定：**先止盈、后止损；第二张失败就撤掉第一张**。
 *
 * ## 为什么抽出来
 *
 * 挂单有两条路：
 *
 * 1. **自动**：成交事件驱动（`service.ts` 的 `openBracket`）；
 * 2. **手动**：人发现仓位没保护，动手补挂（`reattach.ts`）。
 *
 * 两条路必须**挂出逐字相同的单**：自定义号的派生、方向、数量对齐、失败回滚，
 * 任何一处不一样就会出现「自动挂的和手动补的不是一回事」——而那种差别只有出事时
 * 才看得出来。因此这份实现**只有一份**，两条路都调它（AGENTS.md 约定 5：
 * 同一概念只有一个名字 / 一份实现）。
 */

import { bracketClientOrderId } from '@trade-tool/core';

/**
 * 单据种类。
 *
 * `tp1` 是分批形态的**第一段止盈**（带数量的那张单）。它与 `tp` 在交易所上的
 * 自定义号形态相同（`rsk-tp-<入场单号>`），但**挂法不同**：带数量 + `reduceOnly`，
 * 而不是 `closePosition`（二者官方明确互斥）。
 */
export type BracketOrderTag = 'tp' | 'tp1' | 'sl';

/**
 * 下单能力。只声明用到的三个方法，测试可整体替身。
 *
 * 全部走 Algo Order API：`algoId` 与普通 `orderId` 是两套独立编号，撤销也各走各的。
 * 这里刻意用 `algoId` 命名而不用 `orderId`——混用只会在撤单时才暴露。
 */
export interface BracketOrderPlacer {
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

export interface PlaceBracketOrdersInput {
  placer: BracketOrderPlacer;
  symbol: string;
  /** 入场单号：条件单的自定义号由它派生。 */
  entryOrderId: string;
  /** 仓位方向。平仓方向与它相反。 */
  positionSide: 'LONG' | 'SHORT';
  /**
   * 挂哪几张。**缺省是两张都挂**（自动路径）。
   *
   * 手动补挂常常只挂缺的那一张（另一张还在交易所上）——此时**不做回滚**：
   * 回滚的前提是「这一轮挂了一对」，而单挂一张不构成一对，撤掉它只会把仓位
   * 扒得更光。
   */
  only?: readonly BracketOrderTag[];
  /** 止盈价（分批形态下是**第一段**的价）。 */
  takeProfitPrice: number;
  /**
   * 第一段减仓量。**只有挂 `tp1` 时才需要**，其余形态传 `null`。
   *
   * 传 `null` 而挂 `tp1` 是**错误**（交易所会拒），因此这里直接抛错而不是发出去。
   */
  tp1Qty: number | null;
  /** 止损价。始终是 `closePosition` 单。 */
  stopPrice: number;
  /**
   * 条件单号里的**档位序号**。
   *
   * `0` = 与进场时那张同名（`rsk-sl-<入场单号>`）。挪单必须传一个更大的号，
   * 因为 Binance 不允许两张同号挂单**同时存在**（§6.8 第 3 条）。
   */
  step?: number;
  workingType: 'MARK_PRICE' | 'CONTRACT_PRICE';
  priceProtect: boolean;
}

export interface PlaceBracketOrdersResult {
  /**
   * 挂上的止盈单号（`tp1` 形态也是止盈）。没挂时为 `null`。
   *
   * ⚠️ **它可能是「挂上了又被撤掉」的那一张**：回滚时单号仍然返回，
   * 与自动路径的既有行为一致（记录里留着这个号，事后能查到「当时挂的是哪一张、
   * 为什么撤的」）。撤没撤看 {@link PlaceBracketOrdersResult.cancelNote}。
   */
  tpAlgoId: number | null;
  /** 挂上的止损单号。没挂或失败时为 `null`。 */
  slAlgoId: number | null;
  /** 失败原因（人可读）。成功时为 `null`。 */
  error: string | null;
  /**
   * 撤单回滚的说明。
   *
   * 「撤单也失败了」必须**单独说**：那意味着交易所上可能**还留着**一张没有对单的
   * 止盈——正是「有止盈没止损」那种最危险的状态，不能让它悄悄过去。
   */
  cancelNote: string | null;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 挂这一对（或其中一张）保护单。
 *
 * **顺序是硬约定**：先止盈、后止损。反过来的话，止盈挂上后止损失败，
 * 我们连一张可以撤的单都没有，仓位直接裸奔。
 *
 * **失败回滚**：第二张失败就撤掉第一张。留一张没有对单的止盈/止损，
 * 比两张都没有更危险。
 */
export async function placeBracketOrders(
  input: PlaceBracketOrdersInput,
): Promise<PlaceBracketOrdersResult> {
  const {
    placer,
    symbol,
    entryOrderId,
    positionSide,
    takeProfitPrice,
    tp1Qty,
    stopPrice,
    step = 0,
    workingType,
    priceProtect,
  } = input;
  const tags: readonly BracketOrderTag[] = input.only ?? ['tp', 'sl'];
  // 平仓方向与开仓方向相反。
  const exitSide = positionSide === 'LONG' ? 'SELL' : 'BUY';

  let tpAlgoId: number | null = null;
  let slAlgoId: number | null = null;
  let cancelNote: string | null = null;

  try {
    if (tags.includes('tp1')) {
      if (tp1Qty === null) {
        throw new Error('分批形态的第一段止盈必须带数量');
      }
      const tp = await placer.placeQuantityOrder({
        symbol,
        side: exitSide,
        type: 'TAKE_PROFIT_MARKET',
        stopPrice: takeProfitPrice,
        quantity: tp1Qty,
        reduceOnly: true,
        clientAlgoId: bracketClientOrderId('tp', entryOrderId, step),
        workingType,
        priceProtect,
      });
      tpAlgoId = tp.algoId;
    } else if (tags.includes('tp')) {
      const tp = await placer.placeClosePositionOrder({
        symbol,
        side: exitSide,
        type: 'TAKE_PROFIT_MARKET',
        stopPrice: takeProfitPrice,
        clientAlgoId: bracketClientOrderId('tp', entryOrderId, step),
        workingType,
        priceProtect,
      });
      tpAlgoId = tp.algoId;
    }

    if (tags.includes('sl')) {
      const sl = await placer.placeClosePositionOrder({
        symbol,
        side: exitSide,
        type: 'STOP_MARKET',
        stopPrice,
        clientAlgoId: bracketClientOrderId('sl', entryOrderId, step),
        workingType,
        priceProtect,
      });
      slAlgoId = sl.algoId;
    }
  } catch (error) {
    // 这一轮挂了「一对」而第二张失败 → 撤掉先挂上的那张。
    //
    // 判据是「**这一轮真的挂上了一张止盈**」（`tpAlgoId !== null`）：只挂一张时
    // 不撤——撤掉它不会让仓位更安全，只会让它从「有止损」变成「什么也没有」。
    // 那种情况该做的是**报出来**，不是替人做决定。
    if (tpAlgoId !== null) {
      try {
        await placer.cancelAlgoOrder(tpAlgoId);
        cancelNote = `；已撤掉先挂上的条件单 ${tpAlgoId}`;
      } catch (cancelError) {
        cancelNote = `；**撤单也失败了**（条件单 ${tpAlgoId} 可能仍在交易所挂着）：${reasonOf(cancelError)}`;
      }
    }
    return { tpAlgoId, slAlgoId, error: reasonOf(error), cancelNote };
  }

  return { tpAlgoId, slAlgoId, error: null, cancelNote };
}
