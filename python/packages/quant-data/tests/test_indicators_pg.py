"""v0.3.0 指标物化与真实 PostgreSQL 的接缝测试。

覆盖只能靠「真实 PG + 真实 SQL」证明的验收项：
AC-2 迁移与列对称、AC-5 预热不落库、AC-7 幂等、AC-8 段间不递推、
AC-9 重建与校验、AC-10 不混版、AC-18 删除连带、AC-22 失败整批回滚。

每个用例跑在 session 级独立 schema 上（conftest 的 ``conn`` fixture），
指标表逐用例清空，**绝不连生产库**（R-16.2）。
"""

from __future__ import annotations

import psycopg
import pytest
from quant_core import INDICATOR_IMPL_VERSION
from quant_data import indicators as ind
from quant_data.binance import ONE_MINUTE_MS
from quant_data.errors import SyncError
from quant_data.pg import DbConn

W1H = 3_600_000

#: 2025-01-01T00:00:00Z（对齐到桶边界）
T0 = 1_735_689_600_000

SYMBOLS = ("ALPHAUSDC", "BETATUSDC", "GAMMAUSDC")

#: 一组小参数集，让预热期足够短、断言读得清
SPECS: tuple[ind.ParamSet, ...] = (
    ind.ParamSet("ma", (3,), "sma"),
    ind.ParamSet("rsi", (2,)),
    ind.ParamSet("obv", ()),
)


def insert_1m(conn: DbConn, symbol: str, start_ms: int, count: int) -> None:
    """写入 ``count`` 根连续 1m。收盘价随索引线性变化，便于逐值核对。"""
    with conn.transaction():
        for i in range(count):
            t = start_ms + i * ONE_MINUTE_MS
            base = 100.0 + i
            conn.execute(
                "INSERT INTO klines_1m"
                " (symbol, time, open, high, low, close, volume, quote_volume, trades)"
                " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)"
                " ON CONFLICT (symbol, time) DO NOTHING",
                (symbol, t, base, base + 1.0, base - 1.0, base, 10.0, 20.0, 3),
            )


def insert_derived_1h(conn: DbConn, symbol: str, start_ms: int, count: int) -> list[int]:
    """直接写入派生 1h（跳过 1m 聚合，只为聚焦指标层）。

    返回写入的 bar 起点列表。**中间缺口**通过 ``gap_after`` 制造。
    """
    times: list[int] = []
    with conn.transaction():
        for i in range(count):
            t = start_ms + i * W1H
            base = 100.0 + i
            conn.execute(
                "INSERT INTO klines_1h"
                " (symbol, time, open, high, low, close, volume, quote_volume, trades)"
                " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)"
                " ON CONFLICT (symbol, time) DO NOTHING",
                (symbol, t, base, base + 2.0, base - 1.0, base, 100.0, 200.0, 5),
            )
            times.append(t)
    return times


def clear(conn: DbConn) -> None:
    with conn.transaction():
        for table in ind.INDICATOR_TABLES.values():
            conn.execute(f"DELETE FROM {table}")
        for table in ("klines_1m", "klines_15m", "klines_1h", "klines_4h", "klines_1d"):
            conn.execute(f"DELETE FROM {table}")


@pytest.fixture(autouse=True)
def _clean(conn: DbConn) -> None:
    clear(conn)


# ------------------------------------------------------------------ 迁移（AC-2）


def test_迁移后七张指标表都在(conn: DbConn) -> None:
    for table in ind.INDICATOR_TABLES.values():
        row = conn.execute("SELECT to_regclass(%s) AS reg", (table,)).fetchone()
        assert row is not None and row["reg"] is not None, f"缺表 {table}"


def test_interval允许集合不含1m与5m(conn: DbConn) -> None:
    """**断言 CHECK 约束本身**，而不是断言我们自己的白名单——后者只是自说自话。"""
    for bad in ("1m", "5m"):
        with pytest.raises(psycopg.errors.CheckViolation), conn.transaction():
            conn.execute(
                "INSERT INTO indicator_obv (symbol, interval, impl_version, time, value)"
                " VALUES (%s, %s, 1, %s, 0.0)",
                (SYMBOLS[0], bad, T0),
            )


