/**
 * `trade-tool risk` —— 止盈止损的**人工干预**（v1.3.0）。
 *
 * ## 为什么要有这个命令
 *
 * 止盈止损是**成交驱动**的：用户数据流送来一笔成交，才算 ATR、才挂单。于是有几类
 * 故障会让仓位**裸奔**，而它们**都不会**被自动修好：
 *
 * - 用户数据流断了 → 断线期间开的仓永远不会被处理（流不重放）；
 * - 私有接口被拒 / 本机时钟偏了 → 一单都挂不上；
 * - 挂在「占坑」与「回填单号」之间进程死了 → 那张单到底下没下只有交易所知道；
 * - 单被人在交易所上撤了 → 本地记着「已挂上」，交易所上已经没有那张单。
 *
 * 这些漂移由 `trade-tool reconcile` **报出来**，但对账**只报告、绝不动手**
 * （AGENTS.md §6.5 第 1 条）：补挂一张止损会平掉真实仓位且不可逆。
 *
 * 因此修复是**人工决定**，这个命令就是那条人工路径。
 *
 * ## 与 `reconcile` 的分工
 *
 * | 命令            | 做什么                                   | 动不动手 |
 * | --------------- | ---------------------------------------- | -------- |
 * | `reconcile`     | 报出差异                                 | **不**    |
 * | `risk reattach` | 按人的决定补挂缺失的保护单               | **要**    |
 *
 * 退出码有语义，便于挂在巡检上：
 *
 *   * `0` 补挂成功（或演练成功）；
 *   * `1` 有东西该补，但**没补上**（被拒绝、失败）——不是运行失败，是「还没修好」；
 *   * 抛错（→ 1，且 stderr 有原因）是另一种情形：压根没查成。
 *
 * `--json` 输出纯 JSON 到 stdout（补挂结果），一切提示走 stderr。
 */

import { SyncError, describeClockSkew, readOptionalSecretKey } from '@trade-tool/core';
import {
  BinancePrivateClient,
  exchangeEndpointsFromEnv,
  resolveActiveCredentials,
  resolveContract,
  resolvePolicy,
} from '@trade-tool/data';
import { createAtrProvider, createReattacher, type ReattachReport } from '@trade-tool/executor';

import { withContext } from '../context.js';

export interface ReattachCommandOptions {
  symbol?: string;
  /** 只算不挂（演练）。 */
  dryRun?: boolean;
  json?: boolean;
}

/**
 * 主密钥**允许缺省**。
 *
 * 与对账同一口径：没注入主密钥只意味着读不到控制面里加密存的那份凭据，
 * 环境变量注入的那份照样能用。为了「补挂一次」而要求先配主密钥，是凭空加一道门槛。
 */
function masterKeyOrNull(): Buffer | null {
  return readOptionalSecretKey();
}

function render(report: ReattachReport): void {
  if (report.refusal !== null) {
    // 「拒绝补挂」与「不需要补挂」是两回事：前者是**该补但不敢补**，
    // 它必须显眼（约定 9：失败要常驻可见）。
    console.log(`✘ ${report.symbol}：${report.refusal}`);
  } else if (report.details.length === 0) {
    console.log(`✔ ${report.symbol} 的仓位有保护，不需要补挂。`);
  }
  for (const detail of report.details) {
    const mark =
      detail.outcome === 'placed'
        ? '✔'
        : detail.outcome === 'dry-run'
          ? '·'
          : detail.outcome === 'failed'
            ? '✘'
            : '—';
    console.log(`${mark} ${detail.symbol}：${detail.reason}`);
    if (detail.tpAlgoId !== undefined || detail.slAlgoId !== undefined) {
      console.log(
        `        订单号：止盈 ${String(detail.tpAlgoId ?? '—')}，止损 ${String(detail.slAlgoId ?? '—')}`,
      );
    }
  }
  if (report.tp1FillRecorded !== null) {
    console.log(`ℹ ${report.tp1FillRecorded}`);
  }
  for (const skip of report.skips) {
    console.log(`— ${skip.symbol} ${skip.entryOrderId ?? ''}：${skip.reason}`);
  }
  if (report.dryRun) {
    console.log('');
    console.log('这是**演练**：这一轮没有挂任何单、也没有改任何状态。');
  }
}

export async function runReattach(options: ReattachCommandOptions = {}): Promise<number> {
  const symbol = options.symbol?.trim();
  if (symbol === undefined || symbol === '') {
    throw new SyncError('CONFIG_INVALID', '必须指定标的：--symbol BTCUSDT');
  }
  return withContext(async (ctx) => {
    const { pool, config, exchange } = ctx;

    // 标的合法性由**运行时元数据**判定，不硬编码（AGENTS.md 约定 10）。
    // 查不到就直接报错，而不是拿一个不存在的标的去交易所问一圈。
    const contract = await resolveContract(ctx, symbol).catch(() => null);
    if (contract === null) {
      throw new SyncError('SYMBOL_NOT_FOUND', `${symbol} 不在 exchangeInfo 快照里，无法补挂`, {
        symbol,
      });
    }

    const credentials = await resolveActiveCredentials({
      pool,
      masterKey: masterKeyOrNull(),
      exchange,
      apiKeyEnv: config.executor.apiKeyEnv,
      apiSecretEnv: config.executor.apiSecretEnv,
      note: (message) => console.error(`[risk] ${message}`),
    });
    const client = new BinancePrivateClient({
      credentials,
      // 与 executor 共用同一份端点解析：补挂若连错环境，挂出去的单就在错的交易所上。
      ...exchangeEndpointsFromEnv(config.executor),
      recvWindowMs: config.executor.recvWindowMs,
    });
    // 与 executor 同一件事：不校时钟的话下面每个签名请求都会 -1021，
    // 报错会长得跟「查失败」一模一样，而它其实是本机时钟偏了。
    const skew = await client.measureClockSkew();
    console.error(`[risk] ${describeClockSkew(skew)}`);

    const atr = createAtrProvider({
      runtime: ctx.runtime,
      dsn: ctx.dsn,
      config: config.executor,
      timeoutMs: config.data.timeoutMs,
    });
    const reattacher = createReattacher({
      pool,
      config,
      client,
      placer: client,
      atr,
      resolvePolicy: async (target) => resolvePolicy(pool, exchange, target, config.executor),
    });

    const report = await reattacher.run(symbol, { dryRun: options.dryRun === true });

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      render(report);
    }
    // 「有东西该补但没补上」= 1：它不是运行失败，是**还没修好**，需要人接着管。
    // 「拒绝补挂」（比如仓位数量与记录对不上）也算这一类。
    const failed =
      report.refusal !== null ||
      report.details.some((detail) => detail.outcome === 'failed' || detail.outcome === 'skipped');
    return failed ? 1 : 0;
  });
}
