/**
 * 链上仓位的读写（真库、真迁移、真 SQL）。
 *
 * 守的是一条容易翻车的边界：**「上一轮的流动性」与「本轮采样的流动性」是两件事**。
 * 2026-11-11 实测踩过：列表查询里 `s.liquidity AS last_liquidity` 撞上了表里
 * 同名的 `last_liquidity` 列，后出现的把前一个盖掉了——于是「上一轮的值」
 * 永远是「这一轮的值」，**加减仓与清空都检测不出来**，而且一声不响。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  insertChainSnapshot,
  listChainPositions,
  listChainSnapshots,
  markChainPositionAlerted,
  readChainPositionByToken,
  readChainPositionState,
  updateChainPositionState,
  upsertChainPosition,
} from '../src/index.js';

import { createTestSchema } from './helpers/pg.js';

const NOW = 1_760_000_000_000;
const KEY = 'a'.repeat(64);
const MANAGER = '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364';

describe('链上仓位的读写', () => {
  let ctx: Awaited<ReturnType<typeof createTestSchema>>;

  beforeAll(async () => {
    ctx = await createTestSchema('chainpos');
  });
  afterAll(async () => {
    await ctx.close();
  });

  // 每个用例从干净的三张表开始：它们共享同一个随机 schema，
  // 上一条用例留下的采样会被下一条数出来（「历史按时间正序」那条尤其容易中招）。
  beforeEach(async () => {
    await ctx.pool.query('TRUNCATE chain_position_alert, chain_position_snapshot, chain_position');
  });

  async function seed(): Promise<void> {
    await upsertChainPosition(ctx.pool, {
      positionKey: KEY,
      chain: 'bsc',
      positionManager: MANAGER,
      pool: '0xb2c8244fbeee2da006b5d9cf09908081f807c649',
      token0: '0x0000000000000000000000000000000000000001',
      token1: '0x0000000000000000000000000000000000000002',
      tokenId: '7784261',
      owner: '0xa6156641dfcda456985fe6d79cd62313b2d04488',
      tickLower: 24400,
      tickUpper: 25200,
      symbol0: 'pPOLY',
      symbol1: 'USDT',
      depositAmount0: '3400000000000000000',
      depositAmount1: '34677495886492744054',
      nowMs: NOW,
    });
  }

  it('「上一轮的流动性」与「本轮采样的流动性」不许混', async () => {
    await seed();
    await insertChainSnapshot(ctx.pool, {
      positionKey: KEY,
      ts: NOW,
      block: 132_930_326n,
      price: 11.8404,
      amount0: 3_818_900_000_000_000_000n,
      amount1: 29_705_100_000_000_000_000n,
      valueUsdt: 74.92,
      costUsdt: 75.15,
      realizedUsdt: 0,
      pnlUsdt: -0.23,
      pnlPct: -0.31,
      feeUsdt: 0.034,
      inRange: true,
      liquidity: 550060234221891411106n,
    });
    // 滚动状态记的是**上一轮**的流动性
    await updateChainPositionState(ctx.pool, KEY, {
      lastLiquidity: '549000000000000000000',
      inRange: true,
      baselineDone: true,
      lastPollAt: NOW,
    });

    const rows = await listChainPositions(ctx.pool);
    expect(rows).toHaveLength(1);
    // 滚动状态里的「上一轮」
    expect(rows[0]!.lastLiquidity).toBe('549000000000000000000');
    // 采样里的「这一轮」——两个值必须能同时看见，不许互相覆盖
    expect(rows[0]!.snapshotLiquidity).toBe('550060234221891411106');
  });

  it('年化窗口的起点：最近 7 天里最早的那条采样', async () => {
    await seed();
    // 三条采样：最近 7 天内两条，7 天前一条（应当被排除在窗口外）
    await insertChainSnapshot(ctx.pool, {
      positionKey: KEY,
      ts: NOW - 8 * 24 * 60 * 60 * 1000,
      block: 132_930_326n,
      price: 11.8404,
      amount0: 3_818_900_000_000_000_000n,
      amount1: 29_705_100_000_000_000_000n,
      valueUsdt: 74.92,
      costUsdt: 75.15,
      realizedUsdt: 0,
      pnlUsdt: -0.23,
      pnlPct: -0.31,
      feeUsdt: 0.01,
      inRange: true,
      liquidity: 550060234221891411106n,
    });
    await insertChainSnapshot(ctx.pool, {
      positionKey: KEY,
      ts: NOW - 3 * 24 * 60 * 60 * 1000,
      block: 132_930_326n,
      price: 11.8404,
      amount0: 3_818_900_000_000_000_000n,
      amount1: 29_705_100_000_000_000_000n,
      valueUsdt: 74.92,
      costUsdt: 75.15,
      realizedUsdt: 0,
      pnlUsdt: -0.23,
      pnlPct: -0.31,
      feeUsdt: 0.5,
      inRange: true,
      liquidity: 550060234221891411106n,
    });
    await insertChainSnapshot(ctx.pool, {
      positionKey: KEY,
      ts: NOW,
      block: 132_930_326n,
      price: 11.8404,
      amount0: 3_818_900_000_000_000_000n,
      amount1: 29_705_100_000_000_000_000n,
      valueUsdt: 74.92,
      costUsdt: 75.15,
      realizedUsdt: 0,
      pnlUsdt: -0.23,
      pnlPct: -0.31,
      feeUsdt: 1.28,
      inRange: true,
      liquidity: 550060234221891411106n,
    });

    const rows = await listChainPositions(ctx.pool);
    // 窗口起点 = 最近 7 天里**最早**的那条（8 天前那条不算）
    expect(rows[0]!.windowTs).toBe(NOW - 3 * 24 * 60 * 60 * 1000);
    expect(rows[0]!.windowFeeUsdt).toBe(0.5);
    // 终点是最新一次采样
    expect(rows[0]!.lastTs).toBe(NOW);
    expect(rows[0]!.lastFeeUsdt).toBe(1.28);
  });

  it('没有采样时：年化窗口的起点是空的（不是 0）', async () => {
    await seed();
    const rows = await listChainPositions(ctx.pool);
    expect(rows[0]!.windowTs).toBeNull();
    expect(rows[0]!.windowFeeUsdt).toBeNull();
  });

  it('没采样过时，采样侧的流动性是空的（不是 0）', async () => {
    await seed();
    const rows = await listChainPositions(ctx.pool);
    expect(rows[0]!.snapshotLiquidity).toBeNull();
    expect(rows[0]!.lastPrice).toBeNull();
  });

  it('「上次推送」的基准单独更新，不与账的状态混在一起', async () => {
    await seed();
    await markChainPositionAlerted(ctx.pool, KEY, { price: 11.84, pnlPct: -0.31, atMs: NOW });
    const row = await readChainPositionState(ctx.pool, KEY);
    expect(row?.lastAlertPrice).toBeCloseTo(11.84, 5);
    expect(row?.lastAlertPnlPct).toBeCloseTo(-0.31, 5);
    expect(row?.lastAlertAt).toBe(NOW);
  });

  it('按「管理器 + tokenId」能找回那一行（读失败时要把错误写上去）', async () => {
    await seed();
    const row = await readChainPositionByToken(ctx.pool, MANAGER, '7784261');
    expect(row?.positionKey).toBe(KEY);
    expect(await readChainPositionByToken(ctx.pool, MANAGER, '9999999')).toBeNull();
  });

  it('采样历史按时间正序返回（画曲线要正着）', async () => {
    await seed();
    for (const [offset, price] of [
      [0, 11.0],
      [60_000, 11.5],
      [120_000, 11.8],
    ] as const) {
      await insertChainSnapshot(ctx.pool, {
        positionKey: KEY,
        ts: NOW + offset,
        block: 132_930_326n,
        price,
        amount0: 0n,
        amount1: 0n,
        valueUsdt: price,
        costUsdt: 75.15,
        realizedUsdt: 0,
        pnlUsdt: price - 75.15,
        pnlPct: 0,
        feeUsdt: 0,
        inRange: true,
        liquidity: 1n,
      });
    }
    const snapshots = await listChainSnapshots(ctx.pool, KEY);
    expect(snapshots.map((s) => s.price)).toEqual([11.0, 11.5, 11.8]);
  });
});
