/**
 * Agent 执行方案的**自动下单**（v1.0.0）。
 *
 * 回答一个问题：**一份被批准的方案，怎么变成交易所里的一笔真实订单？**
 *
 * 流程是三步，顺序不能换：**认领 → 下单 → 回填**。
 *
 *   1. **认领**（`approved → executing`）：先把「这份方案归我了」写进库。
 *      它是**幂等锚点**——两个执行器同时跑时只有一个能认领成功。
 *   2. **下单**：市价进场单。这是**唯一不可回滚**的一步。
 *   3. **回填**（`executing → executed`）：记下单号与时刻。
 *
 * ⚠️ **为什么不能省掉第 1 步**：下单成功但回填前进程崩掉的话，那一单已经真实存在，
 * 而库里没有任何东西记着它。下一轮再跑一次就是**重复下单**——仓位翻倍，
 * 而日志与库里都看不出异常。认领把这件事挡在前面：崩在中间时方案停在 `executing`，
 * **不会被自动重试**（那一单到底下没下，只有交易所知道），
 * 本模块把它当成「状态未知」报出来，等人确认。
 *
 * ## 为什么只支持市价进场
 *
 * 限价进场（GTC）的生命周期是另一个题目：挂着不成交怎么办、过期怎么撤、
 * 部分成交怎么算——每一条都要有代码与状态。这里**明确不支持**：
 * 遇到限价方案就记一条**看得见的失败**（`status='failed'` + 原因），
 * 而不是悄悄跳过或者挂一个永远不成交的单。
 *
 * ## 止损与止盈不在这里挂
 *
 * 这里只负责**进场**。止损止盈由成交事件驱动（`service.ts` 的 `openBracket`）：
 * 成交价是**实际成交价**（不是方案里的估算价），档位用**方案给的 ATR 倍数**
 * （`decision_source='agent-plan'`）。于是滑点不会让止损落错位置，
 * 而「当时用的是哪套档位」也留了痕。
 */

import { agentEntryClientOrderId, createLogger, parseAgentEntryClientOrderId } from '@trade-tool/core';
import {
  claimTradingPlan,
  listApprovedTradingPlans,
  listExecutingTradingPlans,
  markTradingPlanExecutionFailed,
  markTradingPlanExecuted,
  readTradingPlanById,
  updateTradingPlanStatus,
  type TradingPlanRow,
} from '@trade-tool/data';

import type { Pool } from '@trade-tool/data';

const log = createLogger('executor:plan');

/**
 * 一份 Agent 方案给出的档位。
 *
 * 它是**方案里的两个 ATR 倍数**——不是价格。价格由 `deriveStagedPlan` 按
 * **实际成交价**算（方案里的进场价是估算值，用它算会把止损挂在错的位置）。
 */
export interface AgentPlanDecision {
  planId: string;
  stopAtrMult: number;
  takeProfitAtrMult: number;
  /** 方案的理由。落进 `decision_rationale`，事后能回答「当时为什么这么定」。 */
  rationale: string;
}

/**
 * 下单能力。只声明用到的一个方法，测试可整体替身。
 *
 * 与 `service.ts` 的 `OrderPlacer` 分开：那边是**条件单**（Algo Order API，
 * 回执是 `algoId`），这边是**普通市价单**（回执是 `orderId`）。两套编号空间互不通用，
 * 混在一起会让「这张单是不是我方挂的」判断失灵。
 */
export interface MarketOrderPlacer {
  placeMarketOrder(request: {
    symbol: string;
    side: 'BUY' | 'SELL';
    quantity: number;
    clientOrderId: string;
  }): Promise<{
    orderId: number;
    clientOrderId: string;
    symbol: string;
    status: string;
    avgPrice: number | null;
    executedQty: number;
  }>;
}

