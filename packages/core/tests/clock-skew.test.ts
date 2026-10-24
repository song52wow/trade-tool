/**
 * 时钟偏差的测量与补偿（纯函数，不出网）。
 *
 * 锁的是三件事：
 *  1. 偏移算得对（正的表示本机快，签名时要**减掉**）；
 *  2. **不能把网络延迟当成时钟偏差**——这是 2026-10-25 在服务器 + 代理上踩到的坑：
 *     老公式只看「发出时刻 − 服务器时刻」，少了整整一个单程延迟，补偿量因此偏小，
 *     签出去的时间戳落到服务器时间**前面**，撞上币安写死的 1000ms 硬阈值 → -1021，
 *     私有请求全挂（连不上仓位、对账失败、挂单撤单一起废掉）；
 *  3. 测量不可信（样本极差大 / 偏移大到没意义）时**直接抛错**，不返回一个
 *     看起来能用的补偿值。
 *
 * 第 2 条锁的不是公式长什么样，而是**最终结果**：签名出去的时间戳必须落在
 * 币安容忍的区间里。因此下面的测试用「模拟一整条链路」的方式断言落点，
 * 而不是断言某个中间值——换一种写法只要落点仍是对的，测试就该放行。
 */

import { ClockSkewError, computeClockSkew, describeClockSkew } from '@trade-tool/core';
import type { ClockSkew } from '@trade-tool/core';
import { describe, expect, it } from 'vitest';

/**
 * 币安的实际口径（`packages/core/src/clock-skew.ts` 里记着出处）：
 * 时间戳跑到服务器时间**前面**超过 1000ms 就拒（硬阈值，调大 `recvWindow` 无效）；
 * 落在**后面**则按 `recvWindow` 容忍。
 */
const AHEAD_LIMIT_MS = 1_000;
const RECV_WINDOW_MS = 5_000;

/** 一条网络路径：本地时钟偏差 + 去程/回程延迟。 */
interface Path {
  /** 本机时钟相对交易所的偏差（正 = 本机快）。 */
  localAheadMs: number;
  /** 去程延迟：本机 → 交易所。 */
  outboundMs: number;
  /** 回程延迟：交易所 → 本机。 */
  inboundMs: number;
}

/** 模拟一次无签名的「服务器时间」测量，产出一条样本。 */
function measure(path: Path, sentTrueAt: number) {
  const sentAt = sentTrueAt + path.localAheadMs;
  const serverTime = sentTrueAt + path.outboundMs;
  const receivedAt = serverTime + path.inboundMs + path.localAheadMs;
  return { sentAt, receivedAt, serverTime };
}

/**
 * 模拟一次**签名私有请求**，返回它相对服务器处理时刻的落点（毫秒）。
 *
 * 正数 = 落在服务器时间之前（安全，只要不超过 `recvWindow`）；
 * 负数 = 跑到服务器时间前面（超过 1000ms 就是 -1021）。
 */
function landingMs(path: Path, skew: ClockSkew, signedTrueAt: number, outboundMs: number): number {
  const timestamp = signedTrueAt + path.localAheadMs - skew.offsetMs;
  const serverNow = signedTrueAt + outboundMs;
  return serverNow - timestamp;
}

/** 老公式的落点：只看发出时刻，把单程延迟当成了偏差。 */
function legacyLandingMs(
  path: Path,
  legacyOffsetMs: number,
  signedTrueAt: number,
  outboundMs: number,
): number {
  const timestamp = signedTrueAt + path.localAheadMs - legacyOffsetMs;
  return signedTrueAt + outboundMs - timestamp;
}

/** 连续采 n 个样本。 */
function sample(path: Path, n: number, startAt = 1_700_000_000_000) {
  return Array.from({ length: n }, (_, i) => measure(path, startAt + i * 30_000));
}

