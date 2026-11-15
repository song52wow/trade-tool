/**
 * **手动补挂**止盈止损（v1.3.0）。
 *
 * 回答一个问题：**仓位现在没有保护，人动手补挂，怎么做才不出错？**
 *
 * ## 为什么要有它
 *
 * 止盈止损是**成交驱动**的：用户数据流送来一笔成交，才算 ATR、才挂单。于是有几类
 * 故障会让仓位**裸奔**，而它们**都不会**被自动修好：
 *
 * | 故障                                  | 症状                                              |
 * | ------------------------------------- | ------------------------------------------------- |
 * | 用户数据流断了                        | 断线期间开的仓永远不会被处理（流不重放）           |
 * | 私有接口被拒 / 本机时钟偏了            | 一单都挂不上，而日志照样有内容                     |
 * | 挂在「占坑」与「回填单号」之间进程死了 | 那张单到底下没下，只有交易所知道                   |
 * | 单被人在交易所上撤了                   | 本地记着「已挂上」，交易所上已经没有那张单         |
 *
 * 这些漂移由对账**报出来**（`unprotected-position` / `missing-stop-order` /
 * `position-without-record`），但对账**只报告、绝不动手**（§6.5 第 1 条）：
 * 补挂一张止损会平掉真实仓位且不可逆，「自动修复」与「报告」的风险完全不对称。
 *
 * 因此修复一直是**人工决定**。这个模块是那条人工路径的编排：
 *
 * - **判据**在 `packages/core/src/risk-reattach.ts`（纯函数）：该补什么、什么情况下不许补；
 * - **挂单**走 `bracket-orders.ts`（与自动路径**同一份实现**）：自定义号、方向、回滚逐字一致；
 * - **落库**走 `packages/data/src/db/risk.ts`：占坑、回填单号、失败留痕。
 *
 * ## 三条硬边界
 *
 * 1. **一次只处理一个标的、一条记录**。条件单保护的是**整个净仓位**，同一个标的上
 *    挂两套保护会出现多组触发价互相撤销、互相触发（§6.3 第 9 条）。
 * 2. **复现优先于重算**。已有记录且当初算出了档位 → **原样复现**它算好的价。
 *    「当初打算挂的那一张」比「现在重新算的一张」更接近用户的本意。
 *    只有「当初压根没算出档位」（占位记录）与「本地根本没有记录」（裸仓）才现算。
 * 3. **不猜、不兜底**。取不到现价 → 拒绝补挂（挂上去可能立刻以市价平仓）；
 *    取不到 ATR → 不给价。宁可让人看见「补不上」，也不让仓位在无人察觉时平掉。
 */

import {
  SyncError,
  checkReattachTriggers,
  createLogger,
  deriveStagedPlan,
  planReattach,
  toTrendDecisionContext,
  type AlertDispatcher,
  type AnalystContext,
  type ExchangeAlgoOrder,
  type ExchangePosition,
  type LlmDecision,
  type ReattachKind,
  type ReattachOrderTag,
  type ReattachSkip,
  type ReattachTarget,
  type StagedMode,
  type TradeToolConfig,
  type Tp1FillFact,
} from '@trade-tool/core';
import {
  claimBracket,
  listUnsettledBrackets,
  markBracketArmed,
  markBracketFailed,
  markBracketPartialArmed,
  markBracketTrailMoved,
  parseStepSize,
  parseTickSize,
  readContractSpecRaw,
  recordBracketTp1Fill,
  reserveTrailStep,
  updateBracketPlan,
  type BinancePrivateClient,
  type BracketDecision,
  type Pool,
  type UnsettledBracketRecord,
} from '@trade-tool/data';

import type { AtrProvider } from './atr.js';
import { placeBracketOrders, type BracketOrderPlacer } from './bracket-orders.js';
import type { RiskDecider } from './decision.js';
import type { RiskPolicy } from './service.js';

const log = createLogger('executor:reattach');

export interface ReattacherDeps {
  pool: Pool;
  config: TradeToolConfig;
  /** 交易所私有接口：读持仓与挂单。 */
  client: BinancePrivateClient;
  /** 挂单能力。 */
  placer: BracketOrderPlacer;
  atr: AtrProvider;
  /**
   * 按标的解析止盈止损参数。
   *
   * 优先级只有一份实现：`resolvePolicy()`（标的覆盖 > 全局默认 > 配置文件）。
   * **不传就用配置文件**——与 `service.ts` 的同一约定。
   */
  resolvePolicy?: (symbol: string) => Promise<RiskPolicy & { source: string }>;
  /**
   * LLM 决策器。**不传就不问模型**。
   *
   * 给了就走**与自动路径同一套**提示词与降级语义：模型失败按
   * `llm.fallbackToPolicy` 降级到配置档位（并留下 `config-fallback` 的痕迹）。
   */
  decider?: RiskDecider;
  /** 读最近若干根 K 线的收益率（给模型看走势）。缺了不影响决策。 */
  readRecentReturns?: (symbol: string, limit: number) => Promise<readonly number[]>;
  /** 取行情上下文（v1.1.0 的趋势档位）。缺了则模型只看收益率数列。 */
  loadMarketContext?: (symbol: string) => Promise<AnalystContext | null>;
  alerts?: AlertDispatcher;
  now?: () => number;
}

/** 一张要挂的单。 */
export interface ReattachOrderSpec {
  tag: ReattachOrderTag;
  price: number;
  /** 带数量的单（分批形态的第一段止盈）才有。 */
  quantity: number | null;
}

/** 算好的一份补挂计划。**还没挂**——这是给人看的那一份。 */
export interface ReattachExecution {
  kind: ReattachKind;
  symbol: string;
  /** 本地记录的入场单号；`null` = 本地没有记录，要新建一条。 */
  entryOrderId: string | null;
  positionSide: 'LONG' | 'SHORT';
  entryPrice: number;
  quantity: number;
  /** 要挂的单。 */
  orders: ReattachOrderSpec[];
  /** 挂完之后这条记录该是什么状态。 */
  targetState: 'armed' | 'partial_armed' | 'trailing';
  /** 落库用的计划。 */
  plan: {
    stopPrice: number;
    takeProfit: number;
    tp1Price: number | null;
    tp1Qty: number | null;
    atr: number;
    atrPeriod: number;
    atrInterval: string;
    atrWindowFrom: number;
    atrWindowTo: number;
    decision?: BracketDecision;
  };
  /** 档位从哪来（人可读）。 */
  origin: string;
}

/** 一次补挂的处置结果。 */
export interface ReattachDetail {
  kind: ReattachKind;
  symbol: string;
  entryOrderId: string | null;
  outcome:
    /** 已挂上，且单号已回填进库。 */
    | 'placed'
    /** 只算了一遍，**没有挂任何单**（演练）。 */
    | 'dry-run'
    /** 没做，且不是故障（没有要补的东西 / 条件不满足）。 */
    | 'skipped'
    /** 挂了但没成（失败原因在 `reason` 里）。 */
    | 'failed';
  reason: string;
  tpAlgoId?: number;
  slAlgoId?: number;
}

export interface ReattachReport {
  symbol: string;
  /** 真的挂上了几笔。 */
  placed: number;
  /** 演练模式：这一轮**没有**挂任何单。 */
  dryRun: boolean;
  details: ReattachDetail[];
  /** 不补挂但要让人知道的事。 */
  skips: ReattachSkip[];
  /**
   * 拒绝补挂的原因（人可读）。`null` = 没有拒绝。
   *
   * 「拒绝」与「不需要补挂」是**两回事**：前者是「该补但不敢补」，
   * 后者是「仓位有保护」。前者必须让人看见（§5 第 9 条）。
   */
  refusal: string | null;
  /**
   * 补记了「第一段止盈已成交」这个事实时的人话说明。`null` = 没有补记。
   *
   * 补记之后这一笔进入移动止损的管辖区——**常驻的 executor** 下一轮会把它
   * 推进到 `trailing` 并把止损挪上去（§6.8.3）。
   */
  tp1FillRecorded: string | null;
}

export interface Reattacher {
  /**
   * 只读地看一眼：这个标的现在缺什么、补挂会挂出哪几张单、各多少钱。
   *
   * **不出网下单、不写库**——它是给人做决定前的那一眼。
   */
  inspect(symbol: string): Promise<{
    target: ReattachTarget | null;
    execution: ReattachExecution | null;
    /** 不补挂的原因（人可读）。`null` = 可以补。 */
    refusal: string | null;
    skips: ReattachSkip[];
    /** 「第一段止盈已成交、而库里没记」这个要补记的事实。`null` = 没有。 */
    tp1Fill: Tp1FillFact | null;
  }>;
  /** 真的补挂。`dryRun` 为真时只算不挂。 */
  run(symbol: string, options?: { dryRun?: boolean }): Promise<ReattachReport>;
}

function reasonOf(error: unknown): string {
  if (error instanceof SyncError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 裸仓新建记录时用的入场单号。 */
function manualEntryOrderId(now: number): string {
  // 用一个**不会与真实订单号撞上**的前缀：交易所的订单号是纯数字。
  // 它会被条件单的自定义号带上（`rsk-tp-manual-…`），因此对账仍能把它认回本地记录。
  return `manual-${String(now)}`;
}

export function createReattacher(deps: ReattacherDeps): Reattacher {
  const { pool, config, client, placer, atr } = deps;
  const settings = config.executor;
  const exchange = config.market.exchange;
  const now = deps.now ?? ((): number => Date.now());

  /** 标的过滤：配置为空 = 全部。 */
  function inScope(symbol: string): boolean {
    return settings.symbols.length === 0 || settings.symbols.includes(symbol);
  }

  async function resolvePolicyFor(symbol: string): Promise<RiskPolicy & { source: string }> {
    if (!deps.resolvePolicy) {
      return {
        atrPeriod: settings.atrPeriod,
        atrInterval: settings.atrInterval,
        stopAtrMult: settings.stopAtrMult,
        takeProfitAtrMult: settings.takeProfitAtrMult,
        takeProfit1Ratio: settings.takeProfit1Ratio,
        trailAtrMult: settings.trailAtrMult,
        breakevenAfterTp1: settings.breakevenAfterTp1,
        source: 'config',
      };
    }
    return deps.resolvePolicy(symbol);
  }

  /** 取事实：本地记录 + 交易所持仓 + 交易所挂单。 */
  async function gather(symbol: string): Promise<{
    records: UnsettledBracketRecord[];
    position: ExchangePosition | null;
    algoOrders: ExchangeAlgoOrder[];
  }> {
    const [records, positions, algoOrders] = await Promise.all([
      listUnsettledBrackets(pool, exchange, symbol),
      client.positionRisk({ symbol }),
      client.openAlgoOrders({ symbol }),
    ]);
    const position =
      positions.find((row) => row.symbol === symbol && row.positionAmt !== 0) ?? null;
    return { records, position, algoOrders };
  }

  /** 找到「主记录」：与判据挑的是同一条。 */
  function primaryRecord(
    records: UnsettledBracketRecord[],
    target: ReattachTarget | null,
  ): UnsettledBracketRecord | null {
    if (target === null || target.entryOrderId === null) return null;
    return records.find((record) => record.entryOrderId === target.entryOrderId) ?? null;
  }

  /**
   * 现算一份计划（本地没有记录，或当初压根没算出档位）。
   *
   * 走的是**与自动路径同一套**：策略 → ATR → 决策（模型/配置）→ `deriveStagedPlan` 算价。
   */
  async function computeFresh(
    target: ReattachTarget,
    record: UnsettledBracketRecord | null,
  ): Promise<ReattachExecution> {
    const symbol = target.symbol;
    const policy = await resolvePolicyFor(symbol);
    const entryTime = record?.entryTime ?? now();
    const snapshot = await atr.atrAt(symbol, now(), entryTime, {
      interval: policy.atrInterval,
      period: policy.atrPeriod,
    });

    const side = target.positionSide === 'LONG' ? 'BUY' : 'SELL';

    // 决策：与自动路径同一套（模型失败按 `llm.fallbackToPolicy` 降级）。
    let decision: LlmDecision = {
      stopAtrMult: policy.stopAtrMult,
      takeProfitAtrMult: policy.takeProfitAtrMult,
      takeProfit1Ratio: policy.takeProfit1Ratio,
      trailAtrMult: policy.trailAtrMult,
      breakevenAfterTp1: policy.breakevenAfterTp1,
    };
    let decisionSource: BracketDecision['source'] = 'config';
    let rationale: string | undefined;
    let fallbackReason: string | undefined;
    let raw: string | undefined;

    if (deps.decider !== undefined && settings.llm.enabled) {
      let recentReturns: readonly number[] = [];
      if (deps.readRecentReturns !== undefined) {
        try {
          recentReturns = await deps.readRecentReturns(symbol, settings.llm.contextBars);
        } catch (error) {
          log.warn(`${symbol} 读近期 K 线失败，模型少一个参考维度：${reasonOf(error)}`);
        }
      }
      let trend;
      if (deps.loadMarketContext !== undefined && settings.trend.enabled) {
        try {
          const analyst = await deps.loadMarketContext(symbol);
          if (analyst !== null) {
            trend = toTrendDecisionContext({
              analyst,
              side,
              entryPrice: target.entryPrice,
              atr: snapshot.atr,
              atrInterval: snapshot.interval,
              atrPeriod: snapshot.period,
            });
          }
        } catch (error) {
          log.warn(`${symbol} 取行情上下文失败，模型这次只用收益率数列：${reasonOf(error)}`);
        }
      }
      const outcome = await deps.decider.decide({
        symbol,
        side,
        entryPrice: target.entryPrice,
        atr: snapshot.atr,
        atrPeriod: snapshot.period,
        atrInterval: snapshot.interval,
        baseline: decision,
        recentReturns,
        ...(trend === undefined ? {} : { trend }),
      });
      decisionSource = outcome.source;
      rationale = outcome.rationale;
      fallbackReason = outcome.fallbackReason;
      raw = outcome.raw;
      if (!outcome.refuse) {
        decision = outcome.decision;
      } else {
        // 用户明确选择了「宁可不挂也不要按配置挂」。手动补挂同样照做——
        // 补挂的语义是「按你批准的那套挂上」，不是「无论如何都挂上」。
        throw new SyncError(
          'CONFIG_INVALID',
          `${symbol} 的模型决策没有产出可用档位，且配置要求不降级（llm.fallbackToPolicy=false）：` +
            `${outcome.fallbackReason ?? '未知原因'}——不补挂`,
          { symbol },
        );
      }
    }

    const spec = await readContractSpecRaw(pool, exchange, symbol);
    const tickSize = parseTickSize(spec, symbol);
    const staged = decision.takeProfit1Ratio > 0 && decision.takeProfit1Ratio < 1;
    const plan = deriveStagedPlan({
      side,
      entryPrice: target.entryPrice,
      atr: snapshot.atr,
      atrPeriod: snapshot.period,
      stopAtrMult: decision.stopAtrMult,
      takeProfitAtrMult: decision.takeProfitAtrMult,
      takeProfit1Ratio: decision.takeProfit1Ratio,
      tickSize,
      ...(staged ? { stepSize: parseStepSize(spec, symbol) } : {}),
      filledQty: target.quantity,
    });

    const tp1Qty = plan.mode === 'partial' ? plan.tp1Qty : null;
    return {
      kind: target.kind,
      symbol,
      entryOrderId: target.entryOrderId,
      positionSide: target.positionSide,
      entryPrice: target.entryPrice,
      quantity: target.quantity,
      orders: [
        {
          tag: plan.mode === 'partial' ? 'tp1' : 'tp',
          price: plan.takeProfitPrice,
          quantity: tp1Qty,
        },
        { tag: 'sl', price: plan.stopPrice, quantity: null },
      ],
      targetState: plan.mode === 'partial' ? 'partial_armed' : 'armed',
      plan: {
        stopPrice: plan.stopPrice,
        takeProfit: plan.takeProfitPrice,
        tp1Price: plan.mode === 'partial' ? plan.takeProfitPrice : null,
        tp1Qty,
        atr: snapshot.atr,
        atrPeriod: snapshot.period,
        atrInterval: snapshot.interval,
        atrWindowFrom: snapshot.segmentFrom,
        atrWindowTo: snapshot.segmentTo,
        decision: {
          source: decisionSource,
          decision,
          ...(rationale === undefined ? {} : { rationale }),
          ...(fallbackReason === undefined ? {} : { fallbackReason }),
          ...(raw === undefined ? {} : { raw }),
          at: now(),
        },
      },
      origin:
        `按当前生效的策略档位现算（${policy.source === 'config' ? '配置文件' : policy.source === 'symbol' ? '标的覆盖' : '全局默认'}）` +
        `，ATR ${snapshot.atr}（${snapshot.interval} · ${String(snapshot.period)}）`,
    };
  }

  /**
   * 复现记录里**当初算好的**计划。
   *
   * 不重新算：补挂要的是「当初打算挂的那一张」。重算会让同一次故障的两次处置
   * 给出不同的止损位，而用户看到的会是两个价。
   */
  function reproduce(target: ReattachTarget, record: UnsettledBracketRecord): ReattachExecution {
    const prices = target.prices;
    if (prices === null) {
      throw new SyncError(
        'CONFIG_INVALID',
        `${target.symbol} 的记录没有可复现的计划（当初没算出档位），需要现算`,
        { symbol: target.symbol },
      );
    }
    const staged = prices.tp1Qty !== null;
    const orders: ReattachOrderSpec[] = [];
    for (const tag of target.need) {
      if (tag === 'sl') {
        orders.push({ tag, price: prices.stopPrice, quantity: null });
        continue;
      }
      if (prices.takeProfitPrice === null) {
        throw new SyncError('CONFIG_INVALID', `${target.symbol} 的记录没有止盈价，无法复现`, {
          symbol: target.symbol,
        });
      }
      orders.push({
        tag: staged ? 'tp1' : 'tp',
        price: prices.takeProfitPrice,
        quantity: staged ? prices.tp1Qty : null,
      });
    }
    const mode: StagedMode = staged ? 'partial' : 'single';
    const targetState: ReattachExecution['targetState'] =
      record.state === 'trailing' ? 'trailing' : mode === 'partial' ? 'partial_armed' : 'armed';
    return {
      kind: target.kind,
      symbol: target.symbol,
      entryOrderId: target.entryOrderId,
      positionSide: target.positionSide,
      entryPrice: target.entryPrice,
      quantity: target.quantity,
      orders,
      targetState,
      plan: {
        stopPrice: prices.stopPrice,
        takeProfit: prices.takeProfitPrice ?? record.takeProfit,
        tp1Price: staged ? prices.takeProfitPrice : null,
        tp1Qty: prices.tp1Qty,
        atr: record.atr,
        atrPeriod: record.atrPeriod,
        atrInterval: record.atrInterval,
        atrWindowFrom: record.atrWindowFrom,
        atrWindowTo: record.atrWindowTo,
      },
      origin:
        `复现记录里当初算好的档位（ATR ${record.atr}（${record.atrInterval} · ` +
        `${String(record.atrPeriod)}），来源 ${record.decisionSource}）`,
    };
  }

  /** 算一份补挂计划（不挂）。 */
  async function buildExecution(
    target: ReattachTarget,
    record: UnsettledBracketRecord | null,
  ): Promise<ReattachExecution> {
    if (target.prices !== null && record !== null) return reproduce(target, record);
    return computeFresh(target, record);
  }

  /** 取现价：持仓快照里没有就问一次公开接口。 */
  async function currentPriceOf(
    symbol: string,
    position: ExchangePosition | null,
  ): Promise<number | null> {
    if (position !== null && position.markPrice !== null && Number.isFinite(position.markPrice)) {
      return position.markPrice;
    }
    try {
      return await client.markPrice(symbol);
    } catch (error) {
      log.warn(`${symbol} 取不到现价：${reasonOf(error)}`);
      return null;
    }
  }

  /** 只读地看一眼：这个标的现在缺什么、补挂会挂出哪几张单、各多少钱。 */
  async function inspect(symbol: string): Promise<{
    target: ReattachTarget | null;
    execution: ReattachExecution | null;
    /** 不补挂的原因（人可读）。`null` = 可以补。 */
    refusal: string | null;
    skips: ReattachSkip[];
    /** 「第一段止盈已成交、而库里没记」这个要补记的事实。`null` = 没有。 */
    tp1Fill: Tp1FillFact | null;
  }> {
    return inspectInternal(symbol);
  }

  /** 一次取齐事实并算出一份计划。`inspect` 与 `run` 共用，避免重复出网。 */
  async function inspectInternal(symbol: string): Promise<{
    target: ReattachTarget | null;
    execution: ReattachExecution | null;
    refusal: string | null;
    skips: ReattachSkip[];
    tp1Fill: Tp1FillFact | null;
  }> {
    if (!inScope(symbol)) {
      return {
        target: null,
        execution: null,
        refusal: `${symbol} 不在 executor.symbols 的范围内，不处理`,
        skips: [],
        tp1Fill: null,
      };
    }
    const { records, position, algoOrders } = await gather(symbol);
    const plan = planReattach({ symbol, records, position, algoOrders });
    if (plan.target === null) {
      return {
        target: null,
        execution: null,
        refusal: plan.refusal,
        skips: plan.skips,
        tp1Fill: plan.tp1Fill,
      };
    }
    const record = primaryRecord(records, plan.target);
    let execution: ReattachExecution;
    try {
      execution = await buildExecution(plan.target, record);
    } catch (error) {
      return {
        target: plan.target,
        execution: null,
        refusal: reasonOf(error),
        skips: plan.skips,
        tp1Fill: plan.tp1Fill,
      };
    }
    // 「挂上去会不会立刻以市价平掉」的检查。**取不到现价就拒绝**——
    // 猜一个方向的后果是仓位被市价平掉（约定 9：不静默兜底）。
    const currentPrice = await currentPriceOf(symbol, position);
    const problem = checkReattachTriggers({
      positionSide: plan.target.positionSide,
      currentPrice,
      orders: execution.orders.map((order) => ({ tag: order.tag, price: order.price })),
    });
    if (problem !== null) {
      return {
        target: plan.target,
        execution,
        refusal: problem,
        skips: plan.skips,
        tp1Fill: plan.tp1Fill,
      };
    }
    return {
      target: plan.target,
      execution,
      refusal: null,
      skips: plan.skips,
      tp1Fill: plan.tp1Fill,
    };
  }

  /**
   * 补记「第一段止盈已成交、而**库里没记**」这个事实。
   *
   * ## 为什么必须补记
   *
   * 第一段止盈是**带数量**的单，它成交后交易所自动撤掉——于是「交易所上找不到
   * 那张单」在成交之后是**正常**的（§6.5 第 5 条）。但「成交了」这个事实
   * 只有一个记录者：用户数据流（`recordBracketTp1Fill`）。用户数据流**不在**时
   * 成交的那一笔，库里就永远缺这个事实，于是两件事同时坏掉：
   *
   * - 对账每轮报一条「止盈单不见了」的**假警报**；
   * - 移动止损定时器不认领这一笔（它只认 `tp1_filled_at` 非空的行，§6.8.3），
   *   于是它永远进不了移动止损——剩余仓位一直用着进场那一档的宽止损。
   *
   * 补记之后，记录停在「`partial_armed` + `tp1_filled_at` 非空」——那正是
   * 移动止损定时器认领的「等推进」那一格，**常驻的 executor 下一轮**就会把它
   * 推进到 `trailing` 并把止损挪上去。
   *
   * ## 价格与手续费用近似值
   *
   * 成交价用**触发价**近似（当时没人看着实际成交价），手续费记 `0`。
   * 宁可记一个带滑点误差的价，也不要让这一段成交的事实整个丢掉——
   * 丢掉的话净盈亏会少算一整段，而那一段是**真的发生过**的。
   */
  async function recordTp1Fill(symbol: string, fact: Tp1FillFact | null): Promise<string | null> {
    if (fact === null) return null;
    const recorded = await recordBracketTp1Fill(
      pool,
      { exchange, symbol, entryOrderId: fact.entryOrderId },
      { price: fact.price, qty: fact.qty, fee: 0 },
      now(),
    );
    if (recorded === 0) {
      const reason = `${symbol} 的「第一段止盈已成交」没能补记进库（这条记录可能已经不在了）——请人工确认`;
      log.error(reason);
      return reason;
    }
    return (
      `${symbol}：第一段止盈确实成交过（按触发价 ${fact.price} 记、手续费记 0），` +
      '这个事实已补记进库——这一笔交给移动止损接手（常驻的 executor 下一轮推进）'
    );
  }

  async function run(symbol: string, options: { dryRun?: boolean } = {}): Promise<ReattachReport> {
    const dryRun = options.dryRun === true;
    const details: ReattachDetail[] = [];

    const { target, execution, refusal, skips, tp1Fill } = await inspectInternal(symbol);

    // 拒绝补挂：原因要让人看见，而且**什么都不做**（不挂单、不改状态）。
    if (refusal !== null) {
      return { symbol, placed: 0, dryRun, details, skips, refusal, tp1FillRecorded: null };
    }

    // 事实补记与「有没有单要补」**无关**：哪怕保护是完整的，那个「已成交」的事实
    // 也该补上（否则对账一直报假警报、移动止损也永远不接手）。
    const tp1FillRecorded = dryRun ? null : await recordTp1Fill(symbol, tp1Fill);

    if (target === null) {
      return { symbol, placed: 0, dryRun, details, skips, refusal: null, tp1FillRecorded };
    }
    if (execution === null) {
      details.push({
        kind: target.kind,
        symbol,
        entryOrderId: target.entryOrderId,
        outcome: 'skipped',
        reason: '算不出补挂计划',
      });
      return { symbol, placed: 0, dryRun, details, skips, refusal: null, tp1FillRecorded };
    }
    if (dryRun) {
      details.push({
        kind: target.kind,
        symbol,
        entryOrderId: target.entryOrderId,
        outcome: 'dry-run',
        reason:
          describeExecution(execution) +
          (tp1Fill === null
            ? ''
            : '；另外：这一笔的第一段止盈已成交（库里没记），演练不改状态，所以这个事实没补记'),
      });
      return { symbol, placed: 0, dryRun, details, skips, refusal: null, tp1FillRecorded: null };
    }

    const record = await loadRecord(symbol, target.entryOrderId);
    const result = await applyExecution(symbol, execution, record);
    details.push(result.detail);
    return {
      symbol,
      placed: result.detail.outcome === 'placed' ? 1 : 0,
      dryRun,
      details,
      skips,
      refusal: null,
      tp1FillRecorded,
    };
  }

  async function loadRecord(
    symbol: string,
    entryOrderId: string | null,
  ): Promise<UnsettledBracketRecord | null> {
    if (entryOrderId === null) return null;
    const records = await listUnsettledBrackets(pool, exchange, symbol);
    return records.find((record) => record.entryOrderId === entryOrderId) ?? null;
  }

  /** 真的挂：下单 → 回填 → 留痕。 */
  async function applyExecution(
    symbol: string,
    execution: ReattachExecution,
    record: UnsettledBracketRecord | null,
  ): Promise<{ detail: ReattachDetail }> {
    const entryOrderId = record?.entryOrderId ?? manualEntryOrderId(now());
    const key = { exchange, symbol, entryOrderId };

    // 移动止损阶段：止损单号必须**新占一个档位**——Binance 不允许两张同号挂单
    // 同时存在，而旧的（已消失的）那张占着 `rsk-sl-<入场单号>`。
    let step = 0;
    if (execution.targetState === 'trailing') {
      const reserved = await reserveTrailStep(pool, key, now());
      if (reserved === null) {
        const reason = '记录已不在移动止损阶段（可能刚被结算），不补挂';
        return {
          detail: {
            kind: execution.kind,
            symbol,
            entryOrderId,
            outcome: 'skipped',
            reason,
          },
        };
      }
      step = reserved;
    }

    /**
     * 占坑（裸仓时才做）：**先占坑再动手**。
     *
     * 顺序不能反：单挂上了、而记录没写进去时，交易所上会留下一张**没人认领**的单
     * ——而补挂的幂等锚点正是这张记录（§6.3 第 4 条）。
     */
    if (record === null) {
      const claimed = await claimBracket(pool, {
        exchange,
        symbol,
        entryOrderId,
        entryPrice: execution.entryPrice,
        entryTime: now(),
        filledQty: execution.quantity,
        positionSide: execution.positionSide,
        atr: execution.plan.atr,
        atrPeriod: execution.plan.atrPeriod,
        atrInterval: execution.plan.atrInterval,
        atrWindowFrom: execution.plan.atrWindowFrom,
        atrWindowTo: execution.plan.atrWindowTo,
        stopPrice: execution.plan.stopPrice,
        takeProfit: execution.plan.takeProfit,
        ...(execution.plan.tp1Qty !== null && execution.plan.tp1Price !== null
          ? { tp1Qty: execution.plan.tp1Qty, tp1Price: execution.plan.tp1Price }
          : {}),
        ...(execution.plan.decision === undefined ? {} : { decision: execution.plan.decision }),
        now: now(),
      });
      if (claimed === null) {
        const reason = '这条记录已经存在（可能刚刚被别人补挂了），不重复挂';
        return {
          detail: { kind: execution.kind, symbol, entryOrderId, outcome: 'skipped', reason },
        };
      }
    }

    // 挂单。**只挂缺的那几张**，另一张还在交易所上时不重复挂。
    const result = await placeBracketOrders({
      placer,
      symbol,
      entryOrderId,
      positionSide: execution.positionSide,
      takeProfitPrice: execution.plan.takeProfit,
      tp1Qty: execution.plan.tp1Qty,
      stopPrice: execution.plan.stopPrice,
      only: execution.orders.map((order) => order.tag),
      step,
      workingType: settings.workingType,
      priceProtect: settings.priceProtect,
    });

    if (result.error !== null) {
      const reason = `${result.error}${result.cancelNote ?? ''}`;
      // 留痕：失败必须**看得见**（约定 9）。裸仓不能只是一行日志。
      await markBracketFailed(
        pool,
        key,
        {
          ...(result.tpAlgoId !== null ? { tpAlgoId: result.tpAlgoId } : {}),
          ...(result.slAlgoId !== null ? { slAlgoId: result.slAlgoId } : {}),
        },
        `手动补挂失败：${reason}`,
        now(),
      ).catch((error: unknown) => {
        log.error(`${symbol} 补挂失败后记失败原因时又出错：${reasonOf(error)}`);
      });
      log.error(`${symbol} 手动补挂失败：${reason}`);
      return {
        detail: {
          kind: execution.kind,
          symbol,
          entryOrderId,
          outcome: 'failed',
          reason,
        },
      };
    }

    // 回填。**单号不回填 = 「单下了但库里不知道」**——那是最不能当下就放过的一种状态。
    const placedTpAlgoId = result.tpAlgoId;
    const placedSlAlgoId = result.slAlgoId;

    /**
     * 这一轮**要挂**的那几张，都挂上了吗？
     *
     * ⚠️ **「只挂一张」是正常的**——另一张还在交易所上（例如「缺止损」、
     * 或「第一段止盈已成交、只剩止损要补」）。而「两张都要、却只挂上一张」
     * 才是那个危险状态（§6.3 第 5 条）。把两者混为一谈，会让最常见的补挂
     * （只补缺的那一张）被记成失败——**挂上了却说没挂上**，比没挂更让人不敢信。
     */
    const wanted = execution.orders.map((order) => order.tag);
    const missing = wanted.filter((tag) =>
      tag === 'sl' ? placedSlAlgoId === null : placedTpAlgoId === null,
    );
    if (missing.length > 0) {
      const reason =
        `补挂要挂的单没有全部挂上（缺 ${missing.map((tag) => describeTag(tag)).join('、')}）` +
        '——请人工确认交易所上的状态';
      await markBracketFailed(pool, key, {}, reason, now()).catch((error: unknown) => {
        log.error(`${symbol} 补挂没挂全后记失败原因时又出错：${reasonOf(error)}`);
      });
      return {
        detail: { kind: execution.kind, symbol, entryOrderId, outcome: 'failed', reason },
      };
    }

    /**
     * 回填用的单号：**这一轮挂上的**；没有就**沿用记录里的旧号**。
     *
     * 沿用旧号是因为「这一轮没挂的那张」**还在交易所上挂着**——把它写成 `null`
     * 等于把一张正在保护仓位的单从账面上抹掉（对账随即报「止损单不见了」）。
     */
    const finalSlAlgoId = placedSlAlgoId ?? record?.slAlgoId ?? null;
    if (finalSlAlgoId === null) {
      const reason = '找不到止损单的单号，无法回填——请人工确认交易所上的状态';
      await markBracketFailed(pool, key, {}, reason, now()).catch((error: unknown) => {
        log.error(`${symbol} 补挂回填时记失败原因又出错：${reasonOf(error)}`);
      });
      return {
        detail: { kind: execution.kind, symbol, entryOrderId, outcome: 'failed', reason },
      };
    }

    if (execution.targetState === 'trailing') {
      const extreme = record?.trailExtreme ?? null;
      const trailAtr = record?.trailAtr ?? null;
      if (extreme === null || trailAtr === null) {
        const reason = '移动止损记录缺极值或 ATR，无法回填新档位——请人工确认';
        await markBracketFailed(pool, key, { slAlgoId: finalSlAlgoId }, reason, now()).catch(
          () => undefined,
        );
        return {
          detail: { kind: execution.kind, symbol, entryOrderId, outcome: 'failed', reason },
        };
      }
      const moved = await markBracketTrailMoved(
        pool,
        key,
        {
          stopPrice: execution.plan.stopPrice,
          extreme,
          atr: trailAtr,
          atrFrom: record?.trailAtrFrom ?? 0,
          atrTo: record?.trailAtrTo ?? 0,
          slAlgoId: finalSlAlgoId,
        },
        now(),
      );
      if (moved === 0) {
        const reason = '记录已不在移动止损阶段，单号没能回填——请人工确认';
        return {
          detail: { kind: execution.kind, symbol, entryOrderId, outcome: 'failed', reason },
        };
      }
    } else {
      if (record !== null && execution.plan.decision !== undefined) {
        // 占位记录：把**新算出来的计划**写回去。不写的话，记录里永远停在
        // 「止损价 = 入场价」，而交易所上挂的是另一个价（对账随即报价格不符）。
        await updateBracketPlan(pool, key, execution.plan, now());
      }

      if (execution.targetState === 'partial_armed') {
        // 第一段止盈单：这一轮挂的，或者**之前就在交易所上**的那一张。
        // 「第一段已成交」的情形下它已经不在交易所上了，但号仍留在记录里做历史。
        const tp1AlgoId = placedTpAlgoId ?? record?.tp1AlgoId ?? null;
        if (tp1AlgoId === null) {
          const reason = '分批形态却找不到第一段止盈的单号，无法回填——请人工确认';
          await markBracketFailed(pool, key, { slAlgoId: finalSlAlgoId }, reason, now()).catch(
            () => undefined,
          );
          return {
            detail: { kind: execution.kind, symbol, entryOrderId, outcome: 'failed', reason },
          };
        }
        await markBracketPartialArmed(pool, key, { tp1AlgoId, slAlgoId: finalSlAlgoId }, now());
      } else {
        const tpAlgoId = placedTpAlgoId ?? record?.tpAlgoId ?? null;
        if (tpAlgoId === null) {
          const reason = '找不到止盈单的单号，无法回填——请人工确认';
          await markBracketFailed(pool, key, { slAlgoId: finalSlAlgoId }, reason, now()).catch(
            () => undefined,
          );
          return {
            detail: { kind: execution.kind, symbol, entryOrderId, outcome: 'failed', reason },
          };
        }
        await markBracketArmed(pool, key, { tpAlgoId, slAlgoId: finalSlAlgoId }, now());
      }
    }

    log.info(
      `${symbol} 手动补挂完成：${describeExecution(execution)}` +
        `（止盈单 ${placedTpAlgoId ?? '—'}，止损单 ${finalSlAlgoId}）`,
    );
    await pushAlert(symbol, execution, placedTpAlgoId, finalSlAlgoId);

    return {
      detail: {
        kind: execution.kind,
        symbol,
        entryOrderId,
        outcome: 'placed',
        reason: describeExecution(execution),
        ...(placedTpAlgoId === null ? {} : { tpAlgoId: placedTpAlgoId }),
        slAlgoId: finalSlAlgoId,
      },
    };
  }

  /** 推一条告警：补挂是**人工动作**，群里应当看得见。 */
  async function pushAlert(
    symbol: string,
    execution: ReattachExecution,
    tpAlgoId: number | null,
    slAlgoId: number,
  ): Promise<void> {
    const alerts = deps.alerts;
    if (alerts === undefined) return;
    try {
      const result = await alerts.dispatch((channel: { kinds: readonly string[] }) => {
        if (!channel.kinds.includes('bracket-armed')) return [];
        return [
          {
            fingerprint: `reattach|${symbol}|${execution.entryOrderId ?? 'manual'}`,
            category: 'risk' as const,
            severity: 'info' as const,
            oneShot: true,
            title: `${symbol} 手动补挂止盈止损`,
            lines: [
              `情形：${describeKind(execution.kind)}`,
              execution.orders
                .map((order) => `${describeTag(order.tag)} ${order.price}`)
                .join('，'),
              `订单号：止盈 ${tpAlgoId === null ? '—（这一轮没挂止盈）' : String(tpAlgoId)}，止损 ${String(slAlgoId)}`,
              execution.origin,
            ],
          },
        ];
      }, 'bracket-armed');
      if (result.sent > 0) log.info(`告警已推送（bracket-armed）：发出 ${String(result.sent)} 条`);
    } catch (error) {
      log.error(`告警推送失败（不影响补挂）：${reasonOf(error)}`);
    }
  }

  return { inspect, run };
}

/** 情形的人话。 */
export function describeKind(kind: ReattachKind): string {
  switch (kind) {
    case 'naked-position':
      return '裸仓（交易所上有仓位，本地没有记录）';
    case 'unprotected-position':
      return '记录下单失败，一张单都没挂上';
    case 'missing-stop-order':
      return '缺止损单';
    case 'missing-take-profit-order':
      return '缺止盈单';
  }
}

function describeTag(tag: ReattachOrderTag): string {
  if (tag === 'sl') return '止损';
  if (tag === 'tp1') return '第一段止盈';
  return '止盈';
}

/** 一份计划的人话（给人看的那一份）。 */
export function describeExecution(execution: ReattachExecution): string {
  return (
    execution.orders.map((order) => `${describeTag(order.tag)} ${order.price}`).join('，') +
    `（入场 ${execution.entryPrice} × ${execution.quantity}，` +
    `${execution.positionSide === 'LONG' ? '多头' : '空头'}；${execution.origin}）`
  );
}
