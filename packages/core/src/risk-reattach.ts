/**
 * 手动补挂止盈止损的**判据**（v1.3.0）。
 *
 * 回答一个问题：**哪些仓位此刻没有保护，人要动手补挂？**
 *
 * ## 它存在的理由
 *
 * 止盈止损是**成交驱动**的：用户数据流送来一笔成交，才算 ATR、才挂单。于是有几类
 * 故障会让仓位**裸奔**，而它们**都不会**被自动修好：
 *
 * - 用户数据流断了（§6.3.1：2026-10-26 实测，从断开到发现隔了 **24 小时**，
 *   期间开的两个仓都没有止盈止损）；
 * - 私有接口被拒 / 本机时钟偏了（2026-10-31 到 11-06 那 6 天，一单都没挂上）；
 * - 挂了单但回填单号前进程死了；
 * - 单被人在交易所上撤了，而本地还记着「已挂上」。
 *
 * 这些漂移由对账**报出来**（`unprotected-position` / `missing-stop-order` /
 * `position-without-record`），但对账**只报告、绝不动手**（§6.5 第 1 条）：
 * 补挂一张止损会平掉真实仓位且不可逆，「自动修复」与「报告」的风险完全不对称。
 *
 * 因此修复一直是**人工决定**。这个模块是那份决定背后的判据：它只回答
 * 「**该补什么、补在哪、什么情况下不许补**」，**不碰交易所、不写库**。
 *
 * ## 三条口径
 *
 * 1. **判据只有这一份实现。** 对账说「缺止损」而补挂说「不缺」，那是两个出口
 *    对同一件事给出不同结论——报告从此没人敢信（§6.5 第 2 条）。因此
 *    「这一态该有哪些单」直接复用 {@link expectedBracketOrders}。
 * 2. **复现优先于重算。** 已有记录时，**原样复现**它当初算好的价：补挂要的是
 *    「当初打算挂的那一张」，不是「现在重新算的一张」。后者会让同一次故障的
 *    两次处置给出不同的止损位。
 * 3. **不猜、不兜底。** 取不到现价就**拒绝补挂**（挂上去可能立刻以市价平仓），
 *    取不到 ATR 就不给价。宁可让人看见「补不上」，也不让仓位在无人察觉时平掉。
 */

import type { DecisionSource } from './llm-decision.js';
import { expectedBracketOrders } from './reconcile.js';
import type { ExchangeAlgoOrder, ExchangePosition, LocalBracket } from './reconcile.js';
import { algoOrderTag, parseBracketClientOrderId, type BracketTag } from './risk-ids.js';

/**
 * 补挂的四种情形。
 *
 * 前两种是「**一张都没挂上**」，后两种是「**挂了一半**」——处置方式不同，
 * 所以分开记（合成一档就看不出「完全没保护」与「只缺止损」的差别）。
 */
export const REATTACH_KINDS = [
  /** 交易所有仓位，本地没有任何未终结的记录——这笔仓位从没被保护过。 */
  'naked-position',
  /** 本地记录是 `failed`：占坑成功、下单失败，一张单都没挂上。 */
  'unprotected-position',
  /** 本地记为已挂上，交易所上却没有止损单——仓位当前没有任何止损保护。 */
  'missing-stop-order',
  /** 止损还在，止盈不见了。 */
  'missing-take-profit-order',
] as const;

export type ReattachKind = (typeof REATTACH_KINDS)[number];

/**
 * 单据种类。
 *
 * `tp1` 是**分批形态的第一段止盈**（带数量的那张单）。它与 `tp` 在交易所上的
 * `clientAlgoId` 形态**相同**（都是 `rsk-tp-<入场单号>`），但在本地是**两张不同的单**：
 * `tp` 是全平单，`tp1` 是带数量的第一段。因此这里用三个取值区分，
 * 而「交易所上认成哪个标签」由 {@link tagOnExchange} 负责映射。
 */
export type ReattachOrderTag = 'tp' | 'tp1' | 'sl';

/** 本地这一种单，在交易所上认成哪个标签。 */
function tagOnExchange(tag: ReattachOrderTag): BracketTag {
  // `tp1` 与 `tp` 共用同一个自定义号前缀（`rsk-tp-`），因此在交易所上无法区分。
  // 这不是本模块的取舍，而是 `bracketClientOrderId` 的既有约定（§6.3）。
  return tag === 'sl' ? 'sl' : 'tp';
}

