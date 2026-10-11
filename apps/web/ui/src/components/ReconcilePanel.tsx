import { useState } from 'react';

import { ApiError, api } from '../api.js';
import { fmtDate, fmtNumber, fmtTime } from '../format.js';
import type { ReconcileDifference, ReconcileKind, ReconcileReport } from '../../../src/types';

function reason(error: unknown): string {
  if (error instanceof ApiError) return `[${error.code}] ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * 差异类型的中文标签。
 *
 * 一律带上原值：读代码 / 查库时用的是 `kind` 的英文，界面上只给中文会让两边对不上，
 * 而「对不上」正是这个面板要解决的事情本身。
 */
const KIND_LABEL: Record<ReconcileKind, string> = {
  'missing-stop-order': '本地记为已挂单，但交易所没有止损单',
  'unprotected-position': '有一笔入场成交没挂上任何保护单',
  'position-without-record': '交易所有仓位，本地没有对应记录',
  'missing-take-profit-order': '止盈单已不在交易所',
  'price-mismatch': '触发价与本地记录不一致',
  'record-without-position': '本地记为已挂单，但交易所已无仓位',
  'orphan-algo-order': '交易所挂着我方单，但本地没有记录引用它',
};

/** 严重度用两档而不是三档：`critical` 是「仓位当前没有止损」，其余都归 `warning`。 */
const SEVERITY_LABEL: Record<'critical' | 'warning', string> = {
  critical: '紧急',
  warning: '注意',
};

function evidenceOf(item: ReconcileDifference): string {
  return Object.entries(item.evidence)
    .filter(([, value]) => value !== null && value !== '')
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('  ');
}

/**
 * 交易对账（v0.6.0）：交易所真实持仓/挂单 vs 本地止盈止损记录。
 *
 * **刻意不自动刷新**，与本页其它面板都不同：那条接口要签名访问交易所私有接口，
 * 出网且消耗请求权重。挂上 5s 节奏就等于每秒问交易所两次要什么——所以这里只有一个
 * 按钮，点了才查，查完就地显示快照时间。快照**会过期**，因此「查询时间」必须常驻可见：
 * 一份十分钟前的「一致」不该长得和刚查出来的一样。
 *
 * 它与「止盈止损」面板的关系：后者只读本地表，回答「我们记了什么」；这个回答
 * 「交易所现在到底是什么」。本地记着已挂单、而交易所那张单早没了，只有后者能发现。
 *
 * 对账**只报告**：不会下单、撤单或改本地状态，处置一律人工决定。
 */
export function ReconcilePanel(props: { symbol: string }) {
  const { symbol } = props;
  const [report, setReport] = useState<ReconcileReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 换标的时清空上一份结果：留着 A 标的的「一致」显示在 B 标的上比什么都不显示更危险
  // ——它会让人以为 B 也查过了。靠父组件的 `key={symbol}` 重新挂载实现（渲染期不做副作用）。

  async function run(): Promise<void> {
    setRunning(true);
    setError(null);
    try {
      setReport(await api.reconcile(symbol));
    } catch (e: unknown) {
      // 失败时**保留**上一次的结果，并明说它是旧的：清空会让「有保护单」突然消失，
      // 看起来像是仓位突然没保护了（AGENTS.md 第 9 条：不静默兜底）。
      setError(reason(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div style={{ marginTop: 18 }}>
      <h2 style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 500 }}>
        交易对账（交易所 vs 本地记录）
      </h2>

      <p className="muted" style={{ fontSize: 12, margin: '6px 0' }}>
        按需查询，不自动刷新：每次查询都要签名访问交易所私有接口并消耗请求配额。
        对账**只报告**——不会下单、撤单或修改本地状态，处置请人工确认。
      </p>

      <div style={{ margin: '8px 0' }}>
        <button onClick={() => void run()} disabled={running}>
          {running ? '查询中…' : '开始对账'}
        </button>
      </div>

      {error !== null ? (
        <p className="mono" style={{ fontSize: 12, color: 'var(--err)', margin: '8px 0 0' }}>
          对账失败：{error}
          {report !== null ? '（下面是上一次查到的快照）' : ''}
        </p>
      ) : null}

      {report === null ? null : (
        <div>
          <p className="mono" style={{ fontSize: 12, margin: '8px 0 0' }}>
            快照时间 {fmtDate(report.checkedAt)} {fmtTime(report.checkedAt)} · 本地未终结记录{' '}
            {fmtNumber(report.scope.localUnsettled)} 条 · 交易所持仓{' '}
            {fmtNumber(report.scope.exchangePositions)} 个 · 挂单{' '}
            {fmtNumber(report.scope.exchangeAlgoOrders)} 张
          </p>

          {report.healthy ? (
            <p style={{ fontSize: 13, color: 'var(--ok)', margin: '6px 0 0' }}>
              ✔ 一致：交易所的持仓与挂单同本地记录对得上。
            </p>
          ) : (
            <>
              <p style={{ fontSize: 13, color: 'var(--err)', margin: '6px 0' }}>
                {report.counts.total} 处差异：紧急 {report.counts.critical} · 注意{' '}
                {report.counts.warning}
              </p>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {report.differences.map((item) => (
                  <li key={`${item.kind}:${item.entryOrderId ?? '-'}`} style={{ marginBottom: 8 }}>
                    <span className="tag error" style={{ marginRight: 6 }}>
                      {SEVERITY_LABEL[item.severity]}
                    </span>
                    <strong>{KIND_LABEL[item.kind]}</strong>
                    <div style={{ fontSize: 12 }}>{item.message}</div>
                    <div className="mono muted" style={{ fontSize: 11 }}>
                      {item.entryOrderId ?? '（无入场单号）'} · {evidenceOf(item)}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
