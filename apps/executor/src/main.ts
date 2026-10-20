#!/usr/bin/env node
import {
  AlertDispatcher,
  NetPositionTracker,
  createNotifier,
  loadConfigOrDefault,
  loadProjectEnv,
  parseSecretKey,
  SECRET_KEY_ENV,
  SyncError,
  describeClockSkew,
  type AlertChannel,
  type Credentials,
} from '@trade-tool/core';
import {
  BinancePrivateClient,
  buildContext,
  createPool,
  openUserDataStream,
  parseAccountUpdate,
  parseOrderTradeUpdate,
  resolveActiveCredentials,
  resolveNotifySettings,
  resolvePolicy,
  exchangeEndpointsFromEnv,
} from '@trade-tool/data';

import type { Pool } from '@trade-tool/data';

import { createAtrProvider } from './atr.js';
import { startPeriodicReconcile, type PeriodicReconcile } from './reconcile.js';
import { startTrailingTimer } from './trailing.js';
import { createExecutorService } from './service.js';

// 必须在 loadConfigOrDefault / createPool 之前：配置路径、数据库密码与 API 密钥
// 都从环境变量来。已存在的变量不会被 .env 覆盖，因此 CI 注入始终优先。
loadProjectEnv();

/** 停止信号。由 SIGINT / SIGTERM 置位，主循环据此退出而不是被强杀。 */
let stopRequested = false;
let closeStream: (() => void) | undefined;
/** 周期对账的定时器。退出时必须停掉，否则进程挂着一个 setInterval 不会结束。 */
let reconcileTimer: PeriodicReconcile | undefined;
/** 移动止损定时器（v0.7.0）。同样必须停掉。 */
let trailTimer: { stop(): void } | undefined;

/**
 * 凭据解析：走 `resolveActiveCredentials()`（**库里优先、环境变量兜底**）。
 *
 * 优先级只有一份实现（v0.6.0 从这里抽到 `packages/data`），因为 v0.6.0 的交易对账
 * 也要解析同一份凭据。两处各判一次的话，「哪一份在生效」就有两个答案。
 *
 * 唯一差异是 executor **要求主密钥存在**：它本来就在持续下单，凭据配置错了必须立刻
 * 失败，而不是悄悄用环境变量里的另一份跑起来。
 */
