/**
 * LLM 决策的契约与纯函数（v0.9.0）。
 *
 * 这个模块回答一个问题：**模型返回什么，我们接受什么。**
 *
 * ## 为什么 LLM 只输出「倍数」，不输出「价格」
 *
 * 止盈止损的价格**永远**由 `deriveStagedPlan`（[`risk-policy.ts`](./risk-policy.ts)）
 * 算出来，模型碰不到那条路径。它只能选「止损放几倍 ATR」这类**参数**。
 *
 * 理由不是不信任模型，而是三条硬约束：
 *
 *   1. **纯函数约束**（AGENTS.md 约定 4）：价格计算必须是无 IO、无时钟、无随机数的
 *      纯函数。模型输出直接变成价格，等于把一条不可复现的路径接到了真实平仓指令上——
 *      同一笔成交重放一次可能得到两个价。
 *   2. **tick 对齐与跨侧校验**：价格要对齐到最小价格变动，并保证止损止盈分居入场价
 *      两侧。这两件事在 `alignToTick` 与 `deriveStagedPlan` 里已经有一份实现
 *      （AGENTS.md §6.1 第 1 条：判据只有一份实现）。模型自己算价 = 第二份实现。
 *   3. **参数可审计**：倍数是几个数字，能落库、能回看、能被 schema 约束。
 *      价格是算出来的结果，落库的是「依据」，这与 `risk_bracket` 存 ATR 快照的
 *      既有做法一致（AGENTS.md §6.3 第 4 条：事后能回答「当时为什么止损在那个价」）。
 *
 * ## 三个刻意的边界
 *
 * - **模型不选「用不用分批」**：`takeProfit1Ratio` 是倍数族里的一个，它为 0 就退化成
 *   单段止盈。这是**参数**不是**方法**，方法切换留给 §6.3 的 `mode` 三形态。
 * - **模型不选 ATR 周期**：`atrInterval` 决定了取哪根 K 线算 ATR，那是**取数口径**，
 *   不是档位。模型改它会让「ATR 快照」与「档位倍数」来自两套口径。
 * - **模型不输出方法名**：见上一条，`mode` 由 `takeProfit1Ratio` 推出。
 *
 * ## 越界怎么办
 *
 * 模型返回的数值**必须**落在与 `executorSchema` 完全一致的区间里（AGENTS.md §6.4
 * 第 4 条：取值范围只有一份）。这里用 zod schema 复用同一份定义，而不是另写一套
 * `if (x > 20)`——两处各写一份的范围校验，漂移的症状是「模型说 25，页面存得下，
 * 纯函数算不出来」。
 *
 * 越界**不是静默截断**：`parseLlmDecision` 抛 `LLM_DECISION_INVALID`，由调用方
 * 决定降级策略并留下可见记录（AGENTS.md 约定 9：不静默兜底）。
 */

import { z } from 'zod';

import { SyncError } from './market-sync.js';

/**
 * 模型可决定的参数族。
 *
 * 字段与 `RiskPolicy` 的倍数部分**逐字对齐**——这不是巧合：决策结果要能直接
 * 替换掉策略里的倍数部分，否则调用方就得写一份「把决策映射成策略」的翻译层，
 * 而那层迟早与 `risk_policy` 的口径漂移。
 */
export const llmDecisionSchema = z.object({
  /** 止损距入场价的 ATR 倍数。 */
  stopAtrMult: z.number().positive().max(20),
  /** 止盈距入场价的 ATR 倍数。 */
  takeProfitAtrMult: z.number().positive().max(50),
  /** 第一段减仓比例，`[0, 1]`。`0` = 关闭分批。 */
  takeProfit1Ratio: z.number().min(0).max(1),
  /** 第一段止盈的 ATR 倍数。 */
  takeProfit1AtrMult: z.number().positive().max(50),
  /** 移动止损的 Chandelier 倍数。 */
  trailAtrMult: z.number().positive().max(20),
  /** 第一段兑现后是否把止损上移到保本位。 */
  breakevenAfterTp1: z.boolean(),
});

