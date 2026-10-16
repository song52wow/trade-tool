"""v0.2.0 派生周期的单元测试：桶对齐、覆盖判据、聚合公式（AC-1..5 / AC-17 / AC-18）。

这些用例**不碰数据库**：判据与聚合值都是纯函数，因此可以逐值断言手算结果。
需要 PG 的部分在 ``test_aggregate_pg.py``。
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from quant_data import aggregate as agg
from quant_data.binance import ONE_MINUTE_MS, Kline
from quant_data.errors import SyncError

# 附录 A.2 的边界值（2025-01-01T00:00:00Z = 1735689600000）
T2025 = 1_735_689_600_000
W4H = 14_400_000
W1D = 86_400_000
W15M = 900_000
W1H = 3_600_000

REPO_ROOT = Path(__file__).resolve().parents[4]
SQL_FILE = REPO_ROOT / "packages" / "data" / "sql" / "004_klines_agg.sql"


def bar(time_ms: int, base: float, quote: float | None = 1.0, trades: int | None = 1) -> Kline:
    return Kline(
        time=time_ms,
        open=base,
        high=base + 1.0,
        low=base - 1.0,
        close=base + 0.5,
        volume=10.0,
        close_time=time_ms + ONE_MINUTE_MS - 1,
        quote_volume=quote,
        trades=trades,
    )


# --------------------------------------------------------------- AC-3 UTC 对齐


class TestBucketAlignment:
    """AC-3 / 附录 A.2：桶起点恒为 UTC 边界，与本地时区无关。"""

    @pytest.mark.parametrize(
        ("time_ms", "width", "expected"),
        [
            (T2025, W15M, T2025),
            (T2025 + W15M - 1, W15M, T2025),  # 00:14:59.999 → 桶 00:00
            (T2025 + W1H - 1, W1H, T2025),  # 00:59:59.999 → 桶 00:00
            (T2025 + W4H - 1, W4H, T2025),  # 03:59:59.999 → 桶 00:00
            (T2025 + W4H, W4H, T2025 + W4H),  # 04:00:00.000 → 换桶
            (T2025 + W1D - 1, W1D, T2025),  # 当日 23:59:59.999 → 当日 00:00
        ],
    )
    def test_边界值(self, time_ms: int, width: int, expected: int) -> None:
        assert agg.bucket_start(time_ms, width) == expected

    def test_1d桶起点恒为UTC零点(self) -> None:
        # 连续 400 天里每个 1d 桶起点都必须是 86_400_000 的整数倍（epoch 0 = UTC 零点）
        start = 1_700_000_000_000 - (1_700_000_000_000 % W1D)
        for day in range(400):
            bucket = agg.bucket_start(start + day * W1D, W1D)
            assert bucket % W1D == 0

    def test_4h桶只落在UTC的0_4_8_12_16_20点(self) -> None:
        hour_offsets = {
            (agg.bucket_start(T2025 + d * W4H, W4H) // 3_600_000) % 24 for d in range(30)
        }
        assert hour_offsets == {0, 4, 8, 12, 16, 20}

    def test_不依赖本地时区(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # 判据与对齐只做整数取模；换个 TZ 结果必须**逐个相同**。
        results = []
        for tz in ("UTC", "Asia/Shanghai", "America/New_York"):
            monkeypatch.setenv("TZ", tz)
            results.append(
                [agg.bucket_start(T2025 + d * W4H, W4H) for d in range(10)]
                + [
                    agg.judge_bucket(
                        bucket=T2025,
                        width_ms=W4H,
                        first_ms=T2025,
                        last_ms=T2025 + W4H - ONE_MINUTE_MS,
                        actual=W4H // ONE_MINUTE_MS,
                    ).write
                ]
            )
        assert results[0] == results[1] == results[2]

    def test_桶宽非正报错(self) -> None:
        with pytest.raises(SyncError) as excinfo:
            agg.bucket_start(T2025, 0)
        assert excinfo.value.code == "CONFIG_INVALID"


# ------------------------------------------------------- R-3 收盘与覆盖判据


class TestJudgeBucket:
    """R-3：只有 ``closed 且 actual == expected 且 actual > 0`` 才写桶。"""

    def test_完整且已收盘的桶可写(self) -> None:
        verdict = agg.judge_bucket(
            bucket=T2025,
            width_ms=W4H,
            first_ms=T2025,
            last_ms=T2025 + W4H - ONE_MINUTE_MS,
            actual=W4H // ONE_MINUTE_MS,
        )
        assert verdict.write is True
        assert verdict.closed is True
        assert verdict.actual == verdict.expected == 240
        assert verdict.missing == 0

    def test_桶内少一根则不写(self) -> None:
        """AC-5：部分覆盖的桶**不写**——半截蜡烛的高低点与成交量都是错的。"""
        verdict = agg.judge_bucket(
            bucket=T2025,
            width_ms=W4H,
            first_ms=T2025,
            last_ms=T2025 + W4H - ONE_MINUTE_MS,
            actual=239,
        )
        assert verdict.write is False
        assert verdict.closed is True
        assert verdict.missing == 1

    def test_未收盘桶不写(self) -> None:
        """AC-4：1m 只到 4h 桶中途 → 不写该桶。判据不读本地时钟。"""
        verdict = agg.judge_bucket(
            bucket=T2025,
            width_ms=W4H,
            first_ms=T2025,
            last_ms=T2025 + 120 * ONE_MINUTE_MS,
            actual=120,
        )
        assert verdict.write is False
        assert verdict.closed is False

    def test_补上末分钟后该桶可写(self) -> None:
        """AC-4 的后半句：补上最后一分钟 → 该桶出现。"""
        verdict = agg.judge_bucket(
            bucket=T2025,
            width_ms=W4H,
            first_ms=T2025,
            last_ms=T2025 + W4H - ONE_MINUTE_MS,
            actual=240,
        )
        assert verdict.write is True

    def test_onboard首日应写入且期望675根(self) -> None:
        """附录 C.1：`F` 落在 12:45，当天 1d 桶的期望根数是 675 而不是 1440。

        写死「一天必须 1440 根」会让新标的第一根日线**永远不存在**。
        """
        onboard = 1_704_285_900_000  # 2024-01-03T12:45:00Z
        bucket = agg.bucket_start(onboard, W1D)
        assert bucket == 1_704_240_000_000
        first_bar = onboard - (onboard % ONE_MINUTE_MS)
        last_bar = bucket + W1D - ONE_MINUTE_MS
        expected = (last_bar - first_bar) // ONE_MINUTE_MS + 1
        assert expected == 675
        verdict = agg.judge_bucket(
            bucket=bucket,
            width_ms=W1D,
            first_ms=first_bar,
            last_ms=last_bar,
            actual=expected,
            # 桶内最早一根就是该标的的第一根 → onboard 首日，期望根数从 F 起算
            bucket_first_ms=first_bar,
        )
        assert verdict.write is True

    def test_桶完全在数据区间之外不参与统计(self) -> None:
        """附录 C.4：`win` 为空 → expected 不得为 0/负数，否则除零与「空桶算合格」。"""
        verdict = agg.judge_bucket(
            bucket=T2025,
            width_ms=W4H,
            first_ms=T2025 + 10 * W4H,
            last_ms=T2025 + 11 * W4H,
            actual=0,
        )
        assert verdict.write is False
        assert verdict.window_start is None
        assert verdict.expected == 0
        assert verdict.missing == 0

    def test_数据末端恰好是桶的最后一分钟时当轮可写(self) -> None:
        """附录 C.2 第二行。"""
        verdict = agg.judge_bucket(
            bucket=T2025,
            width_ms=W1H,
            first_ms=T2025,
            last_ms=T2025 + W1H - ONE_MINUTE_MS,
            actual=60,
        )
        assert verdict.write is True

    def test_判据不读任何时钟(self) -> None:
        """R-3.2：判据只依赖 F/L 与桶内行集合，因此两次调用必同结果。"""
        kwargs = {
            "bucket": T2025,
            "width_ms": W4H,
            "first_ms": T2025,
            "last_ms": T2025 + 100 * ONE_MINUTE_MS,
            "actual": 100,
        }
        assert agg.judge_bucket(**kwargs) == agg.judge_bucket(**kwargs)

    @pytest.mark.parametrize("interval", ["15m", "1h", "4h", "1d"])
    @pytest.mark.parametrize("actual", [0, 1, 7])
    def test_参数化到四周期(self, interval: str, actual: int) -> None:
        width = agg.interval_width(interval)
        verdict = agg.judge_bucket(
            bucket=T2025,
            width_ms=width,
            first_ms=T2025,
            last_ms=T2025 + width - ONE_MINUTE_MS,
            actual=actual,
        )
        expected_ok = actual == width // ONE_MINUTE_MS
        assert verdict.write is expected_ok


# ------------------------------------------------------------ AC-2 / AC-17 聚合值


class TestAggregateRows:
    """AC-2 逐值正确 + AC-17 NULL 不冒充。"""

    def test_ohlcv取首末与极值(self) -> None:
        rows = [bar(T2025 + i * ONE_MINUTE_MS, base=100.0 + i) for i in range(15)]
        out = agg.aggregate_rows(rows)
        assert out.time == T2025
        assert out.open == 100.0  # 首行 open
        assert out.close == 114.5  # 末行 close
        assert out.high == 114.0 + 1.0  # max(high)
        assert out.low == 99.0  # min(low)
        assert out.volume == 150.0  # 15 × 10

    def test_入参乱序也按时间排序(self) -> None:
        rows = [bar(T2025 + i * ONE_MINUTE_MS, base=100.0 + i) for i in range(15)]
        shuffled = list(reversed(rows))
        assert agg.aggregate_rows(shuffled) == agg.aggregate_rows(rows)

    def test_quote_volume任一为NULL则结果NULL(self) -> None:
        """AC-17：既不部分求和，也不写 0。"""
        rows = [bar(T2025 + i * ONE_MINUTE_MS, 100.0, quote=2.0) for i in range(15)]
        rows[7] = bar(T2025 + 7 * ONE_MINUTE_MS, 100.0, quote=None)
        assert agg.aggregate_rows(rows).quote_volume is None

    def test_quote_volume全非NULL才求和(self) -> None:
        rows = [bar(T2025 + i * ONE_MINUTE_MS, 100.0, quote=2.5) for i in range(15)]
        assert agg.aggregate_rows(rows).quote_volume == pytest.approx(37.5)

    def test_trades同规则(self) -> None:
        rows = [bar(T2025 + i * ONE_MINUTE_MS, 100.0, trades=3) for i in range(15)]
        rows[0] = bar(T2025, 100.0, trades=None)
        assert agg.aggregate_rows(rows).trades is None
        rows[0] = bar(T2025, 100.0, trades=3)
        assert agg.aggregate_rows(rows).trades == 45

    def test_零值不是NULL(self) -> None:
        """R-4.3：0 是合法值，绝不能被当成「缺失」。"""
        rows = [bar(T2025 + i * ONE_MINUTE_MS, 100.0, quote=0.0, trades=0) for i in range(15)]
        out = agg.aggregate_rows(rows)
        assert out.quote_volume == 0.0
        assert out.trades == 0

    def test_空桶报错而不是返回空值(self) -> None:
        with pytest.raises(SyncError) as excinfo:
            agg.aggregate_rows([])
        assert excinfo.value.code == "AGGREGATION_FAILED"

    @pytest.mark.parametrize("interval", ["15m", "1h", "4h", "1d"])
    def test_每周期都给出确定结果(self, interval: str) -> None:
        width = agg.interval_width(interval)
        count = width // ONE_MINUTE_MS
        rows = [bar(T2025 + i * ONE_MINUTE_MS, base=50.0 + i) for i in range(count)]
        out = agg.aggregate_rows(rows)
        assert out.open == 50.0
        assert out.close == 50.0 + count - 1 + 0.5
        assert out.volume == 10.0 * count
        # 纯数据变换：同样输入必得同样输出（R-2.4）
        assert agg.aggregate_rows(rows) == out


# ------------------------------------------------------------------ 白名单


class TestIntervalWhitelist:
    """R-9.1 / AC-12：未实现周期一律 CONFIG_INVALID，绝不静默跳过。"""

    @pytest.mark.parametrize("bad", ["1m", "5m", "2h", "foo", ""])
    def test_未实现周期报错(self, bad: str) -> None:
        with pytest.raises(SyncError) as excinfo:
            agg.validate_intervals([bad])
        assert excinfo.value.code == "CONFIG_INVALID"

    def test_按短到长归一(self) -> None:
        assert agg.validate_intervals(["1d", "15m", "4h"]) == ("15m", "4h", "1d")

    def test_去重且保持固定次序(self) -> None:
        # 固定次序是幂等断言的前提：连续两次补齐的 JSON 必须逐字节相同（R-5.7）
        assert agg.validate_intervals(["4h", "4h", "1h"]) == ("1h", "4h")

    def test_空集合合法表示显式关闭(self) -> None:
        assert agg.validate_intervals([]) == ()

    def test_部分失败即整体失败(self) -> None:
        with pytest.raises(SyncError):
            agg.validate_intervals(["15m", "5m"])


# ---------------------------------------------------------------- AC-1 三方一致


class TestSchemaMapping:
    """R-1.6 / AC-1：core 映射、quant_data 映射、迁移文件表集合三方一致。"""

    def test_迁移文件里的表集合与本模块一致(self) -> None:
        found = set(re.findall(r"CREATE TABLE IF NOT EXISTS (klines_\w+)", SQL_FILE.read_text()))
        assert found == set(agg.DERIVED_TABLES.values())
        assert "klines_1m" not in found, "004 不得重建 1m 表（R-1.4）"

    def test_每张派生表都有BRIN索引(self) -> None:
        text = SQL_FILE.read_text()
        for table in agg.DERIVED_TABLES.values():
            assert f"ON {table} USING BRIN (symbol, time)" in text

    def test_桶宽与表名一一对应(self) -> None:
        assert set(agg.BUCKET_WIDTHS_MS) == set(agg.DERIVED_TABLES)
        # 每标的每年桶数 = 365 天 / 桶宽（附录 B.1）
        expected = {"15m": 35_040, "1h": 8_760, "4h": 2_190, "1d": 365}
        for interval, bars in expected.items():
            assert 365 * W1D // agg.interval_width(interval) == bars

    def test_每个桶宽都整除一天(self) -> None:
        for interval, width in agg.BUCKET_WIDTHS_MS.items():
            assert W1D % width == 0, f"{interval} 的桶宽必须整除一天"


class TestBucketStarts:
    def test_两端都含住(self) -> None:
        # 区间末桶必须被完整重算，否则跨批的桶永远差一根（R-4.2）
        assert agg.bucket_starts(T2025 + 60_000, T2025 + 100 * 60_000, W1H) == [
            T2025,
            T2025 + W1H,
        ]

    def test_起点即桶起点时只含该桶(self) -> None:
        assert agg.bucket_starts(T2025, T2025 + 59 * ONE_MINUTE_MS, W1H) == [T2025]

    def test_ceil_to_bucket含住末桶(self) -> None:
        assert agg.ceil_to_bucket(T2025, W4H) == T2025
        assert agg.ceil_to_bucket(T2025 + 1, W4H) == T2025 + W4H
        assert agg.ceil_to_bucket(T2025 + W4H, W4H) == T2025 + W4H


# ------------------------------------------------------------- AC-18 源码无标的


def test_源码不得出现真实合约名() -> None:
    """AC-18：`src` 下不得出现任何真实合约名。测试与文档除外。"""
    patterns = re.compile(r"SOLUSDC|BTCUSDC|DOGEUSDC")
    roots = [
        REPO_ROOT / "python" / "packages",
        REPO_ROOT / "packages" / "core" / "src",
        REPO_ROOT / "packages" / "data" / "src",
        REPO_ROOT / "apps",
    ]
    hits: list[str] = []
    for root in roots:
        for path in root.rglob("*"):
            if not path.is_file() or "node_modules" in path.parts:
                continue
            if path.suffix not in {".py", ".ts", ".tsx", ".sql"}:
                continue
            if "tests" in path.parts or "test" in path.name:
                continue  # 测试夹具是唯一允许出现的地方（R-5.1 例外）
            if patterns.search(path.read_text(encoding="utf-8", errors="ignore")):
                hits.append(str(path.relative_to(REPO_ROOT)))
    assert hits == [], f"源码里出现了具体合约名：{hits}"
