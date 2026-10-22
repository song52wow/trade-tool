/**
 * 分析师 Agent 的契约与纯函数（v1.0.0）。
 *
 * ## 它回答什么问题
 *
 * 「这个标的现在**值不值得碰**，以及**凭什么**。」
 *
 * 分析师看三个面：**技术面**（价格结构与指标）、**情绪面**（持仓者的钱往哪边压）、
 * **基本面**（合约规格、流动性、持有成本）。三个面各给一个分数与理由，
 * 合成的**总立场**由本模块的纯函数算出，不��模型自己下结论。
 *
 * ## 三条不可协商的边界
 *
 * 1. **模型不输出价格。** 报告里只有分数、理由与 ATR 倍数。止损价、止盈价
 *    由 `deriveExecutionPlan`（[`agent-trader.ts`](./agent-trader.ts)）按 ATR 算，
 *    再对齐到标的的最小价格变动。理由与 v0.9.0 的止盈止损决策同源：
 *    价格必须是可复现的纯函数产物，不能是模型的一次输出（AGENTS.md 约定 4）。
 * 2. **模型不输出仓位。** 分析师只说「多空倾向 + 该放多少止损空间」，
 *    钱的事留给交易员 Agent，且**由程序算**（见 `agent-trader.ts`）。
 * 3. **总立场由程序算。** 模型给三个面的分数，程序按权重合成 stance 与 confidence。
 *    否则「报告里写着看多、落库的立场却是看空」这类漂移无从查起——
 *    判据只有一份实现（AGENTS.md §6.1 第 1 条）。
 *
 * ## 为什么分数是 [-1, 1] 而不是「看多/看空/观望」
 *
 * 三档标签会丢掉强度信息：同样是「看多」，-0.2 与 +0.9 对仓位的影响差一个量级。
 * 分数让权重可调、让 confidence 有意义，也让「三个面互相矛盾」这件事能被算出来
 * （见 {@link aggregateAnalystReport} 的一致性因子）。
 *
 * ## 一致性为什么会被折进 confidence
 *
 * 技术面看多、情绪面看空、基本面中性——这种时候模型的 confidence 再高也不该被采信。
 * 所以合成时把**面与面之间的一致程度**乘进 confidence：三个面越一致，
 * 结论越可信。判据在本模块，只有一份。
 */

import { z } from 'zod';

import { SyncError } from './market-sync.js';

/**
 * 分析师看的三个面。**顺序固定**，因为权重与提示词都按这个次序呈现，
 * 键序漂移会让「两次运行逐字相同」这条幂等断言假失败。
 */
export const ANALYST_FACETS = ['technical', 'sentiment', 'fundamental'] as const;

/** 三个面之一。 */
export type AnalystFacet = (typeof ANALYST_FACETS)[number];

/** 总立场。`neutral` 不是「没意见」，而是「三个面互相抵消，或都不强」。 */
export type Stance = 'bullish' | 'bearish' | 'neutral';

/** 三个面的权重。权重不必和为 1——合成时会按总和归一。 */
export type AnalystWeights = Record<AnalystFacet, number>;

/** 一个面的判断。 */
export interface AnalystFacetView {
  /**
   * 该面的方向分，`-1`（极空）… `+1`（极多）。
   *
   * `0` 表示「这个面没有信息量」，不是「中性偏多」。
   */
  score: number;
  /** 支撑这个分数的理由。给人看，也是事后复核的凭据。 */
  notes: string[];
}

/**
 * 分析师报告（**模型产出的那一版**）。
 *
 * 注意它**没有** stance 字段：总立场由 {@link aggregateAnalystReport} 算。
 */
export interface AnalystReport {
  technical: AnalystFacetView;
  sentiment: AnalystFacetView;
  fundamental: AnalystFacetView;
  /** 模型自评的把握程度，`[0, 1]`。合成时会被一致性因子折减。 */
  confidence: number;
  /** 建议的止损距离（ATR 倍数）。价格由程序算。 */
  stopAtrMult: number;
  /** 建议的止盈距离（ATR 倍数）。价格由程序算。 */
  takeProfitAtrMult: number;
  /** 总体理由。 */
  rationale: string;
}

