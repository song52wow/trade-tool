import { useLayoutEffect, useState } from 'react';

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

/** 快照多久算「还新鲜」。超过就标黄，而不是继续当成当前状态显示。 */
const STALE_AFTER_MS = 15 * 60_000;

/**
 * 交易对账（v0.6.0）：交易所真实持仓/挂单 vs 本地止盈止损记录。
 *
 * **默认显示的是自动对账的结果**，不是用户点一下才算数：`apps/executor` 每
 * `executor.reconcileIntervalMs`（默认 5 分钟）跑一次全账户对账并把快照落库，
 * 本面板只读那张表——它因此可以安全地跟着全局刷新节奏走。
 *
 * 按钮保留下来是「我现在就想看一眼」的补充：它会立刻出网重查一次并覆盖快照。
 * 注意这两条路径的性质不同——自动那条已经把请求花在别处了，手动这条要现花。
 *
 * 读的是**快照**，所以「查询时间」必须常驻可见，过期还要标出来：
 * 一份十分钟前的「一致」不该长得和刚查出来的一样。
 *
 * 对账**只报告**：不会下单、撤单或修改本地状态，处置一律人工决定。
 */
export function ReconcilePanel(props: { symbol: string; tick: number }) {
  const { symbol, tick } = props;
  const [report, setReport] = useState<ReconcileReport | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    let cancelled = false;
    void api
      .latestReconcile()
      .then((result) => {
        if (cancelled) return;
        setReport(result.report);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // 失败时保留上一次读到的内容：清空会让「有保护单」突然消失，
        // 看起来像是仓位突然没保护了（AGENTS.md 第 9 条：不静默兜底）。
        setError(reason(e));
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, tick]);

  async function runNow(): Promise<void> {
    setRunning(true);
    setError(null);
    try {
      setReport(await api.reconcile(symbol));
    } catch (e: unknown) {
      setError(reason(e));
    } finally {
      setRunning(false);
    }
  }

  // 自动对账是**全账户**跑的一份快照，这里只显示本标的的差异。
  // 过滤是视图行为，不是判据——判据仍只有 core 那一份（AGENTS.md：判据唯一实现）。
  const mine = (report?.differences ?? []).filter((d) => d.symbol === symbol);
  const age = report === null ? null : Date.now() - report.checkedAt;
  const stale = age !== null && age > STALE_AFTER_MS;

  return (
    <div style={{ marginTop: 18 }}>
      <h2 style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 500 }}>
        交易对账（交易所 vs 本地记录）
      </h2>

      <p className="muted" style={{ fontSize: 12, margin: '6px 0' }}>
        由 <code>apps/executor</code> 每 5 分钟自动对账一次（全账户），下面是最近一次快照。
        「立即对账」会**当场出网重查并覆盖它**——对账**只报告**，不会下单、撤单或修改本地状态。
      </p>

      <div style={{ margin: '8px 0' }}>
        <button onClick={() => void runNow()} disabled={running}>
          {running ? '查询中…' : '立即对账'}
        </button>
      </div>

      {error !== null ? (
        <p className="mono" style={{ fontSize: 12, color: 'var(--err)', margin: '8px 0 0' }}>
          {error}
          {report !== null ? '（下面是上一次读到的快照）' : ''}
        </p>
      ) : null}

      {!loaded ? null : report === null ? (
        <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>
          {symbol} 还没有自动对账记录。
          {error === null ? '确认 apps/executor 正在运行（自动对账在它里面），或点上面的「立即对账」。' : ''}
        </p>
      ) : (
        <div>
          <p className="mono" style={{ fontSize: 12, margin: '8px 0 0' }}>
            快照时间 {fmtDate(report.checkedAt)} {fmtTime(report.checkedAt)}
            {stale ? '（已过期，请以「立即对账」为准）' : ''} · 本地未终结记录{' '}
            {fmtNumber(report.scope.localUnsettled)} 条 · 交易所持仓{' '}
            {fmtNumber(report.scope.exchangePositions)} 个 · 挂单{' '}
            {fmtNumber(report.scope.exchangeAlgoOrders)} 张
          </p>

          {report.healthy ? (
            <p style={{ fontSize: 13, color: 'var(--ok)', margin: '6px 0 0' }}>
              ✔ 全账户一致：交易所的持仓与挂单同本地记录对得上。
            </p>
          ) : (
            <>
              <p style={{ fontSize: 13, color: 'var(--err)', margin: '6px 0' }}>
                全账户 {report.counts.total} 处差异：紧急 {report.counts.critical} · 注意{' '}
                {report.counts.warning}
              </p>
              {mine.length === 0 ? (
                <p className="muted" style={{ fontSize: 12 }}>
                  本标的（{symbol}）不在差异列表里——上面的差异属于其它标的。
                </p>
              ) : null}
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {mine.map((item) => (
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