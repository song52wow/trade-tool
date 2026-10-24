/**
 * LLM 客户端（v0.9.0）：OpenAI 兼容的 chat completions。
 *
 * ## 为什么放 data 层
 *
 * 它做两件事：出网、把 JSON 变成档位参数。前者是 IO，AGENTS.md §4 说「行情接入、
 * 缓存、Python 调用」归 `packages/data`；后者是纯函数，归 `packages/core`。
 * 这里只做前者——解析与校验在 `packages/core/src/llm-decision.ts`。
 *
 * ## 为什么用 OpenAI 兼容协议
 *
 * 因为它是事实标准：OpenAI、DeepSeek、通义、智谱、Ollama、vLLM、LM Studio
 * 都提供 `/v1/chat/completions` 这个形状。写死某一家会让「换个模型」变成改代码。
 *
 * ## 三个不可协商的行为
 *
 * 1. **硬超时**：`AbortController` + 定时器。模型慢不能把成交处理卡住——
 *    那段时间仓位是裸的（AGENTS.md §6.3 第 4 条的同一类风险）。
 * 2. **失败即报错**：`LLM_CALL_FAILED`，不返回空字符串、不返回默认值。
 *    调用方决定降级策略，客户端不替它决定（AGENTS.md 约定 9）。
 * 3. **密钥只从环境变量读**：配置里只写**环境变量名**，与 `executor.apiKeyEnv`
 *    同一套做法（AGENTS.md 约定 2）。
 */

import { SyncError } from '@trade-tool/core';

/** 一条对话消息。 */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 客户端配置。密钥本身不在这里——只有**环境变量名**。 */
export interface LlmClientOptions {
  /** API 基址，如 `https://api.openai.com/v1`。末尾的斜杠会被去掉。 */
  baseUrl: string;
  /** 模型名。 */
  model: string;
  /**
   * API 密钥所在的**环境变量名**。
   *
   * 配置文件里出现明文密钥会被直接拒绝（AGENTS.md 约定 2），因此这里只存名字。
   *
   * 给了 {@link LlmClientOptions.apiKey} 时它不必填——控制面录入的那一份
   * 已经在调用方手里了。
   */
  apiKeyEnv?: string;
  /**
   * 直接给的密钥（v1.0.0 控制面录入的那一份，密文解开后的明文）。
   *
   * 与 {@link LlmClientOptions.apiKeyEnv} **二选一**：给了就用它，
   * 不给就从环境变量读。两者都不给时**报错**——不静默用空串去请求。
   *
   * 密钥**只在这两处出现**：环境变量，或控制面录入后解开的那一份。
   * 它不进配置文件、不进 argv、不进日志（约定 2）。
   */
  apiKey?: string;
  /**
   * 单次调用的硬超时（毫秒）。
   *
   * 缺省 8000：一次正常的 chat completion 在 1–3 秒。给到 8 秒是留余量，
   * 再长就说明网络或服务有问题——那种情况下**应该失败降级**，而不是继续等。
   */
  timeoutMs?: number;
  /** 温度。缺省 0——档位决策要的是可复现，不是发散。 */
  temperature?: number;
  /** 注入用的 fetch 实现。测试用。 */
  fetchImpl?: typeof fetch;
}

/** 客户端的最小能力面。executor 只依赖这个接口，便于替换与测试。 */
export interface LlmClient {
  /**
   * 发起一次对话补全，返回模型输出的**原始正文**。
   *
   * 返回原文而不返回解析后的结构：解析是纯函数，在 core 层做，
   * 这里的职责只有「把请求发出去、把正文拿回来」。
   */
  complete(messages: readonly LlmMessage[]): Promise<string>;
}

/** 响应里我们关心的部分。别的字段不看，也不透出。 */
interface ChatCompletionResponse {
  choices?: {
    message?: { content?: string | null };
  }[];
  error?: { message?: string; code?: string | number; type?: string };
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed === '') {
    throw new SyncError('CONFIG_INVALID', 'LLM baseUrl 不能为空：它决定请求发到哪里');
  }
  return trimmed;
}

/**
 * 从环境变量里取密钥。
 *
 * **读不到就报错**，不用空串继续（AGENTS.md 约定 8：配置与外部输入缺失就报错，
 * 并说清怎么配）。错误信息里带上环境变量名，让人一眼知道该配哪个。
 */
export function readLlmApiKey(envName: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[envName];
  if (value === undefined || value.trim() === '') {
    throw new SyncError(
      'CONFIG_INVALID',
      `LLM API 密钥缺失：请在环境变量 ${envName} 里填上密钥（配置文件里只写变量名，不写密钥本身）`,
      { envName },
    );
  }
  return value.trim();
}

/**
 * 建一个 OpenAI 兼容的客户端。
 *
 * @throws SyncError 'CONFIG_INVALID' 缺 baseUrl / model / apiKeyEnv；
 *         'LLM_CALL_FAILED' 请求失败、超时或返回体不可解析。
 */
export function createLlmClient(options: LlmClientOptions): LlmClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  if (options.model.trim() === '') {
    throw new SyncError('CONFIG_INVALID', 'LLM model 不能为空：它决定用哪个模型');
  }
  // 密钥：**直接给的优先**，否则从环境变量读。两者都没有就报错——
  // 拿着空串去请求会得到一个语焉不详的 401，而真正的原因（没配密钥）在这里更清楚。
  const explicitKey = options.apiKey?.trim() ?? '';
  if (explicitKey === '') {
    if (options.apiKeyEnv === undefined || options.apiKeyEnv.trim() === '') {
      throw new SyncError(
        'CONFIG_INVALID',
        'LLM 密钥没给：要么提供 apiKey（控制面录入的那一份），' +
          '要么提供 apiKeyEnv（密钥所在的环境变量名）',
      );
    }
  }
  const timeoutMs = options.timeoutMs ?? 8_000;
  const temperature = options.temperature ?? 0;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return {
    async complete(messages: readonly LlmMessage[]): Promise<string> {
      const apiKey = explicitKey !== '' ? explicitKey : readLlmApiKey(options.apiKeyEnv as string);
      const controller = new AbortController();
      // 定时器**必须**在 finally 里清掉，否则每次调用都在 Node 的定时器列表里
      // 留一条，直到进程退出——一个每分钟跑几十次的定时器会让进程永远不退出。
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: options.model,
            messages,
            temperature,
            // 走 JSON 模式。模型仍然可能不遵守（各家实现程度不同），
            // 所以解析层还要容忍代码围栏——但**不能**因此放宽到「从散文里抠数字」。
            response_format: { type: 'json_object' },
          }),
          signal: controller.signal,
        });

        const body = await response.text();
        if (!response.ok) {
          // 带上模型服务自己的错误信息：它比「HTTP 400」有用得多。
          throw new SyncError(
            'LLM_CALL_FAILED',
            `LLM 请求失败：HTTP ${String(response.status)} ${response.statusText}` +
              `${extractProviderError(body)}`,
            { status: response.status, body: body.slice(0, 500) },
          );
        }
        return extractContent(body);
      } catch (error) {
        if (error instanceof SyncError) throw error;
        if (isAbortError(error)) {
          throw new SyncError(
            'LLM_CALL_FAILED',
            `LLM 请求超时（${String(timeoutMs)}ms）：模型没在这个时间内给出结果，` +
              `已放弃这次决策并走降级路径`,
            { timeoutMs },
          );
        }
        throw new SyncError('LLM_CALL_FAILED', `LLM 请求出错：${(error as Error).message}`, {
          cause: String(error),
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** 从错误响应体里挖出服务商自己的说明。挖不到就返回空串。 */
function extractProviderError(body: string): string {
  try {
    const parsed = JSON.parse(body) as ChatCompletionResponse;
    const message = parsed.error?.message;
    if (typeof message === 'string' && message !== '') return `：${message}`;
  } catch {
    // 不是 JSON（网关错误页之类）。不猜，直接不补这句。
  }
  return '';
}

/** 从成功响应体里取出模型输出正文。取不到就报错。 */
function extractContent(body: string): string {
  let parsed: ChatCompletionResponse;
  try {
    parsed = JSON.parse(body) as ChatCompletionResponse;
  } catch (error) {
    throw new SyncError('LLM_CALL_FAILED', `LLM 返回的不是合法 JSON：${(error as Error).message}`, {
      body: body.slice(0, 500),
    });
  }
  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new SyncError(
      'LLM_CALL_FAILED',
      'LLM 响应里没有 choices[0].message.content：模型服务返回的形状不对',
      { body: body.slice(0, 500) },
    );
  }
  return content;
}

/**
 * 判断一个异常是不是超时中止。
 *
 * `AbortController.abort()` 抛的 `DOMException` 在 Node 里的 `name` 是
 * `AbortError`；但不同运行时的表现不完全一致（有的给 `code = 'ABORT_ERR'`，
 * 有的给 `code = 20`），所以两个都认。
 */
function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { name?: unknown; code?: unknown };
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return true;
  return e.code === 'ABORT_ERR' || e.code === 20;
}