/** 单个面的 schema。分数有界，理由条数有上限——防止模型写一整页散文。 */
export const analystFacetSchema = z.object({
  score: z.number().min(-1).max(1),
  notes: z.array(z.string().min(1)).max(6),
});

/**
 * 整份报告的 schema。
 *
 * 倍数上界与 `llmDecisionSchema` 对齐（止损 ≤ 20、止盈 ≤ 50），
 * 因为这两份输出最终都变成**同一张保护单**上的两个价。
 */
export const analystReportSchema = z.object({
  technical: analystFacetSchema,
  sentiment: analystFacetSchema,
  fundamental: analystFacetSchema,
  confidence: z.number().min(0).max(1),
  stopAtrMult: z.number().positive().max(20),
  takeProfitAtrMult: z.number().positive().max(50),
  rationale: z.string().min(1).max(2_000),
});

/**
 * 合成后的结论。**这份才是落库与展示的那一份**——
 * 它由纯函数算出，因此「报告里写着看多、库里记的是看空」不可能发生。
 */
export interface AnalystVerdict {
  /** 总立场。 */
  stance: Stance;
  /** 折减后的信心，`[0, 1]`。 */
  confidence: number;
  /** 加权综合分，`[-1, 1]`。 */
  bias: number;
  /** 三个面的原始判断，原样保留。 */
  facets: Record<AnalystFacet, AnalystFacetView>;
  /** 建议的止损 ATR 倍数（模型给的，程序校验过范围）。 */
  stopAtrMult: number;
  /** 建议的止盈 ATR 倍数。 */
  takeProfitAtrMult: number;
  /** 总体理由。 */
  rationale: string;
  /** 一致性因子 `[0, 1]`：三个面之间有多一致。 */
  agreement: number;
}

/** 合成参数。 */
export interface AggregateOptions {
  /**
   * 「中性带」的宽度：综合分落在 `(-band, band)` 里就算 `neutral`。
   *
   * 缺省 0.2：综合分不到两成时，三个面基本在互相抵消，
   * 这时候硬给一个方向比给「观望」更危险。
   */
  neutralBand?: number;
}

/**
 * 把三个面的分数合成一个结论。**纯函数**：同样的输入永远给出同样的结论
 * （AGENTS.md 约定 4）。
 *
 * 合成式：
 *
 * ```
 * bias      = Σ(wᵢ × scoreᵢ) / Σwᵢ
 * agreement = 1 − Σ(wᵢ × |scoreᵢ − bias|) / Σwᵢ        （1 = 三个面完全一致）
 * confidence = 模型自评 confidence × agreement
 * stance    = bias ≥ band ? 看多 : bias ≤ −band ? 看空 : 中性
 * ```
 *
 * `agreement` 的直觉：三个面都在 0.8 附近 → 一致 → 1；一个 +0.8 两个 −0.8 →
 * 互相抵消 → 0。这种时候即便模型自评 confidence 很高，合成后的信心也会被压到 0，
 * 因为**互相矛盾的面本来就不该被当成高置信度结论**。
 *
 * @throws SyncError 'CONFIG_INVALID' 权重非正 / 中性带越界。
 */
