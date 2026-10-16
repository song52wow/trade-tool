import { afterEach, describe, expect, it } from 'vitest';

import { DEMO_REST_BASE_URL, LIVE_REST_BASE_URL, LIVE_STREAM_URL } from '@trade-tool/core';

import {
  DEMO_STREAM_URL_ENV,
  exchangeEndpointsFromEnv,
  pythonEnvFromEnv,
} from '../src/exchange-endpoints.js';

/**
 * 环境变量接线层的断言：配置 + env → 客户端选项。
 *
 * 这一层以前**根本不存在**——四处 `new BinancePrivateClient` 都不传端点，
 * 于是配置层怎么改都只打主网，而没有任何测试会发现（「都不传」是默认行为，
 * 不是被谁改坏的）。锁住它是为了让「本地跑 Demo」成为配置能表达的状态。
 */
const saved = process.env[DEMO_STREAM_URL_ENV];

afterEach(() => {
  if (saved === undefined) delete process.env[DEMO_STREAM_URL_ENV];
  else process.env[DEMO_STREAM_URL_ENV] = saved;
});

const cfg = (environment: 'live' | 'demo') =>
  ({ environment }) as unknown as Parameters<typeof exchangeEndpointsFromEnv>[0];

describe('exchangeEndpointsFromEnv', () => {
  it('demo：从环境变量读 WS，REST 指向 demo', () => {
    process.env[DEMO_STREAM_URL_ENV] = 'https://demo-stream.example';
    expect(exchangeEndpointsFromEnv(cfg('demo'))).toEqual({
      baseUrl: DEMO_REST_BASE_URL,
      streamUrl: 'https://demo-stream.example',
    });
  });

  it('demo 但变量缺失：抛错，绝不退回主网流', () => {
    delete process.env[DEMO_STREAM_URL_ENV];
    expect(() => exchangeEndpointsFromEnv(cfg('demo'))).toThrow(
      /TRADE_TOOL_BINANCE_DEMO_STREAM_URL/,
    );
  });

  it('live：不看这个变量，给主网两个常量', () => {
    process.env[DEMO_STREAM_URL_ENV] = 'https://ignored.example';
    expect(exchangeEndpointsFromEnv(cfg('live'))).toEqual({
      baseUrl: LIVE_REST_BASE_URL,
      streamUrl: LIVE_STREAM_URL,
    });
  });
});

describe('pythonEnvFromEnv', () => {
  it('demo：把 demo REST 基址注入子进程，否则行情会继续抓主网', () => {
    process.env[DEMO_STREAM_URL_ENV] = 'https://demo-stream.example';
    expect(pythonEnvFromEnv(cfg('demo'))).toEqual({
      TRADE_TOOL_BINANCE_BASE_URL: DEMO_REST_BASE_URL,
    });
  });

  it('live：返回空，主网路径不受任何影响', () => {
    expect(pythonEnvFromEnv(cfg('live'))).toEqual({});
  });
});
