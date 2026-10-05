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

function series(n: number): BarDto[] {
  return Array.from({ length: n }, (_, i) => bar(BASE + i * MINUTE, 100 + i));
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

function renderChart(props: Partial<Parameters<typeof PriceChart>[0]> = {}) {
  return render(<PriceChart symbol="AAAUSDT" totalRows={123_456} hasHistory tick={0} {...props} />);
}

describe('PriceChart 取数', () => {
  it('库里没数据时不发请求，直接给可执行的下一步', async () => {
    const { calls } = stubFetch({});
    renderChart({ hasHistory: false, totalRows: 0 });

    expect(calls).toHaveLength(0);
    expect(screen.getByText(/库里还没有/)).toBeTruthy();
    expect(screen.getByText(/开始同步后/)).toBeTruthy();
  });

  it('有数据时取最近 N 根并画出蜡烛', async () => {
    const { calls } = stubFetch({ symbol: 'AAAUSDT', limit: 300, items: series(5) });
    const { container } = renderChart();

    await waitFor(() => expect(container.querySelectorAll('rect[data-bar-time]')).toHaveLength(5));
    expect(calls[0]).toContain('/api/symbols/AAAUSDT/bars?limit=300');
  });

  it('图注说清「图上这点 vs 库里那堆」，不让人误以为看全了', async () => {
    stubFetch({ symbol: 'AAAUSDT', limit: 300, items: series(5) });
    renderChart({ totalRows: 123_456 });

    await waitFor(() => expect(screen.getByText(/库内共/)).toBeTruthy());
    expect(screen.getByText(/123,456/)).toBeTruthy();
  });

  it('切区间按新根数重新取数', async () => {
    const { calls } = stubFetch({ symbol: 'AAAUSDT', limit: 300, items: series(5) });
    renderChart();

    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => {
      fireEvent.click(screen.getByTitle(/最近 60 分钟/));
    });

    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toContain('limit=60');
  });

  it('跟全局刷新走：tick 变化才重新取数（不自己另开轮询）', async () => {
    const { calls } = stubFetch({ symbol: 'AAAUSDT', limit: 300, items: series(5) });
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
    stubFetch({ symbol: 'AAAUSDT', limit: 900, items: series(3) });
    renderChart();

    // 缺省区间 300 < 900，不算截断
    await waitFor(() => expect(screen.getByText(/读取于/)).toBeTruthy());
    expect(screen.queryByText(/请求被截断/)).toBeNull();

    // 切到 1440 根：900 < 1440，图只覆盖了一部分，必须说出来
    await act(async () => {
      fireEvent.click(screen.getByTitle(/最近 1,440 分钟/));
    });
    await waitFor(() => expect(screen.getByText(/请求被截断到/)).toBeTruthy());
  });

  it('读取失败必须**常驻可见**，并说明下面的是旧数据', async () => {
    const { fetchMock } = stubFetch({ symbol: 'AAAUSDT', limit: 300, items: series(5) });
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
      fireEvent.click(screen.getByTitle(/最近 60 分钟/));
    });

    await waitFor(() => expect(screen.getByText(/读取 K 线失败/)).toBeTruthy());
    // 失败时不清空图：数据还在，标注是上一次的
    expect(container.querySelectorAll('rect[data-bar-time]').length).toBeGreaterThan(0);
    expect(screen.getByText(/上一次读到的数据/)).toBeTruthy();
  });

  it('库里没有该标的的数据时显示空状态，不是报错', async () => {
    stubFetch({ symbol: 'AAAUSDT', limit: 300, items: [] });
    renderChart();

    await waitFor(() => expect(screen.getByText(/这个区间内库里没有数据/)).toBeTruthy());
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
