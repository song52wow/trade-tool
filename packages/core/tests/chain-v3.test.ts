/**
 * 链上仓位估值的纯函数测试（不出网、不连 PG）。
 *
 * 锁的是「算出来的账对不对」，用的样本是**真实链上数据**
 * （BSC 上 pPOLY/USDT 的 V3 仓位 #7784261，2026-11-10 16:51 存入）：
 *
 *   * 流动性 550060234221891411106；
 *   * 边界 tick 24400 / 25200（价格 11.47 – 12.43）；
 *   * 投入 3.4 个 pPOLY + 34.677496 个 USDT；
 *   * 当前 sqrtPriceX96 0x370e5d96bbcfe77aa0557f4b3（tick 24716）。
 *
 * 这几个数是**独立核对过**的：池子自己的 `positions(bytes32)` 与仓位管理器上的
 * `positions(uint256)` 一致，且「反推的存入价格」能把投入的两个币**精确还原**
 * （相对误差 < 1e-6）。因此这里锁住的是「别把已经对过的账算歪」。
 */

import {
  accruedFees,
  computeChainApy,
  computeChainPositionSnapshot,
  feeGrowthInside,
  fromRaw,
  liquidityToAmounts,
  priceFromSqrtPrice,
  rollChainPositionCost,
  solveDepositSqrtPrice,
  sqrtRatioAtTick,
  tickAtSqrtRatio,
  toRaw,
} from '@trade-tool/core';
import { describe, expect, it } from 'vitest';

const LIQUIDITY = 550060234221891411106n;
const TICK_LOWER = 24400;
const TICK_UPPER = 25200;
const DEPOSIT_0 = 3400000000000000000n;
const DEPOSIT_1 = 34677495886492744054n;
const SQRT_PRICE = 272624679396422263054081193139n;

describe('tick 与价格的换算', () => {
  it('tick → 价格与链上对得上', () => {
    // 24400 → 11.4716，25200 → 12.4270（池子 slot0 的 tick 24716 → 11.8405）。
    expect(priceFromSqrtPrice(sqrtRatioAtTick(24400))).toBeCloseTo(11.4716, 3);
    expect(priceFromSqrtPrice(sqrtRatioAtTick(25200))).toBeCloseTo(12.427, 2);
    expect(priceFromSqrtPrice(SQRT_PRICE)).toBeCloseTo(11.84053, 4);
  });

  it('sqrtPriceX96 → tick 与 slot0 自带的 tick 一致', () => {
    expect(tickAtSqrtRatio(SQRT_PRICE)).toBe(24716);
  });

  it('tick 越界与非法值必须报错，不得静默给个数', () => {
    expect(() => sqrtRatioAtTick(900000)).toThrow(/超出可表示范围/);
    expect(() => sqrtRatioAtTick(1.5)).toThrow(/必须是整数/);
  });
});

describe('liquidityToAmounts', () => {
  const lower = sqrtRatioAtTick(TICK_LOWER);
  const upper = sqrtRatioAtTick(TICK_UPPER);

  it('区间内：两个币都有，比例与公式一致', () => {
    const got = liquidityToAmounts(LIQUIDITY, SQRT_PRICE, lower, upper);
    expect(fromRaw(got.amount0)).toBeCloseTo(3.8178, 3);
    expect(fromRaw(got.amount1)).toBeCloseTo(29.7176, 3);
  });

  it('低于下界：全是 token0；高于上界：全是 token1', () => {
    const below = liquidityToAmounts(LIQUIDITY, lower - 1n, lower, upper);
    expect(below.amount1).toBe(0n);
    expect(below.amount0).toBeGreaterThan(0n);

    const above = liquidityToAmounts(LIQUIDITY, upper + 1n, lower, upper);
    expect(above.amount0).toBe(0n);
    expect(above.amount1).toBeGreaterThan(0n);
  });

  it('边界反了必须报错', () => {
    expect(() => liquidityToAmounts(LIQUIDITY, SQRT_PRICE, upper, lower)).toThrow(
      /下界必须小于上界/,
    );
  });
});

describe('solveDepositSqrtPrice', () => {
  it('反推出的价格能把投入的两个币精确还原', () => {
    const lower = sqrtRatioAtTick(TICK_LOWER);
    const upper = sqrtRatioAtTick(TICK_UPPER);
    const sqrtDeposit = solveDepositSqrtPrice(LIQUIDITY, lower, upper, DEPOSIT_0, DEPOSIT_1);
    const got = liquidityToAmounts(LIQUIDITY, sqrtDeposit, lower, upper);
    // 相对误差 < 1e-6（Uniswap 自己取整带来的）
    expect(Number(got.amount0 - DEPOSIT_0) / Number(DEPOSIT_0)).toBeLessThan(1e-6);
    expect(Number(got.amount1 - DEPOSIT_1) / Number(DEPOSIT_1)).toBeLessThan(1e-6);
    // 存入时的价格：11.9027 USDT/pPOLY。
    expect(priceFromSqrtPrice(sqrtDeposit)).toBeCloseTo(11.9027, 3);
  });

  it('数量与流动性对不上时必须报错，不得给个「差不多」的价格', () => {
    const lower = sqrtRatioAtTick(TICK_LOWER);
    const upper = sqrtRatioAtTick(TICK_UPPER);
    expect(() =>
      solveDepositSqrtPrice(LIQUIDITY, lower, upper, DEPOSIT_0 * 3n, DEPOSIT_1 * 3n),
    ).toThrow(/反推存入价格失败/);
  });
});