/**
 * ATR 快照。**随记录一起存**，好让事后能回答「当时为什么止损在那个价」，
 * 而不必复算（复算会因数据回补而变，§6.3 第 4 条）。
 */
export interface ReattachAtr {
  atr: number;
  atrPeriod: number;
  atrInterval: string;
  atrWindowFrom: number;
  atrWindowTo: number;
}

/**
 * 对账用的本地记录 + 补挂需要的额外几列。
 *
 * 刻意只声明要用的字段：把整份 `risk_bracket` 行拉进来，「这个判据需要什么」
 * 就说不清了。
 */
export interface ReattachRecord extends LocalBracket {
  atr: number;
  atrPeriod: number;
  atrInterval: string;
  atrWindowFrom: number;
  atrWindowTo: number;
  /** 分批形态第一段的数量（`partial_armed` 行有值）。 */
  tp1Qty: number | null;
  decisionSource: DecisionSource;
  decisionStopAtrMult: number | null;
  decisionTakeProfitAtrMult: number | null;
  decisionTakeProfit1Ratio: number | null;
}

/**
 * 「第一段止盈是不是**已经成交**了」的判定结果。
 *
 * - `not-staged`：不分批，根本没有「第一段」这回事；
 * - `tp1-open`：第一段还没成交，仓位仍然是满的；
 * - `tp1-filled`：第一段已成交，仓位少了约一段；
 * - `unknown`：**说不清**——仓位与两种预期都对不上。
 */
export type Tp1FillState = 'not-staged' | 'tp1-open' | 'tp1-filled' | 'unknown';

/**
 * 数量的相对容差。
 *
 * 数量都按 `stepSize` 对齐过，浮点表示的误差在 1e-12 量级；1e-6 的相对容差
 * 远大于它，又足够小——不会把「减了一半」认成「没减」。
 */
const QTY_REL_TOL = 1e-6;

function qtyTolerance(value: number): number {
  return Math.max(1e-9, Math.abs(value) * QTY_REL_TOL);
}

/**
 * 判一判：这一笔的**第一段止盈是不是已经成交了**。
 *
 * ## 为什么要有这个判定
 *
 * 分批形态下第一段止盈是**带数量**的单，它成交后**交易所自动撤掉**——
 * 于是「交易所上找不到那张单」在第一段成交之后是**正常**的（§6.5 第 5 条）。
 *
 * 但「第一段成交了」这个**事实**只有一个记录者：用户数据流（`recordBracketTp1Fill`）。
 * 而用户数据流**可能当时不在**——第一段在 executor 不在的时候成交了，
 * 库里就还留着「该有第一段止盈单」。手动补挂这时有两个坑：
 *
 * 1. **重复减仓**：照着库里补，会再挂一张第一段止盈单 → 再减一次仓；
 * 2. **移动止损永不接手**：记录卡在 `partial_armed`，而移动止损定时器只认
 *    「`tp1_filled_at` 非空」的那些行（§6.8.3）。
 *
 * ## 拿什么判
 *
 * **交易所的实际仓位**。分批形态下第一段成交后，仓位正好少了 `tp1_qty` 那一段：
 *
 * ```
 * 第一段没成交 → 仓位 ≈ 入场数量
 * 第一段已成交 → 仓位 ≈ 入场数量 − 第一段数量
 * ```
 *
 * 两个预期值**对不上**时一律判 `unknown`，**不猜**（§5 第 9 条）：仓位被手工动过、
 * 第一段只成交了一部分、或者用户又加了仓——这几种情况照着记录补都可能挂错数量
 * 或重复减仓。宁可让人看见「补不上」。
 *
 * **纯函数**：同样的输入永远给出同样的输出。
 */
