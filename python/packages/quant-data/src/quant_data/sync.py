"""同步编排：首次全量、增量续传、缺口回补与校验。

一轮 ``sync`` 的固定顺序（对应需求）：
a. 单写者锁（``pg.SymbolLock``）→ b. 元数据解析与校验 → c. **优先回补已登记缺口**（R-11.B6）
→ d. 由起点决定写入策略（R-9.3）→ e/f. 分页拉取、去重、边界校验 → g. 丢弃最后一根（R-10.1）
→ h. 分批 ``COPY`` 写入并同事务推进水位（R-3.2 / R-19.5）→ i. 最后一根自愈校验（R-10.3）
→ j. 增量缺口检测（R-11.A）→ k. 全局权重预算（R-20）→ l. NOT NULL 语义（R-4）。
"""

from __future__ import annotations

import math
import os
import time
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from quant_core.io import log

from . import pg
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

#: 缺口自动回补的默认尝试上限（R-11.B9）。
DEFAULT_MAX_GAP_ATTEMPTS = 5

#: 缺口检测的**回看窗口**：每轮除了 ``[verified_upto, max(time)]``，还多扫最近这么多毫秒。
#:
#: 为什么需要它：R-11.A.2 写的是「只扫 ``[verified_upto, max(time)]``」，而 AC-7 要求
#: 「人为在库里删掉中间几行 → **下一轮**自动补回」。两者字面上互斥——一轮干净同步之后
#: ``verified_upto == max(time)``，此时删中间行不改变 ``max(time)``，扫描区间塌缩成单点，
#: 中间的洞永远看不见。R-11 自己的目标是「**保证检测成本不随数据量线性增长**」，
#: 字面区间只是表达该目标的一种方式；AC-7 才是可验收的具体标准。
#: 因此扫描区间取 ``[min(verified_upto, max(time) - lookback), max(time)]``：
#: 每轮固定多扫最近 7 天（1m 约 10,080 行/标的），成本有界、且只走 (symbol,time) 的
#: BRIN 索引，仍然**不是**每轮全表扫描（R-11.A.2 的真实目标得以保留）。
DEFAULT_GAP_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000

#: 单行体积估算（附录 C.2：行存 ~100 字节/行，含索引项）。``sync_state.bytes`` 是可观测缓存，
#: 用估算值推进；权威行数始终是 ``klines_1m`` 的实际行数。
ESTIMATED_BYTES_PER_ROW = 100


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
        budget = WeightBudget(conn, opts.weight_budget)
        yield _build_client(opts, budget), budget
    finally:
        conn.close()


@contextmanager
def open_writer(opts: SyncOptions, now: int) -> Iterator[tuple[DbConn, WeightBudget]]:
    """需要写库的命令：单写者锁 + 写连接 + 配额桶。"""
    dsn = opts.dsn
    writer = pg.connect(dsn)
    try:
        # 先校验 schema 再抢锁：未迁移的库应报 SCHEMA_VERSION_MISMATCH 而不是 SQL 错误（R-19.7）。
        pg.ensure_schema(writer)
        lock = pg.SymbolLock.acquire(dsn, opts.exchange, opts.symbol, now)
        budget_conn = pg.connect(dsn)
        try:
            yield writer, WeightBudget(budget_conn, opts.weight_budget)
        finally:
            budget_conn.close()
            lock.release()
    finally:
        writer.close()


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
    """丢掉所有尚未收盘的 bar（``closeTime > now``），其余全部保留。"""
    return [row for row in page if row.close_time <= now]


