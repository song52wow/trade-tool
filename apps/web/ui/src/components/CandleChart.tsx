import { useLayoutEffect, useRef, useState } from 'react';

import type { BarDto } from '../../../src/types';
import { describeSpan, gapStats } from './gaps.js';

// 缺口统计住在 gaps.ts（纯计算，1m 与派生周期共用），这里转出以保持
// `CandleChart` 作为「图表相关」的单一入口——既有测试与调用方都从这里取。
export { gapStats, describeSpan, minutesToBars } from './gaps.js';
export type { GapStats } from './gaps.js';

/**
 * K 线（蜡烛图）。手写 SVG，不套 recharts。
 *
 * 为什么不用图表库：库给的是「按序排列的一串 OHLC」，而这个页面真正要回答的问题是
 * **「同步下来的数据长什么样、哪里是空的」**。横轴必须按**时间**而不是按序号排布——
 * 按序号排会把缺口悄悄抹平，一段 3 天的空洞会显示成连续下跌，那是骗人的界面（R-4.4
 * 的同一个道理：缺的东西要看得见）。缺口统计因此直接写在图下方，不藏进 tooltip。
 *
 * 桶宽 ``barMs`` 是**必填**：v0.2.0 起周期可以是 15m / 1h / 4h / 1d，
 * 写死 60_000 会让「缺一根 4h」被当成「缺一分钟」。
 */
export const DEFAULT_BAR_MS = 60_000;

/**
 * 红涨绿跌。
 *
 * 刻意**不**复用状态色（--ok/--err）：那套是「正常 / 故障」，这里说的是行情方向。
 * 中文用户的直觉是红涨绿跌，海外是绿涨红跌，方向颜色在图例里写明，不靠猜。
 */
const UP = '#f85149';
const DOWN = '#3fb950';
const GRID = '#2a2f3a';
const AXIS = '#9aa3b2';
const GAP_FILL = '#2a2f3a';

const DEFAULT_WIDTH = 900;
const HEIGHT = 300;
const PAD_LEFT = 64;
/**
 * 右边距要放得下「最新价」标签。
 *
 * 标签画在绘图区**外面**的右侧留白里：画在里面就会压住最后几根蜡烛——那几根恰好是
 * 用户最想看清的。
 */
const PAD_RIGHT = 46;
const PAD_TOP = 10;
const AXIS_H = 20;
/** 成交量面板占绘图区的比例；剩下的给价格。 */
const VOL_RATIO = 0.24;
const VOL_GAP = 12;
const MIN_BODY = 1;
const MAX_BODY = 10;

export interface CandleLayout {
  width: number;
  plotLeft: number;
  plotWidth: number;
  priceTop: number;
  priceHeight: number;
  volTop: number;
  volHeight: number;
  t0: number;
  t1: number;
  lo: number;
  hi: number;
  maxVolume: number;
  /** 一分钟占多少像素 */
  slot: number;
  bodyWidth: number;
}

function extent(bars: readonly BarDto[]): { lo: number; hi: number; maxVolume: number } {
  let lo = Infinity;
  let hi = -Infinity;
  let maxVolume = 0;
  for (const bar of bars) {
    if (bar.low < lo) lo = bar.low;
    if (bar.high > hi) hi = bar.high;
    if (bar.volume > maxVolume) maxVolume = bar.volume;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: 0, hi: 1, maxVolume: 0 };
  // 全平的价格（lo === hi）会让除零，画出一条不存在的线；按比例撑开一点点。
  if (hi === lo) {
    const pad = Math.max(Math.abs(hi) * 0.001, 1e-8);
    return { lo: hi - pad, hi: hi + pad, maxVolume };
  }
  return { lo, hi, maxVolume };
}

/** 纯计算：像素布局。抽出来是为了能脱离 DOM 断言坐标与空值分支。 */
export function layoutCandles(
  bars: readonly BarDto[],
  width: number,
  height: number = HEIGHT,
  barMs: number = DEFAULT_BAR_MS,
): CandleLayout {
  const plotLeft = PAD_LEFT;
  const plotWidth = Math.max(1, width - PAD_LEFT - PAD_RIGHT);
  const inner = Math.max(60, height - PAD_TOP - AXIS_H);
  const priceHeight = Math.max(20, Math.round(inner * (1 - VOL_RATIO)) - Math.floor(VOL_GAP / 2));
  const volHeight = Math.max(16, Math.round(inner * VOL_RATIO) - Math.floor(VOL_GAP / 2));
  const priceTop = PAD_TOP;
  const volTop = priceTop + priceHeight + VOL_GAP;

  const first = bars[0]?.time ?? 0;
  const last = bars[bars.length - 1]?.time ?? first;
  // 单根 bar（或全平价）也要有非零跨度，否则横轴除零、图直接消失。
  const t1 = last > first ? last : first + barMs;
  const { lo, hi, maxVolume } = extent(bars);
  const slot = plotWidth / ((t1 - first) / barMs + 1);

  return {
    width,
    plotLeft,
    plotWidth,
    priceTop,
    priceHeight,
    volTop,
    volHeight,
    t0: first,
    t1,
    lo,
    hi,
    maxVolume,
    slot,
    bodyWidth: Math.max(MIN_BODY, Math.min(MAX_BODY, Math.floor(slot * 0.7))),
  };
}

