#!/usr/bin/env node
/**
 * 链上仓位监控服务（v1.2.0）的入口。
 *
 * 职责：定时读链 → 算账 → 落库 → 按需推送。
 * 它**只读链**、**只写自己的三张表**，不碰行情同步、不碰下单、不碰生命周期——
 * 六个入口之间职责不重叠（AGENTS.md §1）。
 */

import {
  AlertDispatcher,
  SECRET_KEY_ENV,
  SyncError,
  createNotifier,
  loadConfigOrDefault,
  loadProjectEnv,
  readOptionalSecretKey,
  type AlertChannel,
} from '@trade-tool/core';
import {
  BscClient,
  assertSchemaVersion,
  createPool,
  resolveNotifySettings,
} from '@trade-tool/data';

import { createChainMonitorService } from './service.js';

// 必须在 loadConfigOrDefault / createPool 之前：配置路径、数据库密码都从环境变量来。
// 已存在的变量不会被 .env 覆盖，因此 CI 注入始终优先。
loadProjectEnv();

/** 停止信号。由 SIGINT / SIGTERM 置位，主循环据此退出而不是被强杀。 */
let stopRequested = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const config = await loadConfigOrDefault();

  // 默认关闭：装了包不等于要跑。开了就会出网读链。
  if (!config.chain.enabled) {
    console.error('[chain-monitor] chain.enabled = false，本服务不会启动');
    process.exit(2);
  }
  if (config.chain.positions.length === 0) {
    console.error(
      '[chain-monitor] chain.positions 为空——没有要盯的仓位。请在配置文件里填上要盯哪一笔。',
    );
    process.exit(2);
  }

  const pool = createPool(config.database);
  const client = new BscClient({ endpoints: config.chain.rpcEndpoints });

  // schema 闸门：库比代码旧（缺 026 那三张表）时**启动就报错**，
  // 而不是跑到一半才冒出「relation "chain_position" does not exist」。
  // 迁移本身由 `trade-tool db migrate` 负责——入口只负责检查（与 sync / web 同一套）。
  await assertSchemaVersion(pool);
  /**
   * 凭据主密钥。**可选**：本服务不下单、不解密交易所凭据，主密钥只在
   * 「控制面录入的飞书设置」那**一档**解密时用得上。
   *
   * 缺了就传 `null`（`resolveNotifySettings` 接受它）——那意味着控制面那一档读不到，
   * 通知回落到「配置文件 + 环境变量」那一档。**该报错的地方仍然会报错**：
   * 通知开着却两边都没有地址时，解析层会抛 `CONFIG_INVALID`，
   * 而不是安静地不推（AGENTS.md 约定 9）。
   *
   * 不像 executor 那样无条件要求它：executor 要用交易所凭据，主密钥是刚需；
   * 这里不是——让一个**用不到**的密钥挡住服务启动，只会让「配好就能跑」变成「还得再配一样」。
   */
  // 判据只有 core 一份：没配 → null（回落配置文件那一档），配错 → 抛。
  const masterKey = readOptionalSecretKey();
  if (masterKey === null) {
    console.error(
      `[chain-monitor] 未设置 ${SECRET_KEY_ENV}：控制面录入的通知设置读不到，` +
        '通知将走「配置文件 + 环境变量」那一档',
    );
  }

  /**
   * 告警通道。**每轮重新解析**一次，因此控制面改完设置后不必重启本服务。
   *
   * 解析顺序与其它入口一致：**库里（控制面录入，密文）优先，配置文件 + 环境变量兜底**，
   * 优先级只有 `resolveNotifySettings` 一份实现。
   */
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
      kinds: resolved.settings.kinds,
      repeatCooldownMs: resolved.settings.repeatCooldownMs,
    };
  };

  // 启动时先解析一次并把状态打出来：配错了要**启动时就炸**，
  // 而不是让服务跑起来、一条消息都发不出去。
  const startupChannel = await resolveChannel();
  console.error(
    startupChannel === null
      ? '[chain-monitor] 飞书通知未启用：只记录，不推送'
      : '[chain-monitor] 飞书通知已启用（每轮重新读取设置，改完不必重启本进程）',
  );

  const alerts = new AlertDispatcher({ channel: resolveChannel });
  const service = createChainMonitorService({
    pool,
    config: config.chain,
    client,
    alerts,
  });

  console.error(
    `[chain-monitor] 服务启动：盯 ${String(config.chain.positions.length)} 笔仓位，` +
      `每 ${String(Math.round(config.chain.pollIntervalMs / 1000))} 秒一轮`,
  );

  // 先跑一轮（页面要有数据），再进入循环。
  while (!stopRequested) {
    const results = await service.pollOnce();
    for (const result of results) {
      if (!result.ok) {
        console.error(`[chain-monitor] 一笔仓位本轮失败：${result.error ?? '未知错误'}`);
        continue;
      }
      const snapshot = result.snapshot;
      if (snapshot === null) continue;
      console.error(
        `[chain-monitor] 现价 ${snapshot.price.toFixed(4)}，价值 ${snapshot.valueUsdt.toFixed(2)} USDT，` +
          `盈亏 ${snapshot.pnlUsdt >= 0 ? '+' : ''}${snapshot.pnlUsdt.toFixed(2)} USDT` +
          `（${snapshot.pnlPct >= 0 ? '+' : ''}${snapshot.pnlPct.toFixed(2)}%）` +
          (result.alert ? (result.sent ? '，已推送' : '，判定该推但没推出去') : '，无变化'),
      );
    }
    // 分片睡眠：停的时候不用等满一轮。
    let waited = 0;
    while (waited < config.chain.pollIntervalMs && !stopRequested) {
      const slice = Math.min(1_000, config.chain.pollIntervalMs - waited);
      await sleep(slice);
      waited += slice;
    }
  }

  console.error('[chain-monitor] 服务已停止');
  await pool.end();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopRequested = true;
  });
}

main().catch((error: unknown) => {
  console.error(`[chain-monitor] 启动失败：${(error as Error).message}`);
  process.exit(1);
});
