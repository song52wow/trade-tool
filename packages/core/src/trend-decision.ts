/**
 * 趋势档位决策的契约与纯函数（v1.1.0）。
 *
 * ## 它补的是哪个缺口
 *
 * v0.9.0 那条「成交 → 问模型 → 定档位」的链路，模型只看到 **ATR 与最近若干根
 * K 线的收益率数列**。用这串数判断「趋势」是很浅的：数列看不出均线结构，看不出
 * 指标背离，看不出持仓者的钱往哪边压。
 *
 * v1.0.0 的分析师 Agent 看的是三个面（技术面 / 情绪面 / 基本面），但它的产物是
 * 一份**执行方案**——进场价、仓位、止损、止盈——只服务于「它自己开仓」。
 * 没有任何入口是「我已经在交易所手动开了仓，你只给我止盈止损」。
 *
 * 本模块补上这个缺口：**已有仓位 → 模型按趋势给档位**。
 * 手动挂单成交后，executor 用同一份行情上下文（Python 现算的技术面 + 情绪面）
 * 问模型「这一笔的止损止盈放多远」，模型仍然只出**倍数**，价格仍由
 * `deriveStagedPlan` 按 ATR 算（AGENTS.md §5 第 13 条：模型只提比例）。
 *
 * ## 最要紧的一件事：ATR 的口径不能混
 *
 * **算价用的 ATR** 与 **趋势分析用的 ATR** 是两个不同周期的尺度：
 *
 * | 尺度             | 周期     | 谁用它                     |
 * | ---------------- | -------- | -------------------------- |
 * | 算价基准 ATR     | `1m`     | `deriveStagedPlan` 算价格  |
 * | 趋势分析 ATR     | `1h`     | 判断趋势的波动背景         |
 *
 * 两者差着一到两个数量级。如果模型拿「2 倍趋势周期 ATR」当答案，而程序按
 * 「2 倍算价基准 ATR」去算价，止损距离会差十倍——**挂出去的止损近到一根针就能扫掉**，
 * 而且日志与库里的一切都「看起来正常」。
 *
 * 因此本模块做了三件事：
 *
 * 1. **提示词里只给一个带单位的 ATR**（算价基准）。趋势周期的 ATR **只以
 *    「占价格的比例」这种无量纲形式出现**，不给具体数值。
 * 2. **硬性要求里写死**「所有倍数以算价基准 ATR 为单位」。
 * 3. **配置基准档位同时给出「倍数」与「占成交价的百分比」**，让模型对尺度有参照：
 *    「配置档位是 2 倍 = 成交价的 0.10%」比光给「2 倍」有用得多。
 *
 * ## 趋势线索为什么用「程序算的客观倾向」
 *
 * 提示词里的趋势不是让模型从一堆指标里凭空总结的，而是先由 Python 侧按**固定的
 * 七条规则**投票算出一个客观倾向分（`market_context.objective_bias`：收盘价 vs MA20、
 * MA20 vs MA60、MACD 柱、RSI、布林中轨、KDJ、OBV），再把逐条依据一起给模型。
 *
 * 这么做的理由与分析师层同源：模型对同一组数字可能有完全不同的解读。给一个锚点，
 * 两者的分歧就会显形（人复核时一眼能看出「模型说 +0.9、客观分是 -0.6」），
 * 而不是被模型的自信掩盖过去。
 *
 * ## 这里的数**不参与**算价
 *
 * 本模块产出的全是**提示词素材**。真正拿去算价的仍然只有
 * `stopAtrMult` / `takeProfitAtrMult` 两个倍数，且它们是模型直接给的——
 * 本模块不替模型改数（改了就变成「模型的输出被悄悄调整过」，而那条调整记录
 * 没有地方写）。
 */

import type { AnalystContext } from './agent-analyst.js';
import type { LlmDecision } from './llm-decision.js';

/**
 * 给模型看的趋势线索。
 *
 * **全部是无量纲或相对量**：唯一的绝对数是「算价基准 ATR」与「成交价」，
 * 而这两个是算价必需的（模型要判断止损离成交价多远）。
 */
export interface TrendDecisionContext {
  /** 标的。 */
  symbol: string;
  /** 持仓方向。 */
  side: 'BUY' | 'SELL';
  /** 成交价。 */
  entryPrice: number;
  /** 算价基准 ATR。**模型给出的倍数乘以它，得到距离。** */
  atr: number;
  /** 算价基准 ATR 的周期。 */
  atrInterval: string;
  /** 算价基准 ATR 的周期长度。 */
  atrPeriod: number;
  /** 算价基准 ATR 占成交价的比例。 */
  atrPercentOfPrice: number;
  /** 趋势分析用的周期（与算价基准 ATR 的周期**不同**）。 */
  trendInterval: string;
  /** 趋势分析的数据时刻（epoch ms）。 */
  trendAsOfMs: number;
  /** 最近收盘价相对成交价的百分比。正数 = 价格在成交价上方。 */
  priceVsEntryPercent: number;
  /** 客观倾向分，`[-1, 1]`。正数偏多。 */
  objectiveBias: number;
  /** 客观倾向的逐条依据。 */
  objectiveNotes: readonly string[];
  /** 均线相对**成交价**的百分比偏移。正数 = 均线在成交价上方。 */
  ma: readonly { kind: string; bars: number; percentFromEntry: number }[];
  /** MACD。`null` = 取不到（**不用 0 冒充**）。 */
  macd: { dif: number; dea: number; hist: number } | null;
  /** RSI。 */
  rsi: readonly { period: number; value: number }[];
  /** 布林带相对成交价的百分比偏移。`null` = 取不到。 */
  boll: { upperPercent: number; lowerPercent: number } | null;
  /** KDJ。`null` = 取不到。 */
  kdj: { k: number; d: number; j: number } | null;
  /** OBV 近段变化量。`null` = 取不到。 */
  obvChange: number | null;
  /** 最新价在最近区间里的分位，`[0, 1]`。 */
  pricePercentile: number;
  /** 最近若干根 K 线的收益率（百分比数）。 */
  recentReturns: readonly number[];
  /** 情绪面。取不到的项是 `null`，**不是 0**。 */
  sentiment: {
    fundingRateAnnualized: number | null;
    basisBps: number | null;
    openInterestChangePct: number | null;
    longShortRatio: number | null;
    takerBuySellRatio: number | null;
  };
  /** 当前生效的档位，作为参考基准。 */
  baseline: LlmDecision;
}

/** {@link toTrendDecisionContext} 的输入。全部是**已取到的数**，不含任何 IO。 */
export interface TrendContextInput {
  /** 行情上下文（Python 现算的技术面 + 情绪面）。 */
  analyst: AnalystContext;
  /** 持仓方向。 */
  side: 'BUY' | 'SELL';
  /** 成交价。 */
  entryPrice: number;
  /** 算价基准 ATR。 */
  atr: number;
  /** 算价基准 ATR 的周期。 */
  atrInterval: string;
  /** 算价基准 ATR 的周期长度。 */
  atrPeriod: number;
}

/**
 * 把行情上下文映射成给模型看的趋势线索。**纯函数**（AGENTS.md 约定 4）。
 *
 * ## 为什么均线与布林要换成「相对成交价的百分比」
 *
 * 原始值是绝对价格（`MA20 = 64850`）。成交价也是绝对价格。模型要同时在脑子里
 * 做一次减法才知道「均线在成交价上方还是下方」——而它做减法不可靠，差个符号
 * 就把「均线压制」读成「均线支撑」。
 *
 * 程序算好这个减法，模型只读结论：**符号不会错**。
 */
export function toTrendDecisionContext(input: TrendContextInput): TrendDecisionContext {
  const { analyst, side, entryPrice, atr, atrInterval, atrPeriod } = input;
  const t = analyst.technical;
  const s = analyst.sentiment;
  const entry = entryPrice > 0 ? entryPrice : t.lastClose;

  return {
    symbol: analyst.symbol,
    side,
    entryPrice: entry,
    atr,
    atrInterval,
    atrPeriod,
    atrPercentOfPrice: entry > 0 ? atr / entry : 0,
    trendInterval: t.interval,
    trendAsOfMs: analyst.asOfMs,
    priceVsEntryPercent: entry > 0 ? ((t.lastClose - entry) / entry) * 100 : 0,
    objectiveBias: t.objectiveBias,
    objectiveNotes: t.objectiveNotes,
    ma: t.ma.map((m) => ({
      kind: m.kind,
      bars: m.bars,
      percentFromEntry: entry > 0 ? ((m.value - entry) / entry) * 100 : 0,
    })),
    macd: t.macd,
    rsi: t.rsi,
    boll:
      t.boll === null
        ? null
        : {
            upperPercent: entry > 0 ? ((t.boll.upper - entry) / entry) * 100 : 0,
            lowerPercent: entry > 0 ? ((t.boll.lower - entry) / entry) * 100 : 0,
          },
    kdj: t.kdj,
    obvChange: t.obv === null ? null : t.obv.change,
    pricePercentile: t.pricePercentile,
    recentReturns: t.recentReturns,
    sentiment: {
      fundingRateAnnualized: s.fundingRateAnnualized,
      basisBps: s.basisBps,
      openInterestChangePct: s.openInterestChangePct,
      longShortRatio: s.longShortRatio,
      takerBuySellRatio: s.takerBuySellRatio,
    },
    baseline: {
      stopAtrMult: analyst.baseline.stopAtrMult,
      takeProfitAtrMult: analyst.baseline.takeProfitAtrMult,
      takeProfit1Ratio: 0,
      trailAtrMult: analyst.baseline.stopAtrMult,
      breakevenAfterTp1: false,
    },
  };
}

/**
 * 构造「按趋势定档位」的提示词。
 *
 * **纯函数**：同样的输入永远给出同样的提示词（AGENTS.md 约定 4）。
 * 提示词里**不出现**密钥、也不出现可变的请求标识——它进不了日志也不会被重放。
 *
 * @param context 给模型看的趋势线索。
 */
export function buildTrendDecisionPrompt(context: TrendDecisionContext): string {
  const lines: string[] = [
    '你是一个加密货币永续合约的**持仓管理师**。一笔仓位**已经成交**（入场价已知），',
    '你的任务是判断：这一笔的止损与止盈应该放在多远。',
    '',
    '## 你要输出的内容',
    '',
    '严格输出一个 JSON 对象，且**只**输出这个对象（不要加任何解释性文字）：',
    JSON.stringify(
      {
        stopAtrMult: '数字。止损距入场价的 ATR 倍数，取值 (0, 20]',
        takeProfitAtrMult:
          '数字。止盈距入场价的 ATR 倍数，取值 (0, 50]。' +
          '不分批时是「到价一次全平」的目标；分批时是「先兑现那一段」的目标',
        takeProfit1Ratio:
          '数字。第一段减仓比例，取值 [0, 1]。0 = 不分批（到价一次全平）；' +
          '严格落在 0 与 1 之间 = 先按这个比例减仓，剩下的仓位交给移动止损',
        trailAtrMult: '数字。移动止损的 Chandelier 倍数，取值 (0, 20]',
        breakevenAfterTp1: '布尔。第一段兑现后是否把止损上移到保本位',
        rationale: '字符串。简短说明为什么这么选（要引用上面的趋势依据）',
      },
      null,
      2,
    ),
    '',
    '## 硬性要求',
    '',
    '- **只输出 JSON**，不要加 markdown 代码块标记。',
    '- **你给出的所有倍数都以【算价基准 ATR】为度量单位**，不是趋势分析周期的 ATR。',
    '  趋势线索来自另一个周期（见下），它的波动尺度与算价基准不是一回事——',
    '  两者差着一到两个数量级，混用会让止损近到一根针就能被扫掉。',
    '- 不要输出入场价、止损价、止盈价这些**绝对价格**——价格由系统按 ATR 倍数算。',
    '- **你输出的每一个数都会被用到**：止盈倍数决定止盈价，减仓比例决定卖多少，',
    '  移动止损倍数决定剩下的仓位怎么了结。',
    '- 止损太近会被市场噪音扫掉，太远则单笔亏损失控。**先看「ATR 占成交价比例」',
    '  再决定倍数**：止损距离占成交价的比例过小（远小于配置档位的参考值）基本会被扫。',
    '- 趋势不利时**收紧**止损（甚至用更小的止盈倍数），趋势有利时才考虑放宽。',
    '  不要因为「看多」就无脑放宽止损——止损距离是风险，不是信心。',
    '',
    '## 仓位事实',
    '',
    `标的：${context.symbol}`,
    `方向：${context.side === 'BUY' ? '做多（BUY）' : '做空（SELL）'}`,
    `成交价：${String(context.entryPrice)}`,
    '',
    '## 算价基准（你的倍数乘以这个 ATR，得到距离）',
    '',
    `ATR(${context.atrInterval}, ${String(context.atrPeriod)})：${String(context.atr)}` +
      `（占成交价 ${(context.atrPercentOfPrice * 100).toFixed(3)}%）`,
    `当前配置档位（参考）：止损 ${String(context.baseline.stopAtrMult)} 倍` +
      `（= 成交价的 ${(context.baseline.stopAtrMult * context.atrPercentOfPrice * 100).toFixed(3)}%）、` +
      `止盈 ${String(context.baseline.takeProfitAtrMult)} 倍` +
      `（= 成交价的 ${(context.baseline.takeProfitAtrMult * context.atrPercentOfPrice * 100).toFixed(3)}%）`,
    '',
    `## 趋势线索（${context.trendInterval} 周期；下面的 ATR 不是你的度量单位）`,
    '',
    `客观倾向分：${context.objectiveBias.toFixed(2)}（-1 极空 → +1 极多）`,
  ];

  if (context.objectiveNotes.length > 0) {
    lines.push('客观倾向的依据：');
    for (const note of context.objectiveNotes) lines.push(`  - ${note}`);
  }

  lines.push(
    `最新收盘价相对成交价：${context.priceVsEntryPercent.toFixed(2)}%（正数 = 价格在成交价上方）`,
    `最新价在最近区间中的分位：${(context.pricePercentile * 100).toFixed(1)}%（0% = 区间最低，100% = 区间最高）`,
  );

  if (context.ma.length > 0) {
    lines.push(
      '均线相对成交价（正数 = 均线在成交价上方）：',
      context.ma
        .map(
          (m) => `  ${m.kind.toUpperCase()}(${String(m.bars)})：${m.percentFromEntry.toFixed(2)}%`,
        )
        .join('\n'),
    );
  }
  if (context.macd !== null) {
    lines.push(
      `MACD：dif ${String(context.macd.dif)} / dea ${String(context.macd.dea)} / hist ${String(context.macd.hist)}` +
        `（hist > 0 = 多头动能）`,
    );
  }
  if (context.rsi.length > 0) {
    lines.push(
      `RSI：${context.rsi.map((r) => `${String(r.period)} → ${String(r.value)}`).join('，')}`,
    );
  }
  if (context.boll !== null) {
    lines.push(
      `布林带相对成交价：上轨 ${context.boll.upperPercent.toFixed(2)}% / ` +
        `下轨 ${context.boll.lowerPercent.toFixed(2)}%`,
    );
  }
  if (context.kdj !== null) {
    lines.push(
      `KDJ：K ${String(context.kdj.k)} / D ${String(context.kdj.d)} / J ${String(context.kdj.j)}`,
    );
  }
  if (context.obvChange !== null) {
    lines.push(`OBV 近段变化：${String(context.obvChange)}（正数 = 资金净流入）`);
  }
  if (context.recentReturns.length > 0) {
    lines.push(
      `最近 ${String(context.recentReturns.length)} 根 K 线的收益率（%）：`,
      context.recentReturns.map((r) => r.toFixed(3)).join(', '),
    );
  }

  lines.push('', '## 情绪面（持仓者的钱往哪边压）', '');
  const s = context.sentiment;
  if (s.fundingRateAnnualized !== null) {
    lines.push(
      `资金费率年化：${(s.fundingRateAnnualized * 100).toFixed(2)}%` + `（正数 = 多头付给空头）`,
    );
  }
  if (s.basisBps !== null) {
    lines.push(`基差：${s.basisBps.toFixed(1)} 个基点（正数 = 现货溢价）`);
  }
  if (s.openInterestChangePct !== null) {
    lines.push(`持仓量近段变化：${s.openInterestChangePct.toFixed(2)}%（正数 = 增仓）`);
  }
  if (s.longShortRatio !== null) {
    lines.push(`多空账户比：${s.longShortRatio.toFixed(2)}（> 1 = 多头账户多）`);
  }
  if (s.takerBuySellRatio !== null) {
    lines.push(`主动买卖比：${s.takerBuySellRatio.toFixed(2)}（> 1 = 主动买多占优）`);
  }
  const sentimentMissing =
    s.fundingRateAnnualized === null &&
    s.basisBps === null &&
    s.openInterestChangePct === null &&
    s.longShortRatio === null &&
    s.takerBuySellRatio === null;
  if (sentimentMissing) {
    lines.push('（情绪面这一组数据都没取到——不要因此改变你的判断依据）');
  }

  return lines.join('\n');
}
