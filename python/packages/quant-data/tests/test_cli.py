"""跨语言接缝的端到端测试：``python -m quant_data`` 真进程 + 真实 PG + 本地 mock 交易所。

这些用例覆盖 AGENTS.md 硬性约定 2 的全部内容：
- 成功 → 退出码 0，stdout **恰好一个** JSON 文档，日志走 stderr；
- 失败 → 退出码非 0，stderr **最后一行**是 ``QUANT_DATA_ERROR {...}``；
- DSN 只从 ``TRADE_TOOL_PG_DSN`` 读，基址只从 ``TRADE_TOOL_BINANCE_BASE_URL`` 读。

它们跑的是**真实子进程 + 真实 psycopg 连接 + 真实 urllib 通路**，
因此 SQL 语法错误、锁语义、事务边界这类只在连库时才暴露的问题会被 CI 直接拦住。
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

from conftest import FakeExchange, SymbolCase, cli_env, fixed_now, serve_exchange
from quant_data import pg
from quant_data.pg import DbConn

SYMBOL = "E2EUSDC"
#: 合成标的：onboard 固定在 2024-01-03，400 根已收盘 + 1 根进行中。
CASE = SymbolCase(symbol=SYMBOL, onboard_date=1_704_285_900_000, bars=400)


def _run(args: list[str], env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "quant_data", *args],
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )


def _error_line(stderr: str) -> dict[str, Any]:
    lines = [line for line in stderr.strip().splitlines() if line.strip()]
    assert lines, "失败时 stderr 不得为空"
    last = lines[-1]
    assert last.startswith("QUANT_DATA_ERROR "), f"stderr 最后一行必须是结构化错误: {last!r}"
    payload: dict[str, Any] = json.loads(last[len("QUANT_DATA_ERROR ") :])
    assert set(payload) == {"code", "message", "details"}
    return payload


def test_end_to_end_sync_then_idempotent_repeat(conn: DbConn, tmp_path: Path) -> None:
    """真实子进程跑完整轮同步：先全量，再重复一轮 added = 0（AC-2 / AC-3 / AC-8）。"""
    fake = FakeExchange(cases=(CASE,))
    now = fixed_now(fake, SYMBOL)
    with serve_exchange(fake) as base_url:
        env = cli_env(str(pg_dsn_of(conn)), base_url)
        first = _run(
            ["sync", "--exchange", "binance", "--symbol", SYMBOL, "--now-ms", str(now)], env
        )
    assert first.returncode == 0, first.stderr
    # stdout 必须只有一个 JSON 文档，且不含任何 K 线数据（R-2.1 / AC-8）。
    assert first.stdout.count("\n") == 1
    summary: dict[str, Any] = json.loads(first.stdout)
    assert set(summary) == {
        "symbol",
        "added",
        "from",
        "to",
        "writeStrategy",
        "watermark",
        "gapsFilled",
        "gapsPending",
        "gapsAbandoned",
        "requests",
        "weight",
        "metadataStale",
        "estimate",
    }
    assert summary["from"] == CASE.onboard_date
    assert summary["writeStrategy"] == "upsert"
    assert summary["added"] == CASE.bars - 1
    # summary 里只有计数与时间范围，没有任何一根 bar 的价格数据（AC-8）。
    assert "close" not in first.stdout and "open" not in first.stdout
    assert "volume" not in first.stdout
    assert len(first.stdout) < 1024

    stored = [
        int(row["time"])
        for row in conn.execute(
            "SELECT time FROM klines_1m WHERE symbol = %s ORDER BY time", (SYMBOL,)
        ).fetchall()
    ]
    assert len(stored) == CASE.bars - 1
    assert stored[-1] == fake.closed_through(SYMBOL)

    with serve_exchange(fake) as base_url:
        env = cli_env(str(pg_dsn_of(conn)), base_url)
        second = _run(
            ["sync", "--exchange", "binance", "--symbol", SYMBOL, "--now-ms", str(now)], env
        )
    assert second.returncode == 0, second.stderr
    repeat: dict[str, Any] = json.loads(second.stdout)
    assert repeat["added"] == 0
    assert "estimate" not in repeat  # 只有首次全量才带规模预估（R-8.3）
    assert repeat["watermark"] == stored[-1]
    assert len(
        conn.execute("SELECT time FROM klines_1m WHERE symbol = %s", (SYMBOL,)).fetchall()
    ) == len(stored)


def test_end_to_end_verify_and_backfill(conn: DbConn, tmp_path: Path) -> None:
    fake = FakeExchange(cases=(CASE,))
    now = fixed_now(fake, SYMBOL)
    with serve_exchange(fake) as base_url:
        env = cli_env(str(pg_dsn_of(conn)), base_url)
        assert _run(["sync", "--symbol", SYMBOL, "--now-ms", str(now)], env).returncode == 0
        gap_start = CASE.onboard_date + 50 * 60_000
        conn.execute(
            "DELETE FROM klines_1m WHERE symbol = %s AND time BETWEEN %s AND %s",
            (SYMBOL, gap_start, gap_start + 2 * 60_000),
        )
        verify = _run(["verify", "--exchange", "binance", "--symbol", SYMBOL], env)
        assert verify.returncode == 0, verify.stderr
        payload = json.loads(verify.stdout)
        assert payload == {
            "symbol": SYMBOL,
            "scannedRows": CASE.bars - 4,
            "gapsFound": 1,
            "verifiedUpTo": gap_start - 60_000,
        }
        backfill = _run(
            [
                "backfill",
                "--symbol",
                SYMBOL,
                "--from",
                str(gap_start),
                "--to",
                str(gap_start + 2 * 60_000),
            ],
            env,
        )
        assert backfill.returncode == 0, backfill.stderr
        assert json.loads(backfill.stdout)["added"] == 3
        assert pg.list_gaps(conn, SYMBOL) == []


def test_end_to_end_unknown_symbol_fails_with_structured_error(
    conn: DbConn, tmp_path: Path
) -> None:
    """未知标的 → 非 0 退出码 + stderr 最后一行含 SYMBOL_NOT_FOUND（AC-13）。"""
    fake = FakeExchange(cases=(CASE,))
    with serve_exchange(fake) as base_url:
        env = cli_env(str(pg_dsn_of(conn)), base_url)
        result = _run(["resolve", "--symbol", "NOSUCHUSDC", "--now-ms", "0"], env)
    assert result.returncode != 0
    assert result.stdout == ""
    assert _error_line(result.stderr)["code"] == "SYMBOL_NOT_FOUND"


def test_end_to_end_missing_dsn_fails_with_config_invalid(tmp_path: Path) -> None:
    """DSN 缺失 → CONFIG_INVALID，不静默兜底、不回退到合成数据（AC-12 / AGENTS.md 约定 8）。"""
    fake = FakeExchange(cases=(CASE,))
    with serve_exchange(fake) as base_url:
        env = cli_env("", base_url)
        env["TRADE_TOOL_PG_DSN"] = ""
        result = _run(["sync", "--symbol", SYMBOL, "--now-ms", "0"], env)
    assert result.returncode != 0
    assert _error_line(result.stderr)["code"] == "CONFIG_INVALID"


def test_end_to_end_exchange_error_is_classified(conn: DbConn, tmp_path: Path) -> None:
    """交易所 5xx → EXCHANGE_ERROR，错误信息里带交易所原文，不静默兜底（R-14 A.3）。"""
    fake = FakeExchange(cases=(CASE,))
    fake.kline_status = 500
    with serve_exchange(fake) as base_url:
        env = cli_env(str(pg_dsn_of(conn)), base_url)
        result = _run(["sync", "--symbol", SYMBOL, "--now-ms", "0"], env)
    assert result.returncode != 0
    payload = _error_line(result.stderr)
    assert payload["code"] == "EXCHANGE_ERROR"
    assert "mock down" in payload["details"]["body"]


def test_end_to_end_metadata_commands(conn: DbConn, tmp_path: Path) -> None:
    """symbols / estimate 走同一条真实通路，且 estimate 不需要数据库（R-8.3 / AC-14）。"""
    fake = FakeExchange(cases=(CASE, SymbolCase("OTHERSUSDC", 1_717_200_000_000, 10)))
    now = fixed_now(fake, SYMBOL)
    with serve_exchange(fake) as base_url:
        env = cli_env(str(pg_dsn_of(conn)), base_url)
        env.pop("TRADE_TOOL_PG_DSN")
        symbols = _run(["symbols", "--now-ms", str(now), "--meta-dir", str(tmp_path)], env)
        estimate = _run(["estimate", "--symbol", SYMBOL, "--now-ms", str(now)], env)
    assert symbols.returncode == 0, symbols.stderr
    listing = json.loads(symbols.stdout)
    assert [entry["symbol"] for entry in listing["symbols"]] == sorted([SYMBOL, "OTHERSUSDC"])
    assert listing["count"] == 2
    assert estimate.returncode == 0, estimate.stderr
    plan = json.loads(estimate.stdout)
    assert plan["from"] == CASE.onboard_date
    assert plan["requests"] == 1 and plan["weight"] == 10


def test_generate_stays_byte_compatible(conn: DbConn) -> None:
    """既有子命令行为不变：合成源仍然可用，且不输出 QUANT_DATA_ERROR 行。"""
    fake = FakeExchange(cases=(CASE,))
    with serve_exchange(fake) as base_url:
        env = cli_env(str(pg_dsn_of(conn)), base_url)
        result = _run(["generate", "--symbol", "BTCUSDT", "--interval", "1h", "--bars", "3"], env)
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["symbol"] == "BTCUSDT"
    assert len(payload["bars"]) == 3
    assert "QUANT_DATA_ERROR" not in result.stderr


def test_concurrent_cli_runs_are_serialized(conn: DbConn, tmp_path: Path) -> None:
    """同一标的并发两个进程：一个跑完，另一个被拒绝而不是交错写（AC-19）。"""
    fake = FakeExchange(cases=(CASE,))
    now = fixed_now(fake, SYMBOL)
    with serve_exchange(fake) as base_url:
        env = cli_env(str(pg_dsn_of(conn)), base_url)
        held = pg.SymbolLock.acquire(str(pg_dsn_of(conn)), "binance", SYMBOL, now)
        try:
            rejected = _run(["sync", "--symbol", SYMBOL, "--now-ms", str(now)], env)
        finally:
            held.release()
    assert rejected.returncode != 0
    assert _error_line(rejected.stderr)["code"] == "SYNC_ALREADY_RUNNING"
    remaining = conn.execute(
        "SELECT count(*) AS n FROM klines_1m WHERE symbol = %s", (SYMBOL,)
    ).fetchone()
    assert remaining is not None
    assert int(remaining["n"]) == 0


def pg_dsn_of(conn: DbConn) -> str:
    """从测试连接反推同一个 DSN（含 search_path），供子进程使用。"""
    info = conn.info
    host, port = info.host, info.port
    user = info.user
    dbname = info.dbname
    password = info.password
    return (
        f"postgresql://{user}:{password}@{host}:{port}/{dbname}"
        f"?options=-c%20search_path%3D{TEST_SCHEMA_NAME(conn)}"
    )


def TEST_SCHEMA_NAME(conn: DbConn) -> str:  # noqa: N802 - 测试辅助函数
    row = conn.execute("SELECT current_schema() AS schema").fetchone()
    assert row is not None
    return str(row["schema"])
