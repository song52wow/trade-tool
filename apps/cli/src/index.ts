#!/usr/bin/env node
import { createLogger } from '@trade-tool/core';
import { Command } from 'commander';

import { runBacktestCommand } from './commands/backtest.js';
import { initConfig, showConfig } from './commands/config.js';
import {
  fetchBars,
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

const log = createLogger('cli');

/**
 * 失败语义（R-14.1）：任何失败都必须抛错并以非 0 退出码结束。
 * 错误信息写 stderr，stdout 保持干净——`--json` 输出因此永远可被管道解析。
 */
function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  log.error(message);
  process.exitCode = 1;
  throw error instanceof Error ? error : new Error(message);
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
    await runMigrate(options).catch(fail);
  });
dbCmd
  .command('status')
  .description('查看 schema 版本比对结果')
  .option('--json', '输出 JSON')
  .action(async (options: { json?: boolean }) => {
    process.exitCode = await runDbStatus(options);
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
