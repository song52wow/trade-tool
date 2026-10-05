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
    const { countsByStatus, totalRows, pendingGaps, rateLimit } = summary;
    console.log('');
    console.log(
      `标的 ${summary.symbols} 个（running ${countsByStatus.running} / paused ${countsByStatus.paused} / error ${countsByStatus.error}）` +
        `  入库 ${totalRows.toLocaleString('en-US')} 行  待回补缺口 ${pendingGaps}`,
    );
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
