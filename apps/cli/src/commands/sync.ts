import { getAllStates, getState, getSummary } from '@trade-tool/data';
import type { SymbolSyncState } from '@trade-tool/core';

import { withContext } from '../context.js';
import { assertSchema } from './db.js';

/**
 * `sync status` —— 同步状态的只读视图（R-15）。
 *
 * 生命周期**变更**不走这里：CLI 保持一次性命令语义（R-14 A / R-15 第 5 条），
 * 开启/暂停/恢复走 `@trade-tool/sync` 导出的原语（R-22）。
 */
export async function runSyncStatus(flags: {
  symbol?: string | undefined;
  json?: boolean | undefined;
}): Promise<number> {
  return withContext(async (ctx) => {
    await assertSchema(ctx.pool);

    if (flags.symbol) {
      const state = await getState(ctx, flags.symbol);
      if (!state) {
        if (flags.json) {
          console.log(JSON.stringify({ symbol: flags.symbol, found: false }, null, 2));
          return 0;
        }
        console.log(`标的 ${flags.symbol} 尚无同步记录（未加入集合或尚未开始同步）。`);
        return 0;
      }
      if (flags.json) {
        console.log(JSON.stringify(state, null, 2));
        return 0;
      }
      printState(state);
      return 0;
    }

    const summary = await getSummary(ctx);
    const states = await getAllStates(ctx);
    if (flags.json) {
      console.log(JSON.stringify({ summary, symbols: states }, null, 2));
      return 0;
    }
    if (states.length === 0) {
      console.log(
        '集合中没有标的。用 `data sync --symbol <SYMBOL>` 或 @trade-tool/sync 的 addSymbol 加入。',
      );
    } else {
      for (const state of states) printState(state);
    }
    const { countsByStatus, totalRows, pendingGaps, rateLimit, derived } = summary;
    console.log('');
    console.log(
      `标的 ${summary.symbols} 个（running ${countsByStatus.running} / paused ${countsByStatus.paused} / error ${countsByStatus.error}）` +
        `  入库 ${totalRows.toLocaleString('en-US')} 行  待回补缺口 ${pendingGaps}`,
    );
    // v0.2.0 R-8.2 / AC-16：派生表的行数与**实测**体积。
    // 体积读 `pg_total_relation_size`，不沿用附录 B.2 的单行估算——那条估算至今未实测，
    // 而 `sync_state.bytes` 一直按它推进。`totalRows` / `totalBytes` 仍是 1m 语义、字段名不变。
    if (derived.length > 0) {
      console.log('派生表（实测体积，含索引摊销）：');
      for (const item of derived) {
        console.log(
          `  ${item.interval.padEnd(4)} ${item.rows.toLocaleString('en-US').padStart(10)} 行` +
            `  ${(item.bytes / 1024 / 1024).toFixed(2)} MB`,
        );
      }
    } else {
      // 空数组**不能**显示成「0 个桶」：那是「未启用派生」，与「启用了但确实为空」
      // 是两种状态，用户据此该去改配置还是去等数据（R-8.4 / AC-22）。
      console.log('派生表：未启用派生（data.aggregateIntervals 为空）');
    }
    console.log(
      `配额：本窗口已用 ${rateLimit.used}/${rateLimit.budgetPerMinute}（${(rateLimit.utilization * 100).toFixed(1)}%）` +
        (rateLimit.pauseUntil
          ? `  全局暂停至 ${new Date(rateLimit.pauseUntil).toISOString()}`
          : ''),
    );
    return 0;
  });
}

function printState(state: SymbolSyncState): void {
  if (!state) return;
  const parts = [
    `${state.symbol.padEnd(14)} ${state.status.padEnd(7)}`,
    `水位 ${state.watermark === null ? '-' : new Date(state.watermark).toISOString()}`,
    `已验证 ${state.verifiedUpTo === null ? '-' : new Date(state.verifiedUpTo).toISOString()}`,
    `${state.rows.toLocaleString('en-US')} 行`,
  ];
  // R-8.3 / R-8.6：首次全量的规模（决策依据）与进度（已入库 / 目标）。
  // 只在计划存在时打印——已有历史的标的本就没有「首次全量规模」。
  if (state.plan) {
    const done = state.rows >= state.plan.bars;
    parts.push(
      `首拉计划 约 ${state.plan.bars.toLocaleString('en-US')} 根 / ` +
        `${state.plan.requests.toLocaleString('en-US')} 次请求 / ` +
        `约 ${Math.max(1, Math.round(state.plan.estimatedMs / 60_000))} 分钟` +
        (done
          ? '（已完成）'
          : `  进度 ${state.rows.toLocaleString('en-US')}/${state.plan.bars.toLocaleString('en-US')}`),
    );
  }
  if (state.pendingGaps > 0) parts.push(`缺口 ${state.pendingGaps}`);
  if (state.lastError) parts.push(`错误 ${state.lastError}`);
  console.log(parts.join('  '));
}
