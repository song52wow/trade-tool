"""聚合失败的事务语义（v0.2.0 AC-21 / R-4.2 / R-4.6 / R-9.3）。

核心断言只有一条：**聚合失败时该批 1m 也一起回滚**。理由很直接——若 1m 已提交而
派生没跟上，就出现了「数据已入库、派生永远不会跟上、且无人察觉」的窗口：那正是
R-4.2 明令禁止的状态。派生层宁可拖慢同步，也必须与 1m 同生共死。

同时验证错误码是 ``AGGREGATION_FAILED``（属「需人工介入」，不无限重试）与「显式关闭
派生是合法配置」这两条。
"""

from __future__ import annotations

from typing import Any

import pytest
from conftest import SymbolCase, serve_exchange
from quant_data import aggregate as agg
from quant_data import pg
from quant_data import sync as sync_mod
from quant_data.errors import SyncError
from quant_data.pg import DbConn

T0 = 1_735_689_600_000
ONE_MINUTE = 60_000


def _rows_in_store(conn: DbConn, symbol: str) -> int:
    row = conn.execute(
        "SELECT count(*) AS n FROM klines_1m WHERE symbol = %s", (symbol,)
    ).fetchone()
    assert row is not None
    return int(row["n"])


def _bar_rows_in_store(conn: DbConn, symbol: str) -> int:
    row = conn.execute(
        f"SELECT count(*) AS n FROM {agg.DERIVED_TABLES['4h']} WHERE symbol = %s", (symbol,)
    ).fetchone()
    assert row is not None
    return int(row["n"])


class _BoomError(RuntimeError):
    """注入到聚合层的假故障。裸异常会�� ``write_bars_and_aggregate`` 归一成
    ``AGGREGATION_FAILED``，因此这里**不能**用 SyncError——它要证明的正是
    「非 SyncError 的异常也被正确归类」。"""


class TestAggregationFailureRollsBack:
    def test_聚合失败时1m整批回滚(self, conn: DbConn, symbol_case: SymbolCase) -> None:
        """AC-21：该批 1m 不得留在库里。"""
        fake = _fake_exchange(symbol_case)
        with serve_exchange(fake) as base_url, _patched_batch(base_url):
            before = _rows_in_store(conn, symbol_case.symbol)
            with pytest.raises(SyncError) as excinfo:
                sync_mod.run_sync(_options(symbol_case, aggregate_intervals=("4h",), batch_size=50))
        assert excinfo.value.code == "AGGREGATION_FAILED"
        # 关键断言：1m 一根都没留下
        assert _rows_in_store(conn, symbol_case.symbol) == before

    def test_失败后派生表也不留半截(self, conn: DbConn, symbol_case: SymbolCase) -> None:
        """整批回滚意味着派生表同样干净——不会出现「1m 没了、4h 还在」的矛盾。"""
        fake = _fake_exchange(symbol_case)
        with (
            serve_exchange(fake) as base_url,
            _patched_batch(base_url),
            pytest.raises(SyncError),
        ):
            sync_mod.run_sync(_options(symbol_case, aggregate_intervals=("4h",), batch_size=50))
        assert _bar_rows_in_store(conn, symbol_case.symbol) == 0

    def test_水位不推进(self, conn: DbConn, symbol_case: SymbolCase) -> None:
        """R-4.2：水位与数据同事务；数据回滚了水位就不能前进。"""
        fake = _fake_exchange(symbol_case)
        with (
            serve_exchange(fake) as base_url,
            _patched_batch(base_url),
            pytest.raises(SyncError),
        ):
            sync_mod.run_sync(_options(symbol_case, aggregate_intervals=("4h",), batch_size=50))
        assert pg.max_time(conn, symbol_case.symbol) is None
        state = pg.read_state(conn, "binance", symbol_case.symbol)
        if state is not None:
            assert state.get("watermark") is None

    def test_错误details带定位信息(self, conn: DbConn, symbol_case: SymbolCase) -> None:
        """用户必须知道是哪个标的、哪个周期、哪段区间出的问题（R-22.4）。"""
        fake = _fake_exchange(symbol_case)
        with (
            serve_exchange(fake) as base_url,
            _patched_batch(base_url),
            pytest.raises(SyncError) as excinfo,
        ):
            sync_mod.run_sync(_options(symbol_case, aggregate_intervals=("4h",), batch_size=50))
        details = excinfo.value.details
        assert details["symbol"] == symbol_case.symbol
        assert "4h" in str(details.get("intervals"))
        assert details["from"] is not None and details["to"] is not None


class TestExplicitDisable:
    def test_空intervals不写派生表也不报错(self, conn: DbConn, symbol_case: SymbolCase) -> None:
        """AC-22：关闭派生是**显式配置**，1m 同步照常成功。"""
        fake = _fake_exchange(symbol_case)
        with serve_exchange(fake) as base_url, _patched_batch(base_url):
            summary = sync_mod.run_sync(
                _options(symbol_case, aggregate_intervals=(), batch_size=50)
            )
        added = summary["added"]
        assert isinstance(added, int) and added > 0
        assert summary["aggregated"] is None, "未启用派生必须是 None 而不是空对象"
        assert _bar_rows_in_store(conn, symbol_case.symbol) == 0
        assert _rows_in_store(conn, symbol_case.symbol) > 0

    def test_未实现周期报CONFIG_INVALID(self, symbol_case: SymbolCase) -> None:
        """R-9.1：出现 1m / 5m / 其它一律报错，不静默跳过。"""
        for bad in (("5m",), ("1m",), ("2h",)):
            with pytest.raises(SyncError) as excinfo:
                sync_mod.resolve_aggregate_intervals(sync_mod.SyncOptions(aggregate_intervals=bad))
            assert excinfo.value.code == "CONFIG_INVALID"

    def test_默认intervals是四个已实现周期(self) -> None:
        assert sync_mod.DEFAULT_AGGREGATE_INTERVALS == ("15m", "1h", "4h", "1d")

    def test_显式配置覆盖默认(self) -> None:
        opts = sync_mod.SyncOptions(aggregate_intervals=("1h",))
        assert sync_mod.resolve_aggregate_intervals(opts) == ("1h",)

    def test_未指定时用默认(self) -> None:
        assert sync_mod.resolve_aggregate_intervals(sync_mod.SyncOptions()) == (
            "15m",
            "1h",
            "4h",
            "1d",
        )


class TestAggregateUnlocksNothing:
    def test_aggregate命令在库无数据时报SYMBOL_NOT_FOUND(self, pg_dsn: str) -> None:
        """「成功但写了 0 个桶」是 R-14 禁止的静默兜底。"""
        with pytest.raises(SyncError) as excinfo:
            sync_mod.run_aggregate(sync_mod.SyncOptions(symbol="GHOSTUSDC", dsn=pg_dsn))
        assert excinfo.value.code == "SYMBOL_NOT_FOUND"


class TestAggregateCheckShape:
    def test_check的每周期键名与补齐一致(self, conn: DbConn, symbol_case: SymbolCase) -> None:
        """R-5.6 / R-8.3：``--check`` 与补齐必须返回**同一个形状**。

        回归用例：check 分支一度直接返回 ``withheld_counts`` 的内部简称键
        （``notClosed`` / ``incomplete``），与跨语言契约 ``AggregateIntervalStats``
        （``withheldNotClosed`` / ``withheldIncomplete``）对不上。后果不是「显示不准」
        而是**命令直接崩**：CLI 打印 ``stats.withheldNotClosed.toLocaleString()`` 抛
        TypeError，于是一份完全一致的库上 ``data aggregate --check`` 永远无法成功退出 0。
        """
        opts = _options(symbol_case, aggregate_intervals=("4h",))
        bucket = 1_735_689_600_000 - (1_735_689_600_000 % 14_400_000)
        with conn.transaction():
            for i in range(240):  # 一个完整的 4h 桶
                conn.execute(
                    "INSERT INTO klines_1m (symbol, time, open, high, low, close, volume)"
                    " VALUES (%s, %s, 1, 2, 0.5, 1.5, 10)",
                    (symbol_case.symbol, bucket + i * ONE_MINUTE),
                )
        fill = sync_mod.run_aggregate(opts)
        check = sync_mod.run_aggregate(opts, check=True)
        fill_intervals = fill["intervals"]
        check_intervals = check["intervals"]
        assert isinstance(fill_intervals, dict) and isinstance(check_intervals, dict)
        expected = {"upserted", "withheldNotClosed", "withheldIncomplete", "missingMinutes"}
        fill_four = fill_intervals["4h"]
        check_four = check_intervals["4h"]
        assert isinstance(fill_four, dict) and isinstance(check_four, dict)
        assert set(fill_four) == expected
        assert set(check_four) == expected
        assert check_four["withheldNotClosed"] == 0
        assert check_four["withheldIncomplete"] == 0


# ------------------------------------------------------------- 测试辅助


def _fake_exchange(case: SymbolCase) -> Any:
    from conftest import FakeExchange

    return FakeExchange(cases=(case,))


def _options(case: SymbolCase, **kwargs: object) -> Any:
    from conftest import TEST_SCHEMA

    return sync_mod.SyncOptions(
        exchange="binance",
        symbol=case.symbol,
        dsn=f"postgresql://trade:trade@127.0.0.1:5432/trade_tool"
        f"?options=-c%20search_path%3D{TEST_SCHEMA}",
        transport=None,
        base_url=None,
        weight_budget=100_000,
        max_gap_attempts=1,
        now_ms=1_800_000_000_000,
        **kwargs,  # type: ignore[arg-type]
    )


def _patched_batch(base_url: str) -> Any:
    """把交易所指向假服务器，并让聚合层抛 ``_Boom``。

    这里必须走**真实**的 ``_stream_pull_and_write``（而不是直接调
    ``write_bars_and_aggregate``）：AC-21 要证明的是「整批回滚」，
    而回滚边界是调用方的 ``with writer.transaction()``，只在真实调用链里才存在。
    """
    import os
    from contextlib import contextmanager

    from conftest import cli_env  # noqa: F401  - 保证 conftest 已被加载

    @contextmanager
    def patcher() -> Any:
        previous_url = os.environ.get("TRADE_TOOL_BINANCE_BASE_URL")
        previous_batches = agg.aggregate_batches
        os.environ["TRADE_TOOL_BINANCE_BASE_URL"] = base_url

        def boom(*_args: object, **_kwargs: object) -> Any:
            raise _BoomError("注入的聚合故障")

        agg.aggregate_batches = boom
        try:
            yield
        finally:
            agg.aggregate_batches = previous_batches
            if previous_url is None:
                os.environ.pop("TRADE_TOOL_BINANCE_BASE_URL", None)
            else:
                os.environ["TRADE_TOOL_BINANCE_BASE_URL"] = previous_url

    return patcher()
