// @vitest-environment jsdom
// UI 用例需要 DOM；服务端用例跑在默认的 node 环境。
import './setup.js';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../ui/src/App';
import type { CredentialStatusDto, RiskPolicyViewDto } from '../../src/types';
import { baseHandlers, stubFetch, symbolRow } from './fixtures';

const NOW = 1_760_000_000_000;

function credential(overrides: Partial<CredentialStatusDto> = {}): CredentialStatusDto {
  return {
    exchange: 'binance',
    configured: false,
    hint: null,
    updatedAt: null,
    masterKeyReady: true,
    ...overrides,
  };
}

function policy(overrides: Partial<RiskPolicyViewDto> = {}): RiskPolicyViewDto {
  return {
    exchange: 'binance',
    global: null,
    overrides: [],
    resolved: {
      atrPeriod: 14,
      atrInterval: '1h',
      stopAtrMult: 2,
      takeProfitAtrMult: 3,
      source: 'config',
    },
    ...overrides,
  };
}

function handlers(extra: Record<string, unknown> = {}) {
  return baseHandlers({
    '/api/symbols': { items: [symbolRow('AAAUSDT'), symbolRow('BBBUSDT')] },
    '/api/settings/credentials': credential(),
    '/api/settings/risk-policy': policy(),
    ...extra,
  });
}

/**
 * 等标的下拉真的拿到运行时集合。
 *
 * 直接 `fireEvent.change(select, { value })` 在选项还没加载完时会**静默无效**：
 * select 里没有那个 option，值赋不进去，状态没变，页面也不报错——用例就会一直等。
 */
async function waitForSymbolOptions(): Promise<void> {
  await waitFor(() => expect(screen.getByRole('option', { name: 'AAAUSDT' })).toBeTruthy());
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  window.location.hash = '#/settings';
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('设置页 · 凭据', () => {
  it('主密钥未就绪时表单禁用，并说清缺什么（而不是让人填完再失败）', async () => {
    stubFetch(handlers({ '/api/settings/credentials': credential({ masterKeyReady: false }) }));
    render(<App />);

    await waitFor(() => expect(screen.getByText(/TRADE_TOOL_SECRET_KEY/)).toBeTruthy());

    const key = screen.getByLabelText('API Key') as HTMLInputElement;
    const secret = screen.getByLabelText('API Secret') as HTMLInputElement;
    expect(key.disabled).toBe(true);
    expect(secret.disabled).toBe(true);
    expect((screen.getByRole('button', { name: '保存凭据' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('已配置的密钥只显示末 4 位，输入框不回填明文', async () => {
    stubFetch(
      handlers({
        '/api/settings/credentials': credential({
          configured: true,
          hint: 'WXYZ',
          updatedAt: NOW - 60_000,
        }),
      }),
    );
    render(<App />);

    await waitFor(() => expect(screen.getByText(/末 4 位 WXYZ/)).toBeTruthy());
    expect(screen.getByText(/更新于/)).toBeTruthy();

    // 回包里没有明文，前端也就没有可回填的东西：
    // 把空框显示成「已填」比显示「末 4 位」危险得多。
    expect((screen.getByLabelText('API Key') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('API Secret') as HTMLInputElement).value).toBe('');
    // 提交后也要清空，不在页面上留一份副本
    expect((screen.getByLabelText('API Secret') as HTMLInputElement).type).toBe('password');
  });

  it('保存成功后就地更新状态，且清空输入框', async () => {
    const stub = stubFetch(
      handlers({
        '/api/settings/credentials': credential({ configured: true, hint: 'WXYZ', updatedAt: NOW }),
      }),
    );
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText('API Key')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'key-value' } });
    fireEvent.change(screen.getByLabelText('API Secret'), { target: { value: 'secret-value' } });
    fireEvent.click(screen.getByRole('button', { name: '保存凭据' }));

    await waitFor(() =>
      expect(
        stub.calls.some((c) => c.method === 'PUT' && c.url === '/api/settings/credentials'),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.getByText(/末 4 位 WXYZ/)).toBeTruthy());
    expect((screen.getByLabelText('API Key') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('API Secret') as HTMLInputElement).value).toBe('');
  });

  it('服务端拒绝时错误常驻显示在页面上', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'PUT') {
          return new Response(
            JSON.stringify({
              error: { code: 'CONFIG_INVALID', message: 'apiKey 与 apiSecret 都不能为空' },
            }),
            { status: 400 },
          );
        }
        const all = handlers();
        const key = Object.keys(all)
          .filter((k) => url.startsWith(k))
          .sort((a, b) => b.length - a.length)[0];
        if (key === undefined) return new Response('not found', { status: 404 });
        return new Response(JSON.stringify(all[key]), { status: 200 });
      }),
    );
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText('API Key')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'k' } });
    fireEvent.change(screen.getByLabelText('API Secret'), { target: { value: 's' } });
    fireEvent.click(screen.getByRole('button', { name: '保存凭据' }));

    await waitFor(() => expect(screen.getByText(/CONFIG_INVALID/)).toBeTruthy());
  });

  it('清空凭据需要二次确认', async () => {
    const stub = stubFetch(
      handlers({
        '/api/settings/credentials': credential({ configured: true, hint: 'WXYZ', updatedAt: NOW }),
      }),
    );
    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: '清空凭据' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: '清空凭据' }));

    // 只弹出解释窗，还没有发 DELETE
    await waitFor(() => expect(screen.getByText(/清空之后/)).toBeTruthy());
    expect(stub.calls.some((c) => c.method === 'DELETE')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '确认清空' }));
    await waitFor(() =>
      expect(
        stub.calls.some((c) => c.method === 'DELETE' && c.url === '/api/settings/credentials'),
      ).toBe(true),
    );
  });
});

