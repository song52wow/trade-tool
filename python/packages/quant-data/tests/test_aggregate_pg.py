"""v0.2.0 派生周期与真实 PostgreSQL 的接缝测试。

覆盖只能靠「真实 PG + 真实 SQL」证明的验收项：
AC-1 迁移与列对称、AC-2 逐值正确、AC-5 扣留可见、AC-7 幂等、
AC-9 重建与校验、AC-11 删除连带、AC-16 实测体积、AC-17 NULL 不冒充。

每个用例跑在同一个 session 级独立 schema 上（conftest 的 ``conn`` fixture），
业务表逐用例清空，**绝不连生产库**（R-16.2）。
"""

from __future__ import annotations

from typing import Any

import pytest
from quant_data import aggregate as agg
from quant_data import pg
from quant_data.binance import ONE_MINUTE_MS
from quant_data.errors import SyncError
from quant_data.pg import DbConn

W4H = 14_400_000
W1H = 3_600_000
W1D = 86_400_000

#: 2025-01-01T00:00:00Z，与附录 A.2 一致
T0 = 1_735_689_600_000

SYMBOLS = ("ALPHAUSDC", "BETATUSDC", "GAMMAUSDC")


def insert(
    conn: DbConn,
    symbol: str,
    start_ms: int,
    count: int,
    *,
    quote: float | None = 2.0,
    trades: int | None = 3,
) -> None:
    """写入 ``count`` 根连续 1m。价格随索引线性变化，便于逐值核对。"""
    with conn.transaction():
        for i in range(count):
            t = start_ms + i * ONE_MINUTE_MS
            conn.execute(
                "INSERT INTO klines_1m"
                " (symbol, time, open, high, low, close, volume, quote_volume, trades)"
                " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)"
                " ON CONFLICT (symbol, time) DO NOTHING",
                (
                    symbol,
                    t,
                    float(100 + i),
                    float(101 + i),
                    float(99 + i),
                    float(100 + i),
                    10.0,
                    quote,
                    trades,
                ),
            )


def current_schema(conn: DbConn) -> str:
    row = conn.execute("SELECT current_schema() AS s").fetchone()
    assert row is not None
    return str(row["s"])


def buckets_of(conn: DbConn, symbol: str, interval: str) -> list[tuple[Any, ...]]:
    rows = conn.execute(
        f"SELECT time, open, high, low, close, volume, quote_volume, trades"
        f"  FROM {agg.DERIVED_TABLES[interval]}"
        f" WHERE symbol = %s ORDER BY time",
        (symbol,),
    ).fetchall()
    return [
        (
            int(r["time"]),
            float(r["open"]),
            float(r["high"]),
            float(r["low"]),
            float(r["close"]),
            float(r["volume"]),
            None if r["quote_volume"] is None else float(r["quote_volume"]),
            None if r["trades"] is None else int(r["trades"]),
        )
        for r in rows
    ]


# ------------------------------------------------------------------ AC-1 迁移


class TestMigration:
    def test_004已应用(self, conn: DbConn) -> None:
        applied = {
            str(r["version"])
            for r in conn.execute("SELECT version FROM schema_migrations").fetchall()
        }
        assert "004_klines_agg" in applied

    def test_四张派生表都存在(self, conn: DbConn) -> None:
        for table in agg.DERIVED_TABLES.values():
            row = conn.execute("SELECT to_regclass(%s) AS reg", (table,)).fetchone()
            assert row is not None and row["reg"] is not None, f"缺少表 {table}"

    @pytest.mark.parametrize("table", sorted(agg.DERIVED_TABLES.values()))
    def test_列与klines_1m逐列相等(self, conn: DbConn, table: str) -> None:
        """R-1.3：用 information_schema 断言，而不是把 DDL 再抄一遍。

        **必须按 schema 过滤**：``information_schema.columns`` 是全库的，不加
        ``table_schema`` 会把 ``public`` 里的同名表也捞进来——那会让列比较在
        「另一个 schema 有张同名但结构不同的表」时假失败。
        """
        schema = current_schema(conn)
        columns = {
            "klines_1m": conn.execute(
                "SELECT column_name, data_type, is_nullable, ordinal_position"
                "  FROM information_schema.columns"
                " WHERE table_schema = %s AND table_name = 'klines_1m' ORDER BY ordinal_position",
                (schema,),
            ).fetchall(),
            table: conn.execute(
                "SELECT column_name, data_type, is_nullable, ordinal_position"
                "  FROM information_schema.columns"
                " WHERE table_schema = %s AND table_name = %s ORDER BY ordinal_position",
                (schema, table),
            ).fetchall(),
        }
        base = [
            (r["column_name"], r["data_type"], r["is_nullable"], r["ordinal_position"])
            for r in columns["klines_1m"]
        ]
        target = [
            (r["column_name"], r["data_type"], r["is_nullable"], r["ordinal_position"])
            for r in columns[table]
        ]
        assert target == base, f"{table} 的列与 klines_1m 不一致"

    @pytest.mark.parametrize("table", sorted(agg.DERIVED_TABLES.values()))
    def test_主键为symbol_time(self, conn: DbConn, table: str) -> None:
        # 必须按 namespace 限定：pg_class 是全库的，不加限定会匹配到 public 里的同名表。
        rows = conn.execute(
            "SELECT a.attname FROM pg_index i"
            "  JOIN pg_class c ON c.oid = i.indrelid"
            "  JOIN pg_namespace n ON n.oid = c.relnamespace"
            "  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)"
            " WHERE c.relname = %s AND i.indisprimary"
            "   AND n.nspname = current_schema() ORDER BY a.attnum",
            (table,),
        ).fetchall()
        assert [str(r["attname"]) for r in rows] == ["symbol", "time"]

    def test_1m表未被改动(self, conn: DbConn) -> None:
        """R-1.4：004 不得给 klines_1m 加列或改主键。"""
        schema = current_schema(conn)
        rows = conn.execute(
            "SELECT column_name FROM information_schema.columns"
            " WHERE table_schema = %s AND table_name = 'klines_1m' ORDER BY ordinal_position",
            (schema,),
        ).fetchall()
        assert [str(r["column_name"]) for r in rows] == [
            "symbol",
            "time",
            "open",
            "high",
            "low",
            "close",
            "volume",
            "quote_volume",
            "trades",
        ]

    def test_派生表可整表清空而不影响1m(self, conn: DbConn) -> None:
        """R-1.4：派生表必须能整表清空重建而不影响 1m（R-5）。"""
        insert(conn, "TRUNCUSDC", T0, 3)
        with conn.transaction():
            conn.execute("TRUNCATE klines_4h")
        assert pg.count_rows(conn, "TRUNCUSDC") == 3


# ---------------------------------------------------- AC-2 / AC-17 逐值正确


class TestAggregateValues:
    @pytest.mark.parametrize("interval", ["15m", "1h", "4h", "1d"])
    def test_四个周期的桶与手算值一致(self, conn: DbConn, interval: str) -> None:
        width = agg.interval_width(interval)
        count = width // ONE_MINUTE_MS
        # 从 4h 边界起铺满两个桶 + 一个不完整桶
        start = T0
        insert(conn, "VALUSDC", start, count * 2 + 5)

        with conn.transaction():
            agg.aggregate_range(
                conn, "VALUSDC", interval, start, start + (count * 2) * ONE_MINUTE_MS - 1
            )

        rows = buckets_of(conn, "VALUSDC", interval)
        assert len(rows) == 2, "未收盘的第 3 个桶不得写入（R-3.3）"
        for index, (bucket, o, h, low, c, vol, qv, tr) in enumerate(rows):
            base = index * count
            assert bucket == start + index * width
            assert o == 100.0 + base
            assert c == 100.0 + base + count - 1
            assert h == 101.0 + base + count - 1
            assert low == 99.0 + base
            assert vol == 10.0 * count
            assert qv == 2.0 * count
            assert tr == 3 * count

    @pytest.mark.parametrize("interval", ["15m", "1h", "4h", "1d"])
    def test_任一1m为NULL则桶为NULL(self, conn: DbConn, interval: str) -> None:
        """AC-17：quote_volume / trades 不得部分求和、不得写 0。"""
        width = agg.interval_width(interval)
        count = width // ONE_MINUTE_MS
        insert(conn, "NULLUSDC", T0, count)
        with conn.transaction():
            conn.execute(
                "UPDATE klines_1m SET quote_volume = NULL WHERE symbol = 'NULLUSDC' AND time = %s",
                (T0 + 7 * ONE_MINUTE_MS,),
            )
            agg.aggregate_range(conn, "NULLUSDC", interval, T0, T0 + width - ONE_MINUTE_MS)
        rows = buckets_of(conn, "NULLUSDC", interval)
        assert len(rows) == 1
        assert rows[0][6] is None, "quote_volume 必须为 NULL 而不是部分求和"

    def test_trades同NULL规则(self, conn: DbConn) -> None:
        insert(conn, "NULLTRD", T0, 15)
        with conn.transaction():
            conn.execute(
                "UPDATE klines_1m SET trades = NULL WHERE symbol = 'NULLTRD' AND time = %s",
                (T0 + ONE_MINUTE_MS,),
            )
            agg.aggregate_range(conn, "NULLTRD", "15m", T0, T0 + 14 * ONE_MINUTE_MS)
        assert buckets_of(conn, "NULLTRD", "15m")[0][7] is None

    def test_onboard首日的1d桶应当出现(self, conn: DbConn) -> None:
        """附录 C.1：675 根的首日 1d 桶必须写入，而不是因为「不满一天」永远缺席。"""
        onboard = 1_704_285_900_000  # 2024-01-03T12:45:00Z
        first_bar = onboard - (onboard % ONE_MINUTE_MS)
        bucket = agg.bucket_start(first_bar, W1D)
        count = (bucket + W1D - ONE_MINUTE_MS - first_bar) // ONE_MINUTE_MS + 1
        assert count == 675
        insert(conn, "ONBOARDUSDC", first_bar, count)
        with conn.transaction():
            agg.aggregate_range(conn, "ONBOARDUSDC", "1d", first_bar, bucket + W1D - ONE_MINUTE_MS)
        rows = buckets_of(conn, "ONBOARDUSDC", "1d")
        assert len(rows) == 1
        assert rows[0][0] == bucket


# --------------------------------------------------------- AC-4 / AC-5 扣留


class TestWithholding:
    def test_未收盘桶不写且计入withheldNotClosed(self, conn: DbConn) -> None:
        insert(conn, "OPENUSDC", T0, 100)  # 4h 桶只走了 100 分钟
        with conn.transaction():
            stats = agg.aggregate_range(conn, "OPENUSDC", "4h", T0, T0 + 99 * ONE_MINUTE_MS)
        assert buckets_of(conn, "OPENUSDC", "4h") == []
        assert stats.upserted == 0
        assert stats.withheld_not_closed == 1
        assert stats.withheld_incomplete == 0

    def test_补上最后一分钟后桶出现(self, conn: DbConn) -> None:
        insert(conn, "CLOSEUSDC", T0, 100)
        with conn.transaction():
            agg.aggregate_range(conn, "CLOSEUSDC", "4h", T0, T0 + 99 * ONE_MINUTE_MS)
        assert buckets_of(conn, "CLOSEUSDC", "4h") == []
        # 补齐到桶的最后一分钟
        insert(conn, "CLOSEUSDC", T0 + 100 * ONE_MINUTE_MS, 140)
        with conn.transaction():
            agg.aggregate_range(conn, "CLOSEUSDC", "4h", T0, T0 + 239 * ONE_MINUTE_MS)
        assert len(buckets_of(conn, "CLOSEUSDC", "4h")) == 1

    def test_桶内缺一根则不写并计入withheldIncomplete(self, conn: DbConn) -> None:
        """AC-5：缺一根本来就有的桶，扣留数与缺失分钟数必须可量化。"""
        insert(conn, "HOLEUSDC", T0, 240)
        victim = T0 + 50 * ONE_MINUTE_MS
        with conn.transaction():
            conn.execute("DELETE FROM klines_1m WHERE symbol = 'HOLEUSDC' AND time = %s", (victim,))
            stats = agg.aggregate_range(conn, "HOLEUSDC", "4h", T0, T0 + 239 * ONE_MINUTE_MS)
        assert buckets_of(conn, "HOLEUSDC", "4h") == []
        assert stats.withheld_incomplete == 1
        assert stats.withheld_not_closed == 0
        assert stats.missing_minutes == 1

    def test_删最早一根不得让桶自愈成合格(self, conn: DbConn) -> None:
        """有效窗口夹到 F 会造成「删掉最早一根 → expected 减少 → 桶自动变合格」。

        那根桶的值是按 240 根算出来的，却因为 F 右移而通过了判据，图上会挂一根
        与上游对不上的蜡烛。桶内一旦有数据，期望根数就必须从桶起点算。

        ``--check`` 对这种残余情形报 **mismatch** 而不是 stale：删掉全局最早一根之后，
        桶内首根仍然等于（新的）F，与真正的 onboard 前缀桶在数据上**完全无法区分**。
        此时值确实对不上（volume 少了一根的贡献），报 mismatch + 由 ``--rebuild`` 修复
        是诚实且可执行的处置；硬要报 stale 就得靠一个不稳健的距离阈值去赌。
        """
        insert(conn, "EARLIEST", T0, 240)
        with conn.transaction():
            agg.aggregate_range(conn, "EARLIEST", "4h", T0, T0 + 239 * ONE_MINUTE_MS)
        assert len(buckets_of(conn, "EARLIEST", "4h")) == 1

        with conn.transaction():
            conn.execute("DELETE FROM klines_1m WHERE symbol = 'EARLIEST' AND time = %s", (T0,))

        # 先校验：此刻派生桶仍按 240 根算出的旧值，而 1m 只剩 239 根 → 值对不上。
        # 必须在**重算之前**查：aggregate_range 会把桶改写成 239 根的值，之后就一致了。
        problems = agg.check_intervals(conn, "EARLIEST", ["4h"], T0, T0 + 239 * ONE_MINUTE_MS)
        assert problems, "必须报出不一致"
        assert {p["kind"] for p in problems} == {"mismatch"}
        # 删掉的是桶内首行，因此 open / low / volume 全部对不上
        assert {"open", "volume"} <= {p["column"] for p in problems}

        # 增量路径只增不删：不新增、不删除。
        # 扣留统计是 0 而不是 1 —— 桶被 judge_bucket 判为合格（桶内首根就是 F），
        # 它确实合格：`--check` 已经把「值不对」报出来，不需要再重复算成「缺数据」。
        with conn.transaction():
            stats = agg.aggregate_range(
                conn, "EARLIEST", "4h", T0 + ONE_MINUTE_MS, T0 + 239 * ONE_MINUTE_MS
            )
        assert stats.upserted == 0, "不得新增"
        assert len(buckets_of(conn, "EARLIEST", "4h")) == 1, "不得删除（R-4.4 只增不删）"
        # 重算后一致了
        assert agg.check_intervals(conn, "EARLIEST", ["4h"], T0, T0 + 239 * ONE_MINUTE_MS) == []

    def test_扣留统计全在1m区间上(self, conn: DbConn) -> None:
        # 3 个 4h 桶：第 1 个完整；第 2 个挖 10 分钟（已收盘但未全覆盖）；
        # 第 3 个只铺一半（未收盘）。1m 总数刻意少于 720。
        insert(conn, "RANGEUSDC", T0, 240 * 2 + 100)
        with conn.transaction():
            conn.execute(
                "DELETE FROM klines_1m WHERE symbol = 'RANGEUSDC' AND time >= %s AND time <= %s",
                (T0 + W4H, T0 + W4H + 9 * ONE_MINUTE_MS),
            )
        last_ms = T0 + 240 * 3 * ONE_MINUTE_MS - 1
        counts = agg.withheld_counts(conn, "RANGEUSDC", "4h", T0, last_ms)
        assert counts["incomplete"] == 1
        assert counts["notClosed"] == 1
        assert counts["missingMinutes"] == 10
        # 只有第一个桶合格且已写入
        with conn.transaction():
            stats = agg.aggregate_range(conn, "RANGEUSDC", "4h", T0, last_ms)
        assert stats.upserted == 1
        assert len(buckets_of(conn, "RANGEUSDC", "4h")) == 1

    def test_interval_summary给出桶数与扣留(self, conn: DbConn) -> None:
        insert(conn, "SUMUSDC", T0, 240)
        with conn.transaction():
            agg.aggregate_range(conn, "SUMUSDC", "4h", T0, T0 + 239 * ONE_MINUTE_MS)
            conn.execute(
                "DELETE FROM klines_1m WHERE symbol = 'SUMUSDC' AND time = %s",
                (T0 + 3 * ONE_MINUTE_MS,),
            )
        summary = agg.interval_summary(conn, "SUMUSDC", "4h", T0, T0 + 239 * ONE_MINUTE_MS)
        assert summary["buckets"] == 1  # 已写入的那一根还在
        assert summary["withheldIncomplete"] == 1  # 现在它不再合格
        assert summary["missingMinutes"] == 1


# ------------------------------------------------------------- AC-7 幂等


class TestIdempotence:
    @pytest.mark.parametrize("interval", ["15m", "1h", "4h", "1d"])
    def test_重复补齐第二次upserted为0且值不变(self, conn: DbConn, interval: str) -> None:
        width = agg.interval_width(interval)
        count = width // ONE_MINUTE_MS
        insert(conn, "IDEMUSDC", T0, count)
        with conn.transaction():
            first = agg.aggregate_range(conn, "IDEMUSDC", interval, T0, T0 + width - ONE_MINUTE_MS)
        snapshot = buckets_of(conn, "IDEMUSDC", interval)
        with conn.transaction():
            second = agg.aggregate_range(conn, "IDEMUSDC", interval, T0, T0 + width - ONE_MINUTE_MS)
        assert first.upserted == 1
        assert second.upserted == 0, "第二次不得计入任何新桶（AC-7）"
        assert buckets_of(conn, "IDEMUSDC", interval) == snapshot

    def test_跨批重算同一个桶只计一次(self, conn: DbConn) -> None:
        """桶对齐而非批边界：跨批的桶被**完整重算**，值覆盖全部 1m。

        桶的值来自**全库**的 1m（不限于本次区间），所以第一批就已经能算出完整的桶；
        这一点正是「按桶对齐」的意义——若按批边界裁剪 1m 读取范围，最后一批只会看到
        自己那 120 根，桶的 volume / high / close 就会是错的。
        """
        insert(conn, "CROSSUSDC", T0, 240)
        with conn.transaction():
            agg.aggregate_range(conn, "CROSSUSDC", "4h", T0, T0 + 60 * ONE_MINUTE_MS)
        rows = buckets_of(conn, "CROSSUSDC", "4h")
        assert len(rows) == 1, "第一批就该写入整桶（值取自全库 1m）"
        assert rows[0][0] == T0
        # 值必须来自全部 240 根，而不是这一批的 60 根
        assert rows[0][1] == 100.0  # open = 首行
        assert rows[0][4] == 100.0 + 239  # close = 末行
        assert rows[0][5] == 10.0 * 240  # volume = 全部求和

        snapshot = rows
        # 后续批次重算同一桶：值不变，upserted 不重复计数（R-4.4 只增不删）
        with conn.transaction():
            second = agg.aggregate_range(
                conn, "CROSSUSDC", "4h", T0 + 60 * ONE_MINUTE_MS, T0 + 120 * ONE_MINUTE_MS
            )
            third = agg.aggregate_range(
                conn, "CROSSUSDC", "4h", T0 + 120 * ONE_MINUTE_MS, T0 + 239 * ONE_MINUTE_MS
            )
        assert second.upserted == 0
        assert third.upserted == 0
        assert buckets_of(conn, "CROSSUSDC", "4h") == snapshot

    def test_跨批重算后再次重算不重复计数(self, conn: DbConn) -> None:
        """已写入的桶被后续批次再次重算时，upserted 仍为 0（R-4.4 只增不删）。"""
        insert(conn, "RECROSS", T0, 240)
        with conn.transaction():
            agg.aggregate_range(conn, "RECROSS", "4h", T0, T0 + 239 * ONE_MINUTE_MS)
        snapshot = buckets_of(conn, "RECROSS", "4h")
        with conn.transaction():
            again = agg.aggregate_range(
                conn, "RECROSS", "4h", T0 + 100 * ONE_MINUTE_MS, T0 + 239 * ONE_MINUTE_MS
            )
        assert again.upserted == 0
        assert buckets_of(conn, "RECROSS", "4h") == snapshot

    def test_增量路径只增不删(self, conn: DbConn) -> None:
        """R-4.4：绝不删除已写入的派生桶。"""
        insert(conn, "NODELUSDC", T0, 240)
        with conn.transaction():
            agg.aggregate_range(conn, "NODELUSDC", "4h", T0, T0 + 239 * ONE_MINUTE_MS)
        assert len(buckets_of(conn, "NODELUSDC", "4h")) == 1
        # 1m 被外部改动后该桶不再合格——补齐**不得**删掉它
        with conn.transaction():
            conn.execute("DELETE FROM klines_1m WHERE symbol = 'NODELUSDC' AND time = %s", (T0,))
            agg.aggregate_range(conn, "NODELUSDC", "4h", T0, T0 + 239 * ONE_MINUTE_MS)
        assert len(buckets_of(conn, "NODELUSDC", "4h")) == 1

    @pytest.mark.parametrize("symbol", SYMBOLS)
    def test_多标的互不干扰(self, conn: DbConn, symbol: str) -> None:
        """R-10.6：必须参数化到多标的——每个参数跑一遍全量聚合。"""
        for other in SYMBOLS:
            insert(conn, other, T0, 240)
        with conn.transaction():
            for other in SYMBOLS:
                agg.aggregate_range(conn, other, "4h", T0, T0 + 239 * ONE_MINUTE_MS)
        # 三个标的各自都拿到了自己的一根桶：聚合不串标的
        for other in SYMBOLS:
            rows = buckets_of(conn, other, "4h")
            assert len(rows) == 1, f"{other} 应有自己的桶"
            assert rows[0][0] == T0
        # 只聚合其中一个，不影响另外两个
        with conn.transaction():
            conn.execute("DELETE FROM klines_4h WHERE symbol = %s", (symbol,))
        remaining = {
            other: len(buckets_of(conn, other, "4h")) for other in SYMBOLS if other != symbol
        }
        assert all(count == 1 for count in remaining.values())
        assert len(buckets_of(conn, symbol, "4h")) == 0


# --------------------------------------------------------- AC-9 重建与校验


class TestRebuildAndCheck:
    def test_rebuild等于清空后全量重建(self, conn: DbConn) -> None:
        insert(conn, "REBUSDC", T0, 240 * 2)
        with conn.transaction():
            agg.aggregate_range(conn, "REBUSDC", "4h", T0, T0 + 480 * ONE_MINUTE_MS - 1)
        before = buckets_of(conn, "REBUSDC", "4h")
        assert len(before) == 2

        # 篡改一个桶
        with conn.transaction():
            conn.execute(
                "UPDATE klines_4h SET close = 999 WHERE symbol = 'REBUSDC' AND time = %s",
                (T0,),
            )
        assert buckets_of(conn, "REBUSDC", "4h")[0][4] == 999

        with conn.transaction():
            agg.aggregate_range(
                conn, "REBUSDC", "4h", T0, T0 + 480 * ONE_MINUTE_MS - 1, rebuild=True
            )
        assert buckets_of(conn, "REBUSDC", "4h") == before

    def test_rebuild按桶边界删除(self, conn: DbConn) -> None:
        """删半截桶会让 --rebuild 与「清空后重建」不相等（AC-9）。

        区间只给第一个桶内的第 6~11 分钟，rebuild 必须把**整个第一个桶**删掉重算；
        第二个桶不在区间内，按「只增不删」（R-4.4）保持原样。
        """
        insert(conn, "EDGEUSDC", T0, 240 * 2)
        with conn.transaction():
            agg.aggregate_range(conn, "EDGEUSDC", "4h", T0, T0 + 480 * ONE_MINUTE_MS - 1)
        before = buckets_of(conn, "EDGEUSDC", "4h")
        assert len(before) == 2

        with conn.transaction():
            agg.aggregate_range(
                conn,
                "EDGEUSDC",
                "4h",
                T0 + 5 * ONE_MINUTE_MS,
                T0 + 10 * ONE_MINUTE_MS,
                rebuild=True,
            )
        after = buckets_of(conn, "EDGEUSDC", "4h")
        # 第一个桶被完整重算（值与之前一致，因为 1m 没变）；第二个桶原样保留
        assert after == before

    def test_check_一致时不报问题(self, conn: DbConn) -> None:
        insert(conn, "OKCHK", T0, 240)
        with conn.transaction():
            agg.aggregate_range(conn, "OKCHK", "4h", T0, T0 + 239 * ONE_MINUTE_MS)
        assert agg.check_intervals(conn, "OKCHK", ["4h"], T0, T0 + 239 * ONE_MINUTE_MS) == []
        agg.raise_on_mismatch("OKCHK", [])

    def test_check_报出missing(self, conn: DbConn) -> None:
        insert(conn, "MISCHK", T0, 240)
        problems = agg.check_intervals(conn, "MISCHK", ["4h"], T0, T0 + 239 * ONE_MINUTE_MS)
        assert [p["kind"] for p in problems] == ["missing"]
        assert problems[0]["time"] == T0
        with pytest.raises(SyncError) as excinfo:
            agg.raise_on_mismatch("MISCHK", problems)
        assert excinfo.value.code == "AGGREGATION_MISMATCH"
        assert "4h" in excinfo.value.message

    def test_check_报出mismatch并指出列(self, conn: DbConn) -> None:
        insert(conn, "BADCHK", T0, 240)
        with conn.transaction():
            agg.aggregate_range(conn, "BADCHK", "4h", T0, T0 + 239 * ONE_MINUTE_MS)
            conn.execute(
                "UPDATE klines_4h SET high = 1 WHERE symbol = 'BADCHK' AND time = %s", (T0,)
            )
        problems = agg.check_intervals(conn, "BADCHK", ["4h"], T0, T0 + 239 * ONE_MINUTE_MS)
        assert [p["kind"] for p in problems] == ["mismatch"]
        assert problems[0]["column"] == "high"

    def test_check_报出stale(self, conn: DbConn) -> None:
        """派生表有但按当前 1m 已不合格（R-3.3 禁止，却可能被外部改动造成）。

        刻意挖**桶中间**的一根（不是最早那根）：这样桶不再整桶齐全，而 onboard 前缀
        的让路规则不会把它误判成合格。
        """
        insert(conn, "STLCHK", T0, 240)
        with conn.transaction():
            agg.aggregate_range(conn, "STLCHK", "4h", T0, T0 + 239 * ONE_MINUTE_MS)
            conn.execute(
                "DELETE FROM klines_1m WHERE symbol = 'STLCHK' AND time = %s",
                (T0 + 100 * ONE_MINUTE_MS,),
            )
        problems = agg.check_intervals(conn, "STLCHK", ["4h"], T0, T0 + 239 * ONE_MINUTE_MS)
        assert [p["kind"] for p in problems] == ["stale"]
        assert problems[0]["time"] == T0

    def test_check只读不写库(self, conn: DbConn) -> None:
        insert(conn, "ROCHK", T0, 240)
        agg.check_intervals(conn, "ROCHK", ["4h"], T0, T0 + 239 * ONE_MINUTE_MS)
        assert buckets_of(conn, "ROCHK", "4h") == []

    def test_check覆盖多个周期(self, conn: DbConn) -> None:
        insert(conn, "MULTI", T0, 240)
        problems = agg.check_intervals(
            conn, "MULTI", ["15m", "1h", "4h", "1d"], T0, T0 + 239 * ONE_MINUTE_MS
        )
        assert {p["interval"] for p in problems} == {"15m", "1h", "4h"}


# ------------------------------------------------------------ AC-16 体积


class TestRelationSize:
    @pytest.mark.parametrize("interval", ["15m", "1h", "4h", "1d"])
    def test_体积可实测且非负(self, conn: DbConn, interval: str) -> None:
        """AC-16：体积必须来自 pg_total_relation_size，而不是估算。"""
        insert(conn, "SIZUSDC", T0, 20)
        with conn.transaction():
            agg.aggregate_range(conn, "SIZUSDC", interval, T0, T0 + 14 * ONE_MINUTE_MS)
        row = conn.execute(
            "SELECT pg_total_relation_size(to_regclass(%s))::bigint AS bytes",
            (agg.DERIVED_TABLES[interval],),
        ).fetchone()
        assert row is not None and int(row["bytes"]) > 0


# ------------------------------------------------------------ 空数据边界


class TestEmptyStore:
    def test_无1m时不造桶(self, conn: DbConn) -> None:
        with conn.transaction():
            stats = agg.aggregate_range(conn, "GHOSTUSDC", "4h", T0, T0 + W4H)
        assert stats.upserted == 0
        assert buckets_of(conn, "GHOSTUSDC", "4h") == []

    def test_read_bounds无数据返回None(self, conn: DbConn) -> None:
        assert agg.read_bounds(conn, "GHOSTUSDC") is None

    def test_withheld_counts无数据全零(self, conn: DbConn) -> None:
        assert agg.withheld_counts(conn, "GHOSTUSDC", "4h", T0, T0 + W4H) == {
            "notClosed": 0,
            "incomplete": 0,
            "missingMinutes": 0,
        }

    def test_check无数据不报stale(self, conn: DbConn) -> None:
        assert agg.check_intervals(conn, "GHOSTUSDC", ["4h"], T0, T0 + W4H) == []