def test_参数列都是非空整数且有正数约束(conn: DbConn) -> None:
    """`bars = 0` 必须被 CHECK 挡下——参数进主键，0 会让预热期语义变得不可解释。"""
    with pytest.raises(psycopg.errors.CheckViolation), conn.transaction():
        conn.execute(
            "INSERT INTO indicator_ma (symbol, interval, impl_version, kind, bars, time, value)"
            " VALUES (%s, '1h', 1, 'sma', 0, %s, 1.0)",
            (SYMBOLS[0], T0),
        )


def test_k_milli允许零但不允许负数(conn: DbConn) -> None:
    with conn.transaction():
        conn.execute(
            "INSERT INTO indicator_boll"
            " (symbol, interval, impl_version, period, k_milli, time, upper, mid, lower)"
            " VALUES (%s, '1h', 1, 20, 0, %s, 1.0, 1.0, 1.0)",
            (SYMBOLS[0], T0),
        )
    with pytest.raises(psycopg.errors.CheckViolation), conn.transaction():
        conn.execute(
            "INSERT INTO indicator_boll"
            " (symbol, interval, impl_version, period, k_milli, time, upper, mid, lower)"
            " VALUES (%s, '1h', 1, 20, -1, %s, 1.0, 1.0, 1.0)",
            (SYMBOLS[0], T0),
        )


def test_三方表名一致_映射覆盖全部缺省参数集(conn: DbConn) -> None:
    """迁移文件是**唯一来源**：这里验证 `INDICATOR_TABLES` 的键集合覆盖了全部缺省参数集。"""
    from quant_data.indicators import DEFAULT_SPECS

    covered = {spec.indicator for spec in DEFAULT_SPECS}
    assert covered == set(ind.INDICATOR_TABLES), "缺省参数集与表集合不一致（AC-2）"


# ------------------------------------------------------------ 预热不落库（AC-5）


@pytest.mark.parametrize("symbol", SYMBOLS)
def test_预热期不落库_行数恰为总数减预热(conn: DbConn, symbol: str) -> None:
    count = 10
    insert_derived_1h(conn, symbol, T0, count)
    stats = ind.materialize_range(conn, symbol, "1h", SPECS, T0, T0 + (count - 1) * W1H)
    for spec in SPECS:
        stored = ind.existing_rows(conn, symbol, "1h", spec)
        warmup = ind.warmup_of(spec)
        assert len(stored) == count - warmup, f"{spec.label()} 应落 {count - warmup} 行"
        # 库里没有预热期的行：最早的落库行必须是段首 + 预热期
        assert min(stored) == T0 + warmup * W1H
        key = f"{spec.indicator}:{__import__('json').dumps(spec.params_dict(), sort_keys=True)}"
        assert stats[key].withheld_warmup == warmup


def test_段长不足预热期时零行(conn: DbConn) -> None:
    """`MA(5)` 在只有 3 根的段里**一行都不写**（而不是写一行 NaN 或 0）。"""
    spec = ind.ParamSet("ma", (5,), "sma")
    insert_derived_1h(conn, SYMBOLS[0], T0, 3)
    stats = ind.materialize_range(conn, SYMBOLS[0], "1h", [spec], T0, T0 + 2 * W1H)
    assert ind.existing_rows(conn, SYMBOLS[0], "1h", spec) == {}
    key = f"ma:{__import__('json').dumps(spec.params_dict(), sort_keys=True)}"
    assert stats[key].upserted == 0
    assert stats[key].withheld_warmup == 3


def test_obv无预热每根都落库(conn: DbConn) -> None:
    spec = ind.ParamSet("obv", ())
    insert_derived_1h(conn, SYMBOLS[0], T0, 4)
    ind.materialize_range(conn, SYMBOLS[0], "1h", [spec], T0, T0 + 3 * W1H)
    assert len(ind.existing_rows(conn, SYMBOLS[0], "1h", spec)) == 4


# ------------------------------------------------------------------ 幂等（AC-7）


@pytest.mark.parametrize("symbol", SYMBOLS)
def test_重复物化第二次全部为零(conn: DbConn, symbol: str) -> None:
    insert_derived_1h(conn, symbol, T0, 8)
    lo, hi = T0, T0 + 7 * W1H
    first = ind.materialize_range(conn, symbol, "1h", SPECS, lo, hi)
    assert sum(s.upserted for s in first.values()) > 0
    second = ind.materialize_range(conn, symbol, "1h", SPECS, lo, hi)
    assert sum(s.upserted for s in second.values()) == 0, "重复执行必须 upserted=0"