export interface PlanExecutorDeps {
  pool: Pool;
  placer: MarketOrderPlacer;
  exchange: string;
  /** 可注入时钟，测试里固定住。 */
  now?: () => number;
  /**
   * 方案的有效期（毫秒）。超过它就不执行。
   *
   * 缺省 30 分钟：一份方案的依据是「刚才那批行情」，
   * 半小时后行情都换了，拿旧方案下单是拿旧信息冒险。
   */
  planTtlMs?: number;
  /**
   * 同时最多允许多少笔未终结的方案。
   *
   * 缺省 1：**一次只开一笔**。开仓是加仓位的动作，连着开两笔会让敞口翻倍，
   * 而两笔方案各自的风险上限是分开算的——加起来就超出了「单笔上限」的本来意思。
   */
  maxOpenPlans?: number;
  /**
   * 该标的当前**有没有未平掉的仓位**。
   *
   * 有就不叠加：Agent 的仓位是按「这一笔最多亏权益的百分之几」算的，
   * 它假设的是**一笔干净的开仓**。在已有仓位上再加一笔，风险敞口就不是
   * 方案里写的那个数了——而方案页面上显示的仍然是那个数。
   */
  hasOpenPosition?: (symbol: string) => boolean;
  /**
   * 该标的**是否已有未终结的止盈止损**。
   *
   * 有就不开新仓：条件单保护的是**整个净仓位**，同一个标的上挂两套保护，
   * 会出现多组触发价互相撤销、互相触发（§6.3 第 4 条）。
   */
  hasUnsettledBracket?: (symbol: string) => Promise<boolean>;
  /** 告警派发器。不传就只记日志。 */
  alerts?: {
    dispatch(
      build: (channel: { kinds: readonly string[] }) => unknown[] | unknown,
      scope: string,
    ): Promise<{ sent: number }>;
  };
}

/** 一份方案的处置结果。**每一条都要有说法**——没有「无声跳过」这一档。 */
export interface PlanExecutionDetail {
  planId: string;
  symbol: string;
  outcome:
    /** 已变成真实订单。 */
    | 'executed'
    /** 没做，且**不是故障**（条件不满足、已被别人认领、不是可执行的方案）。 */
    | 'skipped'
    /** 下单失败。方案已记 `failed` + 原因。 */
    | 'failed';
  reason: string;
  entryOrderId?: string;
}

/**
 * 一轮执行的结果。
 *
 * `stuck` 单列：认领之后崩在中间的方案停在 `executing`，
 * 它们**不会**被自动重试（本模块只捞 `approved`），
 * 必须由人确认「那一单到底下没下」。把它们混进 `skipped` 就会被当成
 * 「这轮没事」，于是那个状态永远没人看。
 */
export interface PlanExecutionReport {
  executed: number;
  skipped: number;
  failed: number;
  /** 认领后卡在 `executing` 的方案数（状态未知，需要人工确认）。 */
  stuck: number;
  details: PlanExecutionDetail[];
}

export interface PlanExecutor {
  runOnce(): Promise<PlanExecutionReport>;
}

/**
 * 限价进场的失败说明。
 *
 * 它是**给人看的**：写清楚「为什么不行」和「怎么办」，
 * 而不是只说「不支持」。方案页面上会原样显示它。
 */
export const LIMIT_ENTRY_UNSUPPORTED =
  '限价进场暂不支持自动执行（只支持市价进场）：限价单可能永远不成交，' +
  '而挂着不成交的仓位没有止损保护。请改用市价进场，或在交易所手动下单。';

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 方案能不能执行。**不合法就不下单**，而不是下到交易所让它拒。
 *
 * 这里的检查与库上的 CHECK 约束是**两道独立的闸**，不是同一份判据：
 * 约束挡的是「写进库就不合规的行」，这里挡的是「库里的行在执行时才发现不完整」。
 * 两道闸各管一段——库上那套治「写」，这套治「读」。
 */
function checkExecutable(plan: TradingPlanRow): string | null {
  if (plan.action !== 'enter') {
    return `方案是「这一轮不做」（action=${plan.action}），没有可执行的进场`;
  }
  if (plan.side === null) return '方案没有方向';
  if (plan.entryType === null) return '方案没有进场类型';
  if (plan.entryType === 'limit') return LIMIT_ENTRY_UNSUPPORTED;
  if (plan.quantity === null || plan.quantity <= 0) return '方案没有有效数量';
  if (plan.stopPrice === null) return '方案没有止损价';
  if (plan.takeProfitPrice === null) return '方案没有止盈价';
  return null;
}

