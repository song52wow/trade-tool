"""Python 侧回测引擎：**唯一的回测实现**（v0.3.0 R-7 / R-8）。

三条不可协商的规则：

1. **可用时刻是成文契约**（R-2）：bar ``t`` 的指标值语义是「在 ``t`` **收盘后**才可用」，
   禁止在任何决策中使用 ``t+1`` 及以后的 bar。指标输入因此只能是**已收盘**的 bar——
   这条由数据层保证（派生表任一时刻只含已收盘且 1m 全覆盖的桶），引擎**不需要自己的
   收盘判据**，也**不得**另立一套。

2. **成交模型固定为「信号在 ``t`` 收盘确认，成交在 ``t+1`` 开盘」**（R-2.3）。
   旧模型是「看到本根收盘价、又以本根收盘价成交」——**知道收盘价的同时以该收盘价成交**，
   那是可复现的未来函数。修掉之后：
     - 序列**最后一根**产生的信号**无法成交**，不产生交易。**不得**回退成「以 ``t`` 收盘
       价成交」——那正是要修掉的东西；
     - ``t+1`` 不存在（序列到 ``t`` 为止）→ 不成交。

3. **策略只消费指标，不自己算指标**（R-8.2）。指标序列一律从 :mod:`quant_core` 取，
   引擎内不得出现任何指标公式（AC-16 守住）。主循环因此是 **O(n)**：指标**一次性向量化
   算完整段**，而不是每根 bar 把整段历史重算一遍（旧实现的 O(n²)）。

绩效指标口径**不变**（R-8.4）：本次只改成交时点与计算复杂度，不改夏普 / 回撤 / 盈亏比的
定义。因此报告里的数字会**有意变化**——那是修掉未来函数的结果，不是回归。
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
from quant_core import Bar, sma

from .metrics import Metrics, compute_metrics

MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000


@dataclass(frozen=True, slots=True)
class BacktestConfig:
    """回测控制参数（经 argv 由 TS 侧传入，R-7.1）。"""

    fast: int = 20
    slow: int = 60
    initial_capital: float = 10_000.0
    fee_rate: float = 0.0005
    slippage_rate: float = 0.0
    bars_per_year: float = 365.0

    def __post_init__(self) -> None:
        if self.fast <= 0 or self.slow <= 0:
            raise ValueError("均线窗口必须为正整数")
        if self.fast >= self.slow:
            raise ValueError(f"fast({self.fast}) 必须小于 slow({self.slow})")


@dataclass(frozen=True, slots=True)
class Trade:
    """一笔已平仓交易。``pnl`` 已扣手续费与滑点。"""

    entry_time: int
    exit_time: int
    entry_price: float
    exit_price: float
    quantity: float
    pnl: float
    reason: str

    def to_dict(self) -> dict[str, float | int | str]:
        return {
            "entryTime": self.entry_time,
            "exitTime": self.exit_time,
            "entryPrice": self.entry_price,
            "exitPrice": self.exit_price,
            "quantity": self.quantity,
            "pnl": self.pnl,
            "reason": self.reason,
        }


@dataclass(frozen=True, slots=True)
class EquityPoint:
    time: int
    equity: float
    drawdown: float

    def to_dict(self) -> dict[str, float | int]:
        return {"time": self.time, "equity": self.equity, "drawdown": self.drawdown}


@dataclass(frozen=True, slots=True)
class BacktestResult:
    equity: list[EquityPoint]
    trades: list[Trade]
    metrics: Metrics

    def to_dict(self) -> dict[str, object]:
        return {
            "equity": [p.to_dict() for p in self.equity],
            "trades": [t.to_dict() for t in self.trades],
            "metrics": self.metrics.to_dict(),
        }


def bars_per_year_for(interval_ms: int) -> float:
    return MS_PER_YEAR / interval_ms


def signals_from_ma_cross(closes: np.ndarray, fast: int, slow: int) -> np.ndarray:
    """双均线交叉信号，**一次性向量化算完整段**（R-8.3）。

    返回长度与输入相等的数组，取值 ``+1``（金叉做多）/ ``-1``（死叉平仓）/ ``0``（无信号），
    **预热段与最后一根一律为 0**——最后一根之所以恒为 0，是因为它的信号无法在 ``t+1``
    成交（序列已到头），提前在信号里剔除比在成交循环里特判更不容易漏（R-2.3）。

    旧实现每根 bar 都把整段历史重算一遍 ``sma``（O(n²)）：500 根合成数据上看不出来，
    对着库内 651 万根 1m 就是不可用。
    """
    fast_ma = sma(closes, fast)
    slow_ma = sma(closes, slow)
    out = np.zeros(closes.size, dtype=np.int64)
    valid = ~np.isnan(fast_ma) & ~np.isnan(slow_ma)
    if closes.size < 2:
        return out
    # 交叉判定需要 i 与 i-1 两根**都**有效，因此起点是第一个「两根皆有效」的位置
    both = valid[1:] & valid[:-1]
    idx = np.nonzero(both)[0] + 1
    if idx.size == 0:
        return out
    prev_fast, prev_slow = fast_ma[idx - 1], slow_ma[idx - 1]
    cur_fast, cur_slow = fast_ma[idx], slow_ma[idx]
    golden = (prev_fast <= prev_slow) & (cur_fast > cur_slow)
    death = (prev_fast >= prev_slow) & (cur_fast < cur_slow)
    out[idx[golden]] = 1
    out[idx[death]] = -1
    # 序列最后一根的信号无法成交 → 恒 0（R-2.3）
    if out.size:
        out[-1] = 0
    return out


def run_backtest(bars: Sequence[Bar], config: BacktestConfig | None = None) -> BacktestResult:
    """单标的、单持仓的回测主循环，**O(n)**。

    成交时点（R-2.3）：``t`` 收盘确认的信号，在 ``t+1`` 的**开盘价**成交，扣双边手续费与滑点。
    """
    if not bars:
        raise ValueError("bars 为空，无法回测")
    cfg = config or BacktestConfig()

    n = len(bars)
    closes = np.array([bar.close for bar in bars], dtype=np.float64)
    opens = np.array([bar.open for bar in bars], dtype=np.float64)
    signals = signals_from_ma_cross(closes, cfg.fast, cfg.slow)

    cash = cfg.initial_capital
    qty = 0.0
    entry_price = 0.0
    entry_time = 0
    pending: int = 0  # t 收盘确认的信号，等 t+1 开盘成交
    trades: list[Trade] = []
    equity: list[EquityPoint] = []
    peak = cfg.initial_capital

    for i in range(n):
        # ① 先按上一根确认的信号在**本根开盘**成交（R-2.3）
        if pending != 0 and i > 0:
            if pending == 1 and qty == 0.0 and cash > 0.0:
                fill = opens[i] * (1.0 + cfg.slippage_rate)
                quantity = cash / (fill * (1.0 + cfg.fee_rate))
                if quantity > 0.0:
                    cash -= quantity * fill * (1.0 + cfg.fee_rate)
                    qty = quantity
                    entry_price = fill
                    entry_time = bars[i].time
            elif pending == -1 and qty > 0.0:
                fill = opens[i] * (1.0 - cfg.slippage_rate)
                proceeds = qty * fill * (1.0 - cfg.fee_rate)
                trades.append(
                    Trade(
                        entry_time=entry_time,
                        exit_time=bars[i].time,
                        entry_price=entry_price,
                        exit_price=fill,
                        quantity=qty,
                        pnl=proceeds - qty * entry_price,
                        reason="ma-death-cross",
                    )
                )
                cash += proceeds
                qty = 0.0
            pending = 0
        # ② 再按本根收盘确认新信号 —— 它的成交在**下一根**开盘
        pending = int(signals[i])
        # ③ 净值按**收盘价**计
        value = cash + qty * closes[i]
        peak = max(peak, value)
        drawdown = (peak - value) / peak if peak else 0.0
        equity.append(EquityPoint(time=bars[i].time, equity=value, drawdown=drawdown))

    # 末根的 `pending` **不成交**：序列到此为止，没有 t+1 的开盘价。
    # 旧实现在这里「以末根收盘价强平」——那正是未来函数的一部分（R-2.3）。
    return BacktestResult(
        equity=equity,
        trades=trades,
        metrics=compute_metrics(
            np.array([p.equity for p in equity], dtype=np.float64),
            cfg.bars_per_year,
            [t.pnl for t in trades],
        ),
    )
