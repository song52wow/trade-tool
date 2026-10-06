import { parseStoredInterval } from '@trade-tool/data';
import { SyncError } from '@trade-tool/core';

/**
 * 默认取最近 300 根。
 *
 * 1m 下约 5 小时：够看清一段形态，又不至于让每次首屏响应过大。看更长区间由页面显式
 * 选择，不靠「默认多给点」解决。
 *
 * 派生周期沿用同一个根数缺省：300 根 4h 约 50 天、300 根 1d 约 10 个月，量级都还在
 * 一次响应能承受的范围内；而**按时间**换算根数会让不同周期出现完全不同的 limit，
 * 那正是「用户以为在看 4h、实际只拿到 5 天数据」这类误解的来源（R-7.1）。
 */
export const DEFAULT_BAR_LIMIT = 300;

/**
 * 单次取数的硬上限（R-23.5）。
 *
 * 这是给 HTTP 查询路径设的闸门。这条 SQL 走主键倒序 LIMIT，本身不贵，但参数一旦能
 * 放到十万行，响应体与序列化就会变成一次无上限的重活儿——而它挂在页面首屏的刷新
 * 节奏上，会把整个轮询拖住。超限**截断**而不是报错：用户选「看更多」时给一张被截断
 * 的图没有意义，但把它连同「实际生效上限」一起回给页面，至少不会被当成完整数据。
 */
export const MAX_BAR_LIMIT = 2000;

/** 把任意数值夹到 [1, MAX_BAR_LIMIT] 内的整数；非有限数按缺省处理。 */
export function clampBarLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_BAR_LIMIT;
  return Math.min(MAX_BAR_LIMIT, Math.max(1, Math.trunc(limit)));
}

/**
 * 解析 `?limit=` 查询参数。
 *
 * 非法值（0、负数、小数、非数字）直接报错而不是默默用缺省：页面自己拼的参数出错时，
 * 静默换成另一个值只会让人以为「数据就这么多」。超出上限则截断到上限。
 */
export function parseBarLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_BAR_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new SyncError('CONFIG_INVALID', `limit 必须是正整数，收到：${raw}`, { limit: raw });
  }
  return Math.min(parsed, MAX_BAR_LIMIT);
}

/**
 * 解析 `?interval=`（v0.2.0 R-7.1）。
 *
 * 缺省 `1m`（向后兼容）；非法或**未实现**的周期（`5m` / `2h` / `foo`）报
 * `CONFIG_INVALID` → 400。
 *
 * **绝不静默回落到 1m**：用户以为在看 4h、实际拿到 1m，正是最典型的静默兜底——
 * 图能画出来，只是每根蜡烛只有 1 分钟数据，不报错也没人发现。
 */
export function parseIntervalParam(raw: string | undefined) {
  return parseStoredInterval(raw);
}
