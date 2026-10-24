/**
 * 交易员 Agent 的契约与纯函数（v1.0.0）。
 *
 * ## 它回答什么问题
 *
 * 「既然值得做，**怎么做**。」——进场方式、仓位多大、止损放哪。
 *
 * ## 一条铁律：模型只提**比例**，钱和价格由程序算
 *
 * 模型能说的只有三样：
 *
 * | 模型说的        | 程序算出来的                     |
 * | --------------- | -------------------------------- |
 * | 方向（多/空/不做） | —                            |
 * | 进场方式与偏移   | **进场价**（对齐到最小价格变动）  |
 * | 风险比例         | **数量、名义金额、实际亏损金额**  |
 * | 止损 / 止盈倍数  | **止损价 / 止盈价**（对齐到 tick）|
 *
 * 为什么不让模型直接说「买 0.35 个 BTC、止损 61000」：
 *
 * 1. **模型算错数量不报错。** 它说「买 0.35 个」完全可能是在算 3.5 个——数量算错
 *    一个数量级，亏损金额也跟着错一个数量级，而**没有任何一处会报错**。
 *    比例（拿权益的百分之几去冒险）出错时，程序算出来的绝对金额仍然是可控的。
 * 2. **价格必须落在 tick 网格上。** 交易所只接受对齐后的价格与数量，
 *    而「对齐」有方向（见 `alignToTick`）：止损往入场价方向挪半个 tick，
 *    实际止损距离就比 ATR 算出来的更近。模型不知道 tick 的存在。
 * 3. **止损/止盈价必须与真正挂出去的那张单逐字一致。** 这里用
 *    {@link deriveBracketPlan}；`apps/executor` 挂单走的是 `deriveStagedPlan`——
 *    **两个不同的函数**，但算式与 tick 对齐方向**逐字相同**
 *    （`deriveStagedPlan` 明确「止损的算式完全复用 v0.4.0 的口径」，而 v0.4.0 的口径
 *    就是 `deriveBracketPlan`；两者对齐方向也相同：多头向下、空头向上）。
 *    于是「方案上写的止损价」与「交易所上挂的止损价」不可能差一个 tick——
 *    这条由 `packages/core/tests/risk-policy.test.ts` 里的断言担保，不靠注释。
 *
 * ## 方向与分析师结论的关系
 *
 * 交易员**不能**与分析师的结论对着干：
 *
 * | 分析师结论 | 允许的方向                | 处置                          |
 * | ---------- | ------------------------- | ----------------------------- |
 * | 看多       | 做多 / 不做              | 做空 → **拒绝出方案**          |
 * | 看空       | 做空 / 不做              | 做多 → **拒绝出方案**          |
 * | 中性       | 做多 / 做空 / 不做       | 允许，但**风险敞口减半**       |
 *
 * 「中性」不等于「不许做」：它说的是「没有明确倾向」，而交易员看的是同一份数据里
 * 更具体的形态。但没有方向性确认时，仓位就该小——所以风险上限按
 * `neutralRiskFactor` 打折（缺省一半）。
 *
 * 反过来「看多却做空」是**真矛盾**：两个 Agent 读同一份数据得出相反的结论，
 * 出方案等于把矛盾变成真钱。这时**不出方案**，并把矛盾写进失败原因里。
 *
 * ## 越界怎么处置：夹住还是拒绝
 *
 * 两者都有，界线是「夹住是否仍然安全」：
 *
 * - **风险比例超上限** → **夹到上限**。往下夹只会更安全，方案仍然可用。
 * - **盈亏比不达标** → **抬高止盈倍数**到达标。往上抬止盈只会更保守。
 * - **名义金额超上限** → **按上限缩量**。缩量只会更安全。
 * - **算出来的数量低于交易所最小下单量** → **拒绝**。这没法夹：
 *   「买 0.0001 个 BTC」不是一笔小单，是一笔**不存在的单**。
 *
 * 每一处夹住都会记进 `adjustments`，落库、页面、CLI 都看得见——
 * 约定 9 忌讳的是「静默兜底」，不是「兜底本身」（AGENTS.md 约定 9）。
 */

import { z } from 'zod';

import { deriveBracketPlan, alignToTick, alignToQty } from './risk-policy.js';
import { SyncError } from './market-sync.js';
import type { AnalystVerdict, Stance } from './agent-analyst.js';

