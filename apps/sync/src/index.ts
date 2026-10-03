/**
 * `@trade-tool/sync` 的公共入口 —— 交付给控制面的原语（R-22）。
 *
 * 控制面只需要 `createSyncService` 返回的对象，**不需要**了解 PG schema、
 * 回补队列或退避策略的任何内部细节（R-22.5）。这里不导出任何 HTTP 相关类型。
 */

export {
  SyncControl,
  type ControlPrimitives,
  type PrimitivesOptions,
  type RuntimeSlot,
} from './primitives.js';
export { SyncDaemon, createDaemon, type DaemonOptions } from './daemon.js';
export {
  createSyncService,
  createSyncServiceFromConfig,
  type SyncService,
  type SyncServiceOptions,
} from './service.js';
