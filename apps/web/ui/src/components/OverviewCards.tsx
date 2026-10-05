import type { SyncStatus, SyncSummary } from '@trade-tool/core';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

import { fmtBytes, fmtNumber, fmtPercent, fmtAgo } from '../format.js';
import type { DaemonStatusDto } from '../../../src/types';

const COLORS: Record<SyncStatus, string> = {
  running: '#3fb950',
  paused: '#6e7681',
  error: '#f85149',
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
      {props.hint ? <div className="muted mono">{props.hint}</div> : null}
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
  const pie = statuses.map((s) => ({
    name: STATUS_LABEL[s],
    status: s,
    value: summary.countsByStatus[s],
  }));
  const total = statuses.reduce((acc, s) => acc + summary.countsByStatus[s], 0);
  const util = summary.rateLimit.utilization;

  return (
    <>
      <div className="cards">
        <Card
          label="标的数"
          value={fmtNumber(summary.symbols)}
          hint={`${STATUS_LABEL.running} ${summary.countsByStatus.running} · ${STATUS_LABEL.error} ${summary.countsByStatus.error}`}
        />
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

      {total > 0 ? (
        <div className="panel">
          <h2>状态分布</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
            <div style={{ width: 180, height: 180 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pie}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={52}
                    outerRadius={78}
                    paddingAngle={2}
                    isAnimationActive={false}
                  >
                    {pie.map((entry) => (
                      <Cell key={entry.status} fill={COLORS[entry.status]} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              {statuses.map((s) => (
                <div key={s} className="row" style={{ gap: 10 }}>
                  <span
                    className="tag"
                    style={{
                      color: COLORS[s],
                      borderColor: COLORS[s],
                      minWidth: 56,
                      textAlign: 'center',
                    }}
                  >
                    {STATUS_LABEL[s]}
                  </span>
                  <span>{fmtNumber(summary.countsByStatus[s])}</span>
                </div>
              ))}
              <div className="row muted mono" style={{ gap: 10, paddingTop: 4 }}>
                <span style={{ minWidth: 56 }}>配额窗口</span>
                <span>
                  {new Date(summary.rateLimit.windowFrom).toLocaleTimeString('zh-CN', {
                    hour12: false,
                  })}
                </span>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
