import type { BarDto, IndicatorsDto } from '../../../src/types';
import {
  IndicatorEmptyState,
  IndicatorLegend,
  ShortfallNotice,
  SUBPANEL_STYLES,
  columnSeries,
  isSubpanel,
  panelRange,
  splitSeries,
  subPanelX,
  subPanelY,
  type SubPanelLayout,
} from './indicators.js';

/**
 * 指标副图：MACD / RSI / KDJ / ATR / OBV（v0.3.0 R-10.4）。
 *
 * 为什么不叠在主图上：这些指标各有自己的量纲（RSI 是 0~100，ATR 是绝对价格，
 * OBV 是从段首 0 起累加的量）。画在价格图里，RSI 的 50 会落在价格 50 的位置——
 * 那不是「看起来乱」，而是**会读错**。
 *
 * OBV 额外只能画在自己的面板里：它是绝对累加量，**不同标的 / 不同段之间不可比**
 * （R-1.6 / A.7），而所有副图都共用价格图的横轴，量纲不可比正是最容易被误读的一处。
 */

const WIDTH = 900;
const PANEL_H = 92;
const PAD_LEFT = 64;
const PAD_RIGHT = 46;
const GAP = 10;
const AXIS_H = 20;
const GRID = '#2a2f3a';
const AXIS = '#9aa3b2';

export function panelHeight(count: number): number {
  return count * (PANEL_H + GAP) + AXIS_H;
}

export function panelLayout(
  index: number,
  count: number,
  t0: number,
  t1: number,
  lo: number,
  hi: number,
): SubPanelLayout {
  const top = index * (PANEL_H + GAP);
  return {
    top,
    height: PANEL_H,
    plotLeft: PAD_LEFT,
    plotWidth: Math.max(1, WIDTH - PAD_LEFT - PAD_RIGHT),
    t0,
    t1: t1 > t0 ? t1 : t0 + 1,
    lo,
    hi,
  };
}

function fmtValue(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  if (abs >= 1e6 || abs < 1e-4) return value.toExponential(2);
  return value.toLocaleString('zh-CN', { maximumFractionDigits: abs >= 100 ? 1 : 4 });
}

/**
 * 副图区。`state !== 'ok'` 时给**空状态 + 原因 + 物化命令**（R-10.4），
 * 而不是画一张空图或抛错——「还没算」是完全正常的状态。
 */
export function IndicatorPanels(props: {
  indicators: IndicatorsDto | undefined;
  bars: readonly BarDto[];
  interval: string;
  hidden?: ReadonlySet<string> | undefined;
  onToggle?: ((label: string) => void) | undefined;
  error?: string | null | undefined;
}) {
  const { indicators, bars, interval, error } = props;
  if (error !== undefined && error !== null) {
    return (
      <p className="chart-error mono" style={{ fontSize: 11, margin: '6px 0 0' }}>
        读取指标失败：{error}
      </p>
    );
  }
  if (indicators === undefined) return null;
  if (indicators.state !== 'ok') {
    return (
      <>
        <IndicatorEmptyState indicators={indicators} />
        <ShortfallNotice indicators={indicators} barCount={bars.length} interval={interval} />
      </>
    );
  }

  const barMs = indicators.intervalMs;
  const first = bars[0]?.time ?? 0;
  const last = bars[bars.length - 1]?.time ?? first;
  const panels = indicators.specs.filter(
    (s) => isSubpanel(s.label) && !(props.hidden?.has(s.label) ?? false),
  );

  return (
    <div className="indicator-panels">
      <IndicatorLegend
        indicators={indicators}
        {...(props.onToggle ? { onToggle: props.onToggle } : {})}
        {...(props.hidden ? { hidden: props.hidden } : {})}
      />
      <ShortfallNotice indicators={indicators} barCount={bars.length} interval={interval} />
      {panels.length > 0 ? (
        <svg
          width={WIDTH}
          height={panelHeight(panels.length)}
          role="img"
          aria-label={`${panels.length} 个指标副图`}
        >
          {panels.map((series, index) => {
            const styles = SUBPANEL_STYLES[series.spec.indicator] ?? {};
            const columns = Object.keys(styles);
            const all = series.rows.flatMap((row) =>
              columns.map((c) => row.values[c]).filter((v): v is number => typeof v === 'number'),
            );
            const [lo, hi] = panelRange(series.label, all);
            const layout = panelLayout(index, panels.length, first, last, lo, hi);
            return (
              <g key={series.label} data-indicator-panel={series.label}>
                <line
                  x1={layout.plotLeft}
                  x2={layout.plotLeft + layout.plotWidth}
                  y1={layout.top}
                  y2={layout.top}
                  stroke={GRID}
                />
                {columns.map((column) => {
                  const points = columnSeries(series.rows, column);
                  const segments = splitSeries(points, barMs);
                  return (
                    <g key={column}>
                      {segments.map((seg, i) =>
                        seg.length < 2 ? null : (
                          <polyline
                            key={`${column}-${String(i)}`}
                            data-indicator-line={`${series.label}:${column}`}
                            points={seg
                              .map(
                                (p) =>
                                  `${String(subPanelX(layout, p.time))},${String(subPanelY(layout, p.value))}`,
                              )
                              .join(' ')}
                            fill="none"
                            stroke={styles[column] ?? '#58a6ff'}
                            strokeWidth={1.2}
                          />
                        ),
                      )}
                      <text
                        x={layout.plotLeft + layout.plotWidth + 4}
                        y={layout.top + 10}
                        fill={AXIS}
                        fontSize={9}
                        className="mono"
                      >
                        {series.label.split('(')[0]?.toUpperCase()} {column}
                      </text>
                      <text
                        x={layout.plotLeft + layout.plotWidth + 4}
                        y={layout.top + 22}
                        fill={AXIS}
                        fontSize={9}
                        className="mono"
                      >
                        {points.length > 0 ? fmtValue(points[points.length - 1]!.value) : '—'}
                      </text>
                    </g>
                  );
                })}
                <text
                  x={PAD_LEFT - 6}
                  y={layout.top + 10}
                  textAnchor="end"
                  fill={AXIS}
                  fontSize={9}
                  className="mono"
                >
                  {fmtValue(hi)}
                </text>
                <text
                  x={PAD_LEFT - 6}
                  y={layout.top + layout.height}
                  textAnchor="end"
                  fill={AXIS}
                  fontSize={9}
                  className="mono"
                >
                  {fmtValue(lo)}
                </text>
              </g>
            );
          })}
        </svg>
      ) : null}
    </div>
  );
}