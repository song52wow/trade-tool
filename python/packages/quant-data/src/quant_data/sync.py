"""同步编排：首次全量、增量续传、缺口回补与校验。

一轮 ``sync`` 的固定顺序（对应需求）：
a. 单写者锁（``pg.SymbolLock``）→ b. 元数据解析与校验 → c. **优先回补已登记缺口**（R-11.B6）
→ d. 由起点决定写入策略（R-9.3）→ e/f. 分页拉取、去重、边界校验 → g. 丢弃最后一根（R-10.1），
并把它的开盘时刻留作收尾校验的时钟无关判据 → h. 分批 ``COPY`` 写入并同事务推进水位
（R-3.2 / R-19.5）→ i. 最后一根自愈校验（R-10.3，**判据不得复用轮首时钟**，见 ``_round_clock``）
→ j. 增量缺口检测（R-11.A）→ k. 全局权重预算（R-20）→ l. NOT NULL 语义（R-4）。
"""

from __future__ import annotations

import json
import math
import os
import time
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from quant_core import INDICATOR_IMPL_VERSION
from quant_core.io import log

from . import aggregate as agg
from . import indicators as ind
from . import pg
from .aggregate import validate_intervals
from .binance import (
    KLINE_LIMIT_MAX,
    ONE_MINUTE_MS,
    BinanceClient,
    ExchangeSymbol,
    Kline,
    align_bar_start,
    kline_weight,
)
from .errors import SyncError
from .http import Transport, UrllibTransport, binance_base_url
from .metadata import (
    DEFAULT_TTL_MS,
    MetadataSnapshot,
    fetch_metadata,
    validate_symbol,
)
from .pg import DbConn
from .ratelimit import DEFAULT_BUDGET_PER_MINUTE, WINDOW_MS, WeightBudget

EXCHANGE_BINANCE = "binance"

#: 分批写入的默认批大小（R-3.2 批大小可配置）。
DEFAULT_BATCH_SIZE = 5_000

#: 补齐 / ``--rebuild`` 的默认分批大小（v0.2.0 R-5.3）。**必须分批**：
#: 整段历史一次聚合会让单个事务持有锁的时间与 WAL 体积都不可接受。
DEFAULT_AGGREGATE_BATCH_BARS = 20_000

#: 指标补齐 / ``--rebuild`` 的默认分批大小（v0.3.0 R-6.3）。**必须分批**，理由同派生：
#: 整段历史一次物化会让单个事务的锁持有时间与 WAL 体积不可接受。
DEFAULT_INDICATOR_BATCH_BARS = 20_000

#: 缺口自动回补的默认尝试上限（R-11.B9）。
DEFAULT_MAX_GAP_ATTEMPTS = 5

#: 缺口检测的**回看窗口**：例行轮次固定扫描最近这么多毫秒。
#:
#: 为什么需要它：R-11.A.2 写的是「只扫 ``[verified_upto, max(time)]``」，而 AC-7 要求
#: 「人为在库里删掉中间几行 → **下一轮**自动补回」。两者字面上互斥——一轮干净同步之后
#: ``verified_upto == max(time)``，此时删中间行不改变 ``max(time)``，扫描区间塌缩成单点，
#: 中间的洞永远看不见。R-11 自己的目标是「**保证检测成本不随数据量线性增长**」，
#: 字面区间只是表达该目标的一种方式；AC-7 才是可验收的具体标准。
#: 因此扫描区间固定取 ``[max(第一根 bar, max(time) - lookback), max(time)]``：
#: 每轮多扫最近 7 天（1m 约 10,080 行/标的），成本有界、且只走 (symbol,time) 的
#: BRIN 索引，仍然**不是**每轮全表扫描（R-11.A.2 的真实目标得以保留）。
#: 下界**不**跟随 ``verified_upto``（见 ``_detect_and_register_gaps`` 的说明）。
DEFAULT_GAP_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000

#: 单行体积估算（附录 C.2：行存 ~100 字节/行，含索引项）。``sync_state.bytes`` 是可观测缓存，
#: 用估算值推进；权威行数始终是 ``klines_1m`` 的实际行数。
ESTIMATED_BYTES_PER_ROW = 100

#: 缺口回补中**不可降级为「重试次数 +1」**的错误码。
#: 这些错误说明交易所无视了 ``startTime``、库里出现未收盘 bar 或数据损坏，
#: 按 R-9.4 / R-21.5 必须直接抛给调用方，让 CLI 以非 0 退出码和可读原因结束；
#: 吞成 gap 重试只会把真正的原因埋进 ``gaps.last_error``，最终报一个错误的
#: ``GAP_ATTEMPTS_EXHAUSTED``。
_MANUAL_GAP_CODES = frozenset(
    {"BACKFILL_BOUNDARY_VIOLATION", "UNCLOSED_BAR_IN_STORE", "NULL_NOT_ALLOWED"}
)


def now_ms() -> int:
    return int(time.time() * 1000)


@dataclass(frozen=True, slots=True)
class SyncOptions:
    """一轮同步的全部入参。``now_ms`` 可注入以固定时钟（R-10.4）。"""

    exchange: str = EXCHANGE_BINANCE
    symbol: str = ""
    from_ms: int | None = None
    to_ms: int | None = None
    batch_size: int = DEFAULT_BATCH_SIZE
    max_gap_attempts: int = DEFAULT_MAX_GAP_ATTEMPTS
    gap_lookback_ms: int = DEFAULT_GAP_LOOKBACK_MS
    weight_budget: int = DEFAULT_BUDGET_PER_MINUTE
    allow_backfill: bool = True
    now_ms: int | None = None
    meta_dir: Path | None = None
    ttl_ms: int = DEFAULT_TTL_MS
    allow_stale: bool = False
    refresh: bool = False
    dsn: str | None = None
    transport: Transport | None = None
    base_url: str | None = None
    page_limit: int = KLINE_LIMIT_MAX
    #: 启用哪些派生周期（v0.2.0 R-9.1）。``None`` = 未指定，走
    #: :data:`DEFAULT_AGGREGATE_INTERVALS`；``[]`` = **显式关闭**派生（R-4.6 / AC-22）。
    aggregate_intervals: tuple[str, ...] | None = None
    #: 补齐 / ``--rebuild`` 的分批大小（仅 ``aggregate`` 子命令用，R-5.3）
    aggregate_batch_bars: int = DEFAULT_AGGREGATE_BATCH_BARS
    #: 启用哪些**指标周期**（v0.3.0 R-9.5）。``None`` = 走缺省；``[]`` = 显式关闭指标层。
    indicator_intervals: tuple[str, ...] | None = None
    #: 要物化的「指标 × 参数集」集合（v0.3.0 R-12.1）。**``[]`` = 显式关闭指标层**
    #: ——那是合法配置，状态里会如实显示「未启用指标」（R-11.4 / AC-23），而不是
    #: 显示 0 行让人以为「还没算」。
    indicator_specs: tuple[ind.ParamSet, ...] | None = None
    #: 补齐 / ``--rebuild`` 的分批大小（仅 ``indicators`` 子命令用，R-6.3）
    indicator_batch_bars: int = DEFAULT_INDICATOR_BATCH_BARS


#: 派生周期的默认集合。**必须**与 ``packages/data/sql/004_klines_agg.sql`` 的表集合一致，
#: 由 AC-1 的测试守住（R-9.4）。
DEFAULT_AGGREGATE_INTERVALS: tuple[str, ...] = ("15m", "1h", "4h", "1d")

#: 指标周期的缺省集合。**必须**与 ``indicatorIntervals`` 的缺省、以及
#: ``005_indicators.sql`` 里 ``interval`` 的 CHECK 允许集合三方一致（AC-2）。
DEFAULT_INDICATOR_INTERVALS: tuple[str, ...] = ind.ALLOWED_INDICATOR_INTERVALS


def resolve_aggregate_intervals(opts: SyncOptions) -> tuple[str, ...]:
    """归一 ``aggregate_intervals``，并对未实现周期报 ``CONFIG_INVALID``（R-9.1）。

    显式 ``[]``（关闭派生）是**合法配置**，不是运行时静默跳过：调用方据此让状态里
    如实显示「未启用派生」（R-8.4 / AC-22）。
    """
    raw = (
        opts.aggregate_intervals
        if opts.aggregate_intervals is not None
        else (DEFAULT_AGGREGATE_INTERVALS)
    )
    return validate_intervals(list(raw))


def resolve_indicator_intervals(opts: SyncOptions) -> tuple[str, ...]:
    """归一 ``indicator_intervals``，对未实现周期报 ``CONFIG_INVALID``（R-9.5）。

    与 :func:`resolve_aggregate_intervals` 分开而不是复用：指标**不做 1m**，而派生做。
    共用一个函数就会在某处不小心把 1m 也放行，而那意味着 4.3 GB/标的（N-2）。
    """
    raw = (
        opts.indicator_intervals
        if opts.indicator_intervals is not None
        else DEFAULT_INDICATOR_INTERVALS
    )
    return ind.validate_indicator_intervals(list(raw))


def resolve_indicator_specs(opts: SyncOptions) -> tuple[ind.ParamSet, ...]:
    """归一 ``indicator_specs``；``None`` = 走缺省，``[]`` = **显式关闭指标层**（R-12.2）。"""
    if opts.indicator_specs is None:
        return ind.DEFAULT_SPECS
    return tuple(opts.indicator_specs)


def _validate_options(
    opts: SyncOptions, *, require_symbol: bool = True, require_range: bool = False
) -> int:
    if require_symbol and not opts.symbol:
        raise SyncError("CONFIG_INVALID", "--symbol 不能为空", {})
    if opts.batch_size <= 0:
        raise SyncError(
            "CONFIG_INVALID", "--batch-size 必须为正整数", {"batchSize": opts.batch_size}
        )
    if opts.max_gap_attempts <= 0:
        raise SyncError(
            "CONFIG_INVALID",
            "--max-gap-attempts 必须为正整数",
            {"maxGapAttempts": opts.max_gap_attempts},
        )
    if require_range:
        if opts.from_ms is None or opts.to_ms is None:
            raise SyncError("CONFIG_INVALID", "backfill 必须同时给出 --from 与 --to", {})
        if opts.to_ms < opts.from_ms:
            raise SyncError(
                "CONFIG_INVALID",
                "--to 不能早于 --from",
                {"from": opts.from_ms, "to": opts.to_ms},
            )
    return opts.now_ms if opts.now_ms is not None else now_ms()


