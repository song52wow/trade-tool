/**
 * 止盈止损服务自己的健康状态（2026-11-06）。
 *
 * ## 为什么需要这一层
 *
 * 2026-11-06 在目标机 192.168.1.90 上实测到的那一次：
 * 币安把私有接口全拒了（`-2015 Invalid API-key, IP, or permissions`），
 * 于是 executor 这条链整条死掉——
 *
 *   * 用户数据流拿不到 listenKey → 看不见成交 → **不挂止盈止损**；
 *   * 周期对账也跑不通 → **连「仓位没有保护」这条告警都发不出来**
 *     （对账失败就没有差异清单，而差异清单正是告警的原料）。
 *
 * 结果：止盈止损从 10-31 03:49 起彻底停摆，**一条消息都没发出来**，
 * 而交易所上那个仓位一直是裸的。日志里全是错误，但**没人盯着日志**。
 *
 * 与 2026-10-25 那次「同步停摆静默 5 小时 55 分」是同一类病（见 AGENTS.md §6.9）。
 * 治法也一样：给「自己不可用」这件事一个出口。
 *
 * ## 两条口径
 *
 * 1. **「活着」与「能用」分开**：心跳照跳不代表服务能用（私有接口全挂时心跳是新的）。
 *    合成一个「在线」就会骗人——这正是这次静默 6 天的形状。
 * 2. **持续不可用才算不可用**：一次网络抖动不该推一条告警。
 *    「同一件事每轮都推」会把告警变成噪声，而**噪声等于没接**
 *    （本文件同族的 `AlertDispatcher` 文件头说的就是这件事）。
 *    因此这里记的是「**从什么时候开始**一直不可用」，由调用方按阈值判断。
 *
 * 纯逻辑：不读时钟、不做 IO、不用随机数。时钟由调用方注入。
 */

/**
 * 私有接口的健康状态。
 *
 * `unavailableSince` 是这套状态的**核心**：它记的是「本次持续不可用的起点」，
 * 恢复后清空，于是「不可用了多久」不需要靠次数去猜。
 */
export interface PrivateApiHealth {
  /** 最近一次私有接口**成功**的时刻；一次都没成功过时为 `null`。 */
  lastOkAt: number | null;
  /**
   * 本次**持续不可用**的起点；现在是可用的（或还没出过事）时为 `null`。
   *
   * 连续失败期间它**保持不变**：每次失败都刷新它的话，「不可用了多久」
   * 永远从头算，持续故障就永远达不到阈值。
   */
  unavailableSince: number | null;
  /** 连续失败次数。恢复后归零。 */
  failureCount: number;
  /** 最近一次失败的错误码。 */
  lastErrorCode: string | null;
  /** 最近一次失败的原话。 */
  lastErrorMessage: string | null;
}

/**
 * 私有接口**持续不可用**多久才算「真不可用」（毫秒）。
 *
 * 取 120 秒的理由：executor 的重连退避上限是 60 秒，因此一次真的故障
 * （key 被拒、代理掐断）在两分钟内必然重试过好几轮；而一次偶发的网络抖动
 * 通常在几秒内就恢复。120 秒把这两类分开：
 * 前者会推一条告警，后者不会。
 */
export const PRIVATE_API_UNAVAILABLE_THRESHOLD_MS = 120_000;

/** 初始状态：还没调用过私有接口。 */
export function initialPrivateApiHealth(): PrivateApiHealth {
  return {
    lastOkAt: null,
    unavailableSince: null,
    failureCount: 0,
    lastErrorCode: null,
    lastErrorMessage: null,
  };
}

/**
 * 记一次**成功**的私有接口调用。
 *
 * 成功会把 `unavailableSince` 清空——于是「恢复了」这件事由状态自己表达，
 * 派发器靠「上一轮有、这一轮没有」推出那条「已恢复」（与对账告警同一套口径）。
 */
export function applyPrivateApiSuccess(health: PrivateApiHealth, now: number): PrivateApiHealth {
  return {
    lastOkAt: now,
    unavailableSince: null,
    failureCount: 0,
    lastErrorCode: null,
    lastErrorMessage: null,
  };
}

/**
 * 记一次**失败**的私有接口调用。
 *
 * ⚠️ **只该传「私有接口不可用」那类错误**（鉴权被拒、时钟越界、连不上），
 * 不要把业务失败（余额不足、参数非法）也塞进来——那会把「下单被拒」
 * 说成「服务不可用」，而这两件事的处置完全不同。
 * 分类由 `packages/data/src/binance-private.ts` 的 `isPrivateApiUnusableError` 做。
 */
export function applyPrivateApiFailure(
  health: PrivateApiHealth,
  now: number,
  failure: { code: string; message: string },
): PrivateApiHealth {
  return {
    lastOkAt: health.lastOkAt,
    unavailableSince: health.unavailableSince ?? now,
    failureCount: health.failureCount + 1,
    lastErrorCode: failure.code,
    lastErrorMessage: failure.message,
  };
}

/**
 * 私有接口是不是**持续**不可用到值得告警的程度。
 *
 * 「持续」由 {@link PRIVATE_API_UNAVAILABLE_THRESHOLD_MS} 决定：
 * 抖动不告警，真的断掉才告警。
 */
export function isPrivateApiUnavailable(
  health: PrivateApiHealth,
  now: number,
  thresholdMs: number = PRIVATE_API_UNAVAILABLE_THRESHOLD_MS,
): boolean {
  if (health.unavailableSince === null) return false;
  return now - health.unavailableSince >= thresholdMs;
}

/**
 * 不可用了多久（毫秒）。现在是可用的时为 0。
 *
 * 给告警文案用：「已经瞎了 N 分钟」比「N 次失败」有信息量——
 * 次数会因重试节奏而变，久不会。
 */
export function privateApiUnavailableMs(health: PrivateApiHealth, now: number): number {
  if (health.unavailableSince === null) return 0;
  return Math.max(0, now - health.unavailableSince);
}
