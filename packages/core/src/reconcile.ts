/**
 * 交易对账的**判据**（v0.6.0）。
 *
 * 回答一个问题：**交易所现在真实的仓位与挂单，同本地 `risk_bracket` 记的对不对得上？**
 *
 * 为什么要做：`risk_bracket` 是止盈止损唯一的账本，而它只有写入侧
 * （占坑 → 下单 → 回填单号）。占坑与下单分别在 PG 与交易所，无法原子提交，于是进程
 * 死在中间是必然的——单挂上了、单号没回填，或本地记着 `armed` 而单早已被撤。这类漂移
 * **没有任何日志会告诉你**：用户数据流不重放历史，而页面只读本地表，于是一切看上去正常。
 *
 * 三条口径，不可协商：
 *
 * 1. **只报告，绝不动手。** 本文件是纯函数，不读时钟、不做 IO。它不写库、不下单、
 *    不撤单。补挂一张止损会平掉真实仓位，且不可逆——「自动修复」的风险与「报告」的
 *    风险完全不对称，因此修复永远是人工决定。
 * 2. **判据只有这一份实现。** CLI 与控制面共用它，否则两个出口对同一件事给出不同结论。
 * 3. **差异按「仓位是否有保护」排序。** 只有止损、没有止盈是 `warning`；本地认为已挂上
 *    而交易所没有止损单是 `critical`。把两者都叫「异常」会让最要紧的那种被淹掉。
 *
 * 「交易所持仓」与「交易所条件单」两个形状定义在这里（而不是接缝那一层）：它们是对账
 * 的输入契约，`packages/data` 的 REST 解析只负责把 payload 变成这里的形状。
 */

import { SyncError } from './market-sync.js';
import { algoOrderTag, parseBracketClientOrderId, type BracketTag } from './risk-ids.js';
import type { PositionSide } from './types.js';

/**
 * 本地只关心**未终结**的记录。
 *
 * 四态的**交易所形态各不相同**，判据必须分开处理（v0.7.0 R-10）：
 *
 * | state            | 交易所上应有的单                     |
 * | ---------------- | ------------------------------------ |
 * | `armed`          | 止盈（全平）+ 止损（全平）两张       |
 * | `partial_armed`  | 第一段止盈（带数量）+ 止损两张        |
 * | `trailing`       | **只有止损一张**                    |
 * | `failed`         | 一张都没有                           |
 *
 * 把 `trailing` 当成 `armed` 处理，会每轮报一条「止盈单不见了」的假警报；
 * 而假警报是让整份报告失去可信度的最快方式（§6.5 第 2 条）。
 */
export type UnsettledBracketState = 'armed' | 'partial_armed' | 'trailing' | 'failed';

/**
 * 对账用到的本地记录。刻意只声明判据要用的字段：
 * 整份 `risk_bracket` 行（含 ATR 窗口等）对账并不关心，把它整个拉进来只会让「这个判据
 * 需要什么」变得不清楚。
 */
export interface LocalBracket {
  symbol: string;
  entryOrderId: string;
  positionSide: 'LONG' | 'SHORT';
  /** 入场价与成交量：报「裸仓」时得让人知道裸的是多大一笔。 */
  entryPrice: number;
  filledQty: number;
  stopPrice: number;
  takeProfit: number;
  tpAlgoId: number | null;
  slAlgoId: number | null;
  /** 第一段止盈的单号与价（`partial_armed` / `trailing` 行有值）。 */
  tp1AlgoId: number | null;
  tp1Price: number | null;
  /** 当前生效的那一档止损价。`trailing` 行必��用它比价，而不是 `stopPrice`。 */
  trailStopPrice: number | null;
  state: UnsettledBracketState;
  lastError: string | null;
  updatedAt: number;
}

/**
 * 该行当前生效的止损价：`trailing` 用移动中的那一档，其余用入场时那一档。
 *
 * 只有这一处决定「拿哪个价去比」：若改成在调用处现选，移动止损每调一档
 * 就会报一条价格不符——而那正是「判据被抄成第二份」的典型症状。
 */
/** 人话阶段名，进告警文案。四个阶段的形态不同，说清楚才用得上。 */
function describeState(state: UnsettledBracketState): string {
  switch (state) {
    case 'armed':
      return '已挂上止盈止损';
    case 'partial_armed':
      return '已挂上第一段止盈与止损';
    case 'trailing':
      return '已进入移动止损（第一段应已成交）';
    case 'failed':
      return '下单失败';
  }
}