describe('computeClockSkew', () => {
  it('中点估计：对称延迟下量出来的就是真实偏差，延迟不算进偏差里', () => {
    const skew = computeClockSkew(
      sample({ localAheadMs: -800, outboundMs: 1_000, inboundMs: 1_000 }, 3),
    );
    // 老公式在这里会量出 -1800（把 1000ms 的单程延迟也算成了偏差）。
    expect(skew.minObservedMs).toBe(-800);
    expect(skew.maxObservedMs).toBe(-800);
    // 真正生效的是「下限」：宁可多补 1000ms，也不可少补。
    expect(skew.floorMs).toBe(200);
    expect(skew.offsetMs).toBe(200);
  });

  it('方向不能搞反：本机快 → offset 为正，本机慢 → offset 为负', () => {
    expect(
      computeClockSkew(sample({ localAheadMs: 900, outboundMs: 100, inboundMs: 100 }, 3)).offsetMs,
    ).toBeGreaterThan(0);
    expect(
      computeClockSkew(sample({ localAheadMs: -900, outboundMs: 100, inboundMs: 100 }, 3)).offsetMs,
    ).toBeLessThan(0);
  });

  it('核心回归：私单请求比测量样本更快时，签名时间戳仍落在容忍区间内', () => {
    // 测量走的是 /fapi/v1/time（往返 3 秒），真正的私单请求走的是同一条路但更快
    // （连接复用、代理命中缓存……）。老公式在这种情况下会把时间戳推到服务器时间前面。
    const measurePath: Path = { localAheadMs: 0, outboundMs: 1_500, inboundMs: 1_500 };
    const samples = sample(measurePath, 3);
    const skew = computeClockSkew(samples);

    const landing = landingMs(measurePath, skew, 1_700_000_100_000, 100);
    expect(landing).toBeGreaterThanOrEqual(-AHEAD_LIMIT_MS);
    expect(landing).toBeLessThanOrEqual(RECV_WINDOW_MS);

    // 同一组样本喂给老公式，它一定会挂——证明这条用例真的踩在坑上。
    const legacyOffset = Math.max(...samples.map((s) => s.sentAt - s.serverTime));
    expect(legacyLandingMs(measurePath, legacyOffset, 1_700_000_100_000, 100)).toBeLessThan(
      -AHEAD_LIMIT_MS,
    );
  });

  it('下限兜底：路径严重不对称（去程慢、回程快）时，落点不会跑到服务器时间前面', () => {
    const path: Path = { localAheadMs: 0, outboundMs: 3_000, inboundMs: 100 };
    const skew = computeClockSkew(sample(path, 3));
    // 中点估计单独用会偏小 1450ms，落点因此跑到前面 → -1021。
    expect(skew.maxObservedMs).toBe(-1_450);
    expect(
      landingMs(path, { ...skew, offsetMs: skew.maxObservedMs }, 1_700_000_100_000, 100),
    ).toBeLessThan(-AHEAD_LIMIT_MS);
    // 「下限」把它兜住：收到时刻 − 服务器时刻 = 回程延迟 + 偏差 ≥ 偏差。
    expect(skew.floorMs).toBe(100);
    const landing = landingMs(path, skew, 1_700_000_100_000, 100);
    expect(landing).toBeGreaterThanOrEqual(0);
    expect(landing).toBeLessThanOrEqual(RECV_WINDOW_MS);
  });

  it('本机慢 1 秒、RTT 2 秒 → 落点在容忍区间内', () => {
    const path: Path = { localAheadMs: -1_000, outboundMs: 1_000, inboundMs: 1_000 };
    const skew = computeClockSkew(sample(path, 3));
    expect(skew.minObservedMs).toBe(-1_000);
    expect(skew.maxObservedMs).toBe(-1_000);
    const landing = landingMs(path, skew, 1_700_000_100_000, 1_200);
    expect(landing).toBeGreaterThanOrEqual(-AHEAD_LIMIT_MS);
    expect(landing).toBeLessThanOrEqual(RECV_WINDOW_MS);
  });

  it('本机快 400 毫秒 + 路径抖动 → 落点仍在容忍区间内', () => {
    const path: Path = { localAheadMs: 400, outboundMs: 800, inboundMs: 1_600 };
    const skew = computeClockSkew(sample(path, 3));
    const landing = landingMs(path, skew, 1_700_000_100_000, 300);
    expect(landing).toBeGreaterThanOrEqual(-AHEAD_LIMIT_MS);
    expect(landing).toBeLessThanOrEqual(RECV_WINDOW_MS);
  });

  it('取**最大值**：离群样本（响应打到了慢节点）不会把补偿拉小', () => {
    // 回程越慢，中点估计越大；取最大 = 补偿往「更早」的方向偏，正是安全的那一侧。
    const samples = [
      measure({ localAheadMs: 0, outboundMs: 1_000, inboundMs: 1_000 }, 1_700_000_000_000),
      measure({ localAheadMs: 0, outboundMs: 1_000, inboundMs: 3_000 }, 1_700_000_030_000),
      measure({ localAheadMs: 0, outboundMs: 1_000, inboundMs: 200 }, 1_700_000_060_000),
    ];
    const skew = computeClockSkew(samples);
    expect(skew.maxObservedMs).toBe(1_000);
    expect(skew.minObservedMs).toBe(-400);
    expect(skew.offsetMs).toBe(1_000);
  });

  it('极差过大时仍按最保守的观测补偿，但把抖动报出来', () => {
    const skew = computeClockSkew(
      sample({ localAheadMs: 0, outboundMs: 1_000, inboundMs: 1_000 }, 1).concat(
        sample({ localAheadMs: 0, outboundMs: 1_000, inboundMs: 9_000 }, 1, 1_700_000_030_000),
      ),
    );
    expect(skew.warning).toMatch(/极差/);
    expect(describeClockSkew(skew)).toMatch(/注意/);
  });

  it('偏移大到 60s 以上 → 抛错并指向修系统时钟', () => {
    try {
      computeClockSkew(sample({ localAheadMs: 120_000, outboundMs: 10, inboundMs: 10 }, 2));
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
      { sentAt: 1_000, receivedAt: 1_100, serverTime: 100 },
      { sentAt: Number.NaN, receivedAt: 1_100, serverTime: 100 },
      { sentAt: 2_000, receivedAt: 2_100, serverTime: 1_100 },
    ]);
    expect(skew.samples).toBe(2);
    expect(skew.offsetMs).toBe(1_000);
  });

  it('坏样本（收到时刻早于发出时刻）被丢掉，而不是拿来算偏移', () => {
    const skew = computeClockSkew([
      { sentAt: 2_000, receivedAt: 1_000, serverTime: 1_500 },
      { sentAt: 3_000, receivedAt: 3_100, serverTime: 2_500 },
    ]);
    expect(skew.samples).toBe(1);
    expect(skew.offsetMs).toBe(600);
  });
});

describe('describeClockSkew', () => {
  it('把方向、量级与样本区间都写出来（补偿必须可见）', () => {
    const path: Path = { localAheadMs: 900, outboundMs: 1_000, inboundMs: 1_100 };
    const text = describeClockSkew(computeClockSkew(sample(path, 3)));
    expect(text).toMatch(/快于交易所/);
    expect(text).toMatch(/3 个样本/);
    expect(text).toMatch(/签名时间戳已按此补偿/);
  });
});
