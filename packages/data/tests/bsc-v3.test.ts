/**
 * 读链这一步的测试（不出网、不连 PG）。
 *
 * 用的样本是**真实链上数据**（BSC 上 pPOLY/USDT 的 V3 仓位 #7784261）：
 * 流动性 550060234221891411106、边界 tick 24400 / 25200、
 * sqrtPriceX96 0x370e5d96bbcfe77aa0557f4b3（tick 24716）。
 *
 * 链上事实由**本地假节点**（`src/testing-bsc.ts`）按真链的 ABI 布局返回——
 * 布局错了替身就白搭（两边一起错却看不出来），所以这里的返回值是照着
 * Uniswap V3 的字序拼的：管理器 12 个字、池子 5 个字。
 */

import { describe, expect, it } from 'vitest';

import {
  BscClient,
  functionSelector,
  keccak256,
  positionKeyHex,
  readChainPosition,
  startMockBscNode,
  type MockBscState,
} from '../src/index.js';

const LIQUIDITY = 550060234221891411106n;
const TICK_LOWER = 24400;
const TICK_UPPER = 25200;
const SQRT_PRICE = 272624679396422263054081193139n;

const POOL = '0xb2c8244fbeee2da006b5d9cf09908081f807c649';
const MANAGER = '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364';
const TOKEN0 = '0x0000000000000000000000000000000000000001';
const TOKEN1 = '0x0000000000000000000000000000000000000002';
const OWNER = '0xa6156641dfcda456985fe6d79cd62313b2d04488';

function baseState(): MockBscState {
  return {
    pool: POOL,
    positionManager: MANAGER,
    token0: TOKEN0,
    token1: TOKEN1,
    position: {
      tokenId: '7784261',
      owner: OWNER,
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      liquidity: LIQUIDITY,
      feeGrowth0Last: 0n,
      feeGrowth1Last: 0n,
      owed0: 0n,
      owed1: 0n,
    },
    sqrtPriceX96: SQRT_PRICE,
    tick: 24716,
    decimals0: 18,
    decimals1: 18,
    // 区间内手续费增长 = global − outsideLower − outsideUpper
    feeGrowthGlobal0: 9_000_000_000_000_000_000_000_000_000_000_000n,
    feeGrowthGlobal1: 60_900_000_000_000_000_000_000_000_000_000_000n,
    feeGrowthOutside0Lower: 1_000_000_000_000_000_000_000_000_000_000_000n,
    feeGrowthOutside0Upper: 2_000_000_000_000_000_000_000_000_000_000_000n,
    feeGrowthOutside1Lower: 20_000_000_000_000_000_000_000_000_000_000_000n,
    feeGrowthOutside1Upper: 10_000_000_000_000_000_000_000_000_000_000_000n,
    poolFee: 10_000,
    blockNumber: 132_918_540n,
  };
}

const CONFIG = {
  chain: 'bsc',
  positionManager: MANAGER,
  pool: POOL,
  token0: TOKEN0,
  token1: TOKEN1,
  tokenId: '7784261',
  owner: OWNER,
  depositAmount0: '3400000000000000000',
  depositAmount1: '34677495886492744054',
};

describe('keccak256', () => {
  it('与公开常量一致（不是 NIST 的 sha3-256）', () => {
    const empty = Buffer.from(keccak256(new Uint8Array(0))).toString('hex');
    expect(empty).toBe('c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');

    const abc = Buffer.from(keccak256(new TextEncoder().encode('abc'))).toString('hex');
    expect(abc).toBe('4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');

    const hello = Buffer.from(keccak256(new TextEncoder().encode('hello'))).toString('hex');
    expect(hello).toBe('1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8');
  });

  it('函数选择器与 Uniswap V3 一致', () => {
    // 这些值在真链上验证过（eth_call 回来的字能正确解码成 tick 区间、流动性与价格）。
    // **它们同时是 keccak 实现是否正确的判据**：ρ/π 的下标写反时，
    // 哈希照样能算出一串 32 字节、**一声不响**，但选择器全是错的
    // （2026-11-11 实测踩过：`positions(uint256)` 算成 0xeb778fda）。
    expect(functionSelector('positions(uint256)')).toBe('0x99fbab88');
    expect(functionSelector('positions(bytes32)')).toBe('0x514ea4bf');
    expect(functionSelector('slot0()')).toBe('0x3850c7bd');
    expect(functionSelector('ownerOf(uint256)')).toBe('0x6352211e');
    expect(functionSelector('decimals()')).toBe('0x313ce567');
    expect(functionSelector('fee()')).toBe('0xddca3f43');
  });
});

