#!/usr/bin/env node
import { createLogger, isSyncError, loadProjectEnv } from '@trade-tool/core';
import { Command } from 'commander';

import { runBacktestCommand } from './commands/backtest.js';
import { initConfig, showConfig } from './commands/config.js';
import {
  fetchBars,
  runAggregate,
  runBackfill,
  runGaps,
  runSync,
  runSymbols,
  runVerify,
  summarize,
} from './commands/data.js';
import { runDbStatus, runMigrate } from './commands/db.js';
import { runSyncStatus } from './commands/sync.js';
import { collectDiagnostics } from './doctor.js';

// 必须在任何读取 process.env 的代码之前：配置路径（TRADE_TOOL_HOME）与数据库密码
// 都从环境变量来，入口不加载 .env 就只能靠 shell export（loadProjectEnv 不覆盖已存在的变量）。
loadProjectEnv();

const log = createLogger('cli');

/**
 * 失败语义（R-14.1）：任何失败都必须抛错并以非 0 退出码结束。
 * 错误信息写 stderr，stdout 保持干净——`--json` 输出因此永远可被管道解析。
 *
 * R-14.3 要求 stderr 的可读原因里**含交易所自己的 code / msg**。
 * 交易所原始响应只落在 `SyncError.details.body` 里，而 `Error.message` 拿不到它，
 * 于是 `minNotional` 这类拒绝原因会被整段丢掉——正好是 §0 把「高 `minNotional` 的 USDC
 * 永续」列为验收样本时预判的失败形态。这里把 details 里与排障相关的字段补进可读文本。
 */
