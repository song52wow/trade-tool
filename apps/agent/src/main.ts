#!/usr/bin/env node
import {
  loadConfigOrDefault,
  loadProjectEnv,
  parseSecretKey,
  SECRET_KEY_ENV,
  SyncError,
} from '@trade-tool/core';
import {
  buildContext,
  createPool,
  listSymbolEntries,
  resolveAgentLlmSettings,
} from '@trade-tool/data';

import { createAgentDaemon } from './daemon.js';
import { createEquityReader } from './equity.js';
import { createLlmResolver } from './llm.js';
import { createAgentService } from './service.js';

// 必须在 loadConfigOrDefault / createPool 之前：配置路径、数据库密码与 API 密钥
// 都从环境变量来。已存在的变量不会被 .env 覆盖，因此 CI 注入始终优先。
loadProjectEnv();

/** 停止信号。SIGINT / SIGTERM 置位，循环据此退出而不是被强杀。 */
let stopRequested = false;

/**
 * 读主密钥。**没有就返回 `null`**——它对控制面录入的那一份是可选的。
 *
 * 与 `parseSecretKey` 的区别：那个在缺密钥时抛错（executor 需要主密钥，
 * 它本来就在持续下单，配错了必须立刻失败）；这里的缺密钥只意味着
 * 「用不了控制面录入的那一份」，而配置文件那一档仍然可用。
 */
function readOptionalMasterKey(): Buffer | null {
  const raw = process.env[SECRET_KEY_ENV];
  if (raw === undefined || raw.trim() === '') return null;
  return parseSecretKey(raw);
}

async function main(): Promise<void> {
  const config = await loadConfigOrDefault();

  // 整段默认关闭：开启它意味着**模型会参与决定真金白银下多少、止损放哪**。
  if (!config.agent.enabled) {
    console.error('agent.enabled = false，本服务不会启动（它会让模型参与决定下单）');
    return;
  }
  // 两个 Agent 都要问模型。没配模型却开着 Agent，那它每一轮都必然失败——
  // 与其让它跑起来刷一屏失败，不如启动时就拒绝。
  if (!config.agent.llm.enabled) {
    throw new SyncError(
      'CONFIG_INVALID',
      'agent.enabled = true 但 agent.llm.enabled = false：' +
        '分析师与交易员都要问模型，没有模型就出不了方案',
      { agentEnabled: true, agentLlmEnabled: false },
    );
  }

  // `agent.execute.enabled` 是「方案自动变成真实订单」的开关（v1.0.0 已实现）。
  //
  // 打开之后：**本进程**只负责出方案（方案直接进 `approved`），
  // 真正下单的是 `apps/executor`——下单要用交易所凭据，而凭据在那边。
  //
  // ⚠️ 两件事必须说清，否则用户会以为「开了开关就有人在下单」：
  //   * executor 必须**同时在跑**（它才是消费方案的那个进程）；
  //   * 开关打开**不会**让本进程自己下单，它连交易所凭据都不碰。
  if (config.agent.execute.enabled) {
    console.error(
      '[agent] 自动执行已开启：本进程产出的方案直接进入「已批准」，' +
        '由 apps/executor 消费并下真实订单（executor 没在跑就只会积压，不会下单）',
    );
  } else {
    console.error('[agent] 自动执行未开启：方案只落库供查看，不会变成真实订单');
  }

  const pool = createPool(config.database);
  const ctx = buildContext(pool, config);

  /**
   * 模型客户端**每轮重新解析**（v1.0.0）：控制面改了模型接入不必重启本进程。
   *
   * 主密钥是**可选**的：没注入就读不到控制面录入的那一份，
   * 生效的必然是配置文件 + 环境变量那一档。
   */
  const masterKey = readOptionalMasterKey();
  const resolveLlm = createLlmResolver({
    pool,
    masterKey,
    config: config.agent.llm,
  });
  // 启动时解析一次，把「当前接的是哪个模型」打出来。
  // 解析失败（模型没启用 / 密钥读不到）在这里就暴露，而不是等第一轮分析失败。
  //
  // ⚠️ **打的是**真正生效的那一份**，不是配置文件里那份。
  // 模型接入可以在控制面配（v1.0.0），此时配置文件的值让位——
  // 打配置文件那份的话，日志会显示**另一个模型**，而排障第一句要回答的
  // 恰恰是「现在到底接的是哪个模型」。
  const resolved = await resolveAgentLlmSettings({
    pool,
    masterKey,
    config: config.agent.llm,
  });
  console.error(
    `[agent] 模型已接入：${resolved.settings.model} @ ${resolved.settings.baseUrl}` +
      `（超时 ${String(resolved.settings.timeoutMs)}ms，` +
      `${config.agent.llm.fallbackToTrade ? '失败记为「未出方案」' : '失败即报错'}；` +
      `生效来源：${resolved.source === 'panel' ? '控制面录入' : '配置文件 + 环境变量'}；` +
      '控制面改了模型接入后下一轮生效，不必重启本进程）',
  );

  // 权益读取与 CLI 用的是**同一份实现**（「哪一份在生效」只有一个答案）。
  const readEquity = createEquityReader({
    pool,
    config: config.agent,
    exchange: ctx.exchange,
    executor: config.executor,
  });

  const service = createAgentService({
    ctx,
    resolveLlm,
    config: config.agent,
    readEquity,
  });

  /**
   * 本轮要分析的标的。
   *
   * 配置里写了就按配置的来；没写就取**库里正在同步**的标的——
   * 正在同步的才有新鲜的派生 K 线，paused 的那些算出来的技术面是陈的。
   */
  async function listSymbols(): Promise<string[]> {
    if (config.agent.symbols.length > 0) {
      return [...config.agent.symbols].sort();
    }
    const entries = await listSymbolEntries(pool, ctx.exchange);
    return entries
      .filter((entry) => entry.desiredState === 'running')
      .map((entry) => entry.symbol)
      .sort();
  }

  const daemon = createAgentDaemon({ service, config: config.agent, listSymbols });

  const shutdown = async (signal: string) => {
    console.error(`\n收到 ${signal}，停止 Agent 守护进程…`);
    stopRequested = true;
    await daemon.stop();
    // **等这一轮跑完**再退：半轮（落了报告没落方案）是「看起来成功了，
    // 其实什么都没做」的一种——页面上会有一份报告，而与之对应的方案永远不会有。
    await daemon.whenStopped();
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  console.error(
    `[agent] 权益来源：${config.agent.equitySource}` +
      `${config.agent.equitySource === 'config' ? `（${String(config.agent.equity)}）` : '（交易所实时余额）'}`,
  );
  console.error(
    `[agent] 自动执行：${config.agent.execute.enabled ? '开（方案会变成真实订单）' : '关（只出方案，不下单）'}`,
  );

  await daemon.start();
  if (stopRequested) {
    await pool.end().catch(() => undefined);
  }
}

/**
 * 启动失败要**说得清**。
 *
 * 裸 `await main()` 会让未捕获的异常打印成一坨 Node 堆栈——错误码与那句话
 * 淹在栈帧里。`apps/executor` 早就是干净的一行，这里照它那份写法：
 * 错误码 + 人话，退出码 1。
 */
try {
  await main();
  process.exit(0);
} catch (error) {
  const message = error instanceof SyncError ? `${error.code}: ${error.message}` : String(error);
  console.error(`[agent] 启动失败：${message}`);
  process.exit(1);
}
