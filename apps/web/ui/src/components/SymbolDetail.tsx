import { fmtAgo, fmtDate, fmtNumber, fmtTime } from '../format.js';
import type { SymbolDetailDto } from '../../../src/types';
import { CoverageChart } from './CoverageChart.js';

export function SymbolDetail(props: {
  detail: SymbolDetailDto;
  now: number;
  /** 全表体检（verify）进行中 */
  verifying: boolean;
  onVerify: () => void;
}) {
  const { state, coverage, contract, gaps, exchange, desiredState, inCollection, hasHistory } =
    props.detail;
  return (
    <div>
      <div className="grid2">
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
