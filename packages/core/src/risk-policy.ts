/**
 * 止盈止损的**纯策略**（v0.4.0）。
 *
 * 输入：入场价 + 一个 ATR 快照 + 配置里的倍数 + 标的的最小价格变动。
 * 输出：止盈价与止损价。**不读时钟、不做 IO、不用随机数**——同一组输入必须永远
 * 给出同一组价格，因为这份输出会变成真实的平仓指令（AGENTS.md 约定 4）。
 *
 * 口径只有一条，但它必须写在这里而不是散在下单那一层：
 *
 * > 止损 = 入场价 ∓ stopAtrMult × ATR，止盈 = 入场价 ± takeProfitAtrMult × ATR，
 * > 两张单都朝**远离入场价**的方向对齐到最小价格变动。
 *
 * 「远离入场价」不是随手选的：若按四舍五入把止损往入场价方向挪 0.5 个 tick，
 * 实际止损距离就比 ATR 算出来的更近；在 1m ATR 本身就不大的标的上，
 * 这一点 tick 的差别足以让止损变成「刚挂上就必被扫」。止盈同理往回挪，
 * 只会让一个理论上可达、实际总差一点的目标变得可达。
 */

import { SyncError } from './market-sync.js';
import type { OrderSide, PositionSide } from './types.js';

/** 与交易所的买卖方向一致，避免在服务里再造一套方向词表。 */
export type EntrySide = OrderSide;

export interface BracketPolicy {
  /** 入场方向。BUY = 开多，止损在下、止盈在上。 */
  side: EntrySide;
  /** ATR 周期长度，与算它的那个快照一起记账。 */
  atrPeriod: number;
  /** 止损距入场价的 ATR 倍数。 */
  stopAtrMult: number;
  /** 止盈距入场价的 ATR 倍数。 */
  takeProfitAtrMult: number;
}

export interface BracketPlanInput extends BracketPolicy {
  /** 成交均价。 */
  entryPrice: number;
  /** 该时刻的 ATR，必须为正。 */
  atr: number;
  /** 标的最小价格变动（tickSize），来自交易所元数据。 */
  tickSize: number;
}

export interface BracketPlan {
  positionSide: PositionSide;
  /** 平仓方向：平多是 SELL，平空是 BUY。 */
  exitSide: OrderSide;
  entryPrice: number;
  atr: number;
  stopPrice: number;
  takeProfitPrice: number;
  /** 实际止损距离（已对齐到 tick）。 */
  stopDistance: number;
  takeProfitDistance: number;
  /** 止盈距离 / 止损距离。 */
  riskReward: number;
}

/** 小数位数。由 tickSize 的字面量决定（`0.010` → 2 位）。 */
export function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || step <= 0) {
    throw new SyncError('CONFIG_INVALID', `最小价格变动必须为正：${String(step)}`, {
      tickSize: step,
    });
  }
  const text = step.toString();
  const dot = text.indexOf('.');
  if (dot < 0) return 0;
  return Math.min(text.length - dot - 1, 12);
}

/**
 * 对齐到最小价格变动。`mode` 决定往哪边取整，**不做四舍五入**。
 *
 * 对齐的基准是**步长的整数倍**，不是「tickSize 的小数位数」——
 * `tickSize = 0.5` 时小数位是 1 位，按位数对齐会得到 1050.6 而不是 1050.5。
 * 前者在某些标的上每次都偏半个 tick，累积起来足以让止损位偏离预期。
 */
export function alignToTick(price: number, tickSize: number, mode: 'down' | 'up'): number {
  if (!Number.isFinite(price) || price <= 0) {
    throw new SyncError('CONFIG_INVALID', `价格必须为正：${String(price)}`, { price });
  }
  decimalsOf(tickSize); // 先校验 tickSize 合法
  const scaled = price / tickSize;
  // 浮点误差修正：`1050 / 0.01` 可能得到 104999.99999999999。
  // 只在**足够接近整数**时吸附，否则保持原值——否则一次四舍五入会
  // 把一个「刚好比 1050 小一点」的真实值抬到 1050，止损就变紧了一个 tick。
  const nearest = Math.round(scaled);
  const stable = Math.abs(scaled - nearest) < 1e-9 ? nearest : scaled;
  const steps = mode === 'down' ? Math.floor(stable) : Math.ceil(stable);
  const result = steps * tickSize;
  if (!Number.isFinite(result) || result <= 0) {
    throw new SyncError(
      'CONFIG_INVALID',
      `价格 ${price} 对齐到 tick ${tickSize} 后为 0：标的价格精度与该价位不匹配`,
      { price, tickSize },
    );
  }
  // 乘回去可能引入尾数噪声（10506 * 0.01 = 105.05999999999999），按 tick 的位数抹平。
  return Number(result.toFixed(decimalsOf(tickSize)));
}

