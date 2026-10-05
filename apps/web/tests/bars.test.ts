import { describe, expect, it } from 'vitest';

import { DEFAULT_BAR_LIMIT, MAX_BAR_LIMIT, clampBarLimit, parseBarLimit } from '../src/bars.js';

describe('K 线取数上限', () => {
  it('缺省值落在页面默认区间内', () => {
    expect(parseBarLimit(undefined)).toBe(DEFAULT_BAR_LIMIT);
    expect(clampBarLimit(undefined)).toBe(DEFAULT_BAR_LIMIT);
  });

  it('合法值原样通过', () => {
    expect(parseBarLimit('1')).toBe(1);
    expect(parseBarLimit('1440')).toBe(1440);
    expect(clampBarLimit(60)).toBe(60);
  });

  it('超上限截断到上限（不报错，因为图仍有意义；生效值会回给页面）', () => {
    expect(parseBarLimit(String(MAX_BAR_LIMIT + 1))).toBe(MAX_BAR_LIMIT);
    expect(clampBarLimit(1_000_000)).toBe(MAX_BAR_LIMIT);
  });

  it('非法值抛错，不静默换成缺省', () => {
    for (const raw of ['0', '-1', '1.5', 'abc', '']) {
      expect(() => parseBarLimit(raw)).toThrowError(/limit 必须是正整数/);
    }
  });

  it('指数写法等价于整数，按其数值处理（1e3 就是 1000，不是错）', () => {
    expect(parseBarLimit('1e3')).toBe(1000);
  });

  it('clampBarLimit 兜住调用方的脏数字：0 归 1，负数归 1，小数截断', () => {
    expect(clampBarLimit(0)).toBe(1);
    expect(clampBarLimit(-3)).toBe(1);
    expect(clampBarLimit(12.9)).toBe(12);
  });

  it('NaN / Infinity 走缺省，不产生一条 SQL 参数为 NaN 的查询', () => {
    expect(clampBarLimit(Number.NaN)).toBe(DEFAULT_BAR_LIMIT);
    expect(clampBarLimit(Number.POSITIVE_INFINITY)).toBe(DEFAULT_BAR_LIMIT);
  });
});