export function detectTp1Fill(input: {
  /** 记录里的入场数量。 */
  filledQty: number;
  /** 第一段止盈的数量；不分批时为 `null`。 */
  tp1Qty: number | null;
  /** 交易所当前的仓位数量（**正数**）。 */
  positionQty: number;
}): Tp1FillState {
  const { filledQty, tp1Qty, positionQty } = input;
  if (tp1Qty === null) return 'not-staged';
  if (!Number.isFinite(filledQty) || !Number.isFinite(positionQty)) return 'unknown';
  if (!(filledQty > 0) || !(positionQty >= 0)) return 'unknown';
  // 表上的约束是 `tp1_qty > 0 AND tp1_qty <= filled_qty`；越界说明数据坏了，
  // 而坏数据不能拿来当判断依据。
  if (tp1Qty <= 0 || tp1Qty > filledQty) return 'unknown';

  const remaining = filledQty - tp1Qty;
  const tolOpen = qtyTolerance(filledQty);
  const tolRemaining = qtyTolerance(remaining);
  // 两个预期值本身就分不开（第一段小到相对误差以内）→ 分不清就是分不清。
  if (Math.abs(filledQty - remaining) <= Math.max(tolOpen, tolRemaining)) return 'unknown';

  if (Math.abs(positionQty - filledQty) <= tolOpen) return 'tp1-open';
  if (Math.abs(positionQty - remaining) <= tolRemaining) return 'tp1-filled';
  return 'unknown';
}

/** 要挂的价与形态。 */
export interface ReattachPrices {
  /** 止损价。 */
  stopPrice: number;
  /**
   * 止盈价。分批形态下它是**第一段**的价；`trailing` 形态下为 `null`
   * （第一段已成交，交易所上不该再有止盈单）。
   */
  takeProfitPrice: number | null;
  /** 分批形态第一段的数量；不分批时为 `null`。 */
  tp1Qty: number | null;
}

/** 一笔要补挂的目标。 */
export interface ReattachTarget {
  kind: ReattachKind;
  symbol: string;
  /**
   * 本地记录的入场单号。
   *
   * `null` = **本地没有记录**（裸仓），补挂时要新建一条。
   */
  entryOrderId: string | null;
  positionSide: 'LONG' | 'SHORT';
  /** 要补哪几张单。 */
  need: readonly ReattachOrderTag[];
  /** 人可读的原因：为什么认定它缺保护。 */
  reason: string;
  /** 算价的基准：入场价。 */
  entryPrice: number;
  /** 仓位数量（正数）。 */
  quantity: number;
  /**
   * **原样复现**用的价与形态。
   *
   * `null` = 这条记录当初**没算出档位**（占位记录），必须现算。
   */
  prices: ReattachPrices | null;
  /** 复现用的 ATR 快照；现算时为 `null`。 */
  atr: ReattachAtr | null;
  /** 现价（判断「挂上去会不会立刻触发」）。取不到时为 `null`。 */
  currentPrice: number | null;
}

/** 不补挂、但要让人知道的事。 */
export interface ReattachSkip {
  symbol: string;
  entryOrderId: string | null;
  reason: string;
}

/**
 * 「第一段止盈已成交、而库里没记」这个**要补记进库**的事实。
 *
 * 补挂路径拿到它就要把它写回 `tp1_filled_at`——否则：
 *
 * - 对账会一直报「止盈单不见了」的假警报（§6.5 第 5 条）；
 * - 移动止损定时器不会认领这一笔，它就永远进不了移动止损（§6.8.3）。
 */
export interface Tp1FillFact {
  /** 该补记到哪条记录上（入场单号）。 */
  entryOrderId: string;
  /**
   * 第一段的成交价。**用触发价近似**——当时没人看着实际成交价。
   *
   * 成交了就是成交了（§6.8.3）：宁可记一个带滑点误差的价，
   * 也不要让这一段成交的事实整个丢掉——那样盈亏会少算一整段。
   */
  price: number;
  /** 第一段成交的数量。 */
  qty: number;
}

/** 一个标的的补挂计划。 */
export interface ReattachPlan {
  symbol: string;
  /** 要补挂的。**一个标的最多一条**——条件单保护的是整个净仓位，叠两套会互相触发。 */
  target: ReattachTarget | null;
  /** 不补挂但要让人知道的。 */
  skips: ReattachSkip[];
  /** 拒绝补挂的原因（人可读）。`null` = 没有拒绝。 */
  refusal: string | null;
  /**
   * 「第一段止盈已成交」这个**要补记进库**的事实。
   *
   * 非 `null` = 第一段确实成交了、而**库里没记**（`tp1_filled_at` 是空的）。
   */
  tp1Fill: Tp1FillFact | null;
}

