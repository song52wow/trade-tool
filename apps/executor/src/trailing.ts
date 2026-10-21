/**
 * 移动止损的周期任务（v0.7.0）。
 *
 * **与对账定时器分开**（AGENTS.md §6.8）：对账是纯只读的（§6.5 第 1 条），而移动止损
 * 要挂单撤单。合成一个定时器会让「对账绝不动手」这条保证失守，而那条保证正是让
 * 「自动修复」与「报告」之间风险不对称的原因。
 *
 * 三条边界：
 *   1. **启动立刻跑一次**。重启往往正是需要补挂的时刻（进程死在「已置 `trailing`、
 *      还没挂新止损」那一格），启动后再等一个周期才补，等于把最该立刻发现的那类
 *      缺口往后推。
 *   2. **本轮失败绝不影响挂单**。它是旁观者，抛出去就等于「追踪挂了 → 止盈止损也停了」。
 *   3. **不新增常驻进程、不新增出网取价**。取数走本地 PG（`quant_data.risk`）。
 */

import { createLogger } from '@trade-tool/core';

import type { ExecutorService, TrailReport } from './service.js';

const log = createLogger('executor');

export interface StartTrailingOptions {
  /** 可注入时钟，测试里固定住。 */
  setIntervalImpl?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalImpl?: (handle: NodeJS.Timeout) => void;
}

export interface TrailingTimer {
  /** 停止定时器。**退出时必须调用**，否则进程不会结束。 */
  stop(): void;
}

/**
 * 启动移动止损周期任务。`intervalMs = 0` 表示**关闭自动移动**，
 * 返回空实现——第一段仍会正常减仓，只是不再自动挪止损。
 */
export function startTrailingTimer(
  service: Pick<ExecutorService, 'trailOnce'>,
  intervalMs: number,
  options: StartTrailingOptions = {},
): TrailingTimer {
  if (intervalMs === 0) {
    log.info('executor.trailIntervalMs = 0：移动止损自动重算已关闭');
    return { stop: () => undefined };
  }

  const setIntervalImpl =
    options.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms) as unknown as NodeJS.Timeout);
  const clearIntervalImpl =
    options.clearIntervalImpl ?? ((handle) => clearInterval(handle as unknown as number));

  let running = false;
  const tick = (): void => {
    // 防重入：上一轮还没跑完就跳过这一轮，而不是让两轮同时挂撤同一张单。
    if (running) return;
    running = true;
    void service
      .trailOnce()
      .then((report: TrailReport) => {
        if (report.moved > 0 || report.failed > 0 || report.advanced > 0) {
          log.info(
            `移动止损一轮：推进 ${report.advanced} / 换档 ${report.moved} / 未变 ${report.unchanged} / ` +
              `失败 ${report.failed} / 跳过 ${report.skipped}`,
          );
        }
      })
      .catch((error: unknown) => {
        log.error(
          `移动止损本轮失败（不影响挂单）：${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        running = false;
      });
  };

  tick();
  const handle = setIntervalImpl(tick, intervalMs);
  log.info(`移动止损已启用：每 ${String(intervalMs / 1000)} 秒重算一次`);

  return {
    stop(): void {
      clearIntervalImpl(handle);
    },
  };
}