export function createPlanExecutor(deps: PlanExecutorDeps): PlanExecutor {
  const now = deps.now ?? ((): number => Date.now());
  async function pushAlert(
    topic: 'agent-plan-executed' | 'agent-plan-failed',
    build: () => {
      fingerprint: string;
      category: 'trade' | 'error';
      severity: 'critical' | 'warning' | 'info';
      oneShot: boolean;
      title: string;
      lines: string[];
    },
  ): Promise<void> {
    const alerts = deps.alerts;
    if (alerts === undefined) return;
    try {
      const result = await alerts.dispatch((channel: { kinds: readonly string[] }) => {
        if (!channel.kinds.includes(topic)) return [];
        return [build()];
      }, topic);
      if (result.sent > 0) log.info(`告警已推送（${topic}）：发出 ${String(result.sent)} 条`);
    } catch (error) {
      log.error(`告警推送失败（不影响下单）：${reasonOf(error)}`);
    }
  }

  async function runOnce(): Promise<PlanExecutionReport> {
    const details: PlanExecutionDetail[] = [];
    let executed = 0;
    let skipped = 0;
    let failed = 0;

    // 卡在 `executing` 的方案：认领之后崩在中间的那些。
    // 它们**不重试**——那一单到底下没下只有交易所知道，重试就是可能下两次。
    const stuck = await listExecutingTradingPlans(deps.pool, deps.exchange);
    for (const plan of stuck) {
      details.push({
        planId: plan.id,
        symbol: plan.symbol,
        outcome: 'skipped',
        reason:
          '方案认领后没有回填单号（执行中断）：那一单是否真的下出去只有交易所知道，' +
          '因此不会自动重试。请在交易所核对后手动处理。',
      });
    }

    const plans = await listApprovedTradingPlans(deps.pool, deps.exchange);
    const ttlMs = deps.planTtlMs ?? 30 * 60_000;
    const maxOpen = deps.maxOpenPlans ?? 1;
    // 已经「认领但没回填」的也算占着额度：那一单可能已经真实存在，
    // 再开一笔就可能超出额度了。
    let opened = stuck.length;

    for (const plan of plans) {
      // 有效期。超时的方案**作废**（`expired`），不再执行。
      //
      // 为什么作废而不是跳过：跳过的方案会永远留在 `approved` 里，
      // 每一轮都被捞出来、被跳过——页面上永远挂着一份「等着执行」的旧方案，
      // 而它永远不会被执行。作废掉，状态才是真的。
      const age = now() - plan.createdAtMs;
      if (age > ttlMs) {
        skipped += 1;
        const reason = `方案已过期（${Math.round(age / 1000)} 秒 > ${Math.round(ttlMs / 1000)} 秒）：依据的行情已经不新了`;
        details.push({ planId: plan.id, symbol: plan.symbol, outcome: 'skipped', reason });
        log.warn(`${plan.symbol} 方案 #${plan.id} 已过期，不再执行`);
        await updateTradingPlanStatus(deps.pool, plan.id, 'expired').catch((error: unknown) => {
          log.error(`${plan.symbol} 方案 #${plan.id} 标记过期失败：${reasonOf(error)}`);
        });
        continue;
      }

      // 同时只开有限几笔。开仓是加仓位的动作，连着开两笔会让敞口翻倍，
      // 而两笔方案各自的风险上限是分开算的——加起来就超出了「单笔上限」的本来意思。
      if (opened >= maxOpen) {
        skipped += 1;
        details.push({
          planId: plan.id,
          symbol: plan.symbol,
          outcome: 'skipped',
          reason: `同时最多 ${String(maxOpen)} 笔未终结的方案，本轮不再开新的`,
        });
        continue;
      }

      const problem = checkExecutable(plan);
      if (problem !== null) {
        // 不可执行的方案**不认领**，直接跳过。
        //
        // 为什么不认领：认领是幂等锚点，把一份永远执行不了的方案认领走，
        // 只会让它卡在 `executing` 变成一个「状态未知」——比跳过更糟。
        skipped += 1;
        details.push({ planId: plan.id, symbol: plan.symbol, outcome: 'skipped', reason: problem });
        log.warn(`${plan.symbol} 方案 #${plan.id} 未执行：${problem}`);
        continue;
      }

      // 已有仓位就不叠加（方案的风险敞口假设的是一笔干净开仓）。
      if (deps.hasOpenPosition?.(plan.symbol) === true) {
        skipped += 1;
        const reason = '该标的当前已有未平掉的仓位，不再叠加开仓（方案的风险敞口假设的是一笔干净开仓）';
        details.push({ planId: plan.id, symbol: plan.symbol, outcome: 'skipped', reason });
        log.warn(`${plan.symbol} 方案 #${plan.id} 未执行：${reason}`);
        continue;
      }

      // 已有未终结的保护就不开新仓（条件单保护的是整个净仓位）。
      if ((await deps.hasUnsettledBracket?.(plan.symbol)) === true) {
        skipped += 1;
        const reason = '该标的已有未终结的止盈止损，不再开新仓（条件单保护的是整个净仓位，重复挂会出现多组触发价）';
        details.push({ planId: plan.id, symbol: plan.symbol, outcome: 'skipped', reason });
        log.warn(`${plan.symbol} 方案 #${plan.id} 未执行：${reason}`);
        continue;
      }

      // 认领。**每次尝试一个新号**：Binance 不允许两张同号挂单同时存在，
      // 沿用同一个号重试必然撞「重复」。
      const attempt = plan.attempt + 1;
      const clientOrderId = agentEntryClientOrderId(plan.id, attempt);
      const claimed = await claimTradingPlan(deps.pool, {
        planId: plan.id,
        expectedAttempt: plan.attempt,
        clientOrderId,
        nowMs: now(),
      });
      if (!claimed) {
        // 不是故障：另一个执行器先认领了，或这一轮已经被人处理过。
        skipped += 1;
        details.push({
          planId: plan.id,
          symbol: plan.symbol,
          outcome: 'skipped',
          reason: '方案已被认领（别的执行器先到，或状态刚被别人改过），本轮跳过',
        });
        continue;
      }

      // 下单。这一步**不可回滚**。
      let orderId: number;
      try {
        const placed = await deps.placer.placeMarketOrder({
          symbol: plan.symbol,
          side: plan.side as 'BUY' | 'SELL',
          quantity: plan.quantity as number,
          clientOrderId,
        });
        orderId = placed.orderId;
      } catch (error) {
        // 下单失败**必须留痕**：方案记 `failed` + 原因，并推一条告警。
        // 仓位没有建立、止损也不会挂——这是需要人知道的事。
        const reason = reasonOf(error);
        failed += 1;
        details.push({ planId: plan.id, symbol: plan.symbol, outcome: 'failed', reason });
        try {
          await markTradingPlanExecutionFailed(deps.pool, {
            planId: plan.id,
            reason,
            nowMs: now(),
          });
        } catch (markError) {
          log.error(`${plan.symbol} 方案 #${plan.id} 记失败时又出错：${reasonOf(markError)}`);
        }
        log.error(`${plan.symbol} 方案 #${plan.id} 下单失败：${reason}`);
        await pushAlert('agent-plan-failed', () => ({
          fingerprint: `agent-plan-failed|${plan.symbol}|${plan.id}`,
          category: 'error',
          severity: 'critical',
          oneShot: true,
          title: `${plan.symbol} Agent 方案下单失败`,
          lines: [
            `方案 #${plan.id}`,
            `方向 ${plan.side}，数量 ${String(plan.quantity)}`,
            `原因：${reason}`,
            '仓位没有建立，止损也没有挂——需要人工确认。',
          ],
        }));
        continue;
      }

      // 回填单号。**这一步失败很严重**：单已经下了，而库里没有单号。
      try {
        await markTradingPlanExecuted(deps.pool, {
          planId: plan.id,
          entryOrderId: String(orderId),
          nowMs: now(),
        });
      } catch (error) {
        // 不静默：方案停在 `executing`，下一轮会被报成「状态未知」。
        log.error(
          `${plan.symbol} 方案 #${plan.id} 的单已经下了（单号 ${String(orderId)}），` +
            `但回填失败：${reasonOf(error)}。方案会停在「执行中」，需要人工确认。`,
        );
      }

      executed += 1;
      opened += 1;
      details.push({
        planId: plan.id,
        symbol: plan.symbol,
        outcome: 'executed',
        reason: '已按方案下出市价进场单',
        entryOrderId: String(orderId),
      });
      log.info(
        `${plan.symbol} 方案 #${plan.id} 已执行：${plan.side} ${String(plan.quantity)}，` +
          `单号 ${String(orderId)}，自定义号 ${clientOrderId}`,
      );
      await pushAlert('agent-plan-executed', () => ({
        fingerprint: `agent-plan-executed|${plan.symbol}|${plan.id}`,
        category: 'trade',
        severity: 'info',
        oneShot: true,
        title: `${plan.symbol} Agent 方案已下单`,
        lines: [
          `方案 #${plan.id}`,
          `方向 ${plan.side}，数量 ${String(plan.quantity)}`,
          `止损 ${String(plan.stopPrice)}，止盈 ${String(plan.takeProfitPrice)}`,
          `订单号：入场 ${String(orderId)}`,
        ],
      }));
    }

    return { executed, skipped, failed, stuck: stuck.length, details };
  }

  return { runOnce };
}

