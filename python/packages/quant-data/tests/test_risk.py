"""``risk-atr`` 的口径测试（v0.4.0）。

这些用例锁的是**四条不可协商的规则**，不是某个具体数值：

1. 只用已收盘的 bar（成交当分钟那根不算）；
2. 不跨缺口（缺口之前的 ATR 不得被「借来」）；
3. 取不到就报 ``RISK_ATR_UNAVAILABLE``，绝不返回 0 或回落到更小周期；
4. 公式来自 :mod:`quant_core`——本模块自己再写一份就分叉了。
"""

from __future__ import annotations

from typing import cast

import numpy as np
import pytest
from quant_core import atr as atr_indicator
from quant_data.errors import SyncError
from quant_data.pg import DbConn
from quant_data.risk import (
    BASE_TABLE,
    Window,
    closed_upper_bound,
    compute_atr,
    parse_interval,
    parse_period,
)

MINUTE = 60_000
#: 2000-01-01 00:00:00Z 起的整分钟，便于人工核对。
T0 = 946_684_800_000


class FakeConn:
    """只实现 ``execute`` 的最小替身：按 SQL 里的表名与上界返回行。"""

    def __init__(self, table: str, rows: list[dict[str, float]]) -> None:
        self.table = table
        self.rows = rows
        self.calls: list[tuple[str, tuple[object, ...]]] = []

    def execute(self, sql: str, params: tuple[object, ...]) -> FakeResult:
        self.calls.append((sql, params))
        if self.table not in sql:
            raise AssertionError(f"SQL 没有命中预期的表 {self.table}: {sql}")
        upper = int(cast(int, params[1]))
        limit = int(cast(int, params[2]))
        picked = [r for r in self.rows if int(r["time"]) <= upper]
        # 与 SQL 一致：ORDER BY time DESC LIMIT n（由被测代码负责翻正）
        picked = sorted(picked, key=lambda r: int(r["time"]), reverse=True)[:limit]
        return FakeResult(picked)


class FakeResult:
    def __init__(self, rows: list[dict[str, float]]) -> None:
        self._rows = rows

    def fetchall(self) -> list[dict[str, float]]:
        return self._rows


def bars(
    start: int, count: int, *, span: float = 10.0, step: float = 0.0
) -> list[dict[str, float]]:
    """构造一段等宽 K 线：``high−low = span``，close 逐根可选线性漂移。"""
    rows: list[dict[str, float]] = []
    for i in range(count):
        close = 100.0 + step * i
        rows.append(
            {
                "time": start + i * MINUTE,
                "high": close + span / 2,
                "low": close - span / 2,
                "close": close,
            }
        )
    return rows


def fake_conn(table: str, rows: list[dict[str, float]]) -> DbConn:
    """把替身交出去时明确 ``cast``：测试要的是「能塞进去」，精确连接类型在这里没有价值。

    用 ``cast`` 而不是 ``type: ignore``——后者会把整条检查静默关掉（AGENTS.md 约定 7）。
    """
    return cast(DbConn, FakeConn(table, rows))


def window_of(rows: list[dict[str, float]]) -> Window:
    return Window(
        times=[int(r["time"]) for r in rows],
        high=np.array([r["high"] for r in rows], dtype=np.float64),
        low=np.array([r["low"] for r in rows], dtype=np.float64),
        close=np.array([r["close"] for r in rows], dtype=np.float64),
    )


# --------------------------------------------------------------- 周期与参数校验


def test_parse_interval_defaults_to_base() -> None:
    assert parse_interval(None) == "1m"
    assert parse_interval("") == "1m"


def test_parse_interval_accepts_derived() -> None:
    assert parse_interval("15m") == "15m"
    assert parse_interval("1h") == "1h"


@pytest.mark.parametrize("raw", ["5m", "2h", "1M", "foo", "15min"])
def test_parse_interval_rejects_unknown_without_fallback(raw: str) -> None:
    """未实现周期必须报错，**不得**静默回落到 1m（否则止损位会近到必被扫）。"""
    with pytest.raises(SyncError) as exc:
        parse_interval(raw)
    assert exc.value.code == "CONFIG_INVALID"


@pytest.mark.parametrize("raw", [0, -1, 1.5, True, "14", None])
def test_parse_period_rejects_non_positive_int(raw: object) -> None:
    with pytest.raises(SyncError) as exc:
        parse_period(raw)
    assert exc.value.code == "CONFIG_INVALID"


def test_closed_upper_bound_excludes_the_open_bar() -> None:
    """bar 在 ``t + W`` 收盘：成交当分钟那根不能进窗口。"""
    assert closed_upper_bound(T0 + 5 * MINUTE, MINUTE) == T0 + 4 * MINUTE


# --------------------------------------------------------------------- 计算口径


def test_compute_atr_matches_quant_core() -> None:
    rows = bars(T0, 60, step=0.5)
    value = compute_atr(window_of(rows), 14)
    assert value == pytest.approx(
        float(
            atr_indicator(window_of(rows).high, window_of(rows).low, window_of(rows).close, 14)[-1]
        )
    )


def test_compute_atr_rejects_short_window_with_missing_count() -> None:
    """不够预热时报错并说清**缺多少根**——否则只能靠猜。"""
    with pytest.raises(SyncError) as exc:
        compute_atr(window_of(bars(T0, 10)), 14)
    assert exc.value.code == "RISK_ATR_UNAVAILABLE"
    assert exc.value.details["missing"] == 5


def test_compute_atr_rejects_non_positive_value() -> None:
    """全零波动的序列算出 ATR=0：必须报错，不能让止损位落在入场价上。"""
    rows = [
        {"time": T0 + i * MINUTE, "high": 100.0, "low": 100.0, "close": 100.0} for i in range(40)
    ]
    with pytest.raises(SyncError) as exc:
        compute_atr(window_of(rows), 14)
    assert exc.value.code == "RISK_ATR_UNAVAILABLE"


# --------------------------------------------------------------------- 选段口径


def test_read_window_excludes_unclosed_bar() -> None:
    from quant_data.risk import read_closed_window

    conn = fake_conn(BASE_TABLE, bars(T0, 120))
    window = read_closed_window(conn, "SYM", "1m", T0 + 100 * MINUTE, 240)
    # 最后一根应是 T0 + 99 * MINUTE（成交当分钟那根还没收盘）
    assert window.times[-1] == T0 + 99 * MINUTE


def test_read_window_takes_only_the_latest_contiguous_segment() -> None:
    """中间挖掉 10 分钟：窗口必须从缺口**之后**开始，不能跨缺口递推。"""
    from quant_data.risk import read_closed_window

    rows = bars(T0, 60) + bars(T0 + 70 * MINUTE, 60)
    conn = fake_conn(BASE_TABLE, rows)
    window = read_closed_window(conn, "SYM", "1m", T0 + 129 * MINUTE, 240)
    assert window.times[0] == T0 + 70 * MINUTE
    assert len(window) == 59


def test_read_window_raises_when_no_rows() -> None:
    from quant_data.risk import read_closed_window

    with pytest.raises(SyncError) as exc:
        read_closed_window(fake_conn(BASE_TABLE, []), "SYM", "1m", T0, 240)
    assert exc.value.code == "RISK_ATR_UNAVAILABLE"
    assert "同步" in exc.value.message


def test_atr_at_returns_segment_provenance() -> None:
    from quant_data.risk import atr_at

    conn = fake_conn(BASE_TABLE, bars(T0, 200))
    # 成交在 T0+200m，那一分钟的 bar 尚未收盘（收盘在 T0+200m），因此窗口是 0..199m 共 200 根
    snapshot = atr_at(conn, "SYM", interval="1m", period=14, as_of_ms=T0 + 200 * MINUTE)
    payload = snapshot.to_dict()
    assert payload["barsUsed"] == 200
    assert payload["segmentFrom"] == T0
    assert payload["segmentTo"] == T0 + 199 * MINUTE
    assert payload["intervalMs"] == MINUTE
    assert isinstance(payload["atr"], float)
