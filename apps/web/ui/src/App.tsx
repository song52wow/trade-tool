import type { RemovePolicy, SyncPlanEstimate } from '@trade-tool/core';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { ApiError, api } from './api.js';
import { fmtAgo, fmtDuration, fmtNumber, fmtPercent } from './format.js';
import { ConfirmDialog } from './components/ConfirmDialog.js';
import { OverviewCards } from './components/OverviewCards.js';
import { SymbolDetail } from './components/SymbolDetail.js';
import { SymbolPicker } from './components/SymbolPicker.js';
import { SymbolTable } from './components/SymbolTable.js';
import type { JobDto, OverviewDto, SymbolDetailDto, SymbolRowDto } from '../../src/types';

const REFRESH_MS = 5_000;

type Toast = { id: number; text: string; kind: 'ok' | 'err' };

type Pending =
  /**
   * 首次全量：先算规模再确认（R-8.3 硬约束），确认后只写意图，由守护进程执行。
   * 存整个 `estimate` 而不是只存 `bars`：请求数 / 权重 / 耗时都是**服务端算出来的**，
   * 页面自己按 1500 与 1920 重算一遍等于把同一套规则维护两份，改一处就会悄悄对不上。
   */
  | { kind: 'startFirstPull'; symbol: string; estimate: SyncPlanEstimate }
  /** 守护进程不在线：意图会记录但不会拉数据，必须说清楚再让用户决定 */
  | { kind: 'startOffline'; symbol: string }
  | { kind: 'verify'; symbol: string }
  | { kind: 'aggregate'; symbol: string; target: number }
  | { kind: 'remove'; symbol: string; policy: RemovePolicy };

