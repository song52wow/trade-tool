/**
 * 模型客户端的**解析器**（v1.0.0）。
 *
 * 回答一个问题：**这一轮该用哪个模型、密钥从哪来**。
 *
 * 「哪一份在生效」只有一份实现：`resolveAgentLlmSettings`（在 `packages/data`），
 * 判据是「面板那一行填全了、且主密钥可用 → 用面板；否则用配置文件 + 环境变量」。
 * 守护进程与命令行**共用这一个解析器**——两处各判一次的话，
 * 「页面显示的和实际用的」就会分叉。
 *
 * ## 为什么每轮重新解析
 *
 * 控制面可以改模型接入（地址 / 模型名 / 密钥 / 超时）。改完**不必重启进程**——
 * 下一轮就用新的那一份。与通知设置同一套做法（「每轮重新解析，改完不必重启」）。
 *
 * ## 主密钥没注入时
 *
 * 面板那一档**读不到**（密文解不开），于是生效的必然是配置文件那一档。
 * 这不是错误：可能用户压根没用控制面录入。主密钥是**可选**的。
 */

import { SyncError, type LlmEndpoint } from '@trade-tool/core';
import { createLlmClient, resolveAgentLlmSettings, type LlmClient } from '@trade-tool/data';

import type { Pool } from '@trade-tool/data';

export interface LlmResolverOptions {
  pool: Pool;
  /** 主密钥。没注入就读不到控制面录入的那一份。 */
  masterKey: Buffer | null;
  /** 配置文件里的 `agent.llm` 段（没有控制面那一档时的兜底）。 */
  config: LlmEndpoint;
  /** 注入用的 fetch 实现。测试用。 */
  fetchImpl?: typeof fetch;
}

/**
 * 建一个「每轮解析一次」的模型客户端工厂。
 *
 * 返回的函数**每次调用都重新读库**（并重新解析密钥），因此控制面改完设置后
 * 下一轮就生效。
 *
 * @throws SyncError 'CONFIG_INVALID' 生效的那一档是「未启用」，或密钥读不到。
 */
export function createLlmResolver(options: LlmResolverOptions): () => Promise<LlmClient> {
  return async (): Promise<LlmClient> => {
    const resolved = await resolveAgentLlmSettings({
      pool: options.pool,
      masterKey: options.masterKey,
      config: options.config,
    });
    const settings = resolved.settings;
    if (!settings.enabled) {
      throw new SyncError(
        'CONFIG_INVALID',
        `模型未启用（生效来源：${resolved.source === 'panel' ? '控制面录入' : '配置文件'}）：` +
          '请在控制面「设置」页打开模型，或把 agent.llm.enabled 设为 true。',
        { source: resolved.source },
      );
    }
    return createLlmClient({
      baseUrl: settings.baseUrl,
      model: settings.model,
      apiKey: settings.apiKey,
      timeoutMs: settings.timeoutMs,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
  };
}
