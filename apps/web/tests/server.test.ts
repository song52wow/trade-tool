import { SyncError } from '@trade-tool/core';
import { describe, expect, it } from 'vitest';

import { buildApp, type WebDeps } from '../src/server.js';
import type { JobDto, OverviewDto, SymbolDetailDto, SymbolRowDto } from '../src/types.js';

const NOW = 1_760_000_000_000;

function row(symbol: string, overrides: Partial<SymbolRowDto> = {}): SymbolRowDto {
  return {
    exchange: 'binance',
    symbol,
    desiredState: 'paused',
    inCollection: true,
    onboardDate: NOW - 86_400_000,
    addedAt: NOW,
    state: null,
    coverage: {
      onboardDate: NOW - 86_400_000,
      earliest: null,
      watermark: null,
      verifiedUpTo: null,
      now: NOW,
    },
    hasHistory: false,
    ...overrides,
  };
}

const job = (id: string, status: JobDto['status'] = 'running'): JobDto => ({
  id,
  kind: 'full',
  symbol: 'AAAUSDT',
  status,
  startedAt: NOW,
  finishedAt: null,
  progress: { rows: 0, target: 100, pendingGaps: 0 },
  result: null,
  error: null,
});

/** 记录调用参数的替身，避免测试里出现真的 PG 与网络。 */
function fakeDeps(overrides: Partial<WebDeps> = {}): WebDeps & { calls: string[] } {
  const calls: string[] = [];
  const base: WebDeps = {
    getOverview: async () =>
      ({
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
          symbols: 1,
          countsByStatus: { paused: 1, running: 0, error: 0 },
          totalRows: 0,
          totalBytes: 0,
          pendingGaps: 0,
          rateLimit: {
            budgetPerMinute: 1920,
            windowFrom: NOW,
            used: 3,
            pauseUntil: null,
            utilization: 0.002,
          },
        },
        exchange: { exchange: 'binance', count: 571, cachedAt: NOW, ageMs: 1000, stale: false },
        // 默认给「在线」，让与守护进程无关的路由用例不被新横幅影响
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
      }) satisfies OverviewDto,
    listSymbols: async () => [row('AAAUSDT')],
    getSymbol: async (symbol) =>
      symbol === 'AAAUSDT' ? { ...row(symbol), contract: null, gaps: [], estimate: null } : null,
    listExchangeSymbols: async (options) => {
      calls.push(`exchange:${String(options?.refresh ?? false)}`);
      return { exchange: 'binance', count: 0, cachedAt: NOW, ageMs: 0, stale: false, symbols: [] };
    },
    addSymbol: async (symbol) => {
      calls.push(`add:${symbol}`);
      return row(symbol);
    },
    removeSymbol: async (symbol, policy) => {
      calls.push(`remove:${symbol}:${policy}`);
    },
    lifecycle: async (symbol, action) => {
      calls.push(`${action}:${symbol}`);
      return row(symbol, { desiredState: action === 'pause' ? 'paused' : 'running' });
    },
    listGaps: async (symbol) => {
      calls.push(`gaps:${symbol}`);
      return [];
    },
    estimate: async (symbol) => {
      calls.push(`estimate:${symbol}`);
      return {
        symbol,
        bars: 100,
        requests: 1,
        weight: 10,
        estimatedMs: 1000,
        from: NOW - 6_000_000,
        to: NOW,
      };
    },
    startJob: async (input) => {
      calls.push(`job:${input.kind}:${input.symbol}:${String(input.target ?? 'none')}`);
      return job(`job-${input.kind}`);
    },
    listJobs: async () => [job('job-full')],
    getJob: async (id) => (id === 'job-full' ? job('job-full') : null),
  };
  return Object.assign(base, overrides, { calls });
}

describe('buildApp 路由', () => {
  it('GET /api/health', async () => {
    const app = buildApp(fakeDeps());
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it('GET /api/overview 汇总 schema、配额与标的数', async () => {
    const app = buildApp(fakeDeps());
    const body = (await (await app.request('/api/overview')).json()) as OverviewDto;

    expect(body.schema.ok).toBe(true);
    expect(body.summary.rateLimit.budgetPerMinute).toBe(1920);
    expect(body.exchange.count).toBe(571);
  });

  it('GET /api/symbols 返回集合条目 + 状态', async () => {
    const app = buildApp(fakeDeps());
    const body = (await (await app.request('/api/symbols')).json()) as { items: SymbolRowDto[] };

    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.symbol).toBe('AAAUSDT');
    expect(body.items[0]?.hasHistory).toBe(false);
  });

  it('POST /api/symbols 新增标的返回 201', async () => {
    const deps = fakeDeps();
    const app = buildApp(deps);

    const res = await app.request('/api/symbols', {
      method: 'POST',
      body: JSON.stringify({ symbol: 'BBBUSDT' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(201);
    expect(deps.calls).toContain('add:BBBUSDT');
  });

  it('POST /api/symbols 缺 symbol 报 400 而不是空跑', async () => {
    const app = buildApp(fakeDeps());
    const res = await app.request('/api/symbols', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('CONFIG_INVALID');
  });

  it('请求体不是 JSON 时报 400', async () => {
    const app = buildApp(fakeDeps());
    const res = await app.request('/api/symbols', {
      method: 'POST',
      body: 'not-json',
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(400);
  });

  it('DELETE 不给 policy 时默认 keep，且不隐式删除', async () => {
    const deps = fakeDeps();
    const app = buildApp(deps);

    const res = await app.request('/api/symbols/AAAUSDT', { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(deps.calls).toContain('remove:AAAUSDT:keep');
  });

  it('DELETE 拒绝未知 policy', async () => {
    const app = buildApp(fakeDeps());
    const res = await app.request('/api/symbols/AAAUSDT', {
      method: 'DELETE',
      body: JSON.stringify({ policy: 'purge' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(400);
  });

  it('生命周期动作分派到对应原语', async () => {
    const deps = fakeDeps();
    const app = buildApp(deps);

    for (const action of ['start', 'pause', 'resume']) {
      const res = await app.request(`/api/symbols/AAAUSDT/${action}`, { method: 'POST' });
      expect(res.status).toBe(200);
    }
    expect(deps.calls).toEqual(['start:AAAUSDT', 'pause:AAAUSDT', 'resume:AAAUSDT']);
  });

  it('未知动作报 400 并列出允许值', async () => {
    const app = buildApp(fakeDeps());
    const res = await app.request('/api/symbols/AAAUSDT/destroy', { method: 'POST' });
    const body = (await res.json()) as { error: { code: string; details: { allowed: string[] } } };

    expect(res.status).toBe(400);
    expect(body.error.details.allowed).toEqual(['start', 'pause', 'resume', 'full', 'verify']);
  });

  it('首次全量返回 202 + job id，并把目标行数透传下去', async () => {
    const deps = fakeDeps();
    const app = buildApp(deps);

    const res = await app.request('/api/symbols/AAAUSDT/full', {
      method: 'POST',
      body: JSON.stringify({ target: 100 }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(202);
    expect((await res.json()) as JobDto).toMatchObject({ id: 'job-full', status: 'running' });
    expect(deps.calls).toContain('job:full:AAAUSDT:100');
  });

  it('GET /api/symbols/:symbol/estimate 提供确认弹窗要的规模数据', async () => {
    const app = buildApp(fakeDeps());
    const body = (await (await app.request('/api/symbols/AAAUSDT/estimate')).json()) as {
      estimate: { bars: number; requests: number; weight: number; estimatedMs: number };
    };

    expect(body.estimate.bars).toBe(100);
    expect(body.estimate.requests).toBe(1);
  });

  it('不在集合里的标的报 404', async () => {
    const app = buildApp(fakeDeps());
    const res = await app.request('/api/symbols/NOPEUSDT');
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(404);
    expect(body.error.code).toBe('SYMBOL_NOT_FOUND');
  });

  it('作业不存在报 404', async () => {
    const app = buildApp(fakeDeps());
    expect((await app.request('/api/jobs/nope')).status).toBe(404);
  });

  it('GET /api/exchange?refresh=true 透传刷新标记', async () => {
    const deps = fakeDeps();
    const app = buildApp(deps);

    await app.request('/api/exchange?refresh=true');

    expect(deps.calls).toContain('exchange:true');
  });
});

describe('SyncError → HTTP 映射', () => {
  it('交易所限频映射为 429 并带出错误码', async () => {
    const app = buildApp(
      fakeDeps({
        listGaps: async () => {
          throw new SyncError('EXCHANGE_RATE_LIMITED', '触发限频', { retryAfter: 30 });
        },
      }),
    );

    const res = await app.request('/api/symbols/AAAUSDT/gaps');
    const body = (await res.json()) as { error: { code: string; details: { retryAfter: number } } };

    expect(res.status).toBe(429);
    expect(body.error.code).toBe('EXCHANGE_RATE_LIMITED');
    expect(body.error.details.retryAfter).toBe(30);
  });

  it('单写者冲突映射为 409', async () => {
    const app = buildApp(
      fakeDeps({
        startJob: async () => {
          throw new SyncError('SYNC_ALREADY_RUNNING', '该标的正在同步', { symbol: 'AAAUSDT' });
        },
      }),
    );

    const res = await app.request('/api/symbols/AAAUSDT/full', { method: 'POST' });

    expect(res.status).toBe(409);
  });

  it('非永续映射为 422', async () => {
    const app = buildApp(
      fakeDeps({
        addSymbol: async () => {
          throw new SyncError('NOT_PERPETUAL', '不是永续合约', { contractType: 'CURRENT_QUARTER' });
        },
      }),
    );

    const res = await app.request('/api/symbols', {
      method: 'POST',
      body: JSON.stringify({ symbol: 'AAAUSDT' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(422);
  });

  it('库连不上映射为 503', async () => {
    const app = buildApp(
      fakeDeps({
        listSymbols: async () => {
          throw new SyncError('DB_CONNECTION_FAILED', '连接被拒');
        },
      }),
    );

    expect((await app.request('/api/symbols')).status).toBe(503);
  });

  it('未分类异常按 500 抛出，不伪装成已知错误', async () => {
    const app = buildApp(
      fakeDeps({
        listSymbols: async () => {
          throw new TypeError('undefined is not a function');
        },
      }),
    );

    const res = await app.request('/api/symbols');
    const body = (await res.json()) as { error: { code: string; message: string } };

    expect(res.status).toBe(500);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toContain('undefined is not a function');
  });
});

describe('详情返回结构', () => {
  it('未收录的标的返回 null（交给路由转 404）', async () => {
    const app = buildApp(fakeDeps());
    const res = await app.request('/api/symbols/ZZZUSDT');
    expect(res.status).toBe(404);
  });

  it('详情含 contract / gaps / estimate 三个字段', async () => {
    const app = buildApp(fakeDeps());
    const body = (await (await app.request('/api/symbols/AAAUSDT')).json()) as SymbolDetailDto;

    expect(body).toHaveProperty('contract');
    expect(body).toHaveProperty('gaps');
    expect(body).toHaveProperty('estimate');
  });
});
