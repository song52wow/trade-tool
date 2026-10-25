#!/usr/bin/env node
import {
  createNotifier,
  loadConfigOrDefault,
  loadProjectEnv,
  normalizeSyncSymbols,
  readOptionalSecretKey,
  SyncError,
  type AlertChannel,
} from '@trade-tool/core';
import { buildContext, createPool, resolveNotifySettings } from '@trade-tool/data';

import { SyncAlerter } from './alert.js';
import { createSyncService } from './service.js';

// 必须在 loadConfigOrDefault / createPool 之前：配置路径与数据库密码都从环境变量来。
loadProjectEnv();

/**
 * 守护进程入口。
 *
 * 生命周期变更**不在这里**做：CLI 与控制面通过 `createSyncService()` 拿到的原语操作，
 * 状态落在 PG，因此跨进程协作不需要额外通信机制（R-22.6）。
 */
async function main(): Promise<void> {
  const config = await loadConfigOrDefault();

  // 配置里的标的集合在启动时并入集合（R-8.4 / R-17.4）：
  // 纯字符串条目默认 paused；显式写了 desiredState=running 的才在并入后立即开启。
  const pool = createPool(config.database);
  const ctx = buildContext(pool, config);

  // 告警通道（2026-10-25）。**每轮重新解析**一次，因此控制面改完设置后不必重启
  // 同步器——下一轮就用新设置。
  //
  // 解析顺序：**库里（控制面录入，密文）优先，配置文件 + 环境变量兜底**。
  // 优先级只有 `resolveNotifySettings` 一份实现（与 executor 同一套），
  // 两处各判一次的话，「哪一份在生效」就有两个答案。
  //
  // 主密钥**允许缺省**：同步器不需要它来解密凭据，缺了只是读不到控制面录入的
  // 那一档，退回「配置文件 + 环境变量」那一档而已。为「看一眼同步有没有在跑」
  // 而要求先配主密钥，是凭空加一道门槛。
  const masterKey = readOptionalSecretKey();
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

  const alerter = new SyncAlerter({ channel: resolveChannel });

  const service = createSyncService(ctx, { config, alerter });

  for (const entry of normalizeSyncSymbols(config.sync.symbols)) {
    await service.primitives.addSymbol(entry.symbol, {
      start: entry.desiredState === 'running',
    });
  }

  await service.daemon.start();

  const shutdown = async (signal: string) => {
    console.error(`\n收到 ${signal}，停止同步守护进程…`);
    // 池是这里建的，所以这里关。顺序：先停守护进程（删心跳行、停刷新），再关池。
    await service.close();
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

await main();
