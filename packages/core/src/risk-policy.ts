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
  /**
   * 仓位方向。**只有 LONG / SHORT**：方向由入场成交的买卖决定，`BOTH` 是账户的
   * 持仓模式（双向模式），不是仓位方向。收窄它，下游算盈亏时就不必再处理
   * 一个永远不会出现的取值。
   */
  positionSide: 'LONG' | 'SHORT';
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
 * 按**步长的整数倍**对齐到 `step`。`mode` 决定往哪边取整，**不做四舍五入**。
 *
 * 价格与数量是同一套算式（都只是「对齐到某个步长」），因此只有这一份实现：
 * 两处各写一遍四舍五入的近似，会让「价格对齐了但数量没对齐」这种错误在核对时
 * 完全看不出来（§5 第 5 条：同一概念只有一个实现）。
 *
 * 对齐的基准是**步长的整数倍**，不是「小数位数」——`step = 0.5` 时小数位是 1 位，
 * 按位数对齐会得到 1050.6 而不是 1050.5。前者在某些标的上每次都偏半个 step，
 * 累积起来足以让止损位偏离预期。
 */
function alignToStep(value: number, step: number, mode: 'down' | 'up', what: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new SyncError('CONFIG_INVALID', `${what}必须为正：${String(value)}`, { value });
  }
  decimalsOf(step); // 先校验 step 合法
  const scaled = value / step;
  // 浮点误差修正：`1050 / 0.01` 可能得到 104999.99999999999。
  // 只在**足够接近整数**时吸附，否则保持原值——否则一次四舍五入会
  // 把一个「刚好比 1050 小一点」的真实值抬到 1050，止损就变紧了一个 tick。
  const nearest = Math.round(scaled);
  const stable = Math.abs(scaled - nearest) < 1e-9 ? nearest : scaled;
  const steps = mode === 'down' ? Math.floor(stable) : Math.ceil(stable);
  const result = steps * step;
  if (!Number.isFinite(result) || result <= 0) {
    throw new SyncError(
      'CONFIG_INVALID',
      `${what} ${value} 对齐到步长 ${step} 后为 0：标的精度与该取值不匹配`,
      { value, step },
    );
  }
  // 乘回去可能引入尾数噪声（10506 * 0.01 = 105.05999999999999），按步长的位数抹平。
  return Number(result.toFixed(decimalsOf(step)));
}

/** 对齐到最小价格变动。`mode` 决定往哪边取整，**不做四舍五入**。 */
export function alignToTick(price: number, tickSize: number, mode: 'down' | 'up'): number {
  return alignToStep(price, tickSize, mode, '价格');
}

/**
 * 对齐到最小下单数量（`LOT_SIZE.stepSize`）。
 *
 * 为什么单独一个函数名而不是复用 `alignToTick`：它们是两个不同的标的属性，
 * 调用方读错一个就是「价格对了但数量错了」。算式只有一份（`alignToStep`），
 * 名字必须各自说得清自己在对齐什么（§5 第 5 条）。
 */
export function alignToQty(qty: number, stepSize: number, mode: 'down' | 'up'): number {
  return alignToStep(qty, stepSize, mode, '数量');
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

/**
 * 第一段减仓比例 ⇄ 页面上的百分数。**只有这一份实现**。
 *
 * 为什么不让控制面自己 `÷ 100`：那样库里存 0.8、页面上存 80、纯函数算 0.8，
 * 三处各有一份口径，出现「页面显示 80% 而实际减了 79.99%」时根本无从查起
 * （§6.4 第 4 条治的正是这个）。
 */
export function ratioToPercent(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    throw new SyncError('CONFIG_INVALID', `第一段减仓比例必须在 [0, 1] 内：${String(ratio)}`, {
      ratio,
    });
  }
  // 0.8 × 100 = 80.00000000000001，抹到 6 位小数足够表达任意可配置的百分比。
  return Math.round(ratio * 100 * 1e6) / 1e6;
}

/** 页面上的百分数 → 第一段减仓比例。见 {@link ratioToPercent}。 */
export function percentToRatio(percent: number): number {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new SyncError(
      'CONFIG_INVALID',
      `第一段减仓百分比必须在 [0, 100] 内：${String(percent)}`,
      { percent },
    );
  }
  return percent / 100;
}

