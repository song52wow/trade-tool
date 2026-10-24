/**
 * LLM 接入配置的**公共部分**（v1.0.0）。
 *
 * ## 为什么单独抽一个文件
 *
 * 「怎么连上一个 OpenAI 兼容的模型服务」是一个概念，它被两处用到：
 *
 * - `executor.llm`：问模型「这笔仓的止盈止损档位用多少」（v0.9.0）
 * - `agent.llm`：问模型「这个标的怎么看」「怎么做这一笔」（v1.0.0）
 *
 * 两处的**接入方式完全一样**（基址、模型名、密钥的环境变量名、超时），
 * 不同的只是「模型回答什么问题」。若各写一份 schema，改一处忘了另一处就会出现
 * 「executor 能连上、agent 连不上」这种查起来很费劲的分叉
 * （AGENTS.md §5 第 5 条：同一概念只有一个实现）。
 *
 * 单独成文件还有一个好处：`config.ts` 要 import `agent-config`（`agentSchema`），
 * 而 `agent-config` 又要用这里的字段——放进同一个文件就会形成循环 import。
 *
 * ## 为什么不共用一份完整 schema
 *
 * 两段配置的**其余字段语义不同**，硬凑成一份会逼着读者去猜：
 *
 * - `executor.llm.fallbackToPolicy`：模型失败时降级到 `risk_policy` 的档位
 *   （仓位已经成交了，不挂止损就是裸仓）；
 * - `executor.llm.contextBars`：喂多少根 K 线给模型算收益率；
 * - `agent.llm.fallbackToTrade`：模型失败时这一轮**不出方案**（还没开仓，
 *   「什么都不做」没有裸仓风险）。
 *
 * 所以这里是「**公共字段一份 + 各自字段各自扩展**」，不是「一份打天下」。
 */

import { z } from 'zod';

/**
 * 接入一个 OpenAI 兼容模型服务的公共字段。
 *
 * 密钥**只写环境变量名**，配置里出现明文密钥会被直接拒绝（AGENTS.md 约定 2）。
 */
export const llmEndpointSchema = z.object({
  /** 是否启用。缺省 false。 */
  enabled: z.boolean().default(false),
  /**
   * API 基址。OpenAI 兼容协议，如 `https://api.openai.com/v1`。
   *
   * **不给默认值**：各家地址不同，给了默认值等于「忘了配也能跑」，
   * 而它会真的去某个地方发请求。启用时缺它必须报错（见 {@link refineLlmEndpoint}）。
   */
  baseUrl: z.string().default(''),
  /** 模型名。同样不给默认值。 */
  model: z.string().default(''),
  /** API 密钥所在的**环境变量名**。配置文件里不写密钥本身（约定 2）。 */
  apiKeyEnv: z.string().min(1).default('TRADE_TOOL_LLM_API_KEY'),
  /**
   * 单次调用的硬超时（毫秒）。
   *
   * 缺省 8000：一次正常的 chat completion 在 1–3 秒。给到 8 秒是留余量，
   * 再长就说明网络或服务有问题——那种情况下**应该失败降级**，而不是继续等。
   */
  timeoutMs: z.number().int().positive().max(60_000).default(8_000),
});

/** {@link llmEndpointSchema} 的类型。 */
export type LlmEndpoint = z.infer<typeof llmEndpointSchema>;

/**
 * 启用时必须同时给出 `baseUrl` 与 `model`。
 *
 * 抽成函数而不是各写一份 `.refine()`：两处各写一遍的话，改了口径只改了一处，
 * 就会出现「executor 缺 model 会报错、agent 缺 model 却静默用默认模型」。
 *
 * @param cfg 待检查的端点配置。
 * @param path 报错时指出的配置路径（如 `['executor', 'llm']`），让人知道改哪儿。
 */
export function refineLlmEndpoint(
  cfg: LlmEndpoint,
  path: readonly string[],
): { ok: true } | { ok: false; message: string } {
  if (!cfg.enabled) return { ok: true };
  const missing: string[] = [];
  if (cfg.baseUrl.trim() === '') missing.push('baseUrl');
  if (cfg.model.trim() === '') missing.push('model');
  if (missing.length === 0) return { ok: true };
  return {
    ok: false,
    message:
      `${path.join('.')}.enabled 为 true 时必须同时给出 ` +
      `${path.join('.')}.${missing.join(' 与 ')}：` +
      '它们决定请求发到哪里、用哪个模型。缺任一项都不许静默用默认值',
  };
}
