"""``risk-atr`` 的口径测试（v0.4.0 + v0.7.0）。

这些用例锁的是**五条不可协商的规则**，不是某个具体数值：

1. 只用已收盘的 bar（成交当分钟那根不算）；
2. 不跨缺口（缺口之前的 ATR 不得被「借来」）；
3. 取不到就报 ``RISK_ATR_UNAVAILABLE``，绝不返回 0 或回落到更小周期；
4. 公式来自 :mod:`quant_core`——本模块自己再写一份就分叉了；
5. 极值 / ``lastClose`` 与 ATR **同一次取数**，且 ``entryTime`` 必填（R-6.2 / R-6.3）。
"""

from __future__ import annotations

from typing import cast

import numpy as np
import pytest
from quant_core import atr as atr_indicator
from quant_data.errors import ERROR_CODES, SyncError
from quant_data.pg import DbConn
from quant_data.risk import (
    BASE_TABLE,
    Window,
    closed_upper_bound,
    compute_atr,
    compute_position_extreme,
    parse_interval,
    parse_period,
    required_bars_between,
    tail_window,
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
    snapshot = atr_at(
        conn, "SYM", entry_time_ms=T0, interval="1m", period=14, as_of_ms=T0 + 200 * MINUTE
    )
    payload = snapshot.to_dict()
    assert payload["barsUsed"] == 200
    assert payload["segmentFrom"] == T0
    assert payload["segmentTo"] == T0 + 199 * MINUTE
    assert payload["intervalMs"] == MINUTE
    assert isinstance(payload["atr"], float)


# ----------------------------------------------------------------- 持仓期极值


def test_required_bars_between_covers_both_ends() -> None:
    assert required_bars_between(T0, T0, MINUTE) == 1
    assert required_bars_between(T0, T0 + 9 * MINUTE, MINUTE) == 10
    assert required_bars_between(T0 + MINUTE, T0, MINUTE) == 0


def test_extreme_covers_the_whole_holding_period() -> None:
    """入场在 T0：极值就是整段 200 根里的最高 / 最低，不是 ATR 窗口那一小段。"""
    from quant_data.risk import atr_at

    conn = fake_conn(BASE_TABLE, bars(T0, 200, step=0.5))
    snapshot = atr_at(
        conn, "SYM", entry_time_ms=T0, interval="1m", period=14, as_of_ms=T0 + 200 * MINUTE
    )
    payload = snapshot.to_dict()
    extreme = cast(dict[str, object], payload["extreme"])
    # 第 200 根 close=199.5，span=10 → high=204.5 / low=95.0
    assert extreme["high"] == pytest.approx(204.5)
    assert extreme["low"] == pytest.approx(95.0)
    assert extreme["from"] == T0
    assert extreme["to"] == T0 + 199 * MINUTE
    assert payload["lastClose"] == pytest.approx(199.5)


def test_extreme_starts_at_entry_not_window_start() -> None:
    """入场在 T0+100m：入场之前的根**不许**进极值（否则是入场前的价格）。"""
    from quant_data.risk import atr_at

    conn = fake_conn(BASE_TABLE, bars(T0, 200, step=0.5))
    snapshot = atr_at(
        conn,
        "SYM",
        entry_time_ms=T0 + 100 * MINUTE,
        interval="1m",
        period=14,
        as_of_ms=T0 + 200 * MINUTE,
    )
    extreme = snapshot.to_dict()["extreme"]
    assert isinstance(extreme, dict)
    assert extreme["from"] == T0 + 100 * MINUTE
    # 第 200 根（index 199）close=199.5 → high=204.5
    assert extreme["high"] == pytest.approx(204.5)


def test_extreme_does_not_cross_a_gap() -> None:
    """中间挖掉 10 分钟：极值只能取 asOf 侧那一段，缺口**不许插值**补齐。"""
    from quant_data.risk import atr_at

    # 缺口前那段的最高点刻意更高（step 很大），一旦跨缺口就会被借进来
    rows = bars(T0, 60, step=2.0) + bars(T0 + 70 * MINUTE, 60, step=0.1)
    conn = fake_conn(BASE_TABLE, rows)
    snapshot = atr_at(
        conn, "SYM", entry_time_ms=T0, interval="1m", period=14, as_of_ms=T0 + 129 * MINUTE
    )
    extreme = snapshot.to_dict()["extreme"]
    assert isinstance(extreme, dict)
    assert extreme["from"] == T0 + 70 * MINUTE, "缺口前的那段不许进入极值"
    # 缺口后那一段只剩到 T0+128m 共 59 根，close 从 100.0 走到 105.8 → high=110.8。
    # 缺口前那一段的最高点是 223（step=2.0），跨缺口就会取到它——所以这个数字才有用。
    assert extreme["high"] == pytest.approx(110.8)


def test_extreme_reports_the_short_segment_truthfully() -> None:
    """持仓期比极值段长时 from/to 如实回传，调用方据此知道它短了（R-6.4）。"""
    from quant_data.risk import atr_at

    rows = bars(T0, 60) + bars(T0 + 70 * MINUTE, 60)
    conn = fake_conn(BASE_TABLE, rows)
    snapshot = atr_at(
        conn, "SYM", entry_time_ms=T0, interval="1m", period=14, as_of_ms=T0 + 129 * MINUTE
    )
    extreme = snapshot.to_dict()["extreme"]
    assert isinstance(extreme, dict)
    assert extreme["from"] == T0 + 70 * MINUTE
    assert extreme["to"] == T0 + 128 * MINUTE
    # 持仓期从 T0 开始，极值却从 T0+70m 开始：没有用「窗口起点」冒充持仓起点
    assert extreme["from"] != T0


def test_extreme_raises_its_own_code_when_empty() -> None:
    """交集为空用**新码**，且不进 MANUAL_INTERVENTION_CODES（本轮不调整即可恢复）。"""
    from quant_data.errors import MANUAL_INTERVENTION_CODES
    from quant_data.risk import atr_at

    conn = fake_conn(BASE_TABLE, bars(T0, 200))
    # 入场时刻晚于 asOf：持仓期内没有任何已收盘 K 线
    with pytest.raises(SyncError) as exc:
        atr_at(
            conn,
            "SYM",
            entry_time_ms=T0 + 500 * MINUTE,
            interval="1m",
            period=14,
            as_of_ms=T0 + 200 * MINUTE,
        )
    assert exc.value.code == "RISK_TRAIL_EXTREME_UNAVAILABLE"
    assert exc.value.code in ERROR_CODES
    # 两个码都必须在册：合并会让「拒绝下单」与「本轮不调整」共用一个处置方式（R-6.5）。
    assert "RISK_ATR_UNAVAILABLE" in ERROR_CODES
    assert exc.value.code not in MANUAL_INTERVENTION_CODES


def test_extreme_rejects_non_positive_entry_time() -> None:
    """entryTime 必填且必须合法：默认成 0 就等于「拿入场前的价格当极值」。"""
    from quant_data.risk import atr_at

    conn = fake_conn(BASE_TABLE, bars(T0, 200))
    for bad in (0, -1, True):
        with pytest.raises(SyncError) as exc:
            atr_at(
                conn,
                "SYM",
                entry_time_ms=bad,
                interval="1m",
                period=14,
                as_of_ms=T0 + 200 * MINUTE,
            )
        assert exc.value.code == "CONFIG_INVALID"


def test_compute_position_extreme_guards_non_finite() -> None:
    """NaN 极值绝不能流到 stdout（TS 侧会读成 null，然后算出 -Infinity 的止损）。"""
    rows = bars(T0, 10)
    rows[3]["high"] = float("nan")
    with pytest.raises(SyncError) as exc:
        compute_position_extreme(window_of(rows), T0, symbol="SYM", interval="1m")
    assert exc.value.code == "RISK_TRAIL_EXTREME_UNAVAILABLE"


def test_atr_and_extreme_come_from_one_read() -> None:
    """一次调用只查一次库：两次取数之间会落进一根新 bar，公式随之失去意义（R-6.2）。"""
    from quant_data.risk import atr_at

    fake = FakeConn(BASE_TABLE, bars(T0, 200))
    atr_at(
        cast(DbConn, fake),
        "SYM",
        entry_time_ms=T0,
        interval="1m",
        period=14,
        as_of_ms=T0 + 200 * MINUTE,
    )
    assert len(fake.calls) == 1, (
        f"ATR / 极值 / lastClose 必须共用一次取数，实际 {len(fake.calls)} 次"
    )


def test_tail_window_keeps_only_the_latest_bars() -> None:
    """ATR 只用自己尾部那一段，不吃持仓期多读出来的部分。"""
    rows = bars(T0, 300)
    window = tail_window(window_of(rows), 240)
    assert len(window) == 240
    assert window.times[0] == T0 + 60 * MINUTE
    assert window.times[-1] == T0 + 299 * MINUTE


def test_snapshot_json_has_no_nan() -> None:
    """stdout 里不许出现 NaN / Infinity——dump_json 用 allow_nan=False，会直接抛。"""
    import json

    from quant_data.risk import atr_at

    conn = fake_conn(BASE_TABLE, bars(T0, 200, step=0.5))
    payload = atr_at(
        conn, "SYM", entry_time_ms=T0, interval="1m", period=14, as_of_ms=T0 + 200 * MINUTE
    ).to_dict()
    text = json.dumps(payload, ensure_ascii=False, allow_nan=False)
    assert "NaN" not in text and "Infinity" not in text