/** 给人看的一行摘要（写进 `clientOrderId` 之外的日志与状态里）。 */
export function describePlan(plan: BracketPlan): string {
  return (
    `${plan.positionSide} 入场 ${plan.entryPrice} ATR=${plan.atr} ` +
    `止损 ${plan.stopPrice}（-${plan.stopDistance}）止盈 ${plan.takeProfitPrice}（+${plan.takeProfitDistance}）` +
    ` R:R=${plan.riskReward.toFixed(2)}`
  );
}

// ---------------------------------------------------------------------------
// 两段止盈（v0.7.0）
// ---------------------------------------------------------------------------

/**
 * 止盈的两种形态。**只有一个止盈倍数**，它决定「这次要卖的那部分，涨到离入场多远就卖」。
 *
 * | `takeProfit1Ratio` | 形态                    | 止盈单                          |
 * | ----------------- | ----------------------- | ------------------------------- |
 * | `0`               | `single`（v0.4.0 行为）  | `closePosition`，全平           |
 * | `(0, 1)`          | `partial`               | `quantity = tp1Qty`，减仓一部分 |
 *
 * 两种形态的止盈价用**同一个**倍数算（`takeProfitAtrMult`）：不分批时它是全平目标，
 * 分批时它是先兑现那一段的目标——剩下的仓位交给移动止损。
 *
 * ## 为什么只剩两种形态
 *
 * v0.7.0 原本有第三种（比例 = `1`，「用另一个倍数全平」）与**两个**止盈倍数。
 * 那一档功能上完全冗余（比例 = 0 + 把止盈倍数填成同一个数，效果逐字相同），
 * 却在两处制造了真实的错：
 *
 *   * 算出来的「整段价」被当成实际挂单价落库，页面显示的「止盈价」因此是一个
 *     **从没挂出去过**的价，对账每轮报一次 `price-mismatch` 假警报；
 *   * 分批形态下「整段价」压根不挂单（剩余仓位交给移动止损），却仍要参与
 *     「第一段必须比整段近」的比较——那是一道与真实挂单无关的自检。
 *
 * 于是合并成一个倍数：比例 = `1` 归一到 `0`（见 {@link normalizeTakeProfit1Ratio}），
 * 「整段止盈价」这个概念整个消失。**页面上从此只有一个止盈倍数可填。**
 */
export type StagedMode = 'single' | 'partial';

/**
 * 第一段减仓比例的归一：**`1` 归一到 `0`**。
 *
 * 只有一个止盈倍数之后，「比例 = 1」与「比例 = 0」逐字等价（都是一次全平、都用
 * `takeProfitAtrMult` 算价），因此 `1` 不再是独立取值。
 *
 * **只有这一份实现**，两处都要用：
 *
 *   * 决策落库前——留痕必须记归一后的值，否则事后对不上「当时用的哪套档位」；
 *   * 算价时——兜底，防止任何一个绕过归一的调用方把 `1` 带进来。
 *
 * 两处各写一遍 `ratio >= 1 ? 0 : ratio` 的话，改了一处忘了另一处，就会出现
 * 「留痕是 0、算价是 1」这种查不出来的不一致。
 */
export function normalizeTakeProfit1Ratio(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    throw new SyncError(
      'CONFIG_INVALID',
      `第一段减仓比例必须在 [0, 1] 内（收到 ${String(ratio)}）`,
      { ratio },
    );
  }
  return ratio >= 1 ? 0 : ratio;
}

export interface StagedPlanInput {
  side: EntrySide;
  entryPrice: number;
  atr: number;
  atrPeriod: number;
  /** 最小价格变动。 */
  tickSize: number;
  /**
   * 最小下单数量（`LOT_SIZE.stepSize`）。
   *
   * **只有 `mode = 'partial'` 才必须给**：不分批时止盈单是 `closePosition`，
   * 不带数量，因此不去读 `LOT_SIZE`——让不需要它的路径也依赖它，等于凭空给
   * `exchangeInfo` 快照加了一个无关的硬要求。
   */
  stepSize?: number;
  /** 入场成交量（`cumulativeQty`）。 */
  filledQty: number;
  stopAtrMult: number;
  /**
   * 止盈倍数。**两种形态都用它**：不分批时是全平目标，分批时是先兑现那一段的目标。
   */
  takeProfitAtrMult: number;
  /** 第一段减仓比例，`[0, 1]`；`1` 会先经 {@link normalizeTakeProfit1Ratio} 归一到 `0`。 */
  takeProfit1Ratio: number;
}

