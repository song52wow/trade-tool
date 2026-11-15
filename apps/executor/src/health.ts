/**
 * 止盈止损服务自己的健康监控（2026-11-06）。
 *
 * ## 为什么需要它
 *
 * 2026-11-06 在目标机 192.168.1.90 上实测：币安把私有接口全拒了（`-2015`），
 * executor 于是既挂不出单、也跑不出对账。止盈止损从 10-31 03:49 起彻底停摆，
 * 而**一条消息都没发出来**——因为对账正是告警的原料，对账一挂，告警链整条断掉。
 *
 * 那 6 天里交易所上一直有个裸仓。没人知道。
 *
 * 治法与 2026-10-25 那次「同步停摆静默 5 小时 55 分」一样（见 `apps/sync/src/alert.ts`）：
 * **给「自己不可用」这件事一个出口**，而不是指望日志被人盯着。
 *
 * ## 三条口径
 *
 * 1. **推送绝不影响挂单**：通知是给人看的，挂单是活干。推送失败只记日志。
 * 2. **「活着」与「能用」分开记**：心跳照跳不代表服务能用。状态行里两组列分开摆，
 *    控制面才不会显示出一个骗人的「在线」。
 * 3. **持续不可用才告警**：一次网络抖动不推（`packages/core/src/executor-health.ts`
 *    的阈值负责这件事）。刷屏的告警等于没接。
 *
 * 判据在 core（纯函数）、交易所差异在 `packages/data`，本文件只做接线。
 */

import {
  AlertDispatcher,
  applyPrivateApiFailure,
  applyPrivateApiSuccess,
  createLogger,
  initialPrivateApiHealth,
  isPrivateApiUnavailable,
  privateApiUnavailableMs,
  type AlertItem,
  type PrivateApiHealth,
} from '@trade-tool/core';
import {
  isPrivateApiUnusableError,
  markExecutorPrivateApi,
  upsertExecutorStatus,
  type Pool,
} from '@trade-tool/data';

const log = createLogger('executor:health');

/**
 * 记账作用域。
 *
 * 与 executor 的对账告警**分开**：对账那条「已恢复」不该把这里的记账当成
 * 「问题消失了」，反之亦然（`AlertDispatcher` 文件头的说明）。
 */
export const EXECUTOR_ALERT_SCOPE = 'executor-health';

/**
 * 健康汇报的间隔（毫秒）。
 *
 * 60 秒：比心跳（10 秒）慢，因为汇报要走飞书；而告警的冷却期是 30 分钟，
 * 汇报再快也不会多推同一条——这一条频率只决定「多久之后群里能看到」。
 */
export const HEALTH_REPORT_INTERVAL_MS = 60_000;

/**
 * 「止盈止损服务不可用」的告警条目。
 *
 * 指纹只由「是什么事」决定：同一场故障反复重试是同一件事。
 * 错误码与原文进 `lines` 而不进指纹——否则每次重试的措辞差异都算新告警，
 * 冷却就形同虚设（`apps/sync/src/alert.ts` 同一套理由）。
 */
export function buildExecutorUnavailableAlert(input: {
  unavailableMs: number;
  failureCount: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
}): AlertItem {
  const minutes = Math.max(1, Math.round(input.unavailableMs / 60_000));
  return {
    fingerprint: 'executor-unavailable|private-api',
    category: 'error',
    severity: 'critical',
    title: '止盈止损服务不可用：连不上交易所私有接口',
    lines: [
      `已经不可用 ${minutes} 分钟（连续失败 ${String(input.failureCount)} 次）`,
      `最后一条错误：${input.lastErrorCode ?? '未知'} ${input.lastErrorMessage ?? ''}`.trim(),
      '这段时间里它挂不出止盈止损单，也查不出仓位有没有保护——交易所有仓位的话它们是裸的。',
      '先查私有接口这三样：API key 是否还有效、出口 IP 是否在白名单里、' +
        'executor.environment 是不是 live（沙箱不认主网密钥，报的错与白名单不匹配一模一样）。',
    ],
    resolvedTitle: '止盈止损服务已恢复',
  };
}

export interface ExecutorHealthOptions {
  pool: Pool;
  exchange: string;
  /** 告警派发器。与对账共用**同一个**派发器：去重与冷却的记账因此是同一份。 */
  alerts: AlertDispatcher;
  /** 注入的时钟，测试用。 */
  now?: () => number;
}

