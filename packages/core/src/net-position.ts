/**
 * 净仓位的本地跟踪（v0.4.1）。
 *
 * ## 为什么需要它
 *
 * 判定「这笔成交是新开仓、减仓还是平仓」需要**净仓位的事实**，而不是成交方向。
 * 只做多时「SELL = 减仓」成立；支持做空后它是错的——开空仓也是 SELL。
 *
 * 但这个事实**拿不到**，这正是实测踩到的坑：
 *
 * 1. USDⓈ-M 的 `ORDER_TRADE_UPDATE` 是**订单**事件（新订单 / 新成交 / 状态变化），
 *    **不带仓位**。仓位在 `ACCOUNT_UPDATE` 的 `a.P[]` 里（`s` / `pa` / `ep` / `ps` …），
 *    且官方注明「仅当 symbol 仓位有变动时推送」，资金费的简略事件甚至不带 `P`。
 *    （第一版实现把判据挂在 `ORDER_TRADE_UPDATE` 的 `a.P` 上，实测恒为 `null`——死代码。）
 * 2. 改走 `ACCOUNT_UPDATE` 也不行：官方只保证**同一事件类型内部**按 `T` / `E` 严格有序，
 *    `ACCOUNT_UPDATE` 与 `ORDER_TRADE_UPDATE` 之间**没有顺序保证**。
 *    「等 ACCOUNT_UPDATE 到了再处理这笔成交」会漏掉先到的成交事件。
 * 3. 每一笔成交都出网查一次 `positionRisk`：慢、吃配额，而且正好被本机时钟偏差打挂
 *    （见 `packages/core/src/clock-skew.ts`）——实测三笔成交全部因此没挂上保护。
 *
 * ## 这里的做法
 *
 * **主路径 = 流内增量净额**：种子取自启动时的 `positionRisk`，之后每笔成交
 * `净额 += (BUY ? +lastFilledQty : −lastFilledQty)`。单向持仓模式下这与交易所的净额
 * **逐笔等价**——因为账户上的每一笔成交（手动下的也包括）都会出现在用户数据流里。
 * 它不依赖事件之间的顺序，也不需要每笔出网。
 *
 * **校正信号 = `ACCOUNT_UPDATE`**：收到就用它覆盖本地净额。
 * 它不是唯一来源（因此不受事件乱序影响），但它是权威值，会把任何漂移拉回来。
 *
 * ## 失步与收敛
 *
 * 唯一的失步来源是**漏事件**：断线期间用户数据流不重放。
 * 因此 `seed()` 在每次重连后都必须再调一次——重连正是可能漏事件的时刻，
 * 而这是调用方的责任，本文件不做「我觉得应该已经同步了」的假设。
 *
 * 纯逻辑，不读时钟、不做 IO：IO 全在 `apps/executor` 那边。
 */

/** 一次成交带来的净仓位增量。 */
export function signedFillDelta(side: 'BUY' | 'SELL', lastFilledQty: number): number {
  if (!Number.isFinite(lastFilledQty)) {
    throw new TypeError(`成交数量不是有限数字：${String(lastFilledQty)}`);
  }
  return side === 'BUY' ? lastFilledQty : -lastFilledQty;
}

/**
 * 「算作空仓」的容差。
 *
 * **这不是可有可无的细节**：净额是逐笔浮点累加出来的，平掉一手 0.1 的仓位后
 * 得到的是 `-2.7755575615628914e-17` 而不是 `0`。若判定写成 `=== 0`，
 * 平仓会被判成「还在减仓」，于是 `cancelled` 收敛**永远不触发**——
 * 正是本文件要修的那个漂移会以另一种形式活下来。
 *
 * 取 1e-9：远小于交易所的最小下单量（合约面值普遍 ≥ 1e-3），
 * 因此不可能把一个真实存在的仓位误判成空仓。
 */
export const POSITION_EPSILON = 1e-9;

/** 把浮点残差收敛到 0，避免 `-2.7e-17` 这种值一路传下去。 */
export function snapToFlat(value: number): number {
  return Math.abs(value) < POSITION_EPSILON ? 0 : value;
}

/**
 * 由「本笔成交前后的净额」判定它做了什么。
 *
 * 三段，与 AGENTS.md §6.3 第 7 条一一对应：
 * - 归零 → 工具外平仓（此前的仓位没了）；
 * - 方向与成交相反 → 在原有仓位上加仓（减仓），由它自己的单触发；
 * - 方向与成交一致 → 新开仓。
 */
export function classifyFill(input: {
  side: 'BUY' | 'SELL';
  /** 本笔成交带来的增量（`signedFillDelta` 的结果）。 */
  delta: number;
  /** 本笔成交**之后**的净仓位。 */
  positionAfter: number;
}): 'opened' | 'reduced' | 'closed' {
  const after = snapToFlat(input.positionAfter);
  if (after === 0) return 'closed';
  const opens = input.side === 'BUY' ? after > 0 : after < 0;
  return opens ? 'opened' : 'reduced';
}

