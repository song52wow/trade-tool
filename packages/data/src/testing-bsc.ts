/**
 * 本地假 BSC 节点——**仅供测试**（与 `testing.ts` 的假交易所同一套理由）。
 *
 * 放在 `src/` 而不是 `tests/`，是因为两处都要用：
 *   * `packages/data/tests/bsc-v3.test.ts` 验「读链」这一步；
 *   * `apps/chain-monitor/tests/service.test.ts` 验「读链 → 算账 → 落库 → 推送」整条。
 * 各自复制一份假节点只会让它们漂移。
 *
 * 它实现的是 **JSON-RPC + `eth_call` 的最小子集**，返回的十六进制**按真链的布局**拼：
 * 仓位管理器 `positions(uint256)` 12 个字、池子 `positions(bytes32)` 5 个字。
 * 布局对了，替身才验得住——布局写错时真链返回的是错位的数据，
 * 而替身按同一份错布局造数据，两者会「一起错」却看不出来。
 *
 * 不做 import 期副作用：只有显式调用 {@link startMockBscNode} 才起服务。
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { encodeInt24, encodeUint, functionSelector } from './bsc-v3.js';

/** 一笔仓位的链上状态。 */
export interface MockBscPosition {
  /** 仓位 NFT 的 tokenId（十进制字符串）。 */
  tokenId: string;
  /** 仓位持有人。 */
  owner: string;
  tickLower: number;
  tickUpper: number;
  /** 当前流动性。 */
  liquidity: bigint;
  /** 池子记的 inside 基准（`feeGrowth0Last` / `feeGrowth1Last`）。 */
  feeGrowth0Last: bigint;
  feeGrowth1Last: bigint;
  /** 已经欠着的、未领取的手续费。 */
  owed0: bigint;
  owed1: bigint;
}

/** 假节点持有的全部链上事实。 */
export interface MockBscState {
  /** 池子地址。 */
  pool: string;
  /** 仓位管理器地址。 */
  positionManager: string;
  token0: string;
  token1: string;
  position: MockBscPosition;
  /** 池子当前价格（Q96 定点）。 */
  sqrtPriceX96: bigint;
  /** 池子当前 tick。 */
  tick: number;
  decimals0: number;
  decimals1: number;
  /** 全池手续费增长。 */
  feeGrowthGlobal0: bigint;
  feeGrowthGlobal1: bigint;
  /** 边界 tick 记的区间外手续费增长。 */
  feeGrowthOutside0Lower: bigint;
  feeGrowthOutside0Upper: bigint;
  feeGrowthOutside1Lower: bigint;
  feeGrowthOutside1Upper: bigint;
  /** 池子费率（万分比）。 */
  poolFee: number;
  /** 当前区块高度。 */
  blockNumber: bigint;
  /**
   * 仓位管理器报的流动性（缺省 = `position.liquidity`）。
   *
   * 单独开这个口子是为了能造出「两处对不上」的故障——
   * 那种故障在真链上意味着 key 算错了，而代码必须把它认出来（而不是当成「仓位没了」）。
   */
  managerLiquidity?: bigint;
  /** 池子报的流动性（缺省 = `position.liquidity`）。 */
  poolLiquidity?: bigint;
}

export interface MockBscNode {
  /** 节点地址（给 `BscClient` 用）。 */
  url: string;
  /** 可变的链上事实（用例里改它来模拟「价格动了」「流动性变了」）。 */
  state: MockBscState;
  /**
   * 让接下来的调用返回 JSON-RPC 错误（模拟节点抽风）。
   *
   * 传 `null` 表示恢复正常。**默认不注入故障**——故障必须是用例自己要的，
   * 否则「这台机器今天网络不好」会让整批用例莫名其妙地红。
   */
  failWith(code: number | null, message?: string): void;
  /** 收到的调用记录（用来断言「读了几次、读的是哪个合约」）。 */
  readonly calls: { method: string; to: string | null; selector: string | null }[];
  close(): Promise<void>;
}

/** 把若干个字拼成 ABI 的返回值。 */
function words(...values: readonly bigint[]): string {
  return '0x' + values.map((value) => encodeUint(value)).join('');
}