/**
 * 由 ATR 快照推出止盈止损价。
 *
 * 参数校验全部前置：ATR <= 0 会让止损正好落在入场价上（当场平仓），
 * 倍数为 0 会让止盈止损重合，这两种都必须显式报错而不是算出个怪价格继续。
 */
export function deriveBracketPlan(input: BracketPlanInput): BracketPlan {
  const { side, entryPrice, atr, tickSize, stopAtrMult, takeProfitAtrMult, atrPeriod } = input;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw new SyncError('CONFIG_INVALID', `入场价必须为正：${String(entryPrice)}`, { entryPrice });
  }
  if (!Number.isFinite(atr) || atr <= 0) {
    throw new SyncError(
      'CONFIG_INVALID',
      `ATR 必须为正（收到 ${String(atr)}）：ATR=0 会让止损正好落在入场价上`,
      { atr },
    );
  }
  for (const [name, value] of [
    ['stopAtrMult', stopAtrMult],
    ['takeProfitAtrMult', takeProfitAtrMult],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new SyncError('CONFIG_INVALID', `${name} 必须为正：${String(value)}`, {
        [name]: value,
      });
    }
  }

  const isLong = side === 'BUY';
  // 多头：止损在下、止盈在上；空头完全镜像。
  const rawStop = isLong ? entryPrice - stopAtrMult * atr : entryPrice + stopAtrMult * atr;
  const rawTakeProfit = isLong
    ? entryPrice + takeProfitAtrMult * atr
    : entryPrice - takeProfitAtrMult * atr;

  // 两张单都朝远离入场价的方向对齐：多头向下（空头向上）。
  const mode = isLong ? 'down' : 'up';
  const stopPrice = alignToTick(rawStop, tickSize, mode);
  const takeProfitPrice = alignToTick(rawTakeProfit, tickSize, mode);

  // 对齐后必须仍然分居入场价两侧。否则说明 tickSize 相对 ATR 大到没有意义
  // （例如 ATR 远小于一个最小变动），此时继续下单只会挂出一张必然被拒的单。
  // 多头要求 止损 < 入场 < 止盈；空头完全镜像。
  const straddles = isLong
    ? stopPrice < entryPrice && takeProfitPrice > entryPrice
    : stopPrice > entryPrice && takeProfitPrice < entryPrice;
  if (!straddles) {
    throw new SyncError(
      'CONFIG_INVALID',
      `ATR(${atrPeriod}) = ${atr} 相对 tick(${tickSize}) 与入场价 ${entryPrice} 太小，` +
        `算出的止盈/止损会落在入场价同一侧（stop=${stopPrice}, tp=${takeProfitPrice}）`,
      { entryPrice, atr, atrPeriod, tickSize, stopPrice, takeProfitPrice },
    );
  }

  const stopDistance = Math.abs(entryPrice - stopPrice);
  const takeProfitDistance = Math.abs(takeProfitPrice - entryPrice);
  return {
    positionSide: isLong ? 'LONG' : 'SHORT',
    exitSide: isLong ? 'SELL' : 'BUY',
    entryPrice,
    atr,
    stopPrice,
    takeProfitPrice,
    stopDistance,
    takeProfitDistance,
    riskReward: takeProfitDistance / stopDistance,
  };
}

/** 给人看的一行摘要（写进 `clientOrderId` 之外的日志与状态里）。 */
export function describePlan(plan: BracketPlan): string {
  return (
    `${plan.positionSide} 入场 ${plan.entryPrice} ATR=${plan.atr} ` +
    `止损 ${plan.stopPrice}（-${plan.stopDistance}）止盈 ${plan.takeProfitPrice}（+${plan.takeProfitDistance}）` +
    ` R:R=${plan.riskReward.toFixed(2)}`
  );
}