def _round_clock(opts: SyncOptions, round_now: int) -> Callable[[], int]:
    """本轮的读时钟函数：**除单测注入外，每次调用都现读一次**。

    - 注入了 ``now_ms``（R-10.4 的单测固定时钟）：恒返回它，用例才可复现；
    - 否则：真读系统时钟，绝不把轮首那一刻复用到底。

    为什么复用轮首时刻是错的：写入路径判定「是否收盘」靠的是**交易所返回的末位**
    （R-10.1，与本地时钟无关），而一轮完全可能因为首次全量（实测十几到几十分钟）、
    全局权重预算等待（``WeightBudget.reserve`` 会 sleep 到下一个 60s 窗口）或缺口回补
    跨过整分钟边界。此时用轮首时钟去判「库里最后一根是否未收盘」，会把本轮刚写入的、
    其实已经收盘的 bar 判成未收盘（``UNCLOSED_BAR_IN_STORE`` 误报），
    在常驻侧直接把标的钉成 ``error`` 并中断同步。
    """
    if opts.now_ms is not None:
        return lambda: round_now
    return now_ms


def _resolve_dsn(opts: SyncOptions) -> str | None:
    return opts.dsn if opts.dsn is not None else os.environ.get(pg.DSN_ENV)


def _build_client(opts: SyncOptions, budget: WeightBudget | None) -> BinanceClient:
    return BinanceClient(
        opts.transport if opts.transport is not None else UrllibTransport(),
        opts.base_url or binance_base_url(),
        budget,
        page_limit=opts.page_limit,
    )


@contextmanager
def open_client(opts: SyncOptions) -> Iterator[tuple[BinanceClient, WeightBudget | None]]:
    """只出网不写库的命令（``symbols`` / ``resolve`` / ``estimate``）。

    配额桶是**可选**的：没有 DSN 时不出网也不失败——``estimate`` 明确不依赖 PG（R-8.3）。
    """
    dsn = _resolve_dsn(opts)
    if dsn is None:
        yield _build_client(opts, None), None
        return
    conn = pg.connect(dsn)
    try:
        # 有 DSN 就意味着会用到 PG（配额桶就是 weight_budget 表）。
        # 因此必须先过 schema 闸门：否则未迁移的库会在 ``WeightBudget._try_reserve`` 里
        # 撞上 ``relation "weight_budget" does not exist``，被兜底成 INTERNAL_ERROR——
        # 报错原因完全对不上真实问题，违反 R-1.3 / R-19.7「版本不匹配必须报错」。
        pg.ensure_schema(conn)
        budget = WeightBudget(conn, opts.weight_budget)
        yield _build_client(opts, budget), budget
    finally:
        conn.close()


@contextmanager
def open_writer(
    opts: SyncOptions, now: int
) -> Iterator[tuple[DbConn, WeightBudget, pg.SymbolLock]]:
    """需要写库的命令：单写者锁 + 写连接 + 配额桶。

    锁对象一并交出，调用方要用 ``lock.created`` 区分「本轮新建行」与「已有行」。
    """
    dsn = opts.dsn
    writer = pg.connect(dsn)
    try:
        # 两条连接都在抢锁**之前**建好：抢到 advisory lock 之后的任何失败路径
        # 都必须能走到 `lock.release()`。若把 budget_conn 的建立放在 acquire 与
        # 内层 try/finally 之间，那里的异常会跳过 release——当前只靠 CPython 引用计数
        # 在栈回卷时顺手关掉连接才没暴露，属于「碰巧正确」。
        budget_conn = pg.connect(dsn)
        try:
            # 先校验 schema 再抢锁：未迁移的库应报 SCHEMA_VERSION_MISMATCH 而非 SQL 错误（R-19.7）。
            pg.ensure_schema(writer)
            lock = pg.SymbolLock.acquire(dsn, opts.exchange, opts.symbol, now)
            try:
                yield writer, WeightBudget(budget_conn, opts.weight_budget), lock
            finally:
                lock.release()
        finally:
            budget_conn.close()
    finally:
        writer.close()


def _discard_ghost_state(writer: DbConn, opts: SyncOptions, lock: pg.SymbolLock) -> None:
    """丢掉本轮抢锁时新建、但标的校验随后的失败留下的 ``sync_state`` 行。

    抢锁必须先于校验（锁键就是 (exchange, symbol)），而抢锁会 `INSERT` 建行。
    不清理的话，`data sync --symbol <拼错的标的>` 会在 `sync status` 里留下一行
    `paused / 0 行`——看起来像这个标的已经被收进集合了。
    只删**本轮新建**的行（``lock.created``），已有行一根都不动。
    """
    if not lock.created:
        return
    with writer.transaction():
        pg.delete_state_row(writer, opts.exchange, opts.symbol)


def _load_metadata(opts: SyncOptions, client: BinanceClient, now: int) -> MetadataSnapshot:
    return fetch_metadata(
        client,
        meta_dir=opts.meta_dir,
        ttl_ms=opts.ttl_ms,
        allow_stale=opts.allow_stale,
        now_ms=now,
        refresh=opts.refresh,
    )


def _resolve(
    opts: SyncOptions, client: BinanceClient, now: int
) -> tuple[MetadataSnapshot, ExchangeSymbol]:
    snapshot = _load_metadata(opts, client, now)
    return snapshot, validate_symbol(snapshot, opts.symbol)


def plan_estimate(
    symbol: str, start_ms: int, end_ms: int, budget_per_minute: int
) -> dict[str, object]:
    """首次全量的规模预估（R-8.3）。

    起点来自**运行时** ``onboardDate``，绝不用硬编码的日期或标的数值（R-8.2 / R-5.3）；
    并向上对齐到 1m 边界（``align_bar_start``），使 ``from`` / ``bars`` / ``requests`` 与
    真正拉取时**完全一致**——``onboardDate`` 常常不对齐（例如 1757407980000 这类），
    报未对齐的起点会让操作者在提交约 5 分钟、约 1000 次请求之前拿到一份对不上的估算。
    """
    if budget_per_minute <= 0:
        raise SyncError("CONFIG_INVALID", "权重预算必须为正整数", {"budget": budget_per_minute})
    start_ms = align_bar_start(start_ms)
    span_ms = max(0, end_ms - start_ms)
    bars = span_ms // ONE_MINUTE_MS + 1
    requests = math.ceil(bars / KLINE_LIMIT_MAX)
    weight = requests * kline_weight(KLINE_LIMIT_MAX)
    return {
        "symbol": symbol,
        "bars": bars,
        "requests": requests,
        "weight": weight,
        "estimatedMs": int(weight / budget_per_minute * WINDOW_MS),
        "from": start_ms,
        "to": end_ms,
    }


#: 首次全量规模预估在 ``sync_state`` 里的列（002_sync_plan，R-8.3 / R-8.6）。
_PLAN_COLUMNS = (
    "plan_bars",
    "plan_requests",
    "plan_weight",
    "plan_estimated_ms",
    "plan_from",
    "plan_to",
    "plan_at",
)


def _plan_fields(estimate: Mapping[str, object], now: int) -> dict[str, object]:
    """把 ``plan_estimate`` 的返回值映射成 ``sync_state`` 的 plan_* 列。"""
    return {
        "plan_bars": estimate["bars"],
        "plan_requests": estimate["requests"],
        "plan_weight": estimate["weight"],
        "plan_estimated_ms": estimate["estimatedMs"],
        "plan_from": estimate["from"],
        "plan_to": estimate["to"],
        "plan_at": now,
    }