export interface ReattachInput {
  symbol: string;
  /** 本地未终结记录（该标的）。 */
  records: readonly ReattachRecord[];
  /** 交易所持仓（该标的）。没有仓位时传 `null`。 */
  position: ExchangePosition | null;
  /** 交易所挂着的条件单（该标的，全量——含**不是我方**的单）。 */
  algoOrders: readonly ExchangeAlgoOrder[];
}

/**
 * 「这条记录当初**没算出档位**」的判据。
 *
 * 占坑失败时（策略解析失败 / ATR 不可用 / 名义金额超上限）落的是一条**占位记录**：
 * ATR 写的是 `Number.MIN_VALUE`，止损价与止盈价都等于入场价（表上的
 * `atr > 0` 与 `stop_price > 0` 两道闸必须过得去，见 `sql/006`）。
 *
 * 这样的记录**没有可复现的计划**：止损价恰好等于入场价，挂上去就是当场平仓。
 * 因此补挂必须**现算**一份，而不是把那两个占位价照抄上去。
 */
const MIN_REAL_ATR = 1e-12;

function isPlaceholderPlan(record: ReattachRecord): boolean {
  return record.atr <= MIN_REAL_ATR || record.stopPrice === record.entryPrice;
}

/**
 * 交易所上我方挂着的单：按「入场单号 → 标签集合」索引。
 *
 * 只有 `rsk-` 前缀的单算我方的；别人（用户自己在交易所上挂的）不算——
 * 把它们算进来会让「我方缺单」这个结论被一张无关的单掩盖。
 *
 * ⚠️ **入场单号可能被截断**：`bracketClientOrderId` 把整串截到 36 字符，
 * 于是交易所回传的 `clientAlgoId` 里，入场单号可能只剩**前缀**。
 * 因此匹配时除了「完全相等」，还要认「**记录的单号以它开头**」——
 * 否则一张明明在交易所上的止损单会被判成「不见了」，补挂就会挂出第二张。
 */
function indexOurOrders(orders: readonly ExchangeAlgoOrder[]): Map<string, Set<BracketTag>> {
  const index = new Map<string, Set<BracketTag>>();
  for (const order of orders) {
    const parsed = parseBracketClientOrderId(order.clientAlgoId);
    if (parsed === null) continue;
    // 认不出的类型**抛错**而不是跳过：前缀是我方的、类型却没见过，
    // 意味着交易所改了命名口径，静默跳过会让「止损单不见了」被误判成「查不到而已」。
    algoOrderTag(order.orderType);
    const bucket = index.get(parsed.entryOrderId) ?? new Set<BracketTag>();
    bucket.add(parsed.tag);
    index.set(parsed.entryOrderId, bucket);
  }
  return index;
}

/** 交易所上这张单是不是**这条记录**的（容忍截断）。 */
function hasOurOrder(
  record: ReattachRecord,
  tag: BracketTag,
  index: Map<string, Set<BracketTag>>,
): boolean {
  for (const [entryOrderId, tags] of index) {
    if (!tags.has(tag)) continue;
    if (entryOrderId === record.entryOrderId) return true;
    // 截断：交易所回传的是入场单号的前缀。
    if (record.entryOrderId.startsWith(entryOrderId)) return true;
  }
  return false;
}

/**
 * 这一态在交易所上该有哪些单。
 *
 * 与 {@link expectedBracketOrders} 同源，只多两件事：
 *
 * 1. 本地记的是「第一段止盈」，交易所上认成的是「止盈」——因此这里做一次映射，
 *    **不重写判据**；
 * 2. `tp1Filled` 是「第一段止盈已成交」的**事实覆盖**——库里那列可能是空的
 *    （见 {@link detectTp1Fill}），而第一段成交后交易所上**本来就不该**有那张单。
 */
function expectedTags(record: ReattachRecord, tp1Filled: boolean): ReattachOrderTag[] {
  const tags = expectedBracketOrders(record, { tp1Filled });
  return tags.map((tag) => (tag === 'tp' && record.state === 'partial_armed' ? 'tp1' : tag));
}

/**
 * 复现原计划时要用的价与形态。
 *
 * `null` = 这条记录是占位记录（当初没算出档位），必须现算。
 */
