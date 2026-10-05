import { useCallback, useLayoutEffect, useState } from 'react';

import { ApiError, api } from '../api.js';
import { fmtDuration, fmtNumber, fmtTime } from '../format.js';
import { CandleChart, GapNotice } from './CandleChart.js';
import type { BarDto, BarsDto } from '../../../src/types';

/**
 * 区间选项是**根数**，不是时间。
 *
 * 周期固定 1m（R-6），两者一一对应；写成根数可以直接变成 SQL 的 LIMIT，不必在前端
 * 先算出时间窗再去对齐分钟边界。标签由根数换算，不另写一份文案。
 */
const RANGES = [60, 300, 720, 1440] as const;
const BAR_MS = 60_000;

const EMPTY: BarsDto = { symbol: '', limit: 0, items: [] };

function reason(error: unknown): string {
  if (error instanceof ApiError) return `[${error.code}] ${error.message}`;
  return error instanceof Error ? error.message : String(error);
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
  /** 库内总行数；用来如实说明「图上这点 vs 库里那堆」 */
  totalRows: number | null;
  hasHistory: boolean;
  tick: number;
}) {
  const [range, setRange] = useState<number>(300);
  const [data, setData] = useState<BarsDto>(EMPTY);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { symbol, hasHistory, tick } = props;

  useLayoutEffect(() => {
    // 库里一行都没有就别发请求：答案已经确定，省一次往返也让空状态更好解释。
    if (!hasHistory) {
      setData(EMPTY);
      setLoadedAt(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void api
      .bars(symbol, range)
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
  }, [symbol, range, tick, hasHistory]);

  const bars: BarDto[] = data.items;
  const truncated = data.limit > 0 && data.limit < range;
  const onRange = useCallback((next: number) => setRange(next), []);

  return (
    <div className="price-chart">
      <div className="chart-head">
        <span className="muted" style={{ fontSize: 12 }}>
          1m K 线（读自本地库）
        </span>
        <div className="spacer" />
        {RANGES.map((n) => (
          <button
            key={n}
            className={range === n ? 'chip active' : 'chip'}
            onClick={() => onRange(n)}
            title={`最近 ${n.toLocaleString('zh-CN')} 分钟`}
          >
            {fmtDuration(n * BAR_MS)}
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
          库里还没有 {props.symbol} 的任何数据。开始同步后这里会随入库进度长出 K 线。
        </p>
      ) : bars.length === 0 ? (
        <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
          {loading ? '正在读取 K 线…' : '这个区间内库里没有数据。'}
        </p>
      ) : (
        <>
          <CandleChart bars={bars} />
          <p className="muted mono" style={{ fontSize: 11, margin: '4px 0 0' }}>
            {loading ? '读取中 · ' : ''}
            {bars.length.toLocaleString('zh-CN')} 根 · {fmtTime(bars[0]?.time)} →{' '}
            {fmtTime(bars[bars.length - 1]?.time)} · 库内共 {fmtNumber(props.totalRows)} 根
            {truncated ? ` · 请求被截断到 ${data.limit.toLocaleString('zh-CN')} 根` : ''}
            {loadedAt === null ? '' : ` · 读取于 ${fmtTime(loadedAt)}`}
          </p>
          <GapNotice bars={bars} />
        </>
      )}
    </div>
  );
}
