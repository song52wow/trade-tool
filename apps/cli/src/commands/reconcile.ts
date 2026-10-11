/**
 * `trade-tool reconcile` —— 交易对账（v0.6.0）。
 *
 * 比对**交易所真实的持仓与条件单**同本地 `risk_bracket` 记的是否一致，只报告不动手。
 *
 * 退出码有语义，便于挂在巡检上：
 *
 *   * `0` 一致（没有任何 critical / warning）；
 *   * `1` 有差异——**不是运行失败**，差异本身就是要人看的东西；
 *   * 抛错（→ 1，且 stderr 有原因）是另一种情形：压根没查成。
 *
 * 这两者的区别很重要：把「查失败」混进「查出差异」，一次签名错误就会看起来像
 * 「交易所持仓正常」，而那恰恰是最不能误判的结论。
 *
 * `--json` 输出纯 JSON 到 stdout（对账结果），一切提示走 stderr。
 */

import {
  parseSecretKey,
  SECRET_KEY_ENV,
  SyncError,
  type ReconcileReport,
} from '@trade-tool/core';
import {
  BinancePrivateClient,
  resolveActiveCredentials,
  resolveContract,
  runReconciliation,
} from '@trade-tool/data';

import { withContext } from '../context.js';

export interface ReconcileCommandOptions {
  symbol?: string;
  json?: boolean;
}

/**
 * 主密钥**允许缺省**。
 *
 * 与 executor 不同：对账是只读的，而没注入主密钥只意味着读不到控制面里加密存的那份
 * 凭据，环境变量注入的那份照样能用。为了「看一眼对不对账」而要求先配主密钥，
 * 是凭空加一道门槛。
 */
function masterKeyOrNull(): Buffer | null {
  const raw = process.env[SECRET_KEY_ENV];
  if (raw === undefined || raw.trim() === '') return null;
  return parseSecretKey(raw);
}

function render(report: ReconcileReport): void {
  const scope = report.symbol ?? '全账户';
  console.log(
    `对账范围：${scope}（本地未终结记录 ${report.scope.localUnsettled} 条、` +
      `交易所持仓 ${report.scope.exchangePositions} 个、挂单 ${report.scope.exchangeAlgoOrders} 张）`,
  );
  if (report.healthy) {
    console.log('✔ 一致：交易所的持仓与挂单同本地记录对得上。');
    return;
  }
  console.log(
    `✘ ${report.counts.total} 处差异：critical ${report.counts.critical}、warning ${report.counts.warning}`,
  );
  for (const item of report.differences) {
    const mark = item.severity === 'critical' ? '【紧急】' : '【注意】';
    console.log(`${mark} ${item.symbol} ${item.entryOrderId ?? '（无入场单号）'}：${item.message}`);
    const evidence = Object.entries(item.evidence)
      .filter(([, value]) => value !== null && value !== '')
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(' ');
    if (evidence !== '') console.log(`        ${evidence}`);
  }
  console.log('');
  console.log('对账**只报告**：不会下单、撤单或改本地状态。处置请人工确认后再执行。');
}

export async function runReconcile(options: ReconcileCommandOptions = {}): Promise<number> {
  const symbol = options.symbol?.trim();
  return withContext(async (ctx) => {
    const { pool, config, exchange } = ctx;
    // 标的合法性由**运行时元数据**判定，不硬编码（AGENTS.md 约定 10）。
    // 查不到就直接报错，而不是拿一个不存在的标的去交易所问一圈然后报「一致」。
    if (symbol !== undefined && symbol !== '') {
      const contract = await resolveContract(ctx, symbol).catch(() => null);
      if (contract === null) {
        throw new SyncError('SYMBOL_NOT_FOUND', `${symbol} 不在 exchangeInfo 快照里，无法对账`, {
          symbol,
        });
      }
    }

    const credentials = await resolveActiveCredentials({
      pool,
      masterKey: masterKeyOrNull(),
      exchange,
      apiKeyEnv: config.executor.apiKeyEnv,
      apiSecretEnv: config.executor.apiSecretEnv,
      note: (message) => console.error(`[reconcile] ${message}`),
    });
    const client = new BinancePrivateClient({
      credentials,
      recvWindowMs: config.executor.recvWindowMs,
    });

    const report = await runReconciliation({
      pool,
      client,
      exchange,
      ...(symbol === undefined || symbol === '' ? {} : { symbol }),
    });

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      render(report);
    }
    return report.healthy ? 0 : 1;
  });
}
