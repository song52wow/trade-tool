/**
 * 盈亏口径（v0.8.0）。
 *
 * **一律用计价币算。** 本仓库做的是 Binance USDⓈ-M 永续（USDT 计价），所以
 * 「价差 × 数量」天然就是 USDT——不换算、不折算、不用汇率。
 *
 * 为什么值得写死：一旦有人拿「点数」「百分比」「BTC 数量」来表达盈亏，通知、页面、
 * 日志就会各算各的。而「这一轮到底赚没赚、赚了多少」恰恰是**最不该有歧义**的一个数——
 * 它直接决定「这一单该不该继续做」。
 *
 * 两个函数都是**纯函数**：不读时钟、不做 IO、不用随机数。
 */

/** 计价币。USDⓈ-M 永续的成交价与手续费都以它计价。 */
export const QUOTE_ASSET = 'USDT';

export type PnlSide = 'LONG' | 'SHORT';

/**
 * 挂上止盈止损那一刻的**预估**盈亏。
 *
 * 是预估不是实际：止盈/止损是「万一打到」，实际能不能打到、什么时候打到，取决于市场。
 */
export interface BracketPnlEstimate {
  /** 打到止盈的收益（计价币，正数 = 赚）。 */
  expectedProfit: number;
  /** 打到止损的亏损（计价币，正数 = 亏这么多）。 */
  expectedLoss: number;
}

/**
 * 挂单时的预估盈亏。
 *
 * 方向由 `positionSide` 决定：多头 `(止盈 − 入场) × 数量`，空头反过来。
 * 计划（`deriveBracketPlan`）保证止盈在盈利侧、止损在亏损侧，因此两个返回值恒为正；
 * 万一拿到的计划方向反了，这里会算出负数——**露出来**，而不是被 `abs()` 抹平。
 */
export function estimateBracketPnl(input: {
  positionSide: PnlSide;
  entryPrice: number;
  /** 数量（基础币，如 BTC）。 */
  quantity: number;
  takeProfitPrice: number;
  stopPrice: number;
}): BracketPnlEstimate {
  const sign = input.positionSide === 'LONG' ? 1 : -1;
  const pnlAt = (price: number): number => (price - input.entryPrice) * input.quantity * sign;
  return {
    expectedProfit: pnlAt(input.takeProfitPrice),
    expectedLoss: -pnlAt(input.stopPrice),
  };
}

/** 一轮走完之后的**实际**盈亏。 */
export interface RealizedPnl {
  /** 毛利（未扣手续费）。正数 = 赚。 */
  gross: number;
  /** 累计手续费（计价币，正数）。 */
  fee: number;
  /** 净盈亏 = 毛利 − 手续费。正数 = 赚。 */
  net: number;
}

/**
 * 实际盈亏，**手续费从毛利里扣**。
 *
 * 手续费是**整轮**的：入场那笔也收。因此 `feeAmount` 累计的是「入场 + 各段平仓」的
 * 全部手续费（见 `risk_bracket.fee_amount`）。只扣出场那笔，会把一轮的收益算虚高。
 *
 * `exitNotional` 是**累计成交额**（事实），而不是「均价 × 数量」（派生值）。
 * 理由：均价要等整轮走完才算得出，而分批止盈（v0.7.0 的两段模型）的中途状态里
 * 根本没有「整轮的均价」这回事——只平了一段时，任何均价都是半个事实。
 *
 * **返回 `null` = 算不出来**：已经平了仓（`closedQty > 0`）却没拿到出场成交额
 * （`exitNotional === 0`）。这时**不能编一个数**——`(0 − 入场价) × 数量` 会得到一个
 * 巨大的假亏损（2026-10-22 实测：一轮真实止损被算成 −194 USDT，飞书卡片上写着
 * 「出场 0」）。「如实说算不出」比「给一个看着精确的假数」安全得多。
 */
export function realizedPnl(input: {
  positionSide: PnlSide;
  entryPrice: number;
  /** 累计平仓量。 */
  closedQty: number;
  /** 累计平仓成交额（计价币）。 */
  exitNotional: number;
  /** 累计手续费（计价币）。 */
  feeAmount: number;
}): RealizedPnl | null {
  if (input.closedQty > 0 && input.exitNotional === 0) return null;
  const sign = input.positionSide === 'LONG' ? 1 : -1;
  const cost = input.entryPrice * input.closedQty;
  const gross = (input.exitNotional - cost) * sign;
  return { gross, fee: input.feeAmount, net: gross - input.feeAmount };
}