/** 交易员模型给出的**提议**。注意它没有数量、没有价格——那些由程序算。 */
export interface TraderProposal {
  /** 方向。`NONE` = 这一轮不做。 */
  side: 'BUY' | 'SELL' | 'NONE';
  /** 进场方式。`market` = 市价，`limit` = 限价（挂在回调价上）。 */
  entryType: 'market' | 'limit';
  /**
   * 限价单挂在现价多远（ATR 倍数）。`0` = 挂在现价。
   *
   * 只对 `limit` 有意义：`market` 时它被忽略。
   */
  entryOffsetAtrMult: number;
  /** 本笔愿意亏掉权益的多大比例（如 `0.01` = 1%）。 */
  riskFraction: number;
  /** 止损距离（ATR 倍数）。 */
  stopAtrMult: number;
  /** 止盈距离（ATR 倍数）。 */
  takeProfitAtrMult: number;
  /** 理由。 */
  rationale: string;
}

/**
 * 提议的 schema。
 *
 * `riskFraction` 上界 5%：模型说要冒 5% 的险已经离谱，但**这一层不负责拒绝**——
 * 真正的闸门是 `limits.maxRiskFraction`（配置），越界由
 * {@link deriveExecutionPlan} 夹住并记录。
 */
export const traderProposalSchema = z.object({
  side: z.enum(['BUY', 'SELL', 'NONE']),
  entryType: z.enum(['market', 'limit']).default('market'),
  entryOffsetAtrMult: z.number().min(0).max(5).default(0),
  riskFraction: z.number().min(0).max(0.05),
  stopAtrMult: z.number().positive().max(20),
  takeProfitAtrMult: z.number().positive().max(50),
  rationale: z.string().min(1).max(2_000),
});

/** 风控上限。全部由配置给，不由模型给。 */
export interface ExecutionLimits {
  /** 单笔最大风险占权益的比例（如 `0.01` = 1%）。 */
  maxRiskFraction: number;
  /** 单笔最大名义金额（计价币）。`0` = 不限。 */
  maxNotional: number;
  /** 最小盈亏比。低于它就抬高止盈倍数。 */
  minRiskReward: number;
  /**
   * 中性结论时风险敞口的打折系数（缺省 0.5 = 减半）。
   *
   * 必须是 `(0, 1]`：`0` 等于「中性时一笔都不许做」，那是另一种设计（用配置关掉）。
   */
  neutralRiskFactor: number;
}

/** 执行方案：**进场、仓位、止损**三件事的完整答案。 */
export type ExecutionPlan =
  | {
      action: 'hold';
      symbol: string;
      /** 为什么这一轮不做。 */
      rationale: string;
      /** 分析师的结论，供展示与留痕。 */
      stance: Stance;
      /** 分析师的信心。 */
      confidence: number;
      /** 参照用的 ATR（不下单，但页面要显示「波动有多大」）。 */
      atr: number;
    }
  | {
      action: 'enter';
      symbol: string;
      /** 进场方向。`BUY` = 开多，`SELL` = 开空。 */
      side: 'BUY' | 'SELL';
      entryType: 'market' | 'limit';
      /** 进场价（已对齐到最小价格变动）。 */
      entryPrice: number;
      /** 止损价（已对齐）。 */
      stopPrice: number;
      /** 止盈价（已对齐）。 */
      takeProfitPrice: number;
      /** 数量（已对齐到最小下单数量步长）。 */
      quantity: number;
      /** 名义金额 = 数量 × 进场价。 */
      notional: number;
      /** 这笔最多亏多少（计价币）= 数量 × 止损距离。 */
      riskAmount: number;
      /** 账户权益。 */
      equity: number;
      /** 实际用掉的风险比例。 */
      riskFraction: number;
      /** ATR。 */
      atr: number;
      /** 止损 ATR 倍数（可能被抬高过）。 */
      stopAtrMult: number;
      /** 止盈 ATR 倍数（可能被抬高过）。 */
      takeProfitAtrMult: number;
      /** 盈亏比。 */
      riskReward: number;
      /** 分析师的结论。 */
      stance: Stance;
      /** 分析师的信心。 */
      confidence: number;
      /** 理由。 */
      rationale: string;
      /** 方案与分析师结论的关系。 */
      stanceAlignment: 'aligned' | 'neutral';
      /**
       * 为了合规而做的调整，逐条写清楚。
       *
       * 空数组 = 原样采纳了模型的提议。**非空时页面必须显示**——
       * 「模型说要冒 3% 的险，程序把它夹到了 1%」这件事，人得知道。
       */
      adjustments: string[];
    };