function pricesOf(record: ReattachRecord): ReattachPrices | null {
  if (isPlaceholderPlan(record)) return null;
  if (record.state === 'partial_armed') {
    // 分批形态：第一段的价与量都在记录里。缺了就**不给价**——
    // 拿 `take_profit` 顶替会让「第一段」变成「整段」，量对不上。
    if (record.tp1Price === null || record.tp1Qty === null) return null;
    return { stopPrice: record.stopPrice, takeProfitPrice: record.tp1Price, tp1Qty: record.tp1Qty };
  }
  if (record.state === 'trailing') {
    // 移动止损阶段：第一段已成交，交易所上**不该**再有止盈单，只剩止损。
    const stop = record.trailStopPrice ?? record.stopPrice;
    return { stopPrice: stop, takeProfitPrice: null, tp1Qty: null };
  }
  return { stopPrice: record.stopPrice, takeProfitPrice: record.takeProfit, tp1Qty: null };
}

/**
 * 判一判：这个标的现在该补什么。
 *
 * **纯函数**：同样的输入必须永远给出同样的输出。
 */
export function planReattach(input: ReattachInput): ReattachPlan {
  const { symbol, records, position, algoOrders } = input;
  const skips: ReattachSkip[] = [];

  // 交易所上没有仓位 → 没有可保护的东西。补挂只会留下一张没人认领的单。
  if (position === null || position.positionAmt === 0) {
    for (const record of records) {
      skips.push({
        symbol,
        entryOrderId: record.entryOrderId,
        reason: '交易所已无该标的仓位，补挂会留下一张没人认领的单',
      });
    }
    return { symbol, target: null, skips, refusal: null, tp1Fill: null };
  }

  const side: 'LONG' | 'SHORT' = position.positionAmt > 0 ? 'LONG' : 'SHORT';
  const positionQty = Math.abs(position.positionAmt);

  /**
   * 方向对不上的记录不参与。
   *
   * ⚠️ **必须按仓位的符号判方向**，不能按交易所回的 `positionSide`：
   * 单向持仓模式下那一列恒为 `BOTH`，拿它匹配等于「什么方向都算对上」——
   * 于是给一个多头仓位补挂时，会把那条空头记录也当成「覆盖它的记录」，
   * 拿它的止损价去挂。方向认反的止损单是**最贵的一种错**。
   *
   * 双向持仓模式本服务直接拒绝（§6.3 第 7 条），因此符号就是唯一的方向事实。
   */
  const covering = records.filter((record) => record.positionSide === side);
  for (const record of records) {
    if (covering.includes(record)) continue;
    skips.push({
      symbol,
      entryOrderId: record.entryOrderId,
      reason: `记录的方向是 ${record.positionSide}，当前仓位方向是 ${side}，两者对不上，不补挂`,
    });
  }

  const index = indexOurOrders(algoOrders);

  /**
   * 这一条记录的「第一段止盈**是不是已经成交**了」。
   *
   * 库里的 `tp1_filled_at` 是权威事实；它为空时**拿交易所的实际仓位核对一次**
   * （见 {@link detectTp1Fill}）——第一段可能在 executor 不在的时候成交了，
   * 而那时没人记（§6.8.3）。
   */
  function tp1FilledOf(record: ReattachRecord): boolean {
    if (record.tp1FilledAt !== null) return true;
    return (
      detectTp1Fill({
        filledQty: record.filledQty,
        tp1Qty: record.tp1Qty,
        positionQty,
      }) === 'tp1-filled'
    );
  }

  // 没有一条记录覆盖这个仓位 → 裸仓。这笔仓位从没被保护过。
  if (covering.length === 0) {
    return {
      symbol,
      target: {
        kind: 'naked-position',
        symbol,
        entryOrderId: null,
        positionSide: side,
        need: ['tp', 'sl'],
        reason:
          `交易所有仓位（${position.positionAmt}），本地没有任何未终结的止盈止损记录` +
          '——这笔仓位没有被这套工具保护过',
        entryPrice: position.entryPrice,
        quantity: Math.abs(position.positionAmt),
        prices: null,
        atr: null,
        currentPrice: position.markPrice,
      },
      skips,
      refusal: null,
      tp1Fill: null,
    };
  }

  /**
   * 挑出**真正在保护这个仓位**的那条记录。
   *
   * 正常情况下同一标的只有一条未终结记录（开仓时会跳过已有保护的标的，
   * §6.3 第 9 条）。出现多条属于异常，因此这里**不猜**：
   *   * 只有一条挂着单 → 就是它；
   *   * 一条都没挂（都是 `failed`） → 取最近更新的一条；
   *   * **多条都挂着单** → 无法判断哪一条对应当前仓位，**拒绝补挂**。
   */
  const withOrders = covering.filter((record) =>
    expectedTags(record, tp1FilledOf(record)).some((tag) =>
      hasOurOrder(record, tagOnExchange(tag), index),
    ),
  );
  let primary: ReattachRecord;
  if (withOrders.length === 1) {
    primary = withOrders[0] as ReattachRecord;
  } else if (withOrders.length === 0) {
    primary = covering[0] as ReattachRecord;
  } else {
    for (const record of covering) {
      skips.push({
        symbol,
        entryOrderId: record.entryOrderId,
        reason: '同一标的有多条未终结记录，且它们各自都挂着单，无法判断哪一条对应当前仓位，不补挂',
      });
    }
    return { symbol, target: null, skips, refusal: null, tp1Fill: null };
  }
  for (const record of covering) {
    if (record === primary) continue;
    skips.push({
      symbol,
      entryOrderId: record.entryOrderId,
      reason: '同一标的有多条未终结记录，只补最要紧的那一条（条件单保护的是整个净仓位）',
    });
  }

  /**
   * 「第一段止盈是不是已经成交了」。
   *
   * 库里的 `tp1_filled_at` 是权威；它为空时用交易所的**实际仓位**核对一次。
   */
  const tp1FillState = detectTp1Fill({
    filledQty: primary.filledQty,
    tp1Qty: primary.tp1Qty,
    positionQty,
  });

  /**
   * 库里没记、而仓位又**对不上** → 说不清 → **拒绝补挂**。
   *
   * 说不清的三种可能：仓位被手工动过、第一段只成交了一部分、用户又加了仓。
   * 这三种照着记录补都可能挂错数量或**重复减仓**——宁可让人看见「补不上」。
   *
   * ⚠️ 库里**已经记了**（`tp1_filled_at` 非空）时不拦：那时事实是权威的，
   * 而仓位对不上只说明之后又被人动过——止损是 `closePosition`，
   * 它保护的是「当时剩余的全部仓位」，补挂它仍然是对的。
   */
  if (primary.tp1FilledAt === null && tp1FillState === 'unknown') {
    const refusal =
      `${symbol} 的仓位数量（${positionQty}）与本地记录对不上：` +
      `记录里这一笔开了 ${primary.filledQty}，第一段止盈 ${String(primary.tp1Qty ?? '—')}` +
      '——要么仓位被手工动过，要么第一段只成交了一部分。' +
      '不敢补挂：照记录补可能重复减仓或挂错数量。请人工确认后处理。';
    return { symbol, target: null, skips, refusal, tp1Fill: null };
  }

  /**
   * 记录说「一张都没挂上」，而仓位少了第一段那么多 → **两者矛盾**，说不清。
   *
   * 这一串要全发生才会走到：「挂了第一段止盈、挂止损失败、回滚撤单也失败、
   * 那张止盈后来又成交了」。罕见，但它一旦发生，照记录补就会**重复减仓**——
   * 所以拒绝，让人去看，而不是替人猜。
   *
   * ⚠️ 库里**已经记了**「第一段已成交」时不拦：那时不是矛盾，只是这行
   * 在失败之后又被人动过。
   */
  if (primary.tp1FilledAt === null && primary.state === 'failed' && tp1FillState === 'tp1-filled') {
    const refusal =
      `${symbol} 的记录说「一张保护单都没挂上」，可交易所的仓位（${positionQty}）` +
      `比记录的入场数量（${primary.filledQty}）少了第一段那么多` +
      `（第一段 ${String(primary.tp1Qty ?? '—')}）——两者矛盾，不敢补挂：` +
      '照记录补可能重复减仓。请人工确认后处理。';
    return { symbol, target: null, skips, refusal, tp1Fill: null };
  }

  const tp1Filled = primary.tp1FilledAt !== null || tp1FillState === 'tp1-filled';

  /**
   * 「第一段成交了、而库里没记」这个**要补记进库**的事实。
   *
   * 不补记的后果：对账每轮报一条「止盈单不见了」的假警报，
   * 而移动止损定时器也不会认领这一笔（它只认 `tp1_filled_at` 非空的行）。
   */
  const tp1Fill: Tp1FillFact | null =
    primary.tp1FilledAt === null &&
    tp1FillState === 'tp1-filled' &&
    primary.tp1Price !== null &&
    primary.tp1Qty !== null
      ? { entryOrderId: primary.entryOrderId, price: primary.tp1Price, qty: primary.tp1Qty }
      : null;

  // 该有的单里，交易所上缺哪几张。
  const missing = expectedTags(primary, tp1Filled).filter(
    (tag) => !hasOurOrder(primary, tagOnExchange(tag), index),
  );
  if (missing.length === 0) {
    skips.push({
      symbol,
      entryOrderId: primary.entryOrderId,
      reason: '本地记录与交易所上的单一致，仓位有保护，不需要补挂',
    });
    return { symbol, target: null, skips, refusal: null, tp1Fill };
  }

  const kind: ReattachKind =
    primary.state === 'failed'
      ? 'unprotected-position'
      : missing.includes('sl')
        ? 'missing-stop-order'
        : 'missing-take-profit-order';

  const prices = pricesOf(primary);
  const reason =
    primary.state === 'failed'
      ? `${symbol} 的入场记录下单失败，一张保护单都没挂上（记录原因：${primary.lastError ?? '未记录'}）`
      : missing.includes('sl')
        ? tp1Filled
          ? `${symbol} 的第一段止盈已经成交，剩余仓位本该由移动止损管着，` +
            '但交易所上没有止损单——剩下的仓位完全没有保护'
          : `${symbol} 本地记为已挂上，但交易所上没有止损单——仓位当前没有止损保护`
        : `${symbol} 止损单还在交易所，但止盈单不见了`;

  return {
    symbol,
    target: {
      kind,
      symbol,
      entryOrderId: primary.entryOrderId,
      positionSide: side,
      need: missing,
      reason,
      entryPrice: primary.entryPrice,
      quantity: primary.filledQty,
      prices,
      atr:
        prices === null
          ? null
          : {
              atr: primary.atr,
              atrPeriod: primary.atrPeriod,
              atrInterval: primary.atrInterval,
              atrWindowFrom: primary.atrWindowFrom,
              atrWindowTo: primary.atrWindowTo,
            },
      currentPrice: position.markPrice,
    },
    skips,
    refusal: null,
    tp1Fill,
  };
}