def _iter_pull(
    client: BinanceClient,
    symbol: str,
    start_ms: int,
    end_ms: int | None,
    now: int,
) -> Iterator[list[Kline]]:
    """按页产出 1m bar（已按区间过滤、已去重、已丢弃未收盘末根）。

    这是个**生成器**：调用方逐批消费，内存占用是 O(单批) 而不是 O(全量)。
    首次全量约 144 万根（附录 B.1），若先把整段拉完再写，中途被中断就得整段重拉，
    R-3.2 / R-8.5 / AC-6 要求的「中断后从水位继续」就不成立。

    末位处理规则见原 ``_pull_range`` 的说明：开放式请求无条件丢弃末位（与时钟无关），
    指定 ``endTime`` 的请求只丢弃 ``closeTime > now`` 的。
    """
    seen: set[int] = set()
    cursor = start_ms
    limit = client.page_limit
    while True:
        page = client.klines(symbol, cursor, end_ms, limit)
        if not page:
            return
        kept = page[:-1] if end_ms is None else _keep_closed(page, now)
        fresh = [row for row in kept if row.time not in seen]
        seen.update(row.time for row in fresh)
        if fresh:
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
    now: int,
) -> list[Kline]:
    """把整段拉成一个列表。**只用于小范围**（单页量级）。

    首次全量与大区间必须走 :func:`_stream_pull_and_write`：把 144 万根全部攒在内存里
    再写，不仅峰值内存随数据量线性增长，而且中断后水位从未推进，重跑要整段重来。
    """
    collected: dict[int, Kline] = {}
    for fresh in _iter_pull(client, symbol, start_ms, end_ms, now):
        for row in fresh:
            collected.setdefault(row.time, row)
    return [collected[key] for key in sorted(collected)]


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
) -> int:
    """边拉边写：攒够 ``batch_size`` 就 ``COPY`` + 提交 + 推进水位，再继续拉下一页。

    这是 R-3.2 / R-8.5 / AC-6 的落点，也是与「先拉完再写」的本质区别：

    - **每批一个事务**，成功提交后才推进水位。中断后重跑从水位继续，不重头、不丢数；
    - **峰值内存是 O(batch_size)**，与数据总量无关——首次全量 144 万行不会撑爆内存；
    - 边界校验（R-9.4）按批执行，与「全量校验后再写」等价：任何一根
      ``time < startTime`` 都会在它所在的那一批抛错，此前已提交的批次保持有效。
    """
    added = 0
    known_rows: int | None = None
    buffer: list[Kline] = []

    def commit(chunk: Sequence[Kline]) -> None:
        """写入一批并在**同一事务内**推进可观测状态（R-19.5）。"""
        nonlocal added, known_rows
        _assert_within_boundary(chunk, start_ms, opts.symbol)
        with writer.transaction():
            batch_added = pg.write_bars(writer, opts.symbol, chunk, strategy)
            # 首批用一次精确 count 打底（状态可能来自旧版本或别的进程），之后按新增累加，
            # 避免每批都做一次 count(*)（首次全量 144 万行时代价不可接受）。
            if known_rows is None:
                known_rows = pg.count_rows(writer, opts.symbol) - batch_added
            known_rows = _advance_progress(writer, opts, batch_added, now, known_rows)
            added += batch_added

    for fresh in _iter_pull(client, opts.symbol, start_ms, end_ms, now):
        buffer.extend(fresh)
        while len(buffer) >= opts.batch_size:
            commit(buffer[: opts.batch_size])
            del buffer[: opts.batch_size]
    if buffer:
        commit(buffer)
    return added


def _assert_last_bar_closed(writer: DbConn, symbol: str, now: int) -> None:
    """库内最后一根必须已收盘（R-10.3）。

    增量起点含最后一根，重拉 + UPSERT 已把它覆盖；这里在写完后再校验一次，
    仍不满足就抛错——**不得静默继续**。
    """
    last = pg.last_bar_time(writer, symbol)
    if last is None:
        return
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
) -> tuple[int, int]:
    """优先回补已登记的缺口（R-11.B6）：成功则删除并推进 ``verified_upto``；失败计次。"""
    filled = 0
    abandoned = 0
    state = pg.read_state(writer, opts.exchange, opts.symbol)
    verified = state.get("verified_upto") if state is not None else None
    verified_ms = int(verified) if verified is not None else None
    for gap in pg.list_gaps(writer, opts.symbol):
        gap_start = int(gap["gap_start"])
        gap_end = int(gap["gap_end"])
        attempts = int(gap["attempts"])
        if attempts >= opts.max_gap_attempts:
            abandoned += 1
            continue
        expected = (gap_end - gap_start) // ONE_MINUTE_MS + 1
        try:
            # 缺口区间天然很小（几根到几百根），单事务内整段写完；
            # 这里刻意不走流式：删除 gap 记录与推进 verified_upto 必须在同一事务里判定（R-11.B8）。
            rows = _pull_range(client, opts.symbol, gap_start, gap_end, now)
            _assert_within_boundary(rows, gap_start, opts.symbol)
            with writer.transaction():
                # 缺口回补一律 DO NOTHING：绝不误改已存在的正确数据（R-11.B7）。
                added = pg.write_bars(writer, opts.symbol, rows, "do-nothing")
                present = pg.count_rows_between(writer, opts.symbol, gap_start, gap_end)
                if present >= expected:
                    pg.delete_gap(writer, opts.symbol, gap_start)
                    # 与 verified_upto 相邻时才推进基线（R-11.B8）。
                    if verified_ms is not None and gap_start <= verified_ms + ONE_MINUTE_MS:
                        verified_ms = gap_end
                # 状态与这批写入同事务推进（R-19.5）。
                _advance_progress(writer, opts, added, now)
            if present >= expected:
                filled += 1
            else:
                _record_gap_failure(
                    writer, opts, gap_start, attempts, f"回补不完整: {present}/{expected} 根", now
                )
        except SyncError as exc:
            _record_gap_failure(
                writer, opts, gap_start, attempts, f"{exc.code}: {exc.message}", now
            )
    return filled, abandoned


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

    扫描区间 = ``[min(verified_upto, max(time) - lookback), max(time)]``，
    并以该标的的第一根 bar 为下界（不扫描尚不存在的时间）。理由见
    ``DEFAULT_GAP_LOOKBACK_MS`` 的注释：字面的 ``[verified_upto, max(time)]`` 与 AC-7
    互斥（干净同步后两者相等，删中间行不可见），而 R-11 的真实目标是「检测成本不随数据量
    线性增长」——加一个固定回看窗口后每轮只多扫固定的行数，**仍然不是**每轮全表扫描
    （R-11.A.2 的目标得以保留，AC-32 由 ``test_gap_detection_scan_is_bounded`` 断言）。

    首次为该标的建立基线时做一次全表扫描（R-11.A3 ①）；无缺口则 ``verified_upto = max(time)``。
    ``verified_upto`` 的语义不变（「已知连续到该时刻，含」），**不会**因为回看窗口而回退。
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
        scan_start = min(verified, latest - opts.gap_lookback_ms)
        first_bar = pg.min_time(writer, opts.symbol)
        if first_bar is not None:
            scan_start = max(scan_start, first_bar)
    gaps = pg.detect_gaps(writer, opts.symbol, scan_start, latest)
    with writer.transaction():
        pg.insert_gaps(writer, opts.exchange, opts.symbol, gaps)
        # 有缺口时基线只能推进到第一个缺口之前，否则会把洞标成「已验证」。
        new_verified = gaps[0].gap_start - ONE_MINUTE_MS if gaps else latest
        if new_verified != verified:
            pg.update_state(
                writer, opts.exchange, opts.symbol, now_ms=now, verified_upto=new_verified
            )
    return pg.count_gaps(writer, opts.symbol), new_verified


def _assert_watermark_consistent(writer: DbConn, exchange: str, symbol: str) -> None:
    """``sync_state.watermark`` 只是可观测缓存；与 ``max(time)`` 不一致必须报错（AC-21）。"""
    state = pg.read_state(writer, exchange, symbol)
    if state is None:
        return
    cached = state.get("watermark")
    authoritative = pg.max_time(writer, symbol)
    if cached is None and authoritative is None:
        return
    if cached is None or authoritative is None or int(cached) != authoritative:
        raise SyncError(
            "WATERMARK_MISMATCH",
            f"sync_state.watermark 与 max(time) 不一致: {symbol}",
            {"cached": cached, "authoritative": authoritative},
        )


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
    with open_writer(opts, now) as (writer, budget):
        client = _build_client(opts, budget)
        snapshot, item = _resolve(opts, client, now)
        before = pg.read_state(writer, opts.exchange, item.symbol)
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
        gaps_filled = 0
        gaps_abandoned = 0
        if opts.allow_backfill:
            gaps_filled, gaps_abandoned = _backfill_registered_gaps(client, writer, opts, now)

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

        # e–h. 边拉边写：每批一个事务，提交后才推进水位（R-3.2 / AC-6）。
        # 边界校验在每批内执行，与「全量校验后再写」等价（R-9.4）。
        added = _stream_pull_and_write(writer, opts, client, start_ms, opts.to_ms, strategy, now)

        # i. 最后一根自愈校验。
        _assert_last_bar_closed(writer, item.symbol, now)

        # j. 增量缺口检测。
        gaps_pending, _verified = _detect_and_register_gaps(writer, opts, now)

        watermark = pg.max_time(writer, item.symbol)
        _assert_watermark_consistent(writer, opts.exchange, item.symbol)
        state = pg.read_state(writer, opts.exchange, item.symbol)
        # R-21.3：error 只能由控制面显式恢复，本轮成功不自动清 error。
        stuck = state is not None and state.get("status") == "error"
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
    with open_writer(opts, now) as (writer, budget):
        client = _build_client(opts, budget)
        # 同样是边拉边写：`data backfill --from --to` 的区间完全可能横跨整个历史，
        # 先攒完再写会把内存吃满，且中断后水位不推进（与 AC-6 冲突）。
        added = _stream_pull_and_write(
            writer, opts, client, opts.from_ms, opts.to_ms, "do-nothing", now
        )
        expected = (opts.to_ms - opts.from_ms) // ONE_MINUTE_MS + 1
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
        }


def run_verify(opts: SyncOptions) -> dict[str, object]:
    """``verify`` 命令：全表缺口扫描并重建 ``verified_upto`` 基线（R-11.A3 ②）。"""
    now = _validate_options(opts)
    dsn = opts.dsn
    lock = pg.SymbolLock.acquire(dsn, opts.exchange, opts.symbol, now)
    writer = pg.connect(dsn)
    try:
        pg.ensure_schema(writer)
        latest = pg.max_time(writer, opts.symbol)
        if latest is None:
            raise SyncError(
                "SYMBOL_NOT_FOUND",
                f"库内没有该标的的任何数据: {opts.symbol}",
                {"symbol": opts.symbol},
            )
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
        writer.close()
        lock.release()