/**
 * 净仓位表。
 *
 * 只存**被跟踪过**的标的：没见过的标的读出来是 `undefined` 而不是 `0`——
 * 「没跟踪过」与「空仓」是两件事，混同会让第一次成交被当成平仓。
 */
/** 一笔成交对净额的实际作用结果。 */
export interface FillApplication {
  /** 成交之后的净仓位（**无论是否累加**，都是「此刻交易所应该是什么样」）。 */
  positionAfter: number;
  /** 是否真的累加了。`false` = 效果已包含在一次校正里，跳过以免双计。 */
  applied: boolean;
}

export class NetPositionTracker {
  private readonly net = new Map<string, number>();
  /** 每个标的「已校正到哪个撮合时刻」——比它早的成交效果都已经算进去了。 */
  private readonly syncedAt = new Map<string, number>();

  /** 播种某个标的的起始净额。启动与**每次重连**后都要调。 */
  seed(symbol: string, positionAmt: number): void {
    if (!Number.isFinite(positionAmt)) {
      throw new TypeError(`初始净仓位不是有限数字：${String(positionAmt)}`);
    }
    this.net.set(symbol, snapToFlat(positionAmt));
  }

  /**
   * 用 `ACCOUNT_UPDATE` 的权威值校正。
   *
   * 「没有这条事件的标的」不做任何事——`ACCOUNT_UPDATE` 只推**变动了**的仓位，
   * 拿它当全量快照会把没变过的仓位清零。
   */
  correct(symbol: string, positionAmt: number, tradeTime: number): void {
    if (!Number.isFinite(tradeTime)) {
      throw new TypeError(`校正的撮合时间不是有限数字：${String(tradeTime)}`);
    }
    this.seed(symbol, positionAmt);
    this.syncedAt.set(symbol, tradeTime);
  }

  /** 当前净仓位。未跟踪过返回 `undefined`。 */
  get(symbol: string): number | undefined {
    return this.net.get(symbol);
  }

  /**
   * 记一笔成交，返回成交**之后**的净仓位。标的没播种过就地初始化为 0。
   *
   * ## 为什么要带 `tradeTime`
   *
   * `ACCOUNT_UPDATE` 与 `ORDER_TRADE_UPDATE` 之间**没有顺序保证**，而两者描述的
   * 往往是**同一个事实**：那笔平仓成交让仓位变成 0，交易所随即推来「仓位 = 0」。
   * 校正已经把该成交的效果提前计入，若它随后又被累加一次，就会凭空造出一个反向仓位。
   *
   * 实测就是这个形态：平空仓的 BUY 成交 → 校正到 0 → 该成交再被累加 →
   * 本地以为新开了多仓 → 挂止盈止损 → 交易所无仓位 → GTE 报错。
   *
   * 规则：**撮合时间不晚于最近一次校正的那笔成交，效果已含在校正中，跳过累加。**
   * 但仍要返回当前净额——判定要用它，那笔成交正是把仓位变平的一笔。
   */
  applyFill(symbol: string, delta: number, tradeTime: number): FillApplication {
    if (!Number.isFinite(delta)) {
      throw new TypeError(`净仓位增量不是有限数字：${String(delta)}`);
    }
    if (!Number.isFinite(tradeTime)) {
      throw new TypeError(`成交撮合时间不是有限数字：${String(tradeTime)}`);
    }
    const syncedAt = this.syncedAt.get(symbol);
    if (syncedAt !== undefined && tradeTime <= syncedAt) {
      return { positionAfter: this.net.get(symbol) ?? 0, applied: false };
    }
    const next = snapToFlat((this.net.get(symbol) ?? 0) + delta);
    this.net.set(symbol, next);
    return { positionAfter: next, applied: true };
  }

  /**
   * 记一笔成交并直接返回净额。**只给「不可能与校正重叠」的调用方用**——
   * 测试与离线推演。真事件流请走 `applyFill`。
   */
  apply(symbol: string, delta: number): number {
    // 用一个比任何撮合时间都大的有限值：既通过有限性校验，又永远不会被「已计入校正」跳过。
    return this.applyFill(symbol, delta, Number.MAX_SAFE_INTEGER).positionAfter;
  }

  /** 丢掉全部跟踪状态。重连后重新播种的第一步。 */
  reset(): void {
    this.net.clear();
    this.syncedAt.clear();
  }

  /** 丢掉某个标的的跟踪状态（重连后重新播种前调用，避免用到过期净额）。 */
  forget(symbol: string): void {
    this.net.delete(symbol);
  }

  /** 当前跟踪的标的数，用于诊断。 */
  get size(): number {
    return this.net.size;
  }
}