def _aligned_bar_count(from_ms: int, to_ms: int) -> int:
    """闭区间 ``[from_ms, to_ms]`` 内**开盘时刻对齐到 1m** 的 bar 个数。

    交易所只返回 ``openTime`` 对齐到 60_000 的 bar，库里也只会有这些行。
    用未对齐的 ``(to - from) // 60_000 + 1`` 会高估：例如 from=60_001、to=179_999
    实际只有 120_000 一根，公式却算出 2，于是 ``present >= expected`` 永远不成立——
    缺口记录清不掉、``data gaps`` 永远挂着该缺口（R-11.B12 的人工兜底闭不上环）。
    """
    first = align_bar_start(from_ms)
    last = (to_ms // ONE_MINUTE_MS) * ONE_MINUTE_MS
    if last < first:
        return 0
    return (last - first) // ONE_MINUTE_MS + 1


def _assert_within_boundary(rows: Sequence[Kline], start_ms: int, symbol: str) -> None:
    """所有返回的 bar 必须 ``time >= 起点``，否则报错且**不写任何数据**（R-9.4 / AC-31）。"""
    for row in rows:
        if row.time < start_ms:
            raise SyncError(
                "BACKFILL_BOUNDARY_VIOLATION",
                f"交易所返回了早于请求起点的 bar（{row.time} < {start_ms}），已放弃本轮写入",
                {
                    "symbol": symbol,
                    "startTime": start_ms,
                    "violatingTime": row.time,
                },
            )


def _keep_closed(page: list[Kline], now: int) -> list[Kline]:
    """丢掉所有尚未收盘的 bar（``closeTime > now``），其余全部保留。

    ``now`` 由调用方按**当页拉取时刻**现读（:func:`_round_clock`）。用轮首时刻会把本轮
    才收盘的尾部 bar 一起丢掉，而限区间请求的完整性判定只在 ``[from, to]`` 内比对，
    丢掉的尾巴既不会报错也不会记成缺口——那就是静默少数据。
    """
    return [row for row in page if row.close_time <= now]


@dataclass(slots=True)
class PullObservation:
    """拉取过程中留下的「交易所当前那根 bar」的开盘时刻（R-10.3 的时钟无关判据）。

    开放式请求（无 ``endTime``）返回的末位就是交易所**正在形成**的那根 bar（R-10.1），
    它会被无条件丢弃；把它的开盘时刻记在这里，收尾校验就能问「库里最后一根是否严格早于
    交易所此刻这根」，而不必拿本地时钟当「是否收盘」的权威（本地时钟既可能落后交易所，
    也可能是轮首抓的旧值）。
    """

    open_bar_time: int | None = None


def _iter_pull(
    client: BinanceClient,
    symbol: str,
    start_ms: int,
    end_ms: int | None,
    clock: Callable[[], int],
    observation: PullObservation | None = None,
) -> Iterator[list[Kline]]:
    """按页产出 1m bar（已按区间过滤、已去重、已丢弃未收盘末根）。

    这是个**生成器**：调用方逐批消费，内存占用是 O(单批) 而不是 O(全量)。
    首次全量约 144 万根（附录 B.1），若先把整段拉完再写，中途被中断就得整段重拉，
    R-3.2 / R-8.5 / AC-6 要求的「中断后从水位继续」就不成立。

    去重只用**一个水位标量**（``emitted_upto``）而不是累积的 ``set``：
    页游标本身就是「上一页最后一根 + 60_000」，正常情况下相邻页不会重叠，
    去重只是防交易所无视 ``startTime`` 的兜底；用 set 记全部行会让内存回到 O(全量)
    （144 万根 ≈ 上百 MB），恰好抵消了流式的意义。

    末位处理规则见原 ``_pull_range`` 的说明：开放式请求无条件丢弃末位（与时钟无关），
    并把该末位记进 ``observation``（逐页覆盖，最后一个非空页的值即交易所此刻的最新 bar）；
    指定 ``endTime`` 的请求只丢弃 ``closeTime > clock()`` 的，且**每页现读一次时钟**。
    """
    emitted_upto = start_ms - ONE_MINUTE_MS
    cursor = start_ms
    limit = client.page_limit
    while True:
        page = client.klines(symbol, cursor, end_ms, limit)
        if not page:
            return
        if end_ms is None:
            if observation is not None:
                observation.open_bar_time = page[-1].time
            kept = page[:-1]
        else:
            kept = _keep_closed(page, clock())
        # 边界校验（R-9.4）必须在去重**之前**：去重是按「已产出的最大 time」丢更早的行，
        # 若先去过重，交易所无视 startTime 返回的越界 bar 会被静默丢掉，
        # AC-31 要求抛出的 BACKFILL_BOUNDARY_VIOLATION 就永远不会发生。
        # 写盘前每批还会再校验一次（`_stream_pull_and_write`），这里只是让它更早、更明确地爆出来。
        _assert_within_boundary(kept, start_ms, symbol)
        fresh = [row for row in kept if row.time > emitted_upto]
        if fresh:
            emitted_upto = max(emitted_upto, max(row.time for row in fresh))
            yield fresh
        if len(page) < limit or not kept:
            return
        if end_ms is None:
            # 从保留的最后一根推进：被丢掉的末位会在下一页作为首元素回来，不丢数据。
            next_cursor = kept[-1].time + ONE_MINUTE_MS
        else:
            # 限区间请求下，被丢掉的只有未收盘的 bar（必然在末尾），越过原始末位即可。
            next_cursor = page[-1].time + ONE_MINUTE_MS
        if end_ms is not None and next_cursor > end_ms:
            return
        if next_cursor <= cursor:  # pragma: no cover - 防御交易所返回不推进
            raise SyncError(
                "EXCHANGE_ERROR",
                f"分页未推进（cursor={cursor}, next={next_cursor}）",
                {"symbol": symbol, "cursor": cursor, "next": next_cursor},
            )
        cursor = next_cursor


def _pull_range(
    client: BinanceClient,
    symbol: str,
    start_ms: int,
    end_ms: int | None,
    clock: Callable[[], int],
) -> list[Kline]:
    """把整段拉成一个列表。**只用于小范围**（单页量级，如缺口回补）。

    首次全量与大区间必须走 :func:`_stream_pull_and_write`：把 144 万根全部攒在内存里
    再写，不仅峰值内存随数据量线性增长，而且中断后水位从未推进，重跑要整段重来。
    """
    collected: dict[int, Kline] = {}
    for fresh in _iter_pull(client, symbol, start_ms, end_ms, clock):
        for row in fresh:
            collected.setdefault(row.time, row)
    return [collected[key] for key in sorted(collected)]


def _by_interval(
    stats: Mapping[str, ind.IndicatorStat], intervals: Sequence[str]
) -> list[tuple[str, dict[str, ind.IndicatorStat]]]:
    """按 :attr:`IndicatorStat.interval` 把一批统计重新分组。"""
    out: dict[str, dict[str, ind.IndicatorStat]] = {}
    for item in stats.values():
        out.setdefault(item.interval, {})[ind.stat_key_from_stat(item)] = item
    return [(iv, out[iv]) for iv in intervals if iv in out]


def _merge_by_interval(
    target: dict[str, dict[str, ind.IndicatorStat]],
    source: Mapping[str, dict[str, ind.IndicatorStat]],
) -> None:
    for interval, batch in source.items():
        ind.merge_stats(target.setdefault(interval, {}), batch)


def _assert_indicator_versions_once(
    writer: DbConn,
    symbol: str,
    intervals: Sequence[str],
    specs: Sequence[ind.ParamSet],
) -> None:
    """一轮同步开始时校验一次 ``impl_version``（R-4.6）。

    混版是「库里已有旧版本行而代码已递增」的静态状态，不会在一轮之内变化。因此
    **每轮查一次**与每批查一次等价，但省掉 ``批数 × 周期数 × 参数集数`` 条往返——
    一轮首次全量可以有上千批，那条固定开销会被放大几千倍。
    """
    for interval in intervals:
        ind.assert_no_mixed_versions(writer, symbol, interval, specs)


def _merge_aggregated(
    target: dict[str, agg.IntervalAggregate], source: Mapping[str, agg.IntervalAggregate]
) -> None:
    """把一批的聚合计数累加进整轮统计。

    一轮同步的「本轮 upserted」必须等所有批都跑完才是完整数字：同一个桶可能被多批各
    重算一次，累加会让它重复计数。因此这里累加的是**各批自己算出的差集**——
    每批只报「自己新写进去的桶」，跨批重复重算的桶只有第一批会报它。
    """
    for interval, item in source.items():
        current = target.get(interval)
        if current is None:
            target[interval] = agg.IntervalAggregate(
                interval=interval,
                upserted=item.upserted,
                withheld_not_closed=item.withheld_not_closed,
                withheld_incomplete=item.withheld_incomplete,
                missing_minutes=item.missing_minutes,
            )
            continue
        current.upserted += item.upserted
        current.withheld_not_closed += item.withheld_not_closed
        current.withheld_incomplete += item.withheld_incomplete
        current.missing_minutes += item.missing_minutes


def write_bars_and_aggregate(
    writer: DbConn,
    symbol: str,
    rows: Sequence[Kline],
    strategy: str,
    intervals: Sequence[str],
    specs: Sequence[ind.ParamSet] = (),
) -> tuple[int, dict[str, agg.IntervalAggregate], dict[str, ind.IndicatorStat]]:
    """**1m 的唯一写入出口**（v0.2.0 R-4.1 / R-4.2；v0.3.0 R-5.1）。

    返回 ``(新增行数, 每周期聚合统计, 每「周期 × 参数集」指标统计)``。调用方负责包
    事务——本函数不自己开事务，因为它必须与 1m 写入、水位推进**同事务**（R-4.2）。

    为什么必须收敛成一个函数：当前写 1m 的路径有三条（``_stream_pull_and_write`` 的每批提交、
    缺口回补的内联写入、``run_backfill`` 的流式写入）。若聚合只挂在其中一条上，另外两条
    写进去的 1m 就永远派生不出高周期——而且是**静默**的：图上少一根 4h，没人会知道
    原因。R-4.1 的原话是「任何新的 1m 写入路径都必须经过它，否则聚合会变成看运气」。

    **指标物化挂在聚合之后、同一事务内**（v0.3.0 R-5.1）：顺序固定为
    ``写 1m → 聚合派生桶 → 物化指标 → 提交``。指标依赖刚写入的派生桶，因此必须在聚合
    之后；同事务的理由与派生聚合完全一致——不允许存在「K 线已提交、指标没跟上且无人
    察觉」的窗口。

    聚合 / 指标任一失败 → 异常向上冒，**整批回滚**（连 1m 一起），由调用方包着的
    `with writer.transaction()` 保证。错误码分别是 ``AGGREGATION_FAILED`` 与
    ``INDICATOR_FAILED``，均属「需人工介入」，不自动重试（R-4.6 / R-9.3 / R-5.4）。
    """
    added = pg.write_bars(writer, symbol, rows, strategy)
    stats: dict[str, agg.IntervalAggregate] = {}
    ind_stats: dict[str, ind.IndicatorStat] = {}
    if not intervals or not rows:
        return added, stats, ind_stats
    # 按**桶**对齐而不是按批边界：跨批的桶必须被完整重算，否则「上一批写了半根、
    # 这一批写了另一半」的桶永远不完整，而那正是 R-3.5 要扣留的情形。
    first_ms = min(row.time for row in rows)
    last_ms = max(row.time for row in rows)
    try:
        # 四个周期共用一次 1m 读取（见 aggregate.aggregate_batches）
        stats = agg.aggregate_batches(
            writer, symbol, list(intervals), first_ms, last_ms + ONE_MINUTE_MS - 1
        )
    except SyncError:
        raise
    except Exception as exc:
        # 聚合阶段的任何异常都归一成 AGGREGATION_FAILED 并附上定位信息：
        # 裸 psycopg 错误一路冒到 CLI 只会变成 INTERNAL_ERROR，用户既不知道
        # 哪个周期出的问题，也不知道该从哪个区间开始查（R-4.6 / R-9.3）。
        raise SyncError(
            "AGGREGATION_FAILED",
            f"派生失败: {symbol} 区间 [{first_ms}, {last_ms}] 周期 {list(intervals)}：{exc}",
            {
                "symbol": symbol,
                "intervals": list(intervals),
                "from": first_ms,
                "to": last_ms,
                "cause": str(exc),
            },
        ) from exc

    # 指标物化：紧接聚合之后、同一事务内（v0.3.0 R-5.1）。区间取**派生桶**范围，
    # 即本批 1m 触及的桶的起点区间——不是 1m 区间，否则每个周期都要在几百万根里
    # 扫一遍根本不属于它的下标。
    if specs:
        for interval in intervals:
            width = agg.interval_width(interval)
            ind.materialize_touched(
                writer,
                symbol,
                interval,
                specs,
                agg.bucket_start(first_ms, width),
                agg.bucket_start(last_ms, width) + width - ONE_MINUTE_MS,
                ind_stats,
            )
    return added, stats, ind_stats


def _advance_progress(
    writer: DbConn,
    opts: SyncOptions,
    added: int,
    now: int,
    rows_before: int | None = None,
) -> int:
    """在**当前事务内**推进可观测状态：水位 / rows / bytes / 待回补缺口数。

    必须与该批 ``COPY`` 同事务提交（R-19.5），否则会出现「数据已入库但水位未推进」。
    ``rows`` 只按新增行数累加（权威行数始终是 ``klines_1m`` 的实际值），
    ``bytes`` 用附录 C.2 的单行体积估算推进。
    """
    state = pg.read_state(writer, opts.exchange, opts.symbol)
    previous_rows = rows_before
    if previous_rows is None:
        previous_rows = int(state["rows"]) if state is not None and state.get("rows") else 0
    previous_bytes = int(state["bytes"]) if state is not None and state.get("bytes") else 0
    total_rows = previous_rows + added
    pg.update_state(
        writer,
        opts.exchange,
        opts.symbol,
        now_ms=now,
        watermark=pg.max_time(writer, opts.symbol),
        rows=total_rows,
        bytes=previous_bytes + added * ESTIMATED_BYTES_PER_ROW,
        pending_gaps=pg.count_gaps(writer, opts.symbol),
    )
    return total_rows


def _stream_pull_and_write(
    writer: DbConn,
    opts: SyncOptions,
    client: BinanceClient,
    start_ms: int,
    end_ms: int | None,
    strategy: str,
    now: int,
) -> tuple[
    int,
    PullObservation,
    dict[str, agg.IntervalAggregate],
    dict[str, dict[str, ind.IndicatorStat]],
]:
    """边拉边写：攒够 ``batch_size`` 就 ``COPY`` + 提交 + 推进水位，再继续拉下一页。

    这是 R-3.2 / R-8.5 / AC-6 的落点，也是与「先拉完再写」的本质区别：

    - **每批一个事务**，成功提交后才推进水位。中断后重跑从水位继续，不重头、不丢数；
    - **峰值内存是 O(batch_size)**，与数据总量无关——首次全量 144 万行不会撑爆内存；
    - 边界校验（R-9.4）按批执行，与「全量校验后再写」等价：任何一根
      ``time < startTime`` 都会在它所在的那一批抛错，此前已提交的批次保持有效。

    返回 ``(新增行数, 拉取过程中观察到的交易所当前 bar, 每周期聚合统计, 指标统计)``。
    第二个返回值目前只有 ``run_sync`` 用得着（R-10.3 的收尾校验），而那个判定必须在写完
    ——可能已过很久——之后才做。第三个是跨批累加后的聚合统计，进 ``SyncRunSummary.aggregated``
    （R-8.3）。第四个是指标物化统计，进 ``SyncRunSummary.indicators``（v0.3.0 R-11.3）。
    """
    added = 0
    known_rows: int | None = None
    buffer: list[Kline] = []
    observation = PullObservation()
    clock = _round_clock(opts, now)
    intervals = resolve_aggregate_intervals(opts)
    specs = resolve_indicator_specs(opts)
    # 混版检查**每轮一次**（R-4.6）：一轮内只有本进程写指标，且只写一个版本，
    # 因此每批重查不会提高安全性，只会把固定开销乘以批数。查出不一致立刻拒绝，
    # 用户不会看到「前几批写进去了、从这一批开始才停」。
    if specs:
        _assert_indicator_versions_once(writer, opts.symbol, intervals, specs)
    aggregated: dict[str, agg.IntervalAggregate] = {
        interval: agg.IntervalAggregate(interval=interval) for interval in intervals
    }
    # **按周期分组**（与 `aggregated` 同形）：内部键只有「指标:参数」，四个周期会互相覆盖，
    # 摘要里就只剩最后一个周期的数字——而那看起来完全正常。
    indicators: dict[str, dict[str, ind.IndicatorStat]] = {i: {} for i in intervals}

    def commit(chunk: Sequence[Kline]) -> None:
        """写入一批并在**同一事务内**推进可观测状态（R-19.5）、派生桶（R-4.2）与指标（R-5.1）。"""
        nonlocal added, known_rows
        _assert_within_boundary(chunk, start_ms, opts.symbol)
        with writer.transaction():
            # 1m 写入 + 派生聚合 + 指标物化在**同一个事务**里：不允许出现「1m 已提交、
            # 派生或指标没跟上且无人察觉」的窗口（R-4.2 / R-5.1）。任一环节抛错 →
            # 整批回滚，连 1m 一起。
            batch_added, stats, ind_stats = write_bars_and_aggregate(
                writer, opts.symbol, chunk, strategy, intervals, specs
            )
            for interval, item in stats.items():
                current = aggregated[interval]
                current.upserted += item.upserted
                current.withheld_not_closed += item.withheld_not_closed
                current.withheld_incomplete += item.withheld_incomplete
                current.missing_minutes += item.missing_minutes
            for interval, batch in _by_interval(ind_stats, intervals):
                ind.merge_stats(indicators[interval], batch)
            # 首批用一次精确 count 打底（状态可能来自旧版本或别的进程），之后按新增累加，
            # 避免每批都做一次 count(*)（首次全量 144 万行时代价不可接受）。
            if known_rows is None:
                known_rows = pg.count_rows(writer, opts.symbol) - batch_added
            known_rows = _advance_progress(writer, opts, batch_added, now, known_rows)
            added += batch_added

    for fresh in _iter_pull(client, opts.symbol, start_ms, end_ms, clock, observation):
        buffer.extend(fresh)
        while len(buffer) >= opts.batch_size:
            commit(buffer[: opts.batch_size])
            del buffer[: opts.batch_size]
    if buffer:
        commit(buffer)
    return added, observation, aggregated, indicators


def _assert_last_bar_closed(
    writer: DbConn,
    symbol: str,
    observation: PullObservation,
    clock: Callable[[], int],
) -> None:
    """库内最后一根必须已收盘（R-10.3）。

    增量起点含最后一根，重拉 + UPSERT 已把它覆盖；这里在写完后再校验一次，
    仍不满足就抛错——**不得静默继续**。

    判据分两级，优先用**与本地时钟无关**的那一级：

    1. ``observation.open_bar_time``（本轮拉取看到的、交易所当前正在形成的那根 bar）：
       库里最后一根必须**严格早于**它。这是精确判据——写入路径丢掉的正是这根末位；
    2. 拿不到观测时（本轮一页都没拉到：库里最后一根已跑到交易所最新数据之后）
       退回本地时钟，并且**必须现读**（``clock``）。绝不能用轮首那一刻：一轮可能跨过
       整分钟边界，用轮首时钟会把本轮刚写入的、已收盘的 bar 误判成未收盘，
       把一次正常的同步打断（见 :func:`_round_clock`）。
    """
    last = pg.last_bar_time(writer, symbol)
    if last is None:
        return
    observed = observation.open_bar_time
    if observed is not None:
        if last < observed:
            return
        raise SyncError(
            "UNCLOSED_BAR_IN_STORE",
            f"库内最后一根 bar 尚未收盘: {symbol} time={last} exchangeOpenBar={observed}",
            {"symbol": symbol, "time": last, "exchangeOpenBar": observed},
        )
    now = clock()
    close_time = pg.bar_close_time(last)
    if close_time > now:
        raise SyncError(
            "UNCLOSED_BAR_IN_STORE",
            f"库内最后一根 bar 尚未收盘: {symbol} time={last} closeTime={close_time} now={now}",
            {"symbol": symbol, "time": last, "closeTime": close_time, "now": now},
        )


def _backfill_registered_gaps(
    client: BinanceClient,
    writer: DbConn,
    opts: SyncOptions,
    now: int,
    *,
    skip: frozenset[int] | None = None,
) -> tuple[
    int,
    int,
    set[int],
    dict[str, agg.IntervalAggregate],
    dict[str, dict[str, ind.IndicatorStat]],
]:
    """优先回补已登记的缺口（R-11.B6）：成功则删除并推进 ``verified_upto``；失败计次。

    返回 ``(已补回数, 已放弃数, 本次尝试过的 gap_start, 每周期聚合统计)``。第三个返回值让
    调用方能在一轮内跑两遍（轮首补上轮遗留的、轮末补本轮新发现的）而**不重复计次**——
    否则同一个缺口一轮会消耗两次 ``attempts``，``maxGapAttempts`` 的语义就变了。

    缺口回补同样经过 :func:`write_bars_and_aggregate`（R-4.3）：缺口被补上的那一轮，
    受影响的高周期桶**当场**出现，不需要人工 ``--rebuild``（AC-8）。
    """
    filled = 0
    abandoned = 0
    attempted: set[int] = set()
    intervals = resolve_aggregate_intervals(opts)
    specs = resolve_indicator_specs(opts)
    if specs:
        _assert_indicator_versions_once(writer, opts.symbol, intervals, specs)
    # 混版检查**每轮一次**（R-4.6）：一轮内只有本进程写指标，且只写一个版本，
    # 因此每批重查不会提高安全性，只会把固定开销乘以批数。查出不一致立刻拒绝，
    # 用户不会看到「前几批写进去了、从这一批开始才停」。
    if specs:
        _assert_indicator_versions_once(writer, opts.symbol, intervals, specs)
    aggregated: dict[str, agg.IntervalAggregate] = {
        interval: agg.IntervalAggregate(interval=interval) for interval in intervals
    }
    indicators: dict[str, dict[str, ind.IndicatorStat]] = {i: {} for i in intervals}
    state = pg.read_state(writer, opts.exchange, opts.symbol)
    verified = state.get("verified_upto") if state is not None else None
    verified_ms = int(verified) if verified is not None else None
    # 缺口区间全在历史里，本来就不该出现未收盘 bar；仍然用现读时钟而不是轮首时刻——
    # 让「是否收盘」的判据在全仓库只有一处来源，比在两种时钟之间挑一个更不容易出错。
    clock = _round_clock(opts, now)
    for gap in pg.list_gaps(writer, opts.symbol):
        gap_start = int(gap["gap_start"])
        if skip is not None and gap_start in skip:
            continue
        gap_end = int(gap["gap_end"])
        attempts = int(gap["attempts"])
        attempted.add(gap_start)
        if attempts >= opts.max_gap_attempts:
            abandoned += 1
            continue
        expected = _aligned_bar_count(gap_start, gap_end)
        try:
            # 缺口区间天然很小（几根到几百根），单事务内整段写完；
            # 这里刻意不走流式：删除 gap 记录与推进 verified_upto 必须在同一事务里判定（R-11.B8）。
            rows = _pull_range(client, opts.symbol, gap_start, gap_end, clock)
            _assert_within_boundary(rows, gap_start, opts.symbol)
            with writer.transaction():
                # 缺口回补一律 DO NOTHING：绝不误改已存在的正确数据（R-11.B7）。
                added, stats, ind_stats = write_bars_and_aggregate(
                    writer, opts.symbol, rows, "do-nothing", intervals, specs
                )
                for interval, batch in _by_interval(ind_stats, intervals):
                    ind.merge_stats(indicators[interval], batch)
                for interval, item in stats.items():
                    current = aggregated[interval]
                    current.upserted += item.upserted
                    current.withheld_not_closed += item.withheld_not_closed
                    current.withheld_incomplete += item.withheld_incomplete
                    current.missing_minutes += item.missing_minutes
                present = pg.count_rows_between(writer, opts.symbol, gap_start, gap_end)
                advanced: int | None = None
                if present >= expected:
                    pg.delete_gap(writer, opts.symbol, gap_start)
                    # 与 verified_upto 相邻时才推进基线（R-11.B8）。
                    if verified_ms is not None and gap_start <= verified_ms + ONE_MINUTE_MS:
                        verified_ms = gap_end
                        advanced = verified_ms
                # 状态与这批写入同事务推进（R-19.5）。
                _advance_progress(writer, opts, added, now)
                # R-11.B8 的「推进 verified_upto」必须落库：`_advance_progress` 不写这一列，
                # 只改局部变量的话，本轮之后进程被杀，基线就退回原处（缺口会被重扫一遍）。
                if advanced is not None:
                    pg.update_state(
                        writer, opts.exchange, opts.symbol, now_ms=now, verified_upto=advanced
                    )
            if present >= expected:
                filled += 1
            else:
                _record_gap_failure(
                    writer, opts, gap_start, attempts, f"回补不完整: {present}/{expected} 根", now
                )
        except SyncError as exc:
            # 这几类错误**不得**降级成「gap 回补失败第 N 次」：它们是交易所无视 startTime /
            # 库里出现未收盘 bar / 数据损坏，R-9.4 与 R-21.5 要求直接报出来。
            # 吞掉的话 CLI 会以退出码 0 收场，最终只报一个 GAP_ATTEMPTS_EXHAUSTED，
            # 真正的原因（越界时间戳）被埋进 gaps.last_error。
            if exc.code in _MANUAL_GAP_CODES:
                raise
            _record_gap_failure(
                writer, opts, gap_start, attempts, f"{exc.code}: {exc.message}", now
            )
    return filled, abandoned, attempted, aggregated, indicators


def _record_gap_failure(
    writer: DbConn,
    opts: SyncOptions,
    gap_start: int,
    attempts: int,
    error: str,
    now: int,
) -> None:
    """记录一次失败回补；达上限则该标的进 ``error`` 并停止自动重试（R-11.B9 / R-21.3）。"""
    reached_cap = attempts + 1 >= opts.max_gap_attempts
    with writer.transaction():
        pg.bump_gap_attempt(writer, opts.symbol, gap_start, attempts + 1, error, now)
        if reached_cap:
            state = pg.read_state(writer, opts.exchange, opts.symbol)
            pg.update_state(
                writer,
                opts.exchange,
                opts.symbol,
                now_ms=now,
                status="error",
                last_error=f"GAP_ATTEMPTS_EXHAUSTED gap_start={gap_start}: {error}",
                error_count=int(state["error_count"]) + 1 if state is not None else 1,
            )
            log(f"gap backfill cap reached for {opts.symbol} gap_start={gap_start}: {error}")
        else:
            pg.update_state(writer, opts.exchange, opts.symbol, now_ms=now, last_error=error)
    log(
        f"gap backfill failed for {opts.symbol} gap_start={gap_start} "
        f"attempt={attempts + 1}: {error}"
    )


def _detect_and_register_gaps(
    writer: DbConn,
    opts: SyncOptions,
    now: int,
) -> tuple[int, int]:
    """缺口检测：范围有界、且能看见「已验证区间之后被外部改动」。

    扫描区间 = ``[max(第一根 bar, max(time) - lookback), max(time)]``——即**固定回看窗口**，
    与 ``verified_upto`` 无关。理由见 ``DEFAULT_GAP_LOOKBACK_MS`` 的注释：字面的
    ``[verified_upto, max(time)]`` 与 AC-7 互斥（干净同步后两者相等，删中间行不可见），
    而 R-11 的真实目标是「检测成本不随数据量线性增长」——加一个固定回看窗口后每轮只多扫
    固定的行数，**仍然不是**每轮全表扫描（R-11.A.2 的目标得以保留，
    AC-32 由 ``test_gap_detection_scan_is_bounded`` 断言）。

    下界**不取** ``verified_upto``：它会被未解决的缺口钉在缺口之前，
    * 取 ``min(verified_upto, ...)`` → 有一个填不上的洞就每轮从那个洞扫到最新，成本线性增长；
    * 取 ``max(verified_upto, ...)`` → 干净同步后它等于 ``max(time)``，窗口塌缩成一个点，
      AC-7 的「删中间行下一轮自动补回」直接失效。
    已登记的缺口本来就落在 ``gaps`` 表里、由 :func:`_backfill_registered_gaps` 负责重试，
    不需要靠扫描重新发现；窗口之外的老洞由 `data verify` 全表扫描负责（R-11.A.3 ②）。

    ``verified_upto`` 取「最早一个未解决缺口之前」：必须看 ``gaps`` 表**全体**，
    因为缺口可能落在扫描窗口之外；只看本轮扫到的缺口会把窗口外的洞标成「已验证」。
    首次为该标的建立基线时做一次全表扫描（R-11.A3 ①）；无缺口则 ``verified_upto = max(time)``。
    """
    state = pg.read_state(writer, opts.exchange, opts.symbol)
    verified_raw = state.get("verified_upto") if state is not None else None
    verified = int(verified_raw) if verified_raw is not None else None
    latest = pg.max_time(writer, opts.symbol)
    if latest is None:
        return pg.count_gaps(writer, opts.symbol), verified if verified is not None else 0
    if verified is None:
        scan_start = pg.PG_MIN_TIME  # 首次建立基线：全表扫描一次（R-11.A3 ①）
    else:
        # 例行轮次只扫**固定回看窗口**，且**不**把 verified_upto 当扫描下界：
        #   * 用 `min(verified_upto, latest - lookback)`：一旦有填不上的缺口把 verified_upto
        #     钉在过去，每轮都会从那个洞一路扫到最新，成本随历史线性增长——正好抵消
        #     回看窗口的意义（R-11.A.2 的真实目标）。
        #   * 用 `max(verified_upto, latest - lookback)`：干净同步后 verified_upto == max(time)，
        #     窗口塌缩成一个点，删中间几行再也看不见——直接违反 AC-7。
        # 因此下界固定取 `latest - lookback`（再按第一根 bar 夹紧）：每轮扫描成本有界，
        # 且始终能看见近端的删改。窗口之外的老洞由 `data verify` 全表扫描负责（R-11.A.3 ②）。
        scan_start = latest - opts.gap_lookback_ms
        first_bar = pg.min_time(writer, opts.symbol)
        if first_bar is not None:
            scan_start = max(scan_start, first_bar)
    gaps = pg.detect_gaps(writer, opts.symbol, scan_start, latest)
    with writer.transaction():
        pg.insert_gaps(writer, opts.exchange, opts.symbol, gaps)
        # 有未解决缺口时基线只能停在最早那个缺口之前，否则会把洞标成「已验证」。
        oldest_gap = pg.min_gap_start(writer, opts.symbol)
        new_verified = latest if oldest_gap is None else min(latest, oldest_gap - ONE_MINUTE_MS)
        if new_verified != verified:
            pg.update_state(
                writer, opts.exchange, opts.symbol, now_ms=now, verified_upto=new_verified
            )
    return pg.count_gaps(writer, opts.symbol), new_verified


def _capture_watermark(writer: DbConn, exchange: str, symbol: str) -> tuple[int | None, int | None]:
    """轮次入口抓一份 ``(cached, authoritative)`` 快照。

    必须在**任何写入之前**抓：一旦开写，``_advance_progress`` 就会用 ``max(time)``
    覆盖掉被篡改的缓存，轮末再比就什么都看不到了——那正是「静默二选一」（R-19.6）。
    """
    state = pg.read_state(writer, exchange, symbol)
    if state is None:
        return None, None
    cached = state.get("watermark")
    return (int(cached) if cached is not None else None), pg.max_time(writer, symbol)


def _assert_watermark_snapshot(symbol: str, cached: int | None, authoritative: int | None) -> None:
    """对**入口快照**做一致性判定（AC-21）。

    放在轮末而不是轮首，是为了给更具体的错误让路：R-10.3 那种「库里多出一根未收盘 bar」
    同样表现为 cached < authoritative，但它有专属错误码 ``UNCLOSED_BAR_IN_STORE``，
    应当由 ``_assert_last_bar_closed`` 报出来，而不是被笼统的水位不一致盖掉。
    """
    if cached is None and authoritative is None:
        return
    if cached is None or authoritative is None or cached != authoritative:
        raise SyncError(
            "WATERMARK_MISMATCH",
            f"sync_state.watermark 与 max(time) 不一致: {symbol}",
            {"cached": cached, "authoritative": authoritative},
        )


def _assert_watermark_consistent(writer: DbConn, exchange: str, symbol: str) -> None:
    """当前时刻的 ``sync_state.watermark`` 与 ``max(time)`` 必须一致（AC-21 / R-19.6）。

    ``cached is None``（缓存尚未初始化，建行 / ``ensureSyncState`` 都插 NULL）而库内已有数据
    同样算不一致——与 TS 侧 ``repo.assertWatermarkConsistent`` 的判定保持一致，两侧不能各说一套。
    """
    cached, authoritative = _capture_watermark(writer, exchange, symbol)
    _assert_watermark_snapshot(symbol, cached, authoritative)


def list_symbols(opts: SyncOptions) -> dict[str, object]:
    """``symbols`` 命令：运行时发现的可交易永续集合，按 symbol 排序。"""
    now = _validate_options(opts, require_symbol=False)
    with open_client(opts) as (client, _budget):
        snapshot = _load_metadata(opts, client, now)
    entries = [
        {
            "symbol": item.symbol,
            "contractType": item.contract_type,
            "status": item.status,
            "onboardDate": item.onboard_date,
        }
        for item in snapshot.tradable_perpetuals()
    ]
    return {
        "exchange": opts.exchange,
        "count": len(entries),
        "cachedAt": snapshot.saved_at,
        "ageMs": snapshot.age_ms(now),
        "stale": snapshot.stale,
        "symbols": entries,
    }


def resolve_symbol(opts: SyncOptions) -> dict[str, object]:
    """``resolve`` 命令：精确匹配 + 校验（R-7.2）。"""
    now = _validate_options(opts)
    with open_client(opts) as (client, _budget):
        snapshot, item = _resolve(opts, client, now)
    return {
        "symbol": item.symbol,
        "contractType": item.contract_type,
        "status": item.status,
        "onboardDate": item.onboard_date,
        "cachedAt": snapshot.saved_at,
        "ageMs": snapshot.age_ms(now),
        "stale": snapshot.stale,
    }


def estimate_scale(opts: SyncOptions) -> dict[str, object]:
    """``estimate`` 命令：首次全量的规模预估，**不需要 PG**（R-8.3）。"""
    now = _validate_options(opts)
    with open_client(opts) as (client, _budget):
        _snapshot, item = _resolve(opts, client, now)
    end = opts.to_ms if opts.to_ms is not None else now
    return plan_estimate(item.symbol, item.onboard_date, end, opts.weight_budget)


def run_sync(opts: SyncOptions) -> dict[str, object]:
    """一轮完整同步，返回 ``SyncRunSummary``（TS 侧 ``market-sync.ts``）。"""
    now = _validate_options(opts)
    with open_writer(opts, now) as (writer, budget, lock):
        client = _build_client(opts, budget)
        # 抢锁会先建出 sync_state 行；标的校验失败时把它清掉，不给拼错的标的留幽灵状态行。
        try:
            snapshot, item = _resolve(opts, client, now)
        except BaseException:
            _discard_ghost_state(writer, opts, lock)
            raise
        before = pg.read_state(writer, opts.exchange, item.symbol)
        # AC-21：在任何写入之前抓下水位快照。分批写入会把被篡改的缓存用 max(time) 覆盖掉，
        # 轮末再比就看不到分叉了（「静默二选一」，R-19.6）。
        # 本轮刚建行时缓存必然是 NULL，而库里可能已有 CLI 拉好的数据——那是「未初始化」不是分叉。
        entry_watermark = (
            (None, None) if lock.created else _capture_watermark(writer, opts.exchange, item.symbol)
        )
        # R-21.3：error 只能由控制面显式 resume 恢复，本轮开始时不得顺手清掉。
        stuck_at_entry = before is not None and before.get("status") == "error"
        with writer.transaction():
            pg.upsert_contract_spec(
                writer,
                opts.exchange,
                item.symbol,
                item.contract_type,
                item.status,
                item.onboard_date,
                dict(item.raw),
                now,
            )
            pg.update_state(
                writer,
                opts.exchange,
                item.symbol,
                now_ms=now,
                status="error" if stuck_at_entry else "running",
                last_run_at=now,
            )

        # c. 优先回补已登记缺口，再拉增量（R-11.B6）。
        intervals = resolve_aggregate_intervals(opts)
        gaps_filled = 0
        gaps_abandoned = 0
        attempted: frozenset[int] = frozenset()
        aggregated: dict[str, agg.IntervalAggregate] = {
            interval: agg.IntervalAggregate(interval=interval) for interval in intervals
        }
        # 指标统计（v0.3.0 R-11.3）。`None` 表示**未启用指标**（indicatorSpecs = {}），
        # 与「启用了但一行没写」（空数组）必须能分开说（R-11.4 / AC-23）——
        # 显示 0 行会让人以为「还没算」，于是反复点重建。
        specs = resolve_indicator_specs(opts)
        indicators: dict[str, dict[str, ind.IndicatorStat]] | None = (
            {i: ind.all_stats(specs, i) for i in resolve_indicator_intervals(opts)}
            if specs
            else None
        )
        if opts.allow_backfill:
            (
                gaps_filled,
                gaps_abandoned,
                attempted_set,
                gap_stats,
                gap_indicators,
            ) = _backfill_registered_gaps(client, writer, opts, now)
            attempted = frozenset(attempted_set)
            _merge_aggregated(aggregated, gap_stats)
            if indicators is not None:
                _merge_by_interval(indicators, gap_indicators)

        # d. 由起点决定写入策略（R-9.3）——本需求最关键的一条规则。
        stored_max = pg.max_time(writer, item.symbol)
        first_pull = stored_max is None
        start_ms, strategy = _resolve_start(opts, item, stored_max, now)
        estimate: dict[str, object] | None = None
        if first_pull:
            estimate = plan_estimate(
                item.symbol,
                start_ms,
                opts.to_ms if opts.to_ms is not None else now,
                opts.weight_budget,
            )
            log(
                f"first full pull plan: {estimate['requests']} requests / "
                f"{estimate['weight']} weight / ~{estimate['estimatedMs']}ms"
            )
            # R-8.3 / R-8.6：规模必须**落库**，由 `sync status` 暴露。
            # 只放进一次性返回值和日志的话，常驻侧（控制面只读库）既看不到
            # 「要拉多少」这个决策依据，也拿不到进度的分母。
            with writer.transaction():
                pg.update_state(
                    writer,
                    opts.exchange,
                    item.symbol,
                    now_ms=now,
                    **_plan_fields(estimate, now),
                )

        # e–h. 边拉边写：每批一个事务，提交后才推进水位（R-3.2 / AC-6）。
        # 边界校验在每批内执行，与「全量校验后再写」等价（R-9.4）。
        # 派生聚合与每批 1m 同事务（R-4.2）。
        added, pull_observation, stream_stats, stream_indicators = _stream_pull_and_write(
            writer, opts, client, start_ms, opts.to_ms, strategy, now
        )
        _merge_aggregated(aggregated, stream_stats)
        if indicators is not None:
            _merge_by_interval(indicators, stream_indicators)

        # i. 最后一根自愈校验（R-10.3）。判据优先用「本轮拉取看到的交易所当前那根 bar」，
        # 与本地时钟无关；退回本地时钟时也必须现读——用轮首的 now 会把本轮刚写入的、
        # 已经收盘的 bar 误判成未收盘（长轮次必然命中，见 _round_clock）。
        _assert_last_bar_closed(writer, item.symbol, pull_observation, _round_clock(opts, now))

        # j. 增量缺口检测。
        gaps_pending, _verified = _detect_and_register_gaps(writer, opts, now)

        # j'. **本轮**就把刚发现的缺口补回来（AC-7：「删掉若干行 → 下一轮 data sync
        # 自动把缺口补回，gaps 表记录被清除」）。
        # 只靠轮首那一遍是不够的：缺口是在轮末检测出来的，若留到下一轮才补，
        # 操作者要跑两轮才看得到修复，且中间那轮 gaps 表一直挂着记录。
        # skip=attempted 保证同一个缺口一轮只计一次 attempts，maxGapAttempts 语义不变（R-11.B9）。
        if opts.allow_backfill and gaps_pending > 0:
            (
                filled_now,
                abandoned_now,
                _attempted,
                round_stats,
                round_indicators,
            ) = _backfill_registered_gaps(client, writer, opts, now, skip=attempted)
            gaps_filled += filled_now
            gaps_abandoned += abandoned_now
            _merge_aggregated(aggregated, round_stats)
            if indicators is not None:
                _merge_by_interval(indicators, round_indicators)
            # 补完重新检测：让 gapsPending / verified_upto 反映真实终态。
            gaps_pending, _verified = _detect_and_register_gaps(writer, opts, now)

        watermark = pg.max_time(writer, item.symbol)
        # 先用入口快照判定：中途的写入可能已经把不一致「顺手修好」，
        # 但那正是必须报出来的分叉，不能让它消失。
        _assert_watermark_snapshot(item.symbol, *entry_watermark)
        _assert_watermark_consistent(writer, opts.exchange, item.symbol)
        state = pg.read_state(writer, opts.exchange, item.symbol)
        # R-21.3：error 只能由控制面显式恢复，本轮成功不自动清 error。
        stuck = state is not None and state.get("status") == "error"
        # 首次全量已跑完：计划列不再有意义（继续显示会让「目标 4,074 / 已入库 4,073」
        # 读成「没跑完」），清空即可——`rows` 本身就是权威行数。
        # 中途失败时不会走到这里，计划保留，进度分母仍然可查（R-8.6）。
        plan_patch: dict[str, object] = dict.fromkeys(_PLAN_COLUMNS) if first_pull else {}
        with writer.transaction():
            pg.update_state(
                writer,
                opts.exchange,
                item.symbol,
                now_ms=now,
                status="error" if stuck else "running",
                watermark=watermark,
                rows=pg.count_rows(writer, item.symbol),
                pending_gaps=gaps_pending,
                last_success_at=now,
                **plan_patch,
            )
        summary: dict[str, object] = {
            "symbol": item.symbol,
            "added": added,
            "from": start_ms,
            "to": watermark,
            "writeStrategy": strategy,
            "watermark": watermark,
            "gapsFilled": gaps_filled,
            "gapsPending": gaps_pending,
            "gapsAbandoned": gaps_abandoned,
            "requests": client.requests,
            "weight": client.weight,
            "metadataStale": snapshot.stale,
            # v0.2.0 R-8.3：`None` 表示**未启用派生**（`aggregateIntervals: []`），
            # 与「启用了但一个桶都没写」（`{}`）是两种状态，控制面必须能分开说（AC-22）。
            "aggregated": ({k: v.to_dict() for k, v in aggregated.items()} if intervals else None),
            # v0.3.0 R-11.3：指标物化统计。`None` = 未启用指标层（显式配置，不是静默跳过）。
            "indicators": (
                {iv: ind.stats_payload(st, specs) for iv, st in indicators.items()}
                if indicators is not None
                else None
            ),
            "implVersion": INDICATOR_IMPL_VERSION,
        }
        if estimate is not None:
            summary["estimate"] = estimate
        return summary


def _resolve_start(
    opts: SyncOptions,
    item: ExchangeSymbol,
    stored_max: int | None,
    now: int,
) -> tuple[int, str]:
    """返回 ``(起点, 写入策略)``（R-9.3）。

    - 无历史 → 从运行时 ``onboardDate`` 全量，**不提供缩短首次范围的开关**（R-8.2）；
    - 有历史且未给 ``--from`` → 起点 = ``max(time)``（**不加 60_000**，让最后一根被重拉覆盖），
      策略 ``upsert``；
    - 给了 ``--from`` 且早于 ``max(time)`` → 策略退化为 ``do-nothing``，绝不改写已有历史。
    """
    if stored_max is None:
        if opts.from_ms is not None:
            log(
                f"first pull ignores --from={opts.from_ms}: "
                f"首次必须从 onboardDate={item.onboard_date} 全量（R-8.2）"
            )
        return align_bar_start(item.onboard_date), "upsert"
    if opts.from_ms is None:
        return stored_max, "upsert"
    if opts.from_ms < stored_max:
        return opts.from_ms, "do-nothing"
    return opts.from_ms, "upsert"


def run_backfill(opts: SyncOptions) -> dict[str, object]:
    """``backfill`` 命令：显式区间补数，恒为 ``do-nothing``，可重复执行（AC-5 / R-15）。"""
    now = _validate_options(opts, require_range=True)
    assert opts.from_ms is not None and opts.to_ms is not None  # require_range 已校验
    with open_writer(opts, now) as (writer, budget, lock):
        client = _build_client(opts, budget)
        # 入口水位快照（AC-21 / R-19.6）。backfill 收尾同样会把 `sync_state.watermark`
        # 覆盖成 `max(time)`；若不先判定，漂移的缓存会被**静默抹平**——
        # 「数据已入库但水位没推进」这类分叉就再也看不见了。判定放在写入前，与 run_sync 一致。
        entry_watermark = (
            (None, None) if lock.created else _capture_watermark(writer, opts.exchange, opts.symbol)
        )
        # 运行时元数据校验（R-7.2 / AC-13）：与 sync 一致。否则未知标的只会被交易所
        # 回一个 HTTP 400 `-1121 Invalid symbol.`，被包成 EXCHANGE_ERROR——
        # 而 CLI 承诺未知标的给出 SYMBOL_NOT_FOUND。
        try:
            _resolve(opts, client, now)
        except BaseException:
            _discard_ghost_state(writer, opts, lock)
            raise
        # 同样是边拉边写：`data backfill --from --to` 的区间完全可能横跨整个历史，
        # 先攒完再写会把内存吃满，且中断后水位不推进（与 AC-6 冲突）。
        # 限区间请求的收盘判据在拉取时就按现读时钟执行了（`_keep_closed`），
        # R-10.3 的收尾校验只属于 `run_sync`，这里不需要那个观测。
        # backfill 也是 1m 写入路径，因此**必须**触发聚合（R-4.1 / AC-6）。
        specs = resolve_indicator_specs(opts)
        added, _observation, aggregated, indicators = _stream_pull_and_write(
            writer, opts, client, opts.from_ms, opts.to_ms, "do-nothing", now
        )
        # 分母必须按**对齐到 1m 开盘时刻**的行数算，否则未对齐入参会高估（R-11.B12）。
        expected = _aligned_bar_count(opts.from_ms, opts.to_ms)
        present = pg.count_rows_between(writer, opts.symbol, opts.from_ms, opts.to_ms)
        with writer.transaction():
            if present >= expected:
                pg.delete_gaps_in_range(writer, opts.symbol, opts.from_ms, opts.to_ms)
            gaps_pending, _verified = _detect_and_register_gaps(writer, opts, now)
            watermark = pg.max_time(writer, opts.symbol)
            pg.update_state(
                writer,
                opts.exchange,
                opts.symbol,
                now_ms=now,
                watermark=watermark,
                pending_gaps=gaps_pending,
                last_success_at=now,
            )
        # 先用入口快照判定：中途的写入会顺手把缓存修成 max(time)，
        # 而那正是必须报出来的分叉（R-19.6），不能让它消失。
        _assert_watermark_snapshot(opts.symbol, *entry_watermark)
        _assert_watermark_consistent(writer, opts.exchange, opts.symbol)
        return {
            "symbol": opts.symbol,
            "added": added,
            "from": opts.from_ms,
            "to": opts.to_ms,
            "writeStrategy": "do-nothing",
            "watermark": watermark,
            "presentRows": present,
            "expectedRows": expected,
            "gapsPending": gaps_pending,
            "requests": client.requests,
            "weight": client.weight,
            "aggregated": ({k: v.to_dict() for k, v in aggregated.items()} if aggregated else None),
            # backfill 也是 1m 写入路径，因此**必须**触发指标物化（R-5.2 / AC-6）。
            # 与 sync 同一个形状：`{周期: {参数集标签: {...}}}`。
            "indicators": (
                {iv: ind.stats_payload(st, specs) for iv, st in indicators.items()}
                if indicators
                else None
            ),
            "implVersion": INDICATOR_IMPL_VERSION,
        }


def run_aggregate(
    opts: SyncOptions, *, rebuild: bool = False, check: bool = False
) -> dict[str, object]:
    """``aggregate`` 命令（v0.2.0 R-5）：补齐 / ``--rebuild`` / ``--check``。

    - **补齐（缺省）**：区间内全部合格桶 UPSERT，**不删**任何已有桶；区间缺省 ``[F, L]``；
    - ``--rebuild``：同一区间先删后算，修复「1m 被改动 / 派生被篡改」；
    - ``--check``：**只读**校验，报出 stale / missing / mismatch，任一不一致即抛
      ``AGGREGATION_MISMATCH``（退出码非 0 由 CLI 决定）。

    与 ``verify`` 的分工：``verify`` 重建 1m 的 ``verified_upto`` 基线，``check`` 只报告
    派生一致性、**不写库**（R-5.1）。

    **不进交易所、不改 ``sync_state`` 的水位与 rows**（R-5.4）：只读 1m、只写派生表。
    单写者锁与 :class:`pg.SymbolLock` 同键（R-5.5），但**不建** ``sync_state`` 行——
    否则「库里已有数据、只是没进集合」的标的会因跑一次重建就多出一行幽灵状态。
    """
    now = _validate_options(opts)
    if rebuild and check:
        # 两个动作语义互斥：--check 是只读的，同时给会让「既删又校验」变成无法解释的组合。
        raise SyncError("CONFIG_INVALID", "--rebuild 与 --check 不能同时使用", {})

    intervals = resolve_aggregate_intervals(opts)
    if not intervals:
        # 显式关闭派生时，`data aggregate` 不该假装成功而什么都不说（R-9.2 / AC-22）。
        raise SyncError(
            "CONFIG_INVALID",
            "未启用派生（aggregateIntervals 为空），无可聚合的周期",
            {"intervals": []},
        )
    if opts.aggregate_batch_bars <= 0:
        raise SyncError(
            "CONFIG_INVALID",
            "--aggregate-batch-bars 必须为正整数",
            {"aggregateBatchBars": opts.aggregate_batch_bars},
        )

    dsn = opts.dsn
    writer = pg.connect(dsn)
    started = time.monotonic()
    try:
        pg.ensure_schema(writer)
        bounds = agg.read_bounds(writer, opts.symbol)
        if bounds is None:
            # 与 verify 同口径：库里没有该标的的任何数据 → SYMBOL_NOT_FOUND，
            # 而不是「成功但写了 0 个桶」（R-14 禁止只报成功）。
            raise SyncError(
                "SYMBOL_NOT_FOUND",
                f"库内没有该标的的任何数据: {opts.symbol}",
                {"symbol": opts.symbol},
            )
        start_ms = opts.from_ms if opts.from_ms is not None else bounds.first_ms
        end_ms = opts.to_ms if opts.to_ms is not None else bounds.last_ms
        if end_ms < start_ms:
            raise SyncError(
                "CONFIG_INVALID", "--to 不能早于 --from", {"from": start_ms, "to": end_ms}
            )

        # 单写者：与 SymbolLock 同一个锁键，抢不到立刻 SYNC_ALREADY_RUNNING（R-5.5）。
        lock = pg.SymbolLock.acquire(dsn, opts.exchange, opts.symbol, now, create_state_row=False)
        try:
            if check:
                problems = agg.check_intervals(writer, opts.symbol, intervals, start_ms, end_ms)
                agg.raise_on_mismatch(opts.symbol, problems)
                return {
                    "symbol": opts.symbol,
                    "from": start_ms,
                    "to": end_ms,
                    "rebuild": False,
                    "check": True,
                    # `withheld_counts` 的键名就是契约（withheldNotClosed / …），
                    # 与补齐路径**同一个形状**——否则 `data aggregate --check` 的
                    # 打印会在 undefined 上崩掉（R-5.6 / R-8.3）。
                    "intervals": {
                        interval: agg.withheld_counts(
                            writer, opts.symbol, interval, start_ms, end_ms
                        )
                        | {"upserted": 0}
                        for interval in intervals
                    },
                    "durationMs": int((time.monotonic() - started) * 1000),
                }

            totals: dict[str, agg.IntervalAggregate] = _aggregate_batched(
                writer,
                opts.symbol,
                intervals,
                start_ms,
                end_ms,
                opts.aggregate_batch_bars,
                rebuild=rebuild,
            )
            return {
                "symbol": opts.symbol,
                "from": start_ms,
                "to": end_ms,
                "rebuild": rebuild,
                "check": False,
                # 键序固定（短 → 长），连续两次补齐的 JSON 因此逐字节相同（R-5.7）
                "intervals": {k: v.to_dict() for k, v in totals.items()},
                "durationMs": int((time.monotonic() - started) * 1000),
            }
        finally:
            lock.release()
    finally:
        writer.close()


def _aggregate_batched(
    writer: DbConn,
    symbol: str,
    intervals: Sequence[str],
    start_ms: int,
    end_ms: int,
    batch_bars: int,
    *,
    rebuild: bool,
) -> dict[str, agg.IntervalAggregate]:
    """按 1m 根数分批、每批一个事务地聚合区间（R-5.3）。

    绝不把整段历史一次聚合：一次全量的 15m 桶可达数十万，单事务的锁持有时间与 WAL
    体积都不可接受。批边界按 **1m 根数**推进而不是按时间推进——用时间会让数据稀疏的
    标的（大量缺口）永远达不到批大小，从而死循环。

    每批把**全部周期**一起处理：它们读的是同一批 1m 行，分开做等于把最贵的查询重复
    四遍（见 :func:`quant_data.aggregate.aggregate_batches`）。批推进按**最宽的周期**
    对齐：窄周期的桶因此会被相邻两批各算一次，而重复重算是幂等的（R-4.2）。
    """
    if not intervals:
        return {}
    widest_width = max(agg.interval_width(i) for i in intervals)
    totals: dict[str, agg.IntervalAggregate] = {
        interval: agg.IntervalAggregate(interval=interval) for interval in intervals
    }
    cursor = start_ms
    while cursor <= end_ms:
        batch_end = min(cursor + batch_bars * ONE_MINUTE_MS - 1, end_ms)
        with writer.transaction():
            batch = agg.aggregate_batches(
                writer, symbol, list(intervals), cursor, batch_end, rebuild=rebuild
            )
        for interval, item in batch.items():
            target = totals[interval]
            target.upserted += item.upserted
            target.withheld_not_closed += item.withheld_not_closed
            target.withheld_incomplete += item.withheld_incomplete
            target.missing_minutes += item.missing_minutes
        # 批可能落在桶中间：必须把游标推到**下一个桶起点**，否则同一批尾桶会被
        # 下一批重算，`upserted` 因而不幂等（AC-9 / R-5.7）。
        next_cursor = (
            agg.ceil_to_bucket(batch_end, widest_width) if batch_end < end_ms else end_ms + 1
        )
        if next_cursor <= cursor:  # pragma: no cover - 防御 batch_bars 过小导致不推进
            raise SyncError(
                "CONFIG_INVALID",
                "aggregateBatchBars 过小，无法按桶推进",
                {"aggregateBatchBars": batch_bars, "intervals": list(intervals)},
            )
        cursor = next_cursor
    return totals


def run_indicators(
    opts: SyncOptions, *, rebuild: bool = False, check: bool = False
) -> dict[str, object]:
    """``indicators`` 命令（v0.3.0 R-6）：补齐 / ``--rebuild`` / ``--check``。

    语义与 ``aggregate`` 同形（R-6.1），便于记忆：
      * **补齐（缺省）**：区间内全部合格行 UPSERT，**不删**任何已有行；区间缺省该标的全量；
      * ``--rebuild``：同一区间**先删后算**，修复「K 线被改动 / 指标被篡改 /
        ``impl_version`` 已递增」；
      * ``--check``：**只读**校验，报 stale / missing / mismatch / 混版，任一不一致即抛
        ``INDICATOR_MISMATCH``（退出码非 0 由 CLI 决定）。

    **不进交易所、不改 ``sync_state`` 的水位与 rows**（R-6.4）：只读派生 K 线、只写指标表。
    单写者锁与 :class:`pg.SymbolLock` 同键（R-6.5），但**不建** ``sync_state`` 行——
    否则「库里已有数据、只是没进集合」的标的会因跑一次重建就多出一行幽灵状态。
    """
    now = _validate_options(opts)
    if rebuild and check:
        raise SyncError("CONFIG_INVALID", "--rebuild 与 --check 不能同时使用", {})

    intervals = resolve_indicator_intervals(opts)
    specs = resolve_indicator_specs(opts)
    if not specs:
        # 显式关闭指标层时，`data indicators` 不该假装成功而什么都不说（R-12.2 / AC-23）。
        raise SyncError(
            "CONFIG_INVALID",
            "未启用指标（indicatorSpecs 为空），无可物化的参数集",
            {"indicatorSpecs": []},
        )
    if not intervals:
        raise SyncError(
            "CONFIG_INVALID",
            "未启用指标周期（indicatorIntervals 为空）",
            {"indicatorIntervals": []},
        )
    if opts.indicator_batch_bars <= 0:
        raise SyncError(
            "CONFIG_INVALID",
            "--indicator-batch-bars 必须为正整数",
            {"indicatorBatchBars": opts.indicator_batch_bars},
        )

    dsn = opts.dsn
    writer = pg.connect(dsn)
    started = time.monotonic()
    try:
        pg.ensure_schema(writer)
        bounds = agg.read_bounds(writer, opts.symbol)
        if bounds is None:
            # 与 verify / aggregate 同口径：库里没有该标的的任何数据 → SYMBOL_NOT_FOUND，
            # 而不是「成功但写了 0 行」（R-14 禁止只报成功）。
            raise SyncError(
                "SYMBOL_NOT_FOUND",
                f"库内没有该标的的任何数据: {opts.symbol}",
                {"symbol": opts.symbol},
            )
        start_ms = opts.from_ms if opts.from_ms is not None else bounds.first_ms
        end_ms = opts.to_ms if opts.to_ms is not None else bounds.last_ms
        if end_ms < start_ms:
            raise SyncError(
                "CONFIG_INVALID", "--to 不能早于 --from", {"from": start_ms, "to": end_ms}
            )

        lock = pg.SymbolLock.acquire(dsn, opts.exchange, opts.symbol, now, create_state_row=False)
        try:
            if check:
                problems: list[ind.IndicatorProblem] = []
                for interval in intervals:
                    problems.extend(
                        ind.check_interval(writer, opts.symbol, interval, specs, start_ms, end_ms)
                    )
                ind.raise_on_mismatch(opts.symbol, problems)
                # 与补齐路径**同一个形状**：键名与 `IndicatorStat.to_dict()` 逐字段一致，
                # 否则 `data indicators --check` 的打印会在 undefined 上崩掉（R-6.6）。
                return {
                    "symbol": opts.symbol,
                    "from": start_ms,
                    "to": end_ms,
                    "rebuild": False,
                    "check": True,
                    "indicators": _indicators_payload(specs, _zero_stats(specs), intervals),
                    "implVersion": INDICATOR_IMPL_VERSION,
                    "durationMs": int((time.monotonic() - started) * 1000),
                }

            totals = _indicators_batched(
                writer,
                opts.symbol,
                intervals,
                specs,
                start_ms,
                end_ms,
                opts.indicator_batch_bars,
                rebuild=rebuild,
            )
            return {
                "symbol": opts.symbol,
                "from": start_ms,
                "to": end_ms,
                "rebuild": rebuild,
                "check": False,
                # 键序固定 → 连续两次补齐的 JSON 逐字节相同（R-6.7）
                "indicators": _indicators_payload(specs, totals, intervals),
                "implVersion": INDICATOR_IMPL_VERSION,
                "durationMs": int((time.monotonic() - started) * 1000),
            }
        finally:
            lock.release()
    finally:
        writer.close()


def _zero_stats(specs: Sequence[ind.ParamSet]) -> dict[str, ind.IndicatorStat]:
    return ind.all_stats(specs, ind.ALLOWED_INDICATOR_INTERVALS[0])


def _indicators_payload(
    specs: Sequence[ind.ParamSet],
    stats: Mapping[str, ind.IndicatorStat],
    intervals: Sequence[str],
) -> dict[str, object]:
    """按 ``specs`` 的固定次序铺开 ``{interval: {spec: {...}}}``，缺项补零。

    铺开而不是直接吐 ``stats`` 的键：键里混了周期名，直接吐会让「某参数集本轮完全没触及」
    变成「从摘要里消失」，看起来像没启用（R-6.6：不许只报成功）。
    """
    payload: dict[str, object] = {}
    for interval in intervals:
        block: dict[str, object] = {}
        for spec in specs:
            key = f"{spec.indicator}:{json.dumps(spec.params_dict(), sort_keys=True)}"
            stat = stats.get(key)
            block[spec.label()] = (
                stat.to_dict()
                if stat is not None
                else {
                    "indicator": spec.indicator,
                    "params": spec.params_dict(),
                    "upserted": 0,
                    "withheldWarmup": 0,
                }
            )
        payload[interval] = block
    return payload


def _indicators_batched(
    writer: DbConn,
    symbol: str,
    intervals: Sequence[str],
    specs: Sequence[ind.ParamSet],
    start_ms: int,
    end_ms: int,
    batch_bars: int,
    *,
    rebuild: bool,
) -> dict[str, ind.IndicatorStat]:
    """按**派生 bar 数**分批、每批一个事务地物化区间（R-6.3）。

    绝不把整段历史一次物化：15m 全历史可达数十万行，单事务的锁持有时间与 WAL 体积
    都不可接受（与 ``_aggregate_batched`` 同理）。

    **批边界必须落在连续段的边界上**——这一点与派生聚合**不一样**，不能照抄它的做法。
    派生聚合按「最宽的周期」对齐批边界是安全的，因为一个桶的值只取决于它自己那几根
    1m；指标则不同：**一个连续段被从中间切成两半后，两半各自的「段首」不同**，
    于是预热期起点、递推种子、乃至浮点累加的原点全都变了——同��根 bar 的指标值
    会与整段重算差最后几位（实测 15m 全库出现 156 万处 ``mismatch``）。

    因此这里每批先读一个探测窗口，切段后**只写完整的段**；末尾那一段若延伸出窗口，
    就把它整体推迟到下一批（下一批从它的**段首**重新读）。代价是每批多读一段，
    换来的是「分批结果与整段重算逐值相同」——而这正是 ``--check`` 的判据。
    """
    if not intervals or not specs:
        return {}
    totals: dict[str, ind.IndicatorStat] = {}
    for interval in intervals:
        width = agg.interval_width(interval)
        cursor = start_ms
        while cursor <= end_ms:
            probe_end = min(cursor + batch_bars * width - 1, end_ms)
            with writer.transaction():
                batch_stats, next_cursor = _materialize_one_batch(
                    writer,
                    symbol,
                    interval,
                    specs,
                    cursor,
                    probe_end,
                    rebuild=rebuild and cursor == start_ms,
                )
            ind.merge_stats(totals, batch_stats)
            if next_cursor <= cursor:  # pragma: no cover - 防御 batch_bars 过小导致不推进
                raise SyncError(
                    "CONFIG_INVALID",
                    "indicatorBatchBars 过小，无法按 bar 推进",
                    {"indicatorBatchBars": batch_bars, "intervals": list(intervals)},
                )
            cursor = next_cursor
    return totals


def _materialize_one_batch(
    writer: DbConn,
    symbol: str,
    interval: str,
    specs: Sequence[ind.ParamSet],
    cursor: int,
    probe_end: int,
    *,
    rebuild: bool,
) -> tuple[dict[str, ind.IndicatorStat], int]:
    """一批 = 若干**完整**的连续段。返回 ``(统计, 下一批起点)``。

    段没有被切断的做法是「把探测窗口延长到该段结束」，**不是**「留到下一批再算」——
    后者会把游标退回全局段首，于是同一段被反复重读重算，永远推不动。

    窗口按倍数外扩直到末段不再顶在窗口末尾（或已经读到数据末尾）。段通常远小于
    窗口，因此实际只多读一次；跨段的罕见数据才会多扩几轮。
    """
    stats: dict[str, ind.IndicatorStat] = {}
    width = agg.interval_width(interval)
    data_end = _derived_end(writer, symbol, interval)
    probe = probe_end
    times: list[int] = []
    series = ind.empty_series()
    segments: list[ind.Segment] = []
    while True:
        times, series = ind.read_derived_bars(writer, symbol, interval, cursor, probe)
        if not times:
            return stats, probe + 1
        segments = ind.split_segments(times, width)
        last = segments[-1]
        # 末段顶在窗口最后一根桶上、且窗口还没到数据末尾 → 它可能还没走完
        if last.end_ms < probe - width + 1 or probe >= data_end:
            next_cursor = times[-1] + width
            break
        probe = min(cursor + (probe - cursor) * 2 + width, max(data_end, probe))

    if not segments:
        return stats, next_cursor
    if rebuild:
        ind.delete_range(writer, symbol, interval, specs, segments[0].start_ms, segments[-1].end_ms)
    ind.write_specs(writer, symbol, interval, specs, times, series, segments, stats)
    return stats, next_cursor


def _derived_end(writer: DbConn, symbol: str, interval: str) -> int:
    """该标的该周期派生表的最后一根 bar 起点（没有则返回 0）。"""
    table = agg.DERIVED_TABLES[interval]
    row = writer.execute(
        f"SELECT max(time) AS t FROM {table} WHERE symbol = %s", (symbol,)
    ).fetchone()
    value = row["t"] if row is not None else None
    return int(value) if value is not None else 0


def _next_indicator_cursor(
    writer: DbConn,
    symbol: str,
    interval: str,
    cursor: int,
    probe_end: int,
    end_ms: int,
    width: int,
) -> int:
    """下一批的起点：落在**段边界**上，因此绝不从一段中间接着算。"""
    if probe_end >= end_ms:
        return end_ms + 1
    times, _series = ind.read_derived_bars(writer, symbol, interval, cursor, probe_end)
    if not times:
        return probe_end + 1
    segments = ind.split_segments(times, width)
    last = segments[-1]
    # 末段走完了整个窗口且窗口不是数据末尾 → 它可能还没结束，从**它的段首**重来
    if last.end_ms == times[-1] and last.end_ms >= probe_end - width + 1:
        return last.start_ms + width
    return times[-1] + width


def run_verify(opts: SyncOptions) -> dict[str, object]:
    """``verify`` 命令：全表缺口扫描并重建 ``verified_upto`` 基线（R-11.A3 ②）。"""
    now = _validate_options(opts)
    dsn = opts.dsn
    writer = pg.connect(dsn)
    try:
        # 先过 schema 闸门，再抢锁：``SymbolLock.acquire`` 第一条语句就是往 sync_state
        # 插入，未迁移的库会在这里抛 UndefinedTable 并被兜底成 INTERNAL_ERROR，
        # 掩盖掉真正的 SCHEMA_VERSION_MISMATCH（与 ``open_writer`` 的顺序保持一致）。
        pg.ensure_schema(writer)
        # 存在性判定放在**抢锁之前**：抢锁会 `INSERT` 建行，对一个拼错的标的
        # `data verify --symbol <typo>` 会留下幽灵 `sync_state` 行。
        latest = pg.max_time(writer, opts.symbol)
        if latest is None:
            raise SyncError(
                "SYMBOL_NOT_FOUND",
                f"库内没有该标的的任何数据: {opts.symbol}",
                {"symbol": opts.symbol},
            )
        lock = pg.SymbolLock.acquire(dsn, opts.exchange, opts.symbol, now)
        try:
            gaps = pg.detect_gaps(writer, opts.symbol, pg.PG_MIN_TIME, latest)
            scanned = pg.count_rows(writer, opts.symbol)
            with writer.transaction():
                pg.insert_gaps(writer, opts.exchange, opts.symbol, gaps)
                verified = gaps[0].gap_start - ONE_MINUTE_MS if gaps else latest
                pg.update_state(
                    writer,
                    opts.exchange,
                    opts.symbol,
                    now_ms=now,
                    verified_upto=verified,
                    pending_gaps=pg.count_gaps(writer, opts.symbol),
                )
            return {
                "symbol": opts.symbol,
                "scannedRows": scanned,
                "gapsFound": len(gaps),
                "verifiedUpTo": verified,
            }
        finally:
            lock.release()
    finally:
        writer.close()
