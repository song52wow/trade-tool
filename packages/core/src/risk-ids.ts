/**
 * 止盈止损条件单的**编号约定**（v0.4.0 写下，v0.6.0 上移到 core，v0.9.2 加档位序号）。
 *
 * 为什么必须在 core 而不是留在 `apps/executor`：v0.6.0 的交易对账要靠这个约定把
 * 交易所挂着的条件单认回本地记录。它原本只长在下单那一层，于是对账如果自己再写一遍
 * 前缀解析，就有了**两份会漂移的判据**——而漂移的症状是「止损挂在错误的仓位上」，
 * 那在日志与页面上都完全看不出来。
 *
 * 约定本身：`rsk-<tp|sl><档位序号>-<entryOrderId>`，整串截断到 36 字符
 * （Binance 的 `clientOrderId` / `clientAlgoId` 长度上限）。
 *
 * ## 为什么有「档位序号」
 *
 * 移动止损每挪一档就要**挂一张新的止损单**（§6.8 第 3 条：先挂新、再撤旧）。
 * 而 Binance **不允许同时存在两张 `clientAlgoId` 相同的挂单**——重复会直接被拒
 * （`ClientOrderId is duplicated.`）。
 *
 * 2026-10-22 实测踩到：止损单的自定义号只由「入场单号」派生（`rsk-sl-<入场单号>`），
 * 于是**每次挪止损用的都是同一个号**。第一次挪就被拒——因为进场时挂的那张止损单
 * 用的也是这个号，而它还在交易所上挂着（挪单是「先挂新再撤旧」，旧单此刻还在）。
 *
 * 后果不是「挪第二次失败」，而是**一次都挪不成**：
 *   * 止损价永远停在入场那一档，移动止损这条线整个是空转的；
 *   * 而账面、交易所、对账三方全绿——止损单确实在交易所上，价格也确实对得上，
 *     只是那个价**从来没被更新过**。
 *
 * 档位序号让每一张止损单有自己的号：进场的止损单是 0 号（`rsk-sl-<入场单号>`，
 * 与旧版本逐字相同，交易所上已存在的单不必动），挪过第 N 档的是 N 号
 * （`rsk-sl<N>-<入场单号>`）。**号永不复用**，于是「先挂新、再撤旧」这条顺序得以保留
 * （撤旧会有无保护窗口，见 §6.8 第 3 条）。
 */

import { SyncError } from './market-sync.js';

/** 我们自己下的两张条件单的 clientOrderId 前缀。用来把自己的成交认出来。 */
export const RISK_CLIENT_ID_PREFIX = 'rsk';

/** Binance 的 clientOrderId 长度上限。条件单侧叫 clientAlgoId，正则与长度同源。 */
export const CLIENT_ID_MAX = 36;

export type BracketTag = 'tp' | 'sl';

/**
 * 由入场订单号派生条件单的 clientOrderId。
 *
 * @param step **档位序号**：0 = 进场时挂的那张（与旧版本逐字相同）；
 *   N ≥ 1 = 移动止损挪到第 N 档时挂的那张。**每一次挪单都必须传一个没被用过的号**，
 *   否则 Binance 会以「ClientOrderId is duplicated」拒单。
 */
export function bracketClientOrderId(tag: BracketTag, entryOrderId: string, step = 0): string {
  // 序号只在「大于 0」时出现：0 号沿用旧格式，交易所上已经挂着的那张单不用改号。
  const suffix = step > 0 ? String(step) : '';
  return `${RISK_CLIENT_ID_PREFIX}-${tag}${suffix}-${entryOrderId}`.slice(0, CLIENT_ID_MAX);
}

/**
 * 反解：这是不是我们挂的单？是的话返回是哪一张、哪一档、对应哪个入场订单号。
 *
 * 不是我们的一律返回 `null`（用户自己在网页上下的单走这里），而**形状不对的
 * `rsk-` 前缀单返回 `null` 而不是抛错**：它只是「不是我方格式」，不是异常。
 */
export function parseBracketClientOrderId(
  clientOrderId: string,
): { tag: BracketTag; entryOrderId: string; step: number } | null {
  if (!clientOrderId.startsWith(`${RISK_CLIENT_ID_PREFIX}-`)) return null;
  const rest = clientOrderId.slice(RISK_CLIENT_ID_PREFIX.length + 1);
  const dash = rest.indexOf('-');
  if (dash < 0) return null;
  const tagPart = rest.slice(0, dash);
  const entryOrderId = rest.slice(dash + 1);
  // 档位序号紧跟在 tag 后面（`sl1` / `sl12`），因此**序号不会被 36 字符截断吃掉**——
  // 截断只可能切到入场单号那一段。
  const matched = /^(tp|sl)(\d+)?$/.exec(tagPart);
  if (matched === null) return null;
  const step = matched[2] === undefined ? 0 : Number(matched[2]);
  if (!Number.isSafeInteger(step) || step < 0) return null;
  if (entryOrderId === '') return null;
  return { tag: matched[1] as BracketTag, entryOrderId, step };
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

// ------------------------------------------------------------------ Agent 进场单

/**
 * Agent 进场单的自定义号前缀（v1.0.0 自动下单）。
 *
 * 与 `rsk-` 分开是因为**编号空间不同**：`rsk-` 是条件单（`clientAlgoId`），
 * 这一类是**普通市价单**（`newClientOrderId`）。两者的前缀混用会让对账与
 * 「这张单是不是我方挂的」判断同时失灵——所以宁可多一个前缀，也不要共用一个。
 */
export const AGENT_CLIENT_ID_PREFIX = 'agt';

/**
 * 由方案 id 与尝试次数派生进场单的自定义号：`agt-p<方案id>-a<第几次尝试>`。
 *
 * **为什么带尝试次数**：Binance 不允许两张 `clientOrderId` 相同的挂单同时存在，
 * 沿用同一个号重试必然撞「重复」，于是重试永远失败（与止损单号复用同一个坑，
 * 见本文件开头）。号里带次数，重试就自动换号。
 *
 * 截断到 36 字符（Binance 的长度上限）。方案 id 是 bigint，位数有限，
 * 正常情况下根本不会触发截断——但**不能依赖「正常情况」**：超长会被交易所拒，
 * 而那种失败长得很像网络问题。
 */
export function agentEntryClientOrderId(planId: string, attempt: number): string {
  return `${AGENT_CLIENT_ID_PREFIX}-p${planId}-a${attempt}`.slice(0, CLIENT_ID_MAX);
}

/**
 * 反解：这是不是 Agent 挂的进场单？是的话返回方案 id 与第几次尝试。
 *
 * 不是我们的一律返回 `null`（用户自己在网页上下的单走这里），
 * 形状不对的 `agt-` 前缀单也返回 `null`——它只是「不是我方格式」，不是异常。
 */
export function parseAgentEntryClientOrderId(
  clientOrderId: string,
): { planId: string; attempt: number } | null {
  if (!clientOrderId.startsWith(`${AGENT_CLIENT_ID_PREFIX}-`)) return null;
  const rest = clientOrderId.slice(AGENT_CLIENT_ID_PREFIX.length + 1);
  const matched = /^p(\d+)-a(\d+)$/.exec(rest);
  if (matched === null) return null;
  const attempt = Number(matched[2]);
  if (!Number.isSafeInteger(attempt) || attempt <= 0) return null;
  return { planId: matched[1] as string, attempt };
}

