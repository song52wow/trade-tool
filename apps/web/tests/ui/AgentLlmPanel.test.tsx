// @vitest-environment jsdom
// 模型接入设置面板的用例（v1.0.0）。每一条都是「不骗人」的硬要求：
//   * **哪一份在生效**必须说清楚（控制面录入 / 配置文件 + 环境变量）；
//   * 密钥**没有明文**：回包里只有「配没配 / 末 4 位」，输入框一律保持空——
//     把空框显示成「已填」比显示「末 4 位」危险得多；
//   * `keyConfigured === null` 是**读不到**（主密钥没注入），必须说「不知道」，
//     说「没配」是猜测，而页面会照着它显示；
//   * 主密钥没就绪 → **整个表单禁用**（填了也存不下来）；
//   * 「留空 = 保持原样」要真的成立：地址 / 模型名原样传空串，密钥留空时
//     **不传 apiKey 字段**。
import './setup.js';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentLlmPanel } from '../../ui/src/components/AgentLlmPanel';
import type { AgentLlmStatusDto } from '../../src/types';
import { NOW, stubFetch } from './fixtures';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const notify = vi.fn();

/** 模型接入状态。默认「控制面录入的那一档在生效，密钥配了」。 */
function llm(overrides: Partial<AgentLlmStatusDto> = {}): AgentLlmStatusDto {
  return {
    enabled: true,
    baseUrl: 'https://api.example.com/v1',
    model: 'gpt-4o-mini',
    timeoutMs: 8000,
    source: 'panel',
    apiKeyEnv: 'TRADE_TOOL_LLM_API_KEY',
    configKeyAvailable: true,
    panel: {
      configured: true,
      hint: 'WXYZ',
      enabled: true,
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o-mini',
      timeoutMs: 8000,
      updatedAt: NOW,
      keyConfigured: true,
    },
    updatedAt: NOW,
    masterKeyReady: true,
    ...overrides,
  };
}

function renderPanel(): void {
  render(<AgentLlmPanel notify={notify} />);
}