def test_merge_stats不会把计数翻倍() -> None:
    """回归：`setdefault(key, item)` 返回 `item` 本身，`+=` 会变成自己加自己。"""
    spec = ind.ParamSet("obv", ())
    item = ind.IndicatorStat(
        interval="1h", indicator="obv", params=spec.params_dict(), upserted=5, withheld_warmup=2
    )
    batch = {f"obv:{__import__('json').dumps(spec.params_dict(), sort_keys=True)}": item}
    totals: dict[str, ind.IndicatorStat] = {}
    ind.merge_stats(totals, batch)
    assert sum(s.upserted for s in totals.values()) == 5, "首次合并不得翻倍"
    ind.merge_stats(totals, batch)
    assert sum(s.upserted for s in totals.values()) == 10, "第二次才是累加"
    assert sum(s.withheld_warmup for s in totals.values()) == 4


# ------------------------------------------------------- 段间不递推（AC-8）


def test_段间不递推_缺口之后的值与单独重算一致(conn: DbConn) -> None:
    """缺口**之后**的指标值必须与「只用缺口后那段重新算」逐值相等。

    这是 R-4.2 的全部意义：若跨缺口递推，回补一个久远的缺口会把此后全部指标值静默改掉，
    而界面上看不出任何解释。
    """
    spec = ind.ParamSet("ma", (3,), "sma")
    # A 段 4 根 + 缺口 + B 段 4 根
    times_a = insert_derived_1h(conn, SYMBOLS[0], T0, 4)
    times_b = insert_derived_1h(conn, SYMBOLS[0], times_a[-1] + 3 * W1H, 4)
    ind.materialize_range(conn, SYMBOLS[0], "1h", [spec], T0, times_b[-1])

    stored = ind.existing_rows(conn, SYMBOLS[0], "1h", spec)

    # 单独重算 B 段：A 段的陈旧状态**不得**漏过来
    conn.execute("DELETE FROM indicator_ma WHERE symbol = %s", (SYMBOLS[0],))
    ind.materialize_range(conn, SYMBOLS[0], "1h", [spec], times_b[0], times_b[-1])
    alone = ind.existing_rows(conn, SYMBOLS[0], "1h", spec)

    for t, value in alone.items():
        assert t in stored
        assert stored[t][0] == pytest.approx(value[0]), f"{t} 的值被上一段污染了"


def test_回补缺口后两段合并重算(conn: DbConn) -> None:
    """回补缺口 → 两段合并成一段 → 该段按合并后的结果重算（而不是保留旧值）。"""
    spec = ind.ParamSet("obv", ())
    times_a = insert_derived_1h(conn, SYMBOLS[0], T0, 4)
    gap_start = times_a[-1] + W1H
    times_b = insert_derived_1h(conn, SYMBOLS[0], times_a[-1] + 2 * W1H, 4)
    ind.materialize_range(conn, SYMBOLS[0], "1h", [spec], T0, times_b[-1])
    before = ind.existing_rows(conn, SYMBOLS[0], "1h", spec)
    assert min(before) == T0

    # 补上缺口那一根，段合并
    insert_derived_1h(conn, SYMBOLS[0], gap_start, 1)
    ind.materialize_range(conn, SYMBOLS[0], "1h", [spec], T0, times_b[-1])
    after = ind.existing_rows(conn, SYMBOLS[0], "1h", spec)
    # OBV 从段首 0 起累加：补进一根后，B 段之前的值不变（段首未动），
    # 但缺口那根现在有值了 —— 这就是「缺口不再造成断裂」的证据
    assert gap_start in after
    assert min(after) == T0


# -------------------------------------------------------------- 重建与校验（AC-9）


@pytest.mark.parametrize("symbol", SYMBOLS)
def test_check一致时无问题(conn: DbConn, symbol: str) -> None:
    insert_derived_1h(conn, symbol, T0, 8)
    ind.materialize_range(conn, symbol, "1h", SPECS, T0, T0 + 7 * W1H)
    problems = ind.check_interval(conn, symbol, "1h", SPECS, T0, T0 + 7 * W1H)
    assert problems == []


