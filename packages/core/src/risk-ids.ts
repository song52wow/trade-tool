/**
 * 止盈止损条件单的**编号约定**（v0.4.0 写下，v0.6.0 上移到 core）。
 *
 * 为什么必须在 core 而不是留在 `apps/executor`：v0.6.0 的交易对账要靠这个约定把
 * 交易所挂着的条件单认回本地记录。它原本只长在下单那一层，于是对账如果自己再写一遍
 * 前缀解析，就有了**两份会漂移的判据**——而漂移的症状是「止损挂在错误的仓位上」，
 * 那在日志与页面上都完全看不出来。
 *
 * 约定本身：`rsk-<tp|sl>-<entryOrderId>`，整串截断到 36 字符（Binance 的
 * `clientOrderId` / `clientAlgoId` 长度上限）。
 */

import { SyncError } from './market-sync.js';

/** 我们自己下的两张条件单的 clientOrderId 前缀。用来把自己的成交认出来。 */
export const RISK_CLIENT_ID_PREFIX = 'rsk';

/** Binance 的 clientOrderId 长度上限。条件单侧叫 clientAlgoId，正则与长度同源。 */
export const CLIENT_ID_MAX = 36;

export type BracketTag = 'tp' | 'sl';

/** 由入场订单号派生条件单的 clientOrderId。 */
export function bracketClientOrderId(tag: BracketTag, entryOrderId: string): string {
  return `${RISK_CLIENT_ID_PREFIX}-${tag}-${entryOrderId}`.slice(0, CLIENT_ID_MAX);
}

/**
 * 反解：这是不是我们挂的单？是的话返回是哪一张与对应的入场订单号。
 *
 * 不是我们的一律返回 `null`（用户自己在网页上下的单走这里），而**形状不对的
 * `rsk-` 前缀单返回 `null` 而不是抛错**：它只是「不是我方格式」，不是异常。
 */
export function parseBracketClientOrderId(
  clientOrderId: string,
): { tag: BracketTag; entryOrderId: string } | null {
  if (!clientOrderId.startsWith(`${RISK_CLIENT_ID_PREFIX}-`)) return null;
  const rest = clientOrderId.slice(RISK_CLIENT_ID_PREFIX.length + 1);
  const dash = rest.indexOf('-');
  if (dash < 0) return null;
  const tag = rest.slice(0, dash);
  const entryOrderId = rest.slice(dash + 1);
  if ((tag !== 'tp' && tag !== 'sl') || entryOrderId === '') return null;
  return { tag, entryOrderId };
}

/**
 * 把条件单的 `orderType` 认成 tp / sl。
 *
 * **两侧的取值确实不一样**，而且比文档示例更麻烦（核对 2026-10-11）：
 *
 *   * 下单时我们发 `TAKE_PROFIT_MARKET` / `STOP_MARKET`；
 *   * 官方文档 `GET /fapi/v1/openAlgoOrders` 的示例回 `TAKE_PROFIT` / `STOP`；
 *   * **实测（同一接口、同一天、真实账户）回的却是 `TAKE_PROFIT_MARKET` / `STOP_MARKET`**。
 *
 * 也就是说文档示例不能当契约——它至少与实际行为不一致。因此这里按**前缀**认
 * （`TAKE_PROFIT*` / `STOP*`），上面三种写法都命中，且新增后缀时不会静默失配。
 *
 * 这也正是「读到的文档必须与代码里实际在用的口径对照」的另一个例子：只按文档写死
 * `=== 'STOP'`，实盘上会把每一张止损单都判成「认不出来的类型」而整份对账抛错。
 *
 * 认不出来的类型**抛错**而不是猜一个：把一个不认识的类型静默当成止损，会凭空造出
 * 一条「止损单存在」的结论，而它恰好是最不能错的那条。
 */
export function algoOrderTag(orderType: string): BracketTag {
  if (orderType.startsWith('TAKE_PROFIT')) return 'tp';
  if (orderType.startsWith('STOP')) return 'sl';
  throw new SyncError('EXCHANGE_ERROR', `无法识别的条件单类型：${orderType}`, { orderType });
}
