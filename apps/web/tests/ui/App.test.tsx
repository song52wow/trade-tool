// @vitest-environment jsdom
// UI 用例需要 DOM；服务端用例跑在默认的 node 环境。
import './setup.js';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../ui/src/App';
import type { OverviewDto, SymbolRowDto } from '../../src/types';

const NOW = 1_760_000_000_000;

const overview: OverviewDto = {
  schema: {
    ok: true,
    applied: ['001_init', '002_sync_plan'],
    known: ['001_init', '002_sync_plan'],
    current: '002_sync_plan',
    latest: '002_sync_plan',
    ahead: [],
    behind: [],
  },
  summary: {
    symbols: 2,
    countsByStatus: { paused: 1, running: 1, error: 0 },
    totalRows: 1_447_273,
    totalBytes: 1_073_741_824,
    pendingGaps: 3,
    rateLimit: {
      budgetPerMinute: 1920,
      windowFrom: NOW,
      used: 240,
      pauseUntil: null,
      utilization: 0.125,
    },
  },
  exchange: { exchange: 'binance', count: 571, cachedAt: NOW, ageMs: 1000, stale: false },
  // 默认在线：离线会多出一条横幅并让「开始同步」先弹解释窗，掩盖掉用例真正想验的东西
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

function row(symbol: string, overrides: Partial<SymbolRowDto> = {}): SymbolRowDto {
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
      rows: 1_447_273,
      bytes: 1_073_741_824,
      lastRunAt: NOW,
      lastSuccessAt: NOW - 30_000,
      lastError: null,
      errorCount: 0,
      backoffUntil: null,
      pendingGaps: 3,
      updatedAt: NOW,
      desiredState: 'paused',
      metadataStale: false,
      plan: null,
    },
    hasHistory: true,
    ...overrides,
  };
}

/** 记录被调用的 URL，便于断言「页面真的去取数了」而不只是渲染出静态壳。 */
function stubFetch(handlers: Record<string, unknown>) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    // 取**最长**匹配的前缀：`/api/symbols` 会同时前缀匹配 `/api/symbols/X/estimate`，
    // 靠书写顺序决定命中谁太脆了（多一个具体路由就可能静默拿错响应）。
    const key = Object.keys(handlers)
      .filter((k) => url.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) {
      return new Response('not found', { status: 404 });
    }
    return new Response(JSON.stringify(handlers[key]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  // 路由现在是 hash 路由（`#/symbol/X`），而 jsdom 的 window 同一个文件里跨用例复用：
  // 上一个用例停在详情页的话，下一个用例一挂载就是详情页，而不是首页。
  window.location.hash = '';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('App 首屏', () => {
  it('挂载后取数并渲染看板与标的表', async () => {
    const calls = stubFetch({
      '/api/overview': overview,
      '/api/symbols': { items: [row('BTCUSDC')] },
      '/api/jobs': { items: [] },
      '/api/exchange': {
        exchange: 'binance',
        count: 1,
        cachedAt: NOW,
        ageMs: 0,
        stale: false,
        symbols: [
          {
            exchange: 'binance',
            symbol: 'BTCUSDC',
            contractType: 'PERPETUAL',
            status: 'TRADING',
            onboardDate: NOW - 86_400_000,
          },
        ],
      },
    });

    render(<App />);

    // 首屏骨架先出现，数据到达后被替换
    expect(screen.getByText('正在读取状态…')).toBeTruthy();

    await waitFor(() => expect(screen.getByText('BTCUSDC')).toBeTruthy());

    expect(calls).toContain('/api/overview');
    expect(calls).toContain('/api/symbols');
    expect(calls).toContain('/api/jobs');
    expect(calls).toContain('/api/exchange');

    // 看板数字来自 overview，而不是写死的占位。
    // 行数与占用在看板卡片和标的表里都会出现，所以用 getAllByText。
    expect(screen.getAllByText('1,447,273').length).toBeGreaterThan(0);
    expect(screen.getAllByText('1.0 GB').length).toBeGreaterThan(0);
    expect(screen.getByText('12.5%')).toBeTruthy();
    expect(screen.getByText('571')).toBeTruthy();
  });

  it('schema 版本不一致时给出醒目提示', async () => {
    stubFetch({
      '/api/overview': {
        ...overview,
        schema: { ...overview.schema, ok: false, current: '001_init', latest: '002_sync_plan' },
      },
      '/api/symbols': { items: [] },
      '/api/jobs': { items: [] },
      '/api/exchange': {
        exchange: 'binance',
        count: 0,
        cachedAt: NOW,
        ageMs: 0,
        stale: false,
        symbols: [],
      },
    });

    render(<App />);

    await waitFor(() =>
      expect(screen.getByText(/schema（001_init）与代码（002_sync_plan）不一致/)).toBeTruthy(),
    );
  });

  it('取数失败时给出常驻错误横幅，而不是静默停在「读取中」', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{"error":{"code":"DB_CONNECTION_FAILED","message":"连接被拒"}}', {
            status: 503,
          }),
      ),
    );

    render(<App />);

    // 这是本用例存在的理由：失败必须留在页面上，不能只弹一下 toast
    await waitFor(() => expect(screen.getByText(/DB_CONNECTION_FAILED/)).toBeTruthy());
    expect(screen.getByText(/每 5s 自动重试/)).toBeTruthy();
  });

  it('有状态但未加入集合的标的标为「未纳管」并给出加入入口', async () => {
    stubFetch({
      '/api/overview': overview,
      '/api/symbols': {
        items: [
          row('BTCUSDT', {
            inCollection: false,
            desiredState: null,
            onboardDate: null,
            addedAt: null,
          }),
        ],
      },
      '/api/jobs': { items: [] },
      '/api/exchange': {
        exchange: 'binance',
        count: 0,
        cachedAt: NOW,
        ageMs: 0,
        stale: false,
        symbols: [],
      },
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText('未纳管')).toBeTruthy());
    expect(screen.getByText('加入集合')).toBeTruthy();
  });
});

