import {
  createLogger,
  SyncError,
  type SymbolEntry,
  type SymbolSyncState,
  type TradeToolConfig,
} from '@trade-tool/core';
import {
  assertSchemaVersion,
  deleteDaemonHeartbeat,
  getAllStates,
  upsertDaemonHeartbeat,
  type MarketContext,
} from '@trade-tool/data';

import { SyncControl } from './primitives.js';
import { SyncAlerter, type PinnedSymbol, type StoppedReason } from './alert.js';

/**
 * 常驻调度循环（R-17 … R-21）。
 *
 * 四条不变量：
 *   1. **单标的失败不扩散**：任一标的出错只写进它自己的状态，其它标的继续（R-21.1 / AC-18）。
 *   2. **单写者**：同一标的同一时刻只有一个任务（R-3.3 / AC-19）。
 *   3. **进程只在全局性错误时退出**：配置非法、PG 不可连、元数据无法获取且无缓存、
 *      schema 版本不匹配（Python 侧以 `SCHEMA_VERSION_MISMATCH` 等错误码上报）。单标的错误一律不退出。
 *   4. **慢标的不堵住别人**：一个标的的首次全量回补（实测一轮 11~15 分钟）
 *      **不得**拖慢其它标的的调度节奏——它们必须照旧每轮都轮到。
 *      （这条是 2026-10-23 实测踩出来的：BNBUSDT 的回补让 BTCUSDT / SOLUSDT
 *      的 1m K 线落后了 10~15 分钟。实现见 {@link SyncDaemon.tick}。）
 */

const log = createLogger('sync');

/**
 * 只在全局性错误时让进程退出。
 *
 * 注意 `DB_CONNECTION_FAILED` **不在**这里：R-14.5 要求「PG 不可连 → 退出」指的是
 * **启动期**——那时 `reconcile()` 读库就会失败并直接把进程带出去；
 * 而 R-21.6 明确要求**运行期**的连接失败走退避重试、且不消耗交易所配额。
 * 把它同时放进这个集合，会让任何单标的的一次 PG 抖动直接杀掉整个进程，
 * 于是 `handleFailure` 里的可恢复分支在真实守护进程中永远走不到。
 * 死锁 / schema 不匹配 / 配置非法仍然是全局性的，照旧立刻退出。
 */
const GLOBAL_FATAL_CODES = new Set([
  'CONFIG_INVALID',
  'SCHEMA_VERSION_MISMATCH',
  'METADATA_FETCH_FAILED',
]);

/**
 * 心跳刷新间隔。
 *
 * 必须**独立于同步轮次**用定时器写，不能只在 `loop()` 每轮开头写一次：
 * `loop()` 自己也会被**数据库查询**卡住（`tick()` 里的 `selectBatch` 是查库），
 * 那一卡就是好几秒到几十秒，期间轮次边界的心跳会变旧，
 * 控制面就会在同步**正在进行中**把它误判成离线。
 *
 * （2026-10-23 之前这里还写着「一轮首次全量可以跑几十分钟，loop() 一直卡在
 * `await this.tick()` 里」——那说的是旧的「一轮等所有标的跑完」的写法。
 * 调度改成「启动即返回」之后，那条卡顿没有了，但心跳仍然独立：**查库**照样会卡，
 * 而心跳的职责是「进程在」，不该由任何一次查库的快慢决定。）
 *
 * 10s 的取值理由：与 `sync.pollIntervalMs`（默认 15s）同量级但更密，短到进程刚崩
 * 就能很快被看出异常，长到不会给 PG 带来可察觉的写入压力（6 次/分钟，单行 upsert）。
 *
 * 导出它，是因为**读的一方必须按同一个节拍判超时**：控制面拿「心跳年龄」和这个间隔的
 * 3 倍比较（apps/web/src/service.ts）。两边各写一个数字迟早会漂移，而漂移的表现是页面
 * 把活着的进程读成离线（或反过来），没人会想到去核对两个常量。
 */
export const HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * 优雅退出时等待在途轮次收尾的上限。
 *
 * 不能无限等：worker 里的检查点只保证**不再开始**下一个标的，不打断已经在途的
 * `runOnce`，而一轮首次全量可达几十分钟。`stop()` 一旦无限等，SIGTERM 就会挂到
 * 几十分钟之后才退出。
 *
 * 截断它不丢数据：首次全量是边拉边写、水位只记已落库的部分，下次启动从水位续传。
 * 10s 足够让一个正常的增量轮次收尾。
 */
const STOP_DRAIN_TIMEOUT_MS = 10_000;

/**
 * **多久没有任何进展就算「停摆」**。
 *
 * 为什么需要它：网络类错误**不再**把标的钉死（见 `primitives.ts` 的
 * `TRANSIENT_CODES`），于是「所有标的都被钉死」那条判据在代理彻底断掉时
 * **不会**触发——一个都没被钉死，但一个也没在动。
 * 没有这条判据的话，代理断掉就变成「没人知道」，那正是本轮要治的病。
 *
 * 取 10 分钟：出口代理的抖动是秒级的（实测 1.9 秒就成功），10 分钟还没有
 * 任何进展，多半是代理或交易所真的出问题了。
 */
const STALLED_THRESHOLD_MS = 10 * 60_000;

export interface DaemonOptions {
  config: TradeToolConfig;
  /** 测试可注入固定时钟 */
  now?: () => number;
  /** 测试可注入的休眠实现 */
  sleep?: (ms: number) => Promise<void>;
  /**
   * 心跳刷新间隔（测试可注入）。生产用 HEARTBEAT_INTERVAL_MS。
   * 暴露它是因为「循环退出后心跳是否真的停了」只能用时间差证明，
   * 按生产值测就得让每个用例等 10 秒。
   */
  heartbeatIntervalMs?: number;
  /**
   * 与调用方共享的控制原语实例。
   *
   * 必须可注入：`createSyncService()` 会把同一个实例交给控制面与守护进程。
   * 若不共享，两边各持一份**实例私有**的运行时槽位（`slots`），于是
   * `addSymbol` 的并发守卫永远命中不了守护进程正在跑的标的，
   * 控制面的 `resume()` 也清不掉守护进程那一侧的退避——显式恢复要等
   * 最长 `backoffMaxMs`（默认 5 分钟）才生效（R-21.3 / R-22）。
   */
  control?: SyncControl;
  /**
   * 告警出口（飞书）。缺省 = 不推送。
   *
   * 为什么它必须是**可选**的：守护进程的核心职责是同步，
   * 通知是给人看的旁路（AGENTS.md 约定 9「不静默兜底」讲的是**失败要报错**，
   * 不是「推送失败要把进程带出去」）。测试不装通知通道，
   * 于是断言「推送失败不影响同步」这条就无从谈起。
   */
  alerter?: SyncAlerter;
}

export class SyncDaemon {
  private readonly control: SyncControl;
  private readonly ctx: MarketContext;
  private readonly config: TradeToolConfig;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private running = false;
  private stopping = false;
  private loopPromise: Promise<void> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly heartbeatIntervalMs: number;
  /**
   * **在途任务**：symbol → promise。
   *
   * 这里存的是「已经启动、还没跑完」的同步任务。**只登记、不等待**——
   * 等它就等于「一轮等所有标的跑完」，那正是慢标的堵住全体的根因（见 {@link tick}）。
   *
   * 任务跑完后自己从表里摘掉，于是它的并发名额**立刻**让给别的标的。
   */
  private readonly inflightTasks = new Map<string, Promise<void>>();
  /**
   * 异步任务里撞到的**全局性错误**。
   *
   * 任务不再由 `tick()` 等待，失败也就没法从 `tick()` 的返回值里拿到。
   * 但「全局性错误必须让进程退出」（R-14.5）这条硬约束不能因此丢掉：
   * 任务把错误记在这里，循环**下一轮**检查到就退出。
   *
   * 代价是退出最多晚一个轮询周期（默认 15 秒）。可以接受——那段时间里进程还在，
   * 心跳照刷，页面看到的是「还在跑」，而不是「静默死掉」。
   */
  private fatalError: SyncError | null = null;
  /** 告警出口（飞书）。缺省 = 不推送。 */
  private readonly alerter: SyncAlerter | undefined;
  /**
   * 上一轮的健康度摘要。
   *
   * 记它是为了**日志不刷屏**：健康度每 15 秒算一次，而「一切正常」这件事
   * 没必要每 15 秒写一行。只在**变化**时打一行。
   */
  private lastHealthSummary: string | null = null;
  /** 全局性错误**是否已经报过**。同一个错误可能从两条路径进来，只推一次。 */
  private fatalReported = false;
  /** 心跳定时器**正在起**（await 之中）。用来防止并发建出两个定时器。 */
  private heartbeatStarting = false;
  /** 上一轮是不是「没有可调度的标的」。用来让那行日志只在变化时出现。 */
  private lastIdle: boolean | null = null;
  /**
   * 最近一次「有标的同步成功」的时刻。
   *
   * 它回答的是「数据还在不在往前走」——比「进程还在不在」更贴近
   * 「有人在干活吗」这个问题。心跳的职责也是这个（见 {@link reportHealth}）。
   */
  private lastProgressAt: number | null = null;

  constructor(ctx: MarketContext, options: DaemonOptions) {
    this.ctx = ctx;
    this.config = options.config;
    this.control =
      options.control ?? new SyncControl(ctx, { config: options.config, exchange: ctx.exchange });
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.alerter = options.alerter;
  }

  get primitives(): SyncControl {
    return this.control;
  }

  /**
   * 启动时的状态对账（R-19.4）。
   * 状态本来就持久化在 PG 里，因此这里**不做任何假设**：重启后 running 的继续增量同步，
   * paused 的保持暂停，已登记的 gaps 继续参与自动回补。
   *
   * 退避截止时间与连续失败次数**必须一起从库里恢复**：调度判断只看运行时槽位，
   * 不恢复的话进程一重启，退避中的标的立刻被重新调度、`maxConsecutiveErrors`
   * 阈值也被清零，「持续失败 → error → 需人工恢复」（R-21.3 / AC-18）在有重启的部署里就不成立。
   */
  async reconcile(): Promise<SymbolSyncState[]> {
    const states = await getAllStates(this.ctx);
    const nowMs = this.now();
    let restoredBackoff = 0;
    for (const state of states) {
      this.control.markInflight(state.symbol, false);
      const slot = this.control.slotsSnapshot()[state.symbol];
      if (!slot) continue;
      const backoffUntil = state.backoffUntil ?? null;
      const stillBackingOff = backoffUntil !== null && backoffUntil > nowMs;
      if (stillBackingOff) restoredBackoff += 1;
      this.control.restoreRuntimeSlot(state.symbol, {
        backoffUntil: stillBackingOff ? backoffUntil : null,
        consecutiveErrors: state.errorCount ?? 0,
      });
    }
    log.info(
      `启动对账：${states.length} 个标的（running ${states.filter((s) => s.status === 'running').length}，` +
        `paused ${states.filter((s) => s.status === 'paused').length}，error ${states.filter((s) => s.status === 'error').length}` +
        `${restoredBackoff > 0 ? `，退避中 ${restoredBackoff}` : ''}）`,
    );
    return states;
  }

  /**
   * 一次调度要用到的全部事实：标的集合、它们的状态、以及「本轮可调度」的子集。
   *
   * 为什么要合成一个方法：`selectBatch` 与「同步健康度」的判定
   * （哪些标的被钉死了、是不是一个都没在跑）需要**同一份**状态快照。
   * 各查一次的话，两次读到的状态可能不一样，于是「调度选了它」与
   * 「告警说它卡住了」能同框出现——那正是这个仓库反复在治的「两个出口结论不一致」。
   */
  private async collect(nowMs: number): Promise<{
    entries: SymbolEntry[];
    states: Map<string, SymbolSyncState>;
    eligible: SymbolEntry[];
  }> {
    const entries = await this.control.listSymbols();
    const states = new Map((await getAllStates(this.ctx)).map((s) => [s.symbol, s]));

    const eligible = entries
      .filter((entry) => {
        if (entry.desiredState !== 'running') return false;
        const state = states.get(entry.symbol);
        if (state?.status === 'error') return false; // 需显式 resume 才恢复（R-21.3）
        return this.control.isSchedulable(entry.symbol, nowMs);
      })
      // **公平轮转**：先跑最久没跑过的（NULL = 从未跑过，最优先）。
      //
      // 不加这一步会永久饿死标的：`listSymbols()` 按 symbol 升序返回，
      // 而成功的标的仍是 running、也不在退避中，于是每一轮都挑同样的前 N 个，
      // 排在 `concurrency` 之外的标的**永远**轮不到——「标的集合可增删、每标的可启停」（G-9）
      // 与「并发度可配置」（R-20.5）都只剩字面。
      //
      // 同 lastRunAt 时按 symbol 兜底排序，保证每轮选择确定、可复现。
      .sort((a, b) => {
        const at = states.get(a.symbol)?.lastRunAt ?? 0;
        const bt = states.get(b.symbol)?.lastRunAt ?? 0;
        if (at !== bt) return at - bt;
        return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
      });

    return { entries, states, eligible };
  }

  /**
   * 本轮可调度的标的：集合内、期望 running、非 error、不在退避中。
   * **顺序稳定**且经过统一限速器排队，批量回补不会一次性放开全部并发（R-20.6 / AC-24）。
   */
  async selectBatch(nowMs: number): Promise<SymbolEntry[]> {
    const { eligible } = await this.collect(nowMs);
    const slotsFree = Math.max(0, this.config.sync.concurrency - this.busyCount());
    return eligible.slice(0, slotsFree);
  }

  /**
   * 跑一轮：**启动**该跑的标的，然后立刻返回。
   *
   * ## 为什么不等它们跑完
   *
   * 原来的写法是「等这一轮**全部**标的跑完才进下一轮」（`await Promise.all(workers)`）。
   * 于是一个标的的**首次全量回补**会把整个调度循环钉住：
   *
   *   * 一轮 = 把「上次水位 → 现在」的数据一次拉完（`batch-size` 只是**写库**的批次大小，
   *     不是拉取上限）→ 首次全量是几百页 HTTP 请求，实测一轮 11~15 分钟；
   *   * 循环要等它跑完 → **其它标的十几分钟才被调度一次**。
   *
   * 2026-10-23 在目标机上实测到：BTCUSDT / SOLUSDT 的 1m K 线因此落后 10~15 分钟
   * （用户看到的是「同步停在 7 分钟前」），而根因只是**另一个**标的（BNBUSDT）
   * 正在做它的首次全量回补。数据没坏、程序没卡死——只是队列被一个慢任务堵住了。
   *
   * 现在的做法：**启动即返回**。每个标的各跑各的，跑完自己摘掉名额；
   * 循环每 {@link config.sync.pollIntervalMs} 扫一次，把空闲名额分给还没跑的标的。
   * 慢标的照旧占着自己的名额（并发上限依然成立），但**不再挡住别人**。
   *
   * ## 失败怎么办
   *
   * 任务不再由本方法等待，失败就拿不到返回值了。两条去处：
   *   * 单标的失败 → 照旧只写它自己的状态（`runOnce` 内部已经写库），日志里报一行；
   *   * 全局性错误 → 记进 {@link fatalError}，循环下一轮检查到就退出（R-14.5 不丢）。
   */
  async tick(): Promise<Map<string, string>> {
    const nowMs = this.now();
    const { entries, states, eligible } = await this.collect(nowMs);
    const slotsFree = Math.max(0, this.config.sync.concurrency - this.busyCount());
    const batch = eligible.slice(0, slotsFree);

    // 健康度**先于**调度算：它决定心跳还刷不刷，也决定要不要推告警。
    await this.reportHealth(entries, states);

    if (batch.length === 0) {
      // 空批次**也要说话**。
      //
      // 2026-10-25 在目标机上实测踩到：三个标的连续失败到上限被钉成 error 之后，
      // 调度器每 15 秒扫一次、每次都选不出标的，而这里直接 return——
      // 于是**日志彻底安静了 5 小时 55 分**，而心跳照刷、控制面显示「在线」。
      // 「没人知道」是这一层最贵的故障（notify.ts 文件头），日志这一行就是它的兜底。
      //
      // 但**只在变化时打**：每轮一行就成了新的噪音（每 15 秒一行，一天一千多行），
      // 而「没人看」等于没接（notify.ts 文件头第 3 条）。
      if (this.lastIdle !== true) {
        this.lastIdle = true;
        log.info('本轮没有可调度的标的（其余状态见上一条健康度日志）');
      }
      return new Map();
    }
    this.lastIdle = false;

    const started: string[] = [];
    for (const entry of batch) {
      // 上一轮启动的、还没跑完的标的：**这一轮不碰它**。
      // `selectBatch` 已经用 `isSchedulable` 滤掉了 inflight 的标的，这一道是防
      // 「启动到 runOnce 真的设上 inflight 之间」的窗口——那个窗口里槽位还没被占上。
      if (this.inflightTasks.has(entry.symbol)) continue;
      if (this.stopping) break;
      this.startSymbol(entry);
      started.push(entry.symbol);
    }

    if (started.length > 0) {
      log.info(`本轮启动 ${started.length} 个标的：${started.join(', ')}`);
    }
    // 失败由任务自己处理（见 {@link startSymbol}），这里没有同步可见的失败。
    return new Map();
  }

  /**
   * 汇报「同步健康度」，并据此决定**心跳还刷不刷**。
   *
   * ## 「停摆」的判定
   *
   * 期望 running 的标的**全部**被钉成 `error` 才算停摆。
   * 只被钉死一部分不算——其余的还在推进，数据仍在进。
   * 退避中、在途的也不算：那是在跑，只是这一轮还没轮到。
   *
   * ## 为什么停摆时要停心跳
   *
   * 心跳的职责是回答「**有人在干活吗**」（apps/web/src/service.ts 的 `daemonStatus`）。
   * 停摆时没有任何数据会再进，继续刷心跳就是让控制面显示「在线」——
   * 而它读到的其实是「进程还在」。「进程还在但没人干活」和「有人干活」
   * 在页面上长得一模一样，那正是这个仓库最忌讳的「界面在骗人」。
   *
   * 停掉之后页面按心跳年龄判成 stale（「进程还在但不对劲，查日志」），
   * 而真正的处置（人工恢复被钉死的标的）由飞书那条「同步停摆」告警说清楚。
   */
  private async reportHealth(
    entries: readonly SymbolEntry[],
    states: Map<string, SymbolSyncState>,
  ): Promise<void> {
    const nowMs = this.now();
    const runningSymbols = entries
      .filter((entry) => entry.desiredState === 'running')
      .map((entry) => entry.symbol);
    const pinned: PinnedSymbol[] = [];
    for (const symbol of runningSymbols) {
      const state = states.get(symbol);
      // 没有 sync_state 行的标的还没跑过，**不算被钉死**（它会被调度）。
      if (state === undefined || state.status !== 'error') continue;
      pinned.push({
        symbol,
        message: state.lastError ?? '（没有留下失败原因）',
        consecutiveErrors: state.errorCount,
      });
    }
    const allPinned = runningSymbols.length > 0 && pinned.length === runningSymbols.length;

    // 「长时间没有进展」：**没有任何标的**在往前推进。
    //
    // 「有在途任务」不算停摆——那说明有任务正在跑（首次全量回补实测要十几分钟，
    // 那段时间里它当然还没有「成功」过，但那是在干活）。
    const idleMs = nowMs - (this.lastProgressAt ?? nowMs);
    const stalled =
      runningSymbols.length > 0 && this.inflightTasks.size === 0 && idleMs > STALLED_THRESHOLD_MS;

    const reason: StoppedReason = allPinned ? 'all-pinned' : stalled ? 'no-progress' : null;
    const stopped = reason !== null;

    if (stopped) {
      this.stopHeartbeat();
    } else {
      await this.startHeartbeat();
    }

    const summary =
      reason === 'all-pinned'
        ? `同步停摆：${String(runningSymbols.length)} 个在跑的标的全部被钉死（${pinned
            .map((item) => item.symbol)
            .join('、')}）`
        : reason === 'no-progress'
          ? `同步停摆：${Math.round(idleMs / 60_000)} 分钟没有任何标的同步成功` +
            '（多半是出口代理或交易所不可达）'
          : pinned.length === 0
            ? `${String(runningSymbols.length)} 个在跑的标的都在推进`
            : `${String(pinned.length)} 个标的被钉死（${pinned
                .map((item) => item.symbol)
                .join('、')}），其余 ${String(runningSymbols.length - pinned.length)} 个仍在推进`;
    if (summary !== this.lastHealthSummary) {
      this.lastHealthSummary = summary;
      if (pinned.length === 0 && reason === null) log.info(summary);
      else log.warn(summary);
    }

    if (this.alerter !== undefined) {
      await this.alerter.reportHealth({
        pinned,
        stopped: reason,
        ...(reason === 'no-progress' ? { idleMs } : {}),
      });
    }
  }

  /**
   * 启动一个标的的同步任务。**不等待它跑完**。
   *
   * 任务自己负责三件事：跑、把失败写进日志、把全局性错误记进 {@link fatalError}。
   * 跑完后从 {@link inflightTasks} 摘掉，于是它的并发名额立刻让给别的标的。
   */
  private startSymbol(entry: SymbolEntry): void {
    const task = (async (): Promise<void> => {
      let error: SyncError | null;
      try {
        error = await this.control.runOnce(entry.symbol, this.now());
      } catch (unexpected) {
        error =
          unexpected instanceof SyncError
            ? unexpected
            : new SyncError(
                'INTERNAL_ERROR',
                unexpected instanceof Error ? unexpected.message : String(unexpected),
              );
      }
      if (error === null) {
        // 有标的同步成功了 → 数据在往前走。
        this.lastProgressAt = this.now();
        return;
      }
      log.warn(`${entry.symbol} 同步失败 [${error.code}]：${error.message}`);
      // 错误隔离：只有**全局性**错误才让进程退出，单标的错误一律不扩散（R-21.1）。
      if (GLOBAL_FATAL_CODES.has(error.code) && !this.isSymbolLocalFailure(error.code)) {
        this.fatalError = error;
      }
    })();

    const tracked = task
      .catch(() => undefined)
      .finally(() => {
        this.inflightTasks.delete(entry.symbol);
      });
    this.inflightTasks.set(entry.symbol, tracked);
  }