async function loadCredentials(
  config: Awaited<ReturnType<typeof loadConfigOrDefault>>,
  pool: Pool,
): Promise<Credentials> {
  return resolveActiveCredentials({
    pool,
    masterKey: parseSecretKey(process.env[SECRET_KEY_ENV]),
    exchange: config.market.exchange,
    apiKeyEnv: config.executor.apiKeyEnv,
    apiSecretEnv: config.executor.apiSecretEnv,
    note: (message) => console.error(`[executor] ${message}`),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 按 key 串行化任务：同一 key 的任务严格按进入顺序依次跑完。
 *
 * 前一个任务**失败不阻断**后一个（`then(task, task)`）——一笔成交处理失败不该让
 * 后续成交永远排不上队。链上只保留「跑完的那个 Promise」，处理完即从表里移除，
 * 否则 key 会随成交笔数无限增长。
 */
function createSerialRunner(): (key: string, task: () => Promise<unknown>) => Promise<unknown> {
  const chains = new Map<string, Promise<unknown>>();
  return function serial(key: string, task: () => Promise<unknown>) {
    const previous = chains.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled: Promise<unknown> = next.catch(() => undefined);
    chains.set(key, settled);
    void settled.then(() => {
      if (chains.get(key) === settled) chains.delete(key);
    });
    return next;
  };
}

async function main(): Promise<void> {
  const config = await loadConfigOrDefault();

  // 服务会**真实下单**，因此默认关闭。必须显式打开，不靠「装了包就在跑」。
  if (!config.executor.enabled) {
    console.error('executor.enabled = false，本服务不会启动（它会真实下单）');
    process.exit(2);
  }

  const pool = createPool(config.database);
  const credentials = await loadCredentials(config, pool);
  const masterKey = parseSecretKey(process.env[SECRET_KEY_ENV]);

  // 告警通道（v0.8.0）。**每轮重新解析**一次，因此控制面改完设置后不必重启
  // executor——下一轮对账（默认 5 分钟内）就用新设置。
  //
  // 解析顺序：**库里（控制面录入，密文）优先，配置文件 + 环境变量兜底**。
  // 优先级只有 `resolveNotifySettings` 一份实现，两处各判一次的话，
  // 「哪一份在生效」就有两个答案。
  //
  // 地址、阈值、冷却时间**一次取全**（同一个 AlertChannel）：只换地址却留着旧阈值，
  // 那种「半更新」比不改更难查。
  const resolveChannel = async (): Promise<AlertChannel | null> => {
    const resolved = await resolveNotifySettings({
      pool,
      masterKey,
      config: config.notify,
    });
    if (!resolved.settings.enabled) return null;
    if (resolved.settings.webhookUrl === '') {
      // 开着却没有地址：抛错而不是安静地不推（AGENTS.md 约定 9）。
      throw new SyncError(
        'CONFIG_INVALID',
        '通知已启用但没有 webhook 地址：请在控制面「设置」页录入，' +
          `或在环境变量 ${config.notify.webhookEnv} 里配置。`,
      );
    }
    return {
      notifier: createNotifier({
        webhookUrl: resolved.settings.webhookUrl,
        secret: resolved.settings.secret,
      }),
      minSeverity: resolved.settings.minSeverity,
      repeatCooldownMs: resolved.settings.repeatCooldownMs,
    };
  };

  // 启动时先解析一次并把状态打出来：配错了要**启动时就炸**，
  // 而不是让服务跑起来、告警一条都发不出去。
  const startupChannel = await resolveChannel();
  console.error(
    startupChannel === null
      ? '[executor] 飞书通知未启用：对账差异只记日志，不推送'
      : '[executor] 飞书通知已启用（设置每轮对账时重新读取，改完不必重启本进程）',
  );

  const alerts = new AlertDispatcher({ channel: resolveChannel });

  const ctx = buildContext(pool, config);
  const client = new BinancePrivateClient({
    credentials,
    // 端点来自 `executor.environment`（live / demo）。以前这里不传，
    // 于是不管配置写什么私有侧一律打主网——本地想跑沙箱根本无从下手。
    ...exchangeEndpointsFromEnv(config.executor),
    recvWindowMs: config.executor.recvWindowMs,
  });
  // **先校时钟再做任何私有调用**：本机时钟与交易所差几百毫秒就会让每个签名请求
  // 吃 -1021（挂单、撤单、对账全在里面）。测量走的是无签名的 /fapi/v1/time，
  // 所以时钟不准时它仍然可用。补偿量必须打出来，不可见的补偿等于没补偿。
  const skew = await client.measureClockSkew();
  console.error(`[executor] ${describeClockSkew(skew)}`);
  const atr = createAtrProvider({
    runtime: ctx.runtime,
    dsn: ctx.dsn,
    config: config.executor,
    timeoutMs: config.data.timeoutMs,
  });
  // 策略按标的解析：标的覆盖 > 全局默认 > 配置文件。优先级只有 resolvePolicy 一份实现，
  // 控制面预览与这里用的是同一个函数，避免「页面显示的」和「实际挂单的」分叉。
  const tracker = new NetPositionTracker();

  /**
   * 播种净仓位。
   *
   * 启动与**每次重连**后都要调：用户数据流不重放断线期间的事件，
   * 不重新播种的话本地净额会从断线那一刻开始一路错下去，而错的方向决定
   * 下一笔成交被当成开仓还是减仓——那会挂出一整套方向相反的止盈止损。
   *
   * 播种失败**不让进程退出**：用户数据流仍要连着，否则连「对账发现仓位没保护」
   * 这条退路都没了。此时表是空的，净额按 0 起算，并留下一条明确的错误日志。
   */
  async function seedNetPositions(): Promise<void> {
    try {
      const rows = await client.positionRisk();
      // 双向持仓模式（同标的有 LONG / SHORT 两行）直接拒绝：两行相消得到 0，
      // 会把「仍有仓位」误判成「已平仓」，进而把未终结记录收敛成 cancelled。
      const bySymbol = new Map<string, typeof rows>();
      for (const row of rows) {
        const list = bySymbol.get(row.symbol) ?? [];
        list.push(row);
        bySymbol.set(row.symbol, list);
      }
      const multiSided = [...bySymbol].filter(
        ([, list]) => list.filter((r) => r.positionAmt !== 0).length > 1,
      );
      if (multiSided.length > 0) {
        throw new SyncError(
          'CONFIG_INVALID',
          `双向持仓模式无法跟踪净仓位（${multiSided
            .map(([symbol, list]) => `${symbol}=${list.map((r) => r.positionAmt).join('/')}`)
            .join('、')}）：` + `两侧净额相消得到 0，会被误判成已平仓。单向持仓模式下本服务可用。`,
          { symbols: multiSided.map(([s]) => s) },
        );
      }
      tracker.reset();
      const open = rows.filter((r) => r.positionAmt !== 0);
      for (const row of rows) tracker.seed(row.symbol, row.positionAmt);
      console.error(
        `[executor] 净仓位已播种（${rows.length} 个标的，其中 ${open.length} 个有仓位：` +
          `${open.map((r) => `${r.symbol}=${r.positionAmt}`).join('、') || '无'}）`,
      );
      // 此刻**没有任何在途事件**，是唯一适合兜底收敛的时刻：接住
      // 「断线期间成交事件整个丢了」——仓位已空而记录还停在 armed。
      // 事件流里不做这件事，因为那里会与止盈止损的 settle() 并发抢同一行。
      await service.convergeFlatPositions(
        rows.filter((r) => r.positionAmt === 0).map((r) => ({ symbol: r.symbol })),
      );
    } catch (error) {
      tracker.reset();
      console.error(`[executor] 净仓位播种失败：${(error as Error).message}`);
      console.error('[executor] 暂按空仓起算——在播种成功前，本服务判定的开仓 / 减仓可能是错的');
    }
  }

  const service = createExecutorService({
    pool,
    config,
    placer: client,
    atr,
    resolvePolicy: async (symbol) => resolvePolicy(pool, ctx.exchange, symbol, config.executor),
    positions: tracker,
  });

  await seedNetPositions();

  // 自动对账与用户数据流**并行**：它跑得慢或挂掉都不影响挂单（见 reconcile.ts）。
  reconcileTimer = startPeriodicReconcile({ pool, client, config, alerts });

  // 移动止损定时器与对账定时器**必须分开**（v0.7.0 / AGENTS.md §6.8）：对账是只读的，
  // 而移动止损要下单，合并会让「对账绝不动手」这条保证失守。
  trailTimer = startTrailingTimer(service, config.executor.trailIntervalMs);

  let delay = config.executor.reconnectBaseMs;
  const serial = createSerialRunner();
  /** 本进程用过的最后一个 listenKey；重连前先释放它。 */
  let lastListenKey: string | null = null;

  /**
   * 主循环：拿 listenKey → 开流 → 断开就退避重连。
   *
   * 重连是硬要求：listenKey 30 分钟过期、长连随时可能断，而用户数据流**不会**
   * 重放断线期间的事件。不重连的后果是「进程活着、日志干净、但新的买入成交
   * 一个都没有保护」——恰恰是这个服务最不该出现的状态。
   */
  while (!stopRequested) {
    try {
      // **先释放上一个 key 再申请**。Binance 在账户已有有效 listenKey 时，
      // `POST /listenKey` 会**返回现有那个**——于是每次重连都在用同一个 key
      // 建新连接，而旧连接在服务端尚未回收；一个 listenKey 只允许一个活跃连接，
      // 两者互相挤掉，症状是「连上马上断、来回抖几次」。
      // 实测（2026-10-16）本机稳定复现：每次进程内所有连接都是同一个 `WfaobE…`，
      // 启动后连断 2~3 次，随后稳定。关掉旧 key 后不再抖。
      //
      // 释放失败**不阻止重连**：key 可能已经过期，而「拿不到旧连接」正是我们要的。
      if (lastListenKey !== null) {
        try {
          await client.closeListenKey(lastListenKey);
        } catch (error) {
          console.error(
            `[executor] 释放旧 listenKey 失败（继续重连）：${(error as Error).message}`,
          );
        }
      }
      const listenKey = await client.createListenKey();
      lastListenKey = listenKey;
      delay = config.executor.reconnectBaseMs;
      console.error(`用户数据流已连接（listenKey ${listenKey.slice(0, 6)}…）`);

      await new Promise<void>((resolve) => {
        const handle = openUserDataStream({
          listenKey,
          url: client.listenKeyUrl(listenKey),
          webSocketFactory: (url) => new WebSocket(url) as unknown as WebSocket,
          keepAliveIntervalMs: 20 * 60_000,
          onKeepAlive: async (key) => {
            await client.keepAliveListenKey(key);
          },
          onEvent: async (payload) => {
            // 仓位校正走**账户事件**，与成交判定分开：官方只保证同一事件类型内部有序，
            // 两者之间没有顺序保证，所以它只能事后纠正，不能参与判定。
            const account = parseAccountUpdate(payload);
            if (account !== null) {
              await service.correctPositions(account);
              return;
            }
            const update = parseOrderTradeUpdate(payload);
            if (update === null) return;
            // 同一标的必须**按到达顺序串行**处理。
            //
            // `openUserDataStream` 的 `onmessage` 是每条消息各起一个 Promise
            // （`void (async () => …)`），彼此不排队。而流内净额是**逐笔累加**的，
            // 并发处理会让同一标的的两笔成交以任意顺序落账，净额直接算错。
            await serial(update.symbol, () => service.handleFill(update));
          },
          onError: (error) => {
            console.error(`[executor] ${error.message}`);
          },
          onClose: (reason) => {
            console.error(`[executor] 用户数据流断开（${reason}）`);
            resolve();
          },
        });
        closeStream = () => handle.close();
      });
      closeStream = undefined;
    } catch (error) {
      console.error(`[executor] 用户数据流不可用：${(error as Error).message}`);
    }

    if (stopRequested) break;
    // 重连前**必须**重新播种：断线期间用户数据流不重放事件，
    // 沿用断线前的净额会让之后每一笔成交的「开仓 / 减仓」判定都建立在错误的基线上。
    await seedNetPositions();
    console.error(`[executor] ${delay}ms 后重连…`);
    await sleep(delay);
    delay = Math.min(delay * 2, config.executor.reconnectMaxMs);
  }

  closeStream?.();
  reconcileTimer?.stop();
  trailTimer?.stop();
  await pool.end().catch(() => undefined);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.error(`\n收到 ${signal}，停止止盈止损服务…`);
    stopRequested = true;
    closeStream?.();
    // 定时器也要停：挂着的 setInterval 会让进程在「已收到停止信号」之后继续不退出。
    reconcileTimer?.stop();
    trailTimer?.stop();
  });
}

try {
  await main();
  process.exit(0);
} catch (error) {
  const message = error instanceof SyncError ? `${error.code}: ${error.message}` : String(error);
  console.error(`[executor] 启动失败：${message}`);
  process.exit(1);
}
