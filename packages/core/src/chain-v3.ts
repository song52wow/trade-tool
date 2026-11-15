/**
 * 链上（BSC / PancakeSwap V3）流动性仓位的估值口径（v1.2.0）。
 *
 * ## 这一层放什么
 *
 * **只有公式，没有 IO**：不读链、不读时钟、不读配置。
 * 同一个口径要么被 `packages/data`（读链上事实）用，要么被 `apps/chain-monitor`
 * 与控制面用；口径有两份实现时，「页面显示的」与「告警里说的」就会分叉，
 * 而分叉的表现是没人知道该信哪个（AGENTS.md §5 第 4 条）。
 *
 * ## 为什么用 BigInt 而不是浮点
 *
 * 仓位流动性是 `550060234221891411106` 这种量级——超出 `Number.MAX_SAFE_INTEGER`，
 * 用浮点算会**悄悄丢掉低位**。丢掉的正是「这个仓位里到底有多少个币」，
 * 而盈亏恰恰是从这里算出来的。因此：
 *
 * * 中间量一律 `bigint`（原始单位：1e18 = 1 个币）；
 * * 只有**给人看的比率**（价格、区间边界）才转成 `number`，
 *   转换点在函数的最后一层，且转换后立刻用。
 *
 * ## 这一层为什么不做「历史价」
 *
 * BSC 的公共节点**不给查历史状态**（`eth_call` 带区块号一律 403），
 * 于是「存入那一刻的价格」拿不到。本文件的 {@link solveDepositSqrtPrice}
 * 是从**投入的币数 + 流动性 + 边界 tick 反推**出来的——这三个都是链上事实，
 * 反推出来的价格与存入时的价格一致（误差来自 Uniswap 自己取整，
 * 实测相对误差 < 1e-6）。反推不出来时**抛错**，不给一个编出来的数
 * （AGENTS.md 约定 9：不静默兜底）。
 */

/** Uniswap V3 的定点精度：sqrtPrice 以 Q96 存。 */
export const Q96 = 1n << 96n;

/** 2^256（手续费增长量的模）。 */
export const UINT256 = 1n << 256n;

/** 一个币在「原始单位」下的最小单位（18 位小数）。BSC 上 pPOLY 与 USDT 都是 18 位。 */
export const TOKEN_DECIMALS = 18;

/** 浮点转定点时用的缩放因子：把真实 sqrtPrice 放大 2^96 倍。 */
const Q96_NUMBER = 2 ** 96;

/**
 * tick → sqrtPriceX96。
 *
 * 用 `1.0001^(tick/2)` 直接算而不是 Uniswap 那套逐位查表：
 * 查表是精确的，但代价是几十行魔数；这里用双精度算，误差 ~1e-16 相对值，
 * 而相邻 tick 的间距是 1e-4——差着八个数量级，够用。
 *
 * 边界 tick 的用途（算持仓构成）对这个精度不敏感；
 * 而 `tickAtSqrtRatio` 反过来用同一个公式，两边不会打架。
 */
export function sqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick)) {
    throw new RangeError(`tick 必须是整数，收到 ${String(tick)}`);
  }
  if (tick < -887272 || tick > 887272) {
    throw new RangeError(`tick ${String(tick)} 超出可表示范围（±887272）`);
  }
  const price = Math.pow(1.0001, tick / 2);
  return BigInt(Math.floor(price * Q96_NUMBER));
}

/**
 * sqrtPriceX96 → tick。
 *
 * 池子给的 `slot0()` 自带 tick，直接用；这个函数是**没有 tick 时**的兜底
 * （例如从别的数据源拿到的价格）。
 */
export function tickAtSqrtRatio(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 <= 0n) {
    throw new RangeError(`sqrtPriceX96 必须为正，收到 ${String(sqrtPriceX96)}`);
  }
  const sqrtPrice = Number(sqrtPriceX96) / Q96_NUMBER;
  return Math.floor((2 * Math.log(sqrtPrice)) / Math.log(1.0001));
}

/**
 * 流动性 → 仓位里两个币各多少（原始单位）。
 *
 * Uniswap V3 的标准公式（白皮书 §II）：
 *
 * ```
 * 区间内（sqrtP 在 [sqrtA, sqrtB] 之间）：
 *   amount0 = L * (sqrtB - sqrtP) / (sqrtP * sqrtB)
 *   amount1 = L * (sqrtP - sqrtA)
 * 低于下界：全是 token0；高于上界：全是 token1。
 * ```
 *
 * 定点化：`sqrt*` 都是 Q96，于是
 * `amount0 = L * (sqrtB - sqrtP) * Q96 / (sqrtP * sqrtB)`。
 */
export function liquidityToAmounts(
  liquidity: bigint,
  sqrtPriceX96: bigint,
  sqrtLowerX96: bigint,
  sqrtUpperX96: bigint,
): { amount0: bigint; amount1: bigint } {
  if (liquidity < 0n) {
    throw new RangeError(`流动性不能为负，收到 ${String(liquidity)}`);
  }
  if (sqrtLowerX96 >= sqrtUpperX96) {
    throw new RangeError(
      `下界必须小于上界，收到 ${String(sqrtLowerX96)} / ${String(sqrtUpperX96)}`,
    );
  }
  if (sqrtPriceX96 <= sqrtLowerX96) {
    return {
      amount0: (liquidity * (sqrtUpperX96 - sqrtLowerX96) * Q96) / (sqrtLowerX96 * sqrtUpperX96),
      amount1: 0n,
    };
  }
  if (sqrtPriceX96 >= sqrtUpperX96) {
    return {
      amount0: 0n,
      amount1: (liquidity * (sqrtUpperX96 - sqrtLowerX96)) / Q96,
    };
  }
  return {
    amount0: (liquidity * (sqrtUpperX96 - sqrtPriceX96) * Q96) / (sqrtPriceX96 * sqrtUpperX96),
    amount1: (liquidity * (sqrtPriceX96 - sqrtLowerX96)) / Q96,
  };
}

/**
 * 区间内的手续费增长（`feeGrowthInside`）。
 *
 * 抄 Uniswap V3 的 `Tick.getFeeGrowthInside`，规则容易写反，
 * 因此在这里写死「为什么」：
 *
 * * `below` = 「下边界以下累计的手续费增长」：
 *   当前 tick **在下边界之上**时，这一块的钱属于区间**之外**，
 *   因此区间内的部分要把它**减掉** → 取下边界存下来的 outside 值；
 *   当前 tick 在下边界之下时，下边界以下的钱本来就在区间外，
 *   而 `global - outside` 才是「下边界以下」那一块 → 取 `global - outside`。
 * * `above` 同理（当前 tick 在上边界之下时取存下来的 outside，否则取 `global - outside`）。
 * * `inside = global - below - above`。
 *
 * 写反的后果是得到一个巨大的数（模 2^256 回绕），表现为「手续费有几亿亿」——
 * 2026-11-11 实测踩过：手续费被算成 1.87e59，盈亏跟着变成天文数字。
 */
export function feeGrowthInside(
  globalGrowth: bigint,
  outsideLower: bigint,
  outsideUpper: bigint,
  tick: number,
  tickLower: number,
  tickUpper: number,
): bigint {
  const below =
    tick >= tickLower ? outsideLower : (globalGrowth - outsideLower + UINT256) % UINT256;
  const above = tick < tickUpper ? outsideUpper : (globalGrowth - outsideUpper + UINT256) % UINT256;
  return (globalGrowth - below - above + UINT256) % UINT256;
}

/**
 * 本仓位累计到手的手续费（原始单位）。
 *
 * `baseline` 是仓位自己记的基准值（上次变动时的区间内增长）。
 * 基准比当前还大说明链上数据对不上（仓位被动过、基准没更新），
 * 这时**按 0 算**——让差值回绕会得到一个巨大的数，
 * 而「少算手续费」只差几分钱，「算错」会差出天文数字。
 */
export function accruedFees(
  liquidity: bigint,
  current: bigint,
  baseline: bigint,
  owed: bigint,
): bigint {
  if (current <= baseline) {
    return owed;
  }
  return (liquidity * (current - baseline)) / (1n << 128n) + owed;
}

