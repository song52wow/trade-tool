import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * 手写 SVG 图表的公共工具：刻度、时间格式、容器测量。
 *
 * 这些函数原来在 `CandleChart` 与 `ChainCurveChart` 各有一份（逐字相同或几乎相同），
 * 而两份 `timeTicks` 已经悄悄分叉：K 线按 **bar 宽度**取整（否则刻度落在两根蜡烛之间），
 * 链上曲线按**跨度**取整（采样不均匀，按采样间隔切会挤在一头）。分叉本身是对的，
 * 但同名函数各写一份就意味着改一处、另一处不知道——所以这里把它们并排放下，
 * 各自名字说清口径。
 *
 * （2026-11-14：链上那一页不再画走势图，`ChainCurveChart` 与它专用的
 * `timeTicksNice` 一起删掉了；K 线用的这些留着。）
 */

/** 轴刻度取 1/2/5×10ⁿ 的「好看」步长，避免出现 0.0037 这种刻度。 */
export function niceStep(raw: number): number {
  const exp = Math.floor(Math.log10(raw));
  const base = 10 ** exp;
  const f = raw / base;
  const mult = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return mult * base;
}

/** 数值轴刻度（价格、盈亏）。`hi <= lo` 时返回单点，让调用方画一条线而不是除零。 */
export function priceTicks(lo: number, hi: number, count = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return [lo];
  const step = niceStep((hi - lo) / count);
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9 && ticks.length < 12; v += step) {
    ticks.push(v);
  }
  return ticks;
}

/**
 * 时间轴刻度（K 线）：步长取 **bar 宽度的整数倍**。
 *
 * 不这么做的话，刻度会落在两根蜡烛中间，图上出现「时间点没有对应的 bar」的错觉。
 */
export function timeTicksByBar(t0: number, t1: number, count = 6, barMs = 60_000): number[] {
  if (t1 <= t0) return [t0];
  const step = Math.max(barMs, Math.round((t1 - t0) / count / barMs) * barMs);
  const ticks: number[] = [];
  for (let t = t0; t <= t1; t += step) ticks.push(t);
  return ticks;
}

/** 只显示时分（当天的刻度用）。 */
export function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 完整日期时间（跨天的刻度用）。 */
export function fmtStamp(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

/**
 * 量容器宽高用 ResizeObserver 量；jsdom / 老浏览器没有它时退回默认宽度，图照常出。
 *
 * 默认宽度由调用方给：两个图的缺省宽度是各自的版面常量，不属于公共逻辑。
 */
export function useMeasuredWidth(defaultWidth: number): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(defaultWidth);
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