/** {@link deriveExecutionPlan} 的输入。全部是**已经取到的数**，不含任何 IO。 */
export interface ExecutionPlanInput {
  symbol: string;
  /** 分析师的结论。方案的方向必须与它不矛盾。 */
  verdict: AnalystVerdict;
  /** 交易员模型给的提议。 */
  proposal: TraderProposal;
  /** 账户权益（计价币）。 */
  equity: number;
  /** 最新价。 */
  lastPrice: number;
  /** ATR。必须为正。 */
  atr: number;
  atrPeriod: number;
  /** 最小价格变动。 */
  tickSize: number;
  /** 最小下单数量步长。 */
  stepSize: number;
  /** 最小下单数量。 */
  minQty: number;
  /** 风控上限。 */
  limits: ExecutionLimits;
}

/**
 * 从提议算出执行方案。**纯函数**：同样的输入永远给出同样的方案
 * （AGENTS.md 约定 4）。这份输出会变成真实的下单指令，因此不做任何隐式兜底——
 * 算不出来就报错。
 *
 * @throws SyncError 'AGENT_PLAN_INVALID' 方向与分析师结论矛盾、算出的数量低于
 *         交易所最小下单量、或输入本身不合法。
 */
export function deriveExecutionPlan(input: ExecutionPlanInput): ExecutionPlan {
  const { symbol, verdict, proposal, equity, lastPrice, atr, tickSize, stepSize, minQty, limits } =
    input;

  if (!Number.isFinite(equity) || equity <= 0) {
    throw new SyncError('AGENT_PLAN_INVALID', `账户权益必须为正（收到 ${String(equity)}）`, {
      equity,
    });
  }
  if (!Number.isFinite(lastPrice) || lastPrice <= 0) {
    throw new SyncError('AGENT_PLAN_INVALID', `最新价必须为正（收到 ${String(lastPrice)}）`, {
      lastPrice,
    });
  }
  if (!Number.isFinite(atr) || atr <= 0) {
    throw new SyncError(
      'AGENT_PLAN_INVALID',
      `ATR 必须为正（收到 ${String(atr)}）：ATR=0 会让止损正好落在进场价上`,
      { atr },
    );
  }

  const adjustments: string[] = [];

  // 方向与分析师结论的一致性。
  const alignment = checkSideAlignment(verdict.stance, proposal.side);
  if (alignment === 'contradicts') {
    throw new SyncError(
      'AGENT_PLAN_INVALID',
      `分析师的结论是${stanceLabel(verdict.stance)}，方案却是${sideLabel(proposal.side)}：` +
        `方向矛盾，不出方案`,
      { stance: verdict.stance, side: proposal.side },
    );
  }

  // 这一轮不做。
  if (proposal.side === 'NONE') {
    return {
      action: 'hold',
      symbol,
      rationale: proposal.rationale,
      stance: verdict.stance,
      confidence: verdict.confidence,
      atr,
    };
  }

  const isLong = proposal.side === 'BUY';

  // 风险比例：先按中性结论打折，再夹到上限。
  const neutralFactor = verdict.stance === 'neutral' ? limits.neutralRiskFactor : 1;
  let riskFraction = proposal.riskFraction * neutralFactor;
  if (neutralFactor !== 1) {
    adjustments.push(
      `分析师结论为中性，风险敞口按 ${neutralFactor} 打折：` +
        `${proposal.riskFraction.toFixed(4)} → ${riskFraction.toFixed(4)}`,
    );
  }
  if (riskFraction > limits.maxRiskFraction) {
    adjustments.push(
      `风险比例超过上限 ${limits.maxRiskFraction.toFixed(4)}，夹到上限：` +
        `${riskFraction.toFixed(4)} → ${limits.maxRiskFraction.toFixed(4)}`,
    );
    riskFraction = limits.maxRiskFraction;
  }

  // 进场价：限价单挂在回调方向；市价单按现价并向保守一侧对齐。
  const entryPrice =
    proposal.entryType === 'limit' && proposal.entryOffsetAtrMult > 0
      ? alignToTick(
          isLong
            ? lastPrice - proposal.entryOffsetAtrMult * atr
            : lastPrice + proposal.entryOffsetAtrMult * atr,
          tickSize,
          isLong ? 'down' : 'up',
        )
      : alignToTick(lastPrice, tickSize, isLong ? 'down' : 'up');

  // 止损与止盈：用 deriveBracketPlan。executor 挂单走 deriveStagedPlan——
  // 两个函数，但算式与对齐方向逐字相同（见文件头第 3 条），
  // 于是「方案上的止损价」与「交易所上的止损价」不会差一个 tick。
  let stopAtrMult = proposal.stopAtrMult;
  let takeProfitAtrMult = proposal.takeProfitAtrMult;
  let bracket = deriveBracketPlan({
    side: proposal.side,
    entryPrice,
    atr,
    tickSize,
    stopAtrMult,
    takeProfitAtrMult,
    atrPeriod: input.atrPeriod,
  });

  // 盈亏比不达标 → 抬高止盈倍数。往上抬止盈只会更保守，因此夹住而不是拒绝。
  if (bracket.riskReward < limits.minRiskReward) {
    const before = takeProfitAtrMult;
    // 需要的止盈距离 = 止损距离 × 最小盈亏比，换算成 ATR 倍数后向上取整到 0.1。
    const needed = (bracket.stopDistance * limits.minRiskReward) / atr;
    takeProfitAtrMult = Math.ceil(needed * 10) / 10;
    if (takeProfitAtrMult <= before) {
      // 理论上不会发生（needed 一定大于 before），但守住：夹不动就报错，
      // 不能悄悄出一个不达标的方案。
      throw new SyncError(
        'AGENT_PLAN_INVALID',
        `盈亏比 ${bracket.riskReward.toFixed(2)} 低于下限 ${limits.minRiskReward.toFixed(2)}，` +
          `且无法通过抬高止盈倍数达标`,
        { riskReward: bracket.riskReward, minRiskReward: limits.minRiskReward },
      );
    }
    bracket = deriveBracketPlan({
      side: proposal.side,
      entryPrice,
      atr,
      tickSize,
      stopAtrMult,
      takeProfitAtrMult,
      atrPeriod: input.atrPeriod,
    });
    adjustments.push(
      `盈亏比 ${bracket.riskReward.toFixed(2)} 低于下限 ${limits.minRiskReward.toFixed(2)}，` +
        `止盈倍数由 ${before} 抬到 ${takeProfitAtrMult}`,
    );
  }

  // 数量：由「愿意亏多少钱 ÷ 每单位亏多少」算出。**模型不参与这一步。**
  const riskAmount = equity * riskFraction;
  const rawQty = riskAmount / bracket.stopDistance;
  let quantity = alignToQty(rawQty, stepSize, 'down');

  // 名义金额超上限 → 按上限缩量。缩量只会更安全。
  if (limits.maxNotional > 0) {
    const maxQty = alignToQty(limits.maxNotional / entryPrice, stepSize, 'down');
    if (quantity > maxQty) {
      adjustments.push(
        `名义金额超过上限 ${limits.maxNotional}，按上限缩量：` + `${quantity} → ${maxQty}`,
      );
      quantity = maxQty;
    }
  }

  if (quantity < minQty) {
    throw new SyncError(
      'AGENT_PLAN_INVALID',
      `按权益 ${equity}、风险比例 ${riskFraction.toFixed(4)}、止损距离 ${bracket.stopDistance} ` +
        `算出的数量 ${quantity} 低于交易所最小下单量 ${minQty}：` +
        `这一笔没法开，不出方案`,
      {
        equity,
        riskFraction,
        stopDistance: bracket.stopDistance,
        quantity,
        minQty,
      },
    );
  }

  const notional = quantity * entryPrice;
  const actualRisk = quantity * bracket.stopDistance;

  return {
    action: 'enter',
    symbol,
    side: proposal.side,
    entryType: proposal.entryType,
    entryPrice,
    stopPrice: bracket.stopPrice,
    takeProfitPrice: bracket.takeProfitPrice,
    quantity,
    notional,
    riskAmount: actualRisk,
    equity,
    riskFraction: actualRisk / equity,
    atr,
    stopAtrMult,
    takeProfitAtrMult,
    riskReward: bracket.riskReward,
    stance: verdict.stance,
    confidence: verdict.confidence,
    rationale: proposal.rationale,
    stanceAlignment: alignment,
    adjustments,
  };
}

