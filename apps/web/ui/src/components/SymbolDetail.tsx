import { fmtAgo, fmtDate, fmtNumber, fmtTime } from '../format.js';
import type { DerivedIntervalDto } from '../../../src/types';
import type { SymbolDetailDto } from '../../../src/types';
import { CoverageChart } from './CoverageChart.js';
import { ALL_INTERVALS } from './gaps.js';
import { PriceChart } from './PriceChart.js';

export function SymbolDetail(props: {
  detail: SymbolDetailDto;
  now: number;
  /** 全表体检（verify）进行中 */
  verifying: boolean;
  onVerify: () => void;
  /** 重建派生表（aggregate）进行中 */
  aggregating: boolean;
  onAggregate: () => void;
  /** 随全局刷新递增，K 线图跟着它更新 */
  tick: number;
}) {
  const {
    state,
    coverage,
    contract,
    gaps,
    exchange,
    desiredState,
    inCollection,
    hasHistory,
    derived,
  } = props.detail;
  return (
    <div>
      {/* K 线放在最上面：这个面板回答的第一个问题是「同步下来的数据长什么样」，
          覆盖时间线与合约规格是它的补充说明。 */}
      <div>
        <h2 style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 500 }}>K 线</h2>
        <PriceChart
          symbol={props.detail.symbol}
          totalRows={state?.rows ?? null}
          hasHistory={hasHistory}
          tick={props.tick}
          derived={derived}
          onAggregate={props.onAggregate}
          aggregating={props.aggregating}
        />
      </div>

      {/* 派生周期表（R-7.5 / AC-15）：回答「为什么没有 4h 蜡烛」。
          数字由 SQL 从 1m 推导，库里没有扣留表——与图上的留白同源。 */}
      <DerivedTable
        derived={derived}
        aggregating={props.aggregating}
        onAggregate={props.onAggregate}
      />

      <div className="grid2" style={{ marginTop: 18 }}>
        <div>
          <h2 style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 500 }}>覆盖时间线</h2>
          <CoverageChart coverage={coverage} />
          <p className="muted mono" style={{ fontSize: 11 }}>
            起点 {fmtDate(coverage.onboardDate)} · 最早入库 {fmtDate(coverage.earliest)} · 水位{' '}
            {fmtTime(coverage.watermark)} · 已验证 {fmtTime(coverage.verifiedUpTo)}
          </p>
        </div>
        <div>
          <h2 style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 500 }}>合约与状态</h2>
          <dl className="kv">
            <dt>交易所</dt>
            <dd className="mono">{exchange}</dd>
            <dt>合约类型</dt>
            <dd className="mono">{contract?.contractType ?? '未知'}</dd>
            <dt>交易状态</dt>
            <dd className="mono">{contract?.status ?? '未知'}</dd>
            <dt>上市时间</dt>
            <dd className="mono">{fmtDate(coverage.onboardDate)}</dd>
            <dt>期望状态</dt>
            <dd className="mono">{desiredState ?? '未加入集合'}</dd>
            <dt>实际状态</dt>
            <dd className="mono">{state?.status ?? '未开始'}</dd>
            <dt>已入库行数</dt>
            <dd className="mono">{fmtNumber(state?.rows)}</dd>
            <dt>最近一次运行</dt>
            <dd className="mono">{fmtAgo(state?.lastRunAt, props.now)}</dd>
            <dt>最近一次成功</dt>
            <dd className="mono">{fmtAgo(state?.lastSuccessAt, props.now)}</dd>
            {state?.lastError ? (
              <>
                <dt style={{ color: 'var(--err)' }}>最近错误</dt>
                <dd className="mono" style={{ whiteSpace: 'pre-wrap' }}>
                  {state.lastError}
                </dd>
              </>
            ) : null}
            {state && state.errorCount > 0 ? (
              <>
                <dt>连续失败</dt>
                <dd className="mono">{state.errorCount}</dd>
              </>
            ) : null}
          </dl>
        </div>
      </div>

      {/* 数据体检放在详情里而不是行内：它是低频的重操作（全表扫描，成本随数据量增长），
          产出 verified_upto / pending_gaps 平时没人看；行内只保留同步这一个主流程。 */}
      <div className="verify-box">
        <div>
          <strong>数据体检</strong>
          <p className="muted" style={{ margin: '4px 0 0', fontSize: 12 }}>
            全表扫描一次，重建「已验证到哪里」基线并登记缺口。例行同步只看最近 7 天，
            <strong>更早的漏行只有它能发现</strong>。只读本地库，不出网、不消耗交易所配额、不写 K
            线。
          </p>
        </div>
        <button
          disabled={props.verifying || !inCollection || !hasHistory}
          title={
            !inCollection
              ? '先加入集合才能执行'
              : !hasHistory
                ? '库内没有该标的的任何数据，无法体检'
                : '开始全表扫描'
          }
          onClick={props.onVerify}
        >
          {props.verifying ? '体检中…' : '开始体检'}
        </button>
      </div>

      <h2 style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 500, marginTop: 18 }}>
        缺口清单（{gaps.length}）
      </h2>
      {gaps.length === 0 ? (
        <p className="muted">没有登记中的缺口。</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>起点</th>
              <th>终点</th>
              <th>缺失行数</th>
              <th>已尝试</th>
              <th>最近尝试</th>
              <th>最近错误</th>
            </tr>
          </thead>
          <tbody>
            {gaps.map((g) => (
              <tr key={`${g.gapStart}-${g.gapEnd}`}>
                <td className="mono">{fmtTime(g.gapStart)}</td>
                <td className="mono">{fmtTime(g.gapEnd)}</td>
                <td>{fmtNumber(g.missingRows)}</td>
                <td>{g.attempts}</td>
                <td className="muted">{fmtAgo(g.lastAttemptAt, props.now)}</td>
                <td className="muted mono" style={{ whiteSpace: 'pre-wrap' }}>
                  {g.lastError ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * 每周期的桶数与扣留原因（v0.2.0 R-7.5 / AC-15）。
 *
 * 「被扣留」必须**说清是哪一种**：
 *   * 未收盘 —— 数据末端那个桶还没走完，等下一批 1m 落库就出现；
 *   * 未全覆盖 —— 桶内上游 1m 有缺口，写进去就是一根半截蜡烛（R-3.5）。
 * 只给一个总数的话，用户看到「少 3 根」仍然不知道该等还是该查缺口。
 */
function DerivedTable(props: {
  derived: Record<string, DerivedIntervalDto>;
  aggregating: boolean;
  onAggregate: () => void;
}) {
  return (
    <div className="verify-box" style={{ marginTop: 18 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <strong>派生周期</strong>
        <table style={{ marginTop: 6 }}>
          <thead>
            <tr>
              <th>周期</th>
              <th>已入库桶</th>
              <th>未收盘扣留</th>
              <th>未全覆盖扣留</th>
              <th>缺失 1m 分钟</th>
            </tr>
          </thead>
          <tbody>
            {ALL_INTERVALS.filter((i) => i !== '1m').map((interval) => {
              const stats = props.derived[interval];
              if (stats === undefined) {
                return (
                  <tr key={interval}>
                    <td className="mono">{interval}</td>
                    <td colSpan={4} className="muted">
                      读取中…
                    </td>
                  </tr>
                );
              }
              if ('withheldReason' in stats) {
                return (
                  <tr key={interval}>
                    <td className="mono">{interval}</td>
                    <td colSpan={4} className="muted">
                      未启用派生（aggregateIntervals 为空）
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={interval}>
                  <td className="mono">{interval}</td>
                  <td>{fmtNumber(stats.buckets)}</td>
                  <td>{fmtNumber(stats.withheldNotClosed)}</td>
                  <td style={stats.withheldIncomplete > 0 ? { color: 'var(--warn)' } : undefined}>
                    {fmtNumber(stats.withheldIncomplete)}
                  </td>
                  <td style={stats.missingMinutes > 0 ? { color: 'var(--warn)' } : undefined}>
                    {fmtNumber(stats.missingMinutes)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="muted" style={{ margin: '6px 0 0', fontSize: 12 }}>
          只写「已收盘且 1m 全覆盖」的桶；未收盘的等下一批，1m 有缺口的被扣留并在图上留白
          （不插值、不写半截蜡烛）。数字由 SQL 从 1m 推导，库里没有单独的扣留表。
        </p>
      </div>
      <button
        disabled={props.aggregating}
        title="从库内 1m 重算全部派生桶（只写派生表，不拉数据、不消耗配额）"
        onClick={props.onAggregate}
      >
        {props.aggregating ? '重建中…' : '重建派生表'}
      </button>
    </div>
  );
}
