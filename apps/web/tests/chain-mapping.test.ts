/**
 * 链上仓位的字段映射（v1.2.0）。
 *
 * **真 PG**（真迁移，从空库跑到 026）：映射要把库里那一行变成页面那一行，
 * 而「字段没错位」只能对着真列验——尤其是：
 *   * `pnlPct` 是**百分数**（-0.25 表示 -0.25%），页面不能再乘一次 100；
 *   * `amount0` / `amount1` / `liquidity` 是**原始单位**的字符串，
 *     服务端不许自作主张换算（页面才除以 1e18）；
 *   * `priceLower` / `priceUpper` 由 tick 换算，口径与 core 的 `priceFromTick` 一致。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createTestSchema,
  insertChainSnapshot,
  listChainPositions,
  listChainSnapshots,
  upsertChainPosition,
  type TestSchema,
} from '@trade-tool/data';

import { toChainPositionDto, toChainSnapshotDto } from '../src/service.js';

const NOW = 1_760_000_000_000;
const POSITION_KEY = '0xabc123';

let schema: TestSchema;

beforeAll(async () => {
  schema = await createTestSchema('web_chain');
});

afterAll(async () => {
  await schema.close();
});

beforeEach(async () => {
  await schema.pool.query('TRUNCATE chain_position_alert, chain_position_snapshot, chain_position');
});

/** 登记一笔仓位（与 `apps/chain-monitor` 的登记口径一致）。 */
async function seedPosition(overrides: Partial<Parameters<typeof upsertChainPosition>[1]> = {}) {
  await upsertChainPosition(schema.pool, {
    positionKey: POSITION_KEY,
    chain: 'bsc',
    positionManager: '0xmanager',
    pool: '0xpool',
    token0: '0xtoken0',
    token1: '0xtoken1',
    tokenId: '7784261',
    owner: '0xa6150000000000000000000000000000000004488',
    tickLower: 24400,
    tickUpper: 25200,
    symbol0: 'pPOLY',
    symbol1: 'USDT',
    depositAmount0: '3817796370563371000000',
    depositAmount1: '29717601928740590000000',
    depositTx: '0x0919aaaa615',
    nowMs: NOW,
    ...overrides,
  });
}

async function seedSnapshot(overrides: Partial<Parameters<typeof insertChainSnapshot>[1]> = {}) {
  await insertChainSnapshot(schema.pool, {
    positionKey: POSITION_KEY,
    ts: NOW - 60_000,
    block: 132_918_540n,
    price: 11.8404,
    amount0: 3_817_796_370_563_371_000_000n,
    amount1: 29_717_601_928_740_590_000_000n,
    valueUsdt: 74.92,
    costUsdt: 75.15,
    realizedUsdt: 0,
    pnlUsdt: -0.19,
    pnlPct: -0.25,
    feeUsdt: 0.03,
    inRange: true,
    liquidity: 550_060_234_221_891_411_106n,
    ...overrides,
  });
}

