/**
 * 周期任务的**唯一一份**装配：启动即跑一次、防重入、失败只记日志、stop 停表。
 *
 * 这段逻辑原来在 `trailing.ts` / `plan-execution.ts` / `reconcile.ts` 各写了一遍，
 * 三份之间已经开始漂移：对账那份一度**没有防重入**（两轮并发写同一份快照，
 * 2026-11-12 审计发现）。复制带来的从来不是省事，而是「改了两处、忘了第三处」。
 *
 * 三条边界（三处任务共用）：
 *   1. **启动立刻跑一次**：重启往往正是需要补做的时刻，等一个周期等于把它往后推。
 *   2. **失败不影响主流程**：这些任务都是「旁观者」或「补做」，抛出去会连累挂单/对账。
 *   3. **防重入**：上一轮没跑完就跳过这一轮，而不是让两轮同时改同一份数据。
 */

import { createLogger } from '@trade-tool/core';

const log = createLogger('executor');

export interface PeriodicTaskOptions {
  /** 间隔毫秒；**0 = 关闭**（返回空实现，不建定时器、不跑首轮）。 */
  intervalMs: number;
  /** 日志与告警文案里的名字（「移动止损」「自动对账」「方案执行」）。 */
  label: string;
  /** 关闭时那句话（说明是哪个配置项关的）。 */
  disabledMessage: string;
  /** 启用时那句话（含间隔）。 */
  enabledMessage: (intervalMs: number) => string;
  /** 一轮干什么。抛出的异常会被兜住并记日志。 */
  tick: () => Promise<void>;
  /**
   * 跳过这一轮时是否打 warn。
   *
   * 对账默认 5 分钟一轮，跳过说明真的慢了，值得说一句；移动止损 5 秒一轮，
   * 偶尔跳过是正常抖动，每跳一次打一行会把日志刷满。
   */
  warnOnSkip?: boolean;
  /** 测试注入：替换真实定时器。 */
  setIntervalImpl?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalImpl?: (handle: NodeJS.Timeout) => void;
}

export interface PeriodicTask {
  /** 停止定时器。**退出时必须调用**，否则进程不会结束。 */
  stop(): void;
}

export function startPeriodicTask(options: PeriodicTaskOptions): PeriodicTask {
  const { intervalMs, label } = options;

  if (intervalMs === 0) {
    log.info(options.disabledMessage);
    return { stop: () => undefined };
  }

  const setIntervalImpl =
    options.setIntervalImpl ??
    ((fn: () => void, ms: number) => setInterval(fn, ms) as unknown as NodeJS.Timeout);
  const clearIntervalImpl =
    options.clearIntervalImpl ??
    ((handle: NodeJS.Timeout) => clearInterval(handle as unknown as number));

  let running = false;
  const tick = (): void => {
    if (running) {
      if (options.warnOnSkip === true) {
        log.warn(`${label}：上一轮还没结束，跳过这一轮（间隔 ${String(intervalMs / 1000)} 秒）`);
      }
      return;
    }
    running = true;
    void options
      .tick()
      .catch((error: unknown) => {
        log.error(
          `${label}本轮失败（不影响挂单）：${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        running = false;
      });
  };

  tick();
  const handle = setIntervalImpl(tick, intervalMs);
  log.info(options.enabledMessage(intervalMs));

  return {
    stop(): void {
      clearIntervalImpl(handle);
    },
  };
}