describe('feeGrowthInside', () => {
  // 样例里的 outside 值必须「上界 > 下界」才符合现实（价格从上往下穿过区间时，
  // 上界之外累计的手续费增长不会少于下界之外的），否则 inside 会算成负数。
  it('区间内 = global - outside_lower - outside_upper', () => {
    expect(feeGrowthInside(100n, 30n, 30n, 50, 20, 80)).toBe(40n);
  });

  it('低于下界时 = outside_lower - outside_upper', () => {
    expect(feeGrowthInside(100n, 50n, 20n, 10, 20, 80)).toBe(30n);
  });

  it('高于上界时 = outside_upper - outside_lower', () => {
    expect(feeGrowthInside(100n, 20n, 50n, 90, 20, 80)).toBe(30n);
  });
});

describe('accruedFees', () => {
  it('按 (当前 - 基准) × 流动性 / 2^128 累计', () => {
    const fees = accruedFees(1n << 128n, 5n, 1n, 0n);
    expect(fees).toBe(4n);
  });

  it('基准比当前还大时按 0 算，不许回绕成天文数字', () => {
    expect(accruedFees(1n << 128n, 1n, 5n, 7n)).toBe(7n);
  });
});

describe('computeChainPositionSnapshot', () => {
  const snapshot = computeChainPositionSnapshot({
    block: 132918540n,
    sqrtPriceX96: SQRT_PRICE,
    tick: 24716,
    tickLower: TICK_LOWER,
    tickUpper: TICK_UPPER,
    liquidity: LIQUIDITY,
    amount0: liquidityToAmounts(
      LIQUIDITY,
      SQRT_PRICE,
      sqrtRatioAtTick(TICK_LOWER),
      sqrtRatioAtTick(TICK_UPPER),
    ).amount0,
    amount1: liquidityToAmounts(
      LIQUIDITY,
      SQRT_PRICE,
      sqrtRatioAtTick(TICK_LOWER),
      sqrtRatioAtTick(TICK_UPPER),
    ).amount1,
    fee0: 0n,
    fee1: 0n,
    depositAmount0: DEPOSIT_0,
    depositAmount1: DEPOSIT_1,
  });

  it('价值、成本、盈亏与人工核对的结果一致', () => {
    // 现值 ≈ 3.8178 pPOLY × 11.8405 + 29.7176 USDT ≈ 74.92 USDT
    expect(snapshot.valueUsdt).toBeCloseTo(74.92, 1);
    // 成本 = 3.4 × 11.9027 + 34.6775 ≈ 75.15 USDT
    expect(snapshot.costUsdt).toBeCloseTo(75.15, 1);
    // 浮动盈亏 ≈ −0.23 USDT（−0.3%）
    expect(snapshot.pnlUsdt).toBeCloseTo(-0.23, 1);
    expect(snapshot.pnlPct).toBeCloseTo(-0.31, 0);
    expect(snapshot.inRange).toBe(true);
  });

  it('区间边界的价格也对得上', () => {
    expect(snapshot.priceLower).toBeCloseTo(11.4716, 3);
    expect(snapshot.priceUpper).toBeCloseTo(12.427, 2);
  });
});

describe('rollChainPositionCost', () => {
  const base = {
    sqrtPriceX96: SQRT_PRICE,
    tickLower: TICK_LOWER,
    tickUpper: TICK_UPPER,
  };

  it('流动性没变时成本不动', () => {
    const got = rollChainPositionCost({
      ...base,
      liquidity: LIQUIDITY,
      lastLiquidity: LIQUIDITY,
      costUsdt: 75.15,
      realizedUsdt: 0,
    });
    expect(got.costUsdt).toBeCloseTo(75.15, 5);
    expect(got.realizedUsdt).toBe(0);
  });

  it('加仓：成本按当时价格加上新增部分', () => {
    const got = rollChainPositionCost({
      ...base,
      liquidity: LIQUIDITY * 2n,
      lastLiquidity: LIQUIDITY,
      costUsdt: 75.15,
      realizedUsdt: 0,
    });
    expect(got.costUsdt).toBeCloseTo(75.15 + 74.92, 0);
    expect(got.realizedUsdt).toBe(0);
  });

  it('减仓：成本按比例分摊出去，差额记成已实现盈亏', () => {
    const got = rollChainPositionCost({
      ...base,
      liquidity: LIQUIDITY / 2n,
      lastLiquidity: LIQUIDITY,
      costUsdt: 75.15,
      realizedUsdt: 0,
    });
    expect(got.costUsdt).toBeCloseTo(75.15 / 2, 1);
    // 撤走一半：拿回约一半价值，成本也分摊一半 → 已实现盈亏 ≈ 价值差的一半
    expect(got.realizedUsdt).toBeCloseTo((74.92 - 75.15) / 2, 1);
  });
});