/**
 * 从「投入了多少币」反推存入那一刻的 sqrtPriceX96。
 *
 * Uniswap 铸仓位时，流动性取两个方向算出来的**较小**值，
 * 所以两个币不一定都被用满：被卡住的那个是「用满」，
 * 另一个是「按流动性算出来该用多少」。因此两个候选都试一遍，
 * 谁能同时对上**另一个**币的数量，就用谁。
 *
 * 两个候选都对不上时抛错——那说明流动性被改过（加仓/减仓），
 * 此时拿一个「差不多」的价格去折算成本，会得到一个看着合理但错的盈亏。
 */
export function solveDepositSqrtPrice(
  liquidity: bigint,
  sqrtLowerX96: bigint,
  sqrtUpperX96: bigint,
  amount0: bigint,
  amount1: bigint,
): bigint {
  if (liquidity <= 0n) {
    throw new RangeError('流动性必须为正才能反推存入价格');
  }
  const candidates: bigint[] = [
    // amount1 用满：sqrtP = sqrtA + amount1 / L
    sqrtLowerX96 + (amount1 * Q96) / liquidity,
    // amount0 用满：amount0 = L*(sqrtB-sqrtP)*Q96/(sqrtP*sqrtB) → 解出 sqrtP
    (liquidity * sqrtUpperX96 * Q96) / (amount0 * sqrtUpperX96 + liquidity * Q96),
  ];
  for (const candidate of candidates) {
    if (candidate < sqrtLowerX96 || candidate > sqrtUpperX96) continue;
    const got = liquidityToAmounts(liquidity, candidate, sqrtLowerX96, sqrtUpperX96);
    const tolerance0 = amount0 / 1_000_000n + 1n;
    const tolerance1 = amount1 / 1_000_000n + 1n;
    const ok0 = got.amount0 <= amount0 + tolerance0 && got.amount0 >= amount0 - tolerance0;
    const ok1 = got.amount1 <= amount1 + tolerance1 && got.amount1 >= amount1 - tolerance1;
    if (ok0 && ok1) return candidate;
  }
  throw new Error('反推存入价格失败：投入数量与流动性、边界 tick 对不上（仓位可能被加仓/减仓过）');
}

/**
 * 价格：token0 用 token1 计价（BSC 上就是「多少 USDT 换一个 pPOLY」）。
 *
 * `price = (sqrtP / 2^96)^2 * 10^(decimals0 - decimals1)`。
 *
 * ⚠️ **中间不能直接做整数除法**：`sqrtP^2 / 2^192` 的整数除法会把小数部分截掉，
 * 11.84 会变成 11（实测踩过）。因此先乘一个精度因子再除，
 * 最后才转 `number`——转 `number` 之前的每一步都是精确的。
 */
export function priceFromSqrtPrice(
  sqrtPriceX96: bigint,
  decimals0: number = TOKEN_DECIMALS,
  decimals1: number = TOKEN_DECIMALS,
): number {
  const PRECISION = 1_000_000_000_000n; // 1e12，够显示 12 位小数
  const scaled = Number((sqrtPriceX96 * sqrtPriceX96 * PRECISION) / (1n << 192n));
  return (scaled / Number(PRECISION)) * Math.pow(10, decimals0 - decimals1);
}

/** tick → 价格（同样以 token1 计价 token0）。 */
export function priceFromTick(
  tick: number,
  decimals0 = TOKEN_DECIMALS,
  decimals1 = TOKEN_DECIMALS,
): number {
  return priceFromSqrtPrice(sqrtRatioAtTick(tick), decimals0, decimals1);
}

/**
 * 原始单位 → 给人看的数量（按小数位缩放）。
 *
 * `number` 只在**展示层**用；中间的账一律用 `bigint`。
 */
export function fromRaw(amount: bigint, decimals: number = TOKEN_DECIMALS): number {
  return Number(amount) / Math.pow(10, decimals);
}

/** 给人看的数量 → 原始单位（入参是字符串，避免浮点丢位）。 */
export function toRaw(amount: string | number, decimals: number = TOKEN_DECIMALS): bigint {
  const text = typeof amount === 'number' ? amount.toFixed(decimals) : amount.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new Error(`数量格式不合法：${text}`);
  }
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = text.replace('-', '').split('.');
  const padded = fraction.padEnd(decimals, '0').slice(0, decimals);
  const value = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded === '' ? '0' : padded);
  return negative ? -value : value;
}

/**
 * 一笔被监控的链上仓位（配置形态）。
 *
 * **不放具体合约名**：仓库的规矩是「标的集合是动态的、合法性由运行时元数据判定」
 * （AGENTS.md 约定 10）。这里给出的是**配置**，不是代码里的常量——
 * 同一个服务盯哪一笔仓位由配置文件说了算。
 */
export interface ChainPositionConfig {
  /** 链的标识（当前只有 `bsc`）。 */
  chain: string;
  /** 仓位管理器（PositionManager）合约地址。 */
  positionManager: string;
  /** 池子地址。 */
  pool: string;
  /** 区间内的 token0 / token1 合约地址。 */
  token0: string;
  token1: string;
  /** 仓位 NFT 的 tokenId（十进制字符串）。 */
  tokenId: string;
  /** 仓位持有人地址。 */
  owner: string;
  /** 投入时两个币的数量（**原始单位**，十进制字符串）。 */
  depositAmount0: string;
  depositAmount1: string;
  /** 投入那笔交易的哈希（给人查的，出问题时报出来有用）。 */
  depositTx?: string | undefined;
  /** 两个币的显示符号（只用于展示）。 */
  symbol0?: string | undefined;
  symbol1?: string | undefined;
}

/** 仓位在某一刻的完整状态（链上事实 + 算出来的账）。 */
export interface ChainPositionSnapshot {
  /** 区块高度（读链时的那一块）。 */
  block: bigint;
  /** token0 用 token1 计价的价格。 */
  price: number;
  /** 池子当前 tick。 */
  tick: number;
  tickLower: number;
  tickUpper: number;
  /** 区间下界 / 上界的价格。 */
  priceLower: number;
  priceUpper: number;
  /** 当前流动性。 */
  liquidity: bigint;
  /** 持仓构成（原始单位）。 */
  amount0: bigint;
  amount1: bigint;
  /** 累计未领手续费（原始单位）。 */
  fee0: bigint;
  fee1: bigint;
  /** 当前价值（计价币）。 */
  valueUsdt: number;
  /** 投入成本（计价币，按存入时的价格折算）。 */
  costUsdt: number;
  /** 已实现盈亏（计价币，加减仓时结算）。 */
  realizedUsdt: number;
  /** 浮动盈亏（计价币，含手续费）。 */
  pnlUsdt: number;
  /** 浮动盈亏百分比。 */
  pnlPct: number;
  /** 价格是否在区间内。 */
  inRange: boolean;
  /** 手续费折成计价币后的金额。 */
  feeUsdt: number;
}

/**
 * 年化收益率（APY）的观测窗口：最近 7 天。
 *
 * 为什么是 7 天：APY 是「**当前**赚多少」，而链上手续费**只在价格落在区间里时**才 accrues——
 * 拿一个月的平均去说「当前」，会在仓位昨天刚出区间时照样显示一个漂亮数字（那是骗人）。
 * 7 天是行业里常见的口径（PancakeSwap 的 7D APR），足够平滑掉单笔大额又不至于过期。
 */
export const CHAIN_APY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 短于一天的窗口**不年化**。
 *
 * 半天里恰好吃到一笔大额手续费，年化出来的数能到几千 %——那不是收益率，是噪声。
 * 这种情况给「窗口内收了多少钱」，把年化留空。
 */
export const CHAIN_APY_MIN_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * 一笔仓位的年化收益率。
 *
 * **算不出来时 `apyPct` 是 `null`，并在 `note` 里说清为什么**——
 * 不给一个编出来的数（AGENTS.md 约定 9）。
 */
export interface ChainApy {
  /** 年化收益率（**百分数**：12.34 表示 12.34%）。算不出来时为 `null`。 */
  apyPct: number | null;
  /** 观测窗口长度（毫秒）。 */
  windowMs: number;
  /** 窗口里收到的手续费（计价币）。算不出来时为 `null`。 */
  feeUsdt: number | null;
  /** 年化用的本金（投入成本，计价币）。 */
  capitalUsdt: number;
  /** 算不出来时的一句话原因（人话，页面直接显示）。能算时为 `null`。 */
  note: string | null;
}

