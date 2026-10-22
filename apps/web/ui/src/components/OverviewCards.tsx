import type { SyncStatus, SyncSummary } from '@trade-tool/core';

import { fmtBytes, fmtNumber, fmtPercent, fmtAgo } from '../format.js';
import type { DaemonStatusDto } from '../../../src/types';

const COLORS: Record<SyncStatus, string> = {
  running: 'var(--ok)',
  paused: 'var(--muted)',
  error: 'var(--err)',
};

const STATUS_LABEL: Record<SyncStatus, string> = {
  running: '同步中',
  paused: '已暂停',
  error: '出错',
};

/**
 * 三态而不是布尔：处置方式不同。
 * `stale`（心跳超时）该去查日志，`stopped`（没有心跳）该去启动进程——
 * 合成一个「离线」会把两种不同的下一步混成同一句话。
 */
const DAEMON_LABEL: Record<DaemonStatusDto['state'], string> = {
  running: '运行中',
  stale: '心跳超时',
  stopped: '未运行',
};

function Card(props: { label: string; value: string; hint?: string }) {
  return (
    <div className="card">
      <div className="label">{props.label}</div>
      <div className="value">{props.value}</div>
      {props.hint ? <div className="hint">{props.hint}</div> : null}
    </div>
  );
}

export function OverviewCards(props: {
  summary: SyncSummary;
  exchangeCount: number;
  exchangeStale: boolean;
  exchangeAgeMs: number;
  daemon: DaemonStatusDto;
  now: number;
  activeJobs: number;
}) {
  const { summary } = props;
  const statuses: SyncStatus[] = ['running', 'paused', 'error'];
  const total = statuses.reduce((acc, s) => acc + summary.countsByStatus[s], 0);
  const util = summary.rateLimit.utilization;

  return (
    <>
      {/*
        头牌区：先回答「全局现在怎么样」，再给细节。

        状态分布用一条**按比例切开的横条**而不是饼图：三个类别的对比本来就更适合
        条形，饼图要靠角度去比大小；而且条形是纯 CSS，不需要图表库——
        顺带消掉了「图表挂载时读 ResizeObserver 抛错会拖垮整页取数」这个老坑。
      */}
      <section className="hero">
        <div className="hero-main">
          <p className="eyebrow">标的数</p>
          <p className="hero-value">{fmtNumber(summary.symbols)}</p>
          {total > 0 ? (
            <>
              <div
                className="dist-bar"
                role="img"
                aria-label={statuses
                  .map((s) => `${STATUS_LABEL[s]} ${summary.countsByStatus[s]}`)
                  .join('，')}
              >
                {statuses.map((s) =>
                  summary.countsByStatus[s] > 0 ? (
                    <span
                      key={s}
                      style={{
                        width: `${(summary.countsByStatus[s] / total) * 100}%`,
                        background: COLORS[s],
                      }}
                    />
                  ) : null,
                )}
              </div>
              <div className="dist-legend">
                {statuses.map((s) => (
                  <span className="dist-legend-item" key={s}>
                    <span className="dist-swatch" style={{ background: COLORS[s] }} />
                    {STATUS_LABEL[s]} <b>{fmtNumber(summary.countsByStatus[s])}</b>
                  </span>
                ))}
              </div>
            </>
          ) : (
            <p className="hero-hint">还没有任何标的。用下面的输入框添加第一个。</p>
          )}
        </div>

        <div className="hero-side">
          <div className="cards">
            <Card label="已入库行数" value={fmtNumber(summary.totalRows)} hint="klines_1m 全表" />
            <Card label="占用" value={fmtBytes(summary.totalBytes)} hint="含索引" />
            <Card
              label="待回补缺口"
              value={fmtNumber(summary.pendingGaps)}
              hint={summary.pendingGaps > 0 ? '需关注' : '无'}
            />
            <Card
              label="配额用量"
              value={fmtPercent(util)}
              hint={`${fmtNumber(summary.rateLimit.used)} / ${fmtNumber(summary.rateLimit.budgetPerMinute)} 每分钟`}
            />
            <Card
              label="可同步标的"
              value={fmtNumber(props.exchangeCount)}
              hint={
                props.exchangeStale
                  ? '元数据已过期（沿用缓存）'
                  : `exchangeInfo ${fmtAgo(props.now - props.exchangeAgeMs, props.now)}更新`
              }
            />
            <Card
              label="同步进程"
              value={DAEMON_LABEL[props.daemon.state]}
              hint={
                props.daemon.state === 'running' && props.daemon.lastBeatAt !== null
                  ? // fmtAgo 收的是**绝对时间戳**，不是时长；传 now - age 会被当成 1970 年的时间
                    `心跳 ${fmtAgo(props.daemon.lastBeatAt, props.now)} · pid ${props.daemon.pid}`
                  : props.daemon.state === 'stale'
                    ? '心跳超时，去查 apps/sync 日志'
                    : '未运行，开始同步不会拉数据'
              }
            />
            <Card
              label="进行中作业"
              value={fmtNumber(props.activeJobs)}
              hint={props.activeJobs > 0 ? '本进程发起（数据体检）' : '空闲'}
            />
            <Card
              label="全局暂停至"
              value={
                summary.rateLimit.pauseUntil
                  ? new Date(summary.rateLimit.pauseUntil).toLocaleTimeString('zh-CN', {
                      hour12: false,
                    })
                  : '—'
              }
              hint={summary.rateLimit.pauseUntil ? '交易所限频' : '未暂停'}
            />
          </div>
        </div>
      </section>
    </>
  );
}
