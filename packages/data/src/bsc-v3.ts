/**
 * BSC 链上读取（只读）：PancakeSwap V3 仓位的链上事实。
 *
 * ## 为什么自己实现 keccak256
 *
 * 函数选择器与仓位 key 都要 keccak256，而 Node 的 `crypto` 只有 **sha3-256**——
 * 两者填充规则不同（Ethereum 用的是原始 Keccak，不是 NIST 批准的 SHA-3），
 * 算出来的选择器全是错的，而且**错得很安静**（调用返回空数据，不报错）。
 * 与其引一个依赖，不如把 100 行算法放这里，并用链上的公开常量做自检。
 *
 * ## 这一层只读不写
 *
 * 链上的东西只读；写的一律走 PG（`packages/data/src/db/`）。
 * 仓库的规矩是「写入只走 packages/data」，而这里连 packages/data 都不写库，
 * 只把事实读出来交给上层算账。
 *
 * ## 出网失败怎么办
 *
 * 抛 `SyncError('NETWORK_ERROR')`，**不返回默认值**：链上读不到就是读不到，
 * 假装读到了会让上层拿一个编出来的价格去算盈亏（AGENTS.md 约定 9）。
 */

import {
  SyncError,
  accruedFees,
  feeGrowthInside,
  liquidityToAmounts,
  sqrtRatioAtTick,
  type ChainPositionConfig,
} from '@trade-tool/core';

/** BSC 公共节点。第一个能用的就用它，挂了换下一个。 */
export const DEFAULT_BSC_ENDPOINTS = [
  'https://bsc-dataseed.binance.org',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed2.binance.org',
  'https://bsc.publicnode.com',
];

// --------------------------------------------------------------------------
// keccak256（纯 TS 实现，与 core 的估值口径分开：core 只管算账）
// --------------------------------------------------------------------------

const MASK64 = (1n << 64n) - 1n;

const KECCAK_ROUND_CONSTANTS = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
];

const KECCAK_ROTATIONS = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

function rotl(value: bigint, shift: number): bigint {
  const s = BigInt(shift);
  return ((value << s) | (value >> (64n - s))) & MASK64;
}

function keccakF(state: bigint[][]): void {
  for (let round = 0; round < 24; round += 1) {
    const c: bigint[] = [];
    for (let x = 0; x < 5; x += 1) {
      c.push(state[x]![0]! ^ state[x]![1]! ^ state[x]![2]! ^ state[x]![3]! ^ state[x]![4]!);
    }
    const d: bigint[] = [];
    for (let x = 0; x < 5; x += 1) {
      d.push(c[(x + 4) % 5]! ^ rotl(c[(x + 1) % 5]!, 1));
    }
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        state[x]![y] = state[x]![y]! ^ d[x]!;
      }
    }
    const b: bigint[][] = [[], [], [], [], []];
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        // ρ + π：`B[y][(2x+3y) % 5] = rot(A[x][y], r[x][y])`。
        // ⚠️ **两个下标的顺序不能反**（`B[(2x+3y)%5][y]` 是错的）：
        // 反了之后哈希照样能算出一串 32 字节，**不报任何错**，
        // 但选择器全是错的 → eth_call 调的是别的函数 → 读到的是别的东西。
        // 2026-11-11 实测踩过：`positions(uint256)` 算成 0xeb778fda，
        // 正确值是 0x99fbab88。**判据只能是公开常量**（见 packages/data/tests/bsc-v3.test.ts）。
        const target = b[y]!;
        target[(2 * x + 3 * y) % 5] = rotl(state[x]![y]!, KECCAK_ROTATIONS[x]![y]!);
      }
    }
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        state[x]![y] = b[x]![y]! ^ (~b[(x + 1) % 5]![y]! & MASK64 & b[(x + 2) % 5]![y]!);
      }
    }
    state[0]![0] = state[0]![0]! ^ KECCAK_ROUND_CONSTANTS[round]!;
  }
}

/** 标准 keccak-256（**不是** NIST 的 sha3-256）。 */
export function keccak256(data: Uint8Array): Uint8Array {
  const rate = 136;
  const state: bigint[][] = Array.from({ length: 5 }, () => new Array<bigint>(5).fill(0n));

  const padded = new Uint8Array(Math.ceil((data.length + 1) / rate) * rate);
  padded.set(data);
  padded[data.length] = 0x01;
  padded[padded.length - 1] = padded[padded.length - 1]! | 0x80;

  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let i = 0; i < rate / 8; i += 1) {
      let lane = 0n;
      for (let byte = 7; byte >= 0; byte -= 1) {
        lane = (lane << 8n) | BigInt(padded[offset + i * 8 + byte]!);
      }
      state[i % 5]![Math.floor(i / 5)] = state[i % 5]![Math.floor(i / 5)]! ^ lane;
    }
    keccakF(state);
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i += 1) {
    let lane = state[i % 5]![Math.floor(i / 5)]!;
    for (let byte = 0; byte < 8; byte += 1) {
      out[i * 8 + byte] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** 函数选择器：`positions(uint256)` → `0x99fbab88`。 */
export function functionSelector(signature: string): string {
  return `0x${toHex(keccak256(new TextEncoder().encode(signature))).slice(0, 8)}`;
}

/**
 * 仓位 key（Uniswap V3 的 `PositionLibrary.positionKey`）。
 *
 * ⚠️ 用的是 **紧凑拼接**（`abi.encodePacked`：20 字节地址 + 3 字节下界 + 3 字节上界），
 * 不是 32 字节填充。用填充算出来的 key 查 `positions(bytes32)` 会**静默返回全零**
 * （2026-11-11 实测踩过：查出来 liquidity = 0，一度以为仓位没了）。
 */
export function positionKeyHex(owner: string, tickLower: number, tickUpper: number): string {
  const address = Uint8Array.from(
    (owner.replace(/^0x/, '').match(/../g) ?? []).map((byte) => parseInt(byte, 16)),
  );
  if (address.length !== 20) {
    throw new SyncError('CONFIG_INVALID', `合约地址格式不对：${owner}`);
  }
  const packed = new Uint8Array(26);
  packed.set(address, 0);
  packed.set(hexToBytes(int24Hex(tickLower)), 20);
  packed.set(hexToBytes(int24Hex(tickUpper)), 23);
  return toHex(keccak256(packed));
}

/** int24 的取值范围（Uniswap V3 的 tick 上下界就落在这里面）。 */
const INT24_MIN = -8_388_608;
const INT24_MAX = 8_388_607;

/**
 * tick → 3 字节**大端补码**（`abi.encodePacked(int24)`）。
 *
 * ⚠️ **不能用 `tick.toString(16).padStart(6, '0')`**：负 tick 会得到 `"-64"`，
 * 补零成 `"000-64"`，再按字节解析时 `parseInt('0-', 16)` 是 `NaN`、落到 `0`——
 * 于是拼出一个**看起来合法**的 key，池子按它查回来全是 0，上层报的却是
 * 「池子/管理器地址不对」（2026-11-12 审计发现，价格 < 1 的池子必踩）。
 * 负 tick 在 V3 里完全正常（token1/token0 < 1 的交易对），因此必须按补码编码。
 */
function int24Hex(tick: number): string {
  if (!Number.isInteger(tick)) {
    throw new SyncError('CONFIG_INVALID', `tick 必须是整数，收到 ${String(tick)}`);
  }
  if (tick < INT24_MIN || tick > INT24_MAX) {
    throw new SyncError(
      'CONFIG_INVALID',
      `tick ${String(tick)} 超出 int24 范围（${String(INT24_MIN)}..${String(INT24_MAX)}）`,
    );
  }
  return BigInt.asUintN(24, BigInt(tick)).toString(16).padStart(6, '0');
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// --------------------------------------------------------------------------
// ABI 的最小解码：只拆 32 字节字
// --------------------------------------------------------------------------

/** 拆成 32 字节字（每个字当成无符号整数）。 */
export function decodeWords(hexData: string): bigint[] {
  const raw = hexData.startsWith('0x') ? hexData.slice(2) : hexData;
  if (raw.length % 64 !== 0) {
    throw new SyncError('INTERNAL_ERROR', `ABI 数据长度不对：${raw.length / 2} 字节`);
  }
  const words: bigint[] = [];
  for (let i = 0; i < raw.length; i += 64) words.push(BigInt(`0x${raw.slice(i, i + 64)}`));
  return words;
}

/** int24（有符号）→ number。tick 是有符号的，别按无符号读。 */
export function decodeInt24(word: bigint): number {
  const masked = BigInt.asIntN(24, word);
  return Number(masked);
}

/** uint256 → bigint（已是 bigint，这里只是语义上的命名）。 */
export function decodeUint256(word: bigint): bigint {
  return BigInt.asUintN(256, word);
}

/** 32 字节字里的地址。 */
export function decodeAddress(word: bigint): string {
  return `0x${(word & ((1n << 160n) - 1n)).toString(16).padStart(40, '0')}`;
}

/** 把 bigint 编成 32 字节十六进制（**不带 0x 前缀**，用来接在选择器后面）。 */
export function encodeUint(word: bigint): string {
  return word.toString(16).padStart(64, '0');
}

/** 把有符号整数编成 32 字节十六进制（补码）。 */
export function encodeInt24(value: number): string {
  return (BigInt(value) & ((1n << 256n) - 1n)).toString(16).padStart(64, '0');
}

// --------------------------------------------------------------------------
// 只读客户端
// --------------------------------------------------------------------------

export interface BscClientOptions {
  /** 节点地址列表。第一个可用就用它，挂了自动换下一个。 */
  endpoints: readonly string[];
  /** 单次请求超时（毫秒）。 */
  timeoutMs?: number;
  /** 每个节点最多试几轮（一轮失败换一个节点）。 */
  attemptsPerEndpoint?: number;
}

export class BscClient {
  private readonly endpoints: string[];
  private readonly timeoutMs: number;
  private readonly attemptsPerEndpoint: number;
  private cursor = 0;

  constructor(options: BscClientOptions) {
    if (options.endpoints.length === 0) {
      throw new SyncError('CONFIG_INVALID', '至少要配一个 BSC 节点地址');
    }
    this.endpoints = [...options.endpoints];
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.attemptsPerEndpoint = options.attemptsPerEndpoint ?? 2;
  }

  /** 发一次 JSON-RPC 调用。节点全挂时抛 `NETWORK_ERROR`（不返回默认值）。 */
  async call(method: string, params: readonly unknown[]): Promise<unknown> {
    let lastError: unknown;
    for (
      let attempt = 0;
      attempt < this.endpoints.length * this.attemptsPerEndpoint;
      attempt += 1
    ) {
      const url =
        this.endpoints[
          (this.cursor + Math.floor(attempt / this.attemptsPerEndpoint)) % this.endpoints.length
        ]!;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`HTTP ${String(response.status)}`);
        }
        const body = (await response.json()) as {
          result?: unknown;
          error?: { code?: number; message?: string };
        };
        if (body.error !== undefined) {
          throw new Error(`${body.error.code ?? '?'}: ${body.error.message ?? '未知错误'}`);
        }
        this.cursor =
          (this.cursor + Math.floor(attempt / this.attemptsPerEndpoint)) % this.endpoints.length;
        return body.result;
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new SyncError(
      'NETWORK_ERROR',
      `BSC 节点全部不可用（${method} 失败）：${String(lastError)}`,
      {
        method,
        endpoints: this.endpoints,
      },
    );
  }

  /** 合约只读调用。返回原始十六进制。 */
  async ethCall(to: string, data: string, block?: string): Promise<string> {
    const result = await this.call('eth_call', [{ to, data }, block ?? 'latest']);
    if (typeof result !== 'string' || result === '0x' || result === '') {
      throw new SyncError('INTERNAL_ERROR', `eth_call(${to}) 没有返回数据`, { to, data });
    }
    return result;
  }

  /** 当前区块高度。 */
  async blockNumber(): Promise<bigint> {
    const result = await this.call('eth_blockNumber', []);
    if (typeof result !== 'string') {
      throw new SyncError('INTERNAL_ERROR', 'eth_blockNumber 返回格式不对');
    }
    return BigInt(result);
  }
}

// --------------------------------------------------------------------------
// 读一笔仓位
// --------------------------------------------------------------------------

/** 链上事实（还没算账）。 */
export interface ChainPositionFacts {
  block: bigint;
  sqrtPriceX96: bigint;
  tick: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  amount0: bigint;
  amount1: bigint;
  fee0: bigint;
  fee1: bigint;
  owner: string;
  decimals0: number;
  decimals1: number;
  /** 池子费率（万分比；10000 = 1%）。 */
  poolFee: number | null;
}

/**
 * 读一笔 PancakeSwap V3 仓位的链上事实。
 *
 * 事实来源只有两处，且**互相校验**：
 *   * 仓位管理器的 `positions(uint256)`：tick 区间与流动性；
 *   * 池子自己的 `positions(bytes32)`：权威的流动性与手续费基准
 *     （owner 是**仓位管理器自己**，不是持币人——用持币人算 key 会查不到）。
 *
 * 两边的流动性对不上时**抛错**：那说明仓位被改动过或者链上数据不一致，
 * 此时继续算账只会得到一个看着正常的错数字。
 */
export async function readChainPosition(
  client: BscClient,
  config: ChainPositionConfig,
): Promise<ChainPositionFacts> {
  const tokenId = BigInt(config.tokenId);

  const managerPosition = decodeWords(
    await client.ethCall(
      config.positionManager,
      `${functionSelector('positions(uint256)')}${encodeUint(tokenId)}`,
    ),
  );
  if (managerPosition.length < 12) {
    throw new SyncError(
      'INTERNAL_ERROR',
      '仓位记录的字数不对（期望 12，实际 ' + String(managerPosition.length) + '）',
    );
  }
  const tickLower = decodeInt24(managerPosition[5]!);
  const tickUpper = decodeInt24(managerPosition[6]!);
  const managerLiquidity = decodeUint256(managerPosition[7]!);

  const key = positionKeyHex(config.positionManager, tickLower, tickUpper);
  const poolPosition = decodeWords(
    await client.ethCall(config.pool, `${functionSelector('positions(bytes32)')}${key}`),
  );
  if (poolPosition.length < 5) {
    throw new SyncError('INTERNAL_ERROR', '池子仓位记录的字数不对');
  }
  const liquidity = decodeUint256(poolPosition[0]!);
  if (liquidity === 0n && managerLiquidity > 0n) {
    // 仓位管理器说有流动性、池子说没有 → **key 算错了**（换了 owner 或 tick 区间）。
    // 这时返回 0 会让上层以为「仓位被清空了」，而实际上仓位好好的。
    throw new SyncError(
      'INTERNAL_ERROR',
      '池子上按算出来的 key 查不到这笔仓位（tokenId=' +
        config.tokenId +
        '，tick ' +
        String(tickLower) +
        '–' +
        String(tickUpper) +
        '）——多半是配置里的池子地址或仓位管理器地址不对',
      { tokenId: config.tokenId, tickLower, tickUpper },
    );
  }
  if (liquidity !== 0n && liquidity !== managerLiquidity) {
    throw new SyncError(
      'INTERNAL_ERROR',
      '两处记录的流动性不一致（仓位管理器与池子），链上数据对不上，不继续算账',
      { managerLiquidity: managerLiquidity.toString(), poolLiquidity: liquidity.toString() },
    );
  }
  const fg0Last = decodeUint256(poolPosition[1]!);
  const fg1Last = decodeUint256(poolPosition[2]!);
  const owed0 = decodeUint256(poolPosition[3]!);
  const owed1 = decodeUint256(poolPosition[4]!);

  const owner = decodeAddress(
    decodeWords(
      await client.ethCall(
        config.positionManager,
        `${functionSelector('ownerOf(uint256)')}${encodeUint(tokenId)}`,
      ),
    )[0]!,
  );

  const slot0 = decodeWords(await client.ethCall(config.pool, functionSelector('slot0()')));
  const sqrtPriceX96 = decodeUint256(slot0[0]!);
  const tick = decodeInt24(slot0[1]!);

  const decimals0 = Number(
    decodeUint256(
      decodeWords(await client.ethCall(config.token0, functionSelector('decimals()')))[0]!,
    ),
  );
  const decimals1 = Number(
    decodeUint256(
      decodeWords(await client.ethCall(config.token1, functionSelector('decimals()')))[0]!,
    ),
  );

  const growthGlobal0 = decodeUint256(
    decodeWords(await client.ethCall(config.pool, functionSelector('feeGrowthGlobal0X128()')))[0]!,
  );
  const growthGlobal1 = decodeUint256(
    decodeWords(await client.ethCall(config.pool, functionSelector('feeGrowthGlobal1X128()')))[0]!,
  );
  const tickLowerInfo = decodeWords(
    await client.ethCall(
      config.pool,
      `${functionSelector('ticks(int24)')}${encodeInt24(tickLower)}`,
    ),
  );
  const tickUpperInfo = decodeWords(
    await client.ethCall(
      config.pool,
      `${functionSelector('ticks(int24)')}${encodeInt24(tickUpper)}`,
    ),
  );
  const outsideLower0 = decodeUint256(tickLowerInfo[2]!);
  const outsideLower1 = decodeUint256(tickLowerInfo[3]!);
  const outsideUpper0 = decodeUint256(tickUpperInfo[2]!);
  const outsideUpper1 = decodeUint256(tickUpperInfo[3]!);

  const inside0 = feeGrowthInside(
    growthGlobal0,
    outsideLower0,
    outsideUpper0,
    tick,
    tickLower,
    tickUpper,
  );
  const inside1 = feeGrowthInside(
    growthGlobal1,
    outsideLower1,
    outsideUpper1,
    tick,
    tickLower,
    tickUpper,
  );
  const fee0 = accruedFees(liquidity, inside0, fg0Last, owed0);
  const fee1 = accruedFees(liquidity, inside1, fg1Last, owed1);

  const amounts = liquidityToAmounts(
    liquidity,
    sqrtPriceX96,
    sqrtRatioAtTick(tickLower),
    sqrtRatioAtTick(tickUpper),
  );

  let poolFee: number | null = null;
  try {
    poolFee = Number(
      decodeUint256(decodeWords(await client.ethCall(config.pool, functionSelector('fee()')))[0]!),
    );
  } catch {
    // 费率只是展示用的背景信息，读不到不算失败（不静默兜底 ≠ 无关信息也要硬失败）。
    poolFee = null;
  }

  return {
    block: await client.blockNumber(),
    sqrtPriceX96,
    tick,
    tickLower,
    tickUpper,
    liquidity,
    amount0: amounts.amount0,
    amount1: amounts.amount1,
    fee0,
    fee1,
    owner,
    decimals0,
    decimals1,
    poolFee,
  };
}
