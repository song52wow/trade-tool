/**
 * 链上仓位的外部链接（v1.2.0）。
 *
 * 这些用例盯的是三件容易悄悄出错的事：
 *   1. **URL 拼错不会报错**——页面上的链接点开是 404，看起来像「链上没这笔交易」；
 *   2. **不认识的链不能猜域名**——猜出来的地址看着能用，点进去却是别的链；
 *   3. **缺一个字段不能让其余链接一起消失**（没记投入交易 ≠ 没有池子链接）。
 */
import { describe, expect, it } from 'vitest';

import { buildChainPositionLinks } from '../src/chain-links.js';

const POOL = '0xB2c8244FBeee2dA006b5D9Cf09908081f807C649';
const MANAGER = '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364';
const OWNER = '0xa6156641dfcda456985fe6d79cd62313b2d04488';
const TX = '0x0919aaaa615';

function links(overrides: Partial<Parameters<typeof buildChainPositionLinks>[0]> = {}) {
  return buildChainPositionLinks({
    chain: 'bsc',
    pool: POOL,
    positionManager: MANAGER,
    tokenId: '7784261',
    owner: OWNER,
    depositTx: TX,
    token0: '0xtoken0',
    token1: '0xtoken1',
    ...overrides,
  });
}

describe('链上仓位的外部链接', () => {
  it('区块浏览器：池子、仓位 NFT、持有人、投入交易、两个代币', () => {
    const { explorer } = links();
    expect(explorer.pool).toBe(`https://bscscan.com/address/${POOL}`);
    expect(explorer.position).toBe(`https://bscscan.com/nft/${MANAGER}/7784261`);
    expect(explorer.owner).toBe(`https://bscscan.com/address/${OWNER}`);
    expect(explorer.depositTx).toBe(`https://bscscan.com/tx/${TX}`);
    expect(explorer.token0).toBe('https://bscscan.com/token/0xtoken0');
    expect(explorer.token1).toBe('https://bscscan.com/token/0xtoken1');
  });

  it('流动性平台：这一笔仓位 + 我的头寸总览', () => {
    const { liquidity } = links();
    expect(liquidity.position).toBe('https://pancakeswap.finance/liquidity/7784261?chain=bsc');
    expect(liquidity.positions).toBe('https://pancakeswap.finance/liquidity/positions?network=56');
  });

  it('链名大小写不敏感（配置里写 "BSC" 也要给链接）', () => {
    expect(links({ chain: 'BSC' }).explorer.pool).not.toBeNull();
    expect(links({ chain: ' bsc ' }).explorer.pool).not.toBeNull();
  });

  it('不认识的链：一条链接都不给，绝不猜域名', () => {
    const result = links({ chain: 'solana' });
    expect(result.explorer.pool).toBeNull();
    expect(result.explorer.position).toBeNull();
    expect(result.explorer.owner).toBeNull();
    expect(result.explorer.depositTx).toBeNull();
    expect(result.explorer.token0).toBeNull();
    expect(result.explorer.token1).toBeNull();
    expect(result.liquidity.position).toBeNull();
    expect(result.liquidity.positions).toBeNull();
  });

  it('缺一个字段只让那一条链接为 null，其余照常给', () => {
    const noTx = links({ depositTx: null });
    expect(noTx.explorer.depositTx).toBeNull();
    expect(noTx.explorer.pool).not.toBeNull();
    expect(noTx.liquidity.position).not.toBeNull();

    const noManager = links({ positionManager: undefined });
    expect(noManager.explorer.position).toBeNull();
    expect(noManager.explorer.pool).not.toBeNull();
  });

  it('空字符串与空白当成「没有」，不拼出半截地址', () => {
    const result = links({ pool: '   ', depositTx: '', tokenId: null });
    expect(result.explorer.pool).toBeNull();
    expect(result.explorer.depositTx).toBeNull();
    expect(result.liquidity.position).toBeNull();
    // 池子没了不影响持有人
    expect(result.explorer.owner).not.toBeNull();
  });
});