describe('「开始同步」的分支', () => {
  const baseHandlers = (extra: Record<string, unknown> = {}) => ({
    '/api/overview': overview,
    '/api/symbols': { items: [row('BTCUSDC')] },
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
  });

  it('守护进程在线且已有历史：直接写意图，不做规模预估', async () => {
    const calls = stubFetch(
      baseHandlers({
        '/api/symbols/BTCUSDC/start': row('BTCUSDC', { desiredState: 'running' }),
      }),
    );
    render(<App />);
    await waitFor(() => screen.getByText('BTCUSDC'));

    fireEvent.click(screen.getByRole('button', { name: '开始同步' }));

    await waitFor(() => expect(calls).toContain('/api/symbols/BTCUSDC/start'));
    // 已有历史就只是增量，不该触发首次全量的规模预估
    expect(calls.some((c) => c.includes('/estimate'))).toBe(false);
  });

  it('守护进程在线但库里没有历史：先算规模并要求确认（R-8.3）', async () => {
    const empty = row('BTCUSDC', {
      hasHistory: false,
      state: { ...row('BTCUSDC').state!, rows: 0, bytes: 0 },
    });
    const calls = stubFetch(
      baseHandlers({
        '/api/overview': overview,
        '/api/symbols': { items: [empty] },
        '/api/symbols/BTCUSDC/estimate': {
          symbol: 'BTCUSDC',
          estimate: {
            symbol: 'BTCUSDC',
            bars: 3_719_360,
            requests: 2_480,
            weight: 24_800,
            estimatedMs: 775_000,
            from: NOW - 86_400_000,
            to: NOW,
          },
        },
        '/api/symbols/BTCUSDC/start': row('BTCUSDC', { desiredState: 'running' }),
      }),
    );
    render(<App />);
    await waitFor(() => screen.getByText('BTCUSDC'));

    fireEvent.click(screen.getByRole('button', { name: '开始同步' }));

    // 先出预估弹窗，**还没有**写意图
    await waitFor(() => expect(calls).toContain('/api/symbols/BTCUSDC/estimate'));
    expect(screen.getByText('3,719,360')).toBeTruthy();
    // 请求数 / 权重 / 耗时都取**服务端**的估算值。曾是页面按 1500 与 1920 自己重算，
    // 且把「权重 → 毫秒」算成 ×1000（正确是 ×60_000）：77.5 万毫秒的估算被显示成「0 秒」。
    expect(screen.getByText('2,480 次')).toBeTruthy();
    expect(screen.getByText(/24,800 · 12\.9 分钟/)).toBeTruthy();
    expect(calls).not.toContain('/api/symbols/BTCUSDC/start');

    // 弹窗的确认按钮与行内按钮同名，按 DOM 顺序取最后一个（弹窗在后）。
    // 必须等弹窗真的打开：ConfirmDialog 在 useEffect 里才 showModal，
    // 文本先出现在 DOM 里、可访问性树要等 effect 跑完才补上。
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: '开始同步' })).toHaveLength(2),
    );
    const starts = screen.getAllByRole('button', { name: '开始同步' });
    fireEvent.click(starts[starts.length - 1]);
    await waitFor(() => expect(calls).toContain('/api/symbols/BTCUSDC/start'));
  });

  it('守护进程离线：先说清楚「不会拉数据」，不静默写意图', async () => {
    const calls = stubFetch(
      baseHandlers({
        '/api/overview': {
          ...overview,
          daemon: {
            ...overview.daemon,
            state: 'stopped',
            pid: null,
            lastBeatAt: null,
            ageMs: null,
          },
        },
      }),
    );
    render(<App />);
    await waitFor(() => screen.getByText('BTCUSDC'));

    // 离线横幅常驻可见
    expect(screen.getByText(/守护进程未运行/)).toBeTruthy();

    // 按钮标签本身就写明不会拉数据（R-25.5），不是只在 title 里说
    fireEvent.click(screen.getByRole('button', { name: '开始同步（不会拉数据）' }));

    // 弹解释窗，且**没有**发出 start
    await waitFor(() => expect(screen.getByText(/只是把期望状态写进数据库/)).toBeTruthy());
    expect(calls).not.toContain('/api/symbols/BTCUSDC/start');
  });
});

describe('行内同步按钮', () => {
  it('期望状态 running 时只显示「同步中 · 暂停」，不再出现「开始同步」', async () => {
    stubFetch({
      '/api/overview': overview,
      '/api/symbols': { items: [row('BTCUSDC', { desiredState: 'running' })] },
      '/api/jobs': { items: [] },
      '/api/exchange': {
        exchange: 'binance',
        count: 0,
        cachedAt: NOW,
        ageMs: 0,
        stale: false,
        symbols: [],
      },
    });
    render(<App />);
    await waitFor(() => screen.getByText('BTCUSDC'));

    expect(screen.getByRole('button', { name: /同步中 · 暂停/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '开始同步' })).toBeNull();
    // 「拉取」「校验」已移出行内
    expect(screen.queryByRole('button', { name: '拉取' })).toBeNull();
    expect(screen.queryByRole('button', { name: '校验' })).toBeNull();
  });

  it('期望状态 paused 时显示「开始同步」', async () => {
    stubFetch({
      '/api/overview': overview,
      '/api/symbols': { items: [row('BTCUSDC')] },
      '/api/jobs': { items: [] },
      '/api/exchange': {
        exchange: 'binance',
        count: 0,
        cachedAt: NOW,
        ageMs: 0,
        stale: false,
        symbols: [],
      },
    });
    render(<App />);
    await waitFor(() => screen.getByText('BTCUSDC'));

    expect(screen.getByRole('button', { name: '开始同步' })).toBeTruthy();
  });

  it('守护进程离线时按钮标签本身说明「不会拉数据」（R-25.5 / AC-42）', async () => {
    // 只改 title 不够：title 要悬停才看得到，行内那一眼仍写着「同步中」而数据一动不动，
    // 正是 R-24 / R-25 要禁止的界面。
    stubFetch({
      '/api/overview': {
        ...overview,
        daemon: { ...overview.daemon, state: 'stopped', pid: null, lastBeatAt: null, ageMs: null },
      },
      '/api/symbols': { items: [row('BTCUSDC', { desiredState: 'running' })] },
      '/api/jobs': { items: [] },
      '/api/exchange': {
        exchange: 'binance',
        count: 0,
        cachedAt: NOW,
        ageMs: 0,
        stale: false,
        symbols: [],
      },
    });
    render(<App />);
    await waitFor(() => screen.getByText('BTCUSDC'));

    expect(screen.getByRole('button', { name: /守护进程未运行/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^同步中 · 暂停$/ })).toBeNull();
  });
});

describe('守护进程卡片', () => {
  it('在线时显示心跳的相对时间，且不是把时长当时间戳（曾误显示「20731 天前」）', async () => {
    stubFetch({
      '/api/overview': {
        ...overview,
        daemon: { ...overview.daemon, lastBeatAt: NOW - 30_000, ageMs: 30_000 },
      },
      '/api/symbols': { items: [] },
      '/api/jobs': { items: [] },
      '/api/exchange': {
        exchange: 'binance',
        count: 0,
        cachedAt: NOW,
        ageMs: 0,
        stale: false,
        symbols: [],
      },
    });
    render(<App />);

    // lastBeatAt = NOW - 30s。fmtAgo 收绝对时间戳，
    // 若误传 now - lastBeatAt 会被当成 1970 年的时间而显示成「几万天前」。
    await waitFor(() => expect(screen.getByText('运行中')).toBeTruthy());
    expect(screen.getByText(/心跳 30 秒前 · pid 4242/)).toBeTruthy();
    expect(screen.queryByText(/天前/)).toBeNull();
  });

  it('离线时卡片与横幅都如实显示「未运行」', async () => {
    stubFetch({
      '/api/overview': {
        ...overview,
        daemon: { ...overview.daemon, state: 'stopped', pid: null, lastBeatAt: null, ageMs: null },
      },
      '/api/symbols': { items: [] },
      '/api/jobs': { items: [] },
      '/api/exchange': {
        exchange: 'binance',
        count: 0,
        cachedAt: NOW,
        ageMs: 0,
        stale: false,
        symbols: [],
      },
    });
    render(<App />);

    await waitFor(() => expect(screen.getByText('未运行')).toBeTruthy());
    expect(screen.getByText(/守护进程未运行/)).toBeTruthy();
  });
});