describe('positionKeyHex', () => {
  it('用紧凑拼接（20 字节地址 + 3 字节下界 + 3 字节上界）', () => {
    // 独立手算一遍：packed 布局错了这里就会红。
    const packed = new Uint8Array(26);
    packed.set(
      Uint8Array.from((MANAGER.slice(2).match(/../g) ?? []).map((b) => parseInt(b, 16))),
      0,
    );
    packed.set(
      Uint8Array.from(
        (TICK_LOWER.toString(16).padStart(6, '0').match(/../g) ?? []).map((b) => parseInt(b, 16)),
      ),
      20,
    );
    packed.set(
      Uint8Array.from(
        (TICK_UPPER.toString(16).padStart(6, '0').match(/../g) ?? []).map((b) => parseInt(b, 16)),
      ),
      23,
    );
    expect(positionKeyHex(MANAGER, TICK_LOWER, TICK_UPPER)).toBe(
      Buffer.from(keccak256(packed)).toString('hex'),
    );
  });

  it('地址格式不对必须报错', () => {
    expect(() => positionKeyHex('0x1234', 1, 2)).toThrow(/合约地址格式不对/);
  });

  it('负 tick 用 int24 补码编码（价格 < 1 的池子）', () => {
    // 回归用例：旧实现是 `tick.toString(16).padStart(6,'0')`，负 tick 会拼出
    // `"000-64"` 这种非法十六进制，按字节解析成 0 —— key 静默算错。
    // 独立手算：20 字节地址 + 两个 3 字节大端补码。
    const lower = -887272;
    const upper = -100;
    const packed = new Uint8Array(26);
    packed.set(
      Uint8Array.from((MANAGER.slice(2).match(/../g) ?? []).map((b) => parseInt(b, 16))),
      0,
    );
    for (const [offset, tick] of [
      [20, lower],
      [23, upper],
    ] as const) {
      const hex = BigInt.asUintN(24, BigInt(tick)).toString(16).padStart(6, '0');
      packed.set(Uint8Array.from((hex.match(/../g) ?? []).map((b) => parseInt(b, 16))), offset);
    }
    expect(positionKeyHex(MANAGER, lower, upper)).toBe(
      Buffer.from(keccak256(packed)).toString('hex'),
    );
  });

  it('超出 int24 的 tick 报 CONFIG_INVALID，而不是拼出一个错 key', () => {
    expect(() => positionKeyHex(MANAGER, 0, 8_388_608)).toThrow(/int24/);
    expect(() => positionKeyHex(MANAGER, -8_388_609, 0)).toThrow(/int24/);
  });
});

describe('readChainPosition', () => {
  it('读出链上的 tick、流动性与价格', async () => {
    const node = await startMockBscNode(baseState());
    try {
      const client = new BscClient({ endpoints: [node.url] });
      const facts = await readChainPosition(client, CONFIG);

      expect(facts.tickLower).toBe(TICK_LOWER);
      expect(facts.tickUpper).toBe(TICK_UPPER);
      expect(facts.tick).toBe(24716);
      expect(facts.liquidity).toBe(LIQUIDITY);
      expect(facts.sqrtPriceX96).toBe(SQRT_PRICE);
      expect(facts.owner).toBe(OWNER);
      expect(facts.decimals0).toBe(18);
      expect(facts.decimals1).toBe(18);
      expect(facts.poolFee).toBe(10_000);
      expect(facts.block).toBe(132_918_540n);
    } finally {
      await node.close();
    }
  });

  it('两处流动性对不上必须报错（链上数据不自洽时不算账）', async () => {
    const state = baseState();
    state.poolLiquidity = LIQUIDITY - 1n;
    const node = await startMockBscNode(state);
    try {
      const client = new BscClient({ endpoints: [node.url] });
      await expect(readChainPosition(client, CONFIG)).rejects.toThrow(/两处记录的流动性不一致/);
    } finally {
      await node.close();
    }
  });

  it('池子查不到（但管理器说有）必须报错，不能当成「仓位没了」', async () => {
    const state = baseState();
    state.poolLiquidity = 0n;
    const node = await startMockBscNode(state);
    try {
      const client = new BscClient({ endpoints: [node.url] });
      await expect(readChainPosition(client, CONFIG)).rejects.toThrow(
        /池子上按算出来的 key 查不到/,
      );
    } finally {
      await node.close();
    }
  });

  it('节点全挂时抛 NETWORK_ERROR，不返回默认值', async () => {
    const node = await startMockBscNode(baseState());
    const url = node.url;
    await node.close();
    const client = new BscClient({ endpoints: [url] });
    await expect(readChainPosition(client, CONFIG)).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
  });
});
