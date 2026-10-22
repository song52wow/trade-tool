// @vitest-environment jsdom
// UI 用例需要 DOM；服务端用例跑在默认的 node 环境。
import './setup.js';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../ui/src/App';
import type {
  AgentLlmStatusDto,
  CredentialStatusDto,
  NotifyStatusDto,
  RiskPolicyViewDto,
} from '../../src/types';
import { navigate } from '../../ui/src/router';
import { baseHandlers, stubFetch, symbolHandlers, symbolRow } from './fixtures';

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

const TOPICS = [
  {
    kind: 'missing-stop-order',
    label: '仓位没有止损保护',
    hint: '本地记着已挂单，交易所却没有止损单',
  },
  { kind: 'missing-take-profit-order', label: '止盈单没了', hint: '止损还在，止盈单已不在交易所' },
];

/** 通知设置状态。默认「没配、走配置文件那一档」。 */
function notify(overrides: Partial<NotifyStatusDto> = {}): NotifyStatusDto {
  return {
    enabled: false,
    kinds: TOPICS.map((t) => t.kind),
    topics: TOPICS,
    repeatCooldownMs: 1_800_000,
    configured: false,
    hint: null,
    secretConfigured: false,
    source: 'config',
    webhookEnv: 'TRADE_TOOL_FEISHU_WEBHOOK_URL',
    secretEnv: 'TRADE_TOOL_FEISHU_WEBHOOK_SECRET',
    panel: null,
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
      takeProfit1Percent: 0,
      trailAtrMult: 2,
      breakevenAfterTp1: true,
      source: 'config',
    },
    ...overrides,
  };
}

/**
 * 模型接入设置的桩（v1.0.0）。
 *
 * 默认是「控制面没录入、生效来源是配置文件那一档」——最常见的那种状态。
 */
function agentLlm(overrides: Partial<AgentLlmStatusDto> = {}): AgentLlmStatusDto {
  return {
    enabled: false,
    baseUrl: '',
    model: '',
    timeoutMs: 8000,
    source: 'config',
    apiKeyEnv: 'TRADE_TOOL_LLM_API_KEY',
    configKeyAvailable: true,
    panel: null,
    updatedAt: null,
    masterKeyReady: true,
    ...overrides,
  };
}

function handlers(extra: Record<string, unknown> = {}) {
  return baseHandlers({
    '/api/symbols': { items: [symbolRow('AAAUSDT'), symbolRow('BBBUSDT')] },
    '/api/settings/credentials': credential(),
    '/api/settings/notify': notify(),
    '/api/settings/risk-policy': policy(),
    // 模型接入那一块（v1.0.0）也在这一页上，缺了桩它会显示一条 404 错误横幅。
    '/api/settings/agent-llm': agentLlm(),
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

describe('设置页 · 飞书通知', () => {
  it('显示生效来源与地址状态，但不回填地址明文', async () => {
    stubFetch(
      handlers({
        '/api/settings/notify': notify({
          enabled: true,
          configured: true,
          hint: 'KLMN',
          secretConfigured: true,
          source: 'panel',
          panel: {
            configured: true,
            hint: 'KLMN',
            enabled: true,
            kinds: TOPICS.map((t) => t.kind),
            repeatCooldownMs: 1_800_000,
            updatedAt: NOW,
            secretConfigured: true,
          },
          updatedAt: NOW,
        }),
      }),
    );
    render(<App />);

    await waitFor(() => expect(screen.getByText('控制面录入')).toBeTruthy());
    // 末 4 位会出现两处（「地址」行与「页面这一份」行）——生效的就是面板这一份
    expect(screen.getAllByText(/末 4 位 KLMN/).length).toBeGreaterThan(0);
    // 回包里没有地址，前端也就没有可回填的东西
    expect((screen.getByLabelText('webhook 地址') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('webhook 地址') as HTMLInputElement).type).toBe('password');
  });

  it('主密钥未就绪时表单禁用，并说清缺什么', async () => {
    stubFetch(handlers({ '/api/settings/notify': notify({ masterKeyReady: false }) }));
    render(<App />);

    await waitFor(() => expect(screen.getByText(/TRADE_TOOL_SECRET_KEY/)).toBeTruthy());
    expect((screen.getByLabelText('webhook 地址') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '保存设置' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('保存时带上开关、地址与参数，提交完清空输入框', async () => {
    const stub = stubFetch(
      handlers({
        '/api/settings/notify': notify({
          enabled: false,
          configured: true,
          hint: 'KLMN',
          source: 'panel',
        }),
      }),
    );
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText('webhook 地址')).toBeTruthy());

    fireEvent.click(screen.getByLabelText('启用飞书通知'));
    fireEvent.change(screen.getByLabelText('webhook 地址'), {
      target: { value: 'https://open.feishu.cn/open-apis/bot/v2/hook/token' },
    });
    fireEvent.change(screen.getByLabelText('重复提醒间隔（分钟）'), { target: { value: '15' } });
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));

    await waitFor(() => {
      const put = stub.calls.find((c) => c.method === 'PUT' && c.url === '/api/settings/notify');
      expect(put?.body).toEqual({
        enabled: true,
        webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/token',
        secret: '',
        clearSecret: false,
        // 勾了哪些内容（清单由服务端下发，页面只负责勾）
        kinds: TOPICS.map((t) => t.kind),
        // 页面填的是分钟，服务端收的是毫秒（换算只在这一处）
        repeatCooldownMs: 900_000,
      });
    });
    await waitFor(() =>
      expect((screen.getByLabelText('webhook 地址') as HTMLInputElement).value).toBe(''),
    );
  });

  it('勾选/取消勾选决定推哪些内容（逐项，不是笼统的一档）', async () => {
    const stub = stubFetch(handlers({ '/api/settings/notify': notify() }));
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText('通知：止盈单没了')).toBeTruthy());

    // 取消勾选「止盈单没了」，其余不动
    fireEvent.click(screen.getByLabelText('通知：止盈单没了'));

    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));

    await waitFor(() => {
      const put = stub.calls.find((c) => c.method === 'PUT' && c.url === '/api/settings/notify');
      expect((put?.body as { kinds: string[] }).kinds).toEqual(['missing-stop-order']);
    });
  });

  it('「全不选」= 一样都不推（是合法选择，不是缺省）', async () => {
    const stub = stubFetch(handlers({ '/api/settings/notify': notify() }));
    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: '全不选' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: '全不选' }));
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));

    await waitFor(() => {
      const put = stub.calls.find((c) => c.method === 'PUT' && c.url === '/api/settings/notify');
      expect((put?.body as { kinds: string[] }).kinds).toEqual([]);
    });
  });

  it('服务端拒绝时错误常驻显示在页面上', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'PUT') {
          return new Response(
            JSON.stringify({
              error: { code: 'CONFIG_INVALID', message: '这不像是飞书自定义机器人的 webhook 地址' },
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
    await waitFor(() => expect(screen.getByLabelText('webhook 地址')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('webhook 地址'), { target: { value: 'https://x/y' } });
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));

    await waitFor(() => expect(screen.getByText(/CONFIG_INVALID/)).toBeTruthy());
  });

  it('清空配置需要二次确认', async () => {
    const stub = stubFetch(
      handlers({
        '/api/settings/notify': notify({
          configured: true,
          hint: 'KLMN',
          source: 'panel',
          panel: {
            configured: true,
            hint: 'KLMN',
            enabled: true,
            kinds: TOPICS.map((t) => t.kind),
            repeatCooldownMs: 1_800_000,
            updatedAt: NOW,
            secretConfigured: false,
          },
        }),
      }),
    );
    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: '清空配置' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: '清空配置' }));

    // 只弹出解释窗，还没有发 DELETE
    await waitFor(() => expect(screen.getByText(/清空之后/)).toBeTruthy());
    expect(stub.calls.some((c) => c.method === 'DELETE')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '确认清空' }));
    await waitFor(() =>
      expect(
        stub.calls.some((c) => c.method === 'DELETE' && c.url === '/api/settings/notify'),
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

  it('保存全局默认带上全部策略字段（只有一个止盈倍数）', async () => {
    const stub = stubFetch(handlers());
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText('全局默认 ATR 周期')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('全局默认 ATR 周期'), { target: { value: '21' } });
    fireEvent.change(screen.getByLabelText('全局默认 ATR 周期口径'), { target: { value: '4h' } });
    fireEvent.change(screen.getByLabelText('全局默认 止损倍数'), { target: { value: '2.5' } });
    fireEvent.change(screen.getByLabelText('全局默认 止盈倍数'), { target: { value: '4' } });
    // 比例以 **百分数** 提交：页面填 80，body 里应是 0.8（换算只有 core 一处实现）
    fireEvent.change(screen.getByLabelText('全局默认 第一段止盈减仓百分比'), {
      target: { value: '80' },
    });
    fireEvent.change(screen.getByLabelText('全局默认 移动止损倍数'), { target: { value: '2.5' } });
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
        // 页面填 80，body 里就是 80（换算在服务端做，core 里只有一份实现）
        takeProfit1Percent: 80,
        trailAtrMult: 2.5,
        breakevenAfterTp1: true,
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

  it('「当前生效」只有一个止盈倍数（分批时它就是第一段的目标价）', async () => {
    stubFetch(
      handlers({
        '/api/settings/risk-policy': policy({
          resolved: {
            atrPeriod: 14,
            atrInterval: '1h',
            stopAtrMult: 2,
            takeProfitAtrMult: 4,
            takeProfit1Percent: 80,
            trailAtrMult: 2,
            breakevenAfterTp1: true,
            source: 'global',
          },
        }),
      }),
    );
    render(<App />);

    await waitFor(() => expect(screen.getByText('止盈倍数')).toBeTruthy());
    // 只有一个止盈倍数：4×ATR
    expect(screen.getByText('4 × ATR')).toBeTruthy();
    // 分批形态：余下的交给移动止损
    expect(screen.getByText(/余下 20% 交给移动止损/)).toBeTruthy();
    // 界面上不再有第二个止盈倍数（v0.9.1 起合并成一个）
    expect(screen.queryByText('第一段止盈倍数')).toBeNull();
  });

  it('不分批时同一个止盈倍数表示「到价一次全平」', async () => {
    stubFetch(handlers());
    render(<App />);

    await waitFor(() => expect(screen.getByText('止盈倍数')).toBeTruthy());
    expect(screen.getByText('3 × ATR')).toBeTruthy();
    expect(screen.getByText(/（不分批）/)).toBeTruthy();
  });

  it('减仓输入的上限是 99（100 与 0 逐字等价，已在服务端归一）', async () => {
    stubFetch(handlers());
    render(<App />);
    await waitFor(() =>
      expect(screen.getByLabelText('全局默认 第一段止盈减仓百分比')).toBeTruthy(),
    );
    const input = screen.getByLabelText('全局默认 第一段止盈减仓百分比') as HTMLInputElement;
    expect(input.max).toBe('99');
  });

  it('每个倍数框都写明「什么时候才生效」（否则用户不知道填了有没有用）', async () => {
    stubFetch(handlers());
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText('全局默认 止盈倍数')).toBeTruthy());

    // 全局默认与标的覆盖两块各有一份同样的说明，因此用 getAllByText。
    expect(screen.getAllByText('不分批时：涨到离入场这么远，一次全部卖掉').length).toBeGreaterThan(
      0,
    );
    expect(
      screen.getAllByText('0 = 不分批；1–99 = 先按「止盈倍数」卖掉这个比例').length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText('分批后剩下的仓位靠它了结，只上移不放宽').length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 标的详情页内设置该标的的止盈止损（v0.7.0 之后）
// ---------------------------------------------------------------------------

describe('标的详情页内的止盈止损策略', () => {
  beforeEach(() => {
    // 用 navigate 而不是直接改 hash：路由里有个**模块级快照缓存**，直接改 hash
    // 不会让它失效，于是这个文件里上一个用例渲染出来的页面会「粘」下来。
    navigate('#/symbol/AAAUSDT');
  });

  afterEach(() => {
    // 还原：否则缓存停在详情页，后面（以及别的）用例会渲染错的页面。
    navigate('#/settings');
  });

  function detailHandlers() {
    return handlers({
      ...symbolHandlers('AAAUSDT'),
      '/api/settings/risk-policy': policy({
        overrides: [
          {
            scope: 'symbol',
            exchange: 'binance',
            symbol: 'AAAUSDT',
            atrPeriod: 14,
            atrInterval: '1m',
            stopAtrMult: 2.5,
            takeProfitAtrMult: 4,
            takeProfit1Percent: 80,
            trailAtrMult: 3,
            breakevenAfterTp1: true,
            updatedAt: NOW,
          },
        ],
        resolved: {
          atrPeriod: 14,
          atrInterval: '1m',
          stopAtrMult: 2.5,
          takeProfitAtrMult: 4,
          takeProfit1Percent: 80,
          trailAtrMult: 3,
          breakevenAfterTp1: true,
          source: 'symbol' as const,
        },
      }),
    });
  }

  it('详情页里出现该标的的策略表单，并显示分批比例', async () => {
    stubFetch(detailHandlers());
    render(<App />);
    await waitFor(() => expect(screen.getByText('合约与状态')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('AAAUSDT 的覆盖')).toBeTruthy());
    // 分批比例与「余下多少交给移动止损」都要看得见
    expect(screen.getByLabelText('AAAUSDT 的覆盖 第一段止盈减仓百分比').value).toBe('80');
    expect(screen.getByText(/余下 20% 交给移动止损/)).toBeTruthy();
  });

  it('详情页**不**出现「保存全局默认」——单标的页上改全局是最容易误按的地方', async () => {
    stubFetch(detailHandlers());
    render(<App />);
    await waitFor(() => expect(screen.getByText('AAAUSDT 的覆盖')).toBeTruthy());
    expect(screen.queryByRole('button', { name: '保存全局默认' })).toBeNull();
    expect(screen.queryByLabelText('选择标的')).toBeNull();
  });

  it('详情页保存的是该标的的覆盖（scope=symbol，带上该 symbol）', async () => {
    const stub = stubFetch(detailHandlers());
    render(<App />);
    await waitFor(() => expect(screen.getByText('AAAUSDT 的覆盖')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('AAAUSDT 的覆盖 第一段止盈减仓百分比'), {
      target: { value: '60' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存覆盖' }));

    await waitFor(() => {
      const put = stub.calls.find((c) => c.method === 'PUT');
      expect(put?.url).toBe('/api/settings/risk-policy');
      expect(put?.body).toMatchObject({
        scope: 'symbol',
        symbol: 'AAAUSDT',
        takeProfit1Percent: 60,
      });
    });
  });
});