describe('原始单位与展示数量的换算', () => {
  it('toRaw 不丢精度（浮点做不到）', () => {
    expect(toRaw('3.4')).toBe(3400000000000000000n);
    expect(toRaw('34.677495886492744054')).toBe(34677495886492744054n);
    expect(toRaw('0.000000000000000001')).toBe(1n);
  });

  it('fromRaw 只用于展示，toRaw 才是精确的那一侧', () => {
    expect(fromRaw(3400000000000000000n)).toBeCloseTo(3.4, 12);
    // 反过来走字符串才是精确的：浮点会丢掉 18 位小数的低位
    expect(toRaw('34.677495886492744054')).toBe(34677495886492744054n);
  });

  it('格式不合法必须报错', () => {
    expect(() => toRaw('abc')).toThrow(/格式不合法/);
  });
});

/**
 * 年化（APY）的口径。
 *
 * 盯的是四件容易做错的事：
 *   1. **年化必须带窗口**：同一笔钱在 7 天窗口和 30 天窗口是两个数；
 *   2. **窗口不到一天不年化**——半天里恰好吃到一笔大额，年化出来是噪声；
 *   3. **手续费被领取过就不给年化**——累计额变小不是「亏了」，是钱被取走了；
 *   4. **没有采样 / 没有本金就不给数**，只说清为什么。
 */
describe('年化收益率（APY）', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('7 天窗口：按窗口内实收手续费年化', () => {
    const got = computeChainApy({
      feeStartUsdt: 0.1,
      feeNowUsdt: 1.38,
      tsStartMs: 1_760_000_000_000,
      tsNowMs: 1_760_000_000_000 + 7 * DAY,
      capitalUsdt: 75.15,
    });
    // (1.38 - 0.1) / 75.15 * 365/7 * 100 ≈ 77.94%
    expect(got.apyPct).toBeCloseTo(((1.38 - 0.1) / 75.15) * (365 / 7) * 100, 6);
    expect(got.feeUsdt).toBeCloseTo(1.28, 10);
    expect(got.windowMs).toBe(7 * DAY);
    expect(got.note).toBeNull();
  });

  it('窗口不到一天：不给年化，但把窗口内收了多少给出来', () => {
    const got = computeChainApy({
      feeStartUsdt: 0,
      feeNowUsdt: 0.5,
      tsStartMs: 1_760_000_000_000,
      tsNowMs: 1_760_000_000_000 + 3 * 60 * 60 * 1000,
      capitalUsdt: 75.15,
    });
    expect(got.apyPct).toBeNull();
    expect(got.feeUsdt).toBeCloseTo(0.5, 10);
    expect(got.note).toMatch(/不到一天/);
  });

  it('窗口内手续费被领取过：不给年化（累计额变小不是亏了）', () => {
    const got = computeChainApy({
      feeStartUsdt: 2.0,
      feeNowUsdt: 0.1,
      tsStartMs: 1_760_000_000_000,
      tsNowMs: 1_760_000_000_000 + 7 * DAY,
      capitalUsdt: 75.15,
    });
    expect(got.apyPct).toBeNull();
    expect(got.feeUsdt).toBeNull();
    expect(got.note).toMatch(/领取过/);
  });

  it('没有采样 / 没有本金：不给数，只说清为什么', () => {
    const noSample = computeChainApy({
      feeStartUsdt: null,
      feeNowUsdt: null,
      tsStartMs: null,
      tsNowMs: null,
      capitalUsdt: 75.15,
    });
    expect(noSample.apyPct).toBeNull();
    expect(noSample.note).toMatch(/还没有采样/);

    const noCapital = computeChainApy({
      feeStartUsdt: 0,
      feeNowUsdt: 1,
      tsStartMs: 1_760_000_000_000,
      tsNowMs: 1_760_000_000_000 + 7 * DAY,
      capitalUsdt: 0,
    });
    expect(noCapital.apyPct).toBeNull();
    expect(noCapital.note).toMatch(/投入成本/);
  });

  it('窗口里一笔手续费没赚到：年化就是 0（那是真的 0，不是没数据）', () => {
    const got = computeChainApy({
      feeStartUsdt: 1.28,
      feeNowUsdt: 1.28,
      tsStartMs: 1_760_000_000_000,
      tsNowMs: 1_760_000_000_000 + 7 * DAY,
      capitalUsdt: 75.15,
    });
    expect(got.apyPct).toBe(0);
    expect(got.note).toBeNull();
  });
});