/**
 * 「挂上去会不会**立刻触发**」的检查。
 *
 * 条件单是**市价**平仓单：触发价一旦被穿过，交易所立刻用市价把仓位平掉。
 * 因此挂之前必须确认触发价在现价的**正确一侧**：
 *
 * - 多头：止损在现价**下方**、止盈在现价**上方**；
 * - 空头：反过来。
 *
 * 取不到现价时**拒绝补挂**（返回一条理由）：那正是「猜一个方向」最容易出事的
 * 时候，而猜错的后果是仓位被市价平掉（§5 第 9 条：不静默兜底）。
 *
 * @param orders 只放**真正要挂的那几张**。已经成交掉的第一段止盈不在其中——
 *   拿它来比现价，会得出「止盈价已经越过现价」这种假拒绝。
 */
export function checkReattachTriggers(input: {
  positionSide: 'LONG' | 'SHORT';
  currentPrice: number | null;
  orders: readonly { tag: ReattachOrderTag; price: number }[];
}): string | null {
  const { positionSide, currentPrice, orders } = input;
  if (currentPrice === null || !Number.isFinite(currentPrice)) {
    return '取不到现价，无法确认挂上去不会立刻以市价平仓——不补挂';
  }
  for (const order of orders) {
    const isStop = order.tag === 'sl';
    // 多头：止损要低于现价、止盈要高于现价；空头反过来。
    const ok = isStop
      ? positionSide === 'LONG'
        ? order.price < currentPrice
        : order.price > currentPrice
      : positionSide === 'LONG'
        ? order.price > currentPrice
        : order.price < currentPrice;
    if (ok) continue;
    const what = isStop ? '止损' : '止盈';
    const side = positionSide === 'LONG' ? '多头' : '空头';
    return (
      `${what}价 ${order.price} 在${side}仓位的错误一侧（现价 ${currentPrice}）：` +
      '挂上去会立刻以市价平仓，不补挂'
    );
  }
  return null;
}
