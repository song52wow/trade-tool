import { vi } from 'vitest';

import type { OverviewDto, SymbolRowDto } from '../../src/types';

/** 一组固定时刻，格式化输出才是确定的（用例里断言的都是本地化字符串）。 */
export const NOW = 1_760_000_000_000;

export const overviewFixture: OverviewDto = {
  schema: {
    ok: true,
    applied: ['001_init'],
    known: ['001_init'],
    current: '001_init',
    latest: '001_init',
    ahead: [],
    behind: [],
  },
  summary: {
    symbols: 2,
    countsByStatus: { paused: 2, running: 0, error: 0 },
    totalRows: 1000,
    totalBytes: 2048,
    pendingGaps: 0,
    rateLimit: {
      budgetPerMinute: 1920,
      windowFrom: NOW,
      used: 0,
      pauseUntil: null,
      utilization: 0,
    },
    // 用例不验派生统计，但少了它整个 fixture 过不了类型
    derived: [{ interval: '15m', table: 'klines_15m', rows: 3, bytes: 4096 }],
  },
  exchange: { exchange: 'binance', count: 2, cachedAt: NOW, ageMs: 0, stale: false },
  daemon: {
    state: 'running',
    pid: 4242,
    startedAt: NOW - 60_000,
    lastBeatAt: NOW - 2_000,
    ageMs: 2_000,
    staleAfterMs: 60_000,
  },
  jobs: { active: 0, recent: [] },
  now: NOW,
};

export function symbolRow(symbol: string, overrides: Partial<SymbolRowDto> = {}): SymbolRowDto {
  return {
    exchange: 'binance',
    symbol,
    desiredState: 'paused',
    inCollection: true,
    onboardDate: NOW - 86_400_000,
    addedAt: NOW,
    state: {
      exchange: 'binance',
      symbol,
      status: 'paused',
      watermark: NOW - 60_000,
      verifiedUpTo: NOW - 3_600_000,
      rows: 1000,
      bytes: 2048,
      lastRunAt: NOW,
      lastSuccessAt: NOW - 30_000,
      lastError: null,
      errorCount: 0,
      backoffUntil: null,
      pendingGaps: 0,
      updatedAt: NOW,
      desiredState: 'paused',
      metadataStale: false,
      plan: null,
    },
    hasHistory: true,
    ...overrides,
  };
}

export type FetchCall = { method: string; url: string; body: unknown };

export type FetchStub = {
  calls: FetchCall[];
  /** 只要 URL 就能查，不必先筛方法。 */
  urls: () => string[];
};

/**
 * 假 fetch。handlers 用**最长前缀**匹配，与 App.test.tsx 同一套约定
 * （`/api/symbols` 会前缀命中 `/api/symbols/X/estimate`，按书写顺序取谁太脆）。
 */
export function stubFetch(handlers: Record<string, unknown>): FetchStub {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    // `input` 收 unknown：服务端的 tsconfig 不带 DOM lib，写 RequestInfo 过不了类型检查
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      let body: unknown = null;
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      calls.push({ method: init?.method ?? 'GET', url, body });
      const key = Object.keys(handlers)
        .filter((k) => url.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      if (key === undefined) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify(handlers[key]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return { calls, urls: () => calls.map((c) => c.url) };
}

/** 首页几个接口的固定回包，省得每个用例都抄一遍。 */
export function baseHandlers(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    '/api/overview': overviewFixture,
    '/api/symbols': { items: [symbolRow('AAAUSDT')] },
    '/api/jobs': { items: [] },
    '/api/exchange': {
      exchange: 'binance',
      count: 1,
      cachedAt: NOW,
      ageMs: 0,
      stale: false,
      symbols: [],
    },
    ...extra,
  };
}

/** 详情页需要的几条：symbol 详情 + 1m K 线 + 止盈止损。 */
export function symbolHandlers(
  symbol: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    [`/api/symbols/${symbol}/bars`]: {
      symbol,
      interval: '1m',
      intervalMs: 60_000,
      limit: 300,
      items: [
        { time: NOW - 60_000, open: 100, high: 101, low: 99, close: 100.5, volume: 10 },
        { time: NOW, open: 100.5, high: 102, low: 100, close: 101.5, volume: 12 },
      ],
    },
    [`/api/symbols/${symbol}/indicators`]: {
      symbol,
      interval: '1h',
      bars: 14,
      rows: [],
    },
    [`/api/symbols/${symbol}/brackets`]: {
      symbol,
      limit: 20,
      items: [],
      countsByState: { armed: 0, take_profit: 0, stop_loss: 0, cancelled: 0, failed: 0 },
    },
    [`/api/symbols/${symbol}`]: {
      ...symbolRow(symbol),
      contract: null,
      gaps: [],
      estimate: null,
      derived: {
        '15m': { buckets: 3, withheldNotClosed: 0, withheldIncomplete: 0, missingMinutes: 0 },
        '1h': { buckets: 1, withheldNotClosed: 0, withheldIncomplete: 0, missingMinutes: 0 },
        '4h': { buckets: 0, withheldNotClosed: 0, withheldIncomplete: 0, missingMinutes: 0 },
        '1d': { withheldReason: 'disabled' },
      },
    },
    ...extra,
  };
}
