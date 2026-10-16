import { fmtAgo, fmtBytes, fmtNumber, fmtTime } from '../format.js';
import type { SymbolRowDto } from '../../../src/types.js';

const STATUS_TAG: Record<string, string> = {
  running: 'tag running',
  paused: 'tag paused',
  error: 'tag error',
};

export function SymbolTable(props: {
  items: SymbolRowDto[];
  now: number;
  selected: string | null;
  busy: string | null;
  /** 常驻守护进程是否在线；离线时「开始同步」不会真的拉数据，必须提示而不是假装。 */
  daemonOnline: boolean;
  onSelect: (symbol: string) => void;
  onLifecycle: (symbol: string, action: 'start' | 'pause' | 'resume') => void;
  /** 「开始同步」：App 会先做离线检查与首次全量的规模预估，再决定要不要落意图 */
  onStart: (symbol: string) => void;
  onRemove: (symbol: string) => void;
  onAdopt: (symbol: string) => void;
}) {
  if (props.items.length === 0) {
    return <p className="muted">还没有任何标的。用上面的输入框添加第一个。</p>;
  }
  return (
    <>
      {/* 窄屏下表格靠横向滚动，桌面端不需要这行提示（CSS 里 display:none） */}
      <p className="scroll-hint">← 表格可左右滑动查看其余列 →</p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>标的</th>
              <th>期望状态</th>
              <th>实际状态</th>
              <th>行数</th>
              <th>占用</th>
              <th>水位</th>
              <th>缺口</th>
              <th>最近成功</th>
              <th style={{ textAlign: 'right' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {props.items.map((row) => {
              const { symbol, state } = row;
              const busy = props.busy === symbol;
              return (
                <tr
                  key={symbol}
                  className={`clickable${props.selected === symbol ? ' selected' : ''}`}
                  onClick={() => props.onSelect(symbol)}
                >
                  <td className="mono">
                    {symbol}
                    {!row.inCollection ? (
                      <>
                        {' '}
                        <span
                          className="tag warn"
                          title="有数据与状态，但不在 symbols 集合里，尚未被纳管"
                        >
                          未纳管
                        </span>
                      </>
                    ) : null}
                  </td>
                  <td>
                    {row.desiredState === null ? (
                      <span className="tag muted">—</span>
                    ) : (
                      <span
                        className={`tag ${row.desiredState === 'running' ? 'running' : 'paused'}`}
                      >
                        {row.desiredState}
                      </span>
                    )}
                  </td>
                  <td>
                    {state ? (
                      <span className={STATUS_TAG[state.status] ?? 'tag'}>{state.status}</span>
                    ) : (
                      <span className="tag muted">未开始</span>
                    )}
                  </td>
                  <td>
                    {row.hasHistory ? fmtNumber(state?.rows) : <span className="muted">无</span>}
                  </td>
                  <td>{fmtBytes(state?.bytes)}</td>
                  <td className="mono">{state?.watermark ? fmtTime(state.watermark) : '—'}</td>
                  <td>
                    {state && state.pendingGaps > 0 ? (
                      <span className="tag warn">{fmtNumber(state.pendingGaps)}</span>
                    ) : (
                      <span className="muted">0</span>
                    )}
                  </td>
                  <td className="muted">{fmtAgo(state?.lastSuccessAt, props.now)}</td>
                  <td style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                    <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                      {!row.inCollection ? (
                        <button
                          className="primary"
                          disabled={busy}
                          title="加入 symbols 集合（默认 paused），之后才能被守护进程调度"
                          onClick={() => props.onAdopt(symbol)}
                        >
                          加入集合
                        </button>
                      ) : row.desiredState === 'running' ? (
                        // 期望状态是 running 时**只给暂停**：数据由常驻守护进程持续拉取，
                        // 「开始同步」此刻没有意义，重复出现只会让人以为要再点一次。
                        //
                        // 守护进程离线时**标签本身**必须说实话（R-25.5）：只改 title 不够
                        // ——title 要悬停才看得到，行内那一眼仍写着「同步中」，而数据一动不动，
                        // 正是 R-24/R-25 要禁止的那种界面。
                        <button
                          className="syncing"
                          disabled={busy}
                          title={
                            props.daemonOnline
                              ? '正在持续同步：守护进程负责补全历史 + 每轮增量拉取'
                              : '期望状态是 running，但守护进程未运行，数据不会更新'
                          }
                          onClick={() => props.onLifecycle(symbol, 'pause')}
                        >
                          <span className="dot" aria-hidden="true" />
                          {props.daemonOnline ? '同步中 · 暂停' : '同步中（守护进程未运行）· 暂停'}
                        </button>
                      ) : (
                        <button
                          className="primary"
                          disabled={busy}
                          title={
                            props.daemonOnline
                              ? '开始同步：守护进程先补全历史，之后每轮增量拉取最新'
                              : '守护进程未运行：意图会记录但不会拉数据，请先启动 apps/sync'
                          }
                          onClick={() => props.onStart(symbol)}
                        >
                          {props.daemonOnline ? '开始同步' : '开始同步（不会拉数据）'}
                        </button>
                      )}
                      {row.desiredState === 'running' && state?.status === 'error' ? (
                        <button
                          disabled={busy}
                          title="连续失败已进 error 且停止自动重试；恢复会清空退避"
                          onClick={() => props.onLifecycle(symbol, 'resume')}
                        >
                          恢复
                        </button>
                      ) : null}
                      <button
                        className="danger"
                        disabled={busy || !row.inCollection}
                        title={row.inCollection ? '移出集合' : '先加入集合才能移除'}
                        onClick={() => props.onRemove(symbol)}
                      >
                        移除
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