export function xOf(layout: CandleLayout, time: number): number {
  return layout.plotLeft + ((time - layout.t0) / (layout.t1 - layout.t0)) * layout.plotWidth;
}

export function yOf(layout: CandleLayout, price: number): number {
  return layout.priceTop + ((layout.hi - price) / (layout.hi - layout.lo)) * layout.priceHeight;
}

/** 轴刻度取 1/2/5×10ⁿ 的「好看」步长，避免出现 0.0037 这种刻度。 */
function niceStep(raw: number): number {
  const exp = Math.floor(Math.log10(raw));
  const base = 10 ** exp;
  const f = raw / base;
  const mult = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return mult * base;
}

export function priceTicks(lo: number, hi: number, count = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return [lo];
  const step = niceStep((hi - lo) / count);
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9 && ticks.length < 12; v += step) {
    ticks.push(v);
  }
  return ticks;
}

export function timeTicks(t0: number, t1: number, count = 6, barMs = DEFAULT_BAR_MS): number[] {
  if (t1 <= t0) return [t0];
  const step = Math.max(barMs, Math.round((t1 - t0) / count / barMs) * barMs);
  const ticks: number[] = [];
  for (let t = t0; t <= t1; t += step) ticks.push(t);
  return ticks;
}

/**
 * 价格格式化：按量级定小数位。
 *
 * 合约价格跨好几个数量级（BTC 万级、DOGE 1e-4 级），固定 2 位会把低价标的压成一坨
 * 「0.00」——图看着是平的，数据其实在动。这里保留约 6 位**有效数字**（小数位 =
 * 6 − 整数位数，夹在 2~8），而不是保留固定位数：既不丢低价标的的精度，也不会让
 * 高价标的的轴标签刷一屏零。末尾的零交给 `maximumFractionDigits` 去掉。
 */
export function fmtPrice(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  if (abs >= 1000) return value.toLocaleString('zh-CN', { maximumFractionDigits: 1 });
  const digits = Math.min(8, Math.max(2, 6 - Math.ceil(Math.log10(abs) + 1)));
  return value.toLocaleString('zh-CN', { maximumFractionDigits: digits });
}