/**
 * 私有接口健康的跟踪与上报。
 *
 * 只做三件事：**记结果**、**写状态行**、**推告警**。
 * 判据不在这里（core），交易所差异也不在这里（`packages/data`）。
 */
export class ExecutorHealthMonitor {
  private readonly pool: Pool;
  private readonly exchange: string;
  private readonly alerts: AlertDispatcher;
  private readonly now: () => number;
  private health: PrivateApiHealth = initialPrivateApiHealth();

  constructor(options: ExecutorHealthOptions) {
    this.pool = options.pool;
    this.exchange = options.exchange;
    this.alerts = options.alerts;
    this.now = options.now ?? (() => Date.now());
  }

  /** 当前健康快照。只读，不改状态。 */
  snapshot(): PrivateApiHealth {
    return this.health;
  }

  /**
   * 记一次**成功**的私有接口调用。
   *
   * 成功会把「不可用中」清掉——于是「恢复了」由状态自己表达，
   * 派发器据此推那条「已恢复」。
   */
  async markPrivateApiSuccess(): Promise<void> {
    this.health = applyPrivateApiSuccess(this.health, this.now());
    await this.persistPrivateApi({ ok: true });
  }

  /**
   * 记一次**失败**的私有接口调用。
   *
   * ⚠️ **只有「接口不可用」那类错误才进来**：业务失败（余额不足、参数非法）
   * 不该把服务说成不可用——处置方向完全不同。
   * 分类由 `isPrivateApiUnusableError` 做（交易所差异在 data 侧）。
   *
   * @returns 是否被记成了「接口不可用」。
   */
  async markPrivateApiFailure(error: unknown): Promise<boolean> {
    if (!isPrivateApiUnusableError(error)) return false;
    const code = errorCode(error);
    const message = error instanceof Error ? error.message : String(error);
    this.health = applyPrivateApiFailure(this.health, this.now(), { code, message });
    await this.persistPrivateApi({ ok: false, code, message });
    return true;
  }

  /**
   * 刷新心跳（进程还活着）。
   *
   * 与业务动作**分开**：私有接口全挂时心跳照跳，于是「活着」与「能用」
   * 在状态行里是两组列，谁也不冒充谁。
   */
  async beat(): Promise<void> {
    try {
      await upsertExecutorStatus(this.pool, this.exchange, this.now());
    } catch (error) {
      // 状态写不进去**不能**拖垮挂单，但必须留痕（约定 9）。
      log.error(`写 executor 状态失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 汇报健康度，推告警。
   *
   * **每轮都调**：派发器靠「上一轮有、这一轮没有」判定问题是否消失，
   * 所以必须把**当前**状态一次性给它，而不是只在出事时推一条。
   */
  async report(): Promise<void> {
    const now = this.now();
    const health = this.health;
    const unavailable = isPrivateApiUnavailable(health, now);
    try {
      await this.alerts.dispatch((channel) => {
        if (!new Set(channel.kinds).has('executor-unavailable')) return [];
        if (!unavailable) return [];
        return [
          buildExecutorUnavailableAlert({
            unavailableMs: privateApiUnavailableMs(health, now),
            failureCount: health.failureCount,
            lastErrorCode: health.lastErrorCode,
            lastErrorMessage: health.lastErrorMessage,
          }),
        ];
      }, EXECUTOR_ALERT_SCOPE);
    } catch (error) {
      // 通道解析失败也不能拖垮挂单，但必须留痕：
      // 静默吞掉的话，通知会「看起来接好了」而实际一条都发不出去。
      log.error(
        `告警通道不可用，通知发不出去：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 把私有接口的结果写进状态行。写失败只记日志，不抛。 */
  private async persistPrivateApi(
    outcome: { ok: true } | { ok: false; code: string; message: string },
  ): Promise<void> {
    try {
      await markExecutorPrivateApi(this.pool, this.exchange, outcome, this.now());
    } catch (error) {
      log.error(
        `记录 executor 私有接口状态失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * 从异常里取出**能给人看的**错误码。
 *
 * 优先用交易所自己的错误码（`-2015` 这种），它比本地错误码更能说明问题；
 * 没有就用本地的错误码；再没有就写「未知」。
 */
function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const details = (error as { details?: Record<string, unknown> }).details;
    if (details !== undefined && details !== null) {
      const raw = details['exchangeCode'];
      if (typeof raw === 'number' || (typeof raw === 'string' && raw !== '')) return String(raw);
    }
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') return code;
  }
  return '未知';
}
