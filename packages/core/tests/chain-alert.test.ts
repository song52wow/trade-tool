/**
 * 链上仓位告警判据的测试（纯函数）。
 *
 * 锁的是三件事：**该推的推**（别漏）、**不该推的不推**（别刷屏）、
 * **没推出去的不算说过**（冷却与基准的纪律）。
 */

import { decideChainPositionAlert, type ChainAlertState } from '@trade-tool/core';
import { describe, expect, it } from 'vitest';

const thresholds = { priceMovePct: 1.5, pnlMovePp: 1.5, cooldownMs: 30 * 60_000 };
const NOW = 1_794_380_000_000;

const baseState: ChainAlertState = {
  baselineDone: true,
  lastAlertPrice: 11.84,
  lastAlertPnlPct: -0.25,
  lastAlertAt: NOW - 60 * 60_000,
  lastLiquidity: '550060234221891411106',
  inRange: true,
};

const snapshot = {
  price: 11.84,
  pnlPct: -0.25,
  inRange: true,
  liquidity: 550060234221891411106n,
};

describe('decideChainPositionAlert', () => {
  it('第一次只建基线', () => {
    const got = decideChainPositionAlert({
      snapshot,
      state: { ...baseState, baselineDone: false },
      thresholds,
      nowMs: NOW,
    });
    expect(got.alert).toBe(true);
    expect(got.reasons).toEqual(['首次监控，建立基线']);
  });

  it('什么都没变就不推', () => {
    const got = decideChainPositionAlert({ snapshot, state: baseState, thresholds, nowMs: NOW });
    expect(got.alert).toBe(false);
    expect(got.reasons).toEqual([]);
  });

  it('价格动超过阈值就推', () => {
    const got = decideChainPositionAlert({
      snapshot: { ...snapshot, price: 11.84 * 1.02 },
      state: baseState,
      thresholds,
      nowMs: NOW,
    });
    expect(got.alert).toBe(true);
    expect(got.reasons.join()).toContain('价格');
  });

  it('盈亏动超过阈值就推', () => {
    const got = decideChainPositionAlert({
      snapshot: { ...snapshot, pnlPct: 2 },
      state: baseState,
      thresholds,
      nowMs: NOW,
    });
    expect(got.alert).toBe(true);
    expect(got.reasons.join()).toContain('盈亏');
  });

  it('有人加仓或减仓立刻推', () => {
    const got = decideChainPositionAlert({
      snapshot: { ...snapshot, liquidity: 12345n },
      state: baseState,
      thresholds,
      nowMs: NOW,
    });
    expect(got.alert).toBe(true);
    expect(got.reasons.join()).toContain('流动性');
  });

  it('价格出了区间立刻推', () => {
    const got = decideChainPositionAlert({
      snapshot: { ...snapshot, inRange: false },
      state: baseState,
      thresholds,
      nowMs: NOW,
    });
    expect(got.alert).toBe(true);
    expect(got.reasons.join()).toContain('区间');
  });

  it('仓位清空立刻推，且不受冷却限制', () => {
    const got = decideChainPositionAlert({
      snapshot: { ...snapshot, liquidity: 0n },
      state: { ...baseState, lastAlertAt: NOW - 1000 },
      thresholds,
      nowMs: NOW,
    });
    expect(got.alert).toBe(true);
    expect(got.reasons.join()).toContain('清空');
  });

  it('已经清空过一次就不重复推', () => {
    const got = decideChainPositionAlert({
      snapshot: { ...snapshot, liquidity: 0n },
      state: { ...baseState, lastLiquidity: '0', lastAlertAt: NOW - 1000 },
      thresholds,
      nowMs: NOW,
    });
    expect(got.alert).toBe(false);
  });

  it('冷却期内加仓 / 减仓仍然立刻推（事件不能被冷却吞掉）', () => {
    // 回归用例：这两类原因是**一次性事件**——被冷却压住的那一轮，库里
    // `last_liquidity` 已经前移，下一轮比不出差异，这件事就永久丢了。
    const got = decideChainPositionAlert({
      snapshot: { ...snapshot, liquidity: 12345n },
      state: { ...baseState, lastAlertAt: NOW - 60_000 },
      thresholds,
      nowMs: NOW,
    });
    expect(got.alert).toBe(true);
    expect(got.suppressed).toBe(false);
    expect(got.reasons.join()).toContain('流动性');
  });

  it('冷却期内进出区间也仍然立刻推', () => {
    const got = decideChainPositionAlert({
      snapshot: { ...snapshot, inRange: false },
      state: { ...baseState, lastAlertAt: NOW - 60_000 },
      thresholds,
      nowMs: NOW,
    });
    expect(got.alert).toBe(true);
    expect(got.suppressed).toBe(false);
    expect(got.reasons.join()).toContain('区间');
  });

  it('冷却期内压住（但记下原因，别丢）', () => {
    const got = decideChainPositionAlert({
      snapshot: { ...snapshot, price: 11.84 * 1.05 },
      state: { ...baseState, lastAlertAt: NOW - 60_000 },
      thresholds,
      nowMs: NOW,
    });
    expect(got.alert).toBe(false);
    expect(got.suppressed).toBe(true);
    expect(got.reasons.length).toBeGreaterThan(0);
  });

  it('冷却期过了就推', () => {
    const got = decideChainPositionAlert({
      snapshot: { ...snapshot, price: 11.84 * 1.05 },
      state: { ...baseState, lastAlertAt: NOW - 31 * 60_000 },
      thresholds,
      nowMs: NOW,
    });
    expect(got.alert).toBe(true);
  });
});