export function aggregateAnalystReport(
  report: AnalystReport,
  weights: AnalystWeights,
  options: AggregateOptions = {},
): AnalystVerdict {
  const band = options.neutralBand ?? 0.2;
  if (!Number.isFinite(band) || band < 0 || band >= 1) {
    throw new SyncError('CONFIG_INVALID', `中性带必须在 [0, 1) 内（收到 ${String(band)}）`, {
      neutralBand: band,
    });
  }
  let weightSum = 0;
  for (const facet of ANALYST_FACETS) {
    const weight = weights[facet];
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new SyncError(
        'CONFIG_INVALID',
        `权重 ${facet} 必须为正（收到 ${String(weight)}）：权重为 0 等于关掉这个面，` +
          `而「关掉」与「没配」是两回事，前者要有话可说`,
        { facet, weight },
      );
    }
    weightSum += weight;
  }

  let bias = 0;
  for (const facet of ANALYST_FACETS) {
    bias += weights[facet] * report[facet].score;
  }
  bias /= weightSum;

  let dispersion = 0;
  for (const facet of ANALYST_FACETS) {
    dispersion += weights[facet] * Math.abs(report[facet].score - bias);
  }
  dispersion /= weightSum;
  const agreement = Math.max(0, 1 - dispersion);

  const stance: Stance = bias >= band ? 'bullish' : bias <= -band ? 'bearish' : 'neutral';
  const confidence = round4(report.confidence * agreement);

  return {
    stance,
    confidence,
    bias: round4(bias),
    agreement: round4(agreement),
    facets: {
      technical: report.technical,
      sentiment: report.sentiment,
      fundamental: report.fundamental,
    },
    stopAtrMult: report.stopAtrMult,
    takeProfitAtrMult: report.takeProfitAtrMult,
    rationale: report.rationale,
  };
}

