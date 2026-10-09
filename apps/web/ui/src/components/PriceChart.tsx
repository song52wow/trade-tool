import type { StoredInterval } from '@trade-tool/core';
import { useCallback, useLayoutEffect, useState } from 'react';

import { ApiError, api } from '../api.js';
import { fmtDuration, fmtNumber, fmtTime } from '../format.js';
import { CandleChart, GapNotice } from './CandleChart.js';
import { IndicatorPanels } from './IndicatorPanels.js';
import { ALL_INTERVALS, EMPTY_BARS, intervalMs, minutesToBars } from './gaps.js';
import type {
  BarDto,
  BarsDto,
  DerivedIntervalDto,
  IndicatorsDto,
} from '../../../src/types';

/**
 * 区间选项是**根数**，不是时间。
 *
 * 1m 与派生周期都按根数表达：写成根数可以直接变成 SQL 的 LIMIT，不必在前端先算出
 * 时间窗再对齐桶边界。标签由根数 × 桶宽换算，不另写一份文案。
 */
const RANGES = [60, 300, 720, 1440] as const;

function reason(error: unknown): string {
  if (error instanceof ApiError) return `[${error.code}] ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * 空状态的原因（R-7.4）。
 *
 * 「这个周期一根都没有」有三种完全不同的处置，页面必须说清是哪一种，否则用户只能猜：
 *   * 该周期尚未收盘——数据末端那个桶还没走完，等下一批 1m 落库就会出现；
 *   * 上游 1m 有缺口——桶被**扣留**了，图上留白才是诚实的（R-3.5）；
 *   * 尚未同步——这个标的压根没有 1m。
 */
function emptyReason(
  symbol: string,
  interval: StoredInterval,
  hasHistory: boolean,
  derived: Record<string, DerivedIntervalDto> | undefined,
): string {
  if (!hasHistory) {
    return `库里还没有 ${symbol} 的任何 1m 数据。开始同步后这里会随入库进度长出 K 线。`;
  }
  if (interval === '1m') return '这个区间内库里没有 1m 数据。';
  const stats = derived?.[interval];
  if (stats === undefined) return `${interval} 暂无已收盘桶。`;
  if ('withheldReason' in stats && stats.withheldReason === 'disabled') {
    return `未启用派生（${interval} 不在 data.aggregateIntervals 里），不会写入任何桶。`;
  }
  if ('withheldReason' in stats) return `${interval} 暂无已收盘桶。`;
  if (stats.buckets === 0 && stats.withheldIncomplete > 0) {
    return (
      `${interval} 一个桶都还没有：该周期全部被扣留，因为上游 1m 缺 ` +
      `${fmtNumber(stats.missingMinutes)} 分钟。缺口补上后同一轮同步就会自动出现，无需重建。`
    );
  }
  if (stats.buckets === 0 && stats.withheldNotClosed > 0) {
    return `${interval} 暂无已收盘桶：数据末端那个桶还没走完，等下一批 1m 落库就会出现。`;
  }
  return `${interval} 在这个区间内没有已收盘的桶。`;
}

/**
 * K 线面板：自己取数，**只读本地库**（`/bars` 不出网、不消耗交易所配额）。
 *
 * 刷新跟着全局的 `tick` 走，而不是自己另开一个定时器：页面已经有一个 5s 的刷新节奏
 * （App 的 `refresh`），图再开一个就等于同一件事有两个真相源，而且用户关掉自动刷新
 * 时图还会继续动——那正是本项目反复在治的「界面显示的和实际发生的不一致」。
 */
export function PriceChart(props: {
  symbol: string;
  /** 库内总行数（1m）；用来如实说明「图上这点 vs 库里那堆」 */
  totalRows: number | null;
  hasHistory: boolean;
  tick: number;
  /** 每周期派生统计，用于空状态原因与缺口的 1m 根因（R-7.4 / R-7.5） */
  derived?: Record<string, DerivedIntervalDto> | undefined;
  /** 重建派生表（R-7.6）：长任务，只登记 id 就返回 */
  onAggregate?: (() => void) | undefined;
  aggregating?: boolean | undefined;
}) {
  const [interval, setInterval] = useState<StoredInterval>('1m');
  const [range, setRange] = useState<number>(300);
  const [data, setData] = useState<BarsDto>(EMPTY_BARS);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 指标：与 K 线同一个 tick 上刷新，同样是**纯读**（不出网、不消耗配额），因此
  // 可以挂在刷新节奏上（R-10.2）。`1m` 没有指标物化，1m 下不发这个请求。
  const [indicators, setIndicators] = useState<IndicatorsDto | undefined>(undefined);
  const [indicatorError, setIndicatorError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set<string>());

  const { symbol, hasHistory, tick, derived } = props;

  useLayoutEffect(() => {
    // 库里一行都没有就别发请求：答案已经确定，省一次往返也让空状态更好解释。
    if (!hasHistory) {
      setData(EMPTY_BARS);
      setLoadedAt(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void api
      .bars(symbol, range, interval)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setLoadedAt(Date.now());
        // 成功即清错：上一轮的失败横幅必须能自己消失。
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // 失败时**保留上一次读到的数据**并明说是旧的：清空会让图突然消失，看起来像
        // 数据被删了（AGENTS.md 第 9 条：不静默兜底）。图注里的读取时间负责说清新鲜度。
        setError(reason(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, range, tick, hasHistory, interval]);

  useLayoutEffect(() => {
    if (!hasHistory || interval === '1m') {
      setIndicators(undefined);
      setIndicatorError(null);
      return;
    }
    let cancelled = false;
    void api
      .indicators(symbol, range, interval)
      .then((result) => {
        if (cancelled) return;
        setIndicators(result);
        setIndicatorError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setIndicatorError(reason(e));
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, range, tick, hasHistory, interval]);

  const onToggle = useCallback((label: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }, []);

  const bars: BarDto[] = data.items;
  const barMs = data.intervalMs > 0 ? data.intervalMs : intervalMs(interval);
  const truncated = data.limit > 0 && data.limit < range;
  const onRange = useCallback((next: number) => setRange(next), []);
  const onInterval = useCallback((next: StoredInterval) => setInterval(next), []);

  // 派生周期的缺口根因：该标的在上游 1m 上**累计**缺了多少分钟（全历史口径）。
  // 它不是本窗口的数字——窗口自己的缺口已经由 GapNotice 按所选周期报过；
  // 这里只回答「为什么会有这些空白」，所以文案必须带上「累计 / 含本区间」。
  const upstreamMissing =
    interval === '1m'
      ? null
      : (() => {
          const stats = derived?.[interval];
          if (stats === undefined || 'withheldReason' in stats) return null;
          return stats.missingMinutes > 0 ? stats.missingMinutes : null;
        })();

  // 该周期**未启用**（不在 `data.aggregateIntervals` 里）。
  // 未启用的周期不能给「重建派生 K 线」按钮：作业读的是同一个配置，
  // 点下去只会重算启用的那几个周期，当前周期照样一根都不会出现——
  // 那是一个按了也不会好的按钮。这里的下一步是改配置，所以只说明原因。
  const intervalDisabled = (() => {
    const stats = derived?.[interval];
    return stats !== undefined && 'withheldReason' in stats;
  })();

  return (
    <div className="price-chart">
      <div className="chart-head">
        <span className="muted" style={{ fontSize: 12 }}>
          {interval} K 线（读自本地库）
        </span>
        {ALL_INTERVALS.map((item) => (
          <button
            key={item}
            className={interval === item ? 'chip active' : 'chip'}
            onClick={() => onInterval(item)}
            title={`切换到 ${item}`}
          >
            {item}
          </button>
        ))}
        <div className="spacer" />
        {RANGES.map((n) => (
          <button
            key={n}
            className={range === n ? 'chip active' : 'chip'}
            onClick={() => onRange(n)}
            title={`最近 ${n.toLocaleString('zh-CN')} 根`}
          >
            {fmtDuration(n * barMs)}
          </button>
        ))}
      </div>

      {error !== null ? (
        <p className="chart-error mono" style={{ fontSize: 11 }}>
          读取 K 线失败：{error}
          {bars.length > 0 ? '（下面是上一次读到的数据）' : ''}
        </p>
      ) : null}

      {!hasHistory ? (
        <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
          {emptyReason(symbol, interval, hasHistory, derived)}
        </p>
      ) : bars.length === 0 ? (
        <div>
          <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
            {loading ? '正在读取 K 线…' : emptyReason(symbol, interval, hasHistory, derived)}
          </p>
          {/* 空状态要给出可执行的下一步，而不是让用户对着空白图猜（R-7.4）。
              但**未启用**的周期没有可执行的重建：作业读的是同一个配置，点了也不会
              写这张表。那种情况下的下一步是改配置，所以只说明原因、不给按钮。 */}
          {interval !== '1m' && !intervalDisabled && props.onAggregate ? (
            <button
              onClick={props.onAggregate}
              disabled={props.aggregating ?? false}
              style={{ marginTop: 8 }}
              title="从库内 1m 重算全部派生桶（只写派生表，不拉数据）"
            >
              {props.aggregating ? '重建中…' : '重建派生 K 线'}
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <CandleChart
            bars={bars}
            barMs={barMs}
            interval={interval}
            {...(indicators !== undefined ? { indicators } : {})}
            hidden={hidden}
          />
          <p className="muted mono" style={{ fontSize: 11, margin: '4px 0 0' }}>
            {loading ? '读取中 · ' : ''}
            {bars.length.toLocaleString('zh-CN')} 根 {interval} · {fmtTime(bars[0]?.time)} →{' '}
            {fmtTime(bars[bars.length - 1]?.time)}
            {interval === '1m'
              ? ` · 库内共 ${fmtNumber(props.totalRows)} 根 1m`
              : ` · 由库内 1m 派生（缺 1 根 = 缺 ${fmtDuration(barMs)}）`}
            {truncated ? ` · 请求被截断到 ${data.limit.toLocaleString('zh-CN')} 根` : ''}
            {loadedAt === null ? '' : ` · 读取于 ${fmtTime(loadedAt)}`}
          </p>
          <GapNotice
            bars={bars}
            barMs={barMs}
            interval={interval}
            upstreamMissingMinutes={upstreamMissing}
          />
          {interval !== '1m' ? (
            <IndicatorPanels
              indicators={indicators}
              bars={bars}
              interval={interval}
              hidden={hidden}
              onToggle={onToggle}
              error={indicatorError}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

/** 供测试与复用：把分钟数按周期换算成根数（避免各处各写一遍公式）。 */
export { minutesToBars };