  /**
   * 正在占用并发名额的标的数。
   *
   * 两个来源取**并集**而不是相加：
   *   * `control` 的槽位（`slot.inflight`）——控制面与守护进程共享的那一份；
   *   * 本守护进程已经启动、还没摘掉的任务。
   *
   * 取并集是为了既不重复计数，又覆盖「任务已启动但 `runOnce` 还没设上 inflight」的窗口。
   */
  private busyCount(): number {
    const busy = new Set<string>();
    for (const [symbol, slot] of Object.entries(this.control.slotsSnapshot())) {
      if (slot.inflight) busy.add(symbol);
    }
    for (const symbol of this.inflightTasks.keys()) busy.add(symbol);
    return busy.size;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    // 「最近一次有进展」从**启动时刻**起算：刚起来的守护进程还没同步成功过，
    // 那不算「很久没进展」——但 10 分钟之后仍然没有任何进展，就算数了。
    this.lastProgressAt = this.now();

    // 全局性错误 → 进程退出；这是「不静默兜底」在常驻形态下的体现。
    try {
      // 启动闸门（R-1.3 / R-14.5 / R-19.7）：schema 版本不匹配必须在**进程启动时**就报出来，
      // 而不是等第一次写库才撞上 `relation … does not exist`（被归成 INTERNAL_ERROR），
      // 更不能在「表都在、只是落后一个迁移」时无感地按旧结构一直跑。
      await assertSchemaVersion(this.ctx.pool);
      await this.reconcile();
    } catch (error) {
      this.running = false;
      await this.reportFatalAndExit(error);
      throw error;
    }

    // 心跳先落一行再开定时器：控制面据此回答「有人在干活吗」。
    // 启动失败时不能留下心跳行，否则页面会显示在线而其实没在跑。
    await this.startHeartbeat();

    this.loopPromise = this.loop();
    // 不能把 loop 的拒绝留成 unhandled rejection：Node 默认会直接终止进程，
    // 日志里只剩下一个没有任何上下文的堆栈（R-14.4 要求错误可读、且单标的失败不终止进程）。
    // 这里显式接住并交给 exitIfGlobalFatal 输出原因；`stop()` 另有自己的 catch。
    this.loopPromise.catch(async (error: unknown) => {
      // 兜底：循环内部的 catch 已经报过一次的话，`reportFatalAndExit` 会自己挡住。
      await this.reportFatalAndExit(error);
    });
    log.info(
      `同步守护进程已启动（并发上限 ${this.config.sync.concurrency}，轮询 ${this.config.sync.pollIntervalMs}ms）`,
    );
  }

  private async loop(): Promise<void> {
    while (this.running && !this.stopping) {
      try {
        await this.tick();
        // 任务不再由 tick() 等待，全局性错误也就没法从它的返回值里拿到。
        // 任务把错误记在这里，循环**下一轮**检查到就退出——R-14.5「全局性错误必须
        // 让进程退出」这条硬约束因此不丢。
        if (this.fatalError !== null) {
          throw this.fatalError;
        }
      } catch (error) {
        this.running = false;
        // 循环退出就必须停刷心跳，否则控制面会把「进程还活着」读成「有人在干活」——
        // 实测踩过：SCHEMA_VERSION_MISMATCH 让循环退出后，心跳定时器仍独立每 10s 刷新，
        // 页面显示守护进程在线，而数据一动不动，正是 R-17.6 禁止的那种骗人界面。
        // 这里**不删**心跳行：进程确实还活着，删掉会让页面报 stopped（「去启动进程」），
        // 而真实处置是查日志。留着让它自然变旧即可，读取方按阈值判成 stale。
        //
        // 在途任务**不等**：让它们跑完（它们写的是已落库的部分，下次从水位续传，不丢数据），
        // 进程随后自然退出。旧写法是「等这一轮**全部**标的跑完才检查致命错误」，
        // 那意味着一个首次全量能拖住退出几十分钟——现在最多晚一个轮询周期被发现。
        this.stopHeartbeat();
        await this.reportFatalAndExit(error);
        throw error;
      }
      if (!this.running || this.stopping) break;
      await this.sleep(this.config.sync.pollIntervalMs);
    }
  }

  /**
   * 区分「该标的的失败」与「影响全局的失败」。
   * `SYMBOL_NOT_FOUND` / `NOT_PERPETUAL` / `NOT_TRADING` 只影响单个标的，不该拖垮进程。
   */
  private isSymbolLocalFailure(code: string): boolean {
    return code === 'SYMBOL_NOT_FOUND' || code === 'NOT_PERPETUAL' || code === 'NOT_TRADING';
  }

  private exitIfGlobalFatal(error: unknown): void {
    const code = (error as { code?: string })?.code;
    log.error(
      `守护进程因全局性错误退出${code ? ` [${code}]` : ''}：${(error as Error)?.message ?? String(error)}`,
    );
    process.exitCode = 1;
  }