export interface StagedPlan {
  mode: StagedMode;
  /** 仓位方向。同 `BracketPlan.positionSide`：只有 LONG / SHORT。 */
  positionSide: 'LONG' | 'SHORT';
  /** 平仓方向：平多是 SELL，平空是 BUY。 */
  exitSide: OrderSide;
  entryPrice: number;
  atr: number;
  /** 止损价。**始终**是 `closePosition` 单，保护的是当时剩余的全部仓位。 */
  stopPrice: number;
  stopDistance: number;
  /**
   * 止盈价。**这一形态下真正会挂在交易所上的那个价**——落库与页面显示都读它，
   * 所以它必须永远是实际挂出去的那个价。
   */
  takeProfitPrice: number;
  /** 第一段减仓量。**只有** `partial` 模式有值（其余为 `null`，不留 0 冒充）。 */
  tp1Qty: number | null;
  /** `partial` 模式下第一段占整段的比例，仅供日志与页面显示。 */
  ratio: number;
}

/**
 * 算出第一段止盈的价与量，以及不变的止损价。
 *
 * 不变量（与 `deriveBracketPlan` 同源）：
 *   * 所有价格朝**远离入场价**的方向对齐；
 *   * 止损仍是 `closePosition` 单，减仓之后继续有效，因此**不需要**因为分批而重挂；
 *   * `0 < tp1Qty < filledQty`，取整后不满足就报错，**不**悄悄改成「不减仓」或「全平」。
 */
