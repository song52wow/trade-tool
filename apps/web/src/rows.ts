import type { SymbolEntry, SymbolSyncState } from '@trade-tool/core';

import type { CoverageDto, SymbolRowDto } from './types.js';

export function toCoverage(params: {
  onboardDate: number | null;
  earliest: number | null;
  state: SymbolSyncState | null;
  now: number;
}): CoverageDto {
  return {
    onboardDate: params.onboardDate,
    earliest: params.earliest,
    watermark: params.state?.watermark ?? null,
    verifiedUpTo: params.state?.verifiedUpTo ?? null,
    now: params.now,
  };
}

export interface MergeRowsParams {
  /** `symbols` 表的成员（R-18 纳管的集合） */
  entries: readonly SymbolEntry[];
  /** `sync_state` 的全部行（R-19 落库的状态） */
  states: readonly SymbolSyncState[];
  /** 最早入库的一根；没有历史时应返回 null，由调用方决定要不要查 */
  earliestOf(symbol: string, state: SymbolSyncState | null): Promise<number | null>;
  /** 集合与状态都没有 exchange 时的兜底值 */
  fallbackExchange: string;
  now: number;
}

/**
 * 列表口径 = `symbols` 集合 ∪ `sync_state`。
 *
 * 只列集合成员会漏掉「用 `data fetch` 写过数据、但没进集合」的标的——那种标的带着
 * 真实行数却从控制面消失，用户会以为数据不存在。`readGlobalSummary` 早已用同样的
 * 并集口径计数，这里必须与它一致，否则看板上的「标的数」会和下面的列表对不上。
 *
 * 抽成纯函数是为了能脱离 PG 与交易所单测。
 */
export async function mergeSymbolRows(params: MergeRowsParams): Promise<SymbolRowDto[]> {
  const stateBySymbol = new Map(params.states.map((s) => [s.symbol, s]));
  const entryBySymbol = new Map(params.entries.map((e) => [e.symbol, e]));
  const symbols = [...new Set([...entryBySymbol.keys(), ...stateBySymbol.keys()])].sort();

  return Promise.all(
    symbols.map(async (symbol) => {
      const entry = entryBySymbol.get(symbol) ?? null;
      const state = stateBySymbol.get(symbol) ?? null;
      // 只有确认有行数时才去查最早一根，避免对空标的做无谓的全表查询。
      const earliest = state && state.rows > 0 ? await params.earliestOf(symbol, state) : null;
      return {
        exchange: entry?.exchange ?? state?.exchange ?? params.fallbackExchange,
        symbol,
        desiredState: entry?.desiredState ?? null,
        inCollection: entry !== null,
        onboardDate: entry?.onboardDate ?? null,
        addedAt: entry?.addedAt ?? null,
        state,
        coverage: toCoverage({
          onboardDate: entry?.onboardDate ?? null,
          earliest,
          state,
          now: params.now,
        }),
        hasHistory: (state?.rows ?? 0) > 0,
      } satisfies SymbolRowDto;
    }),
  );
}
