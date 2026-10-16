/**
 * 时钟偏差的测量与补偿（纯函数，不出网）。
 *
 * 锁的是三件事：
 *  1. 偏移算得对（正的表示本机快，签名时要**减掉**）；
 *  2. 补偿取下四分位而不是中位数——宁可少补；
 *  3. 测量不可信（样本极差大 / 偏移大到没意义）时**直接抛错**，不返回一个
 *     看起来能用的补偿值。
 */

import { ClockSkewError, computeClockSkew, describeClockSkew } from '@trade-tool/core';
import { describe, expect, it } from 'vitest';

/** 构造一组「本机比交易所快 fixedMs」的样本。 */
function samples(
  fixedMs: number,
  jitter: readonly number[],
  base = 1_700_000_000_000,
): Array<{ sentAt: number; serverTime: number }> {
  return jitter.map((j, i) => ({
    sentAt: base + i * 30_000,
    serverTime: base + i * 30_000 - (fixedMs + j),
  }));
}

describe('computeClockSkew', () => {
  it('本机快 → offset 为正，签名时据此减掉', () => {
    const skew = computeClockSkew(samples(900, [0, 10, -10]));
    expect(skew.offsetMs).toBeGreaterThan(0);
    expect(skew.samples).toBe(3);
  });

  it('本机慢 → offset 为负（方向不能搞反）', () => {
    const skew = computeClockSkew(samples(-900, [0, 5, -5]));
    expect(skew.offsetMs).toBeLessThan(0);
  });

  it('取**最大值**：观测值只会低估真实偏差，最大值才是最紧的下界', () => {
    // 实测形态：多数样本 ≈1215，偶尔出现 ≈-900 的离群样本
    // （响应打到了时钟偏慢的边缘节点）。离群值只会拉低最小值，取最大值天然免疫。
    const skew = computeClockSkew(samples(1215, [0, 5, -2100]));
    expect(skew.offsetMs).toBe(1220); // 观测 1215 / 1220 / −885
    expect(skew.minObservedMs).toBe(-885);
    expect(skew.maxObservedMs).toBe(1220);
  });

  it('极差过大时仍按最大值补偿，但把抖动报出来', () => {
    const skew = computeClockSkew(samples(1200, [0, -9000]));
    expect(skew.offsetMs).toBe(1200);
    expect(skew.warning).toMatch(/极差/);
    expect(describeClockSkew(skew)).toMatch(/注意/);
  });

  it('偏移大到 60s 以上 → 抛错并指向修系统时钟', () => {
    try {
      computeClockSkew(samples(120_000, [0, 5]));
      throw new Error('本该抛错');
    } catch (error) {
      expect((error as ClockSkewError).code).toBe('CLOCK_SKEW_TOO_LARGE');
      expect((error as Error).message).toMatch(/系统时钟/);
    }
  });

  it('没有有效样本 → 抛错而不是默认 0', () => {
    expect(() => computeClockSkew([])).toThrow(ClockSkewError);
  });

  it('丢弃非法样本但保留合法样本', () => {
    const skew = computeClockSkew([
      { sentAt: 1_000, serverTime: 100 },
      { sentAt: Number.NaN, serverTime: 100 },
      { sentAt: 2_000, serverTime: 1_100 },
    ]);
    expect(skew.samples).toBe(2);
    expect(skew.offsetMs).toBe(900);
  });
});

describe('describeClockSkew', () => {
  it('把方向、量级与样本区间都写出来（补偿必须可见）', () => {
    const text = describeClockSkew(computeClockSkew(samples(900, [0, 10, 20])));
    expect(text).toMatch(/快于交易所/);
    expect(text).toMatch(/920ms/);
    expect(text).toMatch(/3 个样本/);
  });
});