export function deriveStagedPlan(input: StagedPlanInput): StagedPlan {
  const {
    side,
    entryPrice,
    atr,
    atrPeriod,
    tickSize,
    stepSize,
    filledQty,
    stopAtrMult,
    takeProfitAtrMult,
    takeProfit1Ratio,
  } = input;

  if (!Number.isFinite(filledQty) || filledQty <= 0) {
    throw new SyncError('CONFIG_INVALID', `成交数量必须为正：${String(filledQty)}`, { filledQty });
  }
  // 归一在**这里**也做一次（除了决策落库前那次）：比例 = 1 与 0 逐字等价，
  // 统一按「不分批」处理，免得任何一个绕过归一的调用方把旧取值带进来。
  const ratio = normalizeTakeProfit1Ratio(takeProfit1Ratio);

  const isLong = side === 'BUY';
  const mode: StagedMode = ratio === 0 ? 'single' : 'partial';
  // 靠近入场价的一侧：多头向下、空头向上。
  const nearMode = isLong ? 'down' : 'up';

  // 止损的算式完全复用 v0.4.0 的口径，不另抄一遍。
  const stopRaw = isLong ? entryPrice - stopAtrMult * atr : entryPrice + stopAtrMult * atr;
  const stopPrice = alignToTick(stopRaw, tickSize, nearMode);

  /**
   * 校验止损价与**会挂出去的那个止盈价**分居入场价两侧。
   *
   * 与 `deriveBracketPlan` 的同一判断保持一致，不在这里另写一套宽松版。
   *
   * 只校验**实际挂单**的那一个价：v0.7.0 曾经在这里校验一个「整段价」，
   * 而那一档下整段价压根不挂单——于是「填了没用」的数也能把整笔买入的保护单卡住，
   * 报错还指向一个从没挂出去的价格。
   */
  const assertStraddles = (price: number): void => {
    const straddles = isLong
      ? stopPrice < entryPrice && price > entryPrice
      : stopPrice > entryPrice && price < entryPrice;
    if (!straddles) {
      throw new SyncError(
        'CONFIG_INVALID',
        `ATR(${atrPeriod}) = ${atr} 相对 tick(${tickSize}) 与入场价 ${entryPrice} 太小，` +
          `算出的止损/止盈会落在入场价同一侧（stop=${stopPrice}, tp=${price}）`,
        { entryPrice, atr, atrPeriod, tickSize, stopPrice, takeProfitPrice: price },
      );
    }
  };

  /**
   * 止盈价。**两种形态用同一个倍数算**：它是「这次要卖的那部分，涨到离入场多远就卖」。
   *
   * 不分批时卖全部（`closePosition` 单）；分批时先卖这一部分（带数量的单），
   * 剩下的仓位交给移动止损。
   */
  const takeProfitRaw = isLong
    ? entryPrice + takeProfitAtrMult * atr
    : entryPrice - takeProfitAtrMult * atr;
  const takeProfitPrice = alignToTick(takeProfitRaw, tickSize, nearMode);
  assertStraddles(takeProfitPrice);

  if (mode === 'single') {
    return {
      mode,
      positionSide: isLong ? 'LONG' : 'SHORT',
      exitSide: isLong ? 'SELL' : 'BUY',
      entryPrice,
      atr,
      stopPrice,
      stopDistance: Math.abs(entryPrice - stopPrice),
      takeProfitPrice,
      tp1Qty: null,
      ratio: 0,
    };
  }

  // 减仓量向下取整：宁可少减一点，也不要多减到超过持仓量。
  // 对齐层在「取整后为 0」时会先抛错，而那条消息说的是步长；这里补上
  // 「这一段为什么不能成立」的上下文，否则排障的人只看到 0.0005 对齐到 0。
  if (stepSize === undefined) {
    throw new SyncError('CONFIG_INVALID', '分批形态必须提供 stepSize（最小下单数量）', {
      symbol: undefined,
      stepSize,
    });
  }
  let tp1Qty: number;
  try {
    tp1Qty = alignToQty(filledQty * ratio, stepSize, 'down');
  } catch (error) {
    throw new SyncError(
      'CONFIG_INVALID',
      `按比例 ${ratio} 与步长 ${stepSize} 取整后无法得到合法的第一段数量` +
        `（持仓 ${filledQty}）：拒绝这一段，不改成「不减仓」也不改成「全平」`,
      { filledQty, takeProfit1Ratio: ratio, stepSize },
    );
  }
  if (tp1Qty <= 0 || tp1Qty >= filledQty) {
    throw new SyncError(
      'CONFIG_INVALID',
      `按比例 ${ratio} 与步长 ${stepSize} 取整后，第一段数量为 ${tp1Qty}，` +
        `不满足 0 < q < 持仓 ${filledQty}——拒绝这一段，不改成「不减仓」也不改成「全平」`,
      { filledQty, takeProfit1Ratio: ratio, stepSize, tp1Qty },
    );
  }

  return {
    mode,
    positionSide: isLong ? 'LONG' : 'SHORT',
    exitSide: isLong ? 'SELL' : 'BUY',
    entryPrice,
    atr,
    stopPrice,
    stopDistance: Math.abs(entryPrice - stopPrice),
    // 分批形态下挂出去的就是这个价（带数量的那张单），落库的 `take_profit` 也是它。
    takeProfitPrice,
    tp1Qty,
    ratio,
  };
}

/** 移动止损没有移动时的原因。常驻可见，不静默跳过（AGENTS.md 约定 9）。 */
export type TrailingReason = 'moved' | 'breakeven' | 'unchanged' | 'beyond-price';

export interface TrailingPlanInput {
  side: EntrySide;
  /** 当前生效的那一档止损价。第一轮传入场时算出的原始止损价。 */
  prevStop: number;
  /** 持仓期极值：多头取区间内最高 high，空头取最低 low。 */
  extreme: number;
  /** 当前 ATR（`k × ATR(最新)`）。 */
  atr: number;
  entryPrice: number;
  tickSize: number;
  /** Chandelier 的倍数。 */
  trailAtrMult: number;
  /** 保本偏移（以 ATR 计）。`0` = 正好保本。 */
  breakevenOffsetAtr?: number;
  /** 是否启用保本档位（`breakevenAfterTp1`）。 */
  applyBreakeven: boolean;
  /**
   * 参考现价：库内最新已收盘 1m 的 `close`（滞后不超过一根 K 线）。
   *
   * 刻意**不引入** markPrice 流——它只用来做一个粗判（止损位有没有越过现价），
   * 而多一条流就多一套重连逻辑。
   */
  referencePrice: number;
}

