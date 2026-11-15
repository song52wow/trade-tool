import { useLayoutEffect, useState } from 'react';

import { ApiError, api } from '../api.js';
import { fmtDate, fmtNumber, fmtPriceExact, fmtTime } from '../format.js';
import type { BracketDto, BracketsDto, BracketStateDto, ReattachDto } from '../../../src/types';
import { ConfirmDialog } from './ConfirmDialog.js';

const EMPTY_COUNTS: Record<BracketStateDto, number> = {
  armed: 0,
  partial_armed: 0,
  trailing: 0,
  take_profit: 0,
  stop_loss: 0,
  cancelled: 0,
  failed: 0,
};

const EMPTY: BracketsDto = {
  symbol: '',
  limit: 20,
  items: [],
  countsByState: EMPTY_COUNTS,
};

function reason(error: unknown): string {
  if (error instanceof ApiError) return `[${error.code}] ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/** 七态的中文标签（v0.7.0 追加两态）。一律带上原值，避免只显示中文时对不上库里的列。 */
const STATE_LABEL: Record<BracketStateDto, string> = {
  armed: '已挂单（两张）',
  partial_armed: '已挂第一段止盈',
  trailing: '移动止损中',
  take_profit: '止盈成交',
  stop_loss: '止损成交',
  cancelled: '已撤销',
  failed: '挂单失败',
};

const STATE_CLASS: Record<BracketStateDto, string> = {
  armed: 'tag running',
  partial_armed: 'tag running',
  trailing: 'tag running',
  take_profit: 'tag ok',
  stop_loss: 'tag error',
  cancelled: 'tag',
  failed: 'tag error',
};

/**
 * 离场价与入场价的百分比距离，保留两位小数。
 *
 * 正负号是给用户看的方向（止盈在上、止损在下），但**不依赖它做判断**——止损位与
 * 入场价的相对高低由 `positionSide` 决定（空头反过来），这里只如实算比值。
 */
function pctOf(entry: number, price: number): string {
  if (!Number.isFinite(entry) || entry === 0) return '—';
  const r = ((price - entry) / Math.abs(entry)) * 100;
  return `${r >= 0 ? '+' : ''}${r.toFixed(2)}%`;
}

/**
 * 止盈止损记录（v0.4.0）：自己取数，**只读本地库**（不下单、不改状态、不出网）。
 *
 * 刷新跟着全局 `tick` 走，与 K 线同一节奏——页面只有一个真相源，用户关掉自动刷新时
 * 这里也会一起停（与 PriceChart 同一个理由）。
 *
 * 这个面板要回答的是「**我的仓位现在有没有保护**」，所以空状态分两种，必须分开说：
 *   * 一条都没有 —— 这个标的还没有过买入成交，属于完全正常；
 *   * 有 failed 但列表里没显示 —— 已被 limit 截断，仍然要显式提醒。
 * 后者正是 `countsByState` 单独查全量的原因：用截断过的 `items` 反推会把最要紧的
 * 一种异常显示成一切正常（v0.4.0 规则 3 / 5）。
 */
export function BracketPanel(props: { symbol: string; tick: number }) {
  const [data, setData] = useState<BracketsDto>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { symbol, tick } = props;

  /**
   * 手动补挂（v1.3.0）。
   *
   * 三步，顺序不能变：**试算 → 确认 → 真的挂**。
   *
   * 试算是必须的：补挂会挂出**真实的条件单**，而触发价一旦被穿过，交易所会立刻
   * 用市价平掉仓位。让用户先看清「要挂哪几张、各多少钱」，再决定要不要挂。
   */
  const [reattach, setReattach] = useState<ReattachDto | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /** 补挂成功后强制重读一次列表。 */
  const [reloadKey, setReloadKey] = useState(0);

  useLayoutEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api
      .brackets(symbol)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        // 成功即清错：上一轮的失败提示必须能自己消失。
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // 失败时保留上一次读到的内容，并明说是旧的：清空会让「有保护单」突然消失，
        // 看起来像是仓位突然没保护了（AGENTS.md 第 9 条：不静默兜底）。
        setError(reason(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, tick, reloadKey]);

  /** 试算：只算不挂，把「要挂什么」显示出来。 */
  async function preview(): Promise<void> {
    setBusy(true);
    try {
      const result = await api.reattach(symbol, true);
      setReattach(result);
      setActionError(null);
      // 只有确实有东西要补时才问「要不要挂」；没有要补的，直接把结论显示出来。
      setConfirming(result.details.length > 0);
    } catch (e: unknown) {
      setActionError(reason(e));
    } finally {
      setBusy(false);
    }
  }

  /** 真的挂。 */
  async function confirmReattach(): Promise<void> {
    setBusy(true);
    try {
      const result = await api.reattach(symbol, false);
      setReattach(result);
      setConfirming(false);
      setActionError(null);
      setReloadKey((key) => key + 1);
    } catch (e: unknown) {
      setActionError(reason(e));
    } finally {
      setBusy(false);
    }
  }

  // 必须逐个兜底，不能裸读 `data.countsByState.failed`：后端字段缺失时（旧进程 /
  // 迁移未应用）那会是 `undefined`，`Cannot read properties of undefined` 会把
  // **整个详情页**一起打挂——一个附加的仓位面板不该有能力弄垮主内容。
  // 与 DerivedTable 的同一处守卫同一个理由。
  const counts = data.countsByState ?? EMPTY_COUNTS;
  const items = data.items ?? [];
  const failedTotal = counts.failed ?? 0;
  // 有 failed 但当前列表一条 failed 都没显示 = 被 limit 截断了，必须仍然提醒。
  const failedHidden = failedTotal - items.filter((b) => b.state === 'failed').length;

  return (
    <div style={{ marginTop: 18 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <h2 style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 500, margin: 0 }}>
          止盈止损（{failedTotal > 0 ? `${failedTotal} 笔失败` : `${items.length} 条记录`}）
        </h2>
        {/*
          补挂是**人工干预**：自动挂单系统出错（用户数据流断了、私有接口被拒、
          单被人在交易所上撤了）之后，仓位会没有保护。这个按钮是那条人工路径的入口。
          它**会真下单**，所以先试算、再确认。
        */}
        <button onClick={() => void preview()} disabled={busy}>
          {busy ? '处理中…' : '补挂止盈止损'}
        </button>
      </div>

      {actionError !== null ? (
        <p className="mono" style={{ fontSize: 12, color: 'var(--err)', margin: '8px 0 0' }}>
          补挂失败：{actionError}
        </p>
      ) : null}

      {reattach !== null && actionError === null ? <ReattachResult result={reattach} /> : null}

      {error !== null ? (
        <p className="mono" style={{ fontSize: 12, color: 'var(--err)', margin: '8px 0 0' }}>
          读取止盈止损记录失败：{error}
          {items.length > 0 ? '（下面是上一次读到的内容）' : ''}
        </p>
      ) : null}

      {/* 五态计数取自**全量**，不受 limit 影响，因此这里总能说清「一共发生了什么」。 */}
      <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>
        {(Object.keys(STATE_LABEL) as BracketStateDto[])
          .filter((state) => counts[state] > 0)
          .map((state) => `${STATE_LABEL[state]} ${fmtNumber(counts[state])}`)
          .join(' · ') || '还没有任何记录。'}
      </p>

      {failedHidden > 0 ? (
        <p className="mono" style={{ fontSize: 12, color: 'var(--err)', margin: '6px 0 0' }}>
          另有 {failedHidden} 笔「挂单失败」不在最近 {data.limit} 条里——这些记录的仓位
          没有保护单，需要人工介入。
        </p>
      ) : null}

      {items.length === 0 ? (
        <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
          {loading
            ? '正在读取止盈止损记录…'
            : `${symbol} 还没有买入成交，因此没有任何止盈止损记录。`}
        </p>
      ) : (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>成交时间</th>
                  <th>方向</th>
                  <th>数量</th>
                  <th>入场价</th>
                  <th>止盈价</th>
                  <th>止损价</th>
                  <th>ATR</th>
                  <th>状态</th>
                  <th>订单号（止盈 / 止损）</th>
                  <th>最后错误</th>
                </tr>
              </thead>
              <tbody>
                {items.map((b) => (
                  <tr key={b.entryOrderId}>
                    <td className="mono" data-label="成交时间" data-cell="primary">
                      {fmtDate(b.entryTime)}
                    </td>
                    <td className="mono" data-label="方向">
                      {b.positionSide}
                    </td>
                    <td data-label="数量">{fmtNumber(b.filledQty)}</td>
                    <td className="mono" data-label="入场价">
                      {fmtPriceExact(b.entryPrice)}
                    </td>
                    <td className="mono" data-label="止盈价">
                      {fmtPriceExact(b.takeProfit)}
                      <div className="muted" style={{ fontSize: 11 }}>
                        {pctOf(b.entryPrice, b.takeProfit)}
                      </div>
                    </td>
                    <td className="mono" data-label="止损价">
                      {/* `trailing` 行要显示**当前生效的那一档**，而不是入场时的原始止损：
                          显示后者会让人以为移动止损一直没动过。 */}
                      {fmtPriceExact(
                        b.state === 'trailing' && b.trailStopPrice ? b.trailStopPrice : b.stopPrice,
                      )}
                      <div className="muted" style={{ fontSize: 11 }}>
                        {pctOf(
                          b.entryPrice,
                          b.state === 'trailing' && b.trailStopPrice
                            ? b.trailStopPrice
                            : b.stopPrice,
                        )}
                      </div>
                      {/* 没移动 / 移动失败的原因必须常驻可见（约定 9），不能只打日志。 */}
                      {b.trailLastError !== null && (
                        <div className="muted" style={{ fontSize: 11 }}>
                          {b.trailLastError}
                        </div>
                      )}
                    </td>
                    <td className="mono" data-label="ATR">
                      {fmtNumber(b.atr)}
                      <div className="muted" style={{ fontSize: 11 }}>
                        {b.atrInterval} · {b.atrPeriod}
                      </div>
                      {/* ATR 取数窗口只含**已收盘** bar（v0.4.0 规则 1），按记录各自显示：
                          每笔成交的窗口都不同，写成一句共用的说明反而对不上行。 */}
                      <div className="muted" style={{ fontSize: 11 }}>
                        {fmtTime(b.atrWindowFrom)} → {fmtTime(b.atrWindowTo)}
                      </div>
                    </td>
                    <td data-label="状态">
                      <span className={STATE_CLASS[b.state]}>{STATE_LABEL[b.state]}</span>
                      <div className="muted" style={{ fontSize: 11 }}>
                        {b.state}
                      </div>
                    </td>
                    {/* 两张单要么都挂上要么都不挂（v0.4.0 规则 5）。因此「只有止盈号、
                        没有止损号」本身就是异常，必须显式说破，不能把 null 渲染成
                        和「已成交后被交易所撤单」同样的「—」。 */}
                    <td className="mono" data-label="订单号（止盈 / 止损）">
                      {fmtNumber(b.tpAlgoId)} / {fmtNumber(b.slAlgoId)}
                      {(b.tpAlgoId === null) !== (b.slAlgoId === null) ? (
                        <div style={{ color: 'var(--err)', fontSize: 11 }}>单号不成对</div>
                      ) : null}
                    </td>
                    <td
                      className="mono"
                      data-label="最后错误"
                      style={
                        b.lastError !== null ? { color: 'var(--err)' } : { color: 'var(--muted)' }
                      }
                    >
                      {b.lastError ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {confirming && reattach !== null ? (
        <ConfirmDialog
          title={`补挂 ${symbol} 的止盈止损`}
          confirmLabel="确认补挂（真下单）"
          danger
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void confirmReattach()}
        >
          <p>下面这些是**即将挂到交易所上**的真实条件单：</p>
          <ul style={{ fontSize: 12, margin: '8px 0' }}>
            {reattach.details.map((detail, index) => (
              <li key={`${detail.kind}-${String(index)}`}>{detail.reason}</li>
            ))}
          </ul>
          <p className="muted" style={{ fontSize: 12 }}>
            条件单是<b>市价</b>平仓单：触发价一旦被穿过，交易所会立刻用市价平掉仓位。
            补挂本身不改仓位，只补上缺失的那张保护单。
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

/** 试算 / 补挂的结果。**每一条都要有说法**——没有「无声跳过」这一档。 */
function ReattachResult(props: { result: ReattachDto }) {
  const { result } = props;
  // 后端字段缺失时（旧进程）不能当成「有拒绝」——那会显示一句 `undefined`。
  const refusal = result.refusal ?? null;
  const tp1FillRecorded = result.tp1FillRecorded ?? null;
  if (refusal === null && result.details.length === 0 && result.skips.length === 0) {
    return (
      <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>
        {result.symbol} 的仓位有保护，不需要补挂。
      </p>
    );
  }
  return (
    <div style={{ marginTop: 10 }}>
      {/*
        「拒绝补挂」要**显眼**：它是「该补但不敢补」（比如仓位数量与记录对不上，
        照记录补可能重复减仓）。藏在一堆灰色小字里，等于没有提示（约定 9）。
      */}
      {refusal !== null ? (
        <p className="mono" style={{ fontSize: 12, margin: '4px 0 0', color: 'var(--err)' }}>
          ✘ {result.symbol}：{refusal}
        </p>
      ) : null}
      {result.details.map((detail, index) => (
        <p
          key={`${detail.kind}-${String(index)}`}
          className="mono"
          style={{
            fontSize: 12,
            margin: '4px 0 0',
            color:
              detail.outcome === 'failed'
                ? 'var(--err)'
                : detail.outcome === 'placed'
                  ? 'var(--ok)'
                  : 'var(--muted)',
          }}
        >
          {detail.outcome === 'placed'
            ? '✔'
            : detail.outcome === 'failed'
              ? '✘'
              : detail.outcome === 'dry-run'
                ? '·'
                : '—'}{' '}
          {detail.reason}
          {detail.tpAlgoId !== undefined || detail.slAlgoId !== undefined
            ? `（止盈 ${fmtNumber(detail.tpAlgoId)}，止损 ${fmtNumber(detail.slAlgoId)}）`
            : ''}
        </p>
      ))}
      {tp1FillRecorded !== null ? (
        <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>
          ℹ {tp1FillRecorded}
        </p>
      ) : null}
      {result.skips.map((skip, index) => (
        <p
          key={`skip-${String(index)}`}
          className="muted"
          style={{ fontSize: 12, margin: '4px 0 0' }}
        >
          — {skip.reason}
        </p>
      ))}
    </div>
  );
}

export type { BracketDto };