/** 模型返回的一份档位决策。字段名与 `llmDecisionSchema` 一致。 */
export type LlmDecision = z.infer<typeof llmDecisionSchema>;

/**
 * 一份决策**从哪来**。
 *
 * 这个字段是整套机制里最重要的一列：它让「这次挂单用的是模型决定的还是人配的」
 * 成为一个**可查的事实**，而不是猜的。`risk_bracket` 会把它落库。
 */
export type DecisionSource = 'llm' | 'config' | 'config-fallback';

/** 决策结果：档位 + 来源 + 可选的说明。 */
export interface RiskDecisionResult {
  /** 实际生效的倍数。 */
  decision: LlmDecision;
  /** 这一份是从哪来的。 */
  source: DecisionSource;
  /** 模型给的理由（若有）。落库后能回答「它当时为什么这么选」。 */
  rationale?: string;
  /** 降级时说明为什么没用上模型。 */
  fallbackReason?: string;
}

/**
 * 从模型的原始输出里解析出一份决策。
 *
 * 接受两种形状：
 *   - **纯 JSON**：`{"stopAtrMult":2,...}`
 *   - **带围栏的 JSON**：```` ```json {...} ``` ````
 *
 * 第二种是模型最常见的输出形态（聊天模型爱加代码块标记），因此必须容忍。
 * 但**只**容忍这一种修饰：不做「从散文里正则抠数字」那种宽松解析——那会让一段
 * 模型胡话变成一份看起来合法的档位，而它会变成真实的平仓指令。
 *
 * 解析失败一律抛 `LLM_DECISION_INVALID`，**不返回默认值**。
 */
export function parseLlmDecision(raw: string): { decision: LlmDecision; rationale?: string } {
  const text = stripFence(raw).trim();
  if (text === '') {
    throw new SyncError('LLM_DECISION_INVALID', '模型返回了空内容，没有可解析的档位决策', {
      rawLength: raw.length,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SyncError(
      'LLM_DECISION_INVALID',
      `模型返回的不是合法 JSON：${(error as Error).message}`,
      { raw: text.slice(0, 500) },
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SyncError('LLM_DECISION_INVALID', '模型返回的 JSON 不是一个对象', {
      raw: text.slice(0, 500),
    });
  }
  const obj = parsed as Record<string, unknown>;
  // 理由是**可选**的：强制它必然会让模型为了凑字段而编一段话。
  // 但它存在时必须是字符串——类型不对说明模型没按约定输出，那份输出整体不可信。
  const rationaleRaw = obj['rationale'];
  let rationale: string | undefined;
  if (rationaleRaw !== undefined && rationaleRaw !== null) {
    if (typeof rationaleRaw !== 'string') {
      throw new SyncError('LLM_DECISION_INVALID', '模型返回的 rationale 不是字符串', {
        rationaleType: typeof rationaleRaw,
      });
    }
    rationale = rationaleRaw;
  }
  const result = llmDecisionSchema.safeParse(obj);
  if (!result.success) {
    throw new SyncError(
      'LLM_DECISION_INVALID',
      `模型返回的档位越界或不完整：${result.error.issues
        .map((i) => `${i.path.join('.') || '(根)'}：${i.message}`)
        .join('；')}`,
      { issues: result.error.issues },
    );
  }
  return rationale === undefined ? { decision: result.data } : { decision: result.data, rationale };
}

/**
 * 去掉 markdown 代码围栏。
 *
 * 只认 ` ``` ` 与 ` ```json ` 两种前缀，且要求围栏成对——不成对说明模型输出被截断了，
 * 那份内容本来就不可信，不该被「尽力修复」成合法 JSON。
 */
function stripFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  if (match === null) return trimmed;
  return match[1] ?? trimmed;
}

/**
 * 一份决策能不能直接用。
 *
 * 除了字段级范围（schema 已经查过），这里查**跨字段的语义约束**：
 * 分批形态下，第一段止盈必须比整段止盈更靠近入场价，否则「先兑现的一段反而更远」
 * 是自相矛盾的配置。
 *
 * 注意 `deriveStagedPlan` 里也有同样的判断——但那是**下单时**的最终防线。
 * 这里提前拦是为了让「模型给的这份决策不可用」在**决策落库前**就暴露，
 * 而不是等到真实成交时才失败（那时仓位已经裸了几秒）。
 *
 * @param atrPeriod 只用于错误信息里说明是哪套参数。
 */
export function validateLlmDecision(
  decision: LlmDecision,
  atrPeriod: number,
): { ok: true } | { ok: false; reason: string } {
  const ratio = decision.takeProfit1Ratio;
  // 只有「真的分批」形态才需要比较两段止盈的远近。
  // ratio = 0 是单段，ratio = 1 是全平（用第一段的价），两者都不存在「先后」。
  if (ratio <= 0 || ratio >= 1) return { ok: true };
  if (decision.takeProfit1AtrMult >= decision.takeProfitAtrMult) {
    return {
      ok: false,
      reason:
        `第一段止盈(${decision.takeProfit1AtrMult}×ATR) 必须比整段止盈` +
        `(${decision.takeProfitAtrMult}×ATR) 更靠近入场价，否则「先兑现的一段」反而更远` +
        `（ATR 周期 ${String(atrPeriod)}）`,
    };
  }
  return { ok: true };
}

/**
 * 把模型给的档位**夹回**可用区间。
 *
 * 与 `parseLlmDecision` 的区别：解析是「不合法就报错」，这里是「给定一份已通过解析的
 * 决策，为它补上可用的取值」。
 *
 * 存在的原因：决策要**落库**（`risk_bracket` 记下「当时用的什么」），而落库的列
 * 有 CHECK 约束。一份越界的决策写进去会报一个数据库层面的 `INTERNAL_ERROR`，
 * 那句话完全指不出「是模型给的档位越界」。在这里夹住，错误信息能直指原因。
 *
 * **只夹数值到边界，不改结构**：`takeProfit1Ratio` 是 0.999999 会夹到 1（等于全平），
 * 但不会改成别的形态——形态是策略语义，模型说了什么就是什么。
 */
export function clampLlmDecision(decision: LlmDecision): LlmDecision {
  return {
    stopAtrMult: clamp(decision.stopAtrMult, 0.0001, 20),
    takeProfitAtrMult: clamp(decision.takeProfitAtrMult, 0.0001, 50),
    takeProfit1Ratio: clamp(decision.takeProfit1Ratio, 0, 1),
    takeProfit1AtrMult: clamp(decision.takeProfit1AtrMult, 0.0001, 50),
    trailAtrMult: clamp(decision.trailAtrMult, 0.0001, 20),
    breakevenAfterTp1: decision.breakevenAfterTp1,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 把模型给出的档位**合并**进一份既有的策略。
 *
 * 合并的方向是「模型覆盖倍数部分，策略保留方法与取数口径」：
 * `atrPeriod` / `atrInterval` **永远**来自策略，模型说了也不算——
 * 见文件头「三个刻意的边界」。
 */
export function mergeDecisionIntoPolicy<T extends LlmDecision>(
  policy: T,
  decision: LlmDecision,
): T {
  return {
    ...policy,
    stopAtrMult: decision.stopAtrMult,
    takeProfitAtrMult: decision.takeProfitAtrMult,
    takeProfit1Ratio: decision.takeProfit1Ratio,
    takeProfit1AtrMult: decision.takeProfit1AtrMult,
    trailAtrMult: decision.trailAtrMult,
    breakevenAfterTp1: decision.breakevenAfterTp1,
  };
}

/**
 * 构造给模型看的提示词。
 *
 * **纯函数**：同样的输入永远给出同样的提示词（AGENTS.md 约定 4：策略是纯函数）。
 * 提示词里**不出现**密钥、也不出现可变的请求标识——它进不了日志也不会被重放。
 *
 * @param context 给模型看的行情上下文。
 */
export function buildDecisionPrompt(context: DecisionPromptContext): string {
  const lines: string[] = [
    '你是一个加密货币永续合约的止盈止损策略师。',
    '根据给定的市场数据，为一笔**已经成交**的仓位选择止盈止损档位。',
    '',
    '## 你要输出的内容',
    '',
    '严格输出一个 JSON 对象，且**只**输出这个对象（不要加任何解释性文字）：',
    JSON.stringify(
      {
        stopAtrMult: '数字。止损距入场价的 ATR 倍数，取值 (0, 20]',
        takeProfitAtrMult: '数字。止盈距入场价的 ATR 倍数，取值 (0, 50]',
        takeProfit1Ratio: '数字。第一段减仓比例，取值 [0, 1]。0 = 不分批',
        takeProfit1AtrMult: '数字。第一段止盈的 ATR 倍数，取值 (0, 50]',
        trailAtrMult: '数字。移动止损的 Chandelier 倍数，取值 (0, 20]',
        breakevenAfterTp1: '布尔。第一段兑现后是否把止损上移到保本位',
        rationale: '字符串。简短说明为什么这么选',
      },
      null,
      2,
    ),
    '',
    '## 硬性要求',
    '',
    '- **只输出 JSON**，不要加 markdown 代码块标记。',
    '- 所有倍数必须落在上面给的取值区间内。',
    '- 若 `takeProfit1Ratio` 严格落在 0 与 1 之间（分批形态），',
    '  则 `takeProfit1AtrMult` 必须**小于** `takeProfitAtrMult`。',
    '- 不要输出入场价、止损价、止盈价这些**绝对价格**——价格由系统按 ATR 倍数算。',
    '',
    '## 市场数据',
    '',
    `标的：${context.symbol}`,
    `方向：${context.side}`,
    `成交价：${String(context.entryPrice)}`,
    `ATR(${context.atrInterval}, ${String(context.atrPeriod)})：${String(context.atr)}`,
  ];
  if (context.recentReturns.length > 0) {
    lines.push(
      `最近 ${String(context.recentReturns.length)} 根 K 线的收益率（%）：`,
      context.recentReturns.map((r) => r.toFixed(3)).join(', '),
    );
  }
  if (context.atrPercentOfPrice !== undefined) {
    lines.push(
      `ATR 占成交价比例：${(context.atrPercentOfPrice * 100).toFixed(2)}%` +
        `（这是判断止损是否过近的关键尺度）`,
    );
  }
  lines.push(
    '',
    '## 当前生效的档位（可作为基准，但你要给出自己的判断）',
    '',
    `止损倍数：${String(context.baseline.stopAtrMult)}`,
    `止盈倍数：${String(context.baseline.takeProfitAtrMult)}`,
    `第一段减仓比例：${String(context.baseline.takeProfit1Ratio)}`,
    `第一段止盈倍数：${String(context.baseline.takeProfit1AtrMult)}`,
    `移动止损倍数：${String(context.baseline.trailAtrMult)}`,
    `第一段后上移保本：${String(context.baseline.breakevenAfterTp1)}`,
  );
  return lines.join('\n');
}

/** 构造提示词所需的行情上下文。全部是**已取到的数**，不含任何 IO。 */
export interface DecisionPromptContext {
  symbol: string;
  side: string;
  entryPrice: number;
  atr: number;
  atrInterval: string;
  atrPeriod: number;
  /** 最近若干根 K 线的收益率（百分比数，如 `1.25` 表示 +1.25%）。 */
  recentReturns: readonly number[];
  /** ATR 占成交价的比例。给了它，模型更容易判断止损是否过近。 */
  atrPercentOfPrice?: number;
  /** 当前生效的档位，作为参考基准。 */
  baseline: LlmDecision;
}
