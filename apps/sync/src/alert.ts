/**
 * 同步器自己的故障 → 飞书告警（2026-10-25 补上）。
 *
 * ## 为什么之前没有
 *
 * `apps/sync` 里此前**一行通知代码都没有**，而 `NOTIFY_KINDS` 里也没有「同步失败」
 * 这一类内容。于是同步器能出的一切故障都只写进日志：
 *
 *   * 某个标的连续失败到 `sync.maxConsecutiveErrors`（默认 5）被钉成 `error`，
 *     停止自动重试（R-21.3），要人工 resume 才会再跑；
 *   * 所有在跑的标的都被钉死 → 调度器选不出任何标的 → **一条数据都不再进**。
 *
 * 第二种最危险：守护进程**还活着**，心跳照刷（心跳定时器与调度循环是分开的），
 * 控制面因此显示「在线」——而实际上一条数据都没进。
 * 目标机 192.168.1.90 上实测到一次**静默 5 小时 55 分**：那段时间里日志一行都没有
 * （空批次直接返回、不打日志），心跳却一直新鲜。
 *
 * 「最贵的故障不是报错，是没人知道」——这一层存在的理由就是它（core/notify.ts 文件头）。
 *
 * ## 三条口径
 *
 * 1. **推送失败不影响同步**：通知是给人看的，同步才是活干。推送挂了只记日志，
 *    绝不把守护进程带出去（AGENTS.md 约定 9 / notify.ts 文件头第 2 条）。
 * 2. **尊重用户的勾选**：哪些内容要推，由生效设置里的 `kinds` 决定，
 *    与 executor 的对账告警同一套口径。
 * 3. **不刷屏**：去重与冷却交给 `AlertDispatcher`（同一条事 30 分钟内只推一次）。
 */

import {
  AlertDispatcher,
  createLogger,
  type AlertChannelProvider,
  type AlertItem,
} from '@trade-tool/core';

const log = createLogger('sync:alert');

/**
 * 记账作用域。
 *
 * 与 executor 的对账告警**分开**：两者互不影响——对账那条「已恢复」不该把
 * 同步器这边的记账当成「问题消失了」，反之亦然（AlertDispatcher 文件头的说明）。
 */
export const SYNC_ALERT_SCOPE = 'sync-health';

/**
 * 「同步停摆」的原因。
 *
 * `null` = 没停摆。两种停摆的**处置完全不同**，因此必须分开说：
 *   * `all-pinned` —— 标的被连续真错误钉死了，要人工点「恢复」；
 *   * `no-progress` —— 没有东西被钉死，但很久没有任何进展，
 *     多半是出口代理或交易所不可达（这种**不需要**人工恢复，代理自己会好）。
 */
export type StoppedReason = 'all-pinned' | 'no-progress' | null;

/**
 * 一个被钉死的标的。
 *
 * 「钉死」= 连续失败到上限，状态被写成 `error`，**不再被自动调度**
 * （R-21.3 / R-21.5）。要它再跑，只有两条路：修好原因后在控制面点「恢复」，
 * 或修好原因后重新 resume。
 *
 * ⚠️ 只有**非环境类**错误（交易所明确说不行、数据对不上）才会钉死它；
 * 网络不通、限流这类「现在连不上」不会（见 `primitives.ts` 的 `TRANSIENT_CODES`）。
 */
export interface PinnedSymbol {
  symbol: string;
  /** 最后一次失败的原因（错误码 + 消息）。 */
  message: string;
  /** 连续失败次数。 */
  consecutiveErrors: number;
}

/**
 * 「某个标的不动了」的告警条目。
 *
 * 指纹只由**标的**决定：同一个标的反复被钉死是同一件事，
 * 掺进失败次数会让每次重试都算新告警，冷却就形同虚设。
 */
export function buildSymbolPinnedAlert(pinned: PinnedSymbol): AlertItem {
  return {
    fingerprint: `sync-symbol-error|${pinned.symbol}`,
    category: 'error',
    // 单个标的停摆是「注意」而不是「紧急」：别的标的还在跑，系统整体还活着。
    // 「一个都没在跑」才是紧急（见 {@link buildStoppedAlert}）。
    severity: 'warning',
    title: `${pinned.symbol} 同步失败，已停止自动重试`,
    lines: [
      `标的：${pinned.symbol}`,
      `连续失败：${String(pinned.consecutiveErrors)} 次`,
      `原因：${pinned.message}`,
      '它不会再被自动调度。修好原因后，在控制面「标的」页点「恢复」才会再跑。',
    ],
    resolvedTitle: `${pinned.symbol} 同步已恢复`,
  };
}

/**
 * 「一个都没在跑」的告警条目。
 *
 * 这一条与上面那几条是**两件事**：上面说的是「这个标的不动了」，
 * 这一条说的是「**整个同步停摆了**」——数据不再前进，而进程可能还活着。
 */
export function buildStoppedAlert(
  pinned: readonly PinnedSymbol[],
  reason: Exclude<StoppedReason, null>,
  idleMs = 0,
): AlertItem {
  const symbols = pinned.map((item) => item.symbol).join('、');
  if (reason === 'no-progress') {
    return {
      fingerprint: 'sync-stopped|no-progress',
      category: 'error',
      severity: 'critical',
      title: '同步停摆：很久没有任何数据进来了',
      lines: [
        `已经 ${Math.round(idleMs / 60_000)} 分钟没有任何标的同步成功`,
        '多半是出口代理或交易所不可达（标的没有被钉死，代理恢复后会自动继续）。',
        '先查代理与网络；若是交易所侧故障，等它恢复即可。',
      ],
      resolvedTitle: '同步已恢复',
    };
  }
  return {
    fingerprint: 'sync-stopped|all-pinned',
    category: 'error',
    severity: 'critical',
    title: '同步停摆：所有在跑的标的都卡住了',
    lines: [
      `卡住的标的：${symbols === '' ? '（无）' : symbols}`,
      '它们连续失败到上限，被写成了 error，不会再被自动调度。',
      '守护进程可能还活着，但一条数据都不会再进。',
      '修好原因后，在控制面「标的」页点「恢复」才会再跑。',
    ],
    resolvedTitle: '同步已恢复',
  };
}

