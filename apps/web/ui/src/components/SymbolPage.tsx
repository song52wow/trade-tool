import { useLayoutEffect, useMemo, useState } from 'react';

import { ApiError, api } from '../api.js';
import { HOME_PATH, navigate, symbolPath } from '../router.js';
import type { SymbolDetailDto, SymbolRowDto } from '../../../src/types';
import { SymbolDetail } from './SymbolDetail.js';

/**
 * 单标的详情页（`#/symbol/<SYMBOL>`）。
 *
 * 它是**独立页面**而不是首页表格下面展开的一块：地址栏里的 hash 就是标的本身，
 * 复制给别人 / 收藏到书签都能回到同一个标的，刷新也停在原地。页内切标的只改 hash，
 * 不整页刷新——图表重新取数由 hash 变化驱动，不靠重载。
 *
 * 取数用 `useLayoutEffect` 而不是 `useEffect`：这张页面**可以是首屏**（直接粘地址栏
 * 进来），而它的子树里有 recharts。effect 里抛出的异常会中止同一次 commit 里剩下的
 * 全部 effect，图表挂载时读 `ResizeObserver` 抛错，详情就永远停在「读取中…」，
 * 而且错误只进 console —— 正是 AGENTS.md 记的那个坑。
 */
export function SymbolPage(props: {
  symbol: string;
  /** 运行时发现的标的集合，用于页内切换；**不含任何硬编码合约名**。 */
  symbols: SymbolRowDto[];
  /** 与页面其它地方同一个「现在」，避免同一屏出现两个基准时刻。 */
  now: number;
  verifying: boolean;
  onVerify: () => void;
  aggregating: boolean;
  onAggregate: () => void;
  tick: number;
}) {
  const [detail, setDetail] = useState<SymbolDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    void api
      .symbol(props.symbol)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e: unknown) => {
        // 读取失败必须**常驻可见**：详情读不出来却显示成空详情，等于谎报「这个标的数据正常」。
        if (cancelled) return;
        setError(
          e instanceof ApiError
            ? `[${e.code}] ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [props.symbol]);

  const options = useMemo(() => props.symbols.map((s) => s.symbol), [props.symbols]);
  /** 上一 / 下一个按页面上给出的顺序走，列表为空时禁用而不是悄悄不动。 */
  const index = options.indexOf(props.symbol);
  const prev = index > 0 ? options[index - 1] : null;
  const next = index >= 0 && index < options.length - 1 ? options[index + 1] : null;

  return (
    <div className="page">
      {/* 详情页自己的标题栏：返回 + 切换标的 + 复制地址栏即可分享 */}
      <div className="detail-head">
        <button className="link" onClick={() => navigate(HOME_PATH)} title="回到首页">
          ← 首页
        </button>
        <h2 className="detail-title mono">{props.symbol}</h2>
        <div className="spacer" />
        <button
          disabled={prev === null}
          title="上一个标的"
          onClick={() => prev && navigate(symbolPath(prev))}
        >
          ← 上一个
        </button>
        <select
          aria-label="切换标的"
          value={props.symbol}
          onChange={(e) => navigate(symbolPath(e.target.value))}
        >
          {/* 当前标的不在集合里（被移除 / 未纳管）时也要有一个可选项，否则 select 显示空白 */}
          {options.includes(props.symbol) ? null : (
            <option value={props.symbol}>{props.symbol}</option>
          )}
          {options.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button
          disabled={next === null}
          title="下一个标的"
          onClick={() => next && navigate(symbolPath(next))}
        >
          下一个 →
        </button>
      </div>

      {error !== null ? (
        <div className="banner">
          读取 {props.symbol} 详情失败：{error}
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            每 5s 自动重试；切到别的标的再切回来也会重读。
          </div>
        </div>
      ) : null}

      <div className="panel">
        {error !== null ? null : detail === null || detail.symbol !== props.symbol ? (
          <p className="muted">读取中…</p>
        ) : (
          <SymbolDetail
            detail={detail}
            now={props.now}
            verifying={props.verifying}
            onVerify={props.onVerify}
            aggregating={props.aggregating}
            onAggregate={props.onAggregate}
            tick={props.tick}
          />
        )}
      </div>
    </div>
  );
}
