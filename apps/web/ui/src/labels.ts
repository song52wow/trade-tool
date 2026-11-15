import type { SyncStatus } from '@trade-tool/core';

import type { DaemonStatusDto, ExecutorStatusDto } from '../../src/types';

/**
 * 状态 → 中文标签的**唯一一份**。
 *
 * 这些表原来分散在 `App.tsx`（顶栏）、`OverviewCards.tsx`（卡片）与 `SymbolTable.tsx`
 * （表格）里，同一屏对同一个概念能出现两套说法（「同步中」vs `running`），
 * 而 `App.tsx` 的注释自己写着「两处各写一份，迟早会有一处先改掉」——
 * 复制正好制造它担心的那件事。集中到一处之后，`tsc` 还会在状态枚举新增成员时报错。
 *
 * 只依赖**类型**（`import type`）：浏览器构建不能引 `@trade-tool/core` 的运行时
 * （barrel 里带 node 内置模块），类型在编译期被擦除，因此安全。
 */

/** 守护进程三态。`stale`（心跳超时）与 `stopped`（没有心跳）处置完全不同，不能合并。 */
export const DAEMON_LABEL: Record<DaemonStatusDto['state'], string> = {
  running: '运行中',
  stale: '心跳超时',
  stopped: '未运行',
};

/**
 * 止盈止损服务三态。**与守护进程同构但不是同一个进程**：
 * 「私有接口不可用」单独一档（进程活着 ≠ 服务能用），所以值相同、语义不同，不合并。
 */
export const EXECUTOR_LABEL: Record<ExecutorStatusDto['state'], string> = {
  running: '运行中',
  stale: '心跳超时',
  stopped: '未运行',
};

/** 同步状态（`sync_state.status`）：卡片与表格共用。 */
export const SYNC_STATUS_LABEL: Record<SyncStatus, string> = {
  running: '同步中',
  paused: '已暂停',
  error: '出错',
};

/** 期望状态（`symbols.desired_state`）：说的是「该不该同步」，不是「上一轮成没成」。 */
export const DESIRED_STATE_LABEL: Record<'running' | 'paused', string> = {
  running: '期望运行',
  paused: '期望暂停',
};