/** 四位小数。够表达连续分数，又不会让落库的浮点尾数变成噪声。 */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * 从模型的原始输出里解析出一份报告。
 *
 * 接受纯 JSON 与带 ``` 围栏的 JSON 两种形态（聊天模型爱加代码块标记），
 * 但**只**容忍这一种修饰：不做「从散文里正则抠分数」那种宽松解析——
 * 那会让一段模型胡话变成一份看起来合法的报告，而它会变成真实的下单依据。
 *
 * 解析失败一律抛 `AGENT_REPORT_INVALID`，**不返回默认值**（AGENTS.md 约定 9）。
 */
export function parseAnalystReport(raw: string): AnalystReport {
  const text = stripFence(raw).trim();
  if (text === '') {
    throw new SyncError('AGENT_REPORT_INVALID', '模型返回了空内容，没有可解析的分析报告', {
      rawLength: raw.length,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SyncError(
      'AGENT_REPORT_INVALID',
      `模型返回的不是合法 JSON：${(error as Error).message}`,
      { raw: text.slice(0, 500) },
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SyncError('AGENT_REPORT_INVALID', '模型返回的 JSON 不是一个对象', {
      raw: text.slice(0, 500),
    });
  }
  const result = analystReportSchema.safeParse(parsed);
  if (!result.success) {
    throw new SyncError(
      'AGENT_REPORT_INVALID',
      `模型返回的分析报告越界或不完整：${result.error.issues
        .map((i) => `${i.path.join('.') || '(根)'}：${i.message}`)
        .join('；')}`,
      { issues: result.error.issues },
    );
  }
  return result.data;
}

/**
 * 去掉 markdown 代码围栏。
 *
 * 只认 ` ``` ` 与 ` ```json ` 两种前缀，且要求围栏成对——不成对说明输出被截断了，
 * 那份内容本来就不可信，不该被「尽力修复」成合法 JSON。
 */
function stripFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  if (match === null) return trimmed;
  return match[1] ?? trimmed;
}

// ---------------------------------------------------------------------------
// 行情上下文（三个面的数据）
// ---------------------------------------------------------------------------

/** 一条均线（`kind` 与 `bars` 一起构成它的身份）。 */
export interface MaValue {
  kind: 'sma' | 'ema';
  bars: number;
  value: number;
}

/** 技术面上下文。数值全部来自 Python 侧现算的指标（AGENTS.md §6.2：指标只在 Python）。 */
export interface TechnicalContext {
  /** 分析周期，如 `1h`。 */
  interval: string;
  /** 参与计算的已收盘 K 线根数。 */
  bars: number;
  /** 最新收盘价。 */
  lastClose: number;
  /** ATR 值。 */
  atr: number;
  /** ATR 周期长度。 */
  atrPeriod: number;
  /** ATR 占价格的比例（如 `0.0072` = 0.72%）。判断「止损会不会太近」的关键尺度。 */
  atrPercentOfPrice: number;
  /** 均线。 */
  ma: readonly MaValue[];
  /** MACD（`dif` / `dea` / `hist`）。取不到时为 `null`，**不用 0 冒充**。 */
  macd: { dif: number; dea: number; hist: number } | null;
  /** RSI。 */
  rsi: readonly { period: number; value: number }[];
  /** 布林带。 */
  boll: { upper: number; mid: number; lower: number } | null;
  /** KDJ。 */
  kdj: { k: number; d: number; j: number } | null;
  /** OBV。`value` 是累计量（本身没有跨标的可比性），`change` 是近 N 根的变化量。 */
  obv: { value: number; change: number } | null;
  /** 最近若干根 K 线的收益率（百分比数，如 `1.25` 表示 +1.25%）。 */
  recentReturns: readonly number[];
  /** 最新价在最近 N 根区间里的分位，`[0, 1]`。 */
  pricePercentile: number;
  /**
   * **客观倾向分**，`[-1, 1]`。
   *
   * 由 Python 侧按固定规则从指标值算出（不经过模型），给模型一个锚点。
   * 模型可以不同意，但它的分数与这个锚点差太远时，复核的人一眼能看出来。
   */
  objectiveBias: number;
  /** 客观倾向的逐条依据。 */
  objectiveNotes: readonly string[];
}

/**
 * 情绪面上下文：持仓者的钱往哪边压。
 *
 * **取不到的项是 `null`，不是 0。** 「资金费率是 0」与「资金费率没取到」是两件
 * 完全不同的事——前者是市场事实，后者是数据缺失，模型对它们的判断应当相反
 * （AGENTS.md 约定 2：禁止用 0 冒充缺失）。
 */
export interface SentimentContext {
  /** 当前资金费率（每个结算周期的比率，如 `0.0001` = 0.01%）。 */
  fundingRate: number | null;
  /** 资金费率年化（正数 = 多头付给空头）。 */
  fundingRateAnnualized: number | null;
  /** 下次结算时间。 */
  nextFundingTimeMs: number | null;
  /** 标记价。 */
  markPrice: number | null;
  /** 指数价。 */
  indexPrice: number | null;
  /** 基差（基点）：`(标记价 − 指数价) / 指数价 × 10000`。 */
  basisBps: number | null;
  /** 持仓量（合约张数口径，以交易所返回为准）。 */
  openInterest: number | null;
  /** 持仓量近 N 期的变化率（百分比数）。正数 = 增仓。 */
  openInterestChangePct: number | null;
  /** 全市场多空**账户**比（>1 = 多头账户多）。 */
  longShortRatio: number | null;
  /** 主动买入 / 主动卖出成交量比（>1 = 主动买多占优）。 */
  takerBuySellRatio: number | null;
  /** 取数过程中的说明（缺哪个、用了什么口径）。 */
  notes: readonly string[];
}

/** 基本面上下文：合约规格、流动性、持有成本。**取不到的项是 `null`，不是 0。 */
export interface FundamentalContext {
  /** 合约类型（`PERPETUAL` 等）。 */
  contractType: string;
  /** 上市时间。取不到时为 `null`。 */
  onboardDateMs: number | null;
  /** 最小价格变动。 */
  tickSize: number;
  /** 最小下单数量。 */
  stepSize: number;
  /** 最小下单数量（`minQty`）。 */
  minQty: number;
  /** 24 小时成交额（计价币）。 */
  quoteVolume24h: number | null;
  /** 24 小时成交笔数。 */
  trades24h: number | null;
  /** 24 小时涨跌幅（百分比数）。 */
  priceChangePct24h: number | null;
  /** 持有成本年化（正数 = 多头付给空头）。与情绪面的资金费率同源，此处按合约口径再记一次。 */
  carryCostAnnualized: number | null;
  /** 说明。 */
  notes: readonly string[];
}

/** 构造提示词所需的完整上下文。全部是**已取到的数**，不含任何 IO。 */
export interface AnalystContext {
  symbol: string;
  /** 数据时刻（毫秒时间戳）。 */
  asOfMs: number;
  technical: TechnicalContext;
  sentiment: SentimentContext;
  fundamental: FundamentalContext;
  /** 当前生效的档位，作为参考基准。 */
  baseline: { stopAtrMult: number; takeProfitAtrMult: number };
}

/**
 * 构造给模型看的提示词。
 *
 * **纯函数**：同样的输入永远给出同样的提示词（AGENTS.md 约定 4）。
 * 提示词里**不出现**密钥、也不出现可变的请求标识——它进不了日志也不会被重放。
 *
 * 提示词必须把三件事讲清楚，否则模型的输出没法用：
 *
 * 1. **每个分数要有什么依据**——「技术面给 0.8 就必须指出是哪几条均线/哪个指标」。
 * 2. **每个输出会被怎么用**——模型按字面意思理解自己的输出，
 *    而「止损倍数会变成真实的价格」这件事它无从猜到。
 * 3. **不许输出价格**——价格由程序按 ATR 算（见文件头「三条边界」）。
 */
export function buildAnalystPrompt(context: AnalystContext): string {
  const lines: string[] = [
    '你是一个加密货币永续合约的**分析师**。你的任务是评估一个标的现在值不值得做多、做空，还是观望。',
    '',
    '## 你要输出的内容',
    '',
    '严格输出一个 JSON 对象，且**只**输出这个对象（不要加任何解释性文字）：',
    JSON.stringify(
      {
        technical: {
          score: '数字，-1 到 1。技术面倾向：+1 极多，-1 极空，0 没有信息量',
          notes: '字符串数组，最多 6 条，写清依据（哪条均线、哪个指标、什么价位结构）',
        },
        sentiment: {
          score: '数字，-1 到 1。情绪面倾向：+1 极多，-1 极空',
          notes: '字符串数组，最多 6 条，写清依据（资金费率、基差、持仓量、多空比、主动买卖比）',
        },
        fundamental: {
          score: '数字，-1 到 1。基本面倾向：+1 极多，-1 极空',
          notes: '字符串数组，最多 6 条，写清依据（流动性、合约规格、持有成本）',
        },
        confidence: '数字，0 到 1。你对本次结论的把握程度',
        stopAtrMult: '数字。你建议的止损距离（ATR 倍数），取值 (0, 20]',
        takeProfitAtrMult: '数字。你建议的止盈距离（ATR 倍数），取值 (0, 50]',
        rationale: '字符串。总体理由，3 到 6 句',
      },
      null,
      2,
    ),
    '',
    '## 硬性要求',
    '',
    '- **只输出 JSON**，不要加 markdown 代码块标记。',
    '- 每个面的分数都必须有数据支撑：`notes` 里要引用上面给你的具体数字。',
    '- **不要输出入场价、止损价、止盈价这些绝对价格**——价格由系统按 ATR 倍数算。',
    '- `stopAtrMult` / `takeProfitAtrMult` **会被直接用掉**：它们决定真实的止损价与止盈价。' +
      '止损倍数太小会被市场噪音扫掉，太大则单笔亏损失控。',
    '- 三个面可以不一致（技术面看多但情绪面过热是常见的）。**不要**为了好看而把它们写成一致——' +
      '不一致本身就是有价值的信息。',
    '',
    `标的：${context.symbol}`,
    '',
    '## 技术面',
    '',
    `周期：${context.technical.interval}（已收盘 K 线 ${String(context.technical.bars)} 根）`,
    `最新收盘价：${String(context.technical.lastClose)}`,
    `ATR(${String(context.technical.atrPeriod)})：${String(context.technical.atr)}` +
      `（占价格 ${(context.technical.atrPercentOfPrice * 100).toFixed(3)}%）`,
    `最新价在最近区间中的分位：${(context.technical.pricePercentile * 100).toFixed(1)}%（0% = 区间最低，100% = 区间最高）`,
  ];

  if (context.technical.ma.length > 0) {
    lines.push(
      '均线：',
      context.technical.ma
        .map((m) => `  ${m.kind.toUpperCase()}(${String(m.bars)}) = ${String(m.value)}`)
        .join('\n'),
    );
  }
  if (context.technical.macd !== null) {
    lines.push(
      `MACD：dif=${String(context.technical.macd.dif)} dea=${String(context.technical.macd.dea)} ` +
        `hist=${String(context.technical.macd.hist)}`,
    );
  }
  for (const r of context.technical.rsi) {
    lines.push(`RSI(${String(r.period)})：${String(r.value)}`);
  }
  if (context.technical.boll !== null) {
    lines.push(
      `BOLL：上轨=${String(context.technical.boll.upper)} 中轨=${String(context.technical.boll.mid)} ` +
        `下轨=${String(context.technical.boll.lower)}`,
    );
  }
  if (context.technical.kdj !== null) {
    lines.push(
      `KDJ：K=${String(context.technical.kdj.k)} D=${String(context.technical.kdj.d)} J=${String(context.technical.kdj.j)}`,
    );
  }
  if (context.technical.obv !== null) {
    lines.push(
      `OBV：累计=${String(context.technical.obv.value)} 近段变化=${String(context.technical.obv.change)}`,
    );
  }
  if (context.technical.recentReturns.length > 0) {
    lines.push(
      `最近 ${String(context.technical.recentReturns.length)} 根 K 线的收益率（%）：` +
        context.technical.recentReturns.map((r) => r.toFixed(3)).join(', '),
    );
  }
  lines.push(
    `客观倾向分（系统按固定规则从上面这些指标算出来的，未经你判断）：` +
      `${String(context.technical.objectiveBias)}`,
  );
  for (const note of context.technical.objectiveNotes) {
    lines.push(`  - ${note}`);
  }

  const s = context.sentiment;
  lines.push(
    '',
    '## 情绪面',
    '',
    `资金费率：${formatPercent(s.fundingRate)}（每次结算）→ 年化 ${formatPercent(s.fundingRateAnnualized)}` +
      `（正数 = 多头付给空头，负数 = 空头付给多头）`,
    `标记价：${formatNumber(s.markPrice)}　指数价：${formatNumber(s.indexPrice)}` +
      `　基差：${formatNumber(s.basisBps)} 基点`,
    `持仓量：${formatNumber(s.openInterest)}　近段变化：${formatPercent(s.openInterestChangePct)}` +
      `（正数 = 增仓）`,
    `全市场多空账户比：${formatNumber(s.longShortRatio)}（>1 = 多头账户多）`,
    `主动买 / 主动卖 量比：${formatNumber(s.takerBuySellRatio)}（>1 = 主动买盘占优）`,
  );
  for (const note of s.notes) {
    lines.push(`  - ${note}`);
  }
  lines.push(
    '**「未取到」表示这一项的数据没拿到，不是数值为零。**' +
      '遇到「未取到」时，不要把它当成中性信号——' +
      '该给 0 分就给 0 分，并在 notes 里写明哪一项缺。',
  );

  const f = context.fundamental;
  lines.push(
    '',
    '## 基本面',
    '',
    `合约类型：${f.contractType}`,
    `上市时间：${f.onboardDateMs === null ? '未知' : new Date(f.onboardDateMs).toISOString()}`,
    `最小价格变动：${String(f.tickSize)}　最小下单数量：${String(f.stepSize)}（下限 ${String(f.minQty)}）`,
    `24 小时成交额：${formatNumber(f.quoteVolume24h)}　成交笔数：${formatNumber(f.trades24h)}`,
    `24 小时涨跌幅：${formatPercent(f.priceChangePct24h)}`,
    `持有成本年化：${formatPercent(f.carryCostAnnualized)}（正数 = 拿着多头要付钱）`,
  );
  for (const note of f.notes) {
    lines.push(`  - ${note}`);
  }

  lines.push(
    '',
    '## 当前生效的档位（可作参考，但你要给出自己的判断）',
    '',
    `止损倍数：${String(context.baseline.stopAtrMult)}`,
    `止盈倍数：${String(context.baseline.takeProfitAtrMult)}`,
  );
  return lines.join('\n');
}

/** 比率按百分比数呈现。小数位固定 4 位，避免「0.0001」和「0.00010」两种写法。 */
function formatPercent(ratio: number | null): string {
  if (ratio === null) return '未取到';
  return `${(ratio * 100).toFixed(4)}%`;
}

/** 普通数值。`null` 呈现为「未取到」，**不写 0**。 */
function formatNumber(value: number | null): string {
  if (value === null) return '未取到';
  return String(value);
}