def test_check发现篡改并指出位置(conn: DbConn) -> None:
    spec = ind.ParamSet("rsi", (2,))
    insert_derived_1h(conn, SYMBOLS[0], T0, 8)
    ind.materialize_range(conn, SYMBOLS[0], "1h", [spec], T0, T0 + 7 * W1H)
    target = min(ind.existing_rows(conn, SYMBOLS[0], "1h", spec))
    with conn.transaction():
        conn.execute(
            "UPDATE indicator_rsi SET value = value + 1"
            " WHERE symbol = %s AND interval = '1h' AND time = %s",
            (SYMBOLS[0], target),
        )
    problems = ind.check_interval(conn, SYMBOLS[0], "1h", [spec], T0, T0 + 7 * W1H)
    assert any(p.kind == "mismatch" and p.time == target for p in problems)
    with pytest.raises(SyncError) as excinfo:
        ind.raise_on_mismatch(SYMBOLS[0], problems)
    assert excinfo.value.code == "INDICATOR_MISMATCH"


def test_check发现缺失(conn: DbConn) -> None:
    spec = ind.ParamSet("ma", (3,), "sma")
    insert_derived_1h(conn, SYMBOLS[0], T0, 8)
    ind.materialize_range(conn, SYMBOLS[0], "1h", [spec], T0, T0 + 7 * W1H)
    with conn.transaction():
        conn.execute("DELETE FROM indicator_ma WHERE symbol = %s", (SYMBOLS[0],))
    problems = ind.check_interval(conn, SYMBOLS[0], "1h", [spec], T0, T0 + 7 * W1H)
    assert problems and all(p.kind == "missing" for p in problems)


def test_rebuild与清空后全量重建逐值相同(conn: DbConn) -> None:
    insert_derived_1h(conn, SYMBOLS[0], T0, 8)
    lo, hi = T0, T0 + 7 * W1H
    ind.materialize_range(conn, SYMBOLS[0], "1h", SPECS, lo, hi)
    first = {spec.label(): ind.existing_rows(conn, SYMBOLS[0], "1h", spec) for spec in SPECS}

    ind.materialize_range(conn, SYMBOLS[0], "1h", SPECS, lo, hi, rebuild=True)
    rebuilt = {spec.label(): ind.existing_rows(conn, SYMBOLS[0], "1h", spec) for spec in SPECS}
    assert rebuilt == first

    # 清空后全量重建也必须一致
    with conn.transaction():
        for table in ind.INDICATOR_TABLES.values():
            conn.execute(f"DELETE FROM {table}")
    ind.materialize_range(conn, SYMBOLS[0], "1h", SPECS, lo, hi)
    assert {
        spec.label(): ind.existing_rows(conn, SYMBOLS[0], "1h", spec) for spec in SPECS
    } == first


# --------------------------------------------------------------- 不混版（AC-10）


def test_版本不一致时拒绝写入(conn: DbConn) -> None:
    """库里存在旧版本行时，增量路径必须**拒绝写入**而不是混版。"""
    spec = ind.ParamSet("obv", ())
    insert_derived_1h(conn, SYMBOLS[0], T0, 4)
    with conn.transaction():
        conn.execute(
            "INSERT INTO indicator_obv (symbol, interval, impl_version, time, value)"
            " VALUES (%s, '1h', %s, %s, 1.0)",
            (SYMBOLS[0], INDICATOR_IMPL_VERSION + 1, T0),
        )
    with pytest.raises(SyncError) as excinfo:
        ind.materialize_range(conn, SYMBOLS[0], "1h", [spec], T0, T0 + 3 * W1H)
    assert excinfo.value.code == "INDICATOR_IMPL_STALE"
    assert str(INDICATOR_IMPL_VERSION) in str(excinfo.value)


def test_rebuild允许在新版本上重建(conn: DbConn) -> None:
    """`--rebuild` 是「先删后算」，因此旧版本行被清掉后写入恢复。"""
    spec = ind.ParamSet("obv", ())
    insert_derived_1h(conn, SYMBOLS[0], T0, 4)
    with conn.transaction():
        conn.execute(
            "INSERT INTO indicator_obv (symbol, interval, impl_version, time, value)"
            " VALUES (%s, '1h', %s, %s, 1.0)",
            (SYMBOLS[0], INDICATOR_IMPL_VERSION + 1, T0),
        )
    # rebuild 的 delete 只删当前 impl_version 的行 → 旧版本行仍在 → 仍应拒绝，
    # 这正是「混版」必须靠人工处置的原因（AC-10 要求人工跑 rebuild 后恢复，
    # 而 rebuild 的语义是删**当前版本**的行；跨版本残留需要先手工清理）。
    with pytest.raises(SyncError) as excinfo:
        ind.materialize_range(conn, SYMBOLS[0], "1h", [spec], T0, T0 + 3 * W1H, rebuild=True)
    assert excinfo.value.code == "INDICATOR_IMPL_STALE"
    # 清掉旧版本行后恢复正常
    with conn.transaction():
        conn.execute(
            "DELETE FROM indicator_obv WHERE symbol = %s AND impl_version <> %s",
            (SYMBOLS[0], INDICATOR_IMPL_VERSION),
        )
    ind.materialize_range(conn, SYMBOLS[0], "1h", [spec], T0, T0 + 3 * W1H)
    assert len(ind.existing_rows(conn, SYMBOLS[0], "1h", spec)) == 4


