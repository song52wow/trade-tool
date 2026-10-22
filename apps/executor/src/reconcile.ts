/**
 * 周期对账（v0.6.0）。
 *
 * 为什么放在 executor 而不是控制面：**控制面不许再起守护进程**（单写者原则，
 * AGENTS.md 控制面硬约束 2），而自动对账需要一个常驻的定时器。executor 本来就常驻、
 * 本来就持有凭据、本来就在用户数据流旁边——把定时器放这里是唯一不破坏那条约束的位置。
 *
 * 三条边界：
 *   1. **只读**：不下单、不撤单、不改 `risk_bracket`（AGENTS.md 对账层规则 1）。
 *   2. **失败不许拖垮服务**：对账挂掉（凭据过期、限频、网络抖动）绝不能影响挂单。
 *      它是旁观者，不是主循环的一部分——因此异常只记日志，不中断主循环。
 *   3. **定时器独立于主循环**：用户数据流重连、ATR 计算再慢，都不影响对账的节奏。
 */

import {
  createLogger,
  type AlertDispatcher,
  type ReconcileReport,
  type TradeToolConfig,
} from '@trade-tool/core';
import {
  recordReconciliation,
  runReconciliation,
  type BinancePrivateClient,
  type Pool,
} from '@trade-tool/data';

import { buildReconcileAlert } from './alert.js';

const log = createLogger('reconcile');

export interface PeriodicReconcileDeps {
  pool: Pool;
  client: BinancePrivateClient;
  config: TradeToolConfig;
  now?: () => number;
  setIntervalImpl?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalImpl?: (handle: NodeJS.Timeout) => void;
  /**
   * 告警派发器（v0.8.0）。**可选**：不传就只记日志，不推送。
   *
   * 它是「差异 → 飞书」这条出口，与对账本身**只读**的性质不冲突：
   * 推一条消息不改任何账本，也不碰交易所。
   */
  alerts?: AlertDispatcher;
}

/**
 * 跑一轮并落快照。**永远不抛**。
 *
 * 调用点还要继续干别的事（挂单），而对账失败对挂单毫无帮助——把异常抛出去只会
 * 让「对账挂了」升级成「止盈止损服务也停了」，那比不对账糟糕得多。
 */
export async function runOnce(deps: PeriodicReconcileDeps): Promise<ReconcileReport | null> {
  const now = deps.now ?? (() => Date.now());

  let report: ReconcileReport;
  try {
    report = await runReconciliation({
      pool: deps.pool,
      client: deps.client,
      exchange: deps.config.market.exchange,
      now,
    });
  } catch (error) {
    log.error(
      `对账本轮失败（不影响挂单）：${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }

  // 落库**单独**兜一次：查成功却写不进去（PG 抖动、迁移未应用）时，
  // 报告本身仍然有价值——差异必须继续进日志。把它并进上面那个 try，
  // 就会因为一次写失败把已经查到的结论整个丢掉。
  try {
    await recordReconciliation(deps.pool, report, now());
  } catch (error) {
    log.error(
      `对账结果落库失败（不影响挂单）：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (report.healthy) {
    log.info(
      `对账一致（${report.scope.exchangePositions} 个持仓 / ${report.scope.exchangeAlgoOrders} 张挂单）`,
    );
  } else {
    // 差异要**逐条**写出来：一份只说「有 2 处差异」的日志，等于让人自己再去查一遍，
    // 而这正是对账要替人做的那件事。
    log.warn(
      `对账发现 ${report.counts.total} 处差异（紧急 ${report.counts.critical} / 注意 ${report.counts.warning}）`,
    );
    for (const item of report.differences) {
      log.warn(
        `  [${item.severity}] ${item.symbol} ${item.entryOrderId ?? ''} ${item.kind}：${item.message}`,
      );
    }
  }

  await dispatchAlerts(deps, report);
  return report;
}

/**
 * 把这轮的对账结论推出去（v0.8.0）。
 *
 * **绝不影响挂单**：推送失败、推送卡住，都不许把对账这一轮变成一次异常。
 * 因此这里整段兜住，失败只记日志——对账是旁观者，挂了也不能影响止盈止损。
 */
async function dispatchAlerts(deps: PeriodicReconcileDeps, report: ReconcileReport): Promise<void> {
  const alerts = deps.alerts;
  if (alerts === undefined) return;

  try {
    // 构造条目的那一步要按**当前生效的设置**过滤（只推用户勾选的内容），
    // 因此条目由通道参数来构造：设置只解析一次，过滤与发送看到的是同一份。
    const result = await alerts.dispatch(
      (channel) => {
        const alert = buildReconcileAlert(report, channel.kinds);
        // 没有差异时传空数组：派发器据此推一条「已恢复」，并清掉上一轮的记账。
        return alert === null ? [] : [alert];
      },
      // 作用域：与生命周期事件的推送**分开记账**——推「第一段止盈成交」
      // 不该把对账的差异当成「问题消失了」。
      'reconcile',
    );
    if (result.sent > 0 || result.recovered > 0 || result.failed > 0) {
      log.info(
        `告警推送：发出 ${String(result.sent)} / 恢复 ${String(result.recovered)}` +
          ` / 冷却压制 ${String(result.suppressed)} / 失败 ${String(result.failed)}`,
      );
    }
  } catch (error) {
    log.error(
      `告警推送异常（不影响挂单）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface PeriodicReconcile {
  /** 立即停掉定时器。**退出时必须调用**，否则进程不会结束。 */
  stop(): void;
}

/**
 * 启动周期对账：先立刻跑一次，再按 `executor.reconcileIntervalMs` 周期跑。
 *
 * 启动就跑一次的理由：重启往往正是漂移产生的时候（进程死在占坑与下单之间），
 * 而重启后**再等一个周期**才去查，等于把最该立刻发现的那一类漂移往后推。
 *
 * `reconcileIntervalMs = 0` 表示关闭自动对账（只留手动触发），返回空实现。
 */
export function startPeriodicReconcile(deps: PeriodicReconcileDeps): PeriodicReconcile {
  const intervalMs = deps.config.executor.reconcileIntervalMs;
  if (intervalMs === 0) {
    log.info('executor.reconcileIntervalMs = 0：自动对账已关闭，只保留手动触发');
    return { stop: () => undefined };
  }

  const setIntervalImpl =
    deps.setIntervalImpl ??
    ((fn: () => void, ms: number) => setInterval(fn, ms) as unknown as NodeJS.Timeout);
  const clearIntervalImpl =
    deps.clearIntervalImpl ??
    ((handle: NodeJS.Timeout) => clearInterval(handle as unknown as number));

  void runOnce(deps);
  const handle = setIntervalImpl(() => {
    void runOnce(deps);
  }, intervalMs);
  log.info(`自动对账已启用：每 ${String(intervalMs / 1000)} 秒一次（全账户）`);

  return {
    stop: () => {
      clearIntervalImpl(handle);
    },
  };
}
