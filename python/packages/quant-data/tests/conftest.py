"""quant-data 的测试夹具。

两条硬要求（R-16.2 / R-16.5）：
- **绝不访问真实网络**：所有出网都走 ``FakeExchange``（实现 ``Transport`` 协议）；
- **绝不连非测试库**：测试用独立的 schema（``search_path`` 注入 DSN），
  迁移直接执行仓库里的 ``packages/data/sql/*.sql``，schema 是唯一来源（R-2.5）。

标的全部是合成名（R-5.1 / AC-15：源码里不得出现真实合约名，测试夹具是唯一例外），
并且各自 ``onboardDate`` 不同，用来证明首次拉取起点真的来自运行时元数据。
"""

from __future__ import annotations

import json
import os
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlsplit

import psycopg
import pytest
from quant_data import pg
from quant_data.binance import ONE_MINUTE_MS, align_bar_start
from quant_data.errors import SyncError
from quant_data.http import HttpResponse
from quant_data.metadata import reset_singleton
from quant_data.pg import DbConn

#: tests/ -> quant-data -> packages -> python -> 仓库根
REPO_ROOT = Path(__file__).resolve().parents[4]
SQL_DIR = REPO_ROOT / "packages" / "data" / "sql"

#: 测试用 PG（容器 trade-tool-pg）。可用环境变量覆盖，但**必须**是测试实例。
ADMIN_DSN = os.environ.get(
    "TRADE_TOOL_TEST_PG_DSN", "postgresql://trade:trade@127.0.0.1:5432/trade_tool"
)
TEST_SCHEMA = f"test_quant_data_{os.getpid()}"


def _dsn_for(schema: str) -> str:
    return f"{ADMIN_DSN}?options=-c%20search_path%3D{schema}"


def _admin() -> psycopg.Connection[Any]:
    return psycopg.connect(ADMIN_DSN, autocommit=True)


@pytest.fixture(scope="session")
def pg_dsn() -> Iterator[str]:
    """独立测试 schema：建库、应用迁移、会话结束删除。"""
    admin = _admin()
    try:
        admin.execute(f'DROP SCHEMA IF EXISTS "{TEST_SCHEMA}" CASCADE')
        admin.execute(f'CREATE SCHEMA "{TEST_SCHEMA}"')
    finally:
        admin.close()
    dsn = _dsn_for(TEST_SCHEMA)
    conn = pg.connect(dsn)
    try:
        pg.apply_migration_files(conn, SQL_DIR, 0)
    finally:
        conn.close()
    try:
        yield dsn
    finally:
        admin = _admin()
        try:
            admin.execute(f'DROP SCHEMA IF EXISTS "{TEST_SCHEMA}" CASCADE')
        finally:
            admin.close()


@pytest.fixture()
def conn(pg_dsn: str) -> Iterator[DbConn]:
    """每个用例一条干净连接：业务表清空、进程内元数据单例清空。"""
    connection = pg.connect(pg_dsn)
    try:
        pg.truncate_all(connection)
        reset_singleton()
        yield connection
    finally:
        connection.close()
        reset_singleton()


@dataclass(frozen=True, slots=True)
class SymbolCase:
    """一个合成的可交易标的。``onboard_date`` 各不相同（附录 A.1 的事实）。"""

    symbol: str
    onboard_date: int
    bars: int
    contract_type: str = "PERPETUAL"
    status: str = "TRADING"


#: 三个合成标的，起始时间相差一年以上：首个标的的 onboard 决定了首次全量的起点。
SYMBOL_CASES: tuple[SymbolCase, ...] = (
    SymbolCase(symbol="ALPHAUSDC", onboard_date=1_704_285_900_000, bars=400),
    SymbolCase(symbol="BETATUSDC", onboard_date=1_717_200_000_000, bars=700),
    SymbolCase(symbol="GAMMAUSDC", onboard_date=1_741_294_200_000, bars=250),
)


@pytest.fixture(params=SYMBOL_CASES, ids=[case.symbol for case in SYMBOL_CASES])
def symbol_case(request: pytest.FixtureRequest) -> SymbolCase:
    """R-16.6：必须参数化到多个标的。"""
    case: SymbolCase = request.param
    return case


def bar_start(case: SymbolCase) -> int:
    """该标的**第一根 bar**的开盘时间。

    真实的 1m bar 开盘时间必然对齐到 60_000 边界；``onboardDate`` 未必对齐，
    因此夹具生成的 bar 从对齐后的时间开始（与交易所行为一致）。
    """
    return align_bar_start(case.onboard_date)


def exchange_entry(case: SymbolCase) -> dict[str, Any]:
    return {
        "symbol": case.symbol,
        "status": case.status,
        "contractType": case.contract_type,
        "onboardDate": case.onboard_date,
        "pricePrecision": 8,
    }


def bar_row(time_ms: int, base: float) -> list[Any]:
    """**真实线格式**的 12 字段 K 线（附录 A.2）。

    交易所实际返回的是混合类型：下标 0 / 6（openTime / closeTime）是 JSON 数字，
    下标 1-5 与 7（OHLCV / quoteVolume）是 **JSON 字符串**，下标 8（trades）是 JSON 数字。
    解析层必须照实处理这个形状，所以夹具不能返回全数字。
    """
    return [
        time_ms,
        str(base),
        str(base + 1.5),
        str(base - 1.5),
        str(base + 0.5),
        "12.5",
        time_ms + ONE_MINUTE_MS - 1,
        str(base * 20.0),
        42,
        str(base * 6.0),
        str(base * 12.0),
        "0",
    ]


def bar_row_numeric(time_ms: int, base: float) -> list[Any]:
    """全 JSON 数字的 K 线：解析层同样必须接受（部分 mock / 未来的返回格式）。"""
    return [
        time_ms,
        base,
        base + 1.5,
        base - 1.5,
        base + 0.5,
        12.5,
        time_ms + ONE_MINUTE_MS - 1,
        base * 20.0,
        42,
        base * 6.0,
        base * 12.0,
        0,
    ]


@dataclass
class FakeExchange:
    """确定性的假交易所：按 URL 参数返回 exchangeInfo / klines，绝不出网。"""

    cases: tuple[SymbolCase, ...]
    extra_symbols: tuple[dict[str, Any], ...] = ()
    ignore_start_time: bool = False
    info_status: int = 200
    kline_status: int = 200
    fail_on_kline_call: int | None = None
    rate_limit_on_call: int | None = None
    info_calls: int = 0
    kline_calls: list[dict[str, Any]] = field(default_factory=list)
    _bar_base: dict[str, float] = field(default_factory=dict)
    _holes: dict[str, tuple[int, int]] = field(default_factory=dict)
    _rows_cache: dict[str, dict[int, list[Any]]] = field(default_factory=dict)

    def __post_init__(self) -> None:
        for index, case in enumerate(self.cases):
            self._bar_base[case.symbol] = 100.0 + index

    def closed_through(self, symbol: str) -> int:
        """该标的最后一根**已收盘** bar 的开盘时间（末位那根是进行中的）。"""
        case = next(c for c in self.cases if c.symbol == symbol)
        return bar_start(case) + (case.bars - 2) * ONE_MINUTE_MS

    def in_progress(self, symbol: str) -> int:
        """交易所返回的最后一根：进行中、未收盘（R-10.1）。"""
        case = next(c for c in self.cases if c.symbol == symbol)
        return bar_start(case) + (case.bars - 1) * ONE_MINUTE_MS

    def rows(self, symbol: str) -> dict[int, list[Any]]:
        case = next(c for c in self.cases if c.symbol == symbol)
        base = self._bar_base[symbol]
        cached = self._rows_cache.get(symbol)
        if cached is None:
            start = bar_start(case)
            cached = {
                start + i * ONE_MINUTE_MS: bar_row(start + i * ONE_MINUTE_MS, base)
                for i in range(case.bars)
            }
            self._rows_cache[symbol] = cached
        return cached

    def advance(self, symbol: str, bars: int) -> None:
        """让交易所多出若干根已收盘 bar（模拟时间前进）。"""
        case = next(c for c in self.cases if c.symbol == symbol)
        object.__setattr__(case, "bars", case.bars + bars)
        self._rows_cache.pop(symbol, None)  # 缓存失效，下一页重新生成

    def set_hole(self, symbol: str, start_index: int, count: int) -> None:
        """让交易所「没有」这一段历史：模拟永久性缺口（R-11.B9 的上界来源）。"""
        self._holes[symbol] = (start_index, count)

    def clear_hole(self, symbol: str) -> None:
        """缺口被外部补齐（人工兜底或交易所补数据）。"""
        self._holes.pop(symbol, None)

    def exchange_info_payload(self) -> dict[str, Any]:
        return {
            "timezone": "UTC",
            "symbols": [exchange_entry(case) for case in self.cases] + list(self.extra_symbols),
        }

    def get(self, url: str, *, timeout_ms: int = 0) -> HttpResponse:
        parsed = urlsplit(url)
        query = dict(parse_qsl(parsed.query))
        if parsed.path.endswith("/exchangeInfo"):
            self.info_calls += 1
            if self.info_status != 200:
                return HttpResponse(self.info_status, b'{"code":-1,"msg":"mock down"}', {})
            return _json_response(self.exchange_info_payload())
        if not parsed.path.endswith("/klines"):  # pragma: no cover - 夹具自身出错
            raise AssertionError(f"未预期的请求路径: {parsed.path}")

        symbol = query["symbol"]
        start = int(query["startTime"]) if "startTime" in query else None
        end = int(query["endTime"]) if "endTime" in query else None
        limit = int(query.get("limit", "500"))
        self.kline_calls.append({"symbol": symbol, "start": start, "end": end, "limit": limit})
        if self.fail_on_kline_call == len(self.kline_calls):
            raise SyncError("NETWORK_ERROR", "mock 断网", {"url": url})
        if self.rate_limit_on_call == len(self.kline_calls):
            return HttpResponse(
                429, b'{"code":-1003,"msg":"Too many requests."}', {"Retry-After": "3"}
            )
        if self.kline_status != 200:
            return HttpResponse(self.kline_status, b'{"code":-1,"msg":"mock down"}', {})
        rows = self._page(symbol, start, end, limit)
        return _json_response(rows)

    def _page(self, symbol: str, start: int | None, end: int | None, limit: int) -> list[Any]:
        rows = self.rows(symbol)
        case = next(c for c in self.cases if c.symbol == symbol)
        hole = self._holes.get(symbol)
        if hole is not None:
            hole_start, hole_count = hole
            blocked = range(hole_start, hole_start + hole_count)
            rows = {
                time_ms: row
                for time_ms, row in rows.items()
                if (time_ms - bar_start(case)) // ONE_MINUTE_MS not in blocked
            }
        selected = [
            row
            for time_ms, row in sorted(rows.items())
            if (self.ignore_start_time or start is None or time_ms >= start)
            and (end is None or time_ms <= end)
        ]
        # 与交易所一致：超出 limit 时从起点顺序截断，末位即「进行中」的 bar。
        return selected[:limit]


