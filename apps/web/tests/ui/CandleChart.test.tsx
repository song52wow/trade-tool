// @vitest-environment jsdom
// UI 用例需要 DOM；服务端用例跑在默认的 node 环境。
import './setup.js';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CandleChart,
  GapNotice,
  gapStats,
  layoutCandles,
  priceTicks,
  timeTicks,
  xOf,
  yOf,
  fmtPrice,
} from '../../ui/src/components/CandleChart';
import type { BarDto } from '../../src/types';

afterEach(cleanup);

const MINUTE = 60_000;
const FOUR_HOURS = 4 * 60 * MINUTE;
const BASE = 1_760_000_000_000;

function bar(time: number, close: number, overrides: Partial<BarDto> = {}): BarDto {
  return {
    time,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 10,
    ...overrides,
  };
}

/** 连续 n 根，close 线性递增，便于断言坐标与顺序。 */
function series(n: number, from = BASE): BarDto[] {
  return Array.from({ length: n }, (_, i) => bar(from + i * MINUTE, 100 + i));
}

describe('K 线布局计算', () => {
  it('横轴按**时间**排布：两根相隔 10 分钟，图上就有 10 分钟的宽度', () => {
    const layout = layoutCandles([bar(BASE, 10), bar(BASE + 10 * MINUTE, 12)], 900);
    const left = xOf(layout, BASE);
    const right = xOf(layout, BASE + 10 * MINUTE);

    expect(left).toBeCloseTo(layout.plotLeft, 6);
    expect(right).toBeCloseTo(layout.plotLeft + layout.plotWidth, 6);
  });

  it('按序号排会抹平缺口——这正是本图不用序号横轴的理由', () => {
    // 5 根 bar，但时间上跨了 50 分钟（中间缺 45 根）
    const bars = Array.from({ length: 5 }, (_, i) => bar(BASE + i * 10 * MINUTE, 100 + i));
    const layout = layoutCandles(bars, 900);

    // 五根在时间轴上各占 1/5 的宽度，而不是挤在左边
    const xs = bars.map((b) => xOf(layout, b.time));
    for (let i = 1; i < xs.length; i += 1) {
      expect((xs[i] ?? 0) - (xs[i - 1] ?? 0)).toBeGreaterThan(layout.plotWidth / 5 / 2);
    }
  });

  it('单根 bar 不除零：跨度退化成 1 分钟，图照常出', () => {
    const layout = layoutCandles([bar(BASE, 10)], 900);
    expect(layout.t1).toBe(BASE + MINUTE);
    expect(Number.isFinite(xOf(layout, BASE))).toBe(true);
    expect(Number.isFinite(yOf(layout, 10))).toBe(true);
  });

  it('全平价格（low === high）也给出非零价格跨度', () => {
    const flat = [bar(BASE, 5, { open: 5, high: 5, low: 5, close: 5 })];
    const layout = layoutCandles(flat, 900);
    expect(layout.hi).toBeGreaterThan(layout.lo);
  });

  it('空输入不炸，图元为空（空状态由外层负责说明原因）', () => {
    const layout = layoutCandles([], 900);
    expect(layout.maxVolume).toBe(0);
    expect(layout.bodyWidth).toBeGreaterThanOrEqual(1);
  });

  it('实体宽度有上下限：一根 bar 也不会撑满整个窗口', () => {
    expect(layoutCandles(series(2), 900).bodyWidth).toBeLessThanOrEqual(10);
    expect(layoutCandles(series(2000), 900).bodyWidth).toBeGreaterThanOrEqual(1);
  });
});

describe('刻度', () => {
  it('价格刻度取 1/2/5×10ⁿ 的整数步长', () => {
    const ticks = priceTicks(0, 100, 5);
    expect(ticks.length).toBeGreaterThan(2);
    for (const t of ticks) expect(Number.isFinite(t)).toBe(true);
    expect(priceTicks(1, 1)).toEqual([1]);
  });

  it('时间刻度至少隔一根 bar，绝不出现 0 跨度刻度', () => {
    const ticks = timeTicks(BASE, BASE + MINUTE, 6);
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < ticks.length; i += 1) {
      expect((ticks[i] ?? 0) - (ticks[i - 1] ?? 0)).toBeGreaterThanOrEqual(MINUTE);
    }
  });
});

describe('缺口统计', () => {
  it('连续无缺口时 missing = 0', () => {
    const stats = gapStats(series(10), MINUTE);
    expect(stats).toEqual({ expected: 10, present: 10, missing: 0, holes: 0, longest: 0 });
  });

  it('中间缺一段：报出段数与最长连续根数', () => {
    // 00,01,02,03 之后跳到 10（缺 6 根：04~09）
    const times = [0, 1, 2, 3, 10].map((m) => BASE + m * MINUTE);
    const stats = gapStats(
      times.map((t, i) => bar(t, 100 + i)),
      MINUTE,
    );

    expect(stats?.present).toBe(5);
    expect(stats?.missing).toBe(6);
    expect(stats?.holes).toBe(1);
    expect(stats?.longest).toBe(6);
  });

  it('多段缺口分别计数', () => {
    const times = [0, 1, 5, 6, 20].map((m) => BASE + m * MINUTE);
    const stats = gapStats(
      times.map((t, i) => bar(t, 100 + i)),
      MINUTE,
    );

    expect(stats?.holes).toBe(2);
    expect(stats?.longest).toBe(13); // 07~19
  });

  it('空数据返回 null（没有数据 ≠ 缺 0 根）', () => {
    expect(gapStats([], MINUTE)).toBeNull();
  });

  /**
   * v0.2.0 R-7.3：桶宽是必填的，缺口一律按**根**统计。
   *
   * 同一组时间戳在 1m 步进下「缺 6 根」，在 4h 步进下只「缺 0 根」——因为相邻两桶
   * 只隔 4 小时。写死 60_000 的实现会在 4h 图上把这个 4 小时的空洞说成「缺 1 分钟」。
   */
  it('按桶宽统计：4h 步进下同样的时间戳不是缺口', () => {
    const times = [0, 1, 2, 3].map((h) => BASE + h * FOUR_HOURS);
    const bars = times.map((t, i) => bar(t, 100 + i));
    expect(gapStats(bars, FOUR_HOURS)?.missing).toBe(0);
    // 若误用 1m 步进，会得出 707 分钟的假缺口
    expect(gapStats(bars, MINUTE)?.missing).toBe(717);
  });

  it('4h 图上缺一根报 1 根（= 4 小时），不是 1 分钟', () => {
    const times = [0, 1, 3, 4].map((h) => BASE + h * FOUR_HOURS);
    const stats = gapStats(
      times.map((t, i) => bar(t, 100 + i)),
      FOUR_HOURS,
    );
    expect(stats?.missing).toBe(1);
    expect(stats?.holes).toBe(1);
    expect(stats?.longest).toBe(1);
  });
});

describe('价格格式化', () => {
  it('按量级给小数位，低价标的不会被压成 0.00', () => {
    // 6 位有效数字：1e-4 量级要留到 8 位，否则 0.00012345 会被显示成 0.000123
    expect(fmtPrice(0.00012345)).toBe('0.00012345');
    expect(fmtPrice(0.12345)).toBe('0.12345');
    expect(fmtPrice(12.3456)).toBe('12.346');
  });

  it('高价标的不刷一屏小数，末尾的零不留着充数', () => {
    expect(fmtPrice(12345.678)).toBe('12,345.7');
    expect(fmtPrice(150)).toBe('150');
  });

  it('0 与非有限数有明确表示，不显示 NaN', () => {
    expect(fmtPrice(0)).toBe('0');
    expect(fmtPrice(Number.NaN)).toBe('—');
  });
});

describe('CandleChart 渲染', () => {
  it('每根 bar 画一根实体（按根数渲染，不按时间插值补齐）', () => {
    const { container } = render(<CandleChart bars={series(6)} />);
    expect(container.querySelectorAll('rect[data-bar-time]')).toHaveLength(6);
    expect(container.querySelectorAll('rect[data-vol-time]')).toHaveLength(6);
  });

  it('图例写明方向配色与「空白即缺口」', () => {
    const { getByText } = render(<CandleChart bars={series(3)} />);
    expect(getByText(/收 ≥ 开/)).toBeTruthy();
    expect(getByText(/收 < 开/)).toBeTruthy();
    expect(getByText(/空白即缺口/)).toBeTruthy();
  });

  it('空数组不渲染任何蜡烛（外层据此显示「库里没有数据」）', () => {
    const { container } = render(<CandleChart bars={[]} />);
    expect(container.querySelectorAll('rect[data-bar-time]')).toHaveLength(0);
  });

  it('悬停出十字光标与 OHLC 提示', () => {
    const { container } = render(<CandleChart bars={series(30)} />);
    const svg = container.querySelector('svg');
    if (svg === null) throw new Error('svg 未渲染');

    // 落在绘图区内：会命中某根 bar
    fireEvent.mouseMove(svg, { clientX: 300 });
    const tip = container.querySelector('.candle-tip');
    expect(tip).not.toBeNull();
    expect(tip?.textContent).toMatch(/开/);
    expect(tip?.textContent).toMatch(/高/);
    expect(tip?.textContent).toMatch(/涨跌/);

    // 移出后提示消失
    fireEvent.mouseLeave(svg);
    expect(container.querySelector('.candle-tip')).toBeNull();
  });

  it('指到绘图区外不显示提示（不吸到最近的一根上）', () => {
    const { container } = render(<CandleChart bars={series(10)} />);
    const svg = container.querySelector('svg');
    if (svg === null) throw new Error('svg 未渲染');

    fireEvent.mouseMove(svg, { clientX: 0 });
    expect(container.querySelector('.candle-tip')).toBeNull();
  });

  it('开盘 == 收盘的十字星仍画出 1px 实体（不会被当成没有数据）', () => {
    const bars = [bar(BASE, 5, { open: 5, close: 5, high: 6, low: 4 })];
    const { container } = render(<CandleChart bars={bars} />);
    const rect = container.querySelector('rect[data-bar-time]');
    expect(Number(rect?.getAttribute('height'))).toBeGreaterThanOrEqual(1);
  });
});

describe('GapNotice', () => {
  it('连续时说明「无缺口」', () => {
    const { getByText } = render(<GapNotice bars={series(10)} />);
    expect(getByText(/无缺口/)).toBeTruthy();
  });

  it('有缺口时把缺多少、几段、最长多长都写出来（1m 用分钟）', () => {
    const times = [0, 1, 2, 3, 10].map((m) => BASE + m * MINUTE);
    const { getByText } = render(
      <GapNotice bars={times.map((t, i) => bar(t, 100 + i))} barMs={MINUTE} interval="1m" />,
    );
    const text = getByText(/缺/).textContent ?? '';
    expect(text).toContain('6');
    expect(text).toContain('1 段');
    expect(text).toContain('分钟');
  });

  it('4h 缺口按根与小时报，并说明上游 1m 根因（R-7.3）', () => {
    const times = [0, 1, 3, 4].map((h) => BASE + h * FOUR_HOURS);
    const { getByText } = render(
      <GapNotice
        bars={times.map((t, i) => bar(t, 100 + i))}
        barMs={FOUR_HOURS}
        interval="4h"
        upstreamMissingMinutes={240}
      />,
    );
    const text = getByText(/缺/).textContent ?? '';
    expect(text).toContain('缺 1 根');
    expect(text).toContain('4 小时');
    expect(text).toContain('根因在上游 1m');
    expect(text).toContain('240');
    // 绝不能把 1m 的分钟口径贴到 4h 图上
    expect(text).not.toContain('缺 1 分钟');
  });

  it('没有数据时什么都不说（不谎报「缺 0」）', () => {
    const { container } = render(<GapNotice bars={[]} />);
    expect(container.textContent).toBe('');
  });
});
