"""由库内 1m 派生高周期 K 线（v0.2.0 R-2 / R-3 / R-4）。

一条不可协商的前提（需求 §1）：**高周期只能有一个来源**。交易所的高周期接口会给出
第二套数据，而两者的边界与成交量口径并不保证逐值相等；此后「图上不对」将无法判定是
同步错了还是聚合错了。因此这里全部是**本地计算 + 本地 SQL**——不出网、不花配额、
不起子进程，不引入任何新依赖（AC-10 / AC-20）。

三条从 1m 上推的既有语义（R-2.3 / R-3）：
  1. 缺口不得插值——桶内少一根 1m 就不写这个桶（R-3.5）；
  2. 库里不存未收盘 bar——桶未走完就不写（R-3.3）；
  3. NULL 表示「交易所未提供」而非 0——桶内任一行为 NULL，桶级就是 NULL（R-2.2）。

**判据只有一份实现**：:func:`judge_bucket`。写入、扣留统计、``--check`` 全部走它。
把判据再抄进一条 SQL 会让「聚合写入」与「聚合校验」各有一套规则，而两者一旦漂移，
``--check`` 就会对着一条永远不会满足的判据报出无穷多个 missing——比没有校验更糟。

为什么不把 ``GROUP BY`` 下推到 SQL：受影响桶的 1m 行数被批大小天然框住
（1d 桶最多 1440 根，4h 240 根，1h 60 根，15m 15 根；一批 N 根 1m 跨过 1d 桶数 ≤ ⌈N/1440⌉+1），
一次全量拉取里反复重读的总量与原始数据量同阶。把这点数据读进 Python，换来的是
「同一组 1m 行必得同一组桶」（R-2.4）这条可逐值断言的性质。
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

from .binance import Kline
from .errors import SyncError
from .pg import DbConn

ONE_MINUTE_MS = 60_000
ONE_DAY_MS = 86_400_000

#: 本期实现的派生周期 -> 表名。**必须**与 ``packages/core`` 的 ``INTERVAL_TABLES`` 与
#: ``packages/data/sql/004_klines_agg.sql`` 里的表集合三方一致（R-1.6 / AC-1）。
DERIVED_TABLES: Mapping[str, str] = {
    "15m": "klines_15m",
    "1h": "klines_1h",
    "4h": "klines_4h",
    "1d": "klines_1d",
}

#: 桶宽 W（毫秒）。四个 W 都整除一天，且 epoch 0 是 UTC 零点，因此取模即可得到 UTC 边界
#: （R-2.1 / 附录 A.1）——**不用** ``date_trunc``：它的结果依赖会话 TimeZone，换个连接参数
#: 同一条 SQL 就会给出另一组边界，而取模永远只有一种结果。
BUCKET_WIDTHS_MS: Mapping[str, int] = {
    "15m": 900_000,
    "1h": 3_600_000,
    "4h": 14_400_000,
    "1d": ONE_DAY_MS,
}

Interval = Literal["15m", "1h", "4h", "1d"]

#: 允许的派生周期（白名单）。``1m`` 是基础数据、``5m`` 本期未实现，两者都必须报
#: CONFIG_INVALID 而不是静默跳过（R-9.1）。
ALLOWED_DERIVED: tuple[str, ...] = tuple(DERIVED_TABLES)


def validate_intervals(values: Sequence[str]) -> tuple[str, ...]:
    """校验并按固定次序（短 → 长）归一。

    次序固定是刻意的：摘要输出必须逐次一致，否则「连续两次补齐逐值相同」这条幂等断言
    会因键序漂移而假失败。
    """
    unknown = [v for v in values if v not in DERIVED_TABLES]
    if unknown:
        raise SyncError(
            "CONFIG_INVALID",
            f"未实现的派生周期: {unknown}（本期只支持 {list(ALLOWED_DERIVED)}；"
            "1m 是基础数据，5m 不在实现范围内）",
            {"intervals": list(values), "supported": list(ALLOWED_DERIVED)},
        )
    chosen = set(values)
    return tuple(i for i in ALLOWED_DERIVED if i in chosen)


def interval_width(interval: str) -> int:
    try:
        return BUCKET_WIDTHS_MS[interval]
    except KeyError as exc:  # pragma: no cover - 调用前已由 validate_intervals 拦下
        raise SyncError(
            "CONFIG_INVALID", f"未实现的派生周期: {interval}", {"interval": interval}
        ) from exc


def bucket_start(time_ms: int, width_ms: int) -> int:
    """``bucket_start(t, W) = t - (t mod W)``（R-2.1）。

    参数化为桶宽而不是周期名：将来加 5m 只需多一列映射，判据本身一个字都不用改（R-1.7）。
    """
    if width_ms <= 0:
        raise SyncError("CONFIG_INVALID", "桶宽必须为正整数", {"widthMs": width_ms})
    return time_ms - (time_ms % width_ms)


def ceil_to_bucket(time_ms: int, width_ms: int) -> int:
    """向上取整到桶边界（R-4.2 的区间终点）。

    聚合区间必须包含 ``batch.max`` 所在的桶，否则跨批的桶会被算成半个；用
    ``ceil(bucket_start(t) + W)`` 而不是 ``bucket_start(t)``，正是为了含住末桶本身。
    """
    start = bucket_start(time_ms, width_ms)
    return start if start == time_ms else start + width_ms


# --------------------------------------------------------------------- 判据


@dataclass(frozen=True, slots=True)
class BucketJudgement:
    """单个桶的判定结果与扣留统计（R-3.7：纯函数的输出形态）。"""

    #: 桶起点
    time: int
    #: 是否写入
    write: bool
    #: 桶是否已收盘（``b + W <= L + 60_000``）
    closed: bool
    #: 桶内实际存在的 1m 根数
    actual: int
    #: 桶内期望的 1m 根数（有效窗口内）
    expected: int
    #: 桶内缺失的分钟数
    missing: int
    #: 有效窗口；桶完全落在数据区间之外时为 None
    window_start: int | None = None
    window_end: int | None = None


def judge_bucket(
    *,
    bucket: int,
    width_ms: int,
    first_ms: int,
    last_ms: int,
    actual: int,
    bucket_first_ms: int | None = None,
) -> BucketJudgement:
    """**核心判据**（R-3.1 / R-3.4），本仓库关于「桶能不能写」的唯一实现。

    记该标的 ``F = min(time)``、``L = max(time)``，桶窗口 ``[b, b + W)``：

    - ``closed = (b + W) <= (L + 60_000)``
    - 有效窗口终点 ``win_end = min(b + W - 60_000, L)``
    - 有效窗口起点见下
    - ``expected = (win_end - win_start) / 60_000 + 1``（窗口非空时）
    - ``actual`` = 桶内 1m 行数

    只有 ``closed 且 actual == expected 且 actual > 0`` 才写桶。

    **有效窗口起点**分两种情形（R-3.4 的两种边缘，都不需要特例）：

      * **onboard 首日**：桶内最早的一根 1m 恰好是该标的的第一根 → 起点取 ``F``。
        期望根数因此是 675 而不是 1440，该桶**应当**写入；写死「一天必须 1440 根」
        会让新上市标的的第一根日线永远不存在（附录 C.1）。
      * **桶内有缺口**：起点取 ``b``。

    区分靠 ``bucket_first_ms``（桶内**实际**最早的一根 1m）。

    注意这条规则的边界：它能识别「桶内缺了尾部/中部」，但识别不了「删掉了该标的
    全局最早的一根」——那时 ``bucket_first_ms`` 仍然等于新的 ``F``，桶会重新合格。
    这类分叉由 :func:`check_intervals` 的 ``stale`` 判定独立抓出（见那里的
    :func:`bucket_is_whole`），因为「已写入的桶必须整桶 1m 齐全」是一条**与 F/L 无关**
    的不变式。
    """
    bucket_end = bucket + width_ms
    # 桶内可能存在的 1m 开盘时间上界是 b + W - 60_000（该分钟收盘于 b + W - 1）
    last_slot = bucket_end - ONE_MINUTE_MS
    closed = bucket_end <= last_ms + ONE_MINUTE_MS

    if actual == 0:
        # 桶内一行都没有：整个桶在数据区间之外，不参与统计也不写（附录 C.4）。
        return BucketJudgement(
            time=bucket, write=False, closed=closed, actual=0, expected=0, missing=0
        )

    win_start = first_ms if bucket_first_ms == first_ms else bucket
    win_end = min(last_slot, last_ms)
    if win_start > win_end:  # pragma: no cover - actual > 0 时不会走到
        return BucketJudgement(
            time=bucket, write=False, closed=closed, actual=0, expected=0, missing=0
        )

    expected = (win_end - win_start) // ONE_MINUTE_MS + 1
    write = closed and actual > 0 and actual == expected
    return BucketJudgement(
        time=bucket,
        write=write,
        closed=closed,
        actual=actual,
        expected=expected,
        missing=max(0, expected - actual),
        window_start=win_start,
        window_end=win_end,
    )


# ------------------------------------------------------------------ 桶值计算


@dataclass(frozen=True, slots=True)
class AggregateBar:
    """一个派生桶的最终值（R-2.2）。``quote_volume`` / ``trades`` 允许 None。"""

    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float
    quote_volume: float | None
    trades: int | None


def aggregate_rows(rows: Sequence[Kline], bucket: int | None = None) -> AggregateBar:
    """把桶内按 ``time`` 升序的 1m 行折成一个桶（纯函数，R-2.2）。

    - ``time`` 取**桶起点** ``b``，不是首行的时间。两者在正常桶里相同，但在
      onboard 首日不同：``F`` 落在 12:45 时，当天 1d 桶的首行是 12:45，而桶起点是
      当日 00:00（附录 C.1）。用首行时间会写出一个不在桶边界上的 ``time``，
      破坏「``time`` 即桶起点」这个跨语言契约，也会让 `--check` 的桶匹配对不上。
    - ``open`` 取首行、``close`` 取末行——**不**取均价、不取前收顶替（R-2.3）；
    - ``quote_volume`` / ``trades``：**任一行为 NULL 则结果为 NULL**，全部非 NULL 才求和。
      对一部分行求和、把另一部分当 0，都会产出一个**看起来正常**的错数（R-4.3 明确禁止）；
      桶级 NULL 是唯一诚实的表达；
    - 不做额外舍入、不把 float 降成 decimal：派生值与 1m 的差异必须只来自聚合本身（R-2.5）。
    """
    if not rows:
        raise SyncError("AGGREGATION_FAILED", "不能聚合空桶", {"rows": 0})
    ordered = sorted(rows, key=lambda r: r.time)
    return AggregateBar(
        time=ordered[0].time if bucket is None else bucket,
        open=ordered[0].open,
        high=max(r.high for r in ordered),
        low=min(r.low for r in ordered),
        close=ordered[-1].close,
        volume=sum(r.volume for r in ordered),
        quote_volume=(
            None
            if any(r.quote_volume is None for r in ordered)
            else sum(float(r.quote_volume) for r in ordered if r.quote_volume is not None)
        ),
        trades=(
            None
            if any(r.trades is None for r in ordered)
            else sum(int(r.trades) for r in ordered if r.trades is not None)
        ),
    )


@dataclass(slots=True)
class IntervalAggregate:
    """单周期一轮聚合的统计（R-5.6：逐周期报出，不许只报「成功」）。"""

    interval: str
    upserted: int = 0
    withheld_not_closed: int = 0
    withheld_incomplete: int = 0
    missing_minutes: int = 0

    def to_dict(self) -> dict[str, object]:
        return {
            "upserted": self.upserted,
            "withheldNotClosed": self.withheld_not_closed,
            "withheldIncomplete": self.withheld_incomplete,
            "missingMinutes": self.missing_minutes,
        }


@dataclass(frozen=True, slots=True)
class BarBounds:
    """该标的 1m 数据的 ``[F, L]``。判据只吃它，不吃时钟。"""

    first_ms: int
    last_ms: int


# ----------------------------------------------------------------- 1m 读取


_BAR_COLUMNS = "time, open, high, low, close, volume, quote_volume, trades"


def read_bars_between(conn: DbConn, symbol: str, start_ms: int, end_ms: int) -> list[Kline]:
    """读 ``[start_ms, end_ms]`` 内的 1m 行，升序。**只读**，复用既有列与行映射。"""
    rows = conn.execute(
        f"SELECT {_BAR_COLUMNS} FROM klines_1m"
        " WHERE symbol = %s AND time >= %s AND time <= %s ORDER BY time ASC",
        (symbol, start_ms, end_ms),
    ).fetchall()
    return [
        Kline(
            time=int(r["time"]),
            open=float(r["open"]),
            high=float(r["high"]),
            low=float(r["low"]),
            close=float(r["close"]),
            volume=float(r["volume"]),
            # schema 不存 close_time（R-10.3 的口径）：按 1m 周期推导，与 `pg.bar_close_time` 同源。
            close_time=int(r["time"]) + ONE_MINUTE_MS - 1,
            quote_volume=None if r["quote_volume"] is None else float(r["quote_volume"]),
            trades=None if r["trades"] is None else int(r["trades"]),
        )
        for r in rows
    ]


def read_bounds(conn: DbConn, symbol: str) -> BarBounds | None:
    """``[min(time), max(time)]``；无数据返回 None（而不是两个 0，那会造出假桶）。"""
    row = conn.execute(
        "SELECT min(time) AS first_ms, max(time) AS last_ms FROM klines_1m WHERE symbol = %s",
        (symbol,),
    ).fetchone()
    if row is None or row["first_ms"] is None or row["last_ms"] is None:
        return None
    return BarBounds(first_ms=int(row["first_ms"]), last_ms=int(row["last_ms"]))


def bucket_starts(start_ms: int, end_ms: int, width_ms: int) -> list[int]:
    """区间 ``[start_ms, end_ms]`` 覆盖到的全部桶起点（升序）。

    两端都**含住**：起点向下对齐、终点向上对齐，保证「batch.max 所在的那个桶」被完整重算
    （R-4.2）。只含一端会让跨批的桶永远差一根，而那正是 R-3.5 要的「不写」——
    于是聚合就变成了「看运气」。
    """
    first = bucket_start(start_ms, width_ms)
    last = bucket_start(end_ms, width_ms)
    return list(range(first, last + width_ms, width_ms))


# ------------------------------------------------------------ 写入派生表

_UPSERT = (
    "INSERT INTO {table} (symbol, time, open, high, low, close, volume, quote_volume, trades)"
    " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)"
    # 同一天内重复重算同一桶是幂等的（R-4.2）：值不变，UPSERT 覆盖出同样一行。
    " ON CONFLICT (symbol, time) DO UPDATE SET open = EXCLUDED.open,"
    " high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,"
    " volume = EXCLUDED.volume, quote_volume = EXCLUDED.quote_volume,"
    " trades = EXCLUDED.trades"
)


def upsert_bars(conn: DbConn, symbol: str, interval: str, bars: Iterable[AggregateBar]) -> int:
    """把已判定合格的桶写入派生表，返回实际**改动**的行数。

    ``ON CONFLICT DO UPDATE`` 的 rowcount 恒等于受影响行数（含值完全相同的），
    因此调用方要拿「第二次 upserted = 0」当幂等断言的话，**不能**直接用这个数。
    增量路径的 ``upserted`` 由 :func:`aggregate_range` 用「写前后的桶集合差集」算。
    """
    table = DERIVED_TABLES[interval]
    payload = [
        (
            symbol,
            bar.time,
            bar.open,
            bar.high,
            bar.low,
            bar.close,
            bar.volume,
            bar.quote_volume,
            bar.trades,
        )
        for bar in bars
    ]
    if not payload:
        return 0
    with conn.cursor() as cur:
        cur.executemany(_UPSERT.format(table=table), payload)
    return len(payload)


def existing_buckets(conn: DbConn, symbol: str, interval: str, lo: int, hi: int) -> set[int]:
    """区间内派生表**已经**有的桶起点集合（用于计算真正的 ``upserted``）。"""
    rows = conn.execute(
        f"SELECT time FROM {DERIVED_TABLES[interval]}"
        " WHERE symbol = %s AND time >= %s AND time <= %s",
        (symbol, lo, hi),
    ).fetchall()
    return {int(r["time"]) for r in rows}


def read_bars_by_bucket(
    conn: DbConn, symbol: str, buckets: Sequence[int], width_ms: int
) -> dict[int, list[Kline]]:
    """**一次查询**读出多个桶的 1m 行，按桶起点分组。

    为什么必须批量：逐桶查询是 N+1——30 天历史的 15m 桶有 2880 个，一批 500 根
    虽只跨几个桶，但 ``--rebuild`` 与全量补齐会跨**全部**桶，于是查询数与桶数同阶。
    实测逐桶查询让每批聚合耗时 281ms，30 天全量要多花 24 秒；改成一次读之后
    同样的工作降到毫秒级。

    区间取 ``[buckets[0], buckets[-1] + W - 60_000]``：含住每个桶的**最后一分钟**，
    少一分钟就会把满桶误判成缺一根。
    """
    if not buckets:
        return {}
    lo = buckets[0]
    hi = buckets[-1] + width_ms - ONE_MINUTE_MS
    rows = read_bars_between(conn, symbol, lo, hi)
    grouped: dict[int, list[Kline]] = {bucket: [] for bucket in buckets}
    for row in rows:
        bucket = bucket_start(row.time, width_ms)
        bucket_rows = grouped.get(bucket)
        if bucket_rows is not None:
            bucket_rows.append(row)
    return grouped


def _judge_with_whole(
    conn: DbConn,
    *,
    symbol: str,
    bucket: int,
    width_ms: int,
    bounds: BarBounds,
    rows: Sequence[Kline],
    whole: set[int],
    preexisting: bool,
) -> BucketJudgement:
    """在 :func:`judge_bucket` 之上补一条**整桶齐全**的硬不变式。

    :func:`judge_bucket` 的有效窗口起点会为 onboard 首日让路（附录 C.1），代价是
    「删掉该标的全局最早的一根 1m」会让 ``F`` 右移到桶内第一根，桶于是重新变成
    「合格」——可它的值早就是按整桶根数算出来的。

    因此对**已经存在于派生表**的桶，额外要求它仍然整桶齐全；不满足就是 stale。
    这条只对**已有桶**生效：onboard 首日那个「合法但不满」的桶正是靠
    :func:`judge_bucket` 写入的，它不在 ``whole`` 里却是正确的——所以本函数只在
    ``preexisting`` 传该桶时才否决。
    """
    verdict = judge_bucket(
        bucket=bucket,
        width_ms=width_ms,
        first_ms=bounds.first_ms,
        last_ms=bounds.last_ms,
        actual=len(rows),
        bucket_first_ms=rows[0].time if rows else None,
    )
    # onboard 前缀桶（桶内首根就是 F）同样不在 `whole` 里，而它完全正确。
    # 必须放过它，否则每轮同步都会把新标的第一个桶报成「未全覆盖扣留」——
    # 而它既没缺数据、也不该被扣留。
    if preexisting and verdict.write and bucket not in whole and rows[0].time != bounds.first_ms:
        return BucketJudgement(
            time=verdict.time,
            write=False,
            closed=verdict.closed,
            actual=verdict.actual,
            expected=verdict.expected + 1,
            missing=verdict.missing + 1,
            window_start=verdict.window_start,
            window_end=verdict.window_end,
        )
    return verdict


def aggregate_range(
    conn: DbConn,
    symbol: str,
    interval: str,
    start_ms: int,
    end_ms: int,
    *,
    rebuild: bool = False,
) -> IntervalAggregate:
    """对 ``[start_ms, end_ms]`` 内全部合格桶执行 UPSERT（补齐 / ``--rebuild``）。

    - **只增不删**（R-4.4）：1m 历史不可改写，聚合绝不删已写入的桶；已写入的桶若因
      1m 被外部改动而不再合格，由 ``--check`` 报出、``--rebuild`` 修复；
    - ``rebuild=True`` 时先删该区间的派生桶再重算。删除范围按**桶边界**裁剪：用户给的
      往往是桶内任意一分钟，删半截会让 ``--rebuild`` 与「清空后全量重建」不相等（AC-9）；
    - 调用方负责划事务（与 1m 写入、R-3.2 同一套语义）。
    """
    width = interval_width(interval)
    stats = IntervalAggregate(interval=interval)
    bounds = read_bounds(conn, symbol)
    if bounds is None:
        return stats
    return _aggregate_one(
        conn,
        symbol=symbol,
        interval=interval,
        start_ms=start_ms,
        end_ms=end_ms,
        bounds=bounds,
        all_rows=read_bars_between(
            conn,
            symbol,
            bucket_start(start_ms, width),
            bucket_start(end_ms, width) + width - ONE_MINUTE_MS,
        ),
        rebuild=rebuild,
    )


def aggregate_batches(
    conn: DbConn,
    symbol: str,
    intervals: Sequence[str],
    start_ms: int,
    end_ms: int,
    *,
    rebuild: bool = False,
) -> dict[str, IntervalAggregate]:
    """一次处理**多个周期**（补齐 / ``--rebuild`` 的主入口）。

    为什么要合并：四个周期读的是**同一批 1m 行**，只是分桶宽度不同。逐周期各读一遍
    等于把最贵的那次查询做四遍——实测首次全量（30 天 / 43200 根）因此慢了一倍多。
    这里按「最宽周期」读一次，各周期在内存里各自切桶。
    """
    stats = {interval: IntervalAggregate(interval=interval) for interval in intervals}
    if not intervals:
        return stats
    bounds = read_bounds(conn, symbol)
    if bounds is None:
        return stats  # 库里没有 1m：不造桶（附录 C.4）

    # 以最宽的周期为界读一次，覆盖所有周期关心的范围
    widest = max(intervals, key=lambda i: interval_width(i))
    widest_width = interval_width(widest)
    read_from = bucket_start(start_ms, widest_width)
    read_to = bucket_start(end_ms, widest_width) + widest_width - ONE_MINUTE_MS
    all_rows = read_bars_between(conn, symbol, read_from, read_to)

    for interval in intervals:
        stats[interval] = _aggregate_one(
            conn,
            symbol=symbol,
            interval=interval,
            start_ms=start_ms,
            end_ms=end_ms,
            bounds=bounds,
            all_rows=all_rows,
            rebuild=rebuild,
        )
    return stats


def _aggregate_one(
    conn: DbConn,
    *,
    symbol: str,
    interval: str,
    start_ms: int,
    end_ms: int,
    bounds: BarBounds,
    all_rows: Sequence[Kline],
    rebuild: bool,
) -> IntervalAggregate:
    """单周期聚合，复用调用方已读好的 1m 行。"""
    width = interval_width(interval)
    result = IntervalAggregate(interval=interval)

    buckets = bucket_starts(start_ms, end_ms, width)
    if not buckets:
        return result
    lo, hi = buckets[0], buckets[-1]

    if rebuild:
        conn.execute(
            f"DELETE FROM {DERIVED_TABLES[interval]}"
            " WHERE symbol = %s AND time >= %s AND time <= %s",
            (symbol, lo, hi),
        )
    before = existing_buckets(conn, symbol, interval, lo, hi) if not rebuild else set()
    # rebuild 时该区间会被先删后算，桶都算「新建」，不适用整桶否决。
    preexisting_all = set() if rebuild else before
    # 整桶齐全判据只对**已存在的桶**有意义；没有任何已有桶时省掉这次全区间 GROUP BY
    # （首次全量绝大多数批次都走这条路径，而它是 30 天历史下最贵的一次查询）。
    # 区间要含桶的**末端**：用桶起点会让末桶只查到它自己那一根，整桶判据恒不成立。
    whole = whole_buckets(conn, symbol, width, lo, hi + width) if preexisting_all else set()

    rows_by_bucket: dict[int, list[Kline]] = {bucket: [] for bucket in buckets}
    for row in all_rows:
        bucket_rows = rows_by_bucket.get(bucket_start(row.time, width))
        if bucket_rows is not None:
            bucket_rows.append(row)

    written: list[AggregateBar] = []
    for bucket in buckets:
        rows = rows_by_bucket.get(bucket, [])
        verdict = _judge_with_whole(
            conn,
            symbol=symbol,
            bucket=bucket,
            width_ms=width,
            bounds=bounds,
            rows=rows,
            whole=whole,
            preexisting=bucket in preexisting_all,
        )
        if verdict.window_start is None:
            # win 为空：桶整个在数据区间之外，不参与统计也不写（附录 C.4）。
            continue
        if not verdict.write:
            # 两种扣留原因必须分开报：未收盘是「等下一批」，未全覆盖是「上游有缺口」（R-3.5）。
            if verdict.closed:
                result.withheld_incomplete += 1
            else:
                result.withheld_not_closed += 1
            result.missing_minutes += verdict.missing
            continue
        written.append(aggregate_rows(rows, bucket))

    upsert_bars(conn, symbol, interval, written)
    # 「本次写入」= 实际落库的桶 - 写前就存在的桶，因此重复执行同一区间时它是 0（AC-7）。
    #
    # 不再查一次「写后存在的桶」：那要多一次范围查询，而答案已经由 written 与 before
    # 完整给出——upsert 只可能新增 written 里的桶，不可能新增别的。rebuild 时区间已被清空，
    # before 为空，全部 written 都算新增。
    result.upserted = sum(1 for bar in written if bar.time not in before)
    return result


def withheld_counts(
    conn: DbConn, symbol: str, interval: str, start_ms: int, end_ms: int
) -> dict[str, int]:
    """区间内被扣留的桶数与缺失分钟数（**由 1m 推导**，不落扣留表，R-3.5）。

    逐桶复用 :func:`judge_bucket`，与写入路径同源；桶数被区间长度框住，详情页一次调用
    的代价可接受。

    **键名就是跨语言契约**：``AggregateIntervalStats`` 用
    ``withheldNotClosed`` / ``withheldIncomplete`` / ``missingMinutes``。这里若用简称
    （``notClosed`` / ``incomplete``），``data aggregate --check`` 的返回就与
    ``SyncRunSummary.aggregated`` / ``data aggregate``（补齐）不是同一个形状——
    两侧类型对不上，CLI 打印会在 ``undefined.toLocaleString`` 上崩掉（R-5.6 / R-8.3）。
    """
    width = interval_width(interval)
    bounds = read_bounds(conn, symbol)
    if bounds is None:
        return {"withheldNotClosed": 0, "withheldIncomplete": 0, "missingMinutes": 0}
    not_closed = incomplete = missing = 0
    bucket_list = bucket_starts(start_ms, end_ms, width)
    whole = (
        whole_buckets(conn, symbol, width, bucket_list[0], bucket_list[-1] + width)
        if bucket_list
        else set()
    )
    preexisting = existing_buckets(conn, symbol, interval, bucket_list[0], bucket_list[-1])
    rows_by_bucket = read_bars_by_bucket(conn, symbol, bucket_list, width)
    for bucket in bucket_list:
        rows = rows_by_bucket.get(bucket, [])
        verdict = _judge_with_whole(
            conn,
            symbol=symbol,
            bucket=bucket,
            width_ms=width,
            bounds=bounds,
            rows=rows,
            whole=whole,
            preexisting=bucket in preexisting,
        )
        if verdict.window_start is None or verdict.write:
            continue
        if verdict.closed:
            incomplete += 1
        else:
            not_closed += 1
        missing += verdict.missing
    return {
        "withheldNotClosed": not_closed,
        "withheldIncomplete": incomplete,
        "missingMinutes": missing,
    }


def interval_summary(
    conn: DbConn, symbol: str, interval: str, start_ms: int, end_ms: int
) -> dict[str, object]:
    """某周期在给定区间上的概览：已入库桶数 + 扣留统计（R-7.5 的服务端依据）。

    与 :func:`withheld_counts` 同源，差别只在多读一次派生表的行数——详情页要回答
    「这个标的一共少了多少根 4h」，那必须同时给出「应该有多少」与「现在有多少」。
    """
    width = interval_width(interval)
    counts = withheld_counts(conn, symbol, interval, start_ms, end_ms)
    stored_row = conn.execute(
        f"SELECT count(*) AS n FROM {DERIVED_TABLES[interval]}"
        " WHERE symbol = %s AND time >= %s AND time <= %s",
        (symbol, bucket_start(start_ms, width), bucket_start(end_ms, width)),
    ).fetchone()
    bounds = read_bounds(conn, symbol)
    return {
        "interval": interval,
        "table": DERIVED_TABLES[interval],
        "buckets": int(stored_row["n"]) if stored_row is not None else 0,
        "withheldNotClosed": counts["withheldNotClosed"],
        "withheldIncomplete": counts["withheldIncomplete"],
        "missingMinutes": counts["missingMinutes"],
        "firstBar": bounds.first_ms if bounds is not None else None,
        "lastBar": bounds.last_ms if bounds is not None else None,
    }


# ------------------------------------------------------------------- --check


def check_intervals(
    conn: DbConn, symbol: str, intervals: Sequence[str], start_ms: int, end_ms: int
) -> list[dict[str, object]]:
    """只读校验：报出 stale / missing / mismatch 三类不一致（R-5.1）。

    - ``stale``    派生表有，但按当前 1m 已不合格（1m 被改动后多出来的桶）；
    - ``missing``  按判据合格，但派生表里没有；
    - ``mismatch`` 合格且存在，但值与重算结果逐列不同。

    **只读**：不写任何表。发现任一不一致由 :func:`raise_on_mismatch` 抛
    ``AGGREGATION_MISMATCH``（退出码非 0 由 CLI 决定）。
    """
    problems: list[dict[str, object]] = []
    for interval in intervals:
        width = interval_width(interval)
        table = DERIVED_TABLES[interval]
        buckets = bucket_starts(start_ms, end_ms, width)
        if not buckets:
            continue
        lo, hi = buckets[0], buckets[-1]
        stored = {
            int(r["time"]): r
            for r in conn.execute(
                f"SELECT {_BAR_COLUMNS} FROM {table}"
                " WHERE symbol = %s AND time >= %s AND time <= %s",
                (symbol, lo, hi),
            ).fetchall()
        }
        bounds = read_bounds(conn, symbol)
        eligible: dict[int, AggregateBar] = {}
        # 桶内实际根数：stale 判定靠它（与 F/L 无关），见下面 `capacity` 处的说明
        actual_of: dict[int, int] = {}
        prefix_of: dict[int, int | None] = {}
        rows_by_bucket = read_bars_by_bucket(conn, symbol, buckets, width)
        for bucket in buckets:
            rows = rows_by_bucket.get(bucket, [])
            actual = len(rows)
            actual_of[bucket] = actual
            # 桶内首根 1m 是否就是该标的的第一根：这是「onboard 前缀桶」的唯一标志，
            # stale 判定必须靠它把「合法但不满」与「被删了数据」区分开（见下面 capacity 处）
            prefix_of[bucket] = rows[0].time if rows else None
            verdict = judge_bucket(
                bucket=bucket,
                width_ms=width,
                first_ms=bounds.first_ms if bounds is not None else bucket,
                last_ms=bounds.last_ms if bounds is not None else bucket,
                actual=actual,
                bucket_first_ms=rows[0].time if rows else None,
            )
            if verdict.window_start is None:
                continue
            if verdict.write:
                eligible[bucket] = aggregate_rows(rows, bucket)

        # 一个满桶应有的 1m 根数。stale 判定用它，见下面 `actual_of` 处的说明。
        capacity = width // ONE_MINUTE_MS

        for bucket, expected in sorted(eligible.items()):
            row = stored.get(bucket)
            if row is None:
                problems.append({"interval": interval, "kind": "missing", "time": bucket})
                continue
            is_prefix = prefix_of.get(bucket) == (bounds.first_ms if bounds is not None else None)
            if not is_prefix and actual_of.get(bucket, 0) < capacity:
                # 桶内 1m 不齐（根数不足一个满桶），它不该以「合格」的身份留在派生表。
                # 必须在比对值**之前**报 stale：值当然对不上，但根因是「这个桶不该在」，
                # 报成 mismatch 会让用户去查聚合公式，而真正的原因是上游少了数据。
                #
                # 这条独立于 `judge_bucket`，因为后者的有效窗口起点会为 onboard 首日让路
                # （附录 C.1），代价是「删掉该标的全局最早的一根 1m」也会让桶重新合格。
                #
                # **必须排除 onboard 前缀桶**（桶内首根就是 F）：那个桶合法但不满，它正是
                # 靠 `judge_bucket` 的让路写进去的。若一并报成 stale，每个新标的的
                # `--check` 都会失败 —— 而 `--check` 的意义恰恰是「一致时不报」。
                #
                # 「删掉了全局最早一根」的残余情形在数据上与前缀桶**无法区分**
                # （两者的桶内首根都等于当前的 F）。那种情况下值确实对不上，
                # 由下面的 mismatch 报出、由 `--rebuild` 修复——比在这里赌一个判据诚实。
                problems.append({"interval": interval, "kind": "stale", "time": bucket})
                continue
            for column, value in (
                ("open", expected.open),
                ("high", expected.high),
                ("low", expected.low),
                ("close", expected.close),
                ("volume", expected.volume),
                ("quote_volume", expected.quote_volume),
                ("trades", expected.trades),
            ):
                stored_value = row[column]
                if stored_value is None:
                    stored_value = None if value is None else float("nan")
                if stored_value != value:
                    problems.append(
                        {
                            "interval": interval,
                            "kind": "mismatch",
                            "time": bucket,
                            "column": column,
                            "stored": row[column],
                            "expected": value,
                        }
                    )
        # 派生表里有、但按当前 1m 已不合格（甚至整桶都不该存在）的行：R-3.3 禁止，
        # 却可能由外部改动造成，必须报出来而不是悄悄留着。
        for bucket in sorted(stored.keys() - eligible.keys()):
            problems.append({"interval": interval, "kind": "stale", "time": bucket})
    return problems


def whole_buckets(conn: DbConn, symbol: str, width_ms: int, lo: int, hi: int) -> set[int]:
    """区间内**整桶 1m 齐全**（根数 = W/60_000）的桶起点集合。

    与 :func:`judge_bucket` 的有效窗口**无关**：只数 ``[b, b+W)`` 里的 1m 行数是否
    恰好等于桶容量。因此 onboard 首日那个「合法但不满」的桶不在此集合内——它是
    靠 ``eligible`` 判合格的，不需要也不应该被这条不变式否决；而一个已经写进派生表
    的桶若不再满足整桶齐全，就是 stale。
    """
    capacity = width_ms // ONE_MINUTE_MS
    # psycopg3 用 pyformat 时 SQL 里的字面 `%` 写作 `%%`；桶对齐因此是 `time %% W`。
    rows = conn.execute(
        "SELECT time - (time %% %s) AS bucket, count(*) AS n"
        "  FROM klines_1m"
        " WHERE symbol = %s AND time >= %s AND time <= %s"
        " GROUP BY 1 HAVING count(*) = %s",
        (width_ms, symbol, lo, hi, capacity),
    ).fetchall()
    return {int(r["bucket"]) for r in rows}


def raise_on_mismatch(symbol: str, problems: Sequence[Mapping[str, object]]) -> None:
    """发现任一不一致就抛 ``AGGREGATION_MISMATCH``（R-5.1），并指出位置。"""
    if not problems:
        return
    first = problems[0]
    raise SyncError(
        "AGGREGATION_MISMATCH",
        f"{symbol} 的派生 K 线与库内 1m 不一致：{len(problems)} 处"
        f"（首个：{first.get('interval')} {first.get('kind')} @ {first.get('time')}）"
        "；修复方式：data aggregate --rebuild",
        {
            "symbol": symbol,
            "count": len(problems),
            "first": dict(first),
            "problems": [dict(p) for p in list(problems)[:20]],
        },
    )