export interface TrailingPlan {
  /** 要挂上去的那一档。没有移动时**等于** `prevStop`（不是空值、也不是 0）。 */
  stopPrice: number;
  /** 是否需要撤旧挂新。`false` 时调用方**必须**跳过一切下单动作。 */
  changed: boolean;
  reason: TrailingReason;
}

/**
 * Chandelier 移动止损：多头 `stop = max(旧档, 极值 − k×ATR)`，空头完全镜像。
 *
 * 三条不可协商的口径：
 *
 * 1. **只朝有利方向移动，永不放宽。** 棘轮的方向由 `max`（多头）/ `min`（空头）保证，
 *    回落时止损不会跟着退回去——放宽止损等于偷偷放大风险。
 * 2. **对齐方向钉死**：候选价向下取整（多头）/ 向上取整（空头）。反一个 tick 就可能
 *    让「刚挂上就必被扫」。
 * 3. **止损位越过现价时不调整**（`reason: 'beyond-price'`）。那意味着极值已回撤到吃掉全部
 *    浮盈，挂上去会立刻触发。此刻平仓属于策略决策（严格追踪），不该由一个只负责
 *    「挪止损」的纯函数顺手做掉。
 */
export function deriveTrailingPlan(input: TrailingPlanInput): TrailingPlan {
  const {
    side,
    prevStop,
    extreme,
    atr,
    entryPrice,
    tickSize,
    trailAtrMult,
    applyBreakeven,
    referencePrice,
  } = input;
  const breakevenOffsetAtr = input.breakevenOffsetAtr ?? 0;

  for (const [name, value] of [
    ['prevStop', prevStop],
    ['extreme', extreme],
    ['entryPrice', entryPrice],
    ['referencePrice', referencePrice],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new SyncError('CONFIG_INVALID', `${name} 必须为正：${String(value)}`, {
        [name]: value,
      });
    }
  }
  if (!Number.isFinite(atr) || atr <= 0) {
    throw new SyncError('CONFIG_INVALID', `ATR 必须为正：${String(atr)}`, { atr });
  }
  if (!Number.isFinite(trailAtrMult) || trailAtrMult <= 0) {
    throw new SyncError('CONFIG_INVALID', `trailAtrMult 必须为正：${String(trailAtrMult)}`, {
      trailAtrMult,
    });
  }
  if (!Number.isFinite(breakevenOffsetAtr) || breakevenOffsetAtr < 0) {
    throw new SyncError('CONFIG_INVALID', `保本偏移必须非负：${String(breakevenOffsetAtr)}`, {
      breakevenOffsetAtr,
    });
  }

  const isLong = side === 'BUY';
  const raw = isLong ? extreme - trailAtrMult * atr : extreme + trailAtrMult * atr;
  const cand = alignToTick(raw, tickSize, isLong ? 'down' : 'up');

  let stop = isLong ? Math.max(prevStop, cand) : Math.min(prevStop, cand);
  let reason: TrailingReason = stop === prevStop ? 'unchanged' : 'moved';

  if (applyBreakeven) {
    const breakevenRaw = isLong
      ? entryPrice + breakevenOffsetAtr * atr
      : entryPrice - breakevenOffsetAtr * atr;
    // 保本位朝**有利方向**对齐：多头向上、空头向下，保证它不低于（不低于入场价）。
    const breakeven = alignToTick(breakevenRaw, tickSize, isLong ? 'up' : 'down');
    const better = isLong ? breakeven > stop : breakeven < stop;
    if (better) {
      stop = breakeven;
      reason = 'breakeven';
    }
  }

  // 越过现价就不动：保留旧档，把原因交出去让人看见。
  const crossed = isLong ? stop >= referencePrice : stop <= referencePrice;
  if (crossed) {
    return { stopPrice: prevStop, changed: false, reason: 'beyond-price' };
  }
  return { stopPrice: stop, changed: stop !== prevStop, reason };
}