/**
 * 详情页里的 K 线（R-23）。
 *
 * 这一组要验的是**接线**：选中标的 → 详情里出现 K 线面板 → 真的去 `/bars` 取数。
 * 组件自己的行为在 CandleChart / PriceChart 的用例里验，这里只看拼装。
 */
describe('详情页 K 线', () => {
  function detailStub(bars: unknown[], detail: SymbolRowDto = row('BTCUSDC')) {
    return {
      '/api/overview': overview,
      '/api/symbols': { items: [detail] },
      '/api/jobs': { items: [] },
      '/api/exchange': {
        exchange: 'binance',
        count: 1,
        cachedAt: NOW,
        ageMs: 0,
        stale: false,
        symbols: [
          {
            exchange: 'binance',
            symbol: 'BTCUSDC',
            contractType: 'PERPETUAL',
            status: 'TRADING',
            onboardDate: NOW - 86_400_000,
          },
        ],
      },
      // 详情与 K 线是两条不同形状的响应：没有各自的 handler，前缀匹配会让
      // `/api/symbols/BTCUSDC` 拿到列表的 { items }，详情页拿到一个空壳。
      // v0.2.0：`/bars` 回包带上实际生效的 interval / intervalMs（页面据此换算缺口）
      '/api/symbols/BTCUSDC/bars': {
        symbol: 'BTCUSDC',
        interval: '1m',
        intervalMs: 60_000,
        limit: 300,
        items: bars,
      },
      '/api/symbols/BTCUSDC': {
        ...detail,
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
    };
  }

  const bars = Array.from({ length: 4 }, (_, i) => ({
    time: NOW - (3 - i) * 60_000,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100.5 + i,
    volume: 12,
  }));

  it('选中已有历史的标的后画出 K 线，并说明数据读自本地库', async () => {
    const calls = stubFetch(detailStub(bars));
    render(<App />);

    await waitFor(() => expect(screen.getByText('BTCUSDC')).toBeTruthy());
    fireEvent.click(screen.getAllByText('BTCUSDC')[0]!);

    await waitFor(() => expect(screen.getByText(/读自本地库/)).toBeTruthy());
    expect(calls.some((c) => c.startsWith('/api/symbols/BTCUSDC/bars'))).toBe(true);
    // 周期可切（v0.2.0 R-7.4）
    expect(screen.getByTitle('切换到 4h')).toBeTruthy();
    // 区间可切
    expect(screen.getByTitle(/最近 60 根/)).toBeTruthy();
  });

  /**
   * 真实踩过的坑：控制面是**改动前启动的旧进程**，响应里没有 `derived` 字段。
   * 派生周期表当时裸读 `derived[interval]`，于是一个附加统计面板直接把**整个详情页**
   * 打挂（`Cannot read properties of undefined`）——连 K 线图都看不到。
   *
   * 这里是防线：字段缺失时该表格显示「读取中…」，主内容照常渲染。
   */
  it('响应缺少 derived 字段时，详情页照常渲染（附加面板不得弄垮主内容）', async () => {
    const stub = detailStub(bars);
    // 刻意删掉 derived，模拟旧进程 / 未迁移 schema
    const detail = { ...(stub['/api/symbols/BTCUSDC'] as Record<string, unknown>) };
    delete detail['derived'];
    stub['/api/symbols/BTCUSDC'] = detail;

    stubFetch(stub);
    render(<App />);
    await waitFor(() => expect(screen.getByText('BTCUSDC')).toBeTruthy());
    fireEvent.click(screen.getAllByText('BTCUSDC')[0]!);

    // 主内容仍在：K 线图与周期切换都要渲染出来
    await waitFor(() => expect(screen.getByTitle('切换到 4h')).toBeTruthy());
    expect(screen.getByText(/读自本地库/)).toBeTruthy();
    // 派生表退化为「读取中…」而不是抛错
    expect(screen.getAllByText(/读取中/).length).toBeGreaterThan(0);
  });

  it('库里没有历史的标的：K 线区给可执行的下一步，而不是空图', async () => {
    const bare = row('BTCUSDC', { hasHistory: false, state: null });
    stubFetch(detailStub([], bare));
    render(<App />);

    await waitFor(() => expect(screen.getByText('BTCUSDC')).toBeTruthy());
    fireEvent.click(screen.getAllByText('BTCUSDC')[0]!);

    // v0.2.0：空状态必须说明原因并给出下一步，文案里带上标的与动作
    await waitFor(() => expect(screen.getByText(/库里还没有 BTCUSDC 的任何 1m 数据/)).toBeTruthy());
    expect(screen.getByText(/开始同步后/)).toBeTruthy();
  });
});
