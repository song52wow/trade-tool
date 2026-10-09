// @vitest-environment jsdom
// 指标叠加的用例（R-10.4 / AC-17）：**缺口处断线**、**指标短于 K 线要写明原因**、
// **未物化给空状态 + 物化命令**。三条都是「不骗人」的硬要求。
import './setup.js';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IndicatorPanels } from '../../ui/src/components/IndicatorPanels';
import { buildOverlayLines } from '../../ui/src/components/CandleChart';
import { columnSeries, panelRange, splitSeries } from '../../ui/src/components/indicators';
import type { BarDto, IndicatorsDto } from '../../src/types';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const HOUR = 3_600_000;
const BASE = 1_760_000_000_000;

function bar(time: number, close: number): BarDto {
  return { time, open: close, high: close + 1, low: close - 1, close, volume: 10 };
}

function bars(n: number, step = HOUR): BarDto[] {
  return Array.from({ length: n }, (_, i) => bar(BASE + i * step, 100 + i));
}

function indicators(overrides: Partial<IndicatorsDto> = {}): IndicatorsDto {
  return {
    symbol: 'AAAUSDT',
    interval: '1h',
    intervalMs: HOUR,
    limit: 300,
    implVersion: 1,
    specs: [
      {
        spec: { indicator: 'rsi', params: { period: 14 }, implVersion: 1, rows: 3 },
        label: 'RSI(period=14)',
        rows: [
          { time: BASE + 14 * HOUR, values: { value: 50 } },
          { time: BASE + 15 * HOUR, values: { value: 51 } },
          { time: BASE + 16 * HOUR, values: { value: 52 } },
        ],
      },
    ],
    shortBy: { bars: 0, reason: null },
    state: 'ok',
    message: null,
    materializeCommand: null,
    ...overrides,
  };
}

// ------------------------------------------------------------------ 纯计算

describe('指标序列按时间切段（缺口处断线的前提）', () => {
  it('连续的时间差等于桶宽时不切段', () => {
    const rows = [
      { time: BASE },
      { time: BASE + HOUR },
      { time: BASE + 2 * HOUR },
    ];
    expect(splitSeries(rows, HOUR)).toHaveLength(1);
  });

  it('出现缺口时切成两段——**绝不跨缺口连线**', () => {
    const rows = [
      { time: BASE },
      { time: BASE + HOUR },
      // 中间缺一根（2h）
      { time: BASE + 3 * HOUR },
      { time: BASE + 4 * HOUR },
    ];
    const segments = splitSeries(rows, HOUR);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toHaveLength(2);
    expect(segments[1]).toHaveLength(2);
  });

  it('桶宽来自服务端回传的 intervalMs，而不是写死 60_000', () => {
    // 4h 图上「相邻两根」的时间差是 4 小时；用 60_000 判断会把每一根都当成孤立点
    const rows = [{ time: BASE }, { time: BASE + 4 * HOUR }];
    expect(splitSeries(rows, 4 * HOUR)).toHaveLength(1);
    expect(splitSeries(rows, 60_000)).toHaveLength(2);
  });

  it('缺某个值列时返回空，页面据此不画那条线', () => {
    const rows = [
      { time: BASE, values: { value: 1 } },
      { time: BASE + HOUR, values: { other: 2 } },
    ];
    expect(columnSeries(rows, 'other')).toEqual([{ time: BASE + HOUR, value: 2 }]);
    expect(columnSeries(rows, 'missing')).toEqual([]);
  });
});

describe('主图叠加线', () => {
  const withMa = indicators({
    specs: [
      {
        spec: { indicator: 'ma', params: { kind: 'sma', bars: 20 }, implVersion: 1, rows: 4 },
        label: 'SMA(bars=20)',
        rows: [
          { time: BASE, values: { value: 1 } },
          { time: BASE + HOUR, values: { value: 2 } },
          { time: BASE + 3 * HOUR, values: { value: 4 } },
          { time: BASE + 4 * HOUR, values: { value: 5 } },
        ],
      },
    ],
  });

  it('缺口处断开：两段各自成线', () => {
    const lines = buildOverlayLines(withMa, HOUR, undefined);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.segments).toHaveLength(2);
  });

  it('MACD 不叠在主图上（量纲不同，叠上去会被读错）', () => {
    const macd = indicators({
      specs: [
        {
          spec: { indicator: 'macd', params: { fast: 12, slow: 26, signal: 9 }, implVersion: 1, rows: 2 },
          label: 'MACD(fast=12, slow=26, signal=9)',
          rows: [
            { time: BASE, values: { dif: 1, dea: 0.5, hist: 0.5 } },
            { time: BASE + HOUR, values: { dif: 2, dea: 1, hist: 1 } },
          ],
        },
      ],
    });
    expect(buildOverlayLines(macd, HOUR, undefined)).toHaveLength(0);
  });

  it('未物化时不画任何线', () => {
    expect(buildOverlayLines(indicators({ state: 'not-materialized' }), HOUR, undefined)).toHaveLength(0);
    expect(buildOverlayLines(undefined, HOUR, undefined)).toHaveLength(0);
  });

  it('图例关掉的参数集不再画线', () => {
    expect(buildOverlayLines(withMa, HOUR, new Set(['SMA(bars=20)']))).toHaveLength(0);
  });
});