/**
 * 算一笔仓位的年化收益率。
 *
 * ## 口径
 *
 * ```
 * APY = (窗口内收到的手续费 ÷ 投入成本) × (365 天 ÷ 窗口长度) × 100%
 * ```
 *
 * 「窗口内收到的手续费」= 窗口终点的**累计未领手续费** − 窗口起点的累计未领手续费。
 * 两者都来自链上事实（`tokensOwed`），因此这是**实际收到过**的钱，不是估算。
 *
 * ## 四种「算不出来」
 *
 * 1. **没有采样**（还没跑第一轮，或库里只有一行）→ 没有起点；
 * 2. **投入成本还没算出来**（成本为 0）→ 没有分母；
 * 3. **窗口里手续费被领取过**（终点累计额 < 起点累计额）→ 差值是负数，
 *    那不是「亏了」，而是钱被取走了；此时**不给年化**，只说明原因；
 * 4. **窗口不到一天**（`CHAIN_APY_MIN_WINDOW_MS`）→ 半天吃到一笔大额，
 *    年化出来的是噪声；此时给「窗口内收了多少钱」，年化留空。
 *
 * @param input 窗口两端的事实与本金。
 */
export function computeChainApy(input: {
  /** 窗口起点的累计未领手续费（计价币）。`null` = 没有采样。 */
  feeStartUsdt: number | null;
  /** 窗口终点（最新一次采样）的累计未领手续费（计价币）。 */
  feeNowUsdt: number | null;
  /** 窗口起点时刻（毫秒）。 */
  tsStartMs: number | null;
  /** 窗口终点时刻（毫秒）。 */
  tsNowMs: number | null;
  /** 投入成本（计价币）。 */
  capitalUsdt: number;
}): ChainApy {
  const { feeStartUsdt, feeNowUsdt, tsStartMs, tsNowMs, capitalUsdt } = input;

  const windowMs = tsStartMs === null || tsNowMs === null ? 0 : Math.max(0, tsNowMs - tsStartMs);

  if (feeStartUsdt === null || feeNowUsdt === null || tsStartMs === null || tsNowMs === null) {
    return {
      apyPct: null,
      windowMs,
      feeUsdt: null,
      capitalUsdt,
      note: '还没有采样记录，算不出年化',
    };
  }

  if (capitalUsdt <= 0) {
    return {
      apyPct: null,
      windowMs,
      feeUsdt: null,
      capitalUsdt,
      note: '投入成本还没算出来，算不出年化',
    };
  }

  if (feeNowUsdt < feeStartUsdt) {
    // 累计额变小 = 手续费在窗口里被领取了（或链上重置）。差值是负的，
    // 拿它去年化会得到一个「天塌了」的假数字——这里只说清事实。
    return {
      apyPct: null,
      windowMs,
      feeUsdt: null,
      capitalUsdt,
      note: '窗口里的手续费被领取过，年化算不出来',
    };
  }

  const feeUsdt = feeNowUsdt - feeStartUsdt;

  if (windowMs < CHAIN_APY_MIN_WINDOW_MS) {
    return {
      apyPct: null,
      windowMs,
      feeUsdt,
      capitalUsdt,
      note: '采样还不到一天，年化没有意义',
    };
  }

  const yearMs = 365 * 24 * 60 * 60 * 1000;
  const apyPct = (feeUsdt / capitalUsdt) * (yearMs / windowMs) * 100;
  return {
    apyPct,
    windowMs,
    feeUsdt,
    capitalUsdt,
    note: null,
  };
}

/**
 * 算出仓位的完整状态。
 *
 * 「链上事实」由调用方（`packages/data`）读好后传进来，这里只做算术。
 */
export function computeChainPositionSnapshot(input: {
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
  /** 投入的两个币（原始单位）。 */
  depositAmount0: bigint;
  depositAmount1: bigint;
  /** 仓位已实现盈亏（滚动记账，由调用方维护）。 */
  realizedUsdt?: number;
  /** 成本（滚动记账；不给就用投入的币按存入价格折算）。 */
  costUsdt?: number;
  decimals0?: number;
  decimals1?: number;
}): ChainPositionSnapshot {
  const decimals0 = input.decimals0 ?? TOKEN_DECIMALS;
  const decimals1 = input.decimals1 ?? TOKEN_DECIMALS;
  const sqrtLowerX96 = sqrtRatioAtTick(input.tickLower);
  const sqrtUpperX96 = sqrtRatioAtTick(input.tickUpper);
  const price = priceFromSqrtPrice(input.sqrtPriceX96, decimals0, decimals1);

  const feeUsdt = fromRaw(input.fee0, decimals0) * price + fromRaw(input.fee1, decimals1);

  let costUsdt = input.costUsdt;
  if (costUsdt === undefined) {
    const sqrtDeposit = solveDepositSqrtPrice(
      input.liquidity,
      sqrtLowerX96,
      sqrtUpperX96,
      input.depositAmount0,
      input.depositAmount1,
    );
    const priceDeposit = priceFromSqrtPrice(sqrtDeposit, decimals0, decimals1);
    costUsdt =
      fromRaw(input.depositAmount0, decimals0) * priceDeposit +
      fromRaw(input.depositAmount1, decimals1);
  }

  const realizedUsdt = input.realizedUsdt ?? 0;
  const valueUsdt = fromRaw(input.amount0, decimals0) * price + fromRaw(input.amount1, decimals1);
  const pnlUsdt = valueUsdt + feeUsdt + realizedUsdt - costUsdt;
  const pnlPct = costUsdt === 0 ? 0 : (pnlUsdt / costUsdt) * 100;

  return {
    block: input.block,
    price,
    tick: input.tick,
    tickLower: input.tickLower,
    tickUpper: input.tickUpper,
    priceLower: priceFromSqrtPrice(sqrtLowerX96, decimals0, decimals1),
    priceUpper: priceFromSqrtPrice(sqrtUpperX96, decimals0, decimals1),
    liquidity: input.liquidity,
    amount0: input.amount0,
    amount1: input.amount1,
    fee0: input.fee0,
    fee1: input.fee1,
    valueUsdt,
    costUsdt,
    realizedUsdt,
    pnlUsdt,
    pnlPct,
    inRange: input.sqrtPriceX96 > sqrtLowerX96 && input.sqrtPriceX96 < sqrtUpperX96,
    feeUsdt,
  };
}

/**
 * 加减仓时滚动成本与已实现盈亏。
 *
 * * 加仓（流动性变大）：成本加上新增部分按**当时价格**折算的金额。
 * * 减仓（流动性变小）：按比例把成本分摊出去，差额算作**已实现**盈亏——
 *   不记的话，撤仓后「赚的那几毛钱」会凭空消失，而用户看到的盈亏会突然归零。
 *
 * 返回**新的**成本与已实现盈亏；调用方负责落库。
 */
export function rollChainPositionCost(input: {
  liquidity: bigint;
  lastLiquidity: bigint | null;
  costUsdt: number;
  realizedUsdt: number;
  sqrtPriceX96: bigint;
  tickLower: number;
  tickUpper: number;
  decimals0?: number;
  decimals1?: number;
}): { costUsdt: number; realizedUsdt: number } {
  const decimals0 = input.decimals0 ?? TOKEN_DECIMALS;
  const decimals1 = input.decimals1 ?? TOKEN_DECIMALS;
  const price = priceFromSqrtPrice(input.sqrtPriceX96, decimals0, decimals1);
  let cost = input.costUsdt;
  let realized = input.realizedUsdt;

  if (input.lastLiquidity === null || input.liquidity === input.lastLiquidity) {
    return { costUsdt: cost, realizedUsdt: realized };
  }

  const delta = input.liquidity - input.lastLiquidity;
  const amounts = liquidityToAmounts(
    delta < 0n ? -delta : delta,
    input.sqrtPriceX96,
    sqrtRatioAtTick(input.tickLower),
    sqrtRatioAtTick(input.tickUpper),
  );
  const valueDelta =
    fromRaw(amounts.amount0, decimals0) * price + fromRaw(amounts.amount1, decimals1);

  if (delta > 0n) {
    cost += valueDelta;
  } else {
    const share = input.lastLiquidity === 0n ? 0 : Number(-delta) / Number(input.lastLiquidity);
    const costOut = cost * share;
    realized += valueDelta - costOut;
    cost -= costOut;
  }
  return { costUsdt: cost, realizedUsdt: realized };
}
