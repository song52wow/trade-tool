import type { IndicatorInterval } from '@trade-tool/data';

import type { BarDto, IndicatorsDto } from '../../../src/types';

/**
 * 指标叠加层（v0.3.0 R-10.4）。
 *
 * 四条硬约束，全部来自「K 线只画真实的行」那一条规则（R-23）的延伸：
 *
 * 1. **横轴按时间排**，与 K 线共用同一个 `xOf`，因此指标线与蜡烛**严格对齐**。
 *    按行序排会把缺口悄悄抹平。
 *
 * 2. **指标线在缺口处断开**。指标行在缺口处是**缺失**的（不是 NaN、不是 0），因此连线
 *    时必须发现「相邻两点的时间差 ≠ 桶宽」并断开。直接连过去会把一段空白画成一条
 *    斜线——用户会把它读成「这段时间指标在平滑变化」，而真相是那段根本没数据。
 *
 * 3. **指标比 K 线短是正常的**，少的正是预热期与未收盘的最后一根（R-2.4）。
 *    必须在图**外**写明少了多少根、原因是什么，否则会被当成数据缺失。
 *
 * 4. 桶宽来自**服务端回传的 `intervalMs`**，不在前端写死 60_000——写死会把
 *    「4h 图上缺一根」说成「缺一分钟」。
 */

/** 主图叠加的指标：均线与布林带（价格量纲）。 */
const OVERLAY = new Set(['ma', 'boll']);
/** 副图单独成面板的指标（各有自己的量纲，叠到价格图上会误导）。 */
const SUBPANEL = new Set(['macd', 'rsi', 'kdj', 'atr', 'obv']);

export function isSubpanel(label: string): boolean {
  const name = label.split('(')[0]?.toLowerCase() ?? '';
  return SUBPANEL.has(name);
}

export function isOverlay(label: string): boolean {
  const name = label.split('(')[0]?.toLowerCase() ?? '';
  return OVERLAY.has(name);
}

/** 该指标表的值列里，哪些适合画在主图（价格量纲）。 */
export const OVERLAY_COLUMNS: Record<string, readonly string[]> = {
  ma: ['value'],
  boll: ['upper', 'mid', 'lower'],
};

/**
 * 副图里每个列的**色板**与量纲标注。
 *
 * MACD 三条线各自有色，RSI/BOLL 上下轨用同色深浅，KDJ 三条同理——
 * 一个面板里十几条同色线没法读，而「读不出来」与「没画」在界面上没有区别。
 */
export const SUBPANEL_STYLES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  macd: { dif: '#58a6ff', dea: '#f0883e', hist: '#a371f7' },
  rsi: { value: '#58a6ff' },
  boll: { upper: '#8b949e', mid: '#f0b72f', lower: '#8b949e' },
  kdj: { k: '#58a6ff', d: '#f0883e', j: '#a371f7' },
  atr: { value: '#3fb950' },
  obv: { value: '#a371f7' },
};

/** 副图的固定量程；超出则按数据自适应。 */
const PANEL_RANGE: Readonly<Record<string, readonly [number, number]>> = {
  rsi: [0, 100],
  kdj: [-20, 120],
};

/**
 * 把指标行切成**连续段**，段间不连线（R-10.4）。
 *
 * 判据是「相邻两点的时间差是否等于桶宽」——与写侧的连续段判据（`quant_data` 的
 * `split_segments`）**同一条规则**。两边漂移的后果是「图上断开但库里连续」或反之。
 */