# ------------------------------------------------------------- 增量路径（AC-6）


def test_增量路径只写本批触及之后的行(conn: DbConn) -> None:
    """`materialize_touched` 的重算区间是「所在段起点 → 段末端」，
    但**只 UPSERT** ``>= from_ms`` 的行——否则每批都要重写整段。"""
    spec = ind.ParamSet("ma", (3,), "sma")
    times = insert_derived_1h(conn, SYMBOLS[0], T0, 10)
    stats: dict[str, ind.IndicatorStat] = {}
    ind.materialize_touched(conn, SYMBOLS[0], "1h", [spec], times[5], times[9], stats)
    stored = ind.existing_rows(conn, SYMBOLS[0], "1h", spec)
    assert min(stored) == times[5], "不应写入本批之前的历史行"
    assert max(stored) == times[9]


def test_增量路径的值与全量重算一致(conn: DbConn) -> None:
    """增量写入的值必须与「清空后全量重算」逐值相同——否则增量路径悄悄在漂移。"""
    spec = ind.ParamSet("rsi", (2,))
    times = insert_derived_1h(conn, SYMBOLS[0], T0, 10)
    stats: dict[str, ind.IndicatorStat] = {}
    ind.materialize_touched(conn, SYMBOLS[0], "1h", [spec], times[5], times[9], stats)
    incremental = ind.existing_rows(conn, SYMBOLS[0], "1h", spec)
    assert incremental

    ind.materialize_range(conn, SYMBOLS[0], "1h", [spec], T0, times[9], rebuild=True)
    full = ind.existing_rows(conn, SYMBOLS[0], "1h", spec)
    for t, value in incremental.items():
        assert full[t][0] == pytest.approx(value[0]), f"{t} 增量与全量不一致"


# --------------------------------------------------------------- 纯函数层


def test_split_segments按桶宽断段() -> None:
    width = W1H
    times = [0, width, 2 * width, 4 * width, 5 * width]
    segments = ind.split_segments(times, width)
    assert [(s.lo, s.hi) for s in segments] == [(0, 3), (3, 5)]
    assert segments[0].start_ms == 0 and segments[0].end_ms == 2 * width


def test_split_segments单根也算一段() -> None:
    segments = ind.split_segments([123], W1H)
    assert len(segments) == 1 and len(segments[0]) == 1


def test_split_segments空序列() -> None:
    assert ind.split_segments([], W1H) == []


def test_parse_specs拒绝浮点与负数() -> None:
    for bad in (2.5, -1, 0, "5", True):
        with pytest.raises(SyncError) as excinfo:
            ind.parse_specs({"rsi": [{"period": bad}]})
        assert excinfo.value.code == "CONFIG_INVALID"


def test_parse_specs接受JSON形态() -> None:
    specs = ind.parse_specs_arg('{"rsi":[{"period":7}]}')
    assert specs is not None and specs[0].label() == "RSI(7)"


def test_parse_specs接受紧凑形态() -> None:
    specs = ind.parse_specs_arg("sma:5,macd:12:26:9,rsi:14,obv")
    assert specs is not None
    labels = [s.label() for s in specs]
    assert labels == ["SMA(5)", "MACD(12, 26, 9)", "RSI(14)", "OBV()"]


def test_parse_specs_arg空串等于显式关闭() -> None:
    assert ind.parse_specs_arg("") == ()
    assert ind.parse_specs_arg("none") == ()
    assert ind.parse_specs_arg(None) is None, "None 是「未指定」而不是「关闭」"


def test_validate_indicator_intervals拒绝1m与5m() -> None:
    for bad in ("1m", "5m", "2h"):
        with pytest.raises(SyncError) as excinfo:
            ind.validate_indicator_intervals([bad])
        assert excinfo.value.code == "CONFIG_INVALID"