describe('模型接入设置面板', () => {
  it('生效来源是控制面录入：说清来源与密钥末 4 位，三个输入框都保持空', async () => {
    stubFetch({ '/api/settings/agent-llm': llm() });
    renderPanel();

    await waitFor(() => expect(screen.getByText('控制面录入')).toBeTruthy());
    expect(screen.getByText('已配置（末 4 位 WXYZ）')).toBeTruthy();

    // 回包里没有明文密钥，前端也就没有可回填的东西：
    // 把空框显示成「已填」比显示「末 4 位」危险得多。
    expect((screen.getByLabelText('API 地址') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('模型名') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('API 密钥') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('API 密钥') as HTMLInputElement).type).toBe('password');
  });

  it('生效来源是配置文件 + 环境变量：来源必须显示出来', async () => {
    stubFetch({ '/api/settings/agent-llm': llm({ source: 'config', panel: null }) });
    renderPanel();

    await waitFor(() => expect(screen.getByText('配置文件 + 环境变量')).toBeTruthy());
    // 排障要看密钥取自哪个环境变量
    expect(screen.getByText('TRADE_TOOL_LLM_API_KEY')).toBeTruthy();
    // 从来没在控制面录入过：那一行不该编出来
    expect(screen.queryByText('页面这一份')).toBeNull();
  });

  it('主密钥没就绪：整个表单禁用，并说清缺什么', async () => {
    stubFetch({
      '/api/settings/agent-llm': llm({
        masterKeyReady: false,
        panel: {
          configured: true,
          hint: 'WXYZ',
          enabled: true,
          baseUrl: 'https://api.example.com/v1',
          model: 'gpt-4o-mini',
          timeoutMs: 8000,
          updatedAt: NOW,
          // 主密钥没注入 → 读不到密文 → 不知道配没配
          keyConfigured: null,
        },
      }),
    });
    renderPanel();

    await waitFor(() => expect(screen.getByText(/TRADE_TOOL_SECRET_KEY/)).toBeTruthy());
    expect((screen.getByLabelText('API 地址') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('模型名') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('API 密钥') as HTMLInputElement).disabled).toBe(true);
    expect(
      (screen.getByRole('button', { name: '保存模型设置' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('密钥读不到（keyConfigured = null）：说「不知道」，不说「没配」', async () => {
    stubFetch({
      '/api/settings/agent-llm': llm({
        panel: {
          configured: true,
          hint: 'WXYZ',
          enabled: true,
          baseUrl: 'https://api.example.com/v1',
          model: 'gpt-4o-mini',
          timeoutMs: 8000,
          updatedAt: NOW,
          keyConfigured: null,
        },
      }),
    });
    renderPanel();

    await waitFor(() => expect(screen.getByText(/不知道/)).toBeTruthy());
    // 「没配」是猜测，而页面会照着它显示——用户会以为还得去重填一遍
    expect(screen.queryByText('未配置')).toBeNull();
  });

  it('保存：地址与模型名留空就原样传空串，密钥留空不传 apiKey 字段', async () => {
    const stub = stubFetch({ '/api/settings/agent-llm': llm() });
    renderPanel();
    await waitFor(() => expect(screen.getByLabelText('API 地址')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: '保存模型设置' }));

    await waitFor(() => {
      const put = stub.calls.find((c) => c.method === 'PUT' && c.url === '/api/settings/agent-llm');
      expect(put?.body).toEqual({
        enabled: true,
        // 「留空 = 保持原样」：原样传空串，服务端据此沿用已存的值
        baseUrl: '',
        model: '',
        timeoutMs: 8000,
      });
      // 密钥留空时**不传** apiKey 字段：多传一个空串就多一处口径可能不一致
      expect(Object.keys((put?.body ?? {}) as object)).not.toContain('apiKey');
    });
  });

  it('提交成功后输入框被清空，不在页面上留一份副本', async () => {
    const stub = stubFetch({ '/api/settings/agent-llm': llm() });
    renderPanel();
    await waitFor(() => expect(screen.getByLabelText('API 地址')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('API 地址'), {
      target: { value: 'https://new.example.com/v1' },
    });
    fireEvent.change(screen.getByLabelText('模型名'), { target: { value: 'gpt-4o' } });
    fireEvent.change(screen.getByLabelText('API 密钥'), { target: { value: 'sk-secret' } });
    fireEvent.click(screen.getByRole('button', { name: '保存模型设置' }));

    await waitFor(() => {
      const put = stub.calls.find((c) => c.method === 'PUT' && c.url === '/api/settings/agent-llm');
      expect(put?.body).toEqual({
        enabled: true,
        baseUrl: 'https://new.example.com/v1',
        model: 'gpt-4o',
        apiKey: 'sk-secret',
        timeoutMs: 8000,
      });
    });
    await waitFor(() =>
      expect((screen.getByLabelText('API 地址') as HTMLInputElement).value).toBe(''),
    );
    expect((screen.getByLabelText('模型名') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('API 密钥') as HTMLInputElement).value).toBe('');
  });

  it('「清空控制面这一份」要二次确认：它是退回配置文件，不是关掉模型', async () => {
    const stub = stubFetch({ '/api/settings/agent-llm': llm() });
    renderPanel();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '清空控制面这一份' })).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole('button', { name: '清空控制面这一份' }));

    // 只弹出解释窗，还没有发 DELETE
    await waitFor(() => expect(screen.getByText(/模型接入会回到/)).toBeTruthy());
    expect(stub.calls.some((c) => c.method === 'DELETE')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '确认清空' }));
    await waitFor(() =>
      expect(
        stub.calls.some((c) => c.method === 'DELETE' && c.url === '/api/settings/agent-llm'),
      ).toBe(true),
    );
  });
});