  /**
   * 全局性错误 → **先推一条告警** → 再让进程退出。
   *
   * 为什么要先推：`process.exitCode = 1` 只是设退出码，进程随后自然退出；
   * 而推送是一次 HTTP 请求，它会把事件循环占住，进程会等它做完。
   * 不这么做的话，「同步器死了」这件事只有日志知道——而这正是本轮要治的病。
   *
   * 推送失败**不阻止退出**：进程该退还得退，失败已经记进日志。
   *
   * 只推一次：同一个错误可能走两条路径进来（循环里的 catch 与 loopPromise 的兜底），
   * 重复推送靠 `AlertDispatcher` 的冷却压住，但这里先自己挡一道，省一次无用推送。
   */
  private async reportFatalAndExit(error: unknown): Promise<void> {
    if (this.fatalReported) {
      this.exitIfGlobalFatal(error);
      return;
    }
    this.fatalReported = true;
    const code = (error as { code?: string })?.code;
    if (this.alerter !== undefined) {
      await this.alerter.reportDaemonExit({
        ...(code === undefined ? {} : { code }),
        message: (error as Error)?.message ?? String(error),
      });
    }
    this.exitIfGlobalFatal(error);
  }

  /** 停掉心跳刷新。循环退出与优雅退出都要走这里，语义相同：不再声称有人在同步。 */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * 开始刷心跳。**幂等**：已经在刷就什么都不做。
   *
   * 之所以要能反复调用：停摆时心跳会被停掉（见 {@link reportHealth}），
   * 恢复之后必须能重新刷上——否则一次停摆之后，心跳就再也不会回来了，
   * 控制面会一直显示「离线」，而同步其实已经恢复。
   */
  private async startHeartbeat(): Promise<void> {
    // 正在起：两次调用会各建一个定时器，而 `stopHeartbeat()` 只能清掉**最后一个**
    // ——另一个会一直刷下去，让「循环已退出」的心跳测试变成随机的红。
    if (this.heartbeatTimer !== null || this.heartbeatStarting) return;
    // 守护进程已经在停了：不许再把心跳拉起来（否则会有一颗「僵尸心跳」
    // 一直刷下去，而页面据此显示「在线」）。
    if (this.stopping || !this.running) return;
    this.heartbeatStarting = true;
    try {
      await upsertDaemonHeartbeat(this.ctx.pool, this.ctx.exchange);
      // **await 期间守护进程可能已经停了**：这时绝不能再开定时器。
      if (this.stopping || !this.running) return;
      this.heartbeatTimer = setInterval(() => {
        // 心跳写失败不能影响同步：吞掉并继续，让读取方按超时判离线即可。
        // 反过来让它冒泡会变成一个未处理的 Promise 拒绝，直接终止进程（R-14.4）。
        void upsertDaemonHeartbeat(this.ctx.pool, this.ctx.exchange).catch((error: unknown) => {
          log.warn(`刷新守护进程心跳失败：${(error as Error)?.message ?? String(error)}`);
        });
      }, this.heartbeatIntervalMs);
      // 心跳不该拖住进程退出
      this.heartbeatTimer.unref?.();
    } finally {
      this.heartbeatStarting = false;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.running = false;
    this.stopHeartbeat();
    // 有界等待在途轮次收尾（理由见 STOP_DRAIN_TIMEOUT_MS）。
    //
    // **还要等在途任务**：任务不再由 `tick()` 等待（见 {@link tick}），所以
    // 「循环结束了」不等于「同步结束了」。等它们一下，退出时不会留下一个
    // 半途而废的写库事务。
    await Promise.race([
      Promise.all([...this.inflightTasks.values()]).catch(() => undefined),
      this.loopPromise?.catch(() => undefined) ?? Promise.resolve(),
      this.sleep(STOP_DRAIN_TIMEOUT_MS),
    ]);
    // 优雅退出删掉心跳，让「行不存在」就是确切的离线，而不是靠阈值猜。
    // 删不掉也不该让停止失败——那只是让页面多显示几秒「在线」。
    await deleteDaemonHeartbeat(this.ctx.pool, this.ctx.exchange).catch((error: unknown) => {
      log.warn(`删除守护进程心跳失败：${(error as Error)?.message ?? String(error)}`);
    });
  }
}

export function createDaemon(ctx: MarketContext, options: DaemonOptions): SyncDaemon {
  return new SyncDaemon(ctx, options);
}