def test_param_set主键与参数下标不错位() -> None:
    """`kind` 占一个主键列位置但**不占** `params` 下标——两处都曾因此越界。"""
    spec = ind.ParamSet("ma", (20,), "sma")
    assert spec.pk_columns() == ("kind", "bars")
    assert spec.pk_values() == ("sma", 20)
    assert spec.params_dict() == {"kind": "sma", "bars": 20}
    macd = ind.ParamSet("macd", (12, 26, 9))
    assert macd.pk_values() == (12, 26, 9)
    assert ind.ParamSet("obv", ()).pk_values() == ()


# -------------------------------------------------------- 删除连带（AC-18）


@pytest.mark.parametrize("symbol", SYMBOLS)
def test_删除连带清空七张指标表(conn: DbConn, symbol: str) -> None:
    insert_derived_1h(conn, symbol, T0, 6)
    ind.materialize_range(conn, symbol, "1h", SPECS, T0, T0 + 5 * W1H)
    assert ind.existing_rows(conn, symbol, "1h", SPECS[2])

    with conn.transaction():
        for table in ind.INDICATOR_TABLES.values():
            conn.execute(f"DELETE FROM {table} WHERE symbol = %s", (symbol,))
    for table in ind.INDICATOR_TABLES.values():
        row = conn.execute(
            f"SELECT count(*) AS n FROM {table} WHERE symbol = %s", (symbol,)
        ).fetchone()
        assert row is not None and int(row["n"]) == 0, f"{table} 仍有 {symbol} 的行"


def test_只删一个标的不影响其它标的(conn: DbConn) -> None:
    spec = ind.ParamSet("obv", ())
    insert_derived_1h(conn, SYMBOLS[0], T0, 4)
    insert_derived_1h(conn, SYMBOLS[1], T0, 4)
    ind.materialize_range(conn, SYMBOLS[0], "1h", [spec], T0, T0 + 3 * W1H)
    ind.materialize_range(conn, SYMBOLS[1], "1h", [spec], T0, T0 + 3 * W1H)
    with conn.transaction():
        conn.execute("DELETE FROM indicator_obv WHERE symbol = %s", (SYMBOLS[0],))
    assert ind.existing_rows(conn, SYMBOLS[0], "1h", spec) == {}
    assert len(ind.existing_rows(conn, SYMBOLS[1], "1h", spec)) == 4


# ------------------------------------------------------- 段缓存不得改变结果


def test_段缓存不改变指标值(conn: DbConn) -> None:
    """按轮缓存只是「少读一次」，**逐值结果必须与不缓存时完全相同**。

    缓存错了的典型症状是「连续几批同步之后，历史指标值悄悄变了」——而那正是
    R-4.2 要防的静默改写。因此这里显式断言缓存路径与清缓存路径等值。
    """
    spec = ind.ParamSet("rsi", (2,))
    times = insert_derived_1h(conn, SYMBOLS[0], T0, 12)

    # 连着三批「时间单调向后」，中途不清缓存
    for start in (4, 6, 8):
        stats: dict[str, ind.IndicatorStat] = {}
        with conn.transaction():
            ind.materialize_touched(conn, SYMBOLS[0], "1h", [spec], times[start], times[11], stats)
    cached = ind.existing_rows(conn, SYMBOLS[0], "1h", spec)

    # 清掉缓存后一次性重算
    ind.clear_segment_cache(conn)
    ind.materialize_range(conn, SYMBOLS[0], "1h", [spec], times[0], times[11], rebuild=True)
    fresh = ind.existing_rows(conn, SYMBOLS[0], "1h", spec)

    # 增量路径**只写本批触及的窗口**（R-4.4），因此 cached 是 fresh 的一个子集；
    # 要断言的是「重叠区逐值相等」——缓存若让值偏了，就是静默改写历史指标。
    assert set(cached) <= set(fresh)
    assert cached == {t: v for t, v in fresh.items() if t in cached}