describe('副图量程', () => {
  it('RSI 恒为 0~100 —— 固定量程，不随数据自适应', () => {
    expect(panelRange('RSI(period=14)', [55, 60])).toEqual([0, 100]);
  });

  it('KDJ 允许负值（J = 3K − 2D 可以小于 0），量程要留出上下空间', () => {
    expect(panelRange('KDJ(n=9, k_period=3, d_period=3)', [80, 95])).toEqual([-20, 120]);
  });

  it('无固定量程的指标按数据自适应并留 5% 余量', () => {
    const [lo, hi] = panelRange('ATR(period=14)', [10, 20]);
    expect(lo).toBeLessThan(10);
    expect(hi).toBeGreaterThan(20);
  });

  it('全平序列不会除零', () => {
    const [lo, hi] = panelRange('ATR(period=14)', [5, 5]);
    expect(hi).toBeGreaterThan(lo);
  });
});

// ------------------------------------------------------------------ 渲染

describe('副图渲染', () => {
  it('画出指标线并标注「收盘后可用」', async () => {
    render(<IndicatorPanels indicators={indicators()} bars={bars(20)} interval="1h" />);
    await waitFor(() => expect(document.querySelector('[data-indicator-panel="RSI(period=14)"]')).toBeTruthy());
    expect(document.body.textContent).toContain('收盘后可用');
  });

  it('未物化时给**空状态 + 原因 + 物化命令**，不是空白图也不是报错', () => {
    render(
      <IndicatorPanels
        indicators={indicators({
          state: 'not-materialized',
          specs: [],
          implVersion: null,
          message: '1h 的指标尚未物化。图上还没有指标线，不代表数据有问题。',
          materializeCommand:
            'pnpm --filter @trade-tool/cli start -- data indicators --symbol AAAUSDT --intervals 1h',
        })}
        bars={bars(20)}
        interval="1h"
      />,
    );
    expect(document.body.textContent).toContain('尚未物化');
    expect(document.body.textContent).toContain('不代表数据有问题');
    expect(document.body.textContent).toContain('data indicators --symbol AAAUSDT');
    expect(document.querySelector('svg')).toBeNull();
  });

  it('未启用该周期时不给出无效的物化命令', () => {
    render(
      <IndicatorPanels
        indicators={indicators({
          state: 'disabled',
          specs: [],
          implVersion: null,
          message: '未启用 1h 的指标（不在 data.indicatorIntervals 里）。',
          materializeCommand: null,
        })}
        bars={bars(20)}
        interval="1h"
      />,
    );
    expect(document.body.textContent).toContain('未启用');
    expect(document.body.textContent).not.toContain('data indicators --symbol');
  });

  it('指标比 K 线短时写明少了多少根与原因，且**不**说成「数据缺失」', () => {
    render(
      <IndicatorPanels
        indicators={indicators({ shortBy: { bars: 14, reason: 'warmup' } })}
        bars={bars(20)}
        interval="1h"
      />,
    );
    const text = document.body.textContent ?? '';
    expect(text).toContain('比 K 线少 14 根');
    expect(text).toContain('预热期');
    expect(text).toContain('而不是数据缺失');
  });

  it('末根未收盘造成的短缺单独说明', () => {
    render(
      <IndicatorPanels
        indicators={indicators({ shortBy: { bars: 1, reason: 'not-closed' } })}
        bars={bars(20)}
        interval="1h"
      />,
    );
    expect(document.body.textContent).toContain('尚未收盘');
  });

  it('读取失败常驻可见，并保留上一次读到的指标', () => {
    render(<IndicatorPanels indicators={indicators()} bars={bars(20)} interval="1h" error="[PG] 读不出来" />);
    expect(document.body.textContent).toContain('读取指标失败');
    expect(document.body.textContent).toContain('读不出来');
  });

  it('图例可切换参数集的显示', async () => {
    const onToggle = vi.fn();
    render(
      <IndicatorPanels
        indicators={indicators()}
        bars={bars(20)}
        interval="1h"
        onToggle={onToggle}
        hidden={new Set(['RSI(period=14)'])}
      />,
    );
    const chip = screen.getByRole('button', { name: /RSI\(period=14\)/ });
    expect(chip.textContent).toContain('○');
    await act(async () => {
      fireEvent.click(chip);
    });
    expect(onToggle).toHaveBeenCalledWith('RSI(period=14)');
  });
});