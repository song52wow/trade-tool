"""quant-backtest：Python 侧回测与绩效计算。"""

from __future__ import annotations

from .engine import BacktestConfig, BacktestResult, bars_per_year_for, run_backtest
from .metrics import Metrics, compute_metrics, drawdown_series

__all__ = [
    "BacktestConfig",
    "BacktestResult",
    "Metrics",
    "bars_per_year_for",
    "compute_metrics",
    "drawdown_series",
    "run_backtest",
]
