"""同步 / 回补 / 校验的核心测试（R-3、R-4、R-8、R-9、R-10、R-11、R-12、R-19、R-20）。"""

from __future__ import annotations

import itertools
import time
from collections.abc import Sequence
from dataclasses import replace
from pathlib import Path
from typing import cast

import psycopg
import pytest
from conftest import SQL_DIR, FakeExchange, SymbolCase, fixed_now
from quant_data import pg, sync
from quant_data.binance import KLINE_LIMIT_MAX, ONE_MINUTE_MS, Kline, align_bar_start
from quant_data.errors import SyncError
from quant_data.pg import DbConn
from quant_data.ratelimit import WINDOW_MS, WeightBudget
from quant_data.sync import (
    DEFAULT_BATCH_SIZE,
    DEFAULT_GAP_LOOKBACK_MS,
    DEFAULT_MAX_GAP_ATTEMPTS,
    ESTIMATED_BYTES_PER_ROW,
    SyncOptions,
    estimate_scale,
    run_backfill,
    run_sync,
    run_verify,
)

EXCHANGE = "binance"


def _options(
    fake: FakeExchange,
    dsn: str,
    meta_dir: Path,
    symbol: str,
    now: int | None,
    *,
    from_ms: int | None = None,
    to_ms: int | None = None,
    batch_size: int = DEFAULT_BATCH_SIZE,
    max_gap_attempts: int = DEFAULT_MAX_GAP_ATTEMPTS,
    gap_lookback_ms: int = DEFAULT_GAP_LOOKBACK_MS,
    page_limit: int = KLINE_LIMIT_MAX,
) -> SyncOptions:
    return SyncOptions(
        exchange=EXCHANGE,
        symbol=symbol,
        dsn=dsn,
        transport=fake,
        meta_dir=meta_dir,
        now_ms=now,
        from_ms=from_ms,
        to_ms=to_ms,
        batch_size=batch_size,
        max_gap_attempts=max_gap_attempts,
        gap_lookback_ms=gap_lookback_ms,
        page_limit=page_limit,
    )


def _fixed_clock(monkeypatch: pytest.MonkeyPatch, values: Sequence[int]) -> None:
    """把 ``sync.now_ms`` 换成一个按序给出固定值的时钟（用完后保持最后一个值）。

    用来表达「轮首抓一次时钟、之后每页现读一次」：单测无法让真实时间前进，
    只有把这两类读取分开喂值，才能证明判据用的是哪一个。
    """
    ticks = itertools.chain(values, itertools.repeat(values[-1]))
    monkeypatch.setattr(sync, "now_ms", lambda: next(ticks))


def _nested(summary: dict[str, object], key: str) -> dict[str, object]:
    """取出摘要里的嵌套对象。

    ``run_sync`` 返回 ``dict[str, object]``，直接下标再下标在 strict mypy 下需要
    ``type: ignore``——而 AC-27 明确要求仓库里不出现 ``type: ignore``。
    这里用一次真正的收窄代替。
    """
    value = summary[key]
    assert isinstance(value, dict), f"{key} 期望是对象，实际是 {type(value).__name__}"
    return {str(inner_key): inner for inner_key, inner in value.items()}


def _times(conn: DbConn, symbol: str) -> list[int]:
    return [
        int(row["time"])
        for row in conn.execute(
            "SELECT time FROM klines_1m WHERE symbol = %s ORDER BY time", (symbol,)
        ).fetchall()
    ]


def _close(conn: DbConn, symbol: str, time_ms: int) -> float | None:
    row = conn.execute(
        "SELECT close FROM klines_1m WHERE symbol = %s AND time = %s", (symbol, time_ms)
    ).fetchone()
    return None if row is None else float(row["close"])


# ---------------------------------------------------------------- 首次全量（R-8）


def test_first_pull_starts_from_runtime_onboard_date(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    """首次全量从**运行时** onboardDate 起算，且必须先暴露规模（AC-2 / AC-10 / R-8.2、R-8.3）。"""
    now = fixed_now(fake, symbol_case.symbol)
    summary = run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))

    assert summary["from"] == symbol_case.onboard_date
    assert summary["writeStrategy"] == "upsert"
    estimate = summary["estimate"]
    assert isinstance(estimate, dict)
    assert estimate["from"] == symbol_case.onboard_date
    assert estimate["requests"] == 1

    stored = _times(conn, symbol_case.symbol)
    # 最后一根（进行中的 bar）被丢弃，因此条数 = 可用根数 - 1。
    assert len(stored) == symbol_case.bars - 1
    assert stored[0] == symbol_case.onboard_date
    assert stored[-1] == fake.closed_through(symbol_case.symbol)
    assert summary["added"] == len(stored)
    assert summary["watermark"] == stored[-1]
    assert summary["gapsPending"] == 0


