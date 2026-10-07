import type { SymbolEntry, SymbolSyncState } from '@trade-tool/core';

import type { SymbolRowDto } from './types.js';

export interface MergeRowsParams {
  /** `symbols` 表的成员（R-18 纳管的集合） */
  entries: readonly SymbolEntry[];
  /** `sync_state` 的全部行（R-19 落库的状态） */
  states: readonly SymbolSyncState[];
  /** 集合与状态都没有 exchange 时的兜底值 */
  fallbackExchange: string;
}

/**
 * 列表口径 = `symbols` 集合 ∪ `sync_state`。
 *
 * 只列集合成员会漏掉「用 `data fetch` 写过数据、但没进集合」的标的——那种标的带着
 * 真实行数却从控制面消失，用户会以为数据不存在。`readGlobalSummary` 早已用同样的
 * 并集口径计数，这里必须与它一致，否则看板上的「标的数」会和下面的列表对不上。
 *
 * 抽成纯函数是为了能脱离 PG 与交易所单测。
 *
 * **不查「最早入库的一根」**：那曾经只为覆盖时间线服务，而时间线已经删掉。留着它等于
 * 列表接口每轮刷新都为每个标的多打一次 PG——没有第二处消费这个值的理由了。
 */
export function mergeSymbolRows(params: MergeRowsParams): SymbolRowDto[] {
  const stateBySymbol = new Map(params.states.map((s) => [s.symbol, s]));
  const entryBySymbol = new Map(params.entries.map((e) => [e.symbol, e]));
  const symbols = [...new Set([...entryBySymbol.keys(), ...stateBySymbol.keys()])].sort();

  return symbols.map((symbol) => {
    const entry = entryBySymbol.get(symbol) ?? null;
    const state = stateBySymbol.get(symbol) ?? null;
    return {
      exchange: entry?.exchange ?? state?.exchange ?? params.fallbackExchange,
      symbol,
      desiredState: entry?.desiredState ?? null,
      inCollection: entry !== null,
      onboardDate: entry?.onboardDate ?? null,
      addedAt: entry?.addedAt ?? null,
      state,
      hasHistory: (state?.rows ?? 0) > 0,
    } satisfies SymbolRowDto;
  });
}
