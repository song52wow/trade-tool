import { useLayoutEffect, useMemo, useState, type ReactNode } from 'react';

import type { ChainApy } from '@trade-tool/core';

import { ApiError, api } from '../api.js';
import { fmtAgo, fmtNumber, fmtPriceExact, fmtTime } from '../format.js';
import { CHAIN_PATH, chainPath, navigate } from '../router.js';
import type { ChainPositionDto, ChainSnapshotDto } from '../../../src/types';

function reason(error: unknown): string {
  if (error instanceof ApiError) return `[${error.code}] ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * 代币原始数量（**1e18 = 1 个币**）→ 给人看的数量。
 *
 * **不用 `Number()` 再除**：1e18 量级的字符串转成浮点会丢掉低位，
 * 而低位正是「这个仓位里到底有多少个币」。这里在**字符串层面**挪小数点，
 * 一个字节都不丢（AGENTS.md §5 第 13 条的精神：账要准）。
 *
 * ⚠️ **只挪小数点，不改精度**：小数位超过 `maxDecimals` 时按「四舍五入到指定位数」
 * 截断显示，并在文档里说明——**账面精度不因此改变**（库里仍是原始单位）。
 * 为什么不显示全部 18 位：一个 3.8 个币的仓位会显示成
 * 「3.818850601383304894 pPOLY」，一眼看不出是 3.8；而飞书告警里同一笔显示的是
 * 「3.8189 pPOLY」——**两个出口显示同一个数却长得不一样**，看着像两笔账。
 * 显示精度取 4 位，与告警文案一致。
 *
 * ⚠️ 这个换算**只适用于代币数量**。链上的 `liquidity` 是 Uniswap V3 的
 * L 值（Q96 刻度），除以 1e18 得到的是一个**没有单位的数**——那是谎报。
 * 它走 `formatLiquidity`。
 *
 * 浏览器端**不引 core**（它的 barrel 带着 node 内置模块，打包会炸），
 * 所以这里是展示层的换算——它只影响显示，不参与任何判据。
 */
export function formatRawAmount(raw: string | null, maxDecimals = 4): string {
  if (raw === null) return '—';
  const text = raw.trim();
  if (text === '') return '—';
  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  const [intPart = '0', fracPart = ''] = body.split('.');
  // 小数点要挪 18 位；输入自带 f 位小数时，小数点还要再往右挪 f 位。
  const digits = (intPart + fracPart).padStart(19 + fracPart.length, '0');
  const cut = 18 + fracPart.length;
  const integer = digits.slice(0, digits.length - cut);
  let fraction = digits.slice(digits.length - cut);
  if (fraction.length > maxDecimals) {
    // 四舍五入：多出来的那位 ≥ 5 就进位（整数部分可能跟着 +1）。
    const roundUp = fraction.charCodeAt(maxDecimals) - 48 >= 5;
    fraction = fraction.slice(0, maxDecimals);
    if (roundUp) {
      const bumped = (BigInt(integer + fraction || '0') + 1n)
        .toString()
        .padStart(integer.length + fraction.length, '0');
      const cutAt = bumped.length - fraction.length;
      const newInteger = bumped.slice(0, cutAt);
      fraction = bumped.slice(cutAt);
      return `${negative ? '-' : ''}${newInteger.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${
        fraction === '' ? '' : `.${fraction}`
      }`;
    }
  }
  fraction = fraction.replace(/0+$/, '');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${fraction === '' ? '' : `.${fraction}`}`;
}

/**
 * 链上流动性（L 值）：**原样显示**，只加千分位。
 *
 * 它是 Uniswap V3 的 Q96 刻度整数，**不是**代币数量——
 * 除以 1e18 会得到一个没有单位的数。页面上它的用处是
 * 「这笔仓位有没有被加仓 / 减仓」，所以显示原始值就够了。
 */
export function formatLiquidity(raw: string | null): string {
  if (raw === null) return '—';
  const text = raw.trim();
  if (text === '') return '—';
  const negative = text.startsWith('-');
  const digits = (negative ? text.slice(1) : text).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${digits}`;
}

/**
 * 数量 + 代币符号。
 *
 * 没值时**只显示破折号**：写成「— pPOLY」看着像「有 0 个 pPOLY」。
 */
function fmtAmountWithSymbol(raw: string | null, symbol: string): string {
  if (raw === null || raw.trim() === '') return '—';
  return `${formatRawAmount(raw)} ${symbol}`;
}

/**
 * 盈亏百分数。
 *
 * ⚠️ `pnlPct` **已经是百分数**（`-0.25` 表示 -0.25%，与 core 的
 * `computeChainPositionSnapshot` 同口径），所以这里**不能再乘一次 100**。
 * 用 `fmtPercent` 会把它显示成 -25%，那是错了一个数量级的谎报。
 */
function fmtPnlPct(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return '—';
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

/** 金额（USDT 计价）：两位小数，带千分位。 */
function fmtUsdt(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * 金额 + 单位。
 *
 * **没值时只显示破折号，不写「— USDT」**：后者看着像「有个数，是 0」，
 * 而 0 在这个页面里会被读成「这个仓位一文不值」——那是谎报。
 */
function fmtUsdtWithUnit(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${fmtUsdt(value)} USDT`;
}

/**
 * 盈亏的配色：**正绿负红**。
 *
 * 刻意**不复用** `--chart-up` / `--chart-down`（那对是行情涨跌，中文习惯红涨绿跌）。
 * 盈亏是「赚还是亏」，红涨绿跌那套在这里会让人读反——赚的钱显示成红色。
 * 因此用语义色 `--ok` / `--err`，与全仓其它「正常 / 故障」的用法一致。
 */
function pnlColor(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'var(--muted)';
  if (value > 0) return 'var(--ok)';
  if (value < 0) return 'var(--err)';
  return 'var(--muted)';
}

/**
 * 年化收益率的显示：**一个数 + 一句口径**。
 *
 * 口径必须跟着数字一起出现——「22.31%」离开「按最近 7 天累计手续费年化」
 * 就是个来路不明的百分数，而这类数字最容易被当成「稳赚」。
 */
function fmtApy(apy: ChainApy): { value: string; hint: string } {
  if (apy.apyPct === null) {
    return { value: '—', hint: apy.note ?? '算不出来' };
  }
  const days = apy.windowMs / 86_400_000;
  return {
    value: `${apy.apyPct.toFixed(2)}%`,
    hint: `按最近 ${days.toFixed(1)} 天累计手续费年化`,
  };
}

function Card(props: { label: string; value: string; hint?: ReactNode; color?: string }) {
  return (
    <div className="card">
      <div className="label">{props.label}</div>
      <div className="value" style={props.color === undefined ? undefined : { color: props.color }}>
        {props.value}
      </div>
      {props.hint ? <div className="hint">{props.hint}</div> : null}
    </div>
  );
}

/**
 * 定价区间尺：一条从下界到上界的轨道 + 一个「现价」标记。
 *
 * **为什么它取代了走势图**：这一页要回答的是「现在在不在区间里、离边界多远」，
 * 而不是「价格走过什么路」。走势图要读两条虚线、一条价格线，还得看最右端——
 * 而价格出了区间时，两条虚线会被挤到边上甚至看不见。
 * 这把尺子只有三件事：**区间两端、现价的位置、离两边各多远**。
 *
 * ⚠️ **区间两端永远显示**：它们由 tick 决定，**不依赖采样**。
 * 还没采过样时（现价未知）只是没有标记点，区间本身照样给得出来。
 */
function RangeGauge(props: {
  lower: number;
  upper: number;
  price: number | null;
  inRange: boolean | null;
}) {
  const { lower, upper, price } = props;
  const known = price !== null && Number.isFinite(price);

  const span = upper - lower;
  const ratio = span > 0 && known ? ((price as number) - lower) / span : 0;
  const inside = known ? (props.inRange ?? (ratio >= 0 && ratio <= 1)) : null;
  const clamped = Math.min(1, Math.max(0, ratio));

  const toLower = lower === 0 || !known ? null : (((price as number) - lower) / lower) * 100;
  const toUpper = upper === 0 || !known ? null : (((price as number) - upper) / upper) * 100;
  const distance =
    toLower === null || toUpper === null
      ? ''
      : inside === true
        ? `距下界 +${toLower.toFixed(1)}% · 距上界 ${toUpper.toFixed(1)}%`
        : (price as number) < lower
          ? `低于下界 ${Math.abs(toLower).toFixed(1)}%`
          : `高于上界 +${Math.abs(toUpper).toFixed(1)}%`;

  return (
    <div className={`range-gauge${inside === false ? ' out' : ''}`}>
      <div
        className="range-track"
        role="img"
        aria-label={
          known
            ? `现价 ${fmtPriceExact(price as number)}，定价区间 ${fmtPriceExact(lower)} 到 ${fmtPriceExact(upper)}，${inside ? '区间内' : '区间外'}`
            : `定价区间 ${fmtPriceExact(lower)} 到 ${fmtPriceExact(upper)}，还没采样，不知道现价在不在区间内`
        }
      >
        <span className="range-fill" style={{ width: `${clamped * 100}%` }} />
        {known ? <span className="range-marker" style={{ left: `${clamped * 100}%` }} /> : null}
      </div>
      <div className="range-labels mono">
        <span>下界 {fmtPriceExact(lower)}</span>
        <span>上界 {fmtPriceExact(upper)}</span>
      </div>
      <p className="range-caption">
        {known ? (
          <>
            现价 {fmtPriceExact(price as number)} · <b>{inside ? '区间内' : '区间外'}</b>
            {distance === '' ? '' : ` · ${distance}`}
          </>
        ) : (
          <>还没采样，暂不知道现价在不在区间</>
        )}
      </p>
    </div>
  );
}

/**
 * 一个跳到外部站点的链接。
 *
 * 一律新标签页打开（`target="_blank"`），并且带上 `rel="noopener noreferrer"`——
 * 少了 `noopener` 时，新页面能通过 `window.opener` 操纵这一页（安全侧的常识，
 * 但漏了就是漏了）。
 */
function ChainLink(props: { href: string; children: ReactNode }) {
  return (
    <a className="chain-link" href={props.href} target="_blank" rel="noopener noreferrer">
      {props.children}
    </a>
  );
}

/**
 * 链上查看：一组跳到链上核对的地方。
 *
 * **链接由服务端算好**（`links` 字段）：浏览器端不 import `@trade-tool/core`，
 * 而链接的拼法必须只有一份实现——页面自己再拼一次，改了域名只改了一边，
 * 另一边就成了死链（而死链不会报错）。
 *
 * 一条链接都没有时（链不在已知列表里）**明说「没有外部链接」**，
 * 而不是显示一排空按钮让人以为页面坏了。
 */
function ChainLinks(props: { position: ChainPositionDto }) {
  const { links } = props.position;
  const symbol0 = props.position.symbol0 ?? '币0';
  const symbol1 = props.position.symbol1 ?? '币1';

  const explorer: { href: string; label: string }[] = [];
  if (links.explorer.position !== null) {
    explorer.push({ href: links.explorer.position, label: '仓位 NFT' });
  }
  if (links.explorer.pool !== null) {
    explorer.push({ href: links.explorer.pool, label: '池子' });
  }
  if (links.explorer.owner !== null) {
    explorer.push({ href: links.explorer.owner, label: '持有人' });
  }
  if (links.explorer.depositTx !== null) {
    explorer.push({ href: links.explorer.depositTx, label: '投入交易' });
  }
  if (links.explorer.token0 !== null) {
    explorer.push({ href: links.explorer.token0, label: symbol0 });
  }
  if (links.explorer.token1 !== null) {
    explorer.push({ href: links.explorer.token1, label: symbol1 });
  }

  const liquidity: { href: string; label: string }[] = [];
  if (links.liquidity.position !== null) {
    liquidity.push({ href: links.liquidity.position, label: '这笔仓位' });
  }
  if (links.liquidity.positions !== null) {
    liquidity.push({ href: links.liquidity.positions, label: '我的头寸' });
  }

  if (explorer.length === 0 && liquidity.length === 0) {
    return (
      <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>
        这条链没有配外部链接，链上身份看下面的「技术细节」。
      </p>
    );
  }

  return (
    <div className="chain-links">
      {explorer.length > 0 ? (
        <div className="chain-link-group">
          <span className="chain-link-title">区块浏览器</span>
          {explorer.map((item) => (
            <ChainLink key={item.href} href={item.href}>
              {item.label}
            </ChainLink>
          ))}
        </div>
      ) : null}
      {liquidity.length > 0 ? (
        <div className="chain-link-group">
          <span className="chain-link-title">流动性平台</span>
          {liquidity.map((item) => (
            <ChainLink key={item.href} href={item.href}>
              {item.label}
            </ChainLink>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 采样明细：**每一次采样记一行**，用表格（田字格）摆出来。
 *
 * ## 为什么是表格而不是曲线
 *
 * 区间尺已经回答了「现在在不在区间里」，而采样明细回答的是另一个问题：
 * **这一路是怎么走过来的**——什么时候出的区间、手续费从哪一刻开始涨、
 * 价值在哪个点上最高过。这些是**离散的事实**（每 15 分钟一次），
 * 表格比曲线诚实：曲线会连出一条**从来没发生过**的中间过程。
 *
 * ## 为什么倒序（最新的在最上面）
 *
 * 采样是 15 分钟一轮，跑上几周就是几百行。从最下面往上翻最费劲，
 * 所以最新的排最前；想看更早的往下滚。
 *
 * ⚠️ **只显示前 100 条**：全量倒进 DOM 会让这一页明显变慢，
 * 而多出来的那些行几乎没人会翻到。总数照实写出来，不假装只有这些。
 */
function ChainSnapshotTable(props: { positionKey: string; tick: number }) {
  const [rows, setRows] = useState<ChainSnapshotDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useLayoutEffect(() => {
    let cancelled = false;
    void api
      .chainSnapshots(props.positionKey, 500)
      .then((items) => {
        if (cancelled) return;
        setRows(items);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(reason(e));
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
    // 与仓位列表同一个刷新节奏（15 秒一轮）：采样 15 分钟才多一行，
    // 跟着 5s 刷只是把同一批行反复读一遍。
  }, [props.positionKey, Math.floor(props.tick / 3)]);

  const shown = useMemo(() => {
    if (rows === null) return [];
    return [...rows].reverse().slice(0, 100);
  }, [rows]);

  const total = rows?.length ?? 0;

  return (
    <div className="chain-snap-table">
      {error !== null ? (
        <div className="banner">
          读取采样明细失败：{error}
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            上面的数字（当前价值、盈亏、APY）来自**上一次成功的采样**，不受影响。
          </div>
        </div>
      ) : null}

      {!loaded ? <p className="muted">正在读取采样明细…</p> : null}

      {loaded && error === null && total === 0 ? (
        <p className="muted">还没有采样记录（监控服务跑起来之后才会有）。</p>
      ) : null}

      {shown.length > 0 ? (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>采样时间</th>
                  <th>现价</th>
                  <th>区间</th>
                  <th>当前价值</th>
                  <th>浮动盈亏</th>
                  <th>累计手续费</th>
                  <th>区块高度</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => (
                  <tr key={row.ts}>
                    <td className="mono">{fmtTime(row.ts)}</td>
                    <td className="mono">{fmtPriceExact(row.price)}</td>
                    <td>
                      {row.inRange ? (
                        <span className="tag ok">区间内</span>
                      ) : (
                        <span className="tag warn">区间外</span>
                      )}
                    </td>
                    <td className="mono">{fmtUsdtWithUnit(row.valueUsdt)}</td>
                    <td className="mono" style={{ color: pnlColor(row.pnlUsdt) }}>
                      {fmtUsdtWithUnit(row.pnlUsdt)}
                      <span className="muted"> {fmtPnlPct(row.pnlPct)}</span>
                    </td>
                    <td className="mono">{fmtUsdtWithUnit(row.feeUsdt)}</td>
                    <td className="mono muted">{row.block}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
            共 {fmtNumber(total)} 条采样，这里按时间倒序显示最近 {fmtNumber(shown.length)} 条。
          </p>
        </>
      ) : null}
    </div>
  );
}

/**
 * 一句话结论：把「在不在区间」「赚了还是亏了」串成人话。
 *
 * 这一页原来把同样的信息分散在四张卡、一张图和一张表里，读者得自己拼。
 * 结论句不引入任何新数据——它只是把已有的三个数（区间状态、盈亏、成本）
 * 按人的阅读顺序说出来。
 */
function describeVerdict(position: ChainPositionDto): string {
  const where =
    position.inRange === null
      ? '还没采样过，暂时不知道价格在不在区间'
      : position.inRange
        ? '价格在定价区间内，仓位在赚手续费'
        : '价格已出定价区间——只剩一种币，暂时不赚手续费';

  if (position.pnlUsdt === null || !Number.isFinite(position.pnlUsdt)) {
    return `${where}。`;
  }
  const sign = position.pnlUsdt >= 0 ? '浮盈' : '浮亏';
  const fee =
    position.feeUsdt === null || !Number.isFinite(position.feeUsdt)
      ? ''
      : `；已赚手续费 ${fmtUsdtWithUnit(position.feeUsdt)}（未领取）`;
  // 年化只在**算得出来**时出现：算不出来时那句「采样还不到一天」放在指标卡里，
  // 不塞进结论句（结论句是给人一句话结论的，不是失败清单）。
  const apy = position.apy.apyPct === null ? '' : `；年化 ${position.apy.apyPct.toFixed(2)}%`;
  return (
    `${where}；当前${sign} ${fmtUsdt(Math.abs(position.pnlUsdt))} USDT` +
    `（${fmtPnlPct(position.pnlPct)}），成本 ${fmtUsdtWithUnit(position.costUsdt)}${fee}${apy}。`
  );
}

/**
 * 一笔仓位的**卡片**（列表页用）。
 *
 * 卡片要能一眼看出重点：现在值多少、赚没赚、价格在不在区间、年化多少。
 * 所以尺子（区间尺）直接放在卡里——**不用点进去**就知道价格离边界多远。
 *
 * 整张卡是一个 `<a>`：点哪都行，而且能中键开新标签、能复制链接
 * （详情是**一条路由**，不是组件内部状态）。
 */
function ChainPositionCard(props: { position: ChainPositionDto; now: number }) {
  const { position, now } = props;
  const symbol0 = position.symbol0 ?? '币0';
  const symbol1 = position.symbol1 ?? '币1';
  const apy = fmtApy(position.apy);
  const href = chainPath(position.positionKey);

  return (
    <a
      className="chain-card"
      href={href}
      onClick={(e) => {
        // 自己导航：hash 路由里 `navigate` 会**同步**通知订阅者，
        // 而直接改 location.hash 要等异步的 hashchange 事件——那会白闪一帧旧内容。
        // `preventDefault` 只拦这一次点击，中键 / 右键复制链接不受影响。
        e.preventDefault();
        navigate(href);
      }}
    >
      <div className="chain-card-head">
        <span className="chain-card-title">
          {symbol0} / {symbol1}
        </span>
        {position.inRange === null ? (
          <span className="tag muted">尚未采样</span>
        ) : position.inRange ? (
          <span className="tag ok">区间内</span>
        ) : (
          <span className="tag warn">区间外</span>
        )}
      </div>
      <div className="chain-card-sub mono">
        #{position.tokenId} · {position.chain}
      </div>

      <div className="chain-card-nums">
        <div>
          <div className="label">当前价值</div>
          <div className="value">{fmtUsdtWithUnit(position.valueUsdt)}</div>
        </div>
        <div>
          <div className="label">浮动盈亏</div>
          <div className="value" style={{ color: pnlColor(position.pnlUsdt) }}>
            {fmtUsdtWithUnit(position.pnlUsdt)}
          </div>
          <div className="hint">{fmtPnlPct(position.pnlPct)}</div>
        </div>
      </div>

      <RangeGauge
        lower={position.priceLower}
        upper={position.priceUpper}
        price={position.price}
        inRange={position.inRange}
      />

      <div className="chain-card-rows">
        <div className="chain-card-row">
          <span className="muted">现价</span>
          <span className="mono">{fmtPriceExact(position.price)}</span>
        </div>
        <div className="chain-card-row">
          <span className="muted">已赚手续费</span>
          <span className="mono">
            {position.feeUsdt === null || !Number.isFinite(position.feeUsdt)
              ? '—'
              : `+${fmtUsdtWithUnit(position.feeUsdt)}`}
          </span>
        </div>
        <div className="chain-card-row">
          <span className="muted">当前 APY</span>
          <span className="mono">{apy.value}</span>
        </div>
        <div className="chain-card-row">
          <span className="muted">上次采样</span>
          <span className="mono">
            {position.lastPollAt === null ? '从未' : fmtAgo(position.lastPollAt, now)}
          </span>
        </div>
      </div>

      <p className="chain-card-hint muted">{apy.hint}</p>
    </a>
  );
}

/**
 * 一笔链上仓位的明细。
 *
 * 数据全部来自**本地库**（链上事实由 `apps/chain-monitor` 读链后落库），
 * 因此这个面板是纯读、可以跟着页面的刷新节奏走。
 *
 * ## 详情页只给四块（2026-11-14 简化）
 *
 * 1. **是什么仓位、现在值多少、赚了还是亏了**（结论句 + 指标卡）；
 * 2. **定价区间**（下界 / 上界 / 现价在哪儿 / 离边界多远）；
 * 3. **链上查看**（区块浏览器 / 流动性平台的跳转）；
 * 4. **技术细节**（收起：地址、仓位键、L 值……）。
 *
 * ⚠️ **不再画走势图，也不再列采样明细**：这两样把一页变成了流水账，
 * 而这一页真正要回答的是「现在在不在区间里、赚没赚、去链上看哪里」。
 * 采样**照旧落库**（`chain_position_snapshot`），只是不再摆到页面上。
 */
function ChainPositionDetail(props: { position: ChainPositionDto; now: number; tick: number }) {
  const { position, now } = props;

  const symbol0 = position.symbol0 ?? '币0';
  const symbol1 = position.symbol1 ?? '币1';
  const apy = fmtApy(position.apy);

  return (
    <>
      {/*
        顶部只回答三个问题：**这是什么仓位、现在值多少、赚了还是亏了**。
        持有人地址 / 仓位键 / 投入交易 / L 值这些排障信息全部收进底部的
        「技术细节」——摆在这里会把真正要看的数字挤到第二屏。
      */}
      <div className="panel">
        <div className="chain-head">
          <h2>
            {symbol0} / {symbol1}
            <span className="tag muted">#{position.tokenId}</span>
            <span className="tag muted">{position.chain}</span>
            {position.inRange === null ? (
              <span className="tag muted">尚未采样</span>
            ) : position.inRange ? (
              <span className="tag ok">区间内</span>
            ) : (
              <span className="tag warn">区间外</span>
            )}
          </h2>
          <span className="muted chain-stamp">
            {position.lastPollAt === null
              ? '还没采样过'
              : `上次采样 ${fmtAgo(position.lastPollAt, now)}`}
          </span>
        </div>

        {/* 回列表：卡片列表是入口，详情是钻进去看的那一层，得给一条回去的路。 */}
        <button className="chain-back" onClick={() => navigate('#/chain')}>
          ← 返回仓位列表
        </button>

        {/* 一句话结论：把「区间」「盈亏」「成本」串成人话，不用自己去对四张卡。 */}
        <p className="chain-verdict">{describeVerdict(position)}</p>

        {position.lastError !== null ? (
          <div className="banner">
            最后一次采样失败：{position.lastError}
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              上面的数字来自<b>上一次成功的采样</b>，不是现在的链上状态。
            </div>
          </div>
        ) : null}

        <div className="cards">
          <Card
            label="当前价值"
            value={fmtUsdtWithUnit(position.valueUsdt)}
            hint="两个币按现价折算"
          />
          <Card
            label="浮动盈亏"
            value={fmtUsdtWithUnit(position.pnlUsdt)}
            hint={
              <>
                <span>{fmtPnlPct(position.pnlPct)}</span> · 成本{' '}
                {fmtUsdtWithUnit(position.costUsdt)}
              </>
            }
            color={pnlColor(position.pnlUsdt)}
          />
          <Card
            label="已赚手续费"
            value={
              position.feeUsdt === null || !Number.isFinite(position.feeUsdt)
                ? '—'
                : `+${fmtUsdtWithUnit(position.feeUsdt)}`
            }
            hint="未领取 · 已计入浮动盈亏"
            color={position.feeUsdt !== null && position.feeUsdt > 0 ? 'var(--ok)' : 'var(--muted)'}
          />
          <Card
            label="现价"
            value={fmtPriceExact(position.price)}
            hint={`区间 ${fmtPriceExact(position.priceLower)} ~ ${fmtPriceExact(position.priceUpper)}`}
          />
          {/*
            年化：**数字与口径必须同时出现**。
            「22.31%」离开「按最近 7 天累计手续费年化」就是个来路不明的百分数，
            而这类数字最容易被当成「稳赚」。
          */}
          <Card
            label="当前 APY"
            value={apy.value}
            hint={apy.hint}
            color={
              position.apy.apyPct !== null && position.apy.apyPct > 0 ? 'var(--ok)' : 'var(--muted)'
            }
          />
          <Card
            label="当前持仓"
            value={fmtAmountWithSymbol(position.amount0, symbol0)}
            hint={fmtAmountWithSymbol(position.amount1, symbol1)}
          />
        </div>
      </div>

      {/*
        定价区间：这一页最该先看清的一块。
        标题旁直接回答「现在在不在区间里」，尺子上再给出下界 / 上界 / 离边界多远。
      */}
      <div className="panel">
        <div className="chain-head">
          <h2>定价区间</h2>
          {position.inRange === null ? (
            <span className="tag muted">尚未采样</span>
          ) : position.inRange ? (
            <span className="tag ok">现在在区间内</span>
          ) : (
            <span className="tag warn">现在在区间外</span>
          )}
        </div>
        <RangeGauge
          lower={position.priceLower}
          upper={position.priceUpper}
          price={position.price}
          inRange={position.inRange}
        />
        <p className="muted" style={{ fontSize: 12, margin: '2px 0 0' }}>
          区间内才有手续费；价格出了区间，仓位就只剩一种币，先不赚手续费。
        </p>
      </div>

      {/*
        采样明细：**每一次采样记一行**（表格）。
        它回答的是「这一路是怎么走过来的」——什么时候出的区间、手续费从哪一刻开始涨。
        与上面的「区间尺」分工明确：尺子讲现在，这张表讲历史。
      */}
      <div className="panel">
        <div className="chain-head">
          <h2>采样明细</h2>
          <span className="muted chain-stamp">每 15 分钟一次</span>
        </div>
        <ChainSnapshotTable positionKey={position.positionKey} tick={props.tick} />
      </div>

      {/*
        链上查看：一眼跳到能核对的地方。
        页面显示的账是**本地算的**，链上那一页才是「原始事实」——
        两者对不上时，只有链上说得清。
      */}
      <div className="panel">
        <div className="chain-head">
          <h2>链上查看</h2>
          <span className="muted chain-stamp">新标签页打开</span>
        </div>
        <ChainLinks position={position} />
      </div>

      {/*
        技术细节：只有排障 / 核对链上身份时才需要。
        地址**完整显示**不截断——它是「这笔仓位是谁的」的唯一凭据。
      */}
      <details className="panel">
        <summary className="chain-summary">技术细节</summary>
        <dl className="kv">
          <dt>持有人</dt>
          <dd className="mono" style={{ wordBreak: 'break-all' }}>
            {position.owner}
          </dd>
          <dt>池子</dt>
          <dd className="mono" style={{ wordBreak: 'break-all' }}>
            {position.pool}
          </dd>
          <dt>仓位管理器</dt>
          <dd className="mono" style={{ wordBreak: 'break-all' }}>
            {position.positionManager}
          </dd>
          <dt>仓位键</dt>
          <dd className="mono" style={{ wordBreak: 'break-all' }}>
            {position.positionKey}
          </dd>
          <dt>投入交易</dt>
          <dd className="mono" style={{ wordBreak: 'break-all' }}>
            {position.depositTx ?? '—'}
          </dd>
          <dt>累计手续费</dt>
          <dd className="mono">{fmtUsdtWithUnit(position.feeUsdt)}</dd>
          <dt>已实现盈亏</dt>
          <dd className="mono" style={{ color: pnlColor(position.realizedUsdt) }}>
            {fmtUsdtWithUnit(position.realizedUsdt)}
          </dd>
          <dt>流动性（链上 L 值）</dt>
          <dd className="mono">{formatLiquidity(position.liquidity)}</dd>
          <dt>上次轮询</dt>
          <dd className="mono">
            {position.lastPollAt === null
              ? '从未'
              : `${fmtTime(position.lastPollAt)}（${fmtAgo(position.lastPollAt, now)}）`}
          </dd>
          <dt>最后一次告警</dt>
          <dd className="mono">
            {position.lastAlertAt === null
              ? '从未'
              : `${fmtTime(position.lastAlertAt)}（${fmtAgo(position.lastAlertAt, now)}）`}
          </dd>
        </dl>
      </details>
    </>
  );
}

/**
 * 链上仓位页面（`#/chain` 列表 / `#/chain/<仓位键>` 详情）。
 *
 * 显示 BSC 上 PancakeSwap V3 流动性仓位的当前盈亏、定价区间、APY 与链上链接。
 *
 * **列表是卡片，点了才进详情**：卡片上直接给出重点（值多少、赚没赚、
 * 价格在不在区间、年化多少），详情是钻进去看细的那一层。
 * 选中哪一笔是**路由**（`#/chain/<仓位键>`），不是组件状态——
 * 于是浏览器的前进/后退、中键新标签、复制链接都天然可用。
 *
 * **取数用 `useLayoutEffect` 而不是 `useEffect`**：这张页面**可以是首屏**
 * （直接粘地址栏进来）。effect 里抛出的异常会中止同一次 commit 里剩下的
 * 全部 effect——这一页的子树里现在没有图表了，但同一个坑记着，
 * 别在它下面再加会抛异常的副作用（`SymbolPage` 里记着同一个坑）。
 */
export function ChainPositionPanel(props: {
  tick: number;
  now: number;
  /** 要看哪一笔的详情；`null` = 显示卡片列表。 */
  positionKey: string | null;
}) {
  const [positions, setPositions] = useState<ChainPositionDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    let cancelled = false;
    void api
      .chainPositions()
      .then((items) => {
        if (cancelled) return;
        setPositions(items);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(reason(e));
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
    // 同上：链上采样是 15 分钟一轮的，跟着全局 5s 刷只会重复读同一批行。
  }, [Math.floor(props.tick / 3)]);

  const selected = useMemo(() => {
    if (props.positionKey === null) return null;
    return positions.find((p) => p.positionKey === props.positionKey) ?? null;
  }, [positions, props.positionKey]);

  /**
   * 读取失败时**保留上一次的数据**，只在上面压一条常驻横幅。
   *
   * 原来这里是整页 `return`：一次抖动就把已经加载出来的曲线、采样表与服务状态
   * 全部丢掉，换成一句错误——而同一页的其它面板（K 线、止盈止损、对账、Agent）
   * 都是「保留旧数据 + 注明是旧的」。同一个页面不该有两种失败口径。
   */
  const banner =
    error === null ? null : (
      <div className="banner">
        读取链上仓位失败：{error}
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          {positions.length > 0
            ? '下面是上一次成功读到的数据，不是现在的链上状态。每 5s 自动重试。'
            : '每 5s 自动重试；点「立即刷新」可立刻重试。'}
        </div>
      </div>
    );

  if (!loaded) {
    return (
      <>
        {banner}
        <p className="muted">正在读取链上仓位…</p>
      </>
    );
  }

  if (positions.length === 0) {
    return (
      <>
        {banner}
        {error !== null ? (
          // 读失败时**不能**显示「尚未配置」：库里到底有没有配置，这一刻谁也不知道。
          <p className="muted">还没读到任何仓位（上一次读取失败）。</p>
        ) : (
          // 「没配置」是**正常状态**，不是错误——页面要说清楚下一步该做什么，
          // 而不是显示一片空白（那会让人以为页面坏了）。
          <div className="panel">
            <h2>链上仓位</h2>
            <p className="muted">尚未配置链上仓位。</p>
            <p className="hint">
              在配置文件里登记要监控的 PancakeSwap V3 仓位（<code>chain.positions</code>）， 再启动{' '}
              <code>apps/chain-monitor</code>——它负责读链、算账、落库并推送告警。
            </p>
          </div>
        )}
      </>
    );
  }

  // 详情：路由给了仓位键，但库里没有这一笔（配置删了 / 库被清了）。
  if (props.positionKey !== null) {
    return (
      <>
        {banner}
        {selected === null ? (
          <div className="panel">
            <h2>找不到这笔仓位</h2>
            <p className="muted">
              它已经不在库里了（配置删掉了，或者库被清过）。回列表看看还有哪些仓位。
            </p>
            <button className="chain-back" onClick={() => navigate(CHAIN_PATH)}>
              ← 返回仓位列表
            </button>
          </div>
        ) : (
          <ChainPositionDetail position={selected} now={props.now} tick={props.tick} />
        )}
      </>
    );
  }

  // 列表：一堆卡片，每张卡自己就是「重点信息」。
  return (
    <>
      {banner}
      <div className="panel">
        <div className="chain-head">
          <h2>链上仓位</h2>
          <span className="muted chain-stamp">
            共 {fmtNumber(positions.length)} 笔 · 点卡片看详情
          </span>
        </div>
        <div className="chain-card-grid">
          {positions.map((p) => (
            <ChainPositionCard key={p.positionKey} position={p} now={props.now} />
          ))}
        </div>
      </div>
    </>
  );
}
