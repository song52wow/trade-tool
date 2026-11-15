/**
 * 私有接口健康状态的纯函数（2026-11-06）。
 *
 * 守的是 2026-10-31 到 11-06 那 6 天静默里最要紧的一条判据：
 * **「持续不可用」才算不可用**。少了它，一次网络抖动就会推一条告警，
 * 而刷屏的告警等于没接（本文件同族的 `AlertDispatcher` 文件头）。
 */

import { describe, expect, it } from 'vitest';

import {
  applyPrivateApiFailure,
  applyPrivateApiSuccess,
  initialPrivateApiHealth,
  isPrivateApiUnavailable,
  privateApiUnavailableMs,
  PRIVATE_API_UNAVAILABLE_THRESHOLD_MS,
} from '../src/executor-health.js';

const NOW = 1_760_000_000_000;

describe('私有接口的健康状态', () => {
  it('刚启动时不是「不可用」', () => {
    const health = initialPrivateApiHealth();
    expect(isPrivateApiUnavailable(health, NOW)).toBe(false);
    expect(privateApiUnavailableMs(health, NOW)).toBe(0);
    expect(health.lastOkAt).toBeNull();
    expect(health.failureCount).toBe(0);
  });

  it('一次失败还不算不可用（抖动不告警）', () => {
    const health = applyPrivateApiFailure(initialPrivateApiHealth(), NOW, {
      code: '-2015',
      message: 'Invalid API-key, IP, or permissions for action',
    });
    expect(isPrivateApiUnavailable(health, NOW)).toBe(false);
    expect(health.failureCount).toBe(1);
    expect(health.lastErrorCode).toBe('-2015');
  });

  it('持续不可用超过阈值才算不可用', () => {
    let health = applyPrivateApiFailure(initialPrivateApiHealth(), NOW, {
      code: '-2015',
      message: 'Invalid API-key, IP, or permissions for action',
    });
    const justBefore = NOW + PRIVATE_API_UNAVAILABLE_THRESHOLD_MS - 1;
    expect(isPrivateApiUnavailable(health, justBefore)).toBe(false);

    const justAfter = NOW + PRIVATE_API_UNAVAILABLE_THRESHOLD_MS;
    expect(isPrivateApiUnavailable(health, justAfter)).toBe(true);
    expect(privateApiUnavailableMs(health, justAfter)).toBe(PRIVATE_API_UNAVAILABLE_THRESHOLD_MS);
  });

  it('连续失败时不可用的起点不被刷新（否则永远达不到阈值）', () => {
    // 这是整套判据的要害：每次失败都刷新起点的话，「不可用了多久」永远从头算，
    // 一次持续 6 天的故障也就永远推不出告警——正是这次静默的形状。
    let health = initialPrivateApiHealth();
    health = applyPrivateApiFailure(health, NOW, { code: '-2015', message: 'x' });
    const start = health.unavailableSince;
    for (let i = 1; i <= 10; i += 1) {
      health = applyPrivateApiFailure(health, NOW + i * 60_000, { code: '-2015', message: 'x' });
    }
    expect(health.unavailableSince).toBe(start);
    expect(isPrivateApiUnavailable(health, NOW + 11 * 60_000)).toBe(true);
    expect(privateApiUnavailableMs(health, NOW + 11 * 60_000)).toBe(11 * 60_000);
  });

  it('成功一次就恢复：清掉不可用状态、错误与失败计数', () => {
    let health = applyPrivateApiFailure(initialPrivateApiHealth(), NOW, {
      code: '-2015',
      message: 'Invalid API-key, IP, or permissions for action',
    });
    health = applyPrivateApiSuccess(health, NOW + 10_000);
    expect(health.unavailableSince).toBeNull();
    expect(health.failureCount).toBe(0);
    expect(health.lastErrorCode).toBeNull();
    expect(health.lastErrorMessage).toBeNull();
    expect(health.lastOkAt).toBe(NOW + 10_000);
    expect(isPrivateApiUnavailable(health, NOW + 10_000)).toBe(false);
    expect(privateApiUnavailableMs(health, NOW + 10_000)).toBe(0);
  });

  it('恢复之后又坏，重新从当下算起点', () => {
    let health = applyPrivateApiFailure(initialPrivateApiHealth(), NOW, {
      code: '-2015',
      message: 'x',
    });
    health = applyPrivateApiSuccess(health, NOW + 10_000);
    health = applyPrivateApiFailure(health, NOW + 20_000, { code: '-1021', message: 'y' });
    expect(health.unavailableSince).toBe(NOW + 20_000);
    expect(health.lastErrorCode).toBe('-1021');
  });
});