async function readBody(request: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** 从调用数据里取出第一个参数（32 字节字）。 */
function firstWord(data: string): bigint {
  const body = data.startsWith('0x') ? data.slice(2) : data;
  return BigInt(`0x${body.slice(8, 72)}`);
}

/**
 * 起一个假 BSC 节点。
 *
 * 只实现 `readChainPosition` 用到的那几个调用；别的调用一律回 JSON-RPC 错误，
 * 而不是回一个空值——「回空值」会让上层以为「读到了 0」。
 */
export async function startMockBscNode(initial: MockBscState): Promise<MockBscNode> {
  /**
   * 用 holder 包一层，是为了让 `node.state = 新对象` 真的生效。
   *
   * 处理函数如果直接闭包捕获 `state`，用例里「整体替换 state」就换不掉它——
   * 假节点还在按老数据回话，而用例以为已经改了链上事实。
   * 症状是「改了没反应」，极难查（2026-11-11 实测踩到：
   * 价格动了、仓位清空了，两条用例都因为这个而不推）。
   */
  const holder: { state: MockBscState } = { state: initial };
  const calls: { method: string; to: string | null; selector: string | null }[] = [];
  let failure: { code: number; message: string } | null = null;

  const selectors = {
    positionsUint: functionSelector('positions(uint256)'),
    positionsBytes: functionSelector('positions(bytes32)'),
    ownerOf: functionSelector('ownerOf(uint256)'),
    slot0: functionSelector('slot0()'),
    ticks: functionSelector('ticks(int24)'),
    decimals: functionSelector('decimals()'),
    feeGrowthGlobal0: functionSelector('feeGrowthGlobal0X128()'),
    feeGrowthGlobal1: functionSelector('feeGrowthGlobal1X128()'),
    fee: functionSelector('fee()'),
  };

  function handleCall(to: string, data: string): string {
    const selector = data.slice(0, 10);
    const state = holder.state;

    if (to === state.positionManager) {
      if (selector === selectors.positionsUint) {
        const p = state.position;
        // 认不出的 tokenId 一律回**全零**：真链上不存在的仓位就是这样，
        // 而「读到一个 0」会让上层以为仓位是空的——那正是要造出来的故障形状。
        const requested = firstWord(data).toString();
        if (requested !== p.tokenId) return words(0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n);
        return words(
          0n, // nonce
          0n, // operator
          BigInt(state.token0),
          BigInt(state.token1),
          BigInt(state.poolFee),
          BigInt.asUintN(24, BigInt(p.tickLower)),
          BigInt.asUintN(24, BigInt(p.tickUpper)),
          state.managerLiquidity ?? p.liquidity,
          p.feeGrowth0Last,
          p.feeGrowth1Last,
          p.owed0,
          p.owed1,
        );
      }
      if (selector === selectors.ownerOf) {
        return words(BigInt(state.position.owner));
      }
      throw new Error(`假节点不支持的调用：positionManager.${selector}`);
    }

    if (to === state.pool) {
      if (selector === selectors.positionsBytes) {
        const p = state.position;
        return words(
          state.poolLiquidity ?? p.liquidity,
          p.feeGrowth0Last,
          p.feeGrowth1Last,
          p.owed0,
          p.owed1,
        );
      }
      if (selector === selectors.slot0) {
        return '0x' + encodeUint(state.sqrtPriceX96) + encodeInt24(state.tick);
      }
      if (selector === selectors.ticks) {
        const tick = Number(BigInt.asIntN(24, firstWord(data)));
        const isLower = tick === state.position.tickLower;
        const outside0 = isLower ? state.feeGrowthOutside0Lower : state.feeGrowthOutside0Upper;
        const outside1 = isLower ? state.feeGrowthOutside1Lower : state.feeGrowthOutside1Upper;
        // ticks(int24) 的布局：liquidityGross, liquidityNet, feeGrowthOutside0,
        // feeGrowthOutside1, tickCumulativeOutside, secondsPerLiquidityOutside, ...
        return words(0n, 0n, outside0, outside1, 0n, 0n);
      }
      if (selector === selectors.feeGrowthGlobal0) return words(state.feeGrowthGlobal0);
      if (selector === selectors.feeGrowthGlobal1) return words(state.feeGrowthGlobal1);
      if (selector === selectors.fee) return words(BigInt(state.poolFee));
      throw new Error(`假节点不支持的调用：pool.${selector}`);
    }

    if (to === state.token0) return words(BigInt(state.decimals0));
    if (to === state.token1) return words(BigInt(state.decimals1));

    throw new Error(`假节点不支持的合约：${to}`);
  }

  const server: Server = createServer((request, response) => {
    void (async () => {
      try {
        const body = await readBody(request);
        const payload = JSON.parse(body) as {
          id: unknown;
          method: string;
          params: unknown[];
        };
        const method = payload.method;
        let to: string | null = null;
        let selector: string | null = null;

        if (method === 'eth_call') {
          const params = payload.params as [{ to: string; data: string }, string];
          to = params[0].to;
          selector = params[0].data.slice(0, 10);
        }
        calls.push({ method, to, selector });

        if (failure !== null) {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: payload.id,
              error: { code: failure.code, message: failure.message },
            }),
          );
          return;
        }

        let result: unknown;
        if (method === 'eth_call') {
          const params = payload.params as [{ to: string; data: string }, string];
          result = handleCall(params[0].to, params[0].data);
        } else if (method === 'eth_blockNumber') {
          result = `0x${holder.state.blockNumber.toString(16)}`;
        } else {
          throw new Error(`假节点不支持的方法：${method}`);
        }

        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }));
      } catch (error) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32000, message: (error as Error).message },
          }),
        );
      }
    })();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    // 用 getter/setter 转发到 holder：整体替换 `node.state = …` 才会真的生效。
    get state(): MockBscState {
      return holder.state;
    },
    set state(next: MockBscState) {
      holder.state = next;
    },
    calls,
    failWith(code: number | null, message = '假节点注入的故障'): void {
      failure = code === null ? null : { code, message };
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
