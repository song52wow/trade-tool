"""行情上下文（v1.0.0）的测试：技术面现算 + 情绪面取数。

覆盖只能靠「真实 PG + 真实公式」证明的部分：

* **技术面**：由库内**派生 K 线**现算指标，取最后一段**连续** K 线；
  库���没有数据时报 ``AGENT_CONTEXT_UNAVAILABLE``（而不是算一个空的技术面）；
  周期不在白名单时报 ``CONFIG_INVALID``（不回落）。
* **情绪面**：七个公开端点各取一次；某个端点挂了时该项记 ``None``、
  失败原因进 ``notes``，**不静默变成 0**。
* **取不到就是取不到**：``None`` 不许变成 ``0``——「资金费率是 0」与
  「资金费率没取到」是两件事（AGENTS.md 约定 2）。

绝不出网：交易所侧是纯替身；PG 用 session 级独立 schema。
"""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import urlsplit

import pytest
from quant_data import market_context as mc
from quant_data.binance import BinanceClient
from quant_data.errors import SyncError
from quant_data.http import HttpResponse
from quant_data.pg import DbConn

W1H = 3_600_000

#: 2025-01-01T00:00:00Z（对齐到桶边界）
T0 = 1_735_689_600_000

SYMBOL = "ALPHAUSDC"


def insert_1h(conn: DbConn, symbol: str, start_ms: int, count: int) -> None:
    """写入 ``count`` 根连续 1h 派生 K 线（收盘价线性上升，便于逐值核对）。"""
    with conn.transaction():
        for i in range(count):
            t = start_ms + i * W1H
            base = 100.0 + i
            conn.execute(
                "INSERT INTO klines_1h"
                " (symbol, time, open, high, low, close, volume, quote_volume, trades)"
                " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)"
                " ON CONFLICT (symbol, time) DO NOTHING",
                (symbol, t, base, base + 1.0, base - 1.0, base, 10.0, 20.0, 3),
            )


class FakeTransport:
    """按路径返回固定响应的假传输层。**绝不出网**。"""

    def __init__(self, responses: dict[str, Any] | None = None) -> None:
        self.responses = responses or {}
        self.paths: list[str] = []

    def get(self, url: str, *, timeout_ms: int) -> HttpResponse:
        # 只取路径部分：客户端拼出来的是「基址 + 路径 + query」。
        path = urlsplit(url).path
        self.paths.append(path)
        if path in self.responses:
            return HttpResponse(200, json.dumps(self.responses[path]).encode(), {})
        return HttpResponse(404, b"{}", {})


def sentiment_responses() -> dict[str, Any]:
    return {
        "/fapi/v1/premiumIndex": {
            "symbol": SYMBOL,
            "markPrice": "100.5",
            "indexPrice": "100.0",
            "lastFundingRate": "0.0001",
            "nextFundingTime": 1_735_692_000_000,
        },
        "/fapi/v1/fundingRate": [
            {"symbol": SYMBOL, "fundingTime": 1, "fundingRate": "0.0002"},
            {"symbol": SYMBOL, "fundingTime": 2, "fundingRate": "0.0001"},
        ],
        "/fapi/v1/openInterest": {"symbol": SYMBOL, "openInterest": "12345.5"},
        "/futures/data/openInterestHist": [
            {"symbol": SYMBOL, "sumOpenInterest": "10000", "timestamp": 1},
            {"symbol": SYMBOL, "sumOpenInterest": "11000", "timestamp": 2},
        ],
        "/futures/data/globalLongShortAccountRatio": [
            {"symbol": SYMBOL, "longShortRatio": "1.2", "timestamp": 1},
        ],
        "/futures/data/takerlongshortRatio": [
            {"buySellRatio": "1.05", "buyVol": "10", "sellVol": "9", "timestamp": 1},
        ],
        "/fapi/v1/ticker/24hr": {
            "symbol": SYMBOL,
            "priceChangePercent": "1.20",
            "quoteVolume": "123456.0",
            "count": 42,
        },
    }


def test_technical_snapshot_reads_derived_bars(conn: DbConn) -> None:
    insert_1h(conn, SYMBOL, T0, 120)
    snap: dict[str, Any] = mc.technical_snapshot(conn, SYMBOL, "1h", 120)

    assert snap["interval"] == "1h"
    assert snap["segmentBars"] == 120
    assert snap["lastClose"] == 219.0
    # ATR 必须为正（否则止损会正好落在进场价上）
    assert isinstance(snap["atr"], float)
    assert snap["atr"] > 0
    assert snap["atrPercentOfPrice"] > 0
    # 均线要算出来
    ma = snap["ma"]
    assert isinstance(ma, list)
    assert {row["bars"] for row in ma} >= {5, 20, 60}
    # 客观倾向分在 [-1, 1] 内，且这里价格一路向上 → 偏多
    assert -1 <= snap["objectiveBias"] <= 1
    assert snap["objectiveBias"] > 0
    # 收益率序列与分位
    assert len(snap["recentReturns"]) == 20
    assert 0 <= snap["pricePercentile"] <= 1


def test_technical_snapshot_rejects_unsupported_interval(conn: DbConn) -> None:
    with pytest.raises(SyncError) as exc:
        mc.technical_snapshot(conn, SYMBOL, "1m", 100)
    assert exc.value.code == "CONFIG_INVALID"


def test_technical_snapshot_without_data_is_context_unavailable(conn: DbConn) -> None:
    with pytest.raises(SyncError) as exc:
        mc.technical_snapshot(conn, SYMBOL, "1h", 100)
    assert exc.value.code == "AGENT_CONTEXT_UNAVAILABLE"


def test_technical_snapshot_uses_last_continuous_segment(conn: DbConn) -> None:
    """中间有缺口时，指标只在**最后一段连续** K 线上算。"""
    insert_1h(conn, SYMBOL, T0, 60)
    # 60 根之后空 10 根，再写 30 根
    insert_1h(conn, SYMBOL, T0 + 70 * W1H, 30)
    snap: dict[str, Any] = mc.technical_snapshot(conn, SYMBOL, "1h", 200)
    assert snap["segmentBars"] == 30


def test_sentiment_snapshot_reads_all_endpoints() -> None:
    transport = FakeTransport(sentiment_responses())
    client = BinanceClient(transport, "https://example.invalid", None)
    snap: dict[str, Any] = mc.sentiment_snapshot(client, SYMBOL)

    assert snap["fundingRate"] == pytest.approx(0.0001)
    # 年化 = 单次费率 × 每天 3 次 × 365
    assert snap["fundingRateAnnualized"] == pytest.approx(0.0001 * 3 * 365)
    assert snap["markPrice"] == pytest.approx(100.5)
    assert snap["indexPrice"] == pytest.approx(100.0)
    # 基差 = (标记价 − 指数价) / 指数价 × 10000 = 50 个基点
    assert snap["basisBps"] == pytest.approx(50.0)
    assert snap["openInterest"] == pytest.approx(12345.5)
    # 持仓量从 10000 涨到 11000 → +10%
    assert snap["openInterestChangePct"] == pytest.approx(10.0)
    assert snap["longShortRatio"] == pytest.approx(1.2)
    assert snap["takerBuySellRatio"] == pytest.approx(1.05)
    assert snap["degraded"] is False
    assert snap["market"]["quoteVolume24h"] == pytest.approx(123456.0)
    assert snap["market"]["trades24h"] == 42
    assert snap["market"]["priceChangePct24h"] == pytest.approx(1.2)


def test_sentiment_snapshot_marks_missing_values_as_none_not_zero() -> None:
    """某个端点 404 → 该项是 ``None``，并把原因写进 notes。**不写 0。**"""
    responses = sentiment_responses()
    del responses["/fapi/v1/premiumIndex"]
    transport = FakeTransport(responses)
    client = BinanceClient(transport, "https://example.invalid", None)
    snap: dict[str, Any] = mc.sentiment_snapshot(client, SYMBOL)

    # 标记价与指数价没有第二个来源可退 → None（**不是 0**）
    assert snap["markPrice"] is None
    assert snap["indexPrice"] is None
    assert snap["basisBps"] is None
    assert snap["degraded"] is True
    assert any("标记价" in note for note in snap["notes"])
    # 资金费率**有**历史接口可退：premiumIndex 拿不到时用历史最后一次。
    # 这是「换一个来源」，不是「把缺失当 0」。
    assert snap["fundingRate"] == pytest.approx(0.0001)


def test_sentiment_snapshot_never_turns_missing_into_zero() -> None:
    """全部端点都取不到时，所有数值项都是 ``None``，没有一个是 0。"""
    transport = FakeTransport({})
    client = BinanceClient(transport, "https://example.invalid", None)
    snap: dict[str, Any] = mc.sentiment_snapshot(client, SYMBOL)

    for key in (
        "fundingRate",
        "fundingRateAnnualized",
        "markPrice",
        "indexPrice",
        "basisBps",
        "openInterest",
        "openInterestChangePct",
        "longShortRatio",
        "takerBuySellRatio",
    ):
        assert snap[key] is None, key
    assert snap["degraded"] is True
    assert len(snap["notes"]) > 0
