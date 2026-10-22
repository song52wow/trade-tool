import { useLayoutEffect, useState } from 'react';

import { ApiError, api } from '../api.js';
import { fmtDate, fmtNumber } from '../format.js';
import type {
  AgentFacetDto,
  AgentReportDto,
  AgentViewDto,
  TradingPlanDto,
} from '../../../src/types';
import { ConfirmDialog } from './ConfirmDialog.js';

const EMPTY: AgentViewDto = { symbol: '', report: null, plan: null };

function reason(error: unknown): string {
  if (error instanceof ApiError) return `[${error.code}] ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * 校验读到的载荷，形状不对就返回 `null`。
 *
 * 运行时的数据**不保证**符合 TS 类型：中间隔着一次 JSON 往返，而控制面
 * 可能是**改动前启动的旧进程**。若 `report` 是 `undefined` 而不是 `null`，
 * `report !== null` 会放行，紧接着 `report.stance` 就把整页带崩——
 * **一个只读面板不该有这个能力**。
 *
 * 判据是 `symbol` 必须是字符串：它是这份载荷的**判别字段**，
 * 缺了它说明回包根本不是 Agent 视图（旧的 `/api/symbols/X` 详情外壳就是这种）。
 * 形状不符时按「读失败」处理（错误常驻可见），而不是假装「没分析过」。
 */
function parseAgentView(raw: unknown): AgentViewDto | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj['symbol'] !== 'string') return null;
  const report = obj['report'];
  const plan = obj['plan'];
  if (report !== null && report !== undefined && typeof report !== 'object') return null;
  if (plan !== null && plan !== undefined && typeof plan !== 'object') return null;
  return {
    symbol: obj['symbol'],
    report: (report ?? null) as AgentReportDto | null,
    plan: (plan ?? null) as TradingPlanDto | null,
  };
}

/** 立场的中文标签。一律带上原值，避免只显示中文时对不上库里的列。 */
const STANCE_LABEL: Record<AgentReportDto['stance'], string> = {
  bullish: '看多',
  bearish: '看空',
  neutral: '中性',
};

const STANCE_CLASS: Record<AgentReportDto['stance'], string> = {
  bullish: 'tag ok',
  bearish: 'tag error',
  neutral: 'tag',
};

const FACET_LABEL: Record<'technical' | 'sentiment' | 'fundamental', string> = {
  technical: '技术面',
  sentiment: '情绪面',
  fundamental: '基本面',
};

/**
 * 价格格式化：**保留有效精度**，最多 8 位小数。
 *
 * 与止盈止损面板同一个理由：这几个数要拿去和真实下单价对照，显示层把它们抹平
 * 就等于让人对着一个看着对、其实不是那个价的数字做决策。
 */
function fmtPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 8 });
}

function FacetRow(props: { name: string; facet: AgentFacetDto }) {
  const { name, facet } = props;
  return (
    <tr>
      <td style={{ whiteSpace: 'nowrap' }}>{name}</td>
      <td className="mono" style={{ width: 72 }}>
        {facet.score.toFixed(2)}
      </td>
      <td style={{ whiteSpace: 'pre-wrap' }}>
        {facet.notes.length > 0 ? facet.notes.join('\n') : '—'}
      </td>
    </tr>
  );
}

/**
 * 方案当前状态的一句话说明。
 *
 * 这几个态必须**分别**说清楚，因为它们对「仓位到底有没有建立」的含义完全不同：
 * `executing` 是「已认领、正在下单」（那一单到底下没下还不知道），`failed` 是
 * 「下单失败，仓位没建立、止损也没挂」，只有 `executed` 才有单号。
 *
 * 把它们混成一句「已处理」的话，人就没法判断现在该不该手动去交易所撤单。
 */
function PlanStatusLine(props: { plan: TradingPlanDto }) {
  const { plan } = props;
  if (plan.status === 'executing') {
    return (
      <p className="mono" style={{ fontSize: 12, color: 'var(--warn)', margin: '4px 0 0' }}>
        已认领，正在下单——这一单到底下没下还不知道。
      </p>
    );
  }
  if (plan.status === 'executed') {
    return (
      <p className="mono" style={{ fontSize: 12, color: 'var(--ok)', margin: '4px 0 0' }}>
        已成交，交易所单号 {plan.entryOrderId ?? '—'}。
      </p>
    );
  }
  if (plan.status === 'failed') {
    return (
      <p className="mono" style={{ fontSize: 12, color: 'var(--err)', margin: '4px 0 0' }}>
        下单失败：{plan.executionFailureReason ?? '（没写原因）'}——仓位没有建立，止损也没有挂。
      </p>
    );
  }
  if (plan.status === 'expired') {
    return (
      <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>
        已过期：这份方案没被执行器接走，已经作废。
      </p>
    );
  }
  if (plan.status === 'rejected') {
    return (
      <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>
        已驳回：这份方案被人工否决，不会下单。
      </p>
    );
  }
  if (plan.status === 'approved') {
    return (
      <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>
        已批准：等 <code>apps/executor</code> 消费（<code>agent.execute.enabled</code>{' '}
        开着才会下单）。
      </p>
    );
  }
  return null;
}

/**
 * 执行方案（v1.0.0）。
 *
 * 批准 / 驳回要分开说三件事，少一件都会让人做错决定：
 *
 * 1. **批准本身不下单。** 真正的下单由 `apps/executor` 消费 `approved` 的方案完成，
 *    而 executor 只在 `agent.execute.enabled` 开着时才消费。开关关着时，批准只是
 *    「预先批准」，**不会有单下出去**。
 * 2. **限价进场不给批准按钮。** 自动执行只支持市价进场——挂限价单要一直盯着成交，
 *    那是另一套东西，不该混进「批准一下就自动跑」的流程里。
 * 3. **状态如实显示。** 「已认领、正在下单」不等于「已成交」，单号只有真成交才有。
 */
function PlanBlock(props: { plan: TradingPlanDto; symbol: string; onChanged: () => void }) {
  const { plan, symbol, onChanged } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'approved' | 'rejected' | null>(null);

  const decide = (next: 'approved' | 'rejected') => {
    setBusy(true);
    setError(null);
    void api
      .setTradingPlanStatus(symbol, plan.id, next)
      .then(() => {
        setConfirm(null);
        // 重新读一遍：方案状态是服务端的事实，页面不自己复述「我批准了」。
        onChanged();
      })
      .catch((e: unknown) => {
        // 失败常驻显示，并保留方案原样（不假装状态已经改了）。
        setError(reason(e));
        setConfirm(null);
      })
      .finally(() => setBusy(false));
  };

  if (plan.action === 'failed') {
    return (
      <div>
        <p className="mono" style={{ color: 'var(--err)', margin: '4px 0' }}>
          未出方案：{plan.failureReason ?? '（没写原因）'}
        </p>
        <p className="muted" style={{ fontSize: 12 }}>
          这一轮分析师的结论是「{STANCE_LABEL[plan.stance]}」，但交易员这一步没能给出 可执行的方案。
        </p>
      </div>
    );
  }
  if (plan.action === 'hold') {
    return (
      <div>
        <p style={{ margin: '4px 0' }}>这一轮不做。</p>
        <p className="muted" style={{ fontSize: 12 }}>
          {plan.rationale}
        </p>
      </div>
    );
  }
  // 只有「真能执行」的方案才谈得上批准：一份「这一轮不做」的记录没有进场可执行。
  const canDecide = plan.status === 'advisory' || plan.status === 'approved';
  // 「能不能批准」由**服务端**算好传过来（判据只有一份，在 core）：
  // 页面自己判一遍就是第二份实现，措辞迟早漂移。
  // ⚠️ 页面**不能** import `@trade-tool/core`：它的 barrel 带着 node:crypto / node:fs，
  // 浏览器构建会直接失败。
  const notApprovable = !plan.approvable;
  return (
    <div>
      <p style={{ margin: '4px 0' }}>
        <b className="mono">
          {plan.side} {plan.entryType} @ {fmtPrice(plan.entryPrice)}
        </b>
        <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
          数量 {fmtNumber(plan.quantity)} · 名义 {fmtPrice(plan.notional)}
        </span>
      </p>
      <p className="mono" style={{ margin: '2px 0', fontSize: 12 }}>
        止损 {fmtPrice(plan.stopPrice)}　止盈 {fmtPrice(plan.takeProfitPrice)}　R:R{' '}
        {plan.riskReward === null ? '—' : plan.riskReward.toFixed(2)}
      </p>
      <p className="muted" style={{ fontSize: 12, margin: '2px 0' }}>
        这一笔最多亏 {fmtPrice(plan.riskAmount)}
        {plan.riskFraction === null ? '' : `（权益的 ${(plan.riskFraction * 100).toFixed(3)}%）`}
        {plan.equitySource === null ? '' : `　权益来源：${plan.equitySource}`}
      </p>
      <p className="muted" style={{ fontSize: 12, margin: '2px 0' }}>
        理由：{plan.rationale}
      </p>
      {plan.adjustments.map((adjustment) => (
        <p
          key={adjustment}
          className="mono"
          style={{ fontSize: 12, color: 'var(--warn)', margin: '2px 0' }}
        >
          ⚠ 已调整：{adjustment}
        </p>
      ))}
      {plan.status === 'advisory' ? (
        <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>
          这只是建议：还没被批准，不会变成真实订单。
        </p>
      ) : null}
      <PlanStatusLine plan={plan} />
      {notApprovable ? (
        <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>
          {/* 原因用服务端算好的那一份（原样显示，别在页面里复述一遍）。 */}
          {plan.approvableReason}
        </p>
      ) : null}
      {error !== null ? (
        <p className="mono" style={{ fontSize: 12, color: 'var(--err)', margin: '6px 0 0' }}>
          批准 / 驳回失败：{error}
          {/* 失败时方案原样保留，并明说没改：页面不自己复述一个没发生的状态变化。 */}
          （方案状态未改变）
        </p>
      ) : null}
      {canDecide ? (
        <div className="row" style={{ marginTop: 8 }}>
          {/* 不能批准的方案不给批准按钮（自动执行只支持市价进场）。驳回始终可用。 */}
          {plan.approvable ? (
            <button className="primary" disabled={busy} onClick={() => setConfirm('approved')}>
              批准
            </button>
          ) : null}
          <button className="danger" disabled={busy} onClick={() => setConfirm('rejected')}>
            驳回
          </button>
          <span className="muted" style={{ fontSize: 12 }}>
            点了批准只是「预先批准」——单由 <code>apps/executor</code> 在
            <code>agent.execute.enabled</code> 开着时才下。
          </span>
        </div>
      ) : null}

      {confirm === 'approved' ? (
        <ConfirmDialog
          title="批准这份执行方案"
          confirmLabel="确认批准"
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => decide('approved')}
        >
          <p>
            批准<b>本身不下单</b>。真正的下单由 <code>apps/executor</code> 在
            <code>agent.execute.enabled</code> 开着时消费已批准的方案完成。
          </p>
          <p className="muted" style={{ fontSize: 12 }}>
            开关关着时，批准只是「预先批准」，<b>不会有单下出去</b>。
          </p>
        </ConfirmDialog>
      ) : null}

      {confirm === 'rejected' ? (
        <ConfirmDialog
          title="驳回这份执行方案"
          confirmLabel="确认驳回"
          danger
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => decide('rejected')}
        >
          <p>驳回之后这份方案不会被执行器消费，不会下单。</p>
          <p className="muted" style={{ fontSize: 12 }}>
            它只是被标成「已驳回」；要重新评估，等 Agent 跑下一轮出新的方案。
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

/**
 * 分析师报告与执行方案（v1.0.0）：自己取数，**只读本地库**。
 *
 * 刷新跟着全局 `tick` 走，与 K 线同一节奏——页面只有一个真相源，用户关掉自动刷新时
 * 这里也会一起停。
 *
 * 这个面板要回答两个问题：
 *   * 「这个标的现在**怎么看**的？」——三面分数、合成立场、理由；
 *   * 「**怎么做**的？」——进场、仓位、止损。
 *
 * 三种空状态必须分开说：
 *   * 从没分析过 —— 正常状态，Agent 还没跑到这个标的；
 *   * 分析过但这一轮失败 —— 有失败原因，必须显式写出来；
 *   * 报告与方案**不是同一轮** —— 页面分别取「最近一条」，不把它们捆在一起。
 *     捆在一起会让人以为那份方案就是基于那份报告做的。
 */
export function AgentPanel(props: { symbol: string; tick: number }) {
  const [data, setData] = useState<AgentViewDto>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * 批准 / 驳回之后要重新读一遍。
   *
   * 方案状态是**服务端的事实**（executor 可能同时在改它），页面不自己复述
   * 「我批准了」——那会在 executor 抢先一步时变成假话。
   */
  const [refresh, setRefresh] = useState(0);
  const { symbol, tick } = props;

  useLayoutEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api
      .agent(symbol)
      .then((result) => {
        if (cancelled) return;
        const view = parseAgentView(result);
        if (view === null) {
          // 形状不对 = 读失败。**不装作「没分析过」**——那会让一份坏数据
          // 看起来像「Agent 还没跑到这个标的」。
          setData((prev) => ({ ...prev, report: null, plan: null }));
          setError('控制面返回的 Agent 数据形状不对（可能是改动前启动的旧进程），已忽略这份响应');
          return;
        }
        setData(view);
        // 成功即清错：上一轮的失败提示必须能自己消失。
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // 失败时保留上一次读到的内容，并明说是旧的：清空会让「有方案」突然消失。
        setError(reason(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, tick, refresh]);

  const report = data.report;
  const plan = data.plan;

  return (
    <div style={{ marginTop: 18 }}>
      <h2 style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 500 }}>
        分析师与交易员（{report === null && plan === null ? '还没有分析过' : '最近一轮'}）
      </h2>

      {error !== null ? (
        <p className="mono" style={{ fontSize: 12, color: 'var(--err)', margin: '8px 0 0' }}>
          读取 Agent 报告失败：{error}
          {report !== null || plan !== null ? '（下面是上一次读到的内容）' : ''}
        </p>
      ) : null}

      {report === null && plan === null ? (
        <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
          {loading
            ? '正在读取…'
            : `${symbol} 还没有被分析过。跑一次 \`trade-tool agent run -s ${symbol}\`，` +
              '或等 Agent 守护进程跑到它。'}
        </p>
      ) : null}

      {report !== null ? (
        <>
          <p style={{ margin: '6px 0 0' }}>
            <span className={STANCE_CLASS[report.stance]}>{STANCE_LABEL[report.stance]}</span>
            <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
              信心 {report.confidence.toFixed(3)} · 综合分 {report.bias.toFixed(3)} · 一致性{' '}
              {report.agreement.toFixed(3)} · {report.interval} · 数据时刻 {fmtDate(report.asOfMs)}
            </span>
          </p>
          {report.degraded ? (
            <p className="mono" style={{ fontSize: 12, color: 'var(--warn)', margin: '4px 0 0' }}>
              ⚠ 情绪面有数据没取到（资金费率 / 基差 / 持仓量等），这一轮的情绪面分数仅供参考。
            </p>
          ) : null}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>面</th>
                  <th>分数</th>
                  <th>依据</th>
                </tr>
              </thead>
              <tbody>
                <FacetRow name={FACET_LABEL.technical} facet={report.technical} />
                <FacetRow name={FACET_LABEL.sentiment} facet={report.sentiment} />
                <FacetRow name={FACET_LABEL.fundamental} facet={report.fundamental} />
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>
            总体理由：{report.rationale}
          </p>
          {report.atr !== null ? (
            <p className="muted" style={{ fontSize: 12, margin: '2px 0 0' }}>
              当时 ATR {fmtPrice(report.atr)}
              {report.lastClose !== null ? ` · 收盘价 ${fmtPrice(report.lastClose)}` : ''}
            </p>
          ) : null}
        </>
      ) : null}

      {plan !== null ? (
        <>
          <h3 style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 500, marginTop: 14 }}>
            执行方案 #{plan.id}
            {/* 报告按数据时刻 upsert（id 不变），方案每轮新建（id 递增）——
                两个号天然不一样，写清楚这份方案基于哪份报告才对得上。 */}
            {plan.reportId === null ? '' : `（基于报告 #${plan.reportId}）`}
          </h3>
          <PlanBlock plan={plan} symbol={symbol} onChanged={() => setRefresh((n) => n + 1)} />
        </>
      ) : null}
    </div>
  );
}
