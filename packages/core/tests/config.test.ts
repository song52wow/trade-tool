import { describe, expect, it } from 'vitest';

import { configSchema, defaultConfig } from '../src/config.js';
import { sma } from '../src/strategy.js';
import { intervalToMs } from '../src/types.js';

describe('configSchema', () => {
  it('补全默认值后可通过校验', () => {
    const parsed = configSchema.parse({ market: { symbol: 'ETHUSDT', interval: '1h' } });
    expect(parsed.market.feeRate).toBe(0.0005);
    expect(parsed.data.python).toBe('uv');
    expect(parsed.version).toBe(1);
  });

  it('拒绝非法周期', () => {
    const result = configSchema.safeParse({ market: { symbol: 'X', interval: '7m' } });
    expect(result.success).toBe(false);
  });

  it('defaultConfig 自洽', () => {
    expect(() => configSchema.parse(defaultConfig())).not.toThrow();
  });
});

describe('sma', () => {
  it('窗口不足时前段为 undefined', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([undefined, undefined, 2, 3, 4]);
  });

  it('拒绝非正窗口', () => {
    expect(() => sma([1, 2], 0)).toThrow(RangeError);
  });
});

describe('intervalToMs', () => {
  it('1h = 3600000ms', () => {
    expect(intervalToMs('1h')).toBe(3_600_000);
  });
});
