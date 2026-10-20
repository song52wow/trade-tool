/**
 * LLM 客户端的测试（v0.9.0）。**不出网**：`fetchImpl` 全部是替身。
 *
 * 锁的是「模型服务不可靠时不能拖垮 executor」这四件事：
 *   * 超时 → 报 `LLM_CALL_FAILED`（**不是**挂住等到天荒地老）；
 *   * HTTP 错误 → 带上服务商自己的说明（比一句「HTTP 400」有用）；
 *   * 缺密钥 → 报 `CONFIG_INVALID` 并说清该配哪个环境变量；
 *   * 响应形状不对 → 报错，不返回空串冒充成功。
 */

import { SyncError } from '@trade-tool/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLlmClient, readLlmApiKey } from '../src/llm.js';

const BASE = {
  baseUrl: 'https://example.invalid/v1',
  model: 'test-model',
  apiKeyEnv: 'TEST_LLM_KEY',
};

// 客户端在**每次调用时**读环境变量（不是构造时），所以这里在每个用例前后摆好。
beforeEach(() => {
  process.env['TEST_LLM_KEY'] = 'sk-test';
});
afterEach(() => {
  delete process.env['TEST_LLM_KEY'];
  delete process.env['DEFINITELY_MISSING_KEY'];
});

function okResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('readLlmApiKey', () => {
  it('读得到就返回（去掉首尾空白）', () => {
    expect(readLlmApiKey('K', { K: '  sk-abc  ' })).toBe('sk-abc');
  });

  it('读不到就报错并说清是哪个变量（不静默用空串）', () => {
    expect(() => readLlmApiKey('MISSING_KEY', {})).toThrow(/MISSING_KEY/);
    expect(() => readLlmApiKey('EMPTY_KEY', { EMPTY_KEY: '   ' })).toThrow(SyncError);
  });
});

describe('createLlmClient', () => {
  it('正常返回时取出模型输出', async () => {
    const fetchImpl = vi.fn(async () => okResponse('{"stopAtrMult":2}'));
    const client = createLlmClient({
      ...BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await client.complete([{ role: 'user', content: 'x' }]);
    expect(out).toBe('{"stopAtrMult":2}');
  });

  it('请求发到 baseUrl + /chat/completions，且带上密钥', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return okResponse('{}');
    });
    const client = createLlmClient({
      ...BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.complete([{ role: 'user', content: 'x' }]);
    expect(calls[0]?.url).toBe('https://example.invalid/v1/chat/completions');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer sk-test');
  });

  it('尾部的斜杠不会造成双斜杠', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      calls.push(String(url));
      return okResponse('{}');
    });
    const client = createLlmClient({
      ...BASE,
      baseUrl: 'https://example.invalid/v1/',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.complete([{ role: 'user', content: 'x' }]);
    expect(calls[0]).toBe('https://example.invalid/v1/chat/completions');
  });

  it('HTTP 错误 → 报 LLM_CALL_FAILED，并带上服务商自己的说明', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: '模型不存在' } }), { status: 404 }),
    );
    const client = createLlmClient({
      ...BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.complete([{ role: 'user', content: 'x' }])).rejects.toThrow(/模型不存在/);
  });

  it('超时 → 报 LLM_CALL_FAILED，**不是**一直挂着', async () => {
    // 模拟一个不响应的服务：只有 abort 才会让 fetch 结束。
    const fetchImpl = vi.fn(
      (_url: string | URL, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );
    const client = createLlmClient({
      ...BASE,
      timeoutMs: 50,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.complete([{ role: 'user', content: 'x' }])).rejects.toThrow(/超时/);
  });

  it('响应里没有 content → 报错，不返回空串冒充成功', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    );
    const client = createLlmClient({
      ...BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.complete([{ role: 'user', content: 'x' }])).rejects.toThrow(SyncError);
  });

  it('响应不是 JSON → 报错', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>502</html>', { status: 200 }));
    const client = createLlmClient({
      ...BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.complete([{ role: 'user', content: 'x' }])).rejects.toThrow(/JSON/);
  });

  it('缺密钥 → 报 CONFIG_INVALID（不是发一个没头的请求）', async () => {
    const fetchImpl = vi.fn(async () => okResponse('{}'));
    const client = createLlmClient({
      ...BASE,
      apiKeyEnv: 'DEFINITELY_MISSING_KEY',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.complete([{ role: 'user', content: 'x' }])).rejects.toThrow(
      /DEFINITELY_MISSING_KEY/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('配置不合法时构造就报错（baseUrl / model 不能空）', () => {
    expect(() => createLlmClient({ ...BASE, baseUrl: '  ' })).toThrow(SyncError);
    expect(() => createLlmClient({ ...BASE, model: '' })).toThrow(SyncError);
    expect(() => createLlmClient({ ...BASE, apiKeyEnv: '' })).toThrow(SyncError);
  });
});
