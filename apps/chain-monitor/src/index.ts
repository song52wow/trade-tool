/**
 * 链上仓位监控的对外出口。
 *
 * 只导出**编排与文案**两层：
 *   * `service.ts`：一轮监控怎么走（读链 → 算账 → 落库 → 判定 → 推送）；
 *   * `alert.ts`：判据变成一条通知文案。
 *
 * 判据在 `@trade-tool/core`（`chain-alert.ts`）、算账在 `chain-v3.ts`、
 * 读链在 `@trade-tool/data`（`bsc-v3.ts`）——那些不重复导出，
 * 「同一个概念只有一个名字」（AGENTS.md §5 第 5 条）。
 */

export * from './alert.js';
export * from './service.js';