export function App() {
  const [overview, setOverview] = useState<OverviewDto | null>(null);
  const [symbols, setSymbols] = useState<SymbolRowDto[]>([]);
  const [jobs, setJobs] = useState<JobDto[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<SymbolDetailDto | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [newSymbol, setNewSymbol] = useState('');
  const [knownSymbols, setKnownSymbols] = useState<string[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  /**
   * 全局刷新计数。每成功刷新一次 +1，详情里的 K 线图拿它当刷新信号。
   *
   * 用它而不是让图自己开定时器：页面只有一个刷新节奏，图自己轮询会出现「关掉自动刷新
   * 后图还在动」这种界面与事实不一致（R-19 的诚实性要求）。
   */
  const [tick, setTick] = useState(0);
  const toastId = useRef(0);

  const notify = useCallback((text: string, kind: 'ok' | 'err' = 'ok') => {
    const id = (toastId.current += 1);
    setToasts((prev) => [...prev, { id, text, kind }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 6000);
  }, []);

  const report = useCallback(
    (error: unknown) => {
      if (error instanceof ApiError) notify(`[${error.code}] ${error.message}`, 'err');
      else notify(error instanceof Error ? error.message : String(error), 'err');
    },
    [notify],
  );

  const refresh = useCallback(async () => {
    try {
      const [o, s, j] = await Promise.all([api.overview(), api.symbols(), api.jobs()]);
      setOverview(o);
      setSymbols(s);
      setJobs(j);
      // 成功即清错：横幅必须能自己消失，否则修好后它还赖着不走。
      setLoadError(null);
      // 只在成功时推进 tick：读取失败时让图再去拉一次同样的数据没有意义。
      setTick((prev) => prev + 1);
    } catch (error) {
      // 加载失败必须是**常驻可见**的，不能只弹一下 toast——那等于静默失败（AGENTS.md 第 9 条）。
      setLoadError(
        error instanceof ApiError
          ? `[${error.code}] ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error),
      );
    }
  }, []);

  /**
   * 首屏取数**刻意用 layout effect**，不是普通的 useEffect。
   *
   * 原因不是洁癖：effect 里抛出的异常会中止同一次 commit 里剩下的全部 effect。
   * 之前就踩过——recharts 的 `ResponsiveContainer` 挂载时读 `ResizeObserver`，
   * 抛错后 `useEffect(() => refresh())` 根本没机会执行，页面永远停在「读取中」，
   * 而错误只进 console 没人看，等于静默失败。layout effect 在 commit 阶段同步执行、
   * 早于所有 passive effect，图表再怎么抽风都拖垮不了取数。
   */
  useLayoutEffect(() => {
    void refresh();
  }, [refresh]);

  // 轮询留在普通 effect：定时器不依赖 effect 是否被 flush。
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(id);
  }, [autoRefresh, refresh]);

  useEffect(() => {
    if (selected === null) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void api
      .symbol(selected)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch(report);
    return () => {
      cancelled = true;
    };
  }, [selected, refresh, report]);

  useEffect(() => {
    void api
      .exchange()
      .then((x) => setKnownSymbols(x.symbols.map((s) => s.symbol)))
      .catch(() => setKnownSymbols([]));
  }, []);

  const activeJobs = useMemo(() => jobs.filter((j) => j.status === 'running'), [jobs]);
  /** 详情面板的「体检中」从作业列表推，不另设状态：那份数据本来就每 5s 刷新一次。 */
  const verifyingSymbol = useMemo(
    () => jobs.find((j) => j.kind === 'verify' && j.status === 'running')?.symbol ?? null,
    [jobs],
  );
  /** 重建派生表同理：同样只从作业列表推，避免两处状态不同步。 */
  const aggregatingSymbol = useMemo(
    () => jobs.find((j) => j.kind === 'aggregate' && j.status === 'running')?.symbol ?? null,
    [jobs],
  );
  const daemonOnline = overview?.daemon.state === 'running';

  const runLifecycle = useCallback(
    async (symbol: string, action: 'start' | 'pause' | 'resume') => {
      setBusy(symbol);
      try {
        await api.lifecycle(symbol, action);
        notify(
          action === 'start'
            ? `${symbol} 已开始同步（守护进程会先补全历史，之后每轮增量拉取）`
            : action === 'pause'
              ? `${symbol} 已暂停同步`
              : `${symbol} 已恢复`,
        );
        await refresh();
      } catch (error) {
        report(error);
      } finally {
        setBusy(null);
      }
    },
    [notify, refresh, report],
  );

  /**
   * 「开始同步」的唯一入口。
   *
   * 三条分支，每条都对应一个真实的风险或约束，不是为了分类而分类：
   *   1. 守护进程不在线 → 意图会写进去但没有任何进程去执行它。不弹窗说清楚的话，
   *      页面会显示成「同步中」而数据一动不动（会骗人的界面）。
   *   2. 库里没有历史 → 这是首次全量，代价是数百~上千次请求（R-8.3 硬约束：
   *      首次全量必须先算规模，且没有「缩短范围」这个选项）。
   *   3. 已有历史 → 只是增量，直接开。
   */
  const askStart = useCallback(
    async (symbol: string) => {
      if (!daemonOnline) {
        setPending({ kind: 'startOffline', symbol });
        return;
      }
      const row = symbols.find((s) => s.symbol === symbol);
      if (row !== undefined && !row.hasHistory) {
        setBusy(symbol);
        try {
          const estimate = await api.estimate(symbol);
          setPending({ kind: 'startFirstPull', symbol, estimate });
        } catch (error) {
          report(error);
        } finally {
          setBusy(null);
        }
        return;
      }
      await runLifecycle(symbol, 'start');
    },
    [daemonOnline, symbols, report, runLifecycle],
  );

  const askRemove = useCallback(
    (symbol: string) => setPending({ kind: 'remove', symbol, policy: 'keep' }),
    [],
  );

  /** 加入集合。新标的一律 paused（R-8.4），绝不因为加进来就自动拉历史。 */
  const addSymbolNamed = useCallback(
    async (symbol: string) => {
      setBusy(symbol);
      try {
        await api.addSymbol(symbol);
        notify(`${symbol} 已加入集合（默认 paused，点「开始同步」才会真正拉数据）`);
        await refresh();
      } catch (error) {
        report(error);
      } finally {
        setBusy(null);
      }
    },
    [notify, refresh, report],
  );

  const addSymbol = useCallback(async () => {
    const symbol = newSymbol.trim();
    if (symbol === '') return;
    await addSymbolNamed(symbol);
    setNewSymbol('');
  }, [addSymbolNamed, newSymbol]);

  const confirmPending = useCallback(async () => {
    if (pending === null) return;
    setBusy(pending.symbol);
    try {
      if (pending.kind === 'startFirstPull' || pending.kind === 'startOffline') {
        await api.lifecycle(pending.symbol, 'start');
        notify(
          daemonOnline
            ? `${pending.symbol} 已开始同步`
            : `${pending.symbol} 意图已记录，但守护进程未运行，数据不会更新`,
        );
      } else if (pending.kind === 'verify') {
        const job = await api.startVerify(pending.symbol);
        notify(`已登记数据体检作业 ${job.id}`);
      } else if (pending.kind === 'aggregate') {
        const job = await api.startAggregate(pending.symbol, pending.target);
        notify(`已登记派生重建作业 ${job.id}（只重算派生表，不拉数据）`);
      } else {
        await api.removeSymbol(pending.symbol, pending.policy);
        notify(`${pending.symbol} 已移除（已入库数据按 ${pending.policy} 处置）`);
        if (selected === pending.symbol) setSelected(null);
      }
      setPending(null);
      await refresh();
    } catch (error) {
      report(error);
    } finally {
      setBusy(null);
    }
  }, [pending, notify, refresh, report, selected, daemonOnline]);

  const now = overview?.now ?? Date.now();
  const schemaOk = overview?.schema.ok ?? false;

  return (
    <div className="app">
      <header className="top">
        <h1>trade-tool 控制面</h1>
        <span className={`tag ${schemaOk ? 'ok' : 'error'}`}>
          schema {overview ? `${overview.schema.current} / ${overview.schema.latest}` : '读取中'}
        </span>
        <div className="spacer" />
        <label className="row" style={{ gap: 6, fontSize: 12 }}>
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          <span className="muted">每 {REFRESH_MS / 1000}s 自动刷新</span>
        </label>
        <button onClick={() => void refresh()}>立即刷新</button>
      </header>

      {loadError !== null ? (
        <div className="banner">
          读取状态失败：{loadError}
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            每 5s 自动重试；点「立即刷新」可立刻重试。
          </div>
        </div>
      ) : null}

      {overview && !schemaOk ? (
        <div className="banner">
          数据库 schema（{overview.schema.current}）与代码（{overview.schema.latest}
          ）不一致，写操作可能失败。 先在命令行跑 <code>trade-tool db migrate</code>。
        </div>
      ) : null}
      {overview?.schema.ahead.length ? (
        <div className="banner">
          数据库里有代码不认识的迁移：{overview.schema.ahead.join(', ')}。请更新代码而不是强行迁移。
        </div>
      ) : null}
      {/* 守护进程不在线时，「开始同步」只写意图、没有任何进程去执行它。这条必须常驻可见：
          否则用户看到「同步中」却等不到数据，只能自己猜原因。 */}
      {overview && !daemonOnline ? (
        <div className="banner">
          守护进程未运行{overview.daemon.state === 'stale' ? '（心跳超时，可能已卡死）' : ''}：
          <b>「开始同步」只会记录意图，不会拉数据</b>。
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            在另一个终端启动常驻进程：
            <code>pnpm --filter @trade-tool/sync start</code>
            {overview.daemon.lastBeatAt !== null ? (
              <> · 最后心跳 {fmtAgo(overview.daemon.lastBeatAt, now)}</>
            ) : null}
          </div>
        </div>
      ) : null}

      {overview ? (
        <OverviewCards
          summary={overview.summary}
          exchangeCount={overview.exchange.count}
          exchangeStale={overview.exchange.stale}
          exchangeAgeMs={overview.exchange.ageMs}
          daemon={overview.daemon}
          now={now}
          activeJobs={overview.jobs.active}
        />
      ) : (
        <p className="muted">正在读取状态…</p>
      )}

      <div className="panel">
        <h2>
          进行中与最近作业
          {activeJobs.length > 0 ? (
            <span className="tag running">{activeJobs.length} 进行中</span>
          ) : null}
        </h2>
        {jobs.length === 0 ? (
          <p className="muted">还没有作业。数据体检会在详情面板里发起。</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>标的</th>
                  <th>类型</th>
                  <th>状态</th>
                  <th>进度</th>
                  <th>开始</th>
                  <th>耗时</th>
                  <th>结果 / 错误</th>
                </tr>
              </thead>
              <tbody>
                {jobs.slice(0, 8).map((job) => {
                  const pct =
                    job.progress.target && job.progress.target > 0 && job.progress.rows !== null
                      ? Math.min(1, job.progress.rows / job.progress.target)
                      : null;
                  return (
                    <tr key={job.id}>
                      <td className="mono">{job.symbol}</td>
                      <td>
                        {job.kind === 'full'
                          ? '全量/增量'
                          : job.kind === 'verify'
                            ? '全表校验'
                            : '派生重建'}
                      </td>
                      <td>
                        <span
                          className={`tag ${
                            job.status === 'running'
                              ? 'running'
                              : job.status === 'failed'
                                ? 'error'
                                : 'ok'
                          }`}
                        >
                          {job.status}
                        </span>
                      </td>
                      <td style={{ minWidth: 180 }}>
                        {pct === null ? (
                          <span className="muted">—</span>
                        ) : (
                          <>
                            <div className="bar thin">
                              <i style={{ width: `${pct * 100}%` }} />
                            </div>
                            <span className="mono muted" style={{ fontSize: 11 }}>
                              {fmtNumber(job.progress.rows)} / {fmtNumber(job.progress.target)} ·{' '}
                              {fmtPercent(pct)}
                            </span>
                          </>
                        )}
                      </td>
                      <td className="muted mono">
                        {new Date(job.startedAt).toLocaleTimeString('zh-CN', { hour12: false })}
                      </td>
                      <td className="muted">
                        {job.finishedAt === null
                          ? '进行中'
                          : fmtDuration(job.finishedAt - job.startedAt)}
                      </td>
                      <td className="mono muted" style={{ whiteSpace: 'pre-wrap' }}>
                        {job.error ? `[${job.error.code}] ${job.error.message}` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <h2>标的集合</h2>
        <div className="row" style={{ marginBottom: 12 }}>
          <SymbolPicker
            options={knownSymbols}
            value={newSymbol}
            onChange={setNewSymbol}
            onSubmit={(s) => void addSymbolNamed(s)}
          />
          <button
            className="primary"
            onClick={() => void addSymbol()}
            disabled={newSymbol.trim() === ''}
          >
            添加（默认 paused）
          </button>
          <span className="muted" style={{ fontSize: 12 }}>
            新标的默认 paused —— 加进来不会自动拉数据，避免一次加多个引发回补风暴。
          </span>
        </div>
        <SymbolTable
          items={symbols}
          now={now}
          selected={selected}
          busy={busy}
          daemonOnline={daemonOnline}
          onSelect={setSelected}
          onLifecycle={(s, a) => void runLifecycle(s, a)}
          onStart={(s) => void askStart(s)}
          onRemove={askRemove}
          onAdopt={(s) => void addSymbolNamed(s)}
        />
      </div>

      {selected !== null ? (
        <div className="panel">
          <h2>
            {selected} 详情
            <button onClick={() => setSelected(null)}>收起</button>
          </h2>
          {detail === null ? (
            <p className="muted">读取中…</p>
          ) : (
            <SymbolDetail
              detail={detail}
              now={now}
              verifying={verifyingSymbol === selected}
              onVerify={() => setPending({ kind: 'verify', symbol: selected })}
              aggregating={aggregatingSymbol === selected}
              onAggregate={() =>
                setPending({
                  kind: 'aggregate',
                  symbol: selected,
                  // 进度分母沿用 1m 行数：页面已有的分母就是它，换成桶数会让
                  // 同一条进度条在两个作业之间跳变。
                  target: detail?.state?.rows ?? 0,
                })
              }
              tick={tick}
            />
          )}
        </div>
      ) : null}

      {pending?.kind === 'startOffline' ? (
        <ConfirmDialog
          title={`${pending.symbol} 的守护进程没有在运行`}
          confirmLabel="仍然记录意图"
          busy={busy === pending.symbol}
          onCancel={() => setPending(null)}
          onConfirm={() => void confirmPending()}
        >
          <p>
            这里的「开始同步」<b>只是把期望状态写进数据库</b>，真正拉数据的是独立的常驻进程
            <code>apps/sync</code>。它现在没有运行，所以不会有任何请求发出去，行数不会变化。
          </p>
          <p className="muted" style={{ fontSize: 12 }}>
            典型用法：先在这里把标的登记为同步中，再去启动守护进程接单——意图已经落库，
            守护进程起来后会立刻接手。
          </p>
        </ConfirmDialog>
      ) : null}

      {pending?.kind === 'startFirstPull' ? (
        <ConfirmDialog
          title={`开始同步 ${pending.symbol}`}
          confirmLabel="开始同步"
          busy={busy === pending.symbol}
          onCancel={() => setPending(null)}
          onConfirm={() => void confirmPending()}
        >
          <p>
            该标的库里还没有历史，守护进程会先<b>补全全部历史</b>（1m，起点取自该标的的运行时{' '}
            <code>onboardDate</code>），之后每轮再增量拉取最新。
          </p>
          <div className="est-grid">
            <div className="card">
              <div className="label">目标行数</div>
              <div className="value">{fmtNumber(pending.estimate.bars)}</div>
            </div>
            <div className="card">
              <div className="label">已入库</div>
              <div className="value">
                {fmtNumber(symbols.find((s) => s.symbol === pending.symbol)?.state?.rows ?? 0)}
              </div>
            </div>
            <div className="card">
              <div className="label">预计请求数</div>
              <div className="value">{fmtNumber(pending.estimate.requests)} 次</div>
            </div>
            <div className="card">
              {/* 权重与耗时都直接取服务端的估算值：单位换算（权重 → 毫秒）是后端的事，
                  在这里再算一遍只会引入一份会漂移的副本。 */}
              <div className="label">预计权重 / 耗时</div>
              <div className="value">
                {fmtNumber(pending.estimate.weight)} · {fmtDuration(pending.estimate.estimatedMs)}
              </div>
            </div>
          </div>
          <p className="muted" style={{ fontSize: 12 }}>
            上面是<b>配额下限</b>
            ，真实耗时受网络往返支配，通常明显更久。这是一次性操作，不提供「缩短范围」选项。
          </p>
        </ConfirmDialog>
      ) : null}

      {pending?.kind === 'verify' ? (
        <ConfirmDialog
          title={`数据体检 ${pending.symbol}`}
          confirmLabel="开始体检"
          busy={busy === pending.symbol}
          onCancel={() => setPending(null)}
          onConfirm={() => void confirmPending()}
        >
          <p>
            会扫描该标的的<b>整张表</b>找缺口并重建「已验证到哪里」基线。行数多时是全表扫描，
            耗时按数据量线性增长。
          </p>
          <p className="muted" style={{ fontSize: 12 }}>
            例行同步只看最近 7 天，<b>更早的漏行只有它能发现</b>
            。只读本地库，不出网、不消耗交易所配额。
            缺口语义：只由真实数据填充，不插值、不跳过（R-11）。
          </p>
        </ConfirmDialog>
      ) : null}

      {pending?.kind === 'aggregate' ? (
        <ConfirmDialog
          title={`重建派生 K 线 ${pending.symbol}`}
          confirmLabel="开始重建"
          busy={busy === pending.symbol}
          onCancel={() => setPending(null)}
          onConfirm={() => void confirmPending()}
        >
          <p>
            从库内已入库的 <b>1m K 线</b>重算 15m / 1h / 4h / 1d 全部桶（先删后算）。
            <b>不出网、不消耗交易所配额</b>，也不改动 1m 与水位。
          </p>
          <p className="muted" style={{ fontSize: 12 }}>
            通常<strong>不需要</strong>手动重建：缺口在下一轮同步被补上时，受影响的桶会自动出现。
            重建用于「1m 被外部改动 / 派生表被篡改」这两种情况。
          </p>
        </ConfirmDialog>
      ) : null}

      {pending?.kind === 'remove' ? (
        <ConfirmDialog
          title={`移除 ${pending.symbol}`}
          confirmLabel="移除"
          danger
          busy={busy === pending.symbol}
          onCancel={() => setPending(null)}
          onConfirm={() => void confirmPending()}
        >
          <p>
            移除只改标的集合，<b>不会自动删数据</b>。已入库行的处置策略：
          </p>
          <div className="row" style={{ marginTop: 8 }}>
            {(['keep', 'archive', 'delete'] as RemovePolicy[]).map((p) => (
              <button
                key={p}
                className={pending.policy === p ? 'primary' : ''}
                onClick={() => setPending({ ...pending, policy: p })}
              >
                {p}
              </button>
            ))}
          </div>
          <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
            keep 保留数据与状态；archive 归档后同样保留；delete 才真正删除行。
          </p>
        </ConfirmDialog>
      ) : null}

      {toasts.map((t) => (
        <div key={t.id} className={`toast${t.kind === 'err' ? ' err' : ''}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