/**
 * 从一笔成交反查它是不是按 Agent 方案下的，并取出该用的档位。
 *
 * **靠自定义号认，不靠单号**：成交事件带的是 `clientOrderId`
 * （`agt-p<方案id>-a<次数>`），从那里能直接拿到方案 id。
 * 用「回填进库的 `entry_order_id`」反查则多一个依赖——回填失败时那一单
 * 明明已经真实存在，却认不出来，于是挂单时用了配置档位而不是方案档位，
 * 而人批准的是方案。
 *
 * 返回 `null` = 这笔成交**不是**按 Agent 方案下的（用户自己在交易所下的单、
 * 或者是本仓库 v0.4.0 之前那些手工开的仓），走配置档位或模型决策。
 */
export async function resolveAgentPlanDecision(
  pool: Pool,
  exchange: string,
  input: { symbol: string; clientOrderId: string },
): Promise<AgentPlanDecision | null> {
  const parsed = parseAgentEntryClientOrderId(input.clientOrderId);
  if (parsed === null) return null;

  const plan = await readTradingPlanById(pool, exchange, input.symbol, parsed.planId);
  if (plan === null) {
    // 自定义号是我们格式，但库里没有这份方案。
    // 这说明方案被删了或库被换过——**不能静默当成「没方案」**，
    // 否则挂单会悄悄用配置档位，而人批准的是别的东西。
    log.error(
      `成交 ${input.clientOrderId} 认出来是 Agent 方案 #${parsed.planId} 的进场单，` +
        `但库里没有这份方案（${input.symbol}）`,
    );
    return null;
  }
  if (plan.stopAtrMult === null || plan.takeProfitAtrMult === null) {
    log.error(
      `Agent 方案 #${plan.id}（${input.symbol}）没有 ATR 倍数，` +
        `无法用它挂止损止盈：${plan.rationale}`,
    );
    return null;
  }
  return {
    planId: plan.id,
    stopAtrMult: plan.stopAtrMult,
    takeProfitAtrMult: plan.takeProfitAtrMult,
    rationale: plan.rationale,
  };
}

/**
 * 方案执行的周期任务（v1.0.0）。
 *
 * **与对账定时器、移动止损定时器分开**（与 §6.8 同一条理由）：
 * 对账是纯只读的，而这里**要下单**。合成一个定时器会让「对账绝不动手」失守。
 *
 * 三条边界：
 *   1. **启动立刻跑一次**。executor 常常是在方案已经批准之后才启动的
 *      （或者重启后错过的），等一个周期才执行等于让用户白等。
 *   2. **本轮失败绝不影响挂单**。它失败不该让止盈止损也停。
 *   3. **防重入**：上一轮还没跑完就跳过这一轮——两轮同时认领同一份方案
 *      虽然有幂等锚点挡着，但那是最后一道保险，不该 routinely 靠它。
 */
export interface StartPlanExecutionOptions {
  setIntervalImpl?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalImpl?: (handle: NodeJS.Timeout) => void;
}

export interface PlanExecutionTimer {
  /** 停止定时器。**退出时必须调用**，否则进程不会结束。 */
  stop(): void;
}

/**
 * 启动方案执行周期任务。
 *
 * `intervalMs = 0` 表示**关闭自动执行**，返回空实现——
 * 这正是「默认只出方案、不下单」的实现方式（开关关着时压根不建这个任务）。
 */
export function startPlanExecutionTimer(
  executor: Pick<PlanExecutor, 'runOnce'>,
  intervalMs: number,
  options: StartPlanExecutionOptions = {},
): PlanExecutionTimer {
  if (intervalMs === 0) {
    log.info('agent.execute.enabled = false：自动下单已关闭，方案只落库');
    return { stop: () => undefined };
  }

  const setIntervalImpl =
    options.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms) as unknown as NodeJS.Timeout);
  const clearIntervalImpl =
    options.clearIntervalImpl ?? ((handle) => clearInterval(handle as unknown as number));

  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    void executor
      .runOnce()
      .then((report: PlanExecutionReport) => {
        if (report.executed > 0 || report.failed > 0 || report.stuck > 0) {
          log.info(
            `方案执行一轮：已下单 ${report.executed} / 跳过 ${report.skipped} / ` +
              `失败 ${report.failed} / 状态未知 ${report.stuck}`,
          );
        }
      })
      .catch((error: unknown) => {
        log.error(
          `方案执行本轮失败（不影响挂单）：${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        running = false;
      });
  };

  tick();
  const handle = setIntervalImpl(tick, intervalMs);
  log.info(`自动下单已启用：每 ${String(intervalMs / 1000)} 秒检查一次已批准的方案`);

  return {
    stop(): void {
      clearIntervalImpl(handle);
    },
  };
}