/**
 * 「守护进程退出了」的告警条目。
 *
 * 与「停摆」分开成一条：进程退出是**最**终状态，不会自己恢复，
 * 而停摆还可能自己好转。用同一个指纹会让「停摆」那条被冷却压住，
 * 于是最该知道的那次退出反而发不出去。
 */
export function buildDaemonExitAlert(error: { code?: string; message: string }): AlertItem {
  return {
    fingerprint: 'sync-stopped|daemon-exit',
    category: 'error',
    severity: 'critical',
    title: '同步守护进程因全局性错误退出',
    lines: [
      error.code === undefined || error.code === '' ? '' : `错误码：${error.code}`,
      `原因：${error.message}`,
      '进程已退出，同步不会再跑。要恢复得重新拉起进程（容器会按 restart 策略重启）。',
    ].filter((line) => line !== ''),
    // 一次性事件：进程都退了，说不上「已恢复」。
    oneShot: true,
  };
}

export interface SyncAlerterOptions {
  /**
   * 通道提供者。**每轮重新解析**一次，因此控制面改完设置后不必重启同步器。
   */
  channel: AlertChannelProvider;
  /** 注入的时钟，测试用。 */
  now?: () => number;
}

/**
 * 同步器的告警出口。
 *
 * 刻意只做一件事：把「同步器的状态」变成「飞书消息」。
 * 通道在哪儿、去重怎么算、失败怎么抛，全部委托给 core 的
 * `AlertDispatcher` 与 `Notifier`——本仓库里告警只有**一套**口径（AGENTS.md 约定 5）。
 */
export class SyncAlerter {
  private readonly dispatcher: AlertDispatcher;
  /**
   * 上一次「通道解析失败」的原因。
   *
   * 记它是为了**日志不刷屏**：这一轮一报（默认 15 秒一轮），
   * 一个配错的通知设置能刷出几千行日志——而刷屏的告警等于没接。
   * 只在**原因变化**时再记一行。
   */
  private lastChannelError: string | null = null;

  constructor(options: SyncAlerterOptions) {
    this.dispatcher = new AlertDispatcher({
      channel: options.channel,
      ...(options.now ? { now: options.now } : {}),
      onError: (error, context) => {
        // 推送失败必须**看得见**，但不能拖垮同步。
        const message = error instanceof Error ? error.message : String(error);
        log.error(
          `飞书推送失败（${context.phase === 'recovery' ? '已恢复' : '告警'}）：${message}`,
        );
      },
    });
  }

  /**
   * 汇报一次「同步健康度」。
   *
   * **每轮都调**：派发器靠「上一轮有、这一轮没有」判定问题是否消失，
   * 所以必须把**当前全部**相关条目一次性给它，而不是只在出事时推一条。
   *
   * @param pinned 当前被钉死的标的（可能为空）。
   * @param stopped 「一个都没在跑」的原因；`null` = 没停摆。
   * @param idleMs 距上次成功同步的时长（毫秒），仅在 `no-progress` 时有意义。
   */
  async reportHealth(input: {
    pinned: readonly PinnedSymbol[];
    stopped: StoppedReason;
    idleMs?: number;
  }): Promise<void> {
    try {
      await this.dispatcher.dispatch((channel) => {
        const enabled = new Set(channel.kinds);
        const items: AlertItem[] = [];
        // 没勾的不推，也不参与指纹——否则「新增一条没勾的差异」会触发一条
        // 内容完全相同的新消息（那种重复比不报还烦人）。
        if (enabled.has('sync-symbol-error')) {
          for (const pinned of input.pinned) items.push(buildSymbolPinnedAlert(pinned));
        }
        if (enabled.has('sync-stopped') && input.stopped !== null) {
          items.push(buildStoppedAlert(input.pinned, input.stopped, input.idleMs ?? 0));
        }
        return items;
      }, SYNC_ALERT_SCOPE);
    } catch (error) {
      // **解析通道失败**（配置坏了、库读不到）也不能拖垮同步。
      // 但必须留痕：静默吞掉的话，通知会「看起来接好了」而实际一条都发不出去。
      this.reportChannelError(error);
    }
  }

  /**
   * 汇报「守护进程因全局性错误退出」。
   *
   * 一次性事件，**不参与**「已恢复」判定（进程都退了，没有「恢复」这回事）。
   */
  async reportDaemonExit(error: { code?: string; message: string }): Promise<void> {
    try {
      await this.dispatcher.dispatch((channel) => {
        if (!new Set(channel.kinds).has('sync-stopped')) return [];
        return [buildDaemonExitAlert(error)];
      }, SYNC_ALERT_SCOPE);
    } catch (error) {
      this.reportChannelError(error);
    }
  }

  /**
   * 通道解析失败：记一行，**但只在原因变化时记**。
   *
   * 每轮一记会刷屏（每 15 秒一行），而刷屏等于没接；
   * 但一个字都不记就成了「看起来接好了」——那正是约定 9 忌讳的。
   */
  private reportChannelError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (message === this.lastChannelError) return;
    this.lastChannelError = message;
    log.error(`同步告警通道不可用，通知发不出去：${message}`);
  }
}