describe('链上仓位的字段映射', () => {
  it('仓位：每个字段都对得上，没有错位', async () => {
    await seedPosition();
    await seedSnapshot();

    const rows = await listChainPositions(schema.pool);
    expect(rows).toHaveLength(1);
    const dto = toChainPositionDto(rows[0]!);

    expect(dto.positionKey).toBe(POSITION_KEY);
    expect(dto.chain).toBe('bsc');
    expect(dto.symbol0).toBe('pPOLY');
    expect(dto.symbol1).toBe('USDT');
    expect(dto.tokenId).toBe('7784261');
    expect(dto.owner).toBe('0xa6150000000000000000000000000000000004488');
    expect(dto.depositTx).toBe('0x0919aaaa615');
    // 链上身份（页面上的「链上查看」链接靠它们拼）
    expect(dto.positionManager).toBe('0xmanager');
    expect(dto.pool).toBe('0xpool');
    expect(dto.token0).toBe('0xtoken0');
    expect(dto.token1).toBe('0xtoken1');
    // 最近一次采样的数字
    expect(dto.price).toBe(11.8404);
    expect(dto.inRange).toBe(true);
    expect(dto.valueUsdt).toBe(74.92);
    expect(dto.pnlUsdt).toBe(-0.19);
    expect(dto.feeUsdt).toBe(0.03);
    // 滚动状态
    expect(dto.costUsdt).toBe(0);
    expect(dto.realizedUsdt).toBe(0);
  });

  it('外部链接：服务端算好，页面不自己拼（口径只有一份）', async () => {
    await seedPosition();

    const rows = await listChainPositions(schema.pool);
    const dto = toChainPositionDto(rows[0]!);

    expect(dto.links.explorer.pool).toBe('https://bscscan.com/address/0xpool');
    expect(dto.links.explorer.owner).toBe(
      'https://bscscan.com/address/0xa6150000000000000000000000000000000004488',
    );
    expect(dto.links.explorer.position).toBe('https://bscscan.com/nft/0xmanager/7784261');
    expect(dto.links.explorer.depositTx).toBe('https://bscscan.com/tx/0x0919aaaa615');
    expect(dto.links.liquidity.position).toBe(
      'https://pancakeswap.finance/liquidity/7784261?chain=bsc',
    );
    expect(dto.links.liquidity.positions).toBe(
      'https://pancakeswap.finance/liquidity/positions?network=56',
    );
  });

  it('年化：服务端算好，算不出来时是 null + 原因（不是 0）', async () => {
    await seedPosition();
    await seedSnapshot();

    const rows = await listChainPositions(schema.pool);
    const dto = toChainPositionDto(rows[0]!);

    // 只有一次采样 → 窗口是 0 → 不到一天，不年化
    expect(dto.apy.apyPct).toBeNull();
    // 成本为 0（没滚动过）时更早一步：连分母都没有
    expect(dto.apy.note).toMatch(/投入成本/);
    expect(dto.apy.capitalUsdt).toBe(0);
  });

  it('pnlPct 原样透出（它已经是百分数，不能再乘 100）', async () => {
    await seedPosition();
    await seedSnapshot({ pnlPct: -0.25 });

    const rows = await listChainPositions(schema.pool);
    const dto = toChainPositionDto(rows[0]!);

    // -0.25 表示 -0.25%。页面直接显示；若这里变成 -25，那页面就会显示成 -2500%。
    expect(dto.pnlPct).toBe(-0.25);
  });

  it('原始单位原样透出：字符串，不在服务端换算', async () => {
    await seedPosition();
    await seedSnapshot();

    const rows = await listChainPositions(schema.pool);
    const dto = toChainPositionDto(rows[0]!);

    expect(typeof dto.amount0).toBe('string');
    expect(dto.amount0).toBe('3817796370563371000000');
    expect(dto.amount1).toBe('29717601928740590000000');
    expect(dto.liquidity).toBe('550060234221891411106');
  });

  it('区间上下界由 tick 换算，口径是 1.0001^tick', async () => {
    await seedPosition({ tickLower: 24400, tickUpper: 25200 });

    const rows = await listChainPositions(schema.pool);
    const dto = toChainPositionDto(rows[0]!);

    expect(dto.priceLower).toBeCloseTo(Math.pow(1.0001, 24400), 6);
    expect(dto.priceUpper).toBeCloseTo(Math.pow(1.0001, 25200), 6);
    // 下界必须小于上界：反了就说明换算的符号搞错了。
    expect(dto.priceLower).toBeLessThan(dto.priceUpper);
  });

  it('还没采过样时：采样来的字段是 null，不是 0', async () => {
    await seedPosition();

    const rows = await listChainPositions(schema.pool);
    const dto = toChainPositionDto(rows[0]!);

    // 0 会被页面显示成「这个仓位一文不值」——那是谎报。
    expect(dto.price).toBeNull();
    expect(dto.valueUsdt).toBeNull();
    expect(dto.pnlUsdt).toBeNull();
    expect(dto.pnlPct).toBeNull();
    expect(dto.feeUsdt).toBeNull();
    expect(dto.amount0).toBeNull();
    expect(dto.inRange).toBeNull();
    // 但区间边界**不依赖采样**，永远有值（它由 tick 决定）。
    expect(dto.priceLower).toBeGreaterThan(0);
    expect(dto.priceUpper).toBeGreaterThan(0);
  });

  it('采样点：字段对得上，且原始单位那三列不外传', async () => {
    await seedPosition();
    await seedSnapshot();

    const rows = await listChainSnapshots(schema.pool, POSITION_KEY);
    expect(rows).toHaveLength(1);
    const dto = toChainSnapshotDto(rows[0]!);

    expect(dto.ts).toBe(NOW - 60_000);
    expect(dto.block).toBe('132918540');
    expect(dto.price).toBe(11.8404);
    expect(dto.valueUsdt).toBe(74.92);
    expect(dto.pnlUsdt).toBe(-0.19);
    expect(dto.pnlPct).toBe(-0.25);
    expect(dto.feeUsdt).toBe(0.03);
    expect(dto.inRange).toBe(true);
  });

  it('采样历史是升序的（画曲线时横轴按时间排布）', async () => {
    await seedPosition();
    await seedSnapshot({ ts: NOW - 120_000, price: 11.5 });
    await seedSnapshot({ ts: NOW - 60_000, price: 11.8404 });
    await seedSnapshot({ ts: NOW, price: 12.1 });

    const rows = await listChainSnapshots(schema.pool, POSITION_KEY);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.ts).toBeLessThan(rows[1]!.ts);
    expect(rows[1]!.ts).toBeLessThan(rows[2]!.ts);
  });

  it('没有采样时是空数组，不是 null', async () => {
    await seedPosition();
    const rows = await listChainSnapshots(schema.pool, POSITION_KEY);
    expect(rows).toEqual([]);
  });
});
