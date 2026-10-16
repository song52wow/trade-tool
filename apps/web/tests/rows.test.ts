import type { SymbolEntry, SymbolSyncState } from '@trade-tool/core';
import { describe, expect, it } from 'vitest';

import { mergeSymbolRows } from '../src/rows.js';

const NOW = 1_760_000_000_000;

function entry(symbol: string, overrides: Partial<SymbolEntry> = {}): SymbolEntry {
  return {
    exchange: 'binance',
    symbol,
    desiredState: 'paused',
    onboardDate: NOW - 86_400_000,
    addedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function state(symbol: string, overrides: Partial<SymbolSyncState> = {}): SymbolSyncState {
  return {
    exchange: 'binance',
    symbol,
    status: 'paused',
    watermark: NOW - 60_000,
    verifiedUpTo: NOW - 3_600_000,
    rows: 100,
    bytes: 10_000,
    lastRunAt: NOW,
    lastSuccessAt: NOW,
    lastError: null,
    errorCount: 0,
    backoffUntil: null,
    pendingGaps: 0,
    updatedAt: NOW,
    desiredState: 'paused',
    metadataStale: false,
    plan: null,
    ...overrides,
  };
}

const base = { fallbackExchange: 'binance' };

describe('mergeSymbolRows（集合 ∪ 状态）', () => {
  it('两边都有的标的合并成一行', () => {
    const rows = mergeSymbolRows({
      ...base,
      entries: [entry('AAAUSDT', { desiredState: 'running' })],
      states: [state('AAAUSDT')],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      symbol: 'AAAUSDT',
      desiredState: 'running',
      inCollection: true,
      hasHistory: true,
    });
    expect(rows[0]?.state?.watermark).toBe(NOW - 60_000);
  });

  it('有状态但没进集合的标的也必须出现，并标记 inCollection=false', () => {
    // 这正是 `data fetch` 造成的形态：写了 klines_1m 与 sync_state，
    // 但没往 symbols 集合里插。漏掉它等于让控制面对真实数据视而不见。
    const rows = mergeSymbolRows({ ...base, entries: [], states: [state('ORPHANUSDT')] });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      symbol: 'ORPHANUSDT',
      inCollection: false,
      desiredState: null,
      hasHistory: true,
    });
    expect(rows[0]?.state?.rows).toBe(100);
  });

  it('只有集合成员、还没跑过的标的也算一行', () => {
    const rows = mergeSymbolRows({ ...base, entries: [entry('NEWUSDT')], states: [] });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ symbol: 'NEWUSDT', inCollection: true, hasHistory: false });
    expect(rows[0]?.state).toBeNull();
  });

  it('按 symbol 排序，页面表格顺序稳定', () => {
    const rows = mergeSymbolRows({
      ...base,
      entries: [entry('ZZZUSDT'), entry('AAAUSDT')],
      states: [state('MMMUSDT')],
    });

    expect(rows.map((r) => r.symbol)).toEqual(['AAAUSDT', 'MMMUSDT', 'ZZZUSDT']);
  });

  it('exchange 优先取集合成员，其次状态行，最后兜底', () => {
    const rows = mergeSymbolRows({
      ...base,
      entries: [entry('AAAUSDT', { exchange: 'binance' })],
      states: [state('AAAUSDT', { exchange: 'binance' })],
      fallbackExchange: 'binance',
    });

    expect(rows[0]?.exchange).toBe('binance');
  });
});