/**
 * 方向与分析师结论是否矛盾。
 *
 * `contradicts` = 分析师看多而方案做空（或反之）。`neutral` = 分析师没明确倾向，
 * 两个方向都不算矛盾。
 */
export type StanceAlignment = 'aligned' | 'contradicts' | 'neutral';

export function checkSideAlignment(stance: Stance, side: 'BUY' | 'SELL' | 'NONE'): StanceAlignment {
  if (side === 'NONE') return 'aligned';
  if (stance === 'neutral') return 'neutral';
  const wantsLong = stance === 'bullish';
  const isLong = side === 'BUY';
  return wantsLong === isLong ? 'aligned' : 'contradicts';
}

/** 立场的中文名。 */
export function stanceLabel(stance: Stance): string {
  if (stance === 'bullish') return '看多';
  if (stance === 'bearish') return '看空';
  return '中性';
}

/** 方向的中文名。 */
export function sideLabel(side: 'BUY' | 'SELL' | 'NONE'): string {
  if (side === 'BUY') return '做多';
  if (side === 'SELL') return '做空';
  return '不做';
}

/**
 * 从模型的原始输出里解析出提议。
 *
 * 与 `parseLlmDecision` 同一套规矩：接受纯 JSON 与带 ``` 围栏的 JSON，
 * **不**从散文里正则抠数字；失败一律抛 `AGENT_PLAN_INVALID`，不返回默认值。
 */
