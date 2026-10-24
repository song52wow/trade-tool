/**
 * Agent 守护进程（v1.0.0）。
 *
 * ## 它只做一件事
 *
 * 每隔一段时间，对**每个标的**跑一轮「分析 → 出方案」。别的什么都不干——
 * 不拉行情（那是 `apps/sync` 的活）、不下单（那是 `apps/executor` 的活）、
 * 不改标的状态（那是控制面的活）。
 *
 * ## 三个刻意的选择
 *
 * 1. **标的集合每轮重读**：控制面随时可能加标的、删标的。启动时读一次就固化，
 *    会让「刚加的标的永远没人分析」变成一件没人发现的事。
 * 2. **单个标的出错不影响其它标的**：一个标的的上下文取不到（库里没 K 线），
 *    不该让整轮剩下的人都不分析。错误逐个记录、逐个打日志。
 * 3. **不并发**：一轮里按标的**顺序**跑。并发会让模型调用同时打出去，
 *    既超配额又让「这一轮的分析顺序」变得不确定——而留痕是要能按顺序读懂的。
 */

import { createLogger, type AgentConfig, type Logger } from '@trade-tool/core';

import type { AgentRoundResult, AgentService } from './service.js';

/** 守护进程的依赖。 */
export interface AgentDaemonOptions {
  service: AgentService;
  config: AgentConfig;
  /** 列本轮要分析的标的。每轮重读。 */
  listSymbols: () => Promise<string[]>;
  /** 日志出口。 */
  log?: Logger;
  /** 休眠。测试可注入假实现（否则测试要真等 15 分钟）。 */
  sleep?: (ms: number) => Promise<void>;
}

/** 守护进程。 */
export interface AgentDaemon {
  /** 跑一轮（不睡）。测试与 CLI 都用它。 */
  tick(): Promise<AgentRoundResult[]>;
  /** 启动循环。 */
  start(): Promise<void>;
  /**
   * 请求停止。**立刻返回**——它只做两件事：置停止标志、唤醒那段休眠。
   *
   * 「本轮跑完没有」由 {@link whenStopped} 回答，别把两者混成一个等待：
   * 混起来会死锁——循环本身在 `sleep` 里，而 `sleep` 里可能正调着 `stop()`。
   */
  stop(): Promise<void>;
  /**
   * 循环真正退出时兑现。
   *
   * 进程收到 SIGTERM 后要**等这一轮跑完**再退出：半轮（落了报告没落方案）
   * 是「看起来成功了，其实什么都没做」的一种——页面上会有一份报告，
   * 而与之对应的方案永远不会有。
   */
  whenStopped(): Promise<void>;
}

/**
 * 建守护进程。
 *
 * `intervalMs` 至少 1 分钟：一轮要调两次模型（分析师 + 交易员），
 * 再加上出网取情绪面，标的多了以后一分钟一轮都不算快。**更频繁只是烧配额。**
 */
export function createAgentDaemon(options: AgentDaemonOptions): AgentDaemon {
  const { service, config } = options;
  const log = options.log ?? createLogger('agent');
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let stopped = false;
  let running = false;
  /** 唤醒「下一轮」的休眠：停止时用它把 15 分钟的等待立刻打断。 */
  let wakeSleep: (() => void) | null = null;
  /** 循环退出时兑现的兑现器。 */
  let resolveLoopExited: (() => void) | null = null;
  let loopExited: Promise<void> = Promise.resolve();

  /**
   * 等到下一轮，但**能被停止打断**。
   *
   * 不打断的话，`agent.intervalMs` 缺省 15 分钟——收到 SIGTERM 后要再等满
   * 15 分钟才退出。进程管理器（systemd / docker）通常只给 10 秒宽限，
   * 于是实际结果是**被强杀**：这一轮跑到一半，数据停在半路。
   */
  async function sleepUntilNextRound(ms: number): Promise<void> {
    if (stopped) return;
    await Promise.race([
      sleep(ms),
      new Promise<void>((resolve) => {
        wakeSleep = resolve;
      }),
    ]);
    wakeSleep = null;
  }

  return {
    async tick(): Promise<AgentRoundResult[]> {
      const symbols = await options.listSymbols();
      if (symbols.length === 0) {
        log.warn('没有可分析的标的：库里的标的一个都没有，或配置里没写');
        return [];
      }
      const results: AgentRoundResult[] = [];
      for (const symbol of symbols) {
        if (stopped) break;
        try {
          results.push(await service.analyzeSymbol(symbol));
        } catch (error) {
          // 单个标的出错不能拖垮整轮。错误已经落库（`action = 'failed'`），
          // 这里再打一行日志，让人知道**是哪个标的**出的问题。
          const message = error instanceof Error ? error.message : String(error);
          log.error(`${symbol} 本轮失败：${message}`);
        }
      }
      return results;
    },

    async start(): Promise<void> {
      running = true;
      stopped = false;
      loopExited = new Promise<void>((resolve) => {
        resolveLoopExited = resolve;
      });
      log.info(
        `开始运行：每 ${String(config.intervalMs / 60_000)} 分钟一轮，` +
          `周期 ${config.interval}，权重 ${JSON.stringify(config.weights)}`,
      );
      try {
        while (!stopped) {
          const startedAt = Date.now();
          try {
            const results = await this.tick();
            const failed = results.filter((r) => r.failure !== null).length;
            log.info(
              `一轮结束：${String(results.length)} 个标的，` +
                `${String(failed)} 个未出方案，耗时 ${String(Date.now() - startedAt)}ms`,
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log.error(`一轮失败：${message}`);
          }
          if (stopped) break;
          await sleepUntilNextRound(config.intervalMs);
        }
      } finally {
        running = false;
        resolveLoopExited?.();
        resolveLoopExited = null;
      }
    },

    async stop(): Promise<void> {
      stopped = true;
      // 打断那段休眠：否则要等满 intervalMs（缺省 15 分钟）才轮到循环检查标志。
      wakeSleep?.();
      log.info(running ? '收到停止信号，本轮结束后退出…' : '已停止');
    },

    async whenStopped(): Promise<void> {
      await loopExited;
    },
  };
}
