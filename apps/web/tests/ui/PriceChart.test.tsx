// @vitest-environment jsdom
// UI 用例需要 DOM；服务端用例跑在默认的 node 环境。
import './setup.js';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PriceChart } from '../../ui/src/components/PriceChart';
import type { BarDto } from '../../src/types';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const MINUTE = 60_000;
const BASE = 1_760_000_000_000;

function bar(time: number, close: number): BarDto {
  return { time, open: close, high: close + 1, low: close - 1, close, volume: 10 };
}

function series(n: number, step = MINUTE): BarDto[] {
  return Array.from({ length: n }, (_, i) => bar(BASE + i * step, 100 + i));
}

/**
 * 构造 `/bars` 的回包。
 *
 * `interval` / `intervalMs` 是 v0.2.0 新增的**实际生效值**（R-7.3）：页面靠它把缺口
 * 换算成「几根 / 几段 / 最长连续」，写死 1m 会在 4h 图上把 4 小时说成 1 分钟。
 */
function barsPayload(limit: number, items: BarDto[], interval = '1m', intervalMs = MINUTE) {
  return { symbol: 'AAAUSDT', interval, intervalMs, limit, items };
}

/** 记录调用路径的假 fetch；`fail` 时返回服务端错误体。 */
function stubFetch(payload: unknown, opts: { fail?: boolean } = {}) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (opts.fail === true) {
      return new Response(JSON.stringify({ error: { code: 'PG_ERROR', message: '库读不出来' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

/**
 * 按请求里的 `interval` 分发不同回包。
 *
 * 周期切换类用例**必须**用这个：固定回包的 stub 会在切到 4h 之后仍然返回 1m 的数据，
 * 于是「空状态原因」「缺口按周期量化」这些断言根本走不到对应分支——测的是渲染分支，
 * 不是周期行为。
 */
function stubFetchByInterval(byInterval: Record<string, { items: BarDto[]; limit?: number }>) {
  const calls: string[] = [];
  const widths: Record<string, number> = {
    '1m': MINUTE,
    '15m': 15 * MINUTE,
    '1h': 60 * MINUTE,
    '4h': FOUR_HOURS,
    '1d': 24 * 60 * MINUTE,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const interval = new URL(url, 'http://localhost').searchParams.get('interval') ?? '1m';
      const spec = byInterval[interval];
      const body = {
        symbol: 'AAAUSDT',
        interval,
        intervalMs: widths[interval] ?? MINUTE,
        limit: spec?.limit ?? 300,
        items: spec?.items ?? [],
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return { calls };
}

function renderChart(props: Partial<Parameters<typeof PriceChart>[0]> = {}) {
  return render(<PriceChart symbol="AAAUSDT" totalRows={123_456} hasHistory tick={0} {...props} />);
}

describe('PriceChart 取数', () => {
  it('库里没数据时不发请求，直接给可执行的下一步', async () => {
    const { calls } = stubFetch(barsPayload(300, []));
    renderChart({ hasHistory: false, totalRows: 0 });

    expect(calls).toHaveLength(0);
    expect(screen.getByText(/库里还没有/)).toBeTruthy();
    expect(screen.getByText(/开始同步后/)).toBeTruthy();
  });

  it('有数据时取最近 N 根并画出蜡烛', async () => {
    const { calls } = stubFetch(barsPayload(300, series(5)));
    const { container } = renderChart();

    await waitFor(() => expect(container.querySelectorAll('rect[data-bar-time]')).toHaveLength(5));
    expect(calls[0]).toContain('/api/symbols/AAAUSDT/bars?limit=300');
    // 缺省请求必须显式带上 interval=1m（向后兼容，服务端据此分派表）
    expect(calls[0]).toContain('interval=1m');
  });

  it('图注说清「图上这点 vs 库里那堆」，不让人误以为看全了', async () => {
    stubFetch(barsPayload(300, series(5)));
    renderChart({ totalRows: 123_456 });

    await waitFor(() => expect(screen.getByText(/库内共/)).toBeTruthy());
    expect(screen.getByText(/123,456/)).toBeTruthy();
  });

  it('切区间按新根数重新取数', async () => {
    const { calls } = stubFetch(barsPayload(300, series(5)));
    renderChart();

    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => {
      fireEvent.click(screen.getByTitle(/最近 60 根/));
    });

    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toContain('limit=60');
  });

  it('跟全局刷新走：tick 变化才重新取数（不自己另开轮询）', async () => {
    const { calls } = stubFetch(barsPayload(300, series(5)));
    const { rerender } = renderChart();

    await waitFor(() => expect(calls).toHaveLength(1));
    // 同一个 tick：不重复取数
    rerender(<PriceChart symbol="AAAUSDT" totalRows={1} hasHistory tick={0} />);
    expect(calls).toHaveLength(1);

    await act(async () => {
      rerender(<PriceChart symbol="AAAUSDT" totalRows={1} hasHistory tick={1} />);
    });
    await waitFor(() => expect(calls).toHaveLength(2));
  });

  it('服务端给的生效上限小于请求量时如实标注，不把截断后的图当成完整数据', async () => {
    stubFetch(barsPayload(900, series(3)));
    renderChart();

    // 缺省区间 300 < 900，不算截断
    await waitFor(() => expect(screen.getByText(/读取于/)).toBeTruthy());
    expect(screen.queryByText(/请求被截断/)).toBeNull();

    // 切到 1440 根：900 < 1440，图只覆盖了一部分，必须说出来
    await act(async () => {
      fireEvent.click(screen.getByTitle(/最近 1,440 根/));
    });
    await waitFor(() => expect(screen.getByText(/请求被截断到/)).toBeTruthy());
  });

  it('读取失败必须**常驻可见**，并说明下面的是旧数据', async () => {
    const { fetchMock } = stubFetch(barsPayload(300, series(5)));
    const { container } = renderChart();
    await waitFor(() => expect(container.querySelectorAll('rect[data-bar-time]').length).toBe(5));

    // 之后开始失败
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { code: 'PG_ERROR', message: '库读不出来' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await act(async () => {
      fireEvent.click(screen.getByTitle(/最近 60 根/));
    });

    await waitFor(() => expect(screen.getByText(/读取 K 线失败/)).toBeTruthy());
    // 失败时不清空图：数据还在，标注是上一次的
    expect(container.querySelectorAll('rect[data-bar-time]').length).toBeGreaterThan(0);
    expect(screen.getByText(/上一次读到的数据/)).toBeTruthy();
  });

  it('库里没有该标的的数据时显示空状态，不是报错', async () => {
    stubFetch(barsPayload(300, []));
    renderChart();

    // 1m 周期下的空状态文案：说明原因而不是笼统说「没有数据」
    // 要等 loading 结束：读数中显示的是「正在读取 K 线…」
    await waitFor(() => expect(document.body.textContent).toContain('这个区间内库里没有 1m 数据'));
  });

  /**
   * 真实踩过的坑：控制面是改动前启动的旧进程。路由在**启动时**注册，于是 `/bars`
   * 返回 404，且响应体不是本服务的错误体 → 前端只能报一句 `404 Not Found`。那等于
   * 把「重启控制面」这唯一的解法藏起来了，用户只会以为是同步出了问题。
   */
  it('404 判为「控制面是旧进程」，并说清该重启', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('404 Not Found', { status: 404 })),
    );
    renderChart();

    await waitFor(() => expect(screen.getByText(/CONTROL_PLANE_STALE/)).toBeTruthy());
    expect(screen.getByText(/重启 trade-tool 控制面/)).toBeTruthy();
  });

  it('404 之外的错误不被改写成「旧进程」', async () => {
    stubFetch({}, { fail: true });
    renderChart();

    await waitFor(() => expect(screen.getByText(/\[PG_ERROR\] 库读不出来/)).toBeTruthy());
  });
});

const FOUR_HOURS = 4 * 60 * MINUTE;

/**
 * 周期切换与缺口量化（v0.2.0 R-7.3 / R-7.4 / AC-14）。
 *
 * 重点是「不骗人」：切到 4h 后，缺口必须按**根**报（4h 图上少一根 = 4 小时），
 * 并说明根因在上游 1m；把分钟数原样贴到 4h 图上是需求明令禁止的。
 */
describe('PriceChart 周期切换', () => {
  /** 4h 桶：0,1,3,4 —— 第 2 根缺失（跳过一根） */
  function fourHourBars(): BarDto[] {
    return [0, 1, 3, 4].map((i) => bar(BASE + i * FOUR_HOURS, 100 + i));
  }

  it('切到 4h 后请求带 interval=4h，且当前周期一直可见', async () => {
    const { calls } = stubFetchByInterval({
      '1m': { items: series(5) },
      '4h': { items: fourHourBars() },
    });
    renderChart();

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toContain('interval=1m');

    await act(async () => {
      fireEvent.click(screen.getByTitle('切换到 4h'));
    });

    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toContain('interval=4h');
    // 当前周期必须常驻可见，否则用户不知道自己在看哪一档
    await waitFor(() => expect(document.body.textContent).toContain('4h K 线'));
  });

  it('五个周期都有显式控件，缺省停在 1m', async () => {
    stubFetchByInterval({ '1m': { items: series(5) } });
    renderChart();
    for (const interval of ['1m', '15m', '1h', '4h', '1d']) {
      expect(screen.getByTitle(`切换到 ${interval}`), `缺少 ${interval} 控件`).toBeTruthy();
    }
    expect(document.body.textContent).toContain('1m K 线');
  });

  it('缺口按所选周期报「根」而不是「分钟」（R-7.3）', async () => {
    stubFetchByInterval({ '1m': { items: series(5) }, '4h': { items: fourHourBars() } });
    renderChart();

    await act(async () => {
      fireEvent.click(screen.getByTitle('切换到 4h'));
    });

    // 同一句里既有「缺 1 根」也有「4 小时」，用容器文本断言避免多重匹配
    await waitFor(() => expect(document.body.textContent).toContain('缺 1 根'));
    expect(document.body.textContent).toContain('4 小时');
    // 4h 下一根 = 4 小时：说成「缺 1 分钟」就是把 1m 的口径贴到了 4h 图上
    expect(document.body.textContent).not.toContain('缺 1 分钟');
  });

  it('说明根因在上游 1m，并标明那是全历史累计口径', async () => {
    stubFetchByInterval({ '1m': { items: series(5) }, '4h': { items: fourHourBars() } });
    renderChart({
      derived: {
        '4h': { buckets: 4, withheldNotClosed: 0, withheldIncomplete: 1, missingMinutes: 240 },
      },
    });

    await act(async () => {
      fireEvent.click(screen.getByTitle('切换到 4h'));
    });

    await waitFor(() => expect(document.body.textContent).toContain('根因在上游 1m'));
    expect(document.body.textContent).toContain('240');
    // 服务端给的是**全历史累计**的缺失分钟数，不是本窗口的。文案必须写清口径——
    // 说成「该区间缺 240 分钟」会把别处老洞的分钟数算到这张图的空白头上。
    expect(document.body.textContent).toContain('累计');
    expect(document.body.textContent).toContain('含本区间');
  });

  it('上游 1m 有缺口导致该周期一个桶都没有时，说明原因而不是空白图', async () => {
    stubFetchByInterval({ '1m': { items: series(5) }, '4h': { items: [] } });
    renderChart({
      derived: {
        '4h': { buckets: 0, withheldNotClosed: 0, withheldIncomplete: 2, missingMinutes: 480 },
      },
    });

    await act(async () => {
      fireEvent.click(screen.getByTitle('切换到 4h'));
    });

    await waitFor(() => expect(document.body.textContent).toContain('上游 1m 缺'));
    // 并说明补上缺口后会自动出现，不需要人工重建
    expect(document.body.textContent).toContain('自动出现');
  });

  it('桶尚未收盘导致空状态时说明「等下一批」', async () => {
    stubFetchByInterval({ '1m': { items: series(5) }, '1h': { items: [] } });
    renderChart({
      derived: {
        '1h': { buckets: 0, withheldNotClosed: 1, withheldIncomplete: 0, missingMinutes: 0 },
      },
    });

    await act(async () => {
      fireEvent.click(screen.getByTitle('切换到 1h'));
    });

    await waitFor(() => expect(document.body.textContent).toContain('还没走完'));
    expect(document.body.textContent).toContain('下一批');
  });

  it('未启用派生时明说，而不是显示 0 个桶（AC-22）', async () => {
    stubFetchByInterval({ '1m': { items: series(5) }, '4h': { items: [] } });
    renderChart({
      derived: { '4h': { withheldReason: 'disabled' } },
      onAggregate: () => undefined,
    });

    await act(async () => {
      fireEvent.click(screen.getByTitle('切换到 4h'));
    });

    await waitFor(() => expect(document.body.textContent).toContain('未启用派生'));
    // 未启用的周期**没有可执行的重建**：作业读的是同一个配置（`data.aggregateIntervals`），
    // 点了也只会重算启用的那几个周期，当前周期照样一根都不出现。
    // 所以这里只说明原因（下一步是改配置），不给一个按了也不会好的按钮。
    expect(document.body.textContent).toContain('data.aggregateIntervals');
    expect(screen.queryByText(/重建派生 K 线/)).toBeNull();
  });

  it('重建按钮触发确认而不是直接开跑（长活儿要显式确认）', async () => {
    const onAggregate = vi.fn();
    const { calls } = stubFetchByInterval({ '1m': { items: series(5) }, '4h': { items: [] } });
    // 启用但暂时没有桶（末尾那个还没收盘）——这种空状态才是重建按钮的用武之地
    renderChart({
      derived: {
        '4h': { buckets: 0, withheldNotClosed: 1, withheldIncomplete: 0, missingMinutes: 0 },
      },
      onAggregate,
    });

    await act(async () => {
      fireEvent.click(screen.getByTitle('切换到 4h'));
    });
    await waitFor(() => expect(document.body.textContent).toContain('重建派生 K 线'));

    // 按钮只负责**请求**重建（App 层会弹确认），不发任何网络请求
    await act(async () => {
      fireEvent.click(screen.getByText(/重建派生 K 线/));
    });
    expect(onAggregate).toHaveBeenCalledTimes(1);

    expect(calls.some((c) => c.startsWith('/api/symbols/AAAUSDT/aggregate'))).toBe(false);
  });
});