function fail(error: unknown): never {
  const log_ = log;
  if (isSyncError(error)) {
    log_.error(error.message);
    const details = error.details;
    const parts: string[] = [];
    if (typeof details.body === 'string' && details.body.trim() !== '') {
      parts.push(`交易所响应: ${details.body.trim()}`);
    }
    const exchangeCode = details.code ?? details.exchangeCode;
    const exchangeMsg = details.msg ?? details.exchangeMsg;
    if (typeof exchangeCode === 'string' || typeof exchangeMsg === 'string') {
      parts.push(`交易所 code=${String(exchangeCode ?? '')} msg=${String(exchangeMsg ?? '')}`);
    }
    if (typeof details.startTime === 'number' || typeof details.violatingTime === 'number') {
      parts.push(
        `位置: startTime=${String(details.startTime)} violatingTime=${String(details.violatingTime)}`,
      );
    }
    if (parts.length > 0) log_.error(parts.join(' | '));
  } else {
    log_.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
  throw error instanceof Error ? error : new Error(String(error));
}

const program = new Command();

program
  .name('trade-tool')
  .description('量化/交易工具集 monorepo 的统一入口')
  .version('0.0.0')
  .showHelpAfterError();

program
  .command('doctor')
  .description('检查本机工具链（node / pnpm / uv / git）')
  .action(async () => {
    const results = await collectDiagnostics();
    for (const item of results) {
      console.log(`${item.ok ? '✔' : '✘'} ${item.name.padEnd(5)} ${item.detail}`);
    }
    if (results.some((r) => !r.ok)) process.exitCode = 1;
  });

const configCmd = program.command('config').description('配置管理');
configCmd
  .command('init')
  .description('写入默认配置 trade-tool.config.json')
  .option('-f, --force', '覆盖已存在的配置')
  .action(async (options: { force?: boolean }) => {
    await initConfig(options).catch(fail);
  });
configCmd
  .command('show')
  .description('打印当前生效配置')
  .action(async () => {
    await showConfig().catch(fail);
  });

const dbCmd = program.command('db').description('数据库 schema 管理');
dbCmd
  .command('migrate')
  .description('应用迁移（幂等，可重复执行）')
  .option('--json', '输出 JSON')
  .action(async (options: { json?: boolean }) => {
    // runMigrate 会在「库比代码新」时返回 1（R-1.3），必须把返回值接到退出码上，
    // 否则这个非 0 形同虚设。
    try {
      process.exitCode = await runMigrate(options);
    } catch (error) {
      fail(error);
    }
  });
dbCmd
  .command('status')
  .description('查看 schema 版本比对结果')
  .option('--json', '输出 JSON')
  .action(async (options: { json?: boolean }) => {
    try {
      process.exitCode = await runDbStatus(options);
    } catch (error) {
      // 这里必须显式走 fail()：否则异常冒到最外层那个 `catch {}` 就只剩退出码 1，
      // stderr 一个字都没有——「失败给不出可读原因」正是 R-14.3 要禁止的形态。
      fail(error);
    }
  });

const dataCmd = program.command('data').description('行情数据');
dataCmd
  .command('fetch')
  .description('拉取 K 线并入库（--source binance 时写 PostgreSQL）')
  .option('-s, --symbol <symbol>')
  .option('-i, --interval <interval>', '仅 synthetic 有效；binance 固定 1m')
  .option('-b, --bars <count>')
  .option('--source <source>', 'synthetic | binance，默认取配置 market.source')
  .option('--no-cache', '跳过本地缓存（仅 synthetic）')
  .action(
    async (options: {
      symbol?: string;
      interval?: string;
      bars?: string;
      source?: string;
      cache?: boolean;
    }) => {
      try {
        const { bars, symbol, interval, source } = await fetchBars({
          symbol: options.symbol,
          interval: options.interval,
          bars: options.bars,
          source: options.source,
          noCache: options.cache === false,
        });
        console.log(JSON.stringify({ symbol, interval, source, ...summarize(bars) }, null, 2));
      } catch (error) {
        fail(error);
      }
    },
  );

dataCmd
  .command('sync')
  .description('增量续传（不传 --from 时起点 = max(time)）')
  .requiredOption('-s, --symbol <symbol>')
  .option('--from <ms>', '显式起点，早于 max(time) 时退化为区间补数（DO NOTHING）')
  .option('--to <ms>', '显式终点，默认拉到最新')
  .option('-y, --yes', '首次全量时跳过规模确认')
  .option('--json', '输出 JSON')
  .action(
    async (options: {
      symbol: string;
      from?: string;
      to?: string;
      yes?: boolean;
      json?: boolean;
    }) => {
      process.exitCode = await runSync(options).catch((error: unknown) => {
        fail(error);
        return 1;
      });
    },
  );

dataCmd
  .command('backfill')
  .description('显式区间回补（永远 DO NOTHING，重复执行行数不变）')
  .requiredOption('-s, --symbol <symbol>')
  .requiredOption('--from <ms>')
  .requiredOption('--to <ms>')
  .option('--json', '输出 JSON')
  .action(async (options: { symbol: string; from: string; to: string; json?: boolean }) => {
    process.exitCode = await runBackfill(options).catch((error: unknown) => {
      fail(error);
      return 1;
    });
  });

dataCmd
  .command('verify')
  .description('全表缺口扫描并重建 verified_upto 基线')
  .requiredOption('-s, --symbol <symbol>')
  .action(async (options: { symbol: string }) => {
    process.exitCode = await runVerify(options).catch((error: unknown) => {
      fail(error);
      return 1;
    });
  });

dataCmd
  .command('gaps')
  .description('查看待回补缺口清单')
  .option('-s, --symbol <symbol>')
  .option('--json', '输出 JSON')
  .action(async (options: { symbol?: string; json?: boolean }) => {
    process.exitCode = await runGaps(options).catch((error: unknown) => {
      fail(error);
      return 1;
    });
  });

dataCmd
  .command('aggregate')
  .description('由库内 1m 派生 / 重建 / 校验 15m / 1h / 4h / 1d')
  .requiredOption('-s, --symbol <symbol>')
  .option('--intervals <list>', '逗号分隔；缺省取 data.aggregateIntervals')
  .option('--from <ms>', '区间起点，缺省 min(time)')
  .option('--to <ms>', '区间终点，缺省 max(time)')
  .option('--rebuild', '先删后算（修复 1m 被改动 / 派生被篡改）')
  .option('--check', '只读校验：报出 stale / missing / mismatch')
  .option('--json', '输出 JSON')
  .action(
    async (options: {
      symbol: string;
      intervals?: string;
      from?: string;
      to?: string;
      rebuild?: boolean;
      check?: boolean;
      json?: boolean;
    }) => {
      process.exitCode = await runAggregate(options).catch((error: unknown) => {
        fail(error);
        return 1;
      });
    },
  );

dataCmd
  .command('symbols')
  .description('运行时列出可同步标的')
  .option('--source <source>', '默认 binance')
  .option('--refresh', '忽略缓存强制刷新元数据')
  .option('--json', '输出纯 JSON 数组')
  .action(async (options: { source?: string; refresh?: boolean; json?: boolean }) => {
    process.exitCode = await runSymbols(options).catch((error: unknown) => {
      fail(error);
      return 1;
    });
  });

const syncCmd = program.command('sync').description('常驻同步状态观测');
syncCmd
  .command('status')
  .description('查看标的同步状态与全局汇总')
  .option('-s, --symbol <symbol>', '只看单个标的')
  .option('--json', '输出 JSON')
  .action(async (options: { symbol?: string; json?: boolean }) => {
    process.exitCode = await runSyncStatus(options).catch((error: unknown) => {
      fail(error);
      return 1;
    });
  });

program
  .command('backtest')
  .description('跑一次回测并写出报告')
  .option('-s, --symbol <symbol>')
  .option('-i, --interval <interval>')
  .option('-b, --bars <count>')
  .option('--fast <window>', '快线窗口')
  .option('--slow <window>', '慢线窗口')
  .option('--json', '输出完整 JSON')
  .action(
    async (options: {
      symbol?: string;
      interval?: string;
      bars?: string;
      fast?: string;
      slow?: string;
      json?: boolean;
    }) => {
      try {
        process.exitCode = await runBacktestCommand(options);
      } catch (error) {
        fail(error);
      }
    },
  );

try {
  // pnpm run 会把 `--` 原样透传进来，先剥掉再交给 commander 解析
  const raw = process.argv.slice(2);
  const args = raw[0] === '--' ? raw.slice(1) : raw;
  await program.parseAsync([process.argv[0] ?? 'node', process.argv[1] ?? 'index.js', ...args]);
} catch {
  process.exit(process.exitCode ?? 1);
}
