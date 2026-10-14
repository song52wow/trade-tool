import { describe, expect, it } from 'vitest';

import {
  DEMO_REST_BASE_URL,
  LIVE_REST_BASE_URL,
  LIVE_STREAM_URL,
  resolveExchangeEndpoints,
} from '../src/exchange-endpoints.js';
import { SyncError } from '../src/market-sync.js';

/**
 * 端点解析的**契约断言**。
 *
 * AGENTS.md §10 第 1 条：接缝的「值」必须有对着契约写的断言。这里锁住的是
 * 「REST 基址与用户数据流地址来自同一次选择」这条**性质**，以及 demo 缺 WS 必报错——
 * 因为静默回落到主网流，正是当初 `listenKeyUrl` 坏掉时 122 个测试全绿的那类失败。
 *
 * 核对于 2026-10-14。主网两个常量是稳定的；demo 的 REST 基址随Binance 于
 * 2025-08-27 关停老 Futures Testnet 而变更过。
 */
describe('resolveExchangeEndpoints', () => {
  it('live 同时给出主网 REST 与用户数据流', () => {
    expect(resolveExchangeEndpoints({ environment: 'live' })).toEqual({
      baseUrl: LIVE_REST_BASE_URL,
      streamUrl: LIVE_STREAM_URL,
    });
  });

  it('live 不看 demo 的 WS 变量——设置它不该改变主网行为', () => {
    const resolved = resolveExchangeEndpoints({
      environment: 'live',
      demoStreamUrl: 'https://should-be-ignored.example',
    });
    expect(resolved.baseUrl).toBe(LIVE_REST_BASE_URL);
    expect(resolved.streamUrl).toBe(LIVE_STREAM_URL);
  });

  it('demo 的 REST 基址不是主网——这条断言失败即表示 Binance 又换了地址', () => {
    const resolved = resolveExchangeEndpoints({
      environment: 'demo',
      demoStreamUrl: 'https://demo-stream.example',
    });
    expect(resolved.baseUrl).toBe(DEMO_REST_BASE_URL);
    // 曾经发生过的事：照抄单个 endpoint 文档页里印着的已废弃地址，配出一个死基址。
    expect(resolved.baseUrl).not.toContain('testnet.binancefuture.com');
    expect(resolved.baseUrl).not.toBe(LIVE_REST_BASE_URL);
  });

  it('demo 必须显式给 WS：缺了就抛 CONFIG_INVALID，绝不回落主网流', () => {
    expect(() => resolveExchangeEndpoints({ environment: 'demo' })).toThrow(SyncError);
    expect(() => resolveExchangeEndpoints({ environment: 'demo', demoStreamUrl: '  ' })).toThrow(
      /TRADE_TOOL_BINANCE_DEMO_STREAM_URL/,
    );
    // 核心断言：这里绝不能悄悄给出主网地址。
    let caught: unknown;
    try {
      resolveExchangeEndpoints({ environment: 'demo' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SyncError);
    expect((caught as SyncError).code).toBe('CONFIG_INVALID');
  });

  it('demo 的 WS 与 REST 一定不是同一个 host（分叉即失败）', () => {
    const resolved = resolveExchangeEndpoints({
      environment: 'demo',
      demoStreamUrl: 'https://demo-stream.example',
    });
    expect(resolved.streamUrl).not.toBe(resolved.baseUrl);
    expect(resolved.streamUrl).toBe('https://demo-stream.example');
  });

  it('WS 地址写 wss:// 也接受，但归一成 https://，让 listenKeyUrl 拼出的地址形态唯一', () => {
    const resolved = resolveExchangeEndpoints({
      environment: 'demo',
      demoStreamUrl: 'wss://demo-stream.example/',
    });
    expect(resolved.streamUrl).toBe('https://demo-stream.example');
  });

  it('非绝对地址直接拒绝——把 host 打错不该等到连不上才暴露', () => {
    expect(() =>
      resolveExchangeEndpoints({ environment: 'demo', demoStreamUrl: 'demo-stream.example' }),
    ).toThrow(/绝对地址/);
  });
});
