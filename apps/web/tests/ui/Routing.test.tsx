// @vitest-environment jsdom
// UI 用例需要 DOM；服务端用例跑在默认的 node 环境。
import './setup.js';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../ui/src/App';
import { parseRoute } from '../../ui/src/router';
import { baseHandlers, stubFetch, symbolHandlers, symbolRow } from './fixtures';

const TWO = {
  '/api/symbols': { items: [symbolRow('AAAUSDT'), symbolRow('BBBUSDT')] },
};

function handlers() {
  return baseHandlers({
    ...TWO,
    ...symbolHandlers('AAAUSDT'),
    ...symbolHandlers('BBBUSDT'),
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  window.location.hash = '';
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('hash 路由解析', () => {
  it('三条路由各自解析，认不出的回首页而不是空白', () => {
    expect(parseRoute('')).toEqual({ kind: 'home' });
    expect(parseRoute('#/')).toEqual({ kind: 'home' });
    expect(parseRoute('#/settings')).toEqual({ kind: 'settings' });
    expect(parseRoute('#/symbol/AAAUSDT')).toEqual({ kind: 'symbol', symbol: 'AAAUSDT' });
    // 带百分号编码的标的来回一圈
    expect(parseRoute('#/symbol/A%2FB')).toEqual({ kind: 'symbol', symbol: 'A/B' });
    // 认不出 / 残缺 / 非法转义：都给首页这个明确落点
    expect(parseRoute('#/nope')).toEqual({ kind: 'home' });
    expect(parseRoute('#/symbol')).toEqual({ kind: 'home' });
    expect(parseRoute('#/symbol/%E0%A4%A')).toEqual({ kind: 'home' });
  });
});

describe('详情页路由', () => {
  it('地址是 #/symbol/X 时直接进详情，而不是先闪一下首页', async () => {
    window.location.hash = '#/symbol/AAAUSDT';
    const stub = stubFetch(handlers());

    render(<App />);

    // 首屏就是详情：合约状态区块出现，首页的标的表不出现
    await waitFor(() => expect(screen.getByText('合约与状态')).toBeTruthy());
    expect(screen.queryByText('标的集合')).toBeNull();
    expect(stub.urls()).toContain('/api/symbols/AAAUSDT');
  });

  it('详情页里切标的不整页刷新：同一个根节点活下来，内容换了', async () => {
    window.location.hash = '#/symbol/AAAUSDT';
    const stub = stubFetch(handlers());
    const { container } = render(<App />);
    await waitFor(() => expect(screen.getByText('合约与状态')).toBeTruthy());

    // 抓住根节点：整页刷新会把它换成另一个对象，页内导航不会
    const rootBefore = container.firstElementChild;
    const detailCallsBefore = stub.calls.filter((c) => c.url === '/api/symbols/AAAUSDT').length;
    const overviewCallsBefore = stub.calls.filter((c) => c.url === '/api/overview').length;

    fireEvent.change(screen.getByLabelText('切换标的'), { target: { value: 'BBBUSDT' } });

    await waitFor(() => expect(window.location.hash).toBe('#/symbol/BBBUSDT'));
    await waitFor(() => expect(stub.urls()).toContain('/api/symbols/BBBUSDT'));

    // 没有整页重载：同一个 DOM 节点还在，首页那一套接口也没有被重新拉一遍
    // （整页刷新会把 /api/overview 重新取一次）
    expect(container.firstElementChild).toBe(rootBefore);
    expect(stub.calls.filter((c) => c.url === '/api/overview')).toHaveLength(overviewCallsBefore);
    expect(stub.calls.filter((c) => c.url === '/api/symbols/AAAUSDT')).toHaveLength(
      detailCallsBefore,
    );
  });

  it('上一个 / 下一个按页面上的标的顺序走', async () => {
    window.location.hash = '#/symbol/AAAUSDT';
    stubFetch(handlers());
    render(<App />);
    await waitFor(() => expect(screen.getByText('合约与状态')).toBeTruthy());

    // AAAUSDT 是集合里的第一个：上一个不可用，下一个可用
    expect((screen.getByTitle('上一个标的') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTitle('下一个标的'));
    await waitFor(() => expect(window.location.hash).toBe('#/symbol/BBBUSDT'));
  });

  it('刷新页面后停在同一路由（hash 是唯一的真相，不回到首页）', async () => {
    window.location.hash = '#/symbol/BBBUSDT';
    stubFetch(handlers());

    const first = render(<App />);
    await waitFor(() => expect(screen.getByText('合约与状态')).toBeTruthy());
    // 卸载再挂载 = 浏览器刷新（同一个 window，hash 还在）
    first.unmount();
    cleanup();

    render(<App />);
    await waitFor(() => expect(screen.getByText('合约与状态')).toBeTruthy());
    expect(window.location.hash).toBe('#/symbol/BBBUSDT');
  });

  it('从详情能回首页', async () => {
    window.location.hash = '#/symbol/AAAUSDT';
    stubFetch(handlers());
    render(<App />);
    await waitFor(() => expect(screen.getByText('合约与状态')).toBeTruthy());

    fireEvent.click(screen.getByTitle('回到首页'));

    await waitFor(() => expect(screen.getByText('标的集合')).toBeTruthy());
    expect(screen.queryByText('合约与状态')).toBeNull();
  });

  it('详情读不出来时错误常驻在页面上，而不是显示成空详情', async () => {
    window.location.hash = '#/symbol/AAAUSDT';
    // 详情接口明确失败，其它接口照常
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api/symbols/AAAUSDT')) {
          return new Response(
            JSON.stringify({ error: { code: 'SYMBOL_NOT_FOUND', message: '库里没有这个标的' } }),
            { status: 404 },
          );
        }
        const ok =
          handlers()[
            Object.keys(handlers())
              .filter((k) => url.startsWith(k))
              .sort((a, b) => b.length - a.length)[0] as string
          ];
        if (ok === undefined) return new Response('not found', { status: 404 });
        return new Response(JSON.stringify(ok), { status: 200 });
      }),
    );

    render(<App />);

    await waitFor(() => expect(screen.getByText(/SYMBOL_NOT_FOUND/)).toBeTruthy());
    // 失败必须留在页面上；也不能把「读不到」画成一份空详情冒充正常
    expect(screen.queryByText('合约与状态')).toBeNull();
  });
});
