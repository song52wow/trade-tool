#!/usr/bin/env node
import { loadConfigOrDefault, loadProjectEnv, SyncError } from '@trade-tool/core';
import { buildContext, createLlmClient, createPool, listSymbolEntries } from '@trade-tool/data';

import { createAgentDaemon } from './daemon.js';
import { createEquityReader } from './equity.js';
import { assertAutoExecutionDisabled } from './execute-guard.js';
import { createAgentService } from './service.js';

// 必须在 loadConfigOrDefault / createPool 之前：配置路径、数据库密码与 API 密钥
// 都从环境变量来。已存在的变量不会被 .env 覆盖，因此 CI 注入始终优先。
loadProjectEnv();

/** 停止信号。SIGINT / SIGTERM 置位，循环据此退出而不是被强杀。 */
let stopRequested = false;

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

  // `agent.execute.enabled` 是「方案自动变成真实订单」的开关。
  // **本期没有实现那条路径**（apps/executor 还不消费 approved 方案），
  // 因此打开它必须**报错**，而不是「打开后什么也不发生」——
  // 日志写着「自动执行：开」而实际一笔单都没下，是约定 9 点名的最危险的一种失败。
  // 闸门本体在 execute-guard.ts（编排器里也有一道，CLI 那条路同样被拦住）。
  assertAutoExecutionDisabled(config.agent);

  const pool = createPool(config.database);
  const ctx = buildContext(pool, config);

  const llm = createLlmClient({
    baseUrl: config.agent.llm.baseUrl,
    model: config.agent.llm.model,
    apiKeyEnv: config.agent.llm.apiKeyEnv,
    timeoutMs: config.agent.llm.timeoutMs,
  });
  console.error(
    `[agent] 模型已接入：${config.agent.llm.model} @ ${config.agent.llm.baseUrl}` +
      `（超时 ${String(config.agent.llm.timeoutMs)}ms，` +
      `${config.agent.llm.fallbackToTrade ? '失败记为「未出方案」' : '失败即报错'}）`,
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
    llm,
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
