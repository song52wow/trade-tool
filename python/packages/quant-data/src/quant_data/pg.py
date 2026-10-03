"""PostgreSQL 存储层。

**表结构以 ``packages/data/sql/`` 的迁移文件为唯一来源**（R-2.5）——本模块不持有影子定义，
只在代码里引用已存在的表名与列名。改 schema 必须同提交更新两侧读写代码（AC-25）。

要点：
- 1m K 线批量写入用 ``COPY`` 进临时表再 ``INSERT … SELECT``（R-3.1）：
  ``COPY`` 本身不支持 ``ON CONFLICT``，而写入策略由起点决定（R-9.3），故用两级写法。
- 单写者（R-3.3）与断点续传（R-3.2 / R-8.5）见 ``SymbolLock`` 与 ``write_bars``。
- 水位权威来源永远是 ``klines_1m`` 的 ``max(time)``（R-9.6）。
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import psycopg
from psycopg.rows import dict_row

from .binance import ONE_MINUTE_MS, Kline
from .errors import SyncError

#: DSN 只从环境变量读取，避免密码/连接串出现在进程列表里。
DSN_ENV = "TRADE_TOOL_PG_DSN"

#: 启动时要求已应用的迁移版本（R-1.3 / R-19.7：不匹配就报错，不按旧结构继续跑）。
REQUIRED_MIGRATION_VERSIONS: frozenset[str] = frozenset({"001_init"})

#: 必需的表（缺表等价于 schema 未迁移，报 SCHEMA_VERSION_MISMATCH）。
REQUIRED_TABLES: frozenset[str] = frozenset(
    {
        "schema_migrations",
        "klines_1m",
        "contract_spec",
        "sync_state",
        "gaps",
        "symbols",
        "weight_budget",
    }
)

#: 全表缺口扫描的下界（首次建立基线时用，bigint 下界足够小）。
PG_MIN_TIME = -(2**62)

#: 锁等待超时：抢不到锁立刻报 SYNC_ALREADY_RUNNING，不排队等待（AC-19）。
LOCK_TIMEOUT = "250ms"

DbRow = dict[str, Any]

#: 带 dict 行工厂的连接类型（本模块所有查询都按列名取值）。
DbConn = psycopg.Connection[DbRow]


def _require_row(row: DbRow | None, context: str) -> DbRow:
    """查询必须命中一行；不命中就报错，不静默返回空值。"""
    if row is None:
        raise SyncError(
            "DB_TRANSACTION_ROLLBACK", f"查询没有返回行: {context}", {"context": context}
        )
    return row


def connect(dsn: str | None = None, *, autocommit: bool = True) -> DbConn:
    """打开连接。默认 autocommit，由调用方用显式 ``with conn.transaction():`` 划事务边界。"""
    resolved = dsn if dsn is not None else os.environ.get(DSN_ENV)
    if not resolved:
        raise SyncError(
            "CONFIG_INVALID",
            f"缺少 PostgreSQL 连接串：请设置环境变量 {DSN_ENV}",
            {"env": DSN_ENV},
        )
    try:
        return psycopg.connect(resolved, autocommit=autocommit, row_factory=dict_row)
    except psycopg.OperationalError as exc:
        raise SyncError(
            "DB_CONNECTION_FAILED",
            f"无法连接 PostgreSQL: {exc}",
            {"dsnHost": _dsn_hint(resolved)},
        ) from exc


def _dsn_hint(dsn: str) -> str:
    """只保留 host/port/db，密码绝不出现在错误信息里。"""
    parts = urlsplit(dsn)
    if not parts.hostname:
        return "unknown"
    return f"{parts.hostname}:{parts.port or 5432}{parts.path}"


def ensure_schema(conn: DbConn) -> None:
    """校验 schema 已迁移到所需版本（R-1.3）。不匹配就报错，不静默按旧 schema 运行。"""
    missing_tables = sorted(
        name
        for name in REQUIRED_TABLES
        if _require_row(
            conn.execute("SELECT to_regclass(%s) AS reg", (name,)).fetchone(),
            f"to_regclass({name})",
        )["reg"]
        is None
    )
    if missing_tables:
        raise SyncError(
            "SCHEMA_VERSION_MISMATCH",
            f"数据库缺少必需的表: {', '.join(missing_tables)}",
            {"missingTables": missing_tables, "required": sorted(REQUIRED_MIGRATION_VERSIONS)},
        )
    applied = {
        str(row["version"])
        for row in conn.execute("SELECT version FROM schema_migrations").fetchall()
    }
    missing_versions = sorted(REQUIRED_MIGRATION_VERSIONS - applied)
    if missing_versions:
        raise SyncError(
            "SCHEMA_VERSION_MISMATCH",
            f"数据库未应用迁移: {', '.join(missing_versions)}（先执行 db migrate）",
            {"missingVersions": missing_versions, "applied": sorted(applied)},
        )


def apply_migration_files(
    conn: DbConn,
    sql_dir: Path,
    now_ms: int,
) -> list[str]:
    """按文件名顺序应用 ``.sql`` 迁移并记录版本；可重复执行且幂等（R-1.2 / AC-1）。

    迁移文件是 schema 的唯一来源；本函数只负责执行与记账，不定义表结构。
    """
    files = sorted(sql_dir.glob("*.sql"))
    if not files:
        raise SyncError(
            "CONFIG_INVALID", f"迁移目录里没有 .sql 文件: {sql_dir}", {"dir": str(sql_dir)}
        )
    applied: list[str] = []
    for path in files:
        version = path.stem
        with conn.transaction():
            # schema_migrations 自身由首个迁移创建，因此先探表再查版本。
            has_table = (
                _require_row(
                    conn.execute("SELECT to_regclass('schema_migrations') AS reg").fetchone(),
                    "to_regclass(schema_migrations)",
                )["reg"]
                is not None
            )
            already = (
                has_table
                and conn.execute(
                    "SELECT 1 FROM schema_migrations WHERE version = %s", (version,)
                ).fetchone()
                is not None
            )
            if not already:
                conn.execute(path.read_text(encoding="utf-8"))
                conn.execute(
                    "INSERT INTO schema_migrations (version, applied_at) VALUES (%s, %s)"
                    " ON CONFLICT (version) DO NOTHING",
                    (version, now_ms),
                )
        applied.append(version)
    return applied


class SymbolLock:
    """单标的单写者锁（R-3.3 / AC-19）。

    实现说明（与需求的 SQL 形状一致）：
    - 拿锁时在**独立连接**的事务里 ``INSERT … ON CONFLICT DO NOTHING`` 建行，
      再 ``SELECT … FROM sync_state WHERE exchange=? AND symbol=? FOR UPDATE``；
    - 该行锁只能覆盖一个事务，无法覆盖「整轮同步」（一轮包含多个分批事务 R-3.2），
      因此整轮级别的互斥用**同一连接上的 session 级 advisory lock** 承担：
      抢不到立即抛 ``SYNC_ALREADY_RUNNING``，绝不排队、绝不与另一轮交错写；
    - 写事务内（每批）仍会 ``FOR UPDATE`` 该行，保证「水位推进」与「数据写入」同事务（R-19.5），
      且所有事务的加锁顺序一致，不会死锁（R-21.6）。

    释放：解除 advisory lock 并关连接；异常路径同样释放。
    """

    def __init__(self, conn: DbConn, exchange: str, symbol: str) -> None:
        self._conn = conn
        self._exchange = exchange
        self._symbol = symbol

    @classmethod
    def acquire(
        cls,
        dsn: str | None,
        exchange: str,
        symbol: str,
        now_ms: int,
    ) -> SymbolLock:
        conn = connect(dsn)
        try:
            with conn.transaction():
                # SET LOCAL 不接受绑定参数（`SET LOCAL lock_timeout = $1` 是语法错误），
                # 必须走 set_config(name, value, is_local)。
                conn.execute("SELECT set_config('lock_timeout', %s, true)", (LOCK_TIMEOUT,))
                conn.execute(
                    "INSERT INTO sync_state (exchange, symbol, status, updated_at)"
                    " VALUES (%s, %s, 'paused', %s) ON CONFLICT (exchange, symbol) DO NOTHING",
                    (exchange, symbol, now_ms),
                )
                row = conn.execute(
                    "SELECT status FROM sync_state WHERE exchange = %s AND symbol = %s FOR UPDATE",
                    (exchange, symbol),
                ).fetchone()
                if row is None:  # pragma: no cover - 上一句刚插入过
                    raise SyncError(
                        "DB_TRANSACTION_ROLLBACK", "sync_state 行未建立", {"symbol": symbol}
                    )
                locked = _require_row(
                    conn.execute(
                        "SELECT pg_try_advisory_lock(hashtextextended(%s, 0)) AS locked",
                        (f"{exchange}/{symbol}",),
                    ).fetchone(),
                    "pg_try_advisory_lock",
                )
                if not bool(locked["locked"]):
                    raise SyncError(
                        "SYNC_ALREADY_RUNNING",
                        f"该标的已有同步在运行: {symbol}",
                        {"exchange": exchange, "symbol": symbol},
                    )
        except psycopg.errors.LockNotAvailable as exc:
            conn.close()
            raise SyncError(
                "SYNC_ALREADY_RUNNING",
                f"该标的的 sync_state 行正被锁定: {symbol}",
                {"exchange": exchange, "symbol": symbol},
            ) from exc
        except BaseException:
            conn.close()
            raise
        return cls(conn, exchange, symbol)

    def release(self) -> None:
        try:
            with self._conn.transaction():
                self._conn.execute(
                    "SELECT pg_advisory_unlock(hashtextextended(%s, 0))",
                    (f"{self._exchange}/{self._symbol}",),
                )
        except psycopg.Error:  # pragma: no cover - 释放失败不掩盖主流程结果
            pass
        finally:
            self._conn.close()

    def __enter__(self) -> SymbolLock:
        return self

    def __exit__(self, *_: object) -> None:
        self.release()


_STATE_COLUMNS: frozenset[str] = frozenset(
    {
        "status",
        "watermark",
        "verified_upto",
        "rows",
        "bytes",
        "last_run_at",
        "last_success_at",
        "last_error",
        "error_count",
        "backoff_until",
        "pending_gaps",
    }
)


def ensure_state_row(conn: DbConn, exchange: str, symbol: str, now_ms: int) -> None:
    conn.execute(
        "INSERT INTO sync_state (exchange, symbol, status, updated_at)"
        " VALUES (%s, %s, 'paused', %s) ON CONFLICT (exchange, symbol) DO NOTHING",
        (exchange, symbol, now_ms),
    )


def read_state(conn: DbConn, exchange: str, symbol: str) -> DbRow | None:
    return conn.execute(
        "SELECT * FROM sync_state WHERE exchange = %s AND symbol = %s",
        (exchange, symbol),
    ).fetchone()


def update_state(
    conn: DbConn,
    exchange: str,
    symbol: str,
    *,
    now_ms: int,
    **fields: object,
) -> None:
    """更新 ``sync_state``。列名只接受白名单内的字段，避免拼接外部输入。"""
    unknown = sorted(set(fields) - _STATE_COLUMNS)
    if unknown:
        raise SyncError("CONFIG_INVALID", f"未知的 sync_state 字段: {unknown}", {"fields": unknown})
    ensure_state_row(conn, exchange, symbol, now_ms)
    # 锁顺序统一：先锁 sync_state 行，再动 klines/gaps，全仓库一致 → 不会死锁。
    conn.execute(
        "SELECT 1 FROM sync_state WHERE exchange = %s AND symbol = %s FOR UPDATE",
        (exchange, symbol),
    )
    if not fields:
        conn.execute(
            "UPDATE sync_state SET updated_at = %s WHERE exchange = %s AND symbol = %s",
            (now_ms, exchange, symbol),
        )
        return
    assignments = [f"{column} = %s" for column in fields]
    params: list[object] = list(fields.values())
    assignments.append("updated_at = %s")
    params.append(now_ms)
    conn.execute(
        f"UPDATE sync_state SET {', '.join(assignments)} WHERE exchange = %s AND symbol = %s",
        (*params, exchange, symbol),
    )


def upsert_contract_spec(
    conn: DbConn,
    exchange: str,
    symbol: str,
    contract_type: str,
    status: str,
    onboard_date: int,
    raw: object,
    now_ms: int,
) -> None:
    """持久化 R-7 的解析结果快照。"""
    conn.execute(
        "INSERT INTO contract_spec (exchange, symbol, contract_type, status, onboard_date, raw,"
        " updated_at) VALUES (%s, %s, %s, %s, %s, %s, %s)"
        " ON CONFLICT (exchange, symbol) DO UPDATE SET"
        " contract_type = EXCLUDED.contract_type, status = EXCLUDED.status,"
        " onboard_date = EXCLUDED.onboard_date, raw = EXCLUDED.raw,"
        " updated_at = EXCLUDED.updated_at",
        (
            exchange,
            symbol,
            contract_type,
            status,
            onboard_date,
            json.dumps(raw, ensure_ascii=False, allow_nan=False),
            now_ms,
        ),
    )


def max_time(conn: DbConn, symbol: str) -> int | None:
    """权威水位（R-9.1）：``max(time)``，不加 60_000。"""
    row = _require_row(
        conn.execute(
            "SELECT max(time) AS max_time FROM klines_1m WHERE symbol = %s", (symbol,)
        ).fetchone(),
        "max(time)",
    )
    value = row["max_time"]
    return int(value) if value is not None else None


def min_time(conn: DbConn, symbol: str) -> int | None:
    """该标的最早的一根 bar：缺口扫描的下界，避免扫描尚不存在的时间。"""
    row = conn.execute(
        "SELECT min(time) AS min_time FROM klines_1m WHERE symbol = %s", (symbol,)
    ).fetchone()
    value = _require_row(row, "min(time)")["min_time"]
    return int(value) if value is not None else None


def count_rows(conn: DbConn, symbol: str) -> int:
    row = _require_row(
        conn.execute("SELECT count(*) AS n FROM klines_1m WHERE symbol = %s", (symbol,)).fetchone(),
        "count(klines_1m)",
    )
    return int(row["n"])


def count_rows_between(conn: DbConn, symbol: str, start_ms: int, end_ms: int) -> int:
    row = _require_row(
        conn.execute(
            "SELECT count(*) AS n FROM klines_1m WHERE symbol = %s AND time BETWEEN %s AND %s",
            (symbol, start_ms, end_ms),
        ).fetchone(),
        "count(klines_1m range)",
    )
    return int(row["n"])


def last_bar_time(conn: DbConn, symbol: str) -> int | None:
    row = conn.execute(
        "SELECT time FROM klines_1m WHERE symbol = %s ORDER BY time DESC LIMIT 1", (symbol,)
    ).fetchone()
    return int(row["time"]) if row is not None else None


def bar_close_time(bar_open_ms: int) -> int:
    """1m bar 的收盘时间。schema 不存 close_time，按周期推导（R-10.3 校验用）。"""
    return bar_open_ms + ONE_MINUTE_MS - 1


_STAGE_DDL = """
CREATE TEMP TABLE IF NOT EXISTS stage_bars (
    time          bigint            NOT NULL,
    open          double precision  NOT NULL,
    high          double precision  NOT NULL,
    low           double precision  NOT NULL,
    close         double precision  NOT NULL,
    volume        double precision  NOT NULL,
    quote_volume  double precision,
    trades        bigint
) ON COMMIT PRESERVE ROWS
"""

_COPY_SQL = (
    "COPY stage_bars (time, open, high, low, close, volume, quote_volume, trades)"
    " FROM STDIN (FORMAT BINARY)"
)

_CONFLICT_UPSERT = (
    "DO UPDATE SET open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,"
    " close = EXCLUDED.close, volume = EXCLUDED.volume, quote_volume = EXCLUDED.quote_volume,"
    " trades = EXCLUDED.trades"
)
_CONFLICT_DO_NOTHING = "DO NOTHING"


def write_bars(
    conn: DbConn,
    symbol: str,
    rows: Sequence[Kline],
    strategy: str,
) -> int:
    """批量写入一批 bar，返回**新增**行数（已存在的行不计入 ``added``）。

    写入方式：``COPY``（二进制）进临时表 → ``INSERT … SELECT … ON CONFLICT``（R-3.1）。
    绝不逐行 INSERT：首次全量约 144 万行（R-1.8 / 附录 C.2）。
    """
    if strategy not in {"upsert", "do-nothing"}:
        raise SyncError("CONFIG_INVALID", f"未知写入策略: {strategy}", {"strategy": strategy})
    if not rows:
        return 0
    conn.execute(_STAGE_DDL)
    with conn.cursor() as cur:
        cur.execute("TRUNCATE stage_bars")
        with cur.copy(_COPY_SQL) as copy:
            copy.set_types(
                ["int8", "float8", "float8", "float8", "float8", "float8", "float8", "int8"]
            )
            for row in rows:
                copy.write_row(
                    (
                        row.time,
                        row.open,
                        row.high,
                        row.low,
                        row.close,
                        row.volume,
                        row.quote_volume,
                        row.trades,
                    )
                )
    # 新增行数：先算再写，两条语句在同一个事务里（R-3.5 整批回滚）。
    added_row = _require_row(
        conn.execute(
            "SELECT count(*) AS n FROM stage_bars s"
            " WHERE NOT EXISTS (SELECT 1 FROM klines_1m k WHERE k.symbol = %s AND k.time = s.time)",
            (symbol,),
        ).fetchone(),
        "count(stage_bars new)",
    )
    conflict = _CONFLICT_UPSERT if strategy == "upsert" else _CONFLICT_DO_NOTHING
    conn.execute(
        "INSERT INTO klines_1m (symbol, time, open, high, low, close, volume, quote_volume, trades)"
        f" SELECT %s, time, open, high, low, close, volume, quote_volume, trades FROM stage_bars"
        f" ON CONFLICT (symbol, time) {conflict}",
        (symbol,),
    )
    return int(added_row["n"])


@dataclass(frozen=True, slots=True)
class Gap:
    """一个缺口：闭区间 ``[gap_start, gap_end]`` 内缺 ``missing_rows`` 根 1m bar。"""

    gap_start: int
    gap_end: int
    missing_rows: int


def detect_gaps(conn: DbConn, symbol: str, start_ms: int, end_ms: int) -> list[Gap]:
    """在 ``[start_ms, end_ms]`` 内用窗口函数 ``lag()`` 检测缺口（R-11.A.1）。

    检测在 SQL 里完成，只把**缺口行**取回应用层，不把行情行拉进 Python。
    """
    rows = conn.execute(
        "SELECT gap_start, gap_end, missing_rows FROM ("
        "  SELECT prev + %s AS gap_start,"
        "         time - %s AS gap_end,"
        "         (time - prev) / %s - 1 AS missing_rows"
        "    FROM ("
        "      SELECT time, lag(time) OVER (ORDER BY time) AS prev"
        "        FROM klines_1m WHERE symbol = %s AND time BETWEEN %s AND %s"
        "    ) adjacent"
        "   WHERE prev IS NOT NULL AND time - prev > %s"
        ") gaps ORDER BY gap_start",
        (ONE_MINUTE_MS, ONE_MINUTE_MS, ONE_MINUTE_MS, symbol, start_ms, end_ms, ONE_MINUTE_MS),
    ).fetchall()
    return [
        Gap(
            gap_start=int(row["gap_start"]),
            gap_end=int(row["gap_end"]),
            missing_rows=int(row["missing_rows"]),
        )
        for row in rows
    ]


def count_gaps(conn: DbConn, symbol: str) -> int:
    row = _require_row(
        conn.execute("SELECT count(*) AS n FROM gaps WHERE symbol = %s", (symbol,)).fetchone(),
        "count(gaps)",
    )
    return int(row["n"])


def list_gaps(conn: DbConn, symbol: str, limit: int = 50) -> list[DbRow]:
    return conn.execute(
        "SELECT gap_start, gap_end, missing_rows, attempts, last_error FROM gaps"
        " WHERE symbol = %s ORDER BY gap_start LIMIT %s",
        (symbol, limit),
    ).fetchall()


def insert_gaps(conn: DbConn, exchange: str, symbol: str, gaps: Iterable[Gap]) -> int:
    """登记缺口；已存在的缺口**不覆盖**其 attempts（R-11.B5）。"""
    payload = [(exchange, symbol, g.gap_start, g.gap_end, g.missing_rows) for g in gaps]
    if not payload:
        return 0
    with conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO gaps (exchange, symbol, gap_start, gap_end, missing_rows)"
            " VALUES (%s, %s, %s, %s, %s) ON CONFLICT (symbol, gap_start) DO NOTHING",
            payload,
        )
    return len(payload)


def delete_gap(conn: DbConn, symbol: str, gap_start: int) -> None:
    conn.execute("DELETE FROM gaps WHERE symbol = %s AND gap_start = %s", (symbol, gap_start))


def bump_gap_attempt(
    conn: DbConn,
    symbol: str,
    gap_start: int,
    attempts: int,
    last_error: str,
    now_ms: int,
) -> None:
    conn.execute(
        "UPDATE gaps SET attempts = %s, last_error = %s, last_attempt_at = %s"
        " WHERE symbol = %s AND gap_start = %s",
        (attempts, last_error, now_ms, symbol, gap_start),
    )


def delete_gaps_in_range(conn: DbConn, symbol: str, start_ms: int, end_ms: int) -> None:
    conn.execute(
        "DELETE FROM gaps WHERE symbol = %s AND gap_start BETWEEN %s AND %s",
        (symbol, start_ms, end_ms),
    )


def truncate_all(conn: DbConn) -> None:
    """清空全部业务表（仅测试用；不静默删数据是 R-18.3 的要求，故只暴露给测试夹具）。"""
    with conn.transaction():
        for table in (
            "klines_1m",
            "contract_spec",
            "sync_state",
            "gaps",
            "symbols",
            "weight_budget",
        ):
            conn.execute(f"TRUNCATE TABLE {table}")
        conn.execute(
            "UPDATE weight_budget SET window_from = 0, used = 0, pause_until = NULL WHERE id = 1"
        )