export function parseTraderProposal(raw: string): TraderProposal {
  const text = stripFence(raw).trim();
  if (text === '') {
    throw new SyncError('AGENT_PLAN_INVALID', '模型返回了空内容，没有可解析的执行提议', {
      rawLength: raw.length,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SyncError(
      'AGENT_PLAN_INVALID',
      `模型返回的不是合法 JSON：${(error as Error).message}`,
      { raw: text.slice(0, 500) },
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SyncError('AGENT_PLAN_INVALID', '模型返回的 JSON 不是一个对象', {
      raw: text.slice(0, 500),
    });
  }
  const result = traderProposalSchema.safeParse(parsed);
  if (!result.success) {
    throw new SyncError(
      'AGENT_PLAN_INVALID',
      `模型返回的执行提议越界或不完整：${result.error.issues
        .map((i) => `${i.path.join('.') || '(根)'}：${i.message}`)
        .join('；')}`,
      { issues: result.error.issues },
    );
  }
  return result.data;
}

/** 去掉 markdown 代码围栏。规则与 `agent-analyst.ts` 的同名函数一致。 */
function stripFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  if (match === null) return trimmed;
  return match[1] ?? trimmed;
}

// ---------------------------------------------------------------------------
// 提示词
// ---------------------------------------------------------------------------

/** 构造交易员提示词所需的上下文。全部是**已取到的数**，不含任何 IO。 */
export interface TraderPromptContext {
  symbol: string;
  /** 分析师的结论（把三个面与理由一并给模型看）。 */
  verdict: AnalystVerdict;
  /** 账户权益。 */
  equity: number;
  /** 最新价。 */
  lastPrice: number;
  /** ATR。 */
  atr: number;
  atrPeriod: number;
  /** 最小价格变动。 */
  tickSize: number;
  /** 最小下单数量步长与下限。 */
  stepSize: number;
  minQty: number;
  /** 风控上限。 */
  limits: ExecutionLimits;
  /** 当前生效的档位，作为参考基准。 */
  baseline: { stopAtrMult: number; takeProfitAtrMult: number };
}

/**
 * 把**比例**说成**百分比**（`0.01` → `"1%"`）。
 *
 * ## 为什么不能直接把两个数拼在一起
 *
 * 提示词里同一个数有两种写法就会歧义，而这里出过一次**真错**：
 * 原来的模板是 `${maxRiskFraction}` 后面接 `${maxRiskFraction * 100}%`——
 * `0.01` 于是拼成了 **「0.011%」**。那句话本意是「1% 的上限」，
 * 读出来却变成「0.011% 的上限」，**小了 100 倍**。
 *
 * 后果不是「模型看错一个字」：模型会照着 0.011% 去提 `riskFraction`，
 * 而那个值在 schema 的合法区间里，程序**不会夹它**（夹的是 0.01 的上限，不是 0.00011），
 * 于是仓位只有该有的百分之一，而日志上一切正常。
 * 「超过会被夹住」那句还给了它虚假的安全感——**看起来有护栏，其实护栏在另一个刻度上**。
 *
 * 所以这里把比例与百分比**都写出来**，并且只用这一处换算。
 */
function percentText(fraction: number): string {
  // 先保留 4 位小数再转成 number：0.011 * 100 = 1.0999999999999999 这种浮点尾巴
  // 不去掉的话，提示词里就会出现「1.0999999999999999%」。
  const percent = Number((fraction * 100).toFixed(4));
  return `${String(percent)}%`;
}

/**
 * 构造给模型看的提示词。
 *
 * **纯函数**（AGENTS.md 约定 4）。提示词里**不出现**密钥。
 *
 * 关键是把「每个输出会被怎么用」讲清楚：
 *
 * - `riskFraction` 会被程序换算成**真实的下单数量**——它说 1% 就是真的拿 1% 的
 *   权益去冒险，因此**必须**落在上限之内。
 * - `stopAtrMult` / `takeProfitAtrMult` 会变成**真实的止损价与止盈价**。
 * - **不许输出数量与价格**——程序会算，而且算得比模型准（它知道 tick 与最小下单量）。
 */
export function buildTraderPrompt(context: TraderPromptContext): string {
  const v = context.verdict;
  const lines: string[] = [
    '你是一个加密货币永续合约的**交易员**。分析师已经给出了一个标的的分析结论，' +
      '你的任务是把它变成一份**可执行的方案**：进场方式、仓位大小、止损止盈。',
    '',
    '## 你要输出的内容',
    '',
    '严格输出一个 JSON 对象，且**只**输出这个对象（不要加任何解释性文字）：',
    JSON.stringify(
      {
        side: '字符串。BUY = 做多，SELL = 做空，NONE = 这一轮不做',
        entryType: '字符串。market = 市价进场，limit = 限价挂在回调价上',
        entryOffsetAtrMult:
          '数字。限价单挂在现价多远（ATR 倍数），取值 [0, 5]。' +
          'entryType=market 时填 0。回调进场比追价更容易拿到好价',
        riskFraction:
          '数字。**比例**（不是百分数），本笔愿意亏掉权益的多大比例，取值 (0, 上限]。' +
          '0.01 = 拿 1% 的权益去冒险——要 1% 就填 0.01，不要填 1。' +
          '**这个数会被换算成真实的下单数量**',
        stopAtrMult: '数字。止损距离（ATR 倍数），取值 (0, 20]',
        takeProfitAtrMult: '数字。止盈距离（ATR 倍数），取值 (0, 50]',
        rationale: '字符串。3 到 6 句，说明这个方案的依据',
      },
      null,
      2,
    ),
    '',
    '## 硬性要求',
    '',
    '- **只输出 JSON**，不要加 markdown 代码块标记。',
    '- **不要输出数量、价格、金额**——这些由系统按风控上限算出来，算得比你准' +
      '（它知道最小价格变动与最小下单量）。',
    `- 风险比例不得超过 ${String(context.limits.maxRiskFraction)}` +
      `（即 ${percentText(context.limits.maxRiskFraction)}）。` +
      '超过会被夹住，但仍按你的意图说明理由。',
    '- **止损与止盈的 ATR 倍数会被直接用掉**：它们决定真实的止损价与止盈价。' +
      '止损倍数太小会被市场噪音扫掉，太大则单笔亏损失控。',
    '',
    '## 分析师的结论',
    '',
    `标的：${context.symbol}`,
    `总立场：${stanceLabel(v.stance)}（这是按三个面加权算出来的，请与它保持一致）`,
    `信心：${String(v.confidence)}（一致性 ${String(v.agreement)}）`,
    `技术面：${String(v.facets.technical.score)}`,
    ...v.facets.technical.notes.map((n) => `  - ${n}`),
    `情绪面：${String(v.facets.sentiment.score)}`,
    ...v.facets.sentiment.notes.map((n) => `  - ${n}`),
    `基本面：${String(v.facets.fundamental.score)}`,
    ...v.facets.fundamental.notes.map((n) => `  - ${n}`),
    `分析师的理由：${v.rationale}`,
    '',
    '## 账户与市场',
    '',
    `账户权益：${String(context.equity)}`,
    `最新价：${String(context.lastPrice)}`,
    `ATR(${String(context.atrPeriod)})：${String(context.atr)}`,
    `最小价格变动：${String(context.tickSize)}　最小下单数量：${String(context.stepSize)}（下限 ${String(context.minQty)}）`,
    `单笔最大名义金额：${context.limits.maxNotional > 0 ? String(context.limits.maxNotional) : '不限'}`,
    `最小盈亏比：${String(context.limits.minRiskReward)}`,
    '',
    '## 当前生效的档位（可作参考，但你要给出自己的判断）',
    '',
    `止损倍数：${String(context.baseline.stopAtrMult)}`,
    `止盈倍数：${String(context.baseline.takeProfitAtrMult)}`,
  ];
  return lines.join('\n');
}
