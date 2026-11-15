/**
 * 告警文案的测试（不出网、不连 PG）。
 *
 * 锁的是三件容易做错的事：
 *   * **指纹只由「是哪笔仓位」决定**——掺进本轮数值会让每轮都算新告警，
 *     冷却形同虚设（AGENTS.md §6.9 第 2 条）；
 *   * **事件型**（`oneShot`）——下一轮它不在了不等于「问题消失了」，
 *     不该推「已恢复」；
 *   * **仓位被清空是大事**——严重度要提到 critical。
 */

import { describe, expect, it } from 'vitest';

import type { ChainPositionSnapshot } from '@trade-tool/core';

import { buildChainPositionAlert } from '../src/alert.js';

function snapshotWith(overrides: Partial<ChainPositionSnapshot> = {}): ChainPositionSnapshot {
  return {
    block: 132_930_326n,
    price: 11.8404,
    tick: 24716,
    tickLower: 24400,
    tickUpper: 25200,
    priceLower: 11.4716,
    priceUpper: 12.427,
    liquidity: 550060234221891411106n,
    amount0: 3_818_900_000_000_000_000n,
    amount1: 29_705_100_000_000_000_000n,
    fee0: 2_876_950_000_000_000n,
    fee1: 0n,
    valueUsdt: 74.92,
    costUsdt: 75.15,
    realizedUsdt: 0,
    pnlUsdt: -0.23,
    pnlPct: -0.31,
    inRange: true,
    feeUsdt: 0.034,
    ...overrides,
  };
}

const POSITION = {
  positionKey: 'abc123',
  symbol0: 'pPOLY',
  symbol1: 'USDT',
  tokenId: '7784261',
  chain: 'bsc',
  pool: '0xB2c8244FBeee2dA006b5D9Cf09908081f807C649',
  positionManager: '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364',
  owner: '0xa6156641dfcda456985fe6d79cd62313b2d04488',
  depositTx: '0x0919aaaa615',
};

describe('链上仓位告警文案', () => {
  it('指纹只由仓位决定，与本轮数值无关', () => {
    const a = buildChainPositionAlert({
      position: POSITION,
      snapshot: snapshotWith({ price: 11.8404, pnlPct: -0.31 }),
      reasons: ['价格较上次推送动了 +1.00%'],
    });
    const b = buildChainPositionAlert({
      position: POSITION,
      snapshot: snapshotWith({ price: 12.5, pnlPct: 3.2 }),
      reasons: ['价格较上次推送动了 +5.00%'],
    });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).toContain(POSITION.positionKey);
  });

  it('是事件型告警（不参与「已恢复」判定）', () => {
    const alert = buildChainPositionAlert({
      position: POSITION,
      snapshot: snapshotWith(),
      reasons: ['首次监控，建立基线'],
    });
    expect(alert.oneShot).toBe(true);
  });

  it('仓位被清空是 critical，其余是 warning', () => {
    const cleared = buildChainPositionAlert({
      position: POSITION,
      snapshot: snapshotWith({ liquidity: 0n }),
      reasons: ['仓位已经清空（流动性归零）'],
    });
    expect(cleared.severity).toBe('critical');
    expect(cleared.title).toContain('已清空');

    const normal = buildChainPositionAlert({
      position: POSITION,
      snapshot: snapshotWith(),
      reasons: ['价格回到设定区间'],
    });
    expect(normal.severity).toBe('warning');
  });

  it('消息里带上价格、区间、持仓、价值与盈亏', () => {
    const alert = buildChainPositionAlert({
      position: POSITION,
      snapshot: snapshotWith(),
      reasons: ['价格跌出设定区间'],
    });
    const text = [...(alert.lines ?? []), ...(alert.highlights ?? [])].join('\n');
    expect(text).toContain('触发原因：价格跌出设定区间');
    expect(text).toContain('11.8404 USDT');
    expect(text).toContain('区间 11.47–12.43');
    expect(text).toContain('区间内');
    expect(text).toContain('3.8189 pPOLY');
    expect(text).toContain('74.92 USDT');
    expect(text).toContain('浮动盈亏：-0.23 USDT');
  });

  it('消息末尾带链上链接：区块浏览器与流动性平台各一条', () => {
    const alert = buildChainPositionAlert({
      position: POSITION,
      snapshot: snapshotWith(),
      reasons: ['价格跌出设定区间'],
    });
    const text = (alert.lines ?? []).join('\n');
    expect(text).toContain(
      '区块浏览器：https://bscscan.com/nft/0x46a15b0b27311cedf172ab29e4f4766fbe7f4364/7784261',
    );
    expect(text).toContain('流动性平台：https://pancakeswap.finance/liquidity/7784261?chain=bsc');
  });

  it('链不认识时不硬凑链接（那会是死链）', () => {
    const alert = buildChainPositionAlert({
      position: { ...POSITION, chain: 'unknown-chain' },
      snapshot: snapshotWith(),
      reasons: ['价格跌出设定区间'],
    });
    const text = (alert.lines ?? []).join('\n');
    expect(text).not.toContain('区块浏览器：');
    expect(text).not.toContain('流动性平台：');
  });
});
