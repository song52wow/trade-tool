from __future__ import annotations

import math

import numpy as np
import pytest
from quant_backtest.engine import BacktestConfig, bars_per_year_for, run_backtest
from quant_backtest.metrics import compute_metrics, drawdown_series
from quant_core import Bar


def _rising_bars(n: int) -> list[Bar]:
    return [
        Bar(
            time=i,
            open=100.0 + i,
            high=101.0 + i,
            low=99.0 + i,
            close=100.0 + i,
            volume=1.0,
        )
        for i in range(n)
    ]


def _zigzag_bars(n: int) -> list[Bar]:
    """正弦走势：快慢均线必然多次穿越，用来验证开平仓链路。"""
    bars: list[Bar] = []
    for i in range(n):
        close = 100.0 + 15.0 * math.sin(i / 3.0)
        bars.append(
            Bar(time=i, open=close, high=close + 1.0, low=close - 1.0, close=close, volume=1.0)
        )
    return bars


def test_drawdown_tracks_peak() -> None:
    out = drawdown_series(np.array([100.0, 110.0, 90.0, 120.0]))
    assert out[0] == pytest.approx(0.0)
    assert out[2] == pytest.approx(20.0 / 110.0)
    assert out[3] == pytest.approx(0.0)


def test_compute_metrics_short_sample_is_zero() -> None:
    m = compute_metrics(np.array([100.0]), 252.0, [])
    assert m.total_return == 0.0
    assert m.trade_count == 0


def test_run_backtest_rejects_empty_bars() -> None:
    with pytest.raises(ValueError):
        run_backtest([])


def test_config_rejects_fast_ge_slow() -> None:
    with pytest.raises(ValueError):
        BacktestConfig(fast=60, slow=20)


def test_run_backtest_on_rising_market_stays_flat() -> None:
    """单调上涨时快慢均线不交叉，应当空仓、零交易。"""
    bars = _rising_bars(60)
    result = run_backtest(bars, BacktestConfig(fast=3, slow=10, initial_capital=1_000.0))
    assert result.trade_pnls == []
    assert all(value == pytest.approx(1_000.0) for value in result.equity)


def test_run_backtest_on_zigzag_opens_and_closes() -> None:
    bars = _zigzag_bars(120)
    result = run_backtest(bars, BacktestConfig(fast=5, slow=15, initial_capital=1_000.0))
    assert len(result.equity) == len(bars)
    assert np.all(np.isfinite(result.equity))
    assert len(result.trade_pnls) >= 1
    assert result.metrics.trade_count == len(result.trade_pnls)
    # 手续费只会让净值不增
    assert result.metrics.total_return <= 0.0 or result.trade_pnls[-1] > 0.0


def test_bars_per_year_for_one_hour() -> None:
    assert bars_per_year_for(3_600_000) == pytest.approx(8_760.0)