/**
 * `partial_armed` 的第一段价。表上的 `risk_bracket_staged_check` 保证它非空，
 * 因此这里拿到 null 说明约束被绕过或查询被改坏了——**抛错**，而不是退回
 * `takeProfit` 继续比。后者会让一条坏数据看起来「只是价对不上」，
 * 而真实情况是这笔记录压根不该存在（AGENTS.md 约定 9）。
 */
function requireTp1Price(record: LocalBracket): number {
  if (record.tp1Price === null) {
    throw new SyncError(
      'CONFIG_INVALID',
      `${record.symbol} 的记录是 partial_armed，却没有第一段止盈价（tp1Price 为空）`,
      { entryOrderId: record.entryOrderId, state: record.state },
    );
  }
  return record.tp1Price;
}

export function effectiveStopPrice(record: LocalBracket): number {
  return record.state === 'trailing' && record.trailStopPrice !== null
    ? record.trailStopPrice
    : record.stopPrice;
}

/**
 * 交易所持仓的一行（`GET /fapi/v3/positionRisk`）。
 *
 * `positionAmt` 的**符号**代表方向（正多负空），`positionSide` 在双向持仓模式下才是
 * LONG/SHORT。两者都留着：单向模式下 `positionSide` 恒为 `BOTH`，只按它判方向会把多空
 * 认反。
 */
export interface ExchangePosition {
  symbol: string;
  positionSide: PositionSide;
  positionAmt: number;
  entryPrice: number;
  markPrice: number | null;
  updateTime: number | null;
}

/**
 * 交易所挂着的一张条件单（`GET /fapi/v1/openAlgoOrders`）。
 *
 * `orderType` 的取值与下单时**不一样**（查询回 `TAKE_PROFIT` / `STOP`，下单发
 * `TAKE_PROFIT_MARKET` / `STOP_MARKET`），认类型一律过 `algoOrderTag()`。
 * 核对日期 2026-10-11。
 */
export interface ExchangeAlgoOrder {
  algoId: number;
  clientAlgoId: string;
  algoType: string;
  orderType: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: PositionSide;
  /** `NEW` / `WORKING` 等。只认「还在挂着」的那些，取数接口本身就是挂单列表。 */
  algoStatus: string;
  triggerPrice: number;
  closePosition: boolean;
  /**
   * 带数量的条件单才有（v0.7.0 的第一段止盈）。`closePosition` 单恒为 `null`。
   *
   * 之前这个字段被整个丢掉了，于是「交易所上那张带数量的单，量是多少」**本地无从得知**——
   * 分批止盈挂错数量时没有任何一处能发现它（v0.7.0 G-5）。
   */
  quantity: number | null;
  createTime: number;
  updateTime: number;
}

/** 差异的严重度。`critical` = 仓位当前没有任何止损保护。 */
export type ReconcileSeverity = 'critical' | 'warning';

export type ReconcileKind =
  /** 本地 `armed`，交易所没有对应的止损单。仓位当前是裸的。 */
  | 'missing-stop-order'
  /** 本地 `failed`（占坑成功但下单失败），而仓位还在。 */
  | 'unprotected-position'
  /** 交易所有仓位，本地没有任何未终结的记录——这笔仓位从来没被这套工具保护过。 */
  | 'position-without-record'
  /** 本地 `armed` / `partial_armed`，但交易所只剩一张（缺止盈）。 */
  | 'missing-take-profit-order'
  /**
   * 本地已进入 `trailing`（第一段已成交，剩余仓位只剩止损），
   * 而交易所却还挂着一张止盈单。
   *
   * 它多半是「成交事件没被本地收到」，于是那笔仓位的账已经错了；
   * 也可能是「工具外平仓后本地撤单失败」。两种都要人看一眼，因此是 warning
   * （仓位此刻仍受止损保护，不是裸的）。
   */
  | 'unexpected-take-profit-order'
  /** 单还在，但触发价与本地记录的止损/止盈价对不上。 */
  | 'price-mismatch'
  /** 本地 `armed`，交易所已无该标的仓位——多半是平仓事件没收到。 */
  | 'record-without-position'
  /** 交易所挂着我方条件单，但没有任何未终结的本地记录引用它的 algoId。 */
  | 'orphan-algo-order';

export interface ReconcileDifference {
  kind: ReconcileKind;
  severity: ReconcileSeverity;
  symbol: string;
  /** 能归属到某笔入场成交就有值；交易所有仓位而本地无记录时为 null。 */
  entryOrderId: string | null;
  /** 一句人话，直接显示。判据不只给代码，还要能让人据此处置。 */
  message: string;
  /** 判据用到的原始量，便于人工核对（本地价、交易所价、单号…）。 */
  evidence: Record<string, string | number | boolean | null>;
}

export interface ReconcileReport {
  exchange: string;
  /** `null` = 全账户对账（不带 symbol 查交易所）。 */
  symbol: string | null;
  checkedAt: number;
  /** 一致 = 没有 critical 也没有 warning。 */
  healthy: boolean;
  counts: Record<ReconcileSeverity, number> & { total: number };
  differences: ReconcileDifference[];
  /** 三侧的规模，便于判断「对账其实什么都没查」。 */
  scope: {
    localUnsettled: number;
    exchangePositions: number;
    exchangeAlgoOrders: number;
  };
}

export interface ReconcileInput {
  exchange: string;
  symbol: string | null;
  /** 判据不读时钟，由调用方注入。 */
  checkedAt: number;
  local: LocalBracket[];
  positions: ExchangePosition[];
  algoOrders: ExchangeAlgoOrder[];
}

/**
 * 价格比对的容差。
 *
 * 价格是按 tick 对齐过的 `double precision`，用 `===` 比会因二进制浮点把「同一个价」
 * 判成不一致——那种假警报会让人开始忽略整份报告，那比不报更糟。取相对容差 1e-9。
 */
function samePrice(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-9);
}

/** 单向持仓模式下 `positionSide` 恒为 BOTH，此时按记录自身的方向匹配。 */
function sideMatches(position: PositionSide, record: 'LONG' | 'SHORT'): boolean {
  return position === 'BOTH' || position === record;
}

function inSymbolScope(symbol: string, scope: string | null): boolean {
  return scope === null || symbol === scope;
}

/** 一张条件单认回本地记录后的样子。 */
interface LinkedOrder {
  tag: BracketTag;
  entryOrderId: string;
  algoId: number;
  triggerPrice: number;
  orderType: string;
  status: string;
}

/**
 * 对账本体。**纯函数**：同样的输入必须永远给出同样的输出。
 *
 * 判据按「仓位 → 记录 → 挂单」三层走，每一层只报它能独立确定的事，避免同一次漂移
 * 被重复报三遍（同一笔裸仓既是「没有止损单」又是「有仓位没记录」，报两条只会让人以为
 * 是两个问题）。
 */
export function reconcileBrackets(input: ReconcileInput): ReconcileReport {
  const { exchange, symbol: scope, checkedAt, local, positions, algoOrders } = input;
  const differences: ReconcileDifference[] = [];

  const localScope = local.filter((r) => inSymbolScope(r.symbol, scope));
  const positionScope = positions.filter((p) => inSymbolScope(p.symbol, scope));
  const algoScope = algoOrders.filter((o) => inSymbolScope(o.symbol, scope));

  // 我方条件单按 clientOrderId 认回入场成交。认不出的（非 rsk- 前缀）直接不参与——
  // 用户自己在网页上下的单不是漂移。
  const linked = new Map<string, Partial<Record<BracketTag, LinkedOrder>>>();
  for (const order of algoScope) {
    const parsed = parseBracketClientOrderId(order.clientAlgoId);
    if (parsed === null) continue;
    // 客户端号与订单类型必须指向同一张单。`algoOrderTag` 对认不出的类型**抛错**而不是
    // 跳过：我方前缀的单出现了没见过的 orderType，意味着交易所改了命名口径，
    // 静默跳过就会让「止损单不在了」被误判成「查不到而已」。
    algoOrderTag(order.orderType);
    const bucket = linked.get(parsed.entryOrderId) ?? {};
    bucket[parsed.tag] = {
      tag: parsed.tag,
      entryOrderId: parsed.entryOrderId,
      algoId: order.algoId,
      triggerPrice: order.triggerPrice,
      orderType: order.orderType,
      status: order.algoStatus,
    };
    linked.set(parsed.entryOrderId, bucket);
  }

  const referencedAlgoIds = new Set<number>();
  for (const record of localScope) {
    if (record.tpAlgoId !== null) referencedAlgoIds.add(record.tpAlgoId);
    if (record.slAlgoId !== null) referencedAlgoIds.add(record.slAlgoId);
    // 第一段的单号必须也算进去：漏了它，第三层会把 TP1 当成「没人引用的我方单」
    // 报一条 orphan，而那条告警会让人以为回填丢了——实际只是判据没跟上 v0.7.0。
    if (record.tp1AlgoId !== null) referencedAlgoIds.add(record.tp1AlgoId);
  }

  // 第一层：本地记录。
  for (const record of localScope) {
    const orders = linked.get(record.entryOrderId);
    const sl = orders?.sl;
    const tp = orders?.tp;

    if (record.state === 'failed') {
      // failed 的含义就是「没挂上任何单」。仓位还在就是裸的，与失败原因无关——
      // 这是最该被看见的一种，因此是 critical，而不是把 last_error 原样复述一遍。
      differences.push({
        kind: 'unprotected-position',
        severity: 'critical',
        symbol: record.symbol,
        entryOrderId: record.entryOrderId,
        message: `${record.symbol} 有一笔入场成交没挂上任何保护单，而仓位可能仍在（记录原因：${
          record.lastError ?? '未记录'
        }）。`,
        evidence: {
          localState: record.state,
          lastError: record.lastError,
          entryPrice: record.entryPrice,
          filledQty: record.filledQty,
        },
      });
      continue;
    }

    // 止损：三态都该有一张（`trailing` 只有这一张）。缺它就是裸仓，critical。
    // 比价用 `effectiveStopPrice`：移动止损每次调档都会改 `trail_stop_price`，
    // 拿入场那一档去比，每次都会报一条假的价格不符。
    const stopPrice = effectiveStopPrice(record);
    if (sl === undefined) {
      differences.push({
        kind: 'missing-stop-order',
        severity: 'critical',
        symbol: record.symbol,
        entryOrderId: record.entryOrderId,
        message: `${record.symbol} 本地记为${describeState(record.state)}，但交易所没有对应的止损单——仓位当前没有止损保护。`,
        evidence: {
          localState: record.state,
          localSlAlgoId: record.slAlgoId,
          localStopPrice: stopPrice,
          entryPrice: record.entryPrice,
        },
      });
    } else if (!samePrice(sl.triggerPrice, stopPrice)) {
      differences.push({
        kind: 'price-mismatch',
        severity: 'warning',
        symbol: record.symbol,
        entryOrderId: record.entryOrderId,
        message: `${record.symbol} 止损单还在交易所，但触发价与本地记录不一致。`,
        evidence: {
          exchangeAlgoId: sl.algoId,
          exchangeTriggerPrice: sl.triggerPrice,
          localStopPrice: stopPrice,
        },
      });
    }

    // 止盈：**按阶段判断「该有什么」，不是「有没有」**。
    //   * `trailing`  —— 第一段已成交，此刻交易所**不该**再有止盈单。
    //     仍有就是 `unexpected-take-profit-order`；反过来按旧判据去报
    //     「止盈单不见了」，会每轮一条假警报。
    //   * 其余两态  —— 该有一张，没有才是 `missing-take-profit-order`。
    if (record.state === 'trailing') {
      if (tp !== undefined) {
        differences.push({
          kind: 'unexpected-take-profit-order',
          severity: 'warning',
          symbol: record.symbol,
          entryOrderId: record.entryOrderId,
          message: `${record.symbol} 本地已进入移动止损阶段（第一段应已成交），交易所却还挂着一张止盈单（${tp.triggerPrice}）——多半是成交事件没被收到，或工具外平仓后撤单失败。`,
          evidence: {
            localState: record.state,
            exchangeAlgoId: tp.algoId,
            exchangeTriggerPrice: tp.triggerPrice,
            localTrailStopPrice: stopPrice,
          },
        });
      }
      continue;
    }

    const takeProfit =
      record.state === 'partial_armed' ? requireTp1Price(record) : record.takeProfit;
    if (tp === undefined) {
      differences.push({
        kind: 'missing-take-profit-order',
        severity: 'warning',
        symbol: record.symbol,
        entryOrderId: record.entryOrderId,
        message: `${record.symbol} 止损单还在，但止盈单已不在交易所（另一张多半是被成交后由交易所自动撤销的，需要确认本地状态是否漏记）。`,
        evidence: {
          localState: record.state,
          localTpAlgoId: record.state === 'partial_armed' ? record.tp1AlgoId : record.tpAlgoId,
          localTakeProfit: takeProfit,
        },
      });
    } else if (!samePrice(tp.triggerPrice, takeProfit)) {
      differences.push({
        kind: 'price-mismatch',
        severity: 'warning',
        symbol: record.symbol,
        entryOrderId: record.entryOrderId,
        message: `${record.symbol} 止盈单还在交易所，但触发价与本地记录不一致。`,
        evidence: {
          exchangeAlgoId: tp.algoId,
          exchangeTriggerPrice: tp.triggerPrice,
          localTakeProfit: takeProfit,
        },
      });
    }
  }

  // 第二层：交易所持仓。只报「本地完全没有未终结记录」的仓位——本地有记录但没止损单
  // 的那种已经在第一层报过了，重复报会让一个裸仓看起来像两个问题。
  for (const position of positionScope) {
    if (position.positionAmt === 0) continue;
    const covered = localScope.some(
      (record) =>
        record.symbol === position.symbol &&
        sideMatches(position.positionSide, record.positionSide),
    );
    if (covered) continue;
    differences.push({
      kind: 'position-without-record',
      severity: 'critical',
      symbol: position.symbol,
      entryOrderId: null,
      message: `${position.symbol} 交易所有仓位（${position.positionAmt}），但本地没有任何未终结的止盈止损记录——这笔仓位没有被这套工具保护过。`,
      evidence: {
        positionSide: position.positionSide,
        positionAmt: position.positionAmt,
        entryPrice: position.entryPrice,
        markPrice: position.markPrice,
      },
    });
  }

  // 第三层：我方条件单是否都被本地引用。没被引用的那张，就是回填丢失或记录已被结清。
  for (const order of algoScope) {
    const parsed = parseBracketClientOrderId(order.clientAlgoId);
    if (parsed === null) continue;
    if (referencedAlgoIds.has(order.algoId)) continue;
    differences.push({
      kind: 'orphan-algo-order',
      severity: 'warning',
      symbol: order.symbol,
      entryOrderId: parsed.entryOrderId,
      message: `${order.symbol} 交易所挂着一张我方${parsed.tag === 'tp' ? '止盈' : '止损'}单，但本地没有任何未终结记录引用它（本地可能已结清，或回填单号时进程被杀）。`,
      evidence: {
        algoId: order.algoId,
        clientAlgoId: order.clientAlgoId,
        orderType: order.orderType,
        algoStatus: order.algoStatus,
        triggerPrice: order.triggerPrice,
      },
    });
  }

  // 「本地记着 armed、交易所已无仓位」：反过来由仓位侧查不出来（positionAmt=0 的行
  // 不构成一条 position 记录），因此必须在这里按标的补一次。
  for (const record of localScope) {
    // `failed` 不参与：它的含义是「什么都没挂上」，由第一层的
    // `unprotected-position` 报（critical）。这里再报一条 record-without-position
    // 会把一个裸仓显示成两个问题。
    if (record.state !== 'armed' && record.state !== 'partial_armed' && record.state !== 'trailing')
      continue;
    const stillOpen = positionScope.some(
      (position) =>
        position.symbol === record.symbol &&
        position.positionAmt !== 0 &&
        sideMatches(position.positionSide, record.positionSide),
    );
    if (stillOpen) continue;
    differences.push({
      kind: 'record-without-position',
      severity: 'warning',
      symbol: record.symbol,
      entryOrderId: record.entryOrderId,
      message: `${record.symbol} 本地记为已挂上止盈止损，但交易所已无该标的仓位——多半是平仓事件没被本地收到。`,
      evidence: {
        localState: record.state,
        localTpAlgoId: record.tpAlgoId,
        localSlAlgoId: record.slAlgoId,
      },
    });
  }

  differences.sort((a, b) => {
    // 严重度优先；同类按标的 + 入场单号排，保证同一份输入的输出顺序稳定（纯函数要求）。
    if (a.severity !== b.severity) return a.severity === 'critical' ? -1 : 1;
    if (a.symbol !== b.symbol) return a.symbol < b.symbol ? -1 : 1;
    return (a.entryOrderId ?? '') < (b.entryOrderId ?? '') ? -1 : 1;
  });

  const counts = {
    critical: differences.filter((d) => d.severity === 'critical').length,
    warning: differences.filter((d) => d.severity === 'warning').length,
    total: differences.length,
  };

  return {
    exchange,
    symbol: scope,
    checkedAt,
    healthy: counts.total === 0,
    counts,
    differences,
    scope: {
      localUnsettled: localScope.length,
      exchangePositions: positionScope.filter((p) => p.positionAmt !== 0).length,
      exchangeAlgoOrders: algoScope.length,
    },
  };
}