def _json_response(payload: object) -> HttpResponse:
    body = json.dumps(payload).encode("utf-8")
    return HttpResponse(200, body, {"Content-Type": "application/json"})


@contextmanager
def local_http_server(status: int, headers: dict[str, str]) -> Iterator[str]:
    """起一个本地 mock HTTP server（仅回环，不出网），验证 stdlib urllib 真实通路。"""
    body = json.dumps({"symbols": []}).encode("utf-8")

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self.send_response(status)
            for key, value in headers.items():
                self.send_header(key, value)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@contextmanager
def serve_exchange(fake: FakeExchange) -> Iterator[str]:
    """把 :class:`FakeExchange` 挂到本地 HTTP server 上。

    端到端用例用 ``TRADE_TOOL_BINANCE_BASE_URL`` 指向它，从而让**真实的** urllib 通路
    （URL 拼装、权重预留、错误分类）参与测试，而不是只测注入的假 transport（R-16.5）。
    """

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            response = fake.get(f"http://mock.local{self.path}", timeout_ms=1000)
            self.send_response(response.status)
            for key, value in response.headers.items():
                self.send_header(key, value)
            self.send_header("Content-Length", str(len(response.body)))
            self.end_headers()
            self.wfile.write(response.body)

        def log_message(self, format: str, *args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def cli_env(pg_dsn: str, base_url: str) -> dict[str, str]:
    """``python -m quant_data`` 子进程的环境：DSN 走环境变量，基址可被 mock 覆盖。"""
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(
        [
            str(REPO_ROOT / "python" / "packages" / "quant-core" / "src"),
            str(REPO_ROOT / "python" / "packages" / "quant-data" / "src"),
        ]
    )
    env["TRADE_TOOL_PG_DSN"] = pg_dsn
    env["TRADE_TOOL_BINANCE_BASE_URL"] = base_url
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return env


@pytest.fixture()
def fake(symbol_case: SymbolCase) -> FakeExchange:
    return FakeExchange(cases=(symbol_case,))


def fixed_now(fake: FakeExchange, symbol: str) -> int:
    """固定时钟：进行中的 bar 刚开始不久，因此「进行中」的那根确实未收盘。"""
    return fake.in_progress(symbol) + 30_000
