import { useLayoutEffect, useMemo, useRef, useState } from 'react';

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
 * 进来），而它的子树里有图表。effect 里抛出的异常会中止同一次 commit 里剩下的
 * 全部 effect，图表挂载时读 `ResizeObserver` 抛错，详情就永远停在「读取中…」，
 * 而且错误只进 console ——正是 AGENTS.md 记的那个坑。
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
  /** 保存提示走同一套横幅。 */
  notify: (text: string, kind?: 'ok' | 'err') => void;
}) {
  /**
   * 详情页内几个**重面板**（K 线 / 止盈止损 / Agent / 对账）的刷新节奏：
   * 每 3 次全局刷新（约 15s）一次。
   *
   * 为什么分档：全局 5s 的节奏是为「进程在不在、同步跑到哪」这类**状态**设的；
   * 而 K 线一次 300 根、方案与对账读的是分钟级变化的数据，5s 重取只是在重复传输。
   * 详情本身（行数 / 缺口 / 派生桶）仍按 5s 走——它是「现在到底怎么样」。
   *
   * 不做成每个面板各自 `setInterval`：多个定时器会让同一屏出现多个时间基准，
   * 关掉自动刷新后还有面板在动（R-19 的诚实性要求）。
   */
  const panelTick = Math.floor(props.tick / 3);

  const [detail, setDetail] = useState<SymbolDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 上一轮的取数控制器：换标的或下一次刷新时**取消**它，避免慢请求层层叠加。 */
  const inFlight = useRef<AbortController | null>(null);

  // 换标的：旧详情与旧错误立刻清掉，别让上一个标的的数据短暂冒充新的。
  // 同一标的的 5s 刷新**不清**——否则每轮都闪一次「读取中」，而画面其实只是更新。
  useLayoutEffect(() => {
    setDetail((prev) => (prev !== null && prev.symbol !== props.symbol ? null : prev));
    setError(null);
  }, [props.symbol]);

  /**
   * 详情取数挂在**全局刷新节奏**（`props.tick`）上，不是只在换标的时读一次。
   *
   * 之前这里只有 `[props.symbol]`，而错误横幅写着「每 5s 自动重试」——那句话是假的：
   * 后端抖一下之后详情就永久停在错误态，同步进行中的「已入库行数 / 缺口 / 派生桶」
   * 也永远不动，同一屏的 K 线却在每 5s 刷新（两个时间基准）。
   *
   * 取消上一轮是配套的：这张页面的服务端要读库 + 算派生统计，慢的时候会超过 5s；
   * 不取消就会叠请求。`AbortError` 不是错误，静默丢弃。
   */
  useLayoutEffect(() => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    void api
      .symbol(props.symbol, { signal: controller.signal })
      .then((d) => {
        setDetail(d);
        setError(null);
      })
      .catch((e: unknown) => {
        // 主动取消：不是失败，什么都不做。
        if (controller.signal.aborted) return;
        // 读取失败必须**常驻可见**：详情读不出来却显示成空详情，等于谎报「这个标的数据正常」。
        setError(
          e instanceof ApiError
            ? `[${e.code}] ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e),
        );
      });
    return () => {
      controller.abort();
    };
  }, [props.symbol, props.tick]);

  const options = useMemo(() => props.symbols.map((s) => s.symbol), [props.symbols]);
  /** 上一 / 下一个按页面上给出的顺序走，列表为空时禁用而不是悄悄不动。 */
  const index = options.indexOf(props.symbol);
  const prev = index > 0 ? options[index - 1] : null;
  const next = index >= 0 && index < options.length - 1 ? options[index + 1] : null;

  return (
    <>
      {/*
        详情页自己的标题栏：**吸顶**。这一页很长（K 线、派生表、合约状态、
        止盈止损、策略、对账、缺口清单），滚到中段时也要知道自己在哪个标的、
        还能不能往前翻一个。
      */}
      <div className="page-head">
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
            tick={panelTick}
            notify={props.notify}
          />
        )}
      </div>
    </>
  );
}
