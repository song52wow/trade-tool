import { useLayoutEffect, useState } from 'react';

import { ApiError, api } from '../api.js';
import { fmtDate, fmtNumber, fmtTime } from '../format.js';
import type { BracketDto, BracketsDto, BracketStateDto } from '../../../src/types';

const EMPTY_COUNTS: Record<BracketStateDto, number> = {
  armed: 0,
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

/** 五态的中文标签。状态多、含义各不相同，一律带上原值，避免只显示中文时对不上库里的列。 */
const STATE_LABEL: Record<BracketStateDto, string> = {
  armed: '已挂单',
  take_profit: '止盈成交',
  stop_loss: '止损成交',
  cancelled: '已撤销',
  failed: '挂单失败',
};

const STATE_CLASS: Record<BracketStateDto, string> = {
  armed: 'tag running',
  take_profit: 'tag ok',
  stop_loss: 'tag error',
  cancelled: 'tag',
  failed: 'tag error',
};

/**
 * 价格格式化：**保留有效精度**，最多 8 位小数，不补尾零。
 *
 * 不能用 `fmtNumber`——它走 `toLocaleString`，对 `0.00123` 这类价格会四舍五入成
 * 舍入后的样子。止盈止损面板上的三个数都是要拿去和下单价对照的，显示层把它们
 * 抹平就等于让用户对着一个看着对、其实不是那个价的数字做决策。
 */
function fmtPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 8 });
}

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
  }, [symbol, tick]);

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
      <h2 style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 500 }}>
        止盈止损（{failedTotal > 0 ? `${failedTotal} 笔失败` : `${items.length} 条记录`}）
      </h2>

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
                    <td className="mono">{fmtDate(b.entryTime)}</td>
                    <td className="mono">{b.positionSide}</td>
                    <td>{fmtNumber(b.filledQty)}</td>
                    <td className="mono">{fmtPrice(b.entryPrice)}</td>
                    <td className="mono">
                      {fmtPrice(b.takeProfit)}
                      <div className="muted" style={{ fontSize: 11 }}>
                        {pctOf(b.entryPrice, b.takeProfit)}
                      </div>
                    </td>
                    <td className="mono">
                      {fmtPrice(b.stopPrice)}
                      <div className="muted" style={{ fontSize: 11 }}>
                        {pctOf(b.entryPrice, b.stopPrice)}
                      </div>
                    </td>
                    <td className="mono">
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
                    <td>
                      <span className={STATE_CLASS[b.state]}>{STATE_LABEL[b.state]}</span>
                      <div className="muted" style={{ fontSize: 11 }}>
                        {b.state}
                      </div>
                    </td>
                    {/* 两张单要么都挂上要么都不挂（v0.4.0 规则 5）。因此「只有止盈号、
                        没有止损号」本身就是异常，必须显式说破，不能把 null 渲染成
                        和「已成交后被交易所撤单」同样的「—」。 */}
                    <td className="mono">
                      {fmtNumber(b.tpOrderId)} / {fmtNumber(b.slOrderId)}
                      {(b.tpOrderId === null) !== (b.slOrderId === null) ? (
                        <div style={{ color: 'var(--err)', fontSize: 11 }}>单号不成对</div>
                      ) : null}
                    </td>
                    <td
                      className="mono"
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
    </div>
  );
}

export type { BracketDto };