function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fmtStamp(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

/** 量容器宽高用 ResizeObserver 量；jsdom / 老浏览器没有它时退回默认宽度，图照常出。 */
function useMeasuredWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const apply = (w: number) => {
      if (w > 0) setWidth(w);
    };
    apply(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) apply(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function Tooltip(props: { bar: BarDto; x: number; y: number; plotRight: number }) {
  const { bar, x, y, plotRight } = props;
  const change = bar.open === 0 ? 0 : (bar.close - bar.open) / bar.open;
  const color = bar.close >= bar.open ? UP : DOWN;
  // 靠右时翻到左侧，否则提示框会被容器裁掉。
  const flip = x > plotRight - 150;
  return (
    <div
      className="candle-tip"
      style={{
        left: flip ? undefined : x + 12,
        right: flip ? plotRight - x + 12 : undefined,
        top: Math.max(0, y - 10),
        borderColor: color,
      }}
    >
      <div className="mono">{fmtStamp(bar.time)}</div>
      <dl>
        <dt>开</dt>
        <dd className="mono">{fmtPrice(bar.open)}</dd>
        <dt>高</dt>
        <dd className="mono">{fmtPrice(bar.high)}</dd>
        <dt>低</dt>
        <dd className="mono">{fmtPrice(bar.low)}</dd>
        <dt>收</dt>
        <dd className="mono" style={{ color }}>
          {fmtPrice(bar.close)}
        </dd>
        <dt>涨跌</dt>
        <dd className="mono" style={{ color }}>
          {`${change >= 0 ? '+' : ''}${(change * 100).toFixed(2)}%`}
        </dd>
        <dt>量</dt>
        <dd className="mono">{bar.volume.toLocaleString('zh-CN')}</dd>
      </dl>
    </div>
  );
}

export function CandleChart(props: {
  bars: readonly BarDto[];
  height?: number;
  /** 桶宽（毫秒）。缺省 1m；派生周期必须显式传入，否则缺口会被按分钟误算。 */
  barMs?: number;
  interval?: string;
}) {
  const bars = props.bars;
  const [ref, width] = useMeasuredWidth();
  const [hover, setHover] = useState<number | null>(null);
  const height = props.height ?? HEIGHT;
  const barMs = props.barMs ?? DEFAULT_BAR_MS;
  const layout = layoutCandles(bars, width, height, barMs);

  if (bars.length === 0) return <div className="candle-wrap" ref={ref} />;

  const plotRight = layout.plotLeft + layout.plotWidth;
  const hovered = hover === null ? null : (bars[hover] ?? null);
  const last = bars[bars.length - 1];

  const pick = (clientX: number, rect: DOMRect) => {
    // jsdom 的 getBoundingClientRect 全 0；此时按布局宽度推算，逻辑仍然可测。
    const boxWidth = rect.width > 0 ? rect.width : layout.width;
    const origin = rect.left > 0 ? rect.left : 0;
    const x = clientX - origin;
    if (x < layout.plotLeft || x > plotRight) {
      setHover(null);
      return;
    }
    const target = layout.t0 + ((x - layout.plotLeft) / layout.plotWidth) * (layout.t1 - layout.t0);
    let best = 0;
    let bestDelta = Infinity;
    for (let i = 0; i < bars.length; i += 1) {
      const delta = Math.abs((bars[i]?.time ?? 0) - target);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = i;
      }
    }
    setHover(best);
  };

  return (
    <div className="candle-wrap" ref={ref}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`${bars.length} 根 ${props.interval ?? '1m'} K 线，${fmtStamp(layout.t0)} 至 ${fmtStamp(layout.t1)}`}
        onMouseMove={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
        onMouseLeave={() => setHover(null)}
      >
        {priceTicks(layout.lo, layout.hi).map((p) => (
          <g key={`p-${String(p)}`}>
            <line
              x1={layout.plotLeft}
              x2={plotRight}
              y1={yOf(layout, p)}
              y2={yOf(layout, p)}
              stroke={GRID}
            />
            <text
              x={layout.plotLeft - 6}
              y={yOf(layout, p) + 3}
              textAnchor="end"
              fill={AXIS}
              fontSize={10}
              className="mono"
            >
              {fmtPrice(p)}
            </text>
          </g>
        ))}

        {timeTicks(layout.t0, layout.t1, 6, barMs).map((t) => (
          <text
            key={`t-${String(t)}`}
            x={xOf(layout, t)}
            y={height - 6}
            textAnchor="middle"
            fill={AXIS}
            fontSize={10}
            className="mono"
          >
            {fmtClock(t)}
          </text>
        ))}

        {/* 成交量在下：同一根的量与方向同色，缺一根就少一根，不插值补齐。 */}
        {bars.map((bar) => {
          const x = xOf(layout, bar.time) - layout.bodyWidth / 2;
          const h = layout.maxVolume > 0 ? (bar.volume / layout.maxVolume) * layout.volHeight : 0;
          return (
            <rect
              key={`v-${String(bar.time)}`}
              data-vol-time={bar.time}
              x={x}
              y={layout.volTop + layout.volHeight - h}
              width={layout.bodyWidth}
              height={Math.max(MIN_BODY, h)}
              fill={bar.close >= bar.open ? UP : DOWN}
              opacity={0.55}
            />
          );
        })}
        <line
          x1={layout.plotLeft}
          x2={plotRight}
          y1={layout.volTop + layout.volHeight}
          y2={layout.volTop + layout.volHeight}
          stroke={GRID}
        />

        {bars.map((bar) => {
          const up = bar.close >= bar.open;
          const color = up ? UP : DOWN;
          const cx = xOf(layout, bar.time);
          const bodyTop = yOf(layout, Math.max(bar.open, bar.close));
          const bodyBottom = yOf(layout, Math.min(bar.open, bar.close));
          return (
            <g key={`c-${String(bar.time)}`}>
              {/* 影线：low → high，always visible，即使实体只有 1px。 */}
              <line
                x1={cx}
                x2={cx}
                y1={yOf(layout, bar.high)}
                y2={yOf(layout, bar.low)}
                stroke={color}
                strokeWidth={1}
              />
              <rect
                data-bar-time={bar.time}
                x={cx - layout.bodyWidth / 2}
                y={bodyTop}
                width={layout.bodyWidth}
                // 开盘价 == 收盘价（十字星）时高度为 0，SVG 上不可见；给 1px 让它仍然读得出来。
                height={Math.max(MIN_BODY, bodyBottom - bodyTop)}
                fill={color}
              />
            </g>
          );
        })}

        {last && layout.maxVolume > 0 ? (
          <text
            x={plotRight + 4}
            y={layout.volTop - 4}
            fill={AXIS}
            fontSize={10}
            textAnchor="start"
            className="mono"
          >
            {last.volume.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}
          </text>
        ) : null}

        {last ? (
          <g>
            <line
              x1={layout.plotLeft}
              x2={plotRight}
              y1={yOf(layout, last.close)}
              y2={yOf(layout, last.close)}
              stroke={last.close >= last.open ? UP : DOWN}
              strokeDasharray="4 3"
              opacity={0.7}
            />
            <text
              x={plotRight + 4}
              y={yOf(layout, last.close) + 3}
              textAnchor="start"
              fill={last.close >= last.open ? UP : DOWN}
              fontSize={10}
              className="mono"
            >
              {fmtPrice(last.close)}
            </text>
          </g>
        ) : null}

        {hovered ? (
          <g pointerEvents="none">
            <line
              x1={xOf(layout, hovered.time)}
              x2={xOf(layout, hovered.time)}
              y1={layout.priceTop}
              y2={layout.volTop + layout.volHeight}
              stroke={AXIS}
              strokeDasharray="2 2"
            />
            <line
              x1={layout.plotLeft}
              x2={plotRight}
              y1={yOf(layout, hovered.close)}
              y2={yOf(layout, hovered.close)}
              stroke={AXIS}
              strokeDasharray="2 2"
            />
          </g>
        ) : null}
      </svg>
      {hovered ? (
        <Tooltip
          bar={hovered}
          x={xOf(layout, hovered.time)}
          y={yOf(layout, hovered.close)}
          plotRight={plotRight}
        />
      ) : null}
      <div className="candle-legend muted">
        <span style={{ color: UP }}>▲ 收 ≥ 开</span>
        <span style={{ color: DOWN }}>▼ 收 &lt; 开</span>
        <span>横轴按时间排布，空白即缺口</span>
      </div>
    </div>
  );
}

/**
 * 缺口说明。**显式写在图下方**：空档是这个项目要让人看见的东西（R-11）。
 *
 * 量化**按所选周期报**（v0.2.0 R-7.3）：4h 图上写「缺 30 分钟」是错的——那 30 分钟是
 * 上游 1m 的根因，在 4h 尺度上表现为「少了 1 根（约 4 小时）」。两句都要说，用户才
 * 分得清「4h 数据本身没写进来」与「1m 有洞导致 4h 被扣留」。
 *
 * 上游那个分钟数是**全历史累计**（`readDerivedIntervals` 对整张 1m 表聚合），
 * 不是本窗口的数字。因此文案必须写成「累计…含本区间」：把它说成「该区间缺 X 分钟」
 * 会把三年前一个老洞的分钟数算到今天的空白头上，那是另一种形式的骗人界面。
 */
export function GapNotice(props: {
  bars: readonly BarDto[];
  barMs?: number;
  interval?: string;
  /** 上游 1m 缺口的分钟数（服务端按**全历史**算好）；给了就一并说明根因 */
  upstreamMissingMinutes?: number | null;
}) {
  const barMs = props.barMs ?? DEFAULT_BAR_MS;
  const stats = gapStats(props.bars, barMs);
  if (stats === null) return null;
  if (stats.missing === 0) {
    return (
      <p className="muted mono" style={{ fontSize: 11, margin: '6px 0 0' }}>
        窗口内 {stats.present} 根连续，无缺口
      </p>
    );
  }
  return (
    <p className="mono" style={{ fontSize: 11, margin: '6px 0 0', color: 'var(--warn)' }}>
      窗口内应有 {stats.expected.toLocaleString('zh-CN')} 根 {props.interval ?? '1m'}，实有{' '}
      {stats.present.toLocaleString('zh-CN')} 根：缺 {stats.missing.toLocaleString('zh-CN')} 根 /{' '}
      {stats.holes} 段，最长连续 {stats.longest.toLocaleString('zh-CN')} 根（
      {describeSpan(barMs, stats.longest)}，图上的空白就是它）
      {props.upstreamMissingMinutes ? (
        <>
          {' '}
          · 根因在上游 1m：该标的 1m 累计缺 {props.upstreamMissingMinutes.toLocaleString(
            'zh-CN',
          )}{' '}
          分钟（全历史口径，含本区间）
        </>
      ) : null}
    </p>
  );
}
