import { describe, expect, it } from 'vitest';

import {
  DERIVED_INTERVALS,
  INTERVAL_TABLES,
  STORED_INTERVALS,
  isStoredInterval,
  SyncError,
} from '@trade-tool/core';

import { parseStoredInterval } from '@trade-tool/data';

import { parseBarLimit, parseIntervalParam } from '../src/bars.js';

/**
 * 周期白名单与表名映射（v0.2.0 R-1.6 / R-6.2 / R-6.5 / AC-12）。
 *
 * 重点不是「能读到 4h」，而是**闸门**：表名不可参数化，所以周期字符串必须先过白名单；
 * 遇到未实现的周期必须报错，绝不能静默回落到 1m——用户以为在看 4h、实际拿到 1m，
 * 正是最典型的静默兜底。
 */
describe('周期 → 表名映射', () => {
  it('STORED_INTERVALS 含 1m 与四个派生周期', () => {
    expect([...STORED_INTERVALS]).toEqual(['1m', '15m', '1h', '4h', '1d']);
  });

  it('DERIVED_INTERVALS 不含 1m', () => {
    expect([...DERIVED_INTERVALS]).toEqual(['15m', '1h', '4h', '1d']);
    expect(DERIVED_INTERVALS).not.toContain('1m');
  });

  it('每个周期都映射到以 klines_ 开头的表', () => {
    for (const interval of STORED_INTERVALS) {
      expect(INTERVAL_TABLES[interval]).toMatch(/^klines_/);
    }
  });

  it('表名互不相同', () => {
    const tables = STORED_INTERVALS.map((i) => INTERVAL_TABLES[i]);
    expect(new Set(tables).size).toBe(tables.length);
  });

  it('1m 映射到 klines_1m（既有表）', () => {
    expect(INTERVAL_TABLES['1m']).toBe('klines_1m');
  });

  it('isStoredInterval 对未实现周期返回 false', () => {
    for (const bad of ['5m', '2h', 'foo', '', '1M', '15M']) {
      expect(isStoredInterval(bad), `${bad} 不该被接受`).toBe(false);
    }
  });

  it('isStoredInterval 对已实现周期返回 true', () => {
    for (const good of STORED_INTERVALS) {
      expect(isStoredInterval(good), `${good} 应被接受`).toBe(true);
    }
  });
});

describe('parseStoredInterval', () => {
  it('缺省为 1m（向后兼容，R-6.1）', () => {
    expect(parseStoredInterval(undefined)).toBe('1m');
    expect(parseStoredInterval(null)).toBe('1m');
    expect(parseStoredInterval('')).toBe('1m');
  });

  it('接受已实现的四个派生周期', () => {
    for (const interval of DERIVED_INTERVALS) {
      expect(parseStoredInterval(interval)).toBe(interval);
    }
  });

  it('5m 明确报错而不是回落（N-1：本期不含 5m）', () => {
    expect(() => parseStoredInterval('5m')).toThrow(SyncError);
    try {
      parseStoredInterval('5m');
    } catch (error) {
      expect((error as SyncError).code).toBe('CONFIG_INVALID');
      expect((error as SyncError).message).toContain('5m');
    }
  });

  it('未知周期一律 CONFIG_INVALID', () => {
    for (const bad of ['2h', 'foo', '1M', '15m ', ' 15m']) {
      expect(() => parseStoredInterval(bad), `${bad} 应报错`).toThrow(SyncError);
    }
  });

  it('错误 details 列出全部可读周期', () => {
    try {
      parseStoredInterval('5m');
      expect.unreachable('应当抛错');
    } catch (error) {
      const details = (error as SyncError).details as { supported: string[] };
      expect(details.supported.sort()).toEqual(['15m', '1d', '1h', '1m', '4h']);
    }
  });
});

describe('parseIntervalParam（HTTP 层）', () => {
  it('缺省 1m', () => {
    expect(parseIntervalParam(undefined)).toBe('1m');
  });

  it('透传已实现周期', () => {
    expect(parseIntervalParam('4h')).toBe('4h');
  });

  it('未实现周期抛 CONFIG_INVALID → 400', () => {
    expect(() => parseIntervalParam('5m')).toThrow(SyncError);
    try {
      parseIntervalParam('2h');
      expect.unreachable('应当抛错');
    } catch (error) {
      expect((error as SyncError).code).toBe('CONFIG_INVALID');
    }
  });
});

describe('parseBarLimit（既有闸门不得回归）', () => {
  it('缺省 300', () => {
    expect(parseBarLimit(undefined)).toBe(300);
  });

  it('超上限截断', () => {
    expect(parseBarLimit('999999')).toBe(2000);
  });

  it('非法值报错而不是静默换值', () => {
    for (const bad of ['0', '-1', '1.5', 'abc']) {
      expect(() => parseBarLimit(bad)).toThrow(SyncError);
    }
  });
});