def test_first_pull_ignores_from_option(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    """首次拉取没有「缩短范围」的开关：给了 --from 也从 onboardDate 全量（R-8.2 / R-13.3）。"""
    now = fixed_now(fake, symbol_case.symbol)
    summary = run_sync(
        _options(
            fake,
            pg_dsn,
            tmp_path,
            symbol_case.symbol,
            now,
            from_ms=symbol_case.onboard_date + 600_000,
        )
    )
    assert summary["from"] == symbol_case.onboard_date
    assert len(_times(conn, symbol_case.symbol)) == symbol_case.bars - 1


def test_contract_spec_snapshot_is_persisted(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    now = fixed_now(fake, symbol_case.symbol)
    run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    row = conn.execute(
        "SELECT contract_type, status, onboard_date FROM contract_spec"
        " WHERE exchange = %s AND symbol = %s",
        (EXCHANGE, symbol_case.symbol),
    ).fetchone()
    assert row is not None
    assert row["contract_type"] == "PERPETUAL"
    assert row["status"] == "TRADING"
    assert int(row["onboard_date"]) == symbol_case.onboard_date


# ---------------------------------------------------------------- 增量续传（R-9）


def test_incremental_start_equals_max_time_without_offset(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    """起点 = max(time)，**不加 60_000**：最后一根必须被重拉并覆盖（R-9.1 / AC-3）。"""
    now = fixed_now(fake, symbol_case.symbol)
    run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    watermark = int(pg.max_time(conn, symbol_case.symbol) or 0)

    fake.advance(symbol_case.symbol, 5)
    later = now + 5 * ONE_MINUTE_MS
    summary = run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, later))

    assert summary["from"] == watermark
    assert fake.kline_calls[-1]["start"] == watermark
    assert summary["writeStrategy"] == "upsert"
    assert summary["added"] == 5


def test_repeat_run_adds_nothing_and_keeps_history(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    """重复执行 added = 0，行数不变，不产生重复行（AC-3 / AC-5 / R-12.1）。"""
    now = fixed_now(fake, symbol_case.symbol)
    first = run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    before = _times(conn, symbol_case.symbol)
    before_closes = [_close(conn, symbol_case.symbol, t) for t in before]

    second = run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    after = _times(conn, symbol_case.symbol)

    assert first["added"] == len(before)
    assert second["added"] == 0
    assert after == before
    assert [_close(conn, symbol_case.symbol, t) for t in after] == before_closes


def test_write_strategy_switches_to_do_nothing_for_earlier_start(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    """起点早于 max(time) 必须退化为 DO NOTHING，绝不改写更早的历史（R-9.3 / R-12.3）。"""
    now = fixed_now(fake, symbol_case.symbol)
    run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    middle = symbol_case.onboard_date + 100 * ONE_MINUTE_MS
    conn.execute(
        "UPDATE klines_1m SET close = -1 WHERE symbol = %s AND time = %s",
        (symbol_case.symbol, middle),
    )

    summary = run_sync(
        _options(fake, pg_dsn, tmp_path, symbol_case.symbol, now, from_ms=symbol_case.onboard_date)
    )
    assert summary["writeStrategy"] == "do-nothing"
    assert summary["added"] == 0
    assert _close(conn, symbol_case.symbol, middle) == -1  # 历史未被改写


def test_write_strategy_stays_upsert_when_start_is_max_time(
    fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    now = fixed_now(fake, symbol_case.symbol)
    run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    summary = run_sync(
        _options(
            fake,
            pg_dsn,
            tmp_path,
            symbol_case.symbol,
            now,
            from_ms=fake.closed_through(symbol_case.symbol),
        )
    )
    assert summary["writeStrategy"] == "upsert"


def test_backfill_never_overwrites_existing_rows(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    now = fixed_now(fake, symbol_case.symbol)
    run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    target = symbol_case.onboard_date + 10 * ONE_MINUTE_MS
    conn.execute(
        "UPDATE klines_1m SET close = 999 WHERE symbol = %s AND time = %s",
        (symbol_case.symbol, target),
    )
    before = len(_times(conn, symbol_case.symbol))

    first = run_backfill(
        _options(
            fake,
            pg_dsn,
            tmp_path,
            symbol_case.symbol,
            now,
            from_ms=target,
            to_ms=target + 2 * ONE_MINUTE_MS,
        )
    )
    second = run_backfill(
        _options(
            fake,
            pg_dsn,
            tmp_path,
            symbol_case.symbol,
            now,
            from_ms=target,
            to_ms=target + 2 * ONE_MINUTE_MS,
        )
    )
    assert first["writeStrategy"] == "do-nothing"
    assert first["added"] == 0  # 区间内已有行
    assert second["added"] == 0
    assert len(_times(conn, symbol_case.symbol)) == before
    assert _close(conn, symbol_case.symbol, target) == 999


def test_backfill_fills_missing_range_and_is_idempotent(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    """显式区间回补：人工兜底入口，重复执行不改变任何东西（AC-5 / R-15）。"""
    now = fixed_now(fake, symbol_case.symbol)
    run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    start = symbol_case.onboard_date + 200 * ONE_MINUTE_MS
    end = start + 4 * ONE_MINUTE_MS
    conn.execute(
        "DELETE FROM klines_1m WHERE symbol = %s AND time BETWEEN %s AND %s",
        (symbol_case.symbol, start, end),
    )

    first = run_backfill(
        _options(fake, pg_dsn, tmp_path, symbol_case.symbol, now, from_ms=start, to_ms=end)
    )
    assert first["added"] == 5
    assert first["presentRows"] == first["expectedRows"] == 5
    rows_after_first = len(_times(conn, symbol_case.symbol))

    second = run_backfill(
        _options(fake, pg_dsn, tmp_path, symbol_case.symbol, now, from_ms=start, to_ms=end)
    )
    assert second["added"] == 0
    assert len(_times(conn, symbol_case.symbol)) == rows_after_first


def test_open_ended_pull_drops_last_even_with_fast_clock(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    """未指定 endTime 时**无条件**丢弃末位：本地时钟快也不可能存入未收盘 bar（R-10.1）。"""
    now = fake.in_progress(symbol_case.symbol) + 10 * ONE_MINUTE_MS  # 时钟快得离谱
    summary = run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    stored = _times(conn, symbol_case.symbol)
    assert len(stored) == symbol_case.bars - 1
    assert fake.in_progress(symbol_case.symbol) not in stored
    last = stored[-1]
    assert pg.bar_close_time(last) <= now
    assert summary["added"] == len(stored)


def test_bounded_backfill_stores_every_closed_bar(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    """指定 endTime 的区间回补：一根都不能少（`--bars 500` 必须真的存 500 根）。"""
    now = fixed_now(fake, symbol_case.symbol)
    start = symbol_case.onboard_date + 10 * ONE_MINUTE_MS
    count = symbol_case.bars - 11  # 从第 10 根到最后一根已收盘 bar，全部落在可用数据内
    end = start + (count - 1) * ONE_MINUTE_MS
    result = run_backfill(
        _options(fake, pg_dsn, tmp_path, symbol_case.symbol, now, from_ms=start, to_ms=end)
    )
    stored = _times(conn, symbol_case.symbol)
    assert result["added"] == count
    assert len(stored) == count
    assert stored[-1] == end == result["to"]
    assert result["presentRows"] == result["expectedRows"] == count

    again = run_backfill(
        _options(fake, pg_dsn, tmp_path, symbol_case.symbol, now, from_ms=start, to_ms=end)
    )
    assert again["added"] == 0  # 幂等性不受丢弃规则改动影响（AC-5）
    assert _times(conn, symbol_case.symbol) == stored


def test_bounded_range_ending_at_in_progress_bar_excludes_it(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    """区间末端是进行中的 bar 时不存它，其余照存（N-1 根），且不报错。"""
    now = fixed_now(fake, symbol_case.symbol)
    start = fake.closed_through(symbol_case.symbol) - 4 * ONE_MINUTE_MS
    end = fake.in_progress(symbol_case.symbol)  # 区间一直请求到「此刻」
    result = run_backfill(
        _options(fake, pg_dsn, tmp_path, symbol_case.symbol, now, from_ms=start, to_ms=end)
    )
    stored = _times(conn, symbol_case.symbol)
    assert end not in stored
    assert len(stored) == 5  # 请求了 6 根，未收盘的末位不存（R-10.3 不变量）
    assert stored[-1] == end - ONE_MINUTE_MS
    assert result["added"] == 5


def test_estimate_from_is_minute_aligned(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path
) -> None:
    """onboardDate 不对齐时，estimate 的 from/根数必须与真正拉取的起点一致（R-8.3）。"""
    unaligned = 1_700_000_000_000
    assert unaligned % ONE_MINUTE_MS != 0
    case = SymbolCase(symbol="OFFSETUSDC", onboard_date=unaligned, bars=200)
    fake = FakeExchange(cases=(case,))
    now = fixed_now(fake, case.symbol)
    expected_start = 1_700_000_040_000  # 1700000000000 + (60000 - 20000)

    plan = estimate_scale(
        SyncOptions(
            symbol=case.symbol,
            transport=fake,
            meta_dir=tmp_path,
            now_ms=now,
            refresh=True,
            dsn=None,
        )
    )
    assert plan["from"] == expected_start
    assert plan["bars"] == (now - expected_start) // ONE_MINUTE_MS + 1
    assert plan["requests"] == -(-int(plan["bars"]) // 1500)

    summary = run_sync(_options(fake, pg_dsn, tmp_path, case.symbol, now))
    assert summary["from"] == expected_start == plan["from"]
    estimate = _nested(summary, "estimate")
    assert estimate["from"] == expected_start
    assert estimate["bars"] == plan["bars"]
    assert _times(conn, case.symbol)[0] == expected_start


def test_rows_and_bytes_advance_with_every_batch(
    conn: DbConn,
    fake: FakeExchange,
    pg_dsn: str,
    tmp_path: Path,
    symbol_case: SymbolCase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``rows``/``bytes`` 与每批 COPY 同事务推进，控制面看不到「0 行」这种不一致（R-19.5）。"""

    now = fixed_now(fake, symbol_case.symbol)
    options = _options(
        fake, pg_dsn, tmp_path, symbol_case.symbol, now, page_limit=60, batch_size=50
    )
    real_write = pg.write_bars
    calls: list[int] = []

    def flaky(target: DbConn, sym: str, chunk: Sequence[Kline], strategy: str) -> int:
        calls.append(1)
        if len(calls) == 3:
            raise SyncError("DB_TRANSACTION_ROLLBACK", "模拟写入中断", {})
        return real_write(target, sym, chunk, strategy)

    monkeypatch.setattr(pg, "write_bars", flaky)
    with pytest.raises(SyncError):
        run_sync(options)
    monkeypatch.undo()

    state = pg.read_state(conn, EXCHANGE, symbol_case.symbol)
    assert state is not None
    assert int(state["rows"]) == 100  # 只计入已提交的两批
    assert int(state["bytes"]) == 100 * ESTIMATED_BYTES_PER_ROW
    assert pg.count_rows(conn, symbol_case.symbol) == int(state["rows"])

    run_sync(options)
    state = pg.read_state(conn, EXCHANGE, symbol_case.symbol)
    assert state is not None
    assert int(state["rows"]) == symbol_case.bars - 1 == pg.count_rows(conn, symbol_case.symbol)
    assert int(state["bytes"]) == (symbol_case.bars - 1) * ESTIMATED_BYTES_PER_ROW


def test_backfill_requires_range(
    fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    with pytest.raises(SyncError) as excinfo:
        run_backfill(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, 0))
    assert excinfo.value.code == "CONFIG_INVALID"


# ------------------------------------------------------- 只存已收盘 bar（R-10）


def test_in_progress_bar_is_discarded(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    """注入固定时钟：响应最后一根（未收盘）必须被丢弃（AC-4 / R-10.1、R-10.4）。"""
    now = fixed_now(fake, symbol_case.symbol)
    in_progress = fake.in_progress(symbol_case.symbol)
    assert pg.bar_close_time(in_progress) > now  # 前置条件：这一根确实未收盘

    run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    stored = _times(conn, symbol_case.symbol)
    assert in_progress not in stored
    assert max(stored) == in_progress - ONE_MINUTE_MS
    assert pg.bar_close_time(max(stored)) <= now


def test_last_bar_self_heals_on_next_run(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    """人为篡改最后一根 → 重拉被覆盖修正，更早的行不变（AC-30 / R-10.3）。"""
    now = fixed_now(fake, symbol_case.symbol)
    run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    last = pg.max_time(conn, symbol_case.symbol)
    assert last is not None
    earlier = last - 5 * ONE_MINUTE_MS
    good_earlier = _close(conn, symbol_case.symbol, earlier)
    conn.execute(
        "UPDATE klines_1m SET close = -42 WHERE symbol = %s AND time = %s",
        (symbol_case.symbol, last),
    )

    run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    assert _close(conn, symbol_case.symbol, last) == pytest.approx(
        float(fake.rows(symbol_case.symbol)[int(last)][4])
    )
    assert _close(conn, symbol_case.symbol, earlier) == good_earlier


def test_unclosed_bar_in_store_raises(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    """重拉之后仍未收盘 → 抛错，不得静默继续（R-10.3 / R-21.5）。"""
    now = fixed_now(fake, symbol_case.symbol)
    run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    rogue = now + 10 * ONE_MINUTE_MS
    conn.execute(
        "INSERT INTO klines_1m (symbol, time, open, high, low, close, volume)"
        " VALUES (%s, %s, 1, 1, 1, 1, 1)",
        (symbol_case.symbol, rogue),
    )
    with pytest.raises(SyncError) as excinfo:
        run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    assert excinfo.value.code == "UNCLOSED_BAR_IN_STORE"
    assert excinfo.value.details["time"] == rogue


def test_store_holding_the_in_progress_bar_is_reported(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    """库里存着交易所**当前那根**（进行中）时必须报错（R-10.3 的观测判据）。

    这是 ``observation.open_bar_time`` 那一级的判据：拉取时丢掉的末位就是「交易所此刻
    这根」，库内最后一根必须严格早于它。与本地时钟无关，因此本地时钟快慢都不影响判定。
    """
    now = fixed_now(fake, symbol_case.symbol)
    run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    in_progress = fake.in_progress(symbol_case.symbol)
    conn.execute(
        "INSERT INTO klines_1m (symbol, time, open, high, low, close, volume)"
        " VALUES (%s, %s, 1, 1, 1, 1, 1)",
        (symbol_case.symbol, in_progress),
    )
    with pytest.raises(SyncError) as excinfo:
        run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    assert excinfo.value.code == "UNCLOSED_BAR_IN_STORE"
    assert excinfo.value.details["time"] == in_progress
    assert excinfo.value.details["exchangeOpenBar"] == in_progress


def test_long_round_does_not_report_unclosed_bar(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    """长轮次不得因为收尾校验而被打断（本用例对应「首次全量/配额等待必然误报」）。

    轮首时刻与末页拉取时刻相差几分钟是常态：首次全量实测十几到几十分钟，
    ``WeightBudget.reserve`` 也可能 sleep 到下一个 60s 窗口。此时库里最后一根是交易所
    **已收盘**的 bar（写入路径丢掉了进行中的末位），只是它收盘发生在轮首之后。
    拿轮首时钟判定会把它误判成未收盘 → 常驻侧立刻把标的钉成 error（需人工 resume），
    一次正常同步就此中断。这里用「轮首时刻比交易所当前 bar 早 4 分钟」表达长轮次。
    """
    in_progress = fake.in_progress(symbol_case.symbol)
    round_start = in_progress - 4 * ONE_MINUTE_MS
    first = run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, round_start))
    assert int(cast(int, first["added"])) > 0

    stored = _times(conn, symbol_case.symbol)
    assert max(stored) == in_progress - ONE_MINUTE_MS  # 进行中的那根一根都没入库
    # 前置条件：最后一根确实是「轮首之后」才收盘的——旧判据必报错
    assert pg.bar_close_time(max(stored)) > round_start

    # 同一陈旧轮首时钟下的增量轮次同样不得报错，且不重复写
    second = run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, round_start))
    assert second["added"] == 0
    assert pg.max_time(conn, symbol_case.symbol) == in_progress - ONE_MINUTE_MS


def test_bounded_pull_uses_per_page_clock_for_closed_check(
    conn: DbConn,
    fake: FakeExchange,
    pg_dsn: str,
    tmp_path: Path,
    symbol_case: SymbolCase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """限区间请求的「是否收盘」必须用**当页**时钟，轮首时钟会把本轮才收盘的尾巴丢掉。

    丢掉的尾巴不会被记成缺口——完整性判定只在 ``[from, to]`` 内比对——也就不会报错，
    一次正常的追赶会静默少几根（违反「不静默兜底」）。这里让时钟按序返回
    「轮首时刻、拉页时刻」，把两个时刻分开；单测无法让真实时间前进，只能这样表达。
    """
    in_progress = fake.in_progress(symbol_case.symbol)
    round_start = in_progress - 4 * ONE_MINUTE_MS
    page_time = fixed_now(fake, symbol_case.symbol)
    _fixed_clock(monkeypatch, [round_start, page_time])

    # now=None：走生产路径的「现读时钟」，才能被上面注入的序列替换（注入 now_ms 会固定整轮）。
    options = replace(
        _options(fake, pg_dsn, tmp_path, symbol_case.symbol, None),
        to_ms=in_progress,
    )
    run_sync(options)

    stored = _times(conn, symbol_case.symbol)
    assert max(stored) == in_progress - ONE_MINUTE_MS
    assert len(stored) == symbol_case.bars - 1


def test_boundary_violation_raises_and_history_untouched(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    """交易所忽略 startTime 时必须报错，且已有历史一根都不许改（AC-31 / R-9.4）。"""
    now = fixed_now(fake, symbol_case.symbol)
    run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    before_times = _times(conn, symbol_case.symbol)
    before_closes = [_close(conn, symbol_case.symbol, t) for t in before_times]
    fake.ignore_start_time = True

    with pytest.raises(SyncError) as excinfo:
        run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    assert excinfo.value.code == "BACKFILL_BOUNDARY_VIOLATION"
    assert int(cast(int, excinfo.value.details["violatingTime"])) < int(
        cast(int, excinfo.value.details["startTime"])
    )
    assert _times(conn, symbol_case.symbol) == before_times
    assert [_close(conn, symbol_case.symbol, t) for t in before_times] == before_closes


# ------------------------------------------------- 批量写入与断点续传（R-3）


def test_copy_batches_and_resume_after_interrupt(
    conn: DbConn,
    fake: FakeExchange,
    pg_dsn: str,
    tmp_path: Path,
    symbol_case: SymbolCase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """多页 + 多批 COPY 写入；第二批失败整批回滚，重跑从水位续传（AC-2 / AC-6 / R-3.1、R-3.5）。"""
    now = fixed_now(fake, symbol_case.symbol)
    options = _options(
        fake, pg_dsn, tmp_path, symbol_case.symbol, now, page_limit=60, batch_size=50
    )
    real_write = pg.write_bars
    calls: list[int] = []

    def flaky(target: DbConn, sym: str, chunk: Sequence[Kline], strategy: str) -> int:
        calls.append(1)
        if len(calls) == 3:
            raise SyncError("DB_TRANSACTION_ROLLBACK", "模拟写入中断", {"batch": len(calls)})
        return real_write(target, sym, chunk, strategy)

    monkeypatch.setattr(pg, "write_bars", flaky)
    with pytest.raises(SyncError):
        run_sync(options)
    monkeypatch.undo()

    committed = _times(conn, symbol_case.symbol)
    assert len(committed) == 100  # 两批 × 50，第三批整批回滚
    state = pg.read_state(conn, EXCHANGE, symbol_case.symbol)
    assert state is not None
    assert int(state["watermark"]) == committed[-1]  # 水位只按已提交批次推进

    fake.kline_calls.clear()
    summary = run_sync(options)
    assert fake.kline_calls[0]["start"] == committed[-1]  # 从水位续传，不重头
    final = _times(conn, symbol_case.symbol)
    assert len(final) == len(set(final))
    assert final == sorted(final)
    assert len(final) == symbol_case.bars - 1
    assert summary["added"] == len(final) - len(committed)


def test_write_failure_rolls_back_whole_batch(
    conn: DbConn,
    fake: FakeExchange,
    pg_dsn: str,
    tmp_path: Path,
    symbol_case: SymbolCase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """批内失败不留半批数据（R-3.5）。"""
    now = fixed_now(fake, symbol_case.symbol)
    options = _options(fake, pg_dsn, tmp_path, symbol_case.symbol, now, batch_size=20)

    def boom(target: DbConn, sym: str, chunk: Sequence[Kline], strategy: str) -> int:
        raise SyncError("DB_DEADLOCK", "模拟事务回滚", {})

    monkeypatch.setattr(pg, "write_bars", boom)
    with pytest.raises(SyncError):
        run_sync(options)
    monkeypatch.undo()
    assert _times(conn, symbol_case.symbol) == []


# ------------------------------------------------------------ 缺口（R-11）


def test_gap_is_detected_registered_and_auto_backfilled(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    """缺口必须被登记到 gaps 表，并在下一轮**自动**补回，无需人工（AC-7 / R-11.B5、R-11.B6）。"""
    now = fixed_now(fake, symbol_case.symbol)
    fake.set_hole(symbol_case.symbol, 100, 3)
    first = run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))

    assert first["gapsPending"] == 1
    gaps = pg.list_gaps(conn, symbol_case.symbol)
    assert len(gaps) == 1
    gap_start = symbol_case.onboard_date + 100 * ONE_MINUTE_MS
    assert int(gaps[0]["gap_start"]) == gap_start
    assert int(gaps[0]["gap_end"]) == gap_start + 2 * ONE_MINUTE_MS
    assert int(gaps[0]["missing_rows"]) == 3
    state = pg.read_state(conn, EXCHANGE, symbol_case.symbol)
    assert state is not None
    assert int(state["verified_upto"]) == gap_start - ONE_MINUTE_MS

    fake.clear_hole(symbol_case.symbol)
    second = run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    assert second["gapsFilled"] == 1
    assert second["gapsPending"] == 0
    assert pg.list_gaps(conn, symbol_case.symbol) == []

    stored = _times(conn, symbol_case.symbol)
    assert stored == sorted(stored)
    assert all(b - a == ONE_MINUTE_MS for a, b in itertools.pairwise(stored))
    state = pg.read_state(conn, EXCHANGE, symbol_case.symbol)
    assert state is not None
    assert int(state["verified_upto"]) == stored[-1]


def test_gap_detection_scan_is_bounded(
    conn: DbConn,
    fake: FakeExchange,
    pg_dsn: str,
    tmp_path: Path,
    symbol_case: SymbolCase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """每轮只扫 [max(first_bar, max(time) - lookback), max(time)]，不随历史线性增长。

    AC-32 的可执行断言：把回看窗口调小后，扫描行数是**常数**，与已入库行数无关。
    下界刻意**不取** ``verified_upto``（干净同步后它等于 max(time)，窗口会塌缩成一个点，
    看不见 AC-7 的人为删行）——理由见 ``sync.DEFAULT_GAP_LOOKBACK_MS``。
    """
    now = fixed_now(fake, symbol_case.symbol)
    lookback = 10 * ONE_MINUTE_MS
    scans: list[tuple[int, int, int]] = []
    real_detect = pg.detect_gaps

    def spy(target: DbConn, symbol: str, start_ms: int, end_ms: int) -> list[pg.Gap]:
        scanned = pg.count_rows_between(target, symbol, max(start_ms, pg.PG_MIN_TIME), end_ms)
        scans.append((start_ms, end_ms, scanned))
        return real_detect(target, symbol, start_ms, end_ms)

    monkeypatch.setattr(pg, "detect_gaps", spy)
    try:
        run_sync(
            _options(fake, pg_dsn, tmp_path, symbol_case.symbol, now, gap_lookback_ms=lookback)
        )
        # 首次为该标的建立基线：全表扫描一次（R-11.A3 ①）。
        assert scans[-1][0] == pg.PG_MIN_TIME
        baseline_scanned = scans[-1][2]
        assert baseline_scanned == symbol_case.bars - 1

        previous_end = scans[-1][1]
        for step in range(1, 4):
            fake.advance(symbol_case.symbol, 10)
            run_sync(
                _options(
                    fake,
                    pg_dsn,
                    tmp_path,
                    symbol_case.symbol,
                    now + step * 10 * ONE_MINUTE_MS,
                    gap_lookback_ms=lookback,
                )
            )
            start_ms, end_ms, scanned = scans[-1]
            assert end_ms == pg.max_time(conn, symbol_case.symbol)
            # 区间 = [max - lookback, max]（verified_upto 已追平 max，取更小的一侧）
            first_bar = pg.min_time(conn, symbol_case.symbol)
            assert first_bar is not None
            assert start_ms == max(first_bar, end_ms - lookback)
            assert scanned == 11  # 闭区间：新增 10 根 + 起点那一根，与历史长度无关
            previous_end = end_ms
        assert baseline_scanned > 10 * scans[-1][2]
    finally:
        monkeypatch.undo()
    assert previous_end > 0


def test_default_gap_lookback_bounds_scan_cost(
    conn: DbConn, pg_dsn: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """缺省回看窗口 = 7 天：历史再长，每轮检测的行数也有上界（AC-32 / R-11.A 的真实目标）。"""
    from quant_data.sync import DEFAULT_GAP_LOOKBACK_MS

    big = SymbolCase(symbol="BIGUSDC", onboard_date=1_700_000_040_000, bars=60_000)
    fake = FakeExchange(cases=(big,))
    now = fixed_now(fake, big.symbol)
    assert DEFAULT_GAP_LOOKBACK_MS == 604_800_000
    expected_rows = DEFAULT_GAP_LOOKBACK_MS // ONE_MINUTE_MS + 1  # 10,080 + 起点

    scans: list[int] = []
    real_detect = pg.detect_gaps

    def spy(target: DbConn, symbol: str, start_ms: int, end_ms: int) -> list[pg.Gap]:
        scans.append(pg.count_rows_between(target, symbol, max(start_ms, pg.PG_MIN_TIME), end_ms))
        return real_detect(target, symbol, start_ms, end_ms)

    monkeypatch.setattr(pg, "detect_gaps", spy)
    run_sync(_options(fake, pg_dsn, tmp_path, big.symbol, now))
    assert scans[-1] == big.bars - 1  # 首次全表基线
    fake.advance(big.symbol, 3)
    run_sync(_options(fake, pg_dsn, tmp_path, big.symbol, now + 3 * ONE_MINUTE_MS))
    assert scans[-1] == expected_rows
    assert scans[-1] < (big.bars + 2) // 4  # 远小于全表：6 万行历史只扫约 1 万行


def test_middle_deletion_is_auto_backfilled_next_round(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    """AC-7 场景①：干净同步之后**人为删掉中间几行**，下一轮**自动补回**，无需人工。

    字面的 ``[verified_upto, max(time)]`` 在这里塌缩成单点（verified_upto == max(time)），
    中间的洞永远看不见；固定回看窗口使它可被发现（本用例锁定的就是这一条）。

    轮次语义（★AC-7）：「下一轮 data sync 自动把缺口补回，gaps 表记录被清除」，
    所以一轮之内必须走完「检测 → 回补 → 清除登记」——只登记就返回不算数。
    """
    now = fixed_now(fake, symbol_case.symbol)
    run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    before = _times(conn, symbol_case.symbol)
    state = pg.read_state(conn, EXCHANGE, symbol_case.symbol)
    assert state is not None
    assert int(state["verified_upto"]) == int(state["watermark"]) == before[-1]

    gap_start = before[len(before) // 2]
    conn.execute(
        "DELETE FROM klines_1m WHERE symbol = %s AND time BETWEEN %s AND %s",
        (symbol_case.symbol, gap_start, gap_start + 2 * ONE_MINUTE_MS),
    )
    assert len(_times(conn, symbol_case.symbol)) == len(before) - 3

    # 第 2 轮：回看窗口让它被当场发现、**当场补回**，登记被清除。
    summary = run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    assert summary["gapsFilled"] == 1
    assert summary["gapsPending"] == 0
    assert pg.list_gaps(conn, symbol_case.symbol) == []
    assert _times(conn, symbol_case.symbol) == before  # 行集合与删除前完全一致
    after = pg.read_state(conn, EXCHANGE, symbol_case.symbol)
    assert after is not None
    assert int(after["verified_upto"]) == before[-1]  # 基线继续推进到 max(time)


def test_verified_upto_advances_to_max_time_without_gaps(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    """没有缺口时 verified_upto = max(time)，且不会被回看窗口拉回去（基线不回退）。"""
    now = fixed_now(fake, symbol_case.symbol)
    run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    watermark = int(pg.max_time(conn, symbol_case.symbol) or 0)
    state = pg.read_state(conn, EXCHANGE, symbol_case.symbol)
    assert state is not None
    assert int(state["verified_upto"]) == watermark

    fake.advance(symbol_case.symbol, 5)
    later = now + 5 * ONE_MINUTE_MS
    run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, later))
    new_watermark = int(pg.max_time(conn, symbol_case.symbol) or 0)
    state = pg.read_state(conn, EXCHANGE, symbol_case.symbol)
    assert state is not None
    assert new_watermark > watermark
    assert int(state["verified_upto"]) == new_watermark


def test_gap_attempts_cap_marks_symbol_error_and_stops_retry(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    """永久性缺口回补达上限后进入 error，停止自动重试，需人工兜底（AC-7 / R-11.B9 / R-21.3）。"""
    now = fixed_now(fake, symbol_case.symbol)
    fake.set_hole(symbol_case.symbol, 50, 2)
    options = _options(fake, pg_dsn, tmp_path, symbol_case.symbol, now, max_gap_attempts=2)
    run_sync(options)  # 第 1 轮：拉取时发现缺口并登记
    run_sync(options)  # 第 2 轮：回补失败，attempts = 1
    run_sync(options)  # 第 3 轮：回补失败，attempts = 2 → 达上限

    gaps = pg.list_gaps(conn, symbol_case.symbol)
    assert len(gaps) == 1
    assert int(gaps[0]["attempts"]) == 2
    state = pg.read_state(conn, EXCHANGE, symbol_case.symbol)
    assert state is not None
    assert state["status"] == "error"
    assert "GAP_ATTEMPTS_EXHAUSTED" in str(state["last_error"])

    # 达上限后不再重试：缺口行原样保留，计入 abandoned。
    again = run_sync(options)
    assert again["gapsAbandoned"] == 1
    assert int(pg.list_gaps(conn, symbol_case.symbol)[0]["attempts"]) == 2

    # 人工兜底：data backfill 可解，且不静默清除 error 状态（R-21.3）。
    fake.clear_hole(symbol_case.symbol)
    gap_start = int(gaps[0]["gap_start"])
    result = run_backfill(
        _options(
            fake,
            pg_dsn,
            tmp_path,
            symbol_case.symbol,
            now,
            from_ms=gap_start,
            to_ms=gap_start + ONE_MINUTE_MS,
        )
    )
    assert result["presentRows"] == result["expectedRows"] == 2
    assert pg.list_gaps(conn, symbol_case.symbol) == []
    state = pg.read_state(conn, EXCHANGE, symbol_case.symbol)
    assert state is not None and state["status"] == "error"


def test_verify_rebuilds_verified_upto_baseline(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    """显式 verify 做全表扫描并重建基线（R-11.A3 ②）。"""
    now = fixed_now(fake, symbol_case.symbol)
    run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    gap_start = symbol_case.onboard_date + 30 * ONE_MINUTE_MS
    conn.execute(
        "DELETE FROM klines_1m WHERE symbol = %s AND time BETWEEN %s AND %s",
        (symbol_case.symbol, gap_start, gap_start + ONE_MINUTE_MS),
    )
    payload = run_verify(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    assert payload["scannedRows"] == symbol_case.bars - 3
    assert payload["gapsFound"] == 1
    assert payload["verifiedUpTo"] == gap_start - ONE_MINUTE_MS
    assert len(pg.list_gaps(conn, symbol_case.symbol)) == 1


def test_verify_without_data_raises(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    with pytest.raises(SyncError) as excinfo:
        run_verify(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, 0))
    assert excinfo.value.code == "SYMBOL_NOT_FOUND"


def test_no_interpolation_of_gaps(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    """禁止插值补齐：缺口只能用真实数据填，永久缺口就保持缺失（R-11.C.10）。"""
    now = fixed_now(fake, symbol_case.symbol)
    fake.set_hole(symbol_case.symbol, 10, 4)
    options = _options(fake, pg_dsn, tmp_path, symbol_case.symbol, now)
    run_sync(options)
    run_sync(options)
    stored = set(_times(conn, symbol_case.symbol))
    for index in range(10, 14):
        assert symbol_case.onboard_date + index * ONE_MINUTE_MS not in stored


# ------------------------------------------------------- 单写者与状态（R-19）


def test_concurrent_sync_is_rejected(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    """同一标的并发两次同步必须被拒绝，不得交错写（AC-19 / R-3.3）。"""
    now = fixed_now(fake, symbol_case.symbol)
    held = pg.SymbolLock.acquire(pg_dsn, EXCHANGE, symbol_case.symbol, now)
    try:
        with pytest.raises(SyncError) as excinfo:
            run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
        assert excinfo.value.code == "SYNC_ALREADY_RUNNING"
    finally:
        held.release()
    assert _times(conn, symbol_case.symbol) == []


def test_locked_sync_state_row_rejects_second_runner(conn: DbConn, pg_dsn: str) -> None:
    """sync_state 行被 FOR UPDATE 锁住时，第二轮直接失败而不是排队（R-3.3）。"""
    symbol = "LOCKUSDC"
    conn.execute(
        "INSERT INTO sync_state (exchange, symbol, status, updated_at)"
        " VALUES (%s, %s, 'running', 0)",
        (EXCHANGE, symbol),
    )
    blocker = pg.connect(pg_dsn)
    try:
        with blocker.transaction():
            blocker.execute(
                "SELECT 1 FROM sync_state WHERE exchange = %s AND symbol = %s FOR UPDATE",
                (EXCHANGE, symbol),
            )
            with pytest.raises(SyncError) as excinfo:
                pg.SymbolLock.acquire(pg_dsn, EXCHANGE, symbol, 0)
            assert excinfo.value.code == "SYNC_ALREADY_RUNNING"
    finally:
        blocker.close()


def test_lock_is_released_after_success(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    now = fixed_now(fake, symbol_case.symbol)
    run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    again = pg.SymbolLock.acquire(pg_dsn, EXCHANGE, symbol_case.symbol, now)
    again.release()


def test_state_is_queryable_and_survives_reconnect(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    """状态与数据一起持久化，换连接（等价于进程重启）后仍准确（R-19.1、R-19.4）。"""
    now = fixed_now(fake, symbol_case.symbol)
    run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    conn.close()
    fresh = pg.connect(pg_dsn)
    try:
        state = pg.read_state(fresh, EXCHANGE, symbol_case.symbol)
        assert state is not None
        assert state["status"] == "running"
        assert int(state["rows"]) == symbol_case.bars - 1
        assert int(state["watermark"]) == fake.closed_through(symbol_case.symbol)
        assert int(state["verified_upto"]) == int(state["watermark"])
        assert int(state["pending_gaps"]) == 0
        assert int(state["last_success_at"]) == now
    finally:
        fresh.close()


def test_watermark_mismatch_is_reported(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    """sync_state.watermark 与 max(time) 不一致必须报错，不静默二选一（AC-21 / R-19.6）。"""
    now = fixed_now(fake, symbol_case.symbol)
    run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    conn.execute(
        "UPDATE sync_state SET watermark = watermark - %s WHERE exchange = %s AND symbol = %s",
        (ONE_MINUTE_MS, EXCHANGE, symbol_case.symbol),
    )
    # 起点晚于库内最后一根 → 本轮不写任何批次，缓存里的旧水位不会被顺带修好。
    with pytest.raises(SyncError) as excinfo:
        run_sync(
            _options(
                fake,
                pg_dsn,
                tmp_path,
                symbol_case.symbol,
                now,
                from_ms=fake.closed_through(symbol_case.symbol) + 5 * ONE_MINUTE_MS,
            )
        )
    assert excinfo.value.code == "WATERMARK_MISMATCH"


def test_watermark_drift_is_reported_even_when_the_round_repairs_it(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    """普通增量轮次里被篡改的水位缓存必须报错，**不能**被分批写入顺手改好（AC-21）。

    这是 AC-21 真实的失效路径：分批提交会用 ``max(time)`` 覆盖 ``sync_state.watermark``，
    轮末再校验就永远看不到分叉，于是「静默二选一」（R-19.6）成立。
    因此判定必须基于**轮次入口的快照**。
    """
    now = fixed_now(fake, symbol_case.symbol)
    run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    truth = pg.max_time(conn, symbol_case.symbol)
    assert truth is not None
    # 把缓存改成与权威值无关的垃圾值：增量轮次照常会写最后一根并「修好」它。
    conn.execute(
        "UPDATE sync_state SET watermark = %s WHERE exchange = %s AND symbol = %s",
        (truth - 7 * ONE_MINUTE_MS, EXCHANGE, symbol_case.symbol),
    )
    with pytest.raises(SyncError) as excinfo:
        run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    assert excinfo.value.code == "WATERMARK_MISMATCH"


def test_unclosed_bar_error_wins_over_watermark_drift(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    """库里多出一根未收盘 bar 时要报 R-10.3 的专属错误码，而不是笼统的水位不一致。

    两种情况在库里长得一样（cached < authoritative），但 R-10.3 的诊断更有价值，
    因此入口快照的判定必须让位给更具体的错误。
    """
    now = fixed_now(fake, symbol_case.symbol)
    run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    conn.execute(
        "INSERT INTO klines_1m (symbol, time, open, high, low, close, volume)"
        " VALUES (%s, %s, 1, 1, 1, 1, 1)",
        (symbol_case.symbol, now + 10 * ONE_MINUTE_MS),
    )
    with pytest.raises(SyncError) as excinfo:
        run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    assert excinfo.value.code == "UNCLOSED_BAR_IN_STORE"


def test_schema_version_mismatch_is_reported(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    """未迁移的库必须报错，而不是按旧结构继续跑（AC-1 / R-1.3、R-19.7）。"""
    empty_schema = "test_quant_data_empty"
    admin = psycopg.connect(pg_dsn.rsplit("?", 1)[0], autocommit=True)
    try:
        admin.execute(f'DROP SCHEMA IF EXISTS "{empty_schema}" CASCADE')
        admin.execute(f'CREATE SCHEMA "{empty_schema}"')
    finally:
        admin.close()
    empty_dsn = f"{pg_dsn.rsplit('?', 1)[0]}?options=-c%20search_path%3D{empty_schema}"
    try:
        with pytest.raises(SyncError) as excinfo:
            run_sync(_options(fake, empty_dsn, tmp_path, symbol_case.symbol, 0))
        assert excinfo.value.code == "SCHEMA_VERSION_MISMATCH"
    finally:
        admin = psycopg.connect(pg_dsn.rsplit("?", 1)[0], autocommit=True)
        try:
            admin.execute(f'DROP SCHEMA IF EXISTS "{empty_schema}" CASCADE')
        finally:
            admin.close()


def test_migrations_are_idempotent(conn: DbConn, pg_dsn: str) -> None:
    """迁移可重复执行且幂等（AC-1 / R-1.2）。"""
    again = pg.apply_migration_files(conn, SQL_DIR, 1)
    # 第二次执行**一个新版本都不该应用**（返回值只含本次真正应用的版本）；
    # 无条件返回全部版本会让这个断言恒真、失去鉴别力。
    assert again == []
    rows = conn.execute("SELECT version FROM schema_migrations ORDER BY version").fetchall()
    assert [str(row["version"]) for row in rows] == [
        "001_init",
        "002_sync_plan",
        "003_daemon_heartbeat",
        # v0.2.0：四张派生周期表
        "004_klines_agg",
        # v0.3.0：七张指标物化表
        "005_indicators",
        # v0.4.0：止盈止损执行记录
        "006_risk_bracket",
        # v0.5.0：控制面可写的运行期设置
        "007_executor_settings",
    ]
    pg.ensure_schema(conn)


def test_missing_dsn_is_config_invalid(
    fake: FakeExchange, tmp_path: Path, symbol_case: SymbolCase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """DSN 只走环境变量；缺失时必须 CONFIG_INVALID，不静默兜底。"""
    monkeypatch.delenv("TRADE_TOOL_PG_DSN", raising=False)
    options = SyncOptions(
        symbol=symbol_case.symbol, transport=fake, meta_dir=tmp_path, now_ms=0, dsn=None
    )
    with pytest.raises(SyncError) as excinfo:
        run_sync(options)
    assert excinfo.value.code == "CONFIG_INVALID"
    assert excinfo.value.details["env"] == "TRADE_TOOL_PG_DSN"


# ------------------------------------------------- NULL 语义与配额（R-4 / R-20）


def test_optional_columns_can_be_null_and_are_readable(conn: DbConn) -> None:
    """quote_volume / trades 为 NULL 表示「交易所未提供」，与 0 严格区分（AC-9 / R-4.2）。"""
    symbol = "NULLUSDC"
    with conn.transaction():
        conn.execute(
            "INSERT INTO klines_1m (symbol, time, open, high, low, close, volume)"
            " VALUES (%s, %s, 1, 2, 0.5, 1.5, 3)",
            (symbol, 1_700_000_000_000),
        )
    row = conn.execute(
        "SELECT quote_volume, trades FROM klines_1m WHERE symbol = %s", (symbol,)
    ).fetchone()
    assert row is not None
    assert row["quote_volume"] is None
    assert row["trades"] is None

    bar = Kline(
        time=1_700_000_060_000,
        open=1.0,
        high=2.0,
        low=0.5,
        close=1.5,
        volume=3.0,
        close_time=1_700_000_119_999,
        quote_volume=None,
        trades=None,
    )
    with conn.transaction():
        added = pg.write_bars(conn, symbol, [bar], "upsert")
    assert added == 1
    row = conn.execute(
        "SELECT quote_volume, trades FROM klines_1m WHERE symbol = %s AND time = %s",
        (symbol, bar.time),
    ).fetchone()
    assert row is not None and row["quote_volume"] is None and row["trades"] is None


def test_mandatory_columns_reject_null_in_database(conn: DbConn) -> None:
    with pytest.raises(psycopg.errors.NotNullViolation), conn.transaction():
        conn.execute(
            "INSERT INTO klines_1m (symbol, time, open, high, low, close, volume)"
            " VALUES (%s, %s, NULL, 1, 1, 1, 1)",
            ("NULLXUSDC", 1),
        )


def test_weight_budget_is_shared_through_postgres(pg_dsn: str) -> None:
    """配额是账号级的：两个独立连接（= 两个进程）共用同一个桶（R-20.1、R-20.2）。"""
    first = pg.connect(pg_dsn)
    second = pg.connect(pg_dsn)
    try:
        WeightBudget(first, 100).reserve(40)
        assert WeightBudget(second, 100).status()["used"] == 40
        WeightBudget(second, 100).reserve(60)
        assert WeightBudget(first, 100).status()["used"] == 100
    finally:
        first.close()
        second.close()


def test_sync_reserves_weight_before_each_request(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    """每次出网都先在 PG 里预留权重，摘要里的 weight 与桶里的 used 必须一致（R-20.2）。"""
    now = fixed_now(fake, symbol_case.symbol)
    summary = run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    probe = pg.connect(pg_dsn)
    try:
        status = WeightBudget(probe, 1920).status()
    finally:
        probe.close()
    weight = int(cast(int, summary["weight"]))
    assert int(cast(int, status["used"])) == weight
    assert weight == 11  # exchangeInfo 1 + limit>1000 的 klines 10（附录 A.3）
    assert summary["requests"] == 2  # exchangeInfo + 一页 klines


def test_rate_limit_pauses_all_processes(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    """429 时尊重 Retry-After 并写 pause_until，让**所有**进程全局暂停（R-21.4）。"""
    now = fixed_now(fake, symbol_case.symbol)
    fake.rate_limit_on_call = 1
    with pytest.raises(SyncError) as excinfo:
        run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    assert excinfo.value.code == "EXCHANGE_RATE_LIMITED"
    row = conn.execute("SELECT pause_until FROM weight_budget WHERE id = 1").fetchone()
    assert row is not None and row["pause_until"] is not None
    assert int(row["pause_until"]) > 0


def test_pagination_advances_and_stops_on_short_page(
    conn: DbConn,
    fake: FakeExchange,
    pg_dsn: str,
    tmp_path: Path,
    symbol_case: SymbolCase,
) -> None:
    """分页按页推进，短页终止；分页重叠按 time 去重（R-12.4）。"""
    now = fixed_now(fake, symbol_case.symbol)
    run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now, page_limit=100))
    assert len(fake.kline_calls) == -(-symbol_case.bars // 100)  # 每页 100 根，短页终止
    starts = [call["start"] for call in fake.kline_calls if call["symbol"] == symbol_case.symbol]
    assert starts == sorted(starts)
    assert len(starts) == len(set(starts))
    stored = _times(conn, symbol_case.symbol)
    assert len(stored) == len(set(stored)) == symbol_case.bars - 1


def test_fetch_interrupt_keeps_committed_progress(
    conn: DbConn,
    fake: FakeExchange,
    pg_dsn: str,
    tmp_path: Path,
    symbol_case: SymbolCase,
) -> None:
    """**拉取阶段**被中断，已提交的批次必须留在库里，重跑从水位继续（R-3.2 / R-8.5 / AC-6）。

    这条用例专门盯「边拉边写」而不是「先拉完再写」：

    先攒完再写的实现里，fetch 阶段一旦断掉，**一行都写不进去**，水位停在起点，
    重跑得从 onboardDate 整段重来——AC-6「不重头」直接不成立，而且 144 万根会先撑爆内存。
    """
    now = fixed_now(fake, symbol_case.symbol)
    options = _options(
        fake, pg_dsn, tmp_path, symbol_case.symbol, now, page_limit=60, batch_size=50
    )

    # 第 5 页（= 4 页 × 60 根 + 第 5 页中途）断网，此时已有 4 批应当提交
    fake.fail_on_kline_call = 5
    with pytest.raises(SyncError):
        run_sync(options)

    committed = _times(conn, symbol_case.symbol)
    # 关键断言：中断时**已经有数据落库**，而不是 0 行
    assert len(committed) == 200, f"中断后应有 200 行已提交，实际 {len(committed)}"
    state = pg.read_state(conn, EXCHANGE, symbol_case.symbol)
    assert state is not None
    assert int(state["watermark"]) == committed[-1]

    # 恢复网络后重跑：从水位续传，不从起点重来
    fake.fail_on_kline_call = None
    fake.kline_calls.clear()
    summary = run_sync(options)
    assert fake.kline_calls[0]["start"] == committed[-1]

    final = _times(conn, symbol_case.symbol)
    assert len(final) == len(set(final)), "重跑不得产生重复行"
    assert len(final) == symbol_case.bars - 1
    assert summary["added"] == len(final) - len(committed)


# ------------------------------------------- 第二轮缺陷回归（审计发现并修复）


def test_detect_gaps_skips_misaligned_neighbours(conn: DbConn) -> None:
    """相邻行差落在 (60_000, 120_000) 时不是 1m 缺口，不得生成非法的 gaps 记录。

    这种非对齐行只能来自外部/手工写入（schema 不禁止）。旧实现会生成
    ``missing_rows = 0`` 且 ``gap_end < gap_start`` 的记录，插入时撞 ``gaps`` 的
    CHECK 约束，异常**每轮重复出现**——该标的此后再也同步不了（R-1.4 / R-11.A.1）。
    """
    conn.execute(
        "INSERT INTO klines_1m (symbol, time, open, high, low, close, volume)"
        " VALUES ('MISALIGNUSDC', 0, 1, 1, 1, 1, 1), ('MISALIGNUSDC', 90000, 1, 1, 1, 1, 1)"
    )
    assert pg.detect_gaps(conn, "MISALIGNUSDC", pg.PG_MIN_TIME, 10**15) == []
    # 即便调用方显式给出非法缺口，也要被挡在约束之外，而不是炸掉整轮
    assert (
        pg.insert_gaps(
            conn, EXCHANGE, "MISALIGNUSDC", [pg.Gap(gap_start=60000, gap_end=30000, missing_rows=0)]
        )
        == 0
    )

    # 真正的 1m 缺口（相邻差 >= 2 分钟）仍然必须检出
    conn.execute(
        "INSERT INTO klines_1m (symbol, time, open, high, low, close, volume)"
        " VALUES ('MISALIGNUSDC', 240000, 1, 1, 1, 1, 1)"
    )
    gaps = pg.detect_gaps(conn, "MISALIGNUSDC", pg.PG_MIN_TIME, 10**15)
    assert len(gaps) == 1
    assert gaps[0].gap_start == 150000
    assert gaps[0].gap_end == 180000
    assert gaps[0].missing_rows == 1


def test_backfill_expected_rows_counts_minute_aligned_bars(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    """未对齐的 ``--from/--to`` 不能让 ``expectedRows`` 高估，否则缺口永远清不掉（R-11.B12）。"""
    now = fixed_now(fake, symbol_case.symbol)
    run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    closed = fake.closed_through(symbol_case.symbol)
    start = closed - 10 * ONE_MINUTE_MS + 1  # 故意不对齐
    end = start + 5 * ONE_MINUTE_MS - 1
    result = run_backfill(
        _options(fake, pg_dsn, tmp_path, symbol_case.symbol, now, from_ms=start, to_ms=end)
    )
    first = align_bar_start(start)
    last = (end // ONE_MINUTE_MS) * ONE_MINUTE_MS
    expected = (last - first) // ONE_MINUTE_MS + 1
    # 旧公式 (to - from) // 60_000 + 1 会算出 expected + 1，`present >= expected` 永假
    assert result["expectedRows"] == expected
    assert result["presentRows"] == expected


def test_backfill_reports_watermark_mismatch(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    """backfill 同样会把 watermark 缓存覆盖成 max(time)，因此同样要先判定分叉（R-19.6 / AC-21）。"""
    now = fixed_now(fake, symbol_case.symbol)
    run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    conn.execute(
        "UPDATE sync_state SET watermark = watermark - %s WHERE exchange = %s AND symbol = %s",
        (ONE_MINUTE_MS, EXCHANGE, symbol_case.symbol),
    )
    start = fake.closed_through(symbol_case.symbol) - 5 * ONE_MINUTE_MS
    with pytest.raises(SyncError) as excinfo:
        run_backfill(
            _options(fake, pg_dsn, tmp_path, symbol_case.symbol, now, from_ms=start, to_ms=start)
        )
    assert excinfo.value.code == "WATERMARK_MISMATCH"


def test_backfill_rejects_unknown_symbol(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    """backfill 也要做运行时元数据校验：未知标的必须是 SYMBOL_NOT_FOUND（R-7.2 / AC-13）。"""
    now = fixed_now(fake, symbol_case.symbol)
    start = fake.closed_through(symbol_case.symbol) - 5 * ONE_MINUTE_MS
    with pytest.raises(SyncError) as excinfo:
        run_backfill(
            _options(fake, pg_dsn, tmp_path, "NOSUCHUSDC", now, from_ms=start, to_ms=start)
        )
    assert excinfo.value.code == "SYMBOL_NOT_FOUND"


@pytest.mark.parametrize("command", ["sync", "backfill", "verify"])
def test_unknown_symbol_leaves_no_ghost_state_row(
    conn: DbConn,
    fake: FakeExchange,
    pg_dsn: str,
    tmp_path: Path,
    symbol_case: SymbolCase,
    command: str,
) -> None:
    """未知标的不得在 sync_state 留下幽灵行——抢锁会先建行，校验失败必须清掉（R-19.1）。"""
    now = fixed_now(fake, symbol_case.symbol)
    start = fake.closed_through(symbol_case.symbol) - 5 * ONE_MINUTE_MS
    options = _options(fake, pg_dsn, tmp_path, "NOSUCHUSDC", now, from_ms=start, to_ms=start)
    with pytest.raises(SyncError) as excinfo:
        if command == "sync":
            run_sync(options)
        elif command == "backfill":
            run_backfill(options)
        else:
            run_verify(options)
    assert excinfo.value.code == "SYMBOL_NOT_FOUND"
    assert pg.read_state(conn, EXCHANGE, "NOSUCHUSDC") is None


def test_gap_backfill_boundary_violation_is_not_downgraded_to_attempts(
    conn: DbConn, fake: FakeExchange, pg_dsn: str, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    """缺口回补撞上越界 bar 必须直接抛（R-9.4 / R-21.5），不能吞成「回补失败第 N 次」。

    吞掉的后果：CLI 退出码仍是 0，操作者最终只能看到一个
    ``GAP_ATTEMPTS_EXHAUSTED``，真正的原因（交易所无视 startTime）被埋进 last_error。
    """
    now = fixed_now(fake, symbol_case.symbol)
    fake.set_hole(symbol_case.symbol, 100, 3)
    first = run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    assert first["gapsPending"] == 1
    attempts_before = int(pg.list_gaps(conn, symbol_case.symbol)[0]["attempts"])
    assert attempts_before >= 1  # 轮末已经尝试过一次

    fake.ignore_start_time = True
    with pytest.raises(SyncError) as excinfo:
        run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))
    assert excinfo.value.code == "BACKFILL_BOUNDARY_VIOLATION"
    # 越界不是「缺口回补的一次失败」，attempts 不能被计进去
    gaps = pg.list_gaps(conn, symbol_case.symbol)
    assert len(gaps) == 1
    assert int(gaps[0]["attempts"]) == attempts_before


def test_first_pull_plan_is_persisted_before_writing_and_cleared_after(
    conn: DbConn,
    fake: FakeExchange,
    pg_dsn: str,
    tmp_path: Path,
    symbol_case: SymbolCase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """R-8.3 / R-8.6：规模必须在写第一批数据**之前**落进 sync_state，跑完后清空。

    只放进一次性返回值与日志是不够的：常驻形态下控制面只能读库，
    既看不到「要拉多少」这个决策依据，也拿不到进度的分母。
    """
    now = fixed_now(fake, symbol_case.symbol)
    observed: list[tuple[int, int]] = []
    real_write = pg.write_bars

    def spy(target: DbConn, symbol: str, rows: Sequence[Kline], strategy: str) -> int:
        row = target.execute(
            "SELECT plan_bars, plan_requests FROM sync_state WHERE exchange = %s AND symbol = %s",
            (EXCHANGE, symbol),
        ).fetchone()
        if row is not None and row["plan_bars"] is not None:
            observed.append((int(row["plan_bars"]), int(row["plan_requests"])))
        return real_write(target, symbol, rows, strategy)

    monkeypatch.setattr(pg, "write_bars", spy)
    summary = run_sync(_options(fake, pg_dsn, tmp_path, symbol_case.symbol, now))

    estimate = _nested(summary, "estimate")
    assert observed, "首批写入之前规模必须已经写进 sync_state"
    assert observed[0][0] == int(cast(int, estimate["bars"]))
    assert observed[0][1] == int(cast(int, estimate["requests"]))

    # 跑完之后清空：`rows` 本身就是权威行数，留着分母会被读成「差一根没跑完」
    state = pg.read_state(conn, EXCHANGE, symbol_case.symbol)
    assert state is not None
    assert state["plan_bars"] is None
    assert state["plan_requests"] is None


def test_ensure_schema_rejects_database_ahead_of_code(conn: DbConn) -> None:
    """库比代码新同样是版本不匹配，必须报错（R-1.3 / R-19.7）。"""
    conn.execute("INSERT INTO schema_migrations (version, applied_at) VALUES ('999_future', 0)")
    try:
        with pytest.raises(SyncError) as excinfo:
            pg.ensure_schema(conn)
        assert excinfo.value.code == "SCHEMA_VERSION_MISMATCH"
    finally:
        conn.execute("DELETE FROM schema_migrations WHERE version = '999_future'")
    pg.ensure_schema(conn)  # 清掉之后必须恢复正常


def test_weight_status_reports_zero_after_window_rolls(conn: DbConn) -> None:
    """R-20.4 要的是**当前窗口**的使用率：窗口滚动后不能继续报上一窗口的残留。"""
    budget = WeightBudget(conn, 1920)
    budget.reserve(5)
    conn.execute(
        "UPDATE weight_budget SET window_from = %s, used = 999 WHERE id = 1",
        (int(time.time() * 1000) - 2 * WINDOW_MS,),
    )
    status = budget.status()
    assert status["used"] == 0
    assert status["utilization"] == 0.0


def test_observe_used_weight_only_increases(conn: DbConn) -> None:
    """交易所头部的账号级用量必须并进本地预算，且**只增不减**（R-20.4 / AC-17）。"""
    budget = WeightBudget(conn, 1920)
    budget.reserve(5)
    budget.observe_used_weight(50)
    row = conn.execute("SELECT used FROM weight_budget WHERE id = 1").fetchone()
    assert row is not None
    assert int(row["used"]) == 50
    # 一次偏小的观测不能把计数拉回去（保守方向）
    budget.observe_used_weight(10)
    row = conn.execute("SELECT used FROM weight_budget WHERE id = 1").fetchone()
    assert row is not None
    assert int(row["used"]) == 50


def test_observe_used_weight_survives_window_rollover(conn: DbConn) -> None:
    """窗口滚动后回写的观测值必须算进**新窗口**，不能被旧窗口的残留顶掉（R-20.8 / AC-17）。

    时序：本地窗口起点在 2 分钟前、``used`` 还是旧窗口的 999；此时交易所头部报 30——
    若照旧值只做「只增不减」，30 < 999 就被丢掉，而下一轮 reserve 把 used 归零后，
    新窗口的账本直接少了这 30。
    """
    budget = WeightBudget(conn, 1920)
    conn.execute(
        "INSERT INTO weight_budget (id, window_from, used) VALUES (1, %s, 999)"
        " ON CONFLICT (id) DO UPDATE SET window_from = EXCLUDED.window_from, used = EXCLUDED.used,"
        " pause_until = NULL",
        (int(time.time() * 1000) - 2 * WINDOW_MS,),
    )
    budget.observe_used_weight(30)
    row = conn.execute("SELECT window_from, used FROM weight_budget WHERE id = 1").fetchone()
    assert row is not None
    assert int(row["used"]) == 30
    # 窗口起点同时被重新锚定，否则这次写入会在下一次 reserve 时被当成旧窗口残留清掉。
    assert int(time.time() * 1000) - int(row["window_from"]) < WINDOW_MS