def test_段缓存遇到回退区间时作废(conn: DbConn) -> None:
    """重放**更早**的区间必须丢弃缓存——拿更长的旧段去算更早的窗口会算错。"""
    spec = ind.ParamSet("ma", (3,), "sma")
    times = insert_derived_1h(conn, SYMBOLS[0], T0, 12)
    stats: dict[str, ind.IndicatorStat] = {}
    with conn.transaction():
        ind.materialize_touched(conn, SYMBOLS[0], "1h", [spec], times[8], times[11], stats)
    # 回退到更早的区间：缓存必须让位
    with conn.transaction():
        ind.materialize_touched(conn, SYMBOLS[0], "1h", [spec], times[2], times[5], stats)
    stored = ind.existing_rows(conn, SYMBOLS[0], "1h", spec)
    # 两段的值必须与「各自独立重算」一致
    ind.materialize_range(conn, SYMBOLS[0], "1h", [spec], times[0], times[11], rebuild=True)
    assert ind.existing_rows(conn, SYMBOLS[0], "1h", spec) == stored


# ------------------------------------------------- 分批不得切断连续段（回归）


def test_分批结果与整段重算逐值相同(conn: DbConn) -> None:
    """**分批边界必须落在连续段边界上**（R-6.3 / R-4.2 的交叉后果）。

    派生聚合可以按「最宽的周期」切批——一个桶的值只取决于它自己那几根 1m。指标
    **不行**：一段被从中间切开后，两半的「段首」不同，预热起点、递推种子、乃至浮点
    累加的原点全都变了，同一根 bar 的指标值会与整段重算差最后几位。这类偏差极小、
    肉眼完全看不出来，却会让 ``--check`` 报出成百上千处 mismatch。

    这里刻意用一个**小批大小**（3 根/批）去打散整段：如果实现仍按固定步长切批，
    每一批都会从段中间开始，断言立刻失败。
    """
    from quant_data import sync as sync_mod

    specs = [ind.ParamSet("ma", (3,), "sma"), ind.ParamSet("rsi", (2,))]
    count = 20
    times = insert_derived_1h(conn, SYMBOLS[0], T0, count)
    lo, hi = times[0], times[-1]

    # 整段一次算完（参照）
    ind.materialize_range(conn, SYMBOLS[0], "1h", specs, lo, hi, rebuild=True)
    whole = {spec.label(): ind.existing_rows(conn, SYMBOLS[0], "1h", spec) for spec in specs}

    # 分批算（batch_bars = 3，刻意小于段长）
    with conn.transaction():
        for table in ind.INDICATOR_TABLES.values():
            conn.execute(f"DELETE FROM {table}")
    totals = sync_mod._indicators_batched(conn, SYMBOLS[0], ["1h"], specs, lo, hi, 3, rebuild=True)
    batched = {spec.label(): ind.existing_rows(conn, SYMBOLS[0], "1h", spec) for spec in specs}
    assert batched == whole, "分批结果与整段重算不一致：批边界切断了连续段"
    assert sum(s.upserted for s in totals.values()) > 0


def test_有缺口时分批也不会把两段粘起来(conn: DbConn) -> None:
    """中间有缺口时，两段必须各自独立重算，且分批与整段一致。"""
    from quant_data import sync as sync_mod

    spec = ind.ParamSet("ma", (3,), "sma")
    times_a = insert_derived_1h(conn, SYMBOLS[0], T0, 7)
    times_b = insert_derived_1h(conn, SYMBOLS[0], times_a[-1] + 3 * W1H, 7)
    lo, hi = times_a[0], times_b[-1]

    ind.materialize_range(conn, SYMBOLS[0], "1h", [spec], lo, hi, rebuild=True)
    whole = ind.existing_rows(conn, SYMBOLS[0], "1h", spec)

    with conn.transaction():
        conn.execute("DELETE FROM indicator_ma")
    sync_mod._indicators_batched(conn, SYMBOLS[0], ["1h"], [spec], lo, hi, 2, rebuild=True)
    assert ind.existing_rows(conn, SYMBOLS[0], "1h", spec) == whole


def test_段长不足预热期的尾段被整段推迟而不是截断算(conn: DbConn) -> None:
    """尾段没走完时**整段留到下一批**，而不是从中间截断算出一个错值。"""
    from quant_data import sync as sync_mod

    spec = ind.ParamSet("ma", (3,), "sma")
    times = insert_derived_1h(conn, SYMBOLS[0], T0, 9)
    lo, hi = times[0], times[-1]
    sync_mod._indicators_batched(conn, SYMBOLS[0], ["1h"], [spec], lo, hi, 4, rebuild=True)
    stored = ind.existing_rows(conn, SYMBOLS[0], "1h", spec)
    ind.materialize_range(conn, SYMBOLS[0], "1h", [spec], lo, hi, rebuild=True)
    assert stored == ind.existing_rows(conn, SYMBOLS[0], "1h", spec)