export function splitSeries(
  rows: readonly { time: number }[],
  barMs: number,
): Array<Array<{ time: number; value: number }>> {
  const out: Array<Array<{ time: number; value: number }>> = [];
  let current: Array<{ time: number; value: number }> = [];
  for (const row of rows) {
    if (current.length > 0 && row.time - current[current.length - 1]!.time !== barMs) {
      out.push(current);
      current = [];
    }
    current.push(row as { time: number; value: number });
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** 取某个值列的时间-值序列（缺失该列时返回空，页面据此只画存在的线）。 */
export function columnSeries(
  rows: readonly { time: number; values: Record<string, number> }[],
  column: string,
): Array<{ time: number; value: number }> {
  return rows
    .filter((row) => typeof row.values[column] === 'number')
    .map((row) => ({ time: row.time, value: row.values[column] as number }));
}

/**
 * 「指标比 K 线短多少根、为什么」的**图外说明**（R-10.4）。
 *
 * 少的根数由服务端算好并回传（它需要库里的 K 线才能算），这里只负责说人话。
 * **不写任何「缺失」字样**：少的是预热期与未收盘的最后一根，是指标的定义，不是数据坏了。
 */
export function ShortfallNotice(props: {
  indicators: IndicatorsDto;
  barCount: number;
  interval: string;
}) {
  const { indicators, barCount, interval } = props;
  if (indicators.state !== 'ok') return null;
  const reasonText: Record<string, string> = {
    warmup: '预热期（窗口尚未填满，指标值还不存在）',
    'not-closed': '最后一根尚未收盘（指标在收盘后才可用）',
    mixed: '预热期与未收盘的最后一根',
  };
  const why = indicators.shortBy.reason === null ? null : reasonText[indicators.shortBy.reason];
  const totalRows = indicators.specs.reduce((sum, s) => sum + s.spec.rows, 0);
  return (
    <p className="muted mono" style={{ fontSize: 11, margin: '4px 0 0' }}>
      指标 {indicators.specs.length} 组参数集 / 共 {totalRows.toLocaleString('zh-CN')} 行 ·{' '}
      {indicators.shortBy.bars > 0
        ? `比 K 线少 ${indicators.shortBy.bars} 根（${why}），这是指标的定义而不是数据缺失`
        : '与 K 线等长'}
      {indicators.implVersion !== null
        ? ` · 实现版本 v${indicators.implVersion}（收盘后可用）`
        : ''}
      {barCount > 0 ? ` · 图上 ${barCount.toLocaleString('zh-CN')} 根 ${interval}` : ''}
    </p>
  );
}

/**
 * 未物化 / 未启用时的**空状态 + 原因 + 物化命令**（R-10.4）。
 *
 * 显示空白图或报错都不行：前者让用户以为「这个指标没有数值」，后者让「还没算」
 * 看起来像「坏了」。这里必须把三件事一起说：状态、原因、下一步命令。
 */
export function IndicatorEmptyState(props: { indicators: IndicatorsDto }) {
  const { indicators } = props;
  return (
    <div className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
      <p style={{ margin: '0 0 4px' }}>{indicators.message ?? '该周期暂无指标。'}</p>
      {indicators.materializeCommand !== null ? (
        <code className="mono" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
          {indicators.materializeCommand}
        </code>
      ) : null}
    </div>
  );
}

export const INDICATOR_INTERVALS: readonly IndicatorInterval[] = ['15m', '1h', '4h', '1d'];

/**
 * 图例。**必须显式列出每个参数集**——「画了几条线」是用户在读图时第一个要确认的事，
 * 而图上一片同色的线没人分得清。
 */
export function IndicatorLegend(props: {
  indicators: IndicatorsDto;
  onToggle?: ((label: string) => void) | undefined;
  hidden?: ReadonlySet<string> | undefined;
}) {
  const { indicators } = props;
  if (indicators.state !== 'ok' || indicators.specs.length === 0) return null;
  return (
    <div className="candle-legend mono" style={{ flexWrap: 'wrap', gap: 8 }}>
      {indicators.specs.map((series) => {
        const off = props.hidden?.has(series.label) ?? false;
        const key = series.label;
        return (
          <button
            key={key}
            className={off ? 'chip' : 'chip active'}
            onClick={() => props.onToggle?.(key)}
            title={`${series.spec.rows.toLocaleString('zh-CN')} 行 · 收盘后可用`}
            style={{ fontSize: 11 }}
          >
            {off ? '○ ' : '● '}
            {series.label}
          </button>
        );
      })}
    </div>
  );
}

/** 副图几何：一个面板在整张图里的上下边界。 */
export interface SubPanelLayout {
  top: number;
  height: number;
  plotLeft: number;
  plotWidth: number;
  t0: number;
  t1: number;
  lo: number;
  hi: number;
}

export function subPanelX(layout: SubPanelLayout, time: number): number {
  return layout.plotLeft + ((time - layout.t0) / (layout.t1 - layout.t0)) * layout.plotWidth;
}

export function subPanelY(layout: SubPanelLayout, value: number): number {
  if (layout.hi <= layout.lo) return layout.top;
  return layout.top + ((layout.hi - value) / (layout.hi - layout.lo)) * layout.height;
}

/** 某个参数集的量程：优先用固定量程（RSI 恒为 0~100），否则按数据自适应并留 5% 余量。 */
export function panelRange(label: string, values: readonly number[]): [number, number] {
  const name = label.split('(')[0]?.toLowerCase() ?? '';
  const fixed = PANEL_RANGE[name];
  if (fixed !== undefined) return [fixed[0], fixed[1]];
  if (values.length === 0) return [0, 1];
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo === hi) {
    const pad = Math.max(Math.abs(lo) * 0.05, 1e-8);
    return [lo - pad, hi + pad];
  }
  const pad = (hi - lo) * 0.05;
  return [lo - pad, hi + pad];
}

/** 缺口统计在图外量化写明时的辅助：给测试与复用。 */
export type { BarDto, IndicatorsDto };