"""绩效指标：与 TS 侧 ``@trade-tool/backtest`` 的口径保持一致。"""

from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np
from numpy.typing import NDArray

FloatArray = NDArray[np.float64]


@dataclass(frozen=True, slots=True)
class Metrics:
    total_return: float
    cagr: float
    volatility: float
    sharpe: float
    max_drawdown: float
    trade_count: int
    win_rate: float

    def to_dict(self) -> dict[str, float | int]:
        return asdict(self)


def drawdown_series(equity: FloatArray) -> FloatArray:
    """相对历史峰值的回撤序列（正数表示下跌）。"""
    if equity.size == 0:
        return equity
    peaks = np.maximum.accumulate(equity)
    with np.errstate(divide="ignore", invalid="ignore"):
        out = np.where(peaks == 0.0, 0.0, (peaks - equity) / peaks)
    return out


def compute_metrics(
    equity: FloatArray,
    bars_per_year: float,
    trade_pnls: list[float] | None = None,
) -> Metrics:
    """``trade_pnls`` 为已实现盈亏，用于交易次数与胜率。"""
    if equity.size < 2:
        return Metrics(0.0, 0.0, 0.0, 0.0, 0.0, 0, 0.0)

    first = float(equity[0])
    last = float(equity[-1])
    total_return = last / first - 1.0 if first else 0.0

    returns = np.diff(equity) / equity[:-1]
    std = float(returns.std(ddof=1)) if returns.size > 1 else 0.0
    mean = float(returns.mean()) if returns.size else 0.0
    volatility = std * float(np.sqrt(bars_per_year))
    sharpe = (mean * bars_per_year) / volatility if volatility else 0.0

    years = (equity.size - 1) / bars_per_year if bars_per_year else 0.0
    cagr = (last / first) ** (1.0 / years) - 1.0 if years > 0 and first > 0 and last > 0 else 0.0

    pnls = trade_pnls or []
    wins = sum(1 for p in pnls if p > 0)
    return Metrics(
        total_return=float(total_return),
        cagr=float(cagr),
        volatility=float(volatility),
        sharpe=float(sharpe),
        max_drawdown=float(drawdown_series(equity).max(initial=0.0)),
        trade_count=len(pnls),
        win_rate=wins / len(pnls) if pnls else 0.0,
    )
