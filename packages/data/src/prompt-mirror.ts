/**
 * 提示词镜像的**运行时**（v1.0.0）：把真正发给模型的那一组消息同步推到飞书群。
 *
 * ## 为什么住在 `packages/data`
 *
 * 有**两个进程**会调模型：`apps/agent`（分析 + 出方案）与 `apps/executor`
 * （按成交价问模型要止损止盈倍数）。两处都要镜像，而
 * `apps/*` 之间**不能互相依赖**（AGENTS.md 约定 1：包之间只依赖 `core`）。
 *
 * 于是这一份放在 `packages/data`：
 *   * 它已经有通知设置的读写与优先级解析（`db/notify.ts`），
 *     「哪一份在生效」只有一份实现；
 *   * 它依赖 core（通道、纯函数），而 core 不依赖它——依赖方向不变；
 *   * 两个 app 都依赖 data，于是**共用同一份镜像逻辑**。
 *
 * ## 四条口径
 *
 * 1. **逐字**。镜像的是**真正发出去的那一组消息**（同一个数组既用来调模型、
 *    也用来镜像），不是重新拼一份——重新拼的那份一旦与模型看见的有出入，
 *    这条线索就废了。
 * 2. **默认不勾**。提示词里带着行情与账户权益。它是唯二默认关闭的通知内容
 *    （core 的 `DEFAULT_NOTIFY_KINDS`）。
 * 3. **推送绝不影响主流程**。飞书挂了、超时了、被拒了——**分析 / 挂单照跑**。
 *    但**失败必须看得见**（记日志），不能一声不响（AGENTS.md 约定 9）。
 * 4. **没勾就不发**。用户没勾这一项时，一次都不发——不是「发了但没勾的样子」。
 */

import {
  buildPromptEvent,
  createLogger,
  createNotifier,
  PROMPT_SOURCE_INFO,
  type AgentPromptMessage,
  type Logger,
  type Notifier,
  type NotifyConfig,
  type PromptSource,
} from '@trade-tool/core';

import { resolveNotifySettings } from './db/notify.js';
import type { Pool } from './db/pool.js';

/** 一次镜像需要的通道。 */
export interface PromptMirrorChannel {
  notifier: Notifier;
  /**
   * 这一轮生效的「要通知哪些内容」。
   *
   * 是宽泛的 `string[]`（与通知层其余部分同一口径）：库里那一份在**运行期**
   * 才校验元素是不是已知种类（`asKinds`）。判断「勾了没有」用的是
   * core 的 `PROMPT_SOURCE_INFO` 里的常量——拼错一个字母的后果是**永远不发**。
   */
  kinds: readonly string[];
}

/**
 * 通道提供者。**每条提示词调一次**。
 *
 * 返回 `null` = 这一轮没有可用通道（通知没开），镜像就什么都不做。
 */
export type PromptMirrorChannelResolver = () =>
  PromptMirrorChannel | null | Promise<PromptMirrorChannel | null>;

/** 要镜像的那一组消息。 */
export interface PromptMirrorInput {
  /** 谁发的这一组消息（决定归属哪种勾选项与标题里的称呼）。 */
  source: PromptSource;
  /** 标的。 */
  symbol: string;
  /** **真正发出去的那一组消息**（含系统提示）。 */
  messages: readonly AgentPromptMessage[];
}

/** 镜像器。 */
export interface PromptMirror {
  /**
   * 镜像一条提示词。
   *
   * **永远不抛错**：推送失败只记日志。抛错会让「飞书挂了」变成「分析也停了 /
   * 挂单也停了」，而提示词镜像只是排障用的辅助出口，绝不该拖垮主流程。
   */
  mirror(input: PromptMirrorInput): Promise<void>;
}

/**
 * 建一个镜像器。
 *
 * @param resolveChannel 每条提示词解析一次通道（控制面改完下一条就生效）。
 * @param log 日志出口，缺省走 core 的 logger（写 stderr）。
 */
export function createPromptMirror(deps: {
  resolveChannel: PromptMirrorChannelResolver;
  log?: Logger;
}): PromptMirror {
  const log = deps.log ?? createLogger('notify');
  return {
    async mirror(input: PromptMirrorInput): Promise<void> {
      let channel: PromptMirrorChannel | null;
      try {
        channel = await deps.resolveChannel();
      } catch (error) {
        // 通道本身配坏了（开着通知却没地址等）。同样只记日志：
        // 镜像坏了不该让主流程停下来。
        log.error(`提示词镜像：取通知通道失败：${reasonOf(error)}`);
        return;
      }
      if (channel === null) return;
      // 没勾这一项就一次都不发。
      const kind = PROMPT_SOURCE_INFO[input.source].kind;
      if (!channel.kinds.includes(kind)) return;

      try {
        await channel.notifier.notify(buildPromptEvent(input));
      } catch (error) {
        log.error(`提示词镜像：推送失败：${reasonOf(error)}`);
      }
    },
  };
}

/**
 * 从运行期设置里解析通道。**每条提示词调一次**。
 *
 * 解析顺序：**库里（控制面录入，密文）优先，配置文件 + 环境变量兜底**——
 * 判据只有 `resolveNotifySettings` 一份实现（§6.9.1 规则 1）。
 *
 * @returns 通知没启用时为 `null`（镜像就什么都不做）。
 * @throws SyncError 'CONFIG_INVALID' 通知开着却没有 webhook 地址。
 */
export function createNotifyChannelResolver(input: {
  pool: Pool;
  /** 主密钥。没注入就读不到控制面录入的那一份（对这两个 app 来说是可选的）。 */
  masterKey: Buffer | null;
  /** 配置文件里的 `notify` 段。 */
  config: NotifyConfig;
}): PromptMirrorChannelResolver {
  return async (): Promise<PromptMirrorChannel | null> => {
    const resolved = await resolveNotifySettings({
      pool: input.pool,
      masterKey: input.masterKey,
      config: input.config,
    });
    if (!resolved.settings.enabled) return null;
    return {
      notifier: createNotifier({
        webhookUrl: resolved.settings.webhookUrl,
        secret: resolved.settings.secret,
      }),
      kinds: resolved.settings.kinds,
    };
  };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
