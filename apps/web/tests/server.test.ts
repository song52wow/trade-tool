import {
  DERIVED_INTERVALS,
  INTERVAL_TABLES,
  SyncError,
  type StoredInterval,
} from '@trade-tool/core';
import { describe, expect, it } from 'vitest';

import { MAX_BAR_LIMIT } from '../src/bars.js';
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
          // v0.2.0 R-8.2：派生表的行数与实测体积（`pg_total_relation_size`）
          derived: DERIVED_INTERVALS.map((interval) => ({
            interval,
            table: INTERVAL_TABLES[interval],
            rows: 0,
            bytes: 0,
          })),
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
      symbol === 'AAAUSDT'
        ? { ...row(symbol), contract: null, gaps: [], estimate: null, derived: {} }
        : null,
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
    listBars: async (symbol, options) => {
      calls.push(`bars:${symbol}:${String(options.limit)}:${options.interval}`);
      return [
        { time: NOW - 60_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
        { time: NOW, open: 1.5, high: 2.5, low: 1, close: 2, volume: 12 },
      ];
    },
    listIndicators: async (symbol, options) => {
      calls.push(`indicators:${symbol}:${String(options.limit)}:${options.interval}`);
      return {
        symbol,
        interval: options.interval,
        intervalMs: options.interval === '1h' ? 3_600_000 : 900_000,
        limit: options.limit,
        implVersion: 1,
        specs: [],
        shortBy: { bars: 0, reason: null },
        state: 'ok',
        message: null,
        materializeCommand: null,
      };
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
    expect(body.error.details.allowed).toEqual([
      'start',
      'pause',
      'resume',
      'full',
      'verify',
      'aggregate',
    ]);
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

  it('SyncError 的 message 不再自带一遍 [CODE] 前缀', async () => {
    // `SyncError` 的 message 本身就是 "[CODE] 正文"（CLI 靠它一行说清错误），而响应体
    // 已经把 code 放在单独字段里；原样透传会让页面拼出 `[CODE] [CODE] 正文`。
    const app = buildApp(
      fakeDeps({
        listSymbols: async () => {
          throw new SyncError('DB_CONNECTION_FAILED', '连不上 PostgreSQL');
        },
      }),
    );

    const res = await app.request('/api/symbols');
    const body = (await res.json()) as { error: { code: string; message: string } };

    expect(res.status).toBe(503);
    expect(body.error.code).toBe('DB_CONNECTION_FAILED');
    expect(body.error.message).toBe('连不上 PostgreSQL');
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

/**
 * K 线取数路由（R-23）。
 *
 * 重点不是「能返回 K 线」，而是**闸门**：`limit` 来自 URL，是唯一能放大这条查询的旋钮，
 * 非法值必须报错、超限必须截断，并且回包里的 `limit` 是**实际生效值**，页面据此说明
 * 自己看到的不是全部。
 */
describe('GET /api/symbols/:symbol/bars', () => {
  it('不传 limit 用缺省 300', async () => {
    const deps = fakeDeps();
    const app = buildApp(deps);
    const res = await app.request('/api/symbols/AAAUSDT/bars');

    expect(res.status).toBe(200);
    expect(deps.calls).toContain('bars:AAAUSDT:300:1m');
  });

  it('回包带上生效 limit 与升序 bar', async () => {
    const app = buildApp(fakeDeps());
    const body = (await (await app.request('/api/symbols/AAAUSDT/bars?limit=120')).json()) as {
      symbol: string;
      limit: number;
      items: { time: number; close: number }[];
    };

    expect(body.symbol).toBe('AAAUSDT');
    expect(body.limit).toBe(120);
    expect(body.items).toHaveLength(2);
    expect(body.items[0]?.time).toBeLessThan(body.items[1]?.time ?? 0);
  });

  it('超上限截断，并把截断后的值如实回传', async () => {
    const deps = fakeDeps();
    const app = buildApp(deps);
    const res = await app.request('/api/symbols/AAAUSDT/bars?limit=999999');
    const body = (await res.json()) as { limit: number };

    expect(body.limit).toBe(MAX_BAR_LIMIT);
    expect(deps.calls).toContain(`bars:AAAUSDT:${String(MAX_BAR_LIMIT)}:1m`);
  });

  it('非法 limit 报 400 且**不落到查询层**', async () => {
    for (const raw of ['0', '-5', '1.5', 'abc']) {
      const deps = fakeDeps();
      const app = buildApp(deps);
      const res = await app.request(`/api/symbols/AAAUSDT/bars?limit=${raw}`);

      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('CONFIG_INVALID');
      // 静默换成缺省值会让人以为「数据就这么多」，所以必须一次查询都不发
      expect(deps.calls.some((c) => c.startsWith('bars:'))).toBe(false);
    }
  });

  it('库里没有该标的数据时 200 + 空数组，不是 404', async () => {
    const app = buildApp(fakeDeps({ listBars: async () => [] }));
    const res = await app.request('/api/symbols/NEVERSYNCED/bars');
    const body = (await res.json()) as { items: unknown[] };

    expect(res.status).toBe(200);
    expect(body.items).toEqual([]);
  });

  it('symbol 前后空格照旧归一化（与其它路由同一口径）', async () => {
    const deps = fakeDeps();
    const app = buildApp(deps);
    await app.request('/api/symbols/%20AAAUSDT%20/bars');
    expect(deps.calls.some((c) => c === 'bars:AAAUSDT:300:1m')).toBe(true);
  });
});

/**
 * 周期白名单（R-7.1 / R-7.2 / AC-12）。
 *
 * 重点是**不静默回落**：用户以为在看 4h、实际拿到 1m，正是最典型的静默兜底——图能画
 * 出来，只是每根蜡烛只有 1 分钟数据，不报错也没人发现。因此非法周期必须 400 且**一次
 * 查询都不发**。
 */
describe('GET /bars 的 ?interval=', () => {
  it('缺省按 1m 分派，并回传生效值', async () => {
    const deps = fakeDeps();
    const app = buildApp(deps);
    const res = await app.request('/api/symbols/AAAUSDT/bars');
    const body = (await res.json()) as { interval: string; intervalMs: number; items: unknown[] };

    expect(res.status).toBe(200);
    expect(deps.calls).toContain('bars:AAAUSDT:300:1m');
    // 桶宽必须回传：页面要靠它把缺口算成「几根」（R-7.3）
    expect(body.interval).toBe('1m');
    expect(body.intervalMs).toBe(60_000);
    // items 的内容与顺序与改动前一致（AC-12，见需求 §6.4）
    expect(body.items).toHaveLength(2);
  });

  it.each(['15m', '1h', '4h', '1d'])('合法周期 %s 被放行', async (interval) => {
    const deps = fakeDeps();
    const app = buildApp(deps);
    const res = await app.request(`/api/symbols/AAAUSDT/bars?interval=${interval}`);

    expect(res.status).toBe(200);
    expect(deps.calls).toContain(`bars:AAAUSDT:300:${interval}`);
    const body = (await res.json()) as { interval: string; intervalMs: number };
    expect(body.interval).toBe(interval);
    expect(body.intervalMs).toBeGreaterThan(60_000);
  });

  it.each(['5m', '2h', 'foo', '1M', '15m%20'])(
    '未实现周期 %s 报 400 且**一次查询都不发**',
    async (interval) => {
      const deps = fakeDeps();
      const app = buildApp(deps);
      const res = await app.request(`/api/symbols/AAAUSDT/bars?interval=${interval}`);

      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('CONFIG_INVALID');
      // 静默换成 1m 会让人以为「数据就这么多」，所以必须不落查询层
      expect(deps.calls.some((c) => c.startsWith('bars:'))).toBe(false);
    },
  );

  it('interval 与 limit 同时非法时，先报 interval（顺序稳定）', async () => {
    const deps = fakeDeps();
    const app = buildApp(deps);
    const res = await app.request('/api/symbols/AAAUSDT/bars?interval=5m&limit=0');
    expect(res.status).toBe(400);
    expect(deps.calls).toHaveLength(0);
  });
});

/**
 * 重建作业（R-7.6）。
 *
 * 重建是几十分钟量级的重活儿：必须 **202 + job id** 立即返回，不许挂在 HTTP 请求上；
 * 同一标的存在作业时按单写者语义报 409。
 */
describe('POST /api/symbols/:symbol/aggregate', () => {
  it('返回 202 + job id，不阻塞等待重建完成', async () => {
    const deps = fakeDeps();
    const app = buildApp(deps);

    const res = await app.request('/api/symbols/AAAUSDT/aggregate', {
      method: 'POST',
      body: JSON.stringify({ target: 100 }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(202);
    expect((await res.json()) as JobDto).toMatchObject({ id: 'job-aggregate', status: 'running' });
    expect(deps.calls).toContain('job:aggregate:AAAUSDT:100');
  });

  it('同一标的已有作业在跑时 409（不并发重建）', async () => {
    const app = buildApp(
      fakeDeps({
        startJob: async () => {
          throw new SyncError('SYNC_ALREADY_RUNNING', '该标的已有作业在进行中', {
            symbol: 'AAAUSDT',
          });
        },
      }),
    );
    const res = await app.request('/api/symbols/AAAUSDT/aggregate', { method: 'POST' });
    expect(res.status).toBe(409);
  });

  it('aggregate 出现在允许的动作列表里', async () => {
    const app = buildApp(fakeDeps());
    const res = await app.request('/api/symbols/AAAUSDT/destroy', { method: 'POST' });
    const body = (await res.json()) as { error: { details: { allowed: string[] } } };
    expect(body.error.details.allowed).toContain('aggregate');
  });
});
