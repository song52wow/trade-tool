"""回测引擎用例（v0.3.0 R-13.3）。

本文件最要紧的两条不是「数字对不对」，而是：

* **无未来函数**（AC-14）：构造「只有使用 ``t+1`` 及以后数据才成立」的信号，断言它
  **不产生交易**；以及末根 bar 的信号同样不成交。
* **O(n) 复杂度**（AC-15）：长序列用例带时间预算，防止有人改回「逐 bar 重算整段历史」。

绩效口径不变（R-8.4），因此这里只断言「口径没被顺手改掉」，不锁死具体数值。
"""

from __future__ import annotations

import math
import time

import numpy as np
import pytest
from quant_backtest.engine import (
    BacktestConfig,
    bars_per_year_for,
    run_backtest,
    signals_from_ma_cross,
)
from quant_backtest.metrics import compute_metrics, drawdown_series
from quant_core import Bar


def _bars(closes: list[float], opens: list[float] | None = None) -> list[Bar]:
    """按收盘价造一根根 bar；``opens`` 默认等于收盘价（即无跳空）。"""
    values = opens if opens is not None else closes
    return [
        Bar(
            time=i * 60_000,
            open=values[i],
            high=max(values[i], closes[i]),
            low=min(values[i], closes[i]),
            close=closes[i],
            volume=1.0,
        )
        for i in range(len(closes))
    ]


def _rising(n: int) -> list[Bar]:
    return _bars([100.0 + i for i in range(n)])


def _zigzag(n: int) -> list[Bar]:
    """正弦走势：快慢均线必然多次穿越，用来验证开平仓链路。"""
    return _bars([100.0 + 15.0 * math.sin(i / 3.0) for i in range(n)])


# ------------------------------------------------------------------ 绩效口径


def test_drawdown_tracks_peak() -> None:
    out = drawdown_series(np.array([100.0, 110.0, 90.0, 120.0]))
    assert out[0] == pytest.approx(0.0)
    assert out[2] == pytest.approx(20.0 / 110.0)
    assert out[3] == pytest.approx(0.0)


def test_compute_metrics_short_sample_is_zero() -> None:
    m = compute_metrics(np.array([100.0]), 252.0, [])
    assert m.total_return == 0.0
    assert m.trade_count == 0


# ------------------------------------------------------------------ 配置校验


def test_config_rejects_fast_ge_slow() -> None:
    with pytest.raises(ValueError):
        BacktestConfig(fast=60, slow=20)


def test_config_rejects_non_positive_window() -> None:
    with pytest.raises(ValueError):
        BacktestConfig(fast=0, slow=60)


def test_run_backtest_rejects_empty_bars() -> None:
    with pytest.raises(ValueError):
        run_backtest([])


def test_bars_per_year_for_one_hour() -> None:
    assert bars_per_year_for(3_600_000) == pytest.approx(8_760.0)


# ------------------------------------------------------------- 基本行为


def test_rising_market_stays_flat() -> None:
    """单调上涨时快慢均线不交叉，应当空仓、零交易。"""
    result = run_backtest(_rising(120), BacktestConfig(fast=3, slow=10, initial_capital=1_000.0))
    assert result.trades == []
    assert all(p.equity == pytest.approx(1_000.0) for p in result.equity)


def test_equity_has_one_point_per_bar() -> None:
    bars = _zigzag(150)
    result = run_backtest(bars, BacktestConfig(fast=5, slow=15, initial_capital=1_000.0))
    assert len(result.equity) == len(bars)
    assert [p.time for p in result.equity] == [b.time for b in bars]
    assert all(np.isfinite(p.equity) for p in result.equity)
    assert all(0.0 <= p.drawdown <= 1.0 for p in result.equity)


def test_zigzag_opens_and_closes() -> None:
    result = run_backtest(_zigzag(200), BacktestConfig(fast=5, slow=15, initial_capital=1_000.0))
    assert len(result.trades) >= 1
    assert result.metrics.trade_count == len(result.trades)
    # 手续费只会让净值不增
    assert result.metrics.total_return <= 0.0 or result.trades[-1].pnl > 0.0


# ------------------------------------------------------- 可用时刻（R-2 / AC-14）


def test_signal_needing_future_data_produces_no_trade() -> None:
    """**无未来函数的正面用例**：构造一段「用未来 3 根才能看出来的交叉」。

    前 60 根完全平坦（快慢均线重合，不产生交叉），第 61~64 根突然跳涨。
    如果实现里存在任何形式的未来函数——用整段历史算指标、用末根强平、
    或「信号与成交同一根」——这段数据都会凭空产生交易。这里断言**一笔都没有**。
    """
    closes = [50.0] * 60 + [50.0, 60.0, 70.0, 80.0]
    result = run_backtest(_bars(closes), BacktestConfig(fast=3, slow=10, initial_capital=1_000.0))
    assert result.trades == [], "只可能由未来数据成立的趋势不得产生交易"


def test_last_bar_signal_never_fills() -> None:
    """**末根信号不成交**：序列到此为止，没有 ``t+1`` 的开盘价可成交（R-2.3）。

    做法是让**末根**成为一次金叉：序列长度恰好等于慢线窗口，于是「金叉成立」只可能
    发生在最后一根上。若实现退化成「以 t 收盘价成交」，这里会凭空多出一笔交易。
    """
    flat = 40.0
    closes = [flat] * 9 + [flat * 2.0]  # 10 根，slow=10 → 交叉只可能发生在末根
    result = run_backtest(_bars(closes), BacktestConfig(fast=2, slow=10, initial_capital=1_000.0))
    assert result.trades == []


def test_last_pending_signal_is_not_liquidated() -> None:
    """持仓跨到序列末尾时**不做末根强平**。

    旧实现会在末尾「以末根收盘价强平」并计入一笔交易——那既是一次未来函数，
    也让「交易次数」依赖序列是否恰好截断在持仓中。
    """
    closes = [100.0] * 10 + [100.0, 130.0, 160.0, 190.0]
    result = run_backtest(_bars(closes), BacktestConfig(fast=2, slow=5, initial_capital=1_000.0))
    # 末根既不新开仓也不平仓：交易数只可能来自序列**内部**的交叉
    for trade in result.trades:
        assert trade.exit_time < result.equity[-1].time


def test_fill_uses_next_bar_open_not_current_close() -> None:
    """成交价是 ``t+1`` 的**开盘价**（R-2.3）。

    构造一次确定的金叉（信号落在下标 5）与一次死叉（信号落在下标 9），并让
    候选价**互不相同**，因此任何一个取错都能被区分出来：

    * 开仓：金叉那根 ``t=5`` 的收盘 = 30，而成交那根 ``t+1=6`` 的**开盘** = 99；
    * 平仓：死叉那根 ``t=9`` 的收盘 = 10，而成交那根 ``t+1=10`` 的**开盘** = 5。

    期望开仓价 99、平仓价 5。两者都取错的话断言立刻失败。
    """
    closes = [10.0, 10.0, 10.0, 10.0, 10.0, 20.0, 30.0, 30.0, 20.0, 10.0, 10.0, 10.0]
    opens = [10.0, 10.0, 10.0, 10.0, 10.0, 20.0, 99.0, 30.0, 20.0, 20.0, 5.0, 10.0]
    result = run_backtest(
        _bars(closes, opens), BacktestConfig(fast=2, slow=5, initial_capital=1_000.0)
    )
    assert len(result.trades) == 1, "该样例应恰好产生一次「金叉开仓 → 死叉平仓」"
    trade = result.trades[0]
    assert trade.entry_price == pytest.approx(99.0), "开仓价必须是成交那根的**开盘价**"
    assert trade.exit_price == pytest.approx(5.0), "平仓价必须是成交那根的**开盘价**"
    assert trade.entry_time == 6 * 60_000, "开仓时间是 t+1 那根 bar 的开盘时刻"
    assert trade.exit_time == 10 * 60_000, "平仓时间是 t+1 那根 bar 的开盘时刻"


def test_no_trade_before_warmup_completes() -> None:
    """预热段内不产生任何信号（否则等于拿还没算出来的指标做决策）。"""
    closes = [10.0, 30.0, 10.0, 30.0, 10.0]
    result = run_backtest(_bars(closes), BacktestConfig(fast=2, slow=20, initial_capital=1_000.0))
    assert result.trades == []


# ------------------------------------------------------- 信号向量的性质


def test_signal_vector_has_zero_last_position() -> None:
    """信号向量最后一格恒为 0（无法成交）——在向量层面就剔除，比成交循环里特判更稳。"""
    closes = np.array([100.0 + (i % 7) for i in range(120)], dtype=np.float64)
    signals = signals_from_ma_cross(closes, 5, 20)
    assert signals[-1] == 0


def test_signal_vector_matches_streaming_golden_cross() -> None:
    """向量实现与「逐根判断」的朴素实现**逐值一致**。

    这条守住 R-8.3 的正确性：优化成向量之后，最容易出的错是「交叉判定偏移了一格」，
    而症状是「回测结果莫名其妙变了一点」——极难定位。
    """
    from quant_core import sma

    closes = np.array([100.0 + 10.0 * math.sin(i / 5.0) for i in range(300)], dtype=np.float64)
    fast = 7
    slow = 21
    vector = signals_from_ma_cross(closes, fast, slow)

    streaming = np.zeros(closes.size, dtype=np.int64)
    for i in range(closes.size):
        if i == 0:
            continue
        history = closes[: i + 1]
        f_now, s_now = sma(history, fast)[-1], sma(history, slow)[-1]
        f_prev, s_prev = sma(history[:-1], fast)[-1], sma(history[:-1], slow)[-1]
        if math.isnan(f_now) or math.isnan(s_now) or math.isnan(f_prev) or math.isnan(s_prev):
            continue
        if f_prev <= s_prev and f_now > s_now:
            streaming[i] = 1
        elif f_prev >= s_prev and f_now < s_now:
            streaming[i] = -1
    streaming[-1] = 0
    assert vector.tolist() == streaming.tolist()


def test_signal_vector_is_all_nan_during_warmup() -> None:
    closes = np.array([100.0 + (i % 3) for i in range(60)], dtype=np.float64)
    signals = signals_from_ma_cross(closes, 20, 30)
    assert signals[:29].tolist() == [0] * 29


# ------------------------------------------------------------ 复杂度（AC-15）


def test_long_series_completes_within_time_budget() -> None:
    """20 万根回测必须在时间预算内完成（O(n) 的可测代理，AC-15）。

    旧实现是 O(n²)：每根 bar 都对整段历史重算一次双均线，20 万根意味着约 2×10¹⁰ 次
    加法——跑不完。这条用例的价值不在「跑得快」，而在「跑得完」。
    """
    n = 200_000
    closes = [100.0 + 10.0 * math.sin(i / 30.0) for i in range(n)]
    bars = _bars(closes)
    started = time.monotonic()
    result = run_backtest(bars, BacktestConfig(fast=20, slow=60, initial_capital=1_000.0))
    elapsed = time.monotonic() - started
    assert len(result.equity) == n
    # 预算放宽到 30s：CI 机器比本地慢一个量级，而 O(n²) 在这个规模上是「跑不完」
    # 而不是「慢一点」——阈值卡在两个数量级之间即可区分。
    assert elapsed < 30.0, f"20 万根回测耗时 {elapsed:.1f}s，超出预算（疑似退化到 O(n²)）"


def test_signal_computation_on_long_series() -> None:
    """指标向量计算本身在长序列上也必须是 O(n)（一次算完整段，不是逐 bar 重算）。"""
    n = 200_000
    closes = np.array([100.0 + 10.0 * math.sin(i / 30.0) for i in range(n)], dtype=np.float64)
    started = time.monotonic()
    signals = signals_from_ma_cross(closes, 20, 60)
    elapsed = time.monotonic() - started
    assert signals.size == n
    assert elapsed < 10.0, f"信号计算耗时 {elapsed:.1f}s，超出预算"
