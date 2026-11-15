/**
 * 链上仓位的**外部链接**（区块浏览器 / 流动性平台）（v1.2.0）。
 *
 * ## 这一层放什么
 *
 * **只有拼 URL，没有 IO**：不读链、不读时钟、不读配置。
 * 链接的拼法只有这一份实现——控制面页面与飞书告警都从这里取，
 * 两处各拼一次的话，改了域名只改了一边，另一边就成了死链（§5 第 4 条）。
 *
 * ## 为什么链接在服务端算好再给页面
 *
 * 页面**不能 import `@trade-tool/core` 的运行时**（它的 barrel 带着
 * `node:crypto` / `node:fs`，浏览器打包会炸）。于是链接由控制面服务端算好，
 * 放进 DTO 里给页面直接用——页面只负责把 URL 放进 `href`，
 * **不自己拼第二份**（与 `ui/src/components/gaps.ts` 同一思路：浏览器端只做展示）。
 *
 * ## 不认识的链怎么办
 *
 * **不给链接**（全部为 `null`），而不是猜一个域名。
 * 猜出来的地址看着能用，点进去却是别的链——那是**谎报**（§5 约定 9）。
 * 页面看到没有链接，就只显示地址本身。
 */

/** 区块浏览器里能落到的几个地方。 */
export interface ChainExplorerLinks {
  /** 池子合约。 */
  pool: string | null;
  /** 仓位 NFT（ERC-721 的那一张）。 */
  position: string | null;
  /** 仓位持有人地址。 */
  owner: string | null;
  /** 投入那笔交易。 */
  depositTx: string | null;
  /** 区间里的 token0 合约。 */
  token0: string | null;
  /** 区间里的 token1 合约。 */
  token1: string | null;
}

/** 流动性平台里能落到的几个地方。 */
export interface ChainLiquidityLinks {
  /** 这一笔仓位的详情页（能看区间、能领手续费）。 */
  position: string | null;
  /** 「我的头寸」总览页。 */
  positions: string | null;
}

/** 一笔仓位的全部外部链接。 */
export interface ChainPositionLinks {
  /** 区块浏览器（BscScan 之类）。 */
  explorer: ChainExplorerLinks;
  /** 流动性平台（PancakeSwap 之类）。 */
  liquidity: ChainLiquidityLinks;
}

/**
 * 每条链的外部站点。
 *
 * `liquidityChain` / `network` 是**平台自己的链标识**（跟我们的 `chain` 字段
 * 不是一回事）：PancakeSwap 的仓位页要 `?chain=bsc`，总览页要 `?network=56`。
 */
interface ChainSites {
  /** 区块浏览器基址。 */
  explorer: string;
  /** 流动性平台基址。 */
  liquidity: string;
  /** 平台自己的链标识（用于 `?chain=`）。 */
  liquidityChain: string;
  /** 平台的网络号（用于 `?network=`）。 */
  network: string;
}

/**
 * 目前只认 BSC。
 *
 * ⚠️ **加一条链时，链接的形态要自己验一遍**（用真实地址点开）——
 * 平台改路由时这里是唯一会悄悄变成死链的地方，而死链不会报错。
 */
const CHAIN_SITES: Record<string, ChainSites> = {
  bsc: {
    explorer: 'https://bscscan.com',
    liquidity: 'https://pancakeswap.finance',
    liquidityChain: 'bsc',
    network: '56',
  },
};

/** 空字符串与空白一律当成「没有」——那不是能打开的地址。 */
function usable(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = value.trim();
  return text === '' ? null : text;
}

/**
 * 拼出一笔仓位的外部链接。
 *
 * **缺的字段只让那一条链接为 `null`**，其余照常给——
 * 「没有投入交易哈希」不该连池子链接也一起没了。
 *
 * @param input 链上身份：链、池子、仓位管理器、tokenId、持有人……
 */
export function buildChainPositionLinks(input: {
  /** 链标识（当前只有 `bsc`）。 */
  chain: string;
  /** 池子合约地址。 */
  pool?: string | null | undefined;
  /** 仓位管理器（PositionManager）合约地址。 */
  positionManager?: string | null | undefined;
  /** 仓位 NFT 的 tokenId（十进制字符串）。 */
  tokenId?: string | null | undefined;
  /** 仓位持有人地址。 */
  owner?: string | null | undefined;
  /** 投入那笔交易的哈希。 */
  depositTx?: string | null | undefined;
  /** token0 合约地址。 */
  token0?: string | null | undefined;
  /** token1 合约地址。 */
  token1?: string | null | undefined;
}): ChainPositionLinks {
  const sites = CHAIN_SITES[input.chain.trim().toLowerCase()];
  if (sites === undefined) {
    // 不认识的链：**一条都不给**。给一个猜出来的域名比不给更坏。
    return {
      explorer: {
        pool: null,
        position: null,
        owner: null,
        depositTx: null,
        token0: null,
        token1: null,
      },
      liquidity: { position: null, positions: null },
    };
  }

  const pool = usable(input.pool);
  const positionManager = usable(input.positionManager);
  const tokenId = usable(input.tokenId);
  const owner = usable(input.owner);
  const depositTx = usable(input.depositTx);
  const token0 = usable(input.token0);
  const token1 = usable(input.token1);

  return {
    explorer: {
      pool: pool === null ? null : `${sites.explorer}/address/${pool}`,
      // 仓位 NFT：区块浏览器的 NFT 页按「合约 + tokenId」定位。
      position:
        positionManager === null || tokenId === null
          ? null
          : `${sites.explorer}/nft/${positionManager}/${tokenId}`,
      owner: owner === null ? null : `${sites.explorer}/address/${owner}`,
      depositTx: depositTx === null ? null : `${sites.explorer}/tx/${depositTx}`,
      token0: token0 === null ? null : `${sites.explorer}/token/${token0}`,
      token1: token1 === null ? null : `${sites.explorer}/token/${token1}`,
    },
    liquidity: {
      position:
        tokenId === null
          ? null
          : `${sites.liquidity}/liquidity/${tokenId}?chain=${sites.liquidityChain}`,
      positions: `${sites.liquidity}/liquidity/positions?network=${sites.network}`,
    },
  };
}
