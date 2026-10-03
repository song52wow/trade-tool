"""Python 侧回测引擎：双均线交叉，单持仓，收盘成交。"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
from quant_core import Bar, sma

from .metrics import Metrics, compute_metrics

MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000


@dataclass(frozen=True, slots=True)
class BacktestConfig:
    fast: int = 20
    slow: int = 60
    initial_capital: float = 10_000.0
    fee_rate: float = 0.0005
    bars_per_year: float = 365.0

    def __post_init__(self) -> None:
        if self.fast <= 0 or self.slow <= 0:
            raise ValueError("均线窗口必须为正整数")
        if self.fast >= self.slow:
            raise ValueError(f"fast({self.fast}) 必须小于 slow({self.slow})")


@dataclass(frozen=True, slots=True)
class BacktestResult:
    equity: list[float]
    trade_pnls: list[float]
    metrics: Metrics


def run_backtest(bars: Sequence[Bar], config: BacktestConfig | None = None) -> BacktestResult:
    if not bars:
        raise ValueError("bars 为空，无法回测")
    cfg = config or BacktestConfig()

    closes = np.array([bar.close for bar in bars], dtype=np.float64)
    fast = sma(closes, cfg.fast)
    slow = sma(closes, cfg.slow)

    cash = cfg.initial_capital
    qty = 0.0
    entry_price = 0.0
    trade_pnls: list[float] = []
    equity: list[float] = []

    for i, bar in enumerate(bars):
        # 预热段内均线仍是 nan，直接跳过，避免用 nan 参与比较
        if i >= cfg.slow:
            golden = fast[i - 1] <= slow[i - 1] and fast[i] > slow[i]
            death = fast[i - 1] >= slow[i - 1] and fast[i] < slow[i]
            if golden and qty == 0.0 and cash > 0.0:
                fill = bar.close
                quantity = cash / (fill * (1.0 + cfg.fee_rate))
                if quantity > 0.0:
                    cash -= quantity * fill * (1.0 + cfg.fee_rate)
                    qty = quantity
                    entry_price = fill
            elif death and qty > 0.0:
                fill = bar.close
                proceeds = qty * fill * (1.0 - cfg.fee_rate)
                trade_pnls.append(proceeds - qty * entry_price)
                cash += proceeds
                qty = 0.0

        equity.append(cash + qty * bar.close)

    if qty > 0.0:
        last = bars[-1]
        trade_pnls.append(qty * last.close * (1.0 - cfg.fee_rate) - qty * entry_price)

    return BacktestResult(
        equity=equity,
        trade_pnls=trade_pnls,
        metrics=compute_metrics(np.array(equity, dtype=np.float64), cfg.bars_per_year, trade_pnls),
    )


def bars_per_year_for(interval_ms: int) -> float:
    return MS_PER_YEAR / interval_ms