describe('设置页 · 止盈止损策略', () => {
  it('生效来源：配置文件（库里还没设过）', async () => {
    stubFetch(handlers());
    render(<App />);

    await waitFor(() => expect(screen.getByText('配置文件')).toBeTruthy());
    // 显示的数值就是 resolved 里的那一套，不是表单里正在编辑的草稿
    expect(screen.getByText('14 × 1h')).toBeTruthy();
    expect(screen.getByText('2 × ATR')).toBeTruthy();
  });

  it('生效来源：全局默认（该标的没有覆盖）', async () => {
    stubFetch({
      ...handlers(),
      '/api/settings/risk-policy': policy({
        global: {
          scope: 'global',
          exchange: 'binance',
          symbol: '',
          atrPeriod: 20,
          atrInterval: '15m',
          stopAtrMult: 1.5,
          takeProfitAtrMult: 2.5,
          updatedAt: NOW,
        },
        resolved: {
          atrPeriod: 20,
          atrInterval: '15m',
          stopAtrMult: 1.5,
          takeProfitAtrMult: 2.5,
          source: 'global',
        },
      }),
    });
    render(<App />);

    await waitFor(() => expect(screen.getByText('全局默认')).toBeTruthy());
    expect(screen.getByText('20 × 15m')).toBeTruthy();
  });

  it('生效来源：本标的覆盖（改了就该一眼看出来自哪一层）', async () => {
    stubFetch({
      ...handlers(),
      '/api/settings/risk-policy': policy({
        overrides: [
          {
            scope: 'symbol',
            exchange: 'binance',
            symbol: 'AAAUSDT',
            atrPeriod: 30,
            atrInterval: '4h',
            stopAtrMult: 2.5,
            takeProfitAtrMult: 5,
            updatedAt: NOW,
          },
        ],
        resolved: {
          atrPeriod: 30,
          atrInterval: '4h',
          stopAtrMult: 2.5,
          takeProfitAtrMult: 5,
          source: 'symbol',
        },
      }),
    });
    render(<App />);

    await waitForSymbolOptions();
    fireEvent.change(screen.getByLabelText('选择标的'), { target: { value: 'AAAUSDT' } });

    await waitFor(() => expect(screen.getByText('本标的覆盖')).toBeTruthy());
    expect(screen.getByText('30 × 4h')).toBeTruthy();
  });

  it('删除覆盖的请求参数正确（scope 与 symbol 都要带上）', async () => {
    const stub = stubFetch(
      handlers({
        '/api/settings/risk-policy': policy({
          overrides: [
            {
              scope: 'symbol',
              exchange: 'binance',
              symbol: 'AAAUSDT',
              atrPeriod: 30,
              atrInterval: '4h',
              stopAtrMult: 2.5,
              takeProfitAtrMult: 5,
              updatedAt: NOW,
            },
          ],
          resolved: {
            atrPeriod: 30,
            atrInterval: '4h',
            stopAtrMult: 2.5,
            takeProfitAtrMult: 5,
            source: 'symbol',
          },
        }),
      }),
    );
    render(<App />);

    await waitForSymbolOptions();
    fireEvent.change(screen.getByLabelText('选择标的'), { target: { value: 'AAAUSDT' } });
    // 等覆盖那一栏真的读到（切换标的后会重新取一次），否则按钮还停在「没有覆盖」的禁用态
    await waitFor(() => expect(screen.getByText('该标的有覆盖，优先于全局')).toBeTruthy());
    const del = screen.getByRole('button', { name: '删除覆盖（回到全局默认）' });
    expect((del as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(del);

    await waitFor(() =>
      expect(
        stub.calls.some(
          (c) =>
            c.method === 'DELETE' &&
            c.url === '/api/settings/risk-policy?scope=symbol&symbol=AAAUSDT',
        ),
      ).toBe(true),
    );
  });

  it('没有覆盖时「删除覆盖」不可点（不发无意义的请求）', async () => {
    stubFetch(handlers());
    render(<App />);
    await waitForSymbolOptions();
    fireEvent.change(screen.getByLabelText('选择标的'), { target: { value: 'BBBUSDT' } });
    await waitFor(() =>
      expect(screen.getByText('该标的没有覆盖，正在生效的是上面那一档')).toBeTruthy(),
    );

    const del = screen.getByRole('button', { name: '删除覆盖（回到全局默认）' });
    expect((del as HTMLButtonElement).disabled).toBe(true);
  });

  it('保存全局默认带上全部四个字段', async () => {
    const stub = stubFetch(handlers());
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText('全局默认 ATR 周期')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('全局默认 ATR 周期'), { target: { value: '21' } });
    fireEvent.change(screen.getByLabelText('全局默认 ATR 周期口径'), { target: { value: '4h' } });
    fireEvent.change(screen.getByLabelText('全局默认 止损倍数'), { target: { value: '2.5' } });
    fireEvent.change(screen.getByLabelText('全局默认 止盈倍数'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: '保存全局默认' }));

    await waitFor(() => {
      const put = stub.calls.find((c) => c.method === 'PUT');
      expect(put?.url).toBe('/api/settings/risk-policy');
      expect(put?.body).toEqual({
        scope: 'global',
        atrPeriod: 21,
        atrInterval: '4h',
        stopAtrMult: 2.5,
        takeProfitAtrMult: 4,
      });
    });
  });

  it('服务端返回的校验错误常驻显示（校验规则只留服务端一份）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'PUT') {
          return new Response(
            JSON.stringify({
              error: { code: 'CONFIG_INVALID', message: 'atrPeriod 必须在 1..200 之间' },
            }),
            { status: 400 },
          );
        }
        const all = handlers();
        const key = Object.keys(all)
          .filter((k) => url.startsWith(k))
          .sort((a, b) => b.length - a.length)[0];
        if (key === undefined) return new Response('not found', { status: 404 });
        return new Response(JSON.stringify(all[key]), { status: 200 });
      }),
    );
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText('全局默认 ATR 周期')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('全局默认 ATR 周期'), { target: { value: '999' } });
    fireEvent.change(screen.getByLabelText('全局默认 止损倍数'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('全局默认 止盈倍数'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: '保存全局默认' }));

    // 前端不自己复述范围规则，错误由服务端给出并留在页面上
    await waitFor(() => expect(screen.getByText(/atrPeriod 必须在 1..200 之间/)).toBeTruthy());
  });

  it('写明「改动只影响之后的新买入成交，已挂出的单不会撤单重挂」', async () => {
    stubFetch(handlers());
    render(<App />);
    await waitFor(() => expect(screen.getByText(/只影响之后的新买入成交/)).toBeTruthy());
  });
});
