"""买入成交 → ATR 风控参数（v0.4.0 ``risk-atr``）。

服务侧（``apps/executor``）拿到一笔**买入成交**后要按「成交时刻」算 ATR，
再由策略换算成止盈止损。这个模块是那条接缝的 Python 端：

* **只读**：不出网、不写库、不消耗交易所配额；
* **只算**：指标公式一律来自 :mod:`quant_core`（AGENTS.md 硬性约定 4），
  本模块**不含任何指标公式**，只有「取哪一段 K 线」的选段逻辑；
* **不出 stdout 传 K 线**：小摘要回 TS，K 线留在库里（R-2.1）。

四条不可协商的规则：

1. **只用已收盘的 bar**。bar 起点为 ``t``、桶宽 ``W``，则收盘时刻是 ``t + W``；
   因此窗口上界是 ``time <= asOf − W``。把未收盘的 bar 喂进 Wilder ATR，
   会让最后一根随价格实时漂移，而止损位也跟着漂——这正是「止损会自己动」这种
   最难查的问题。
2. **不跨缺口**。窗口必须是**极大连续段**的尾部（与 ``indicators`` 的分段口径一致），
   回补一个久远的缺口不得改写此后成交对应的 ATR。
3. **取不到就报错，不回退**。库里没有足够的连续已收盘 K 线时抛
   ``RISK_ATR_UNAVAILABLE`` 并说清「缺多少根」；**绝不**改用更小周期、
   也**绝不**拿 0 或 NaN 当 ATR——止损位会因此变成入场价，账户当场归零。
4. **表名与周期不可参数化**：周期先过 :data:`ATR_TABLES` / :data:`BUCKET_WIDTHS`
   白名单再进 SQL。
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

import numpy as np
from quant_core import atr as atr_indicator
from quant_core.indicators import warmup_atr

from . import pg
from .aggregate import BUCKET_WIDTHS_MS, DERIVED_TABLES
from .errors import SyncError
from .indicators import split_segments
from .pg import DbConn

#: 1m 基础表与桶宽。它不在 ``DERIVED_TABLES`` 里（那张表只列派生周期），
#: 但 ATR 窗口的默认周期就是 1m，因此在这里显式补齐。
BASE_TABLE = "klines_1m"
BASE_INTERVAL = "1m"
ONE_MINUTE_MS = 60_000

#: 允许算 ATR 的周期 -> 表名。**只从这里取**（规则 4）。
ATR_TABLES: Mapping[str, str] = {BASE_INTERVAL: BASE_TABLE, **DERIVED_TABLES}

#: 允许算 ATR 的周期 -> 桶宽（毫秒）。**只从这里取**。
BUCKET_WIDTHS: Mapping[str, int] = {
    BASE_INTERVAL: ONE_MINUTE_MS,
    **BUCKET_WIDTHS_MS,
}

#: 允许的周期次序（短 → 长），用于错误提示与摘要输出。
ALLOWED_ATR_INTERVALS: tuple[str, ...] = (BASE_INTERVAL, *DERIVED_TABLES)

#: 默认窗口根数：预热期 ``period`` 根 + 一段缓冲，够算又不至于把整张表读出来。
DEFAULT_WINDOW_BARS = 240

#: 默认 ATR 周期。与 ``core`` 侧 ``executor.atrPeriod`` 的缺省值一致。
DEFAULT_ATR_PERIOD = 14


def parse_interval(raw: str | None) -> str:
    """解析 ATR 周期。缺省 ``1m``；``5m`` / ``foo`` / ``1M`` 一律 ``CONFIG_INVALID``。

    **绝不静默回落到 1m**：用户以为按 15m 的波动设止损、实际拿到 1m，
    止损位会近到几分钟内必被扫，而这在日志里完全看不出来。
    """
    if raw is None or raw == "":
        return BASE_INTERVAL
    if raw in ATR_TABLES:
        return raw
    raise SyncError(
        "CONFIG_INVALID",
        f"ATR 不支持该周期：{raw}（可算周期为 {list(ALLOWED_ATR_INTERVALS)}；5m 在派生层就没有表）",
        {"interval": raw, "supported": list(ALLOWED_ATR_INTERVALS)},
    )


def parse_period(raw: object) -> int:
    """解析 ATR 周期长度。正整数，否则 ``CONFIG_INVALID``（AGENTS.md 约定 9）。"""
    if isinstance(raw, bool) or not isinstance(raw, int):
        raise SyncError("CONFIG_INVALID", f"ATR period 必须是整数：{raw!r}", {"period": raw})
    if raw < 1:
        raise SyncError("CONFIG_INVALID", f"ATR period 必须为正：{raw}", {"period": raw})
    return raw


def table_of(interval: str) -> str:
    try:
        return ATR_TABLES[interval]
    except KeyError as exc:  # pragma: no cover - 调用前已由 parse_interval 拦下
        raise SyncError(
            "CONFIG_INVALID", f"ATR 不支持该周期: {interval}", {"interval": interval}
        ) from exc


def width_of(interval: str) -> int:
    try:
        return BUCKET_WIDTHS[interval]
    except KeyError as exc:  # pragma: no cover - 同上
        raise SyncError(
            "CONFIG_INVALID", f"ATR 不支持该周期: {interval}", {"interval": interval}
        ) from exc


def closed_upper_bound(as_of_ms: int, width_ms: int) -> int:
    """``as_of`` 时刻**已收盘**的 bar 起点上界（含）。

    bar 在 ``t + W`` 才收盘，因此 ``t + W <= asOf`` 等价于 ``t <= asOf − W``。
    """
    return as_of_ms - width_ms


@dataclass(frozen=True, slots=True)
class AtrSnapshot:
    """一次「按成交时刻算 ATR」的结果。

    ``segmentFrom`` / ``segmentTo`` 随值一起回传：出问题时能立刻定位到
    到底用了哪一段 K 线，而不是只看到一个没有来由的数字。
    """

    symbol: str
    interval: str
    period: int
    atr: float
    bars_used: int
    segment_from: int
    segment_to: int
    as_of_ms: int

    def to_dict(self) -> dict[str, object]:
        return {
            "symbol": self.symbol,
            "interval": self.interval,
            "intervalMs": width_of(self.interval),
            "period": self.period,
            "atr": self.atr,
            "barsUsed": self.bars_used,
            "segmentFrom": self.segment_from,
            "segmentTo": self.segment_to,
            "asOfMs": self.as_of_ms,
        }


@dataclass(slots=True)
class Window:
    """连续段尾部的窗口：时间与 OHLC，等长。"""

    times: list[int]
    high: np.ndarray
    low: np.ndarray
    close: np.ndarray

    def __len__(self) -> int:
        return len(self.times)


def read_closed_window(
    conn: DbConn, symbol: str, interval: str, as_of_ms: int, window_bars: int
) -> Window:
    """取 ``as_of`` 时刻最近的一段**连续且已收盘**的 K 线（最多 ``window_bars`` 根）。

    一次 ``ORDER BY time DESC LIMIT n`` 取回再翻正，与 ``readLatestBars`` 同思路：
    要的是**最近**这一端，而不是区间最早的那 n 根。
    """
    table = table_of(interval)
    width = width_of(interval)
    upper = closed_upper_bound(as_of_ms, width)
    if upper < 0:
        raise SyncError(
            "RISK_ATR_UNAVAILABLE",
            f"{symbol} 在 {as_of_ms} 之前还没有一根已收盘的 {interval} K 线",
            {"symbol": symbol, "interval": interval, "asOfMs": as_of_ms},
        )
    rows = conn.execute(
        f"SELECT time, high, low, close FROM {table}"
        " WHERE symbol = %s AND time <= %s ORDER BY time DESC LIMIT %s",
        (symbol, upper, window_bars),
    ).fetchall()
    if not rows:
        raise SyncError(
            "RISK_ATR_UNAVAILABLE",
            f"{symbol} 库里没有 {interval} 已收盘 K 线（截止 {as_of_ms}）；"
            "先让 apps/sync 把该标的的行情同步上来",
            {
                "symbol": symbol,
                "interval": interval,
                "asOfMs": as_of_ms,
                "closedUpperBound": upper,
                "hint": "pnpm --filter @trade-tool/sync start（并在控制面 start 该标的）",
            },
        )
    rows = list(reversed(rows))
    times = [int(r["time"]) for r in rows]
    segments = split_segments(times, width)
    # 只要最近那一段：更早的段与 asOf 之间的缺口意味着「这段历史不完整」，
    # 跨过去算出来的 ATR 描述的不是这段行情（规则 2）。
    segment = segments[-1]
    lo = max(segment.lo, segment.hi - window_bars)
    return Window(
        times=times[lo : segment.hi],
        high=np.array([float(r["high"]) for r in rows[lo : segment.hi]], dtype=np.float64),
        low=np.array([float(r["low"]) for r in rows[lo : segment.hi]], dtype=np.float64),
        close=np.array([float(r["close"]) for r in rows[lo : segment.hi]], dtype=np.float64),
    )


def compute_atr(window: Window, period: int) -> float:
    """在窗口上算 Wilder ATR，取最后一个有效值。

    公式**不在这里**：来自 :func:`quant_core.atr`（AGENTS.md 硬性约定 4）。
    """
    need = warmup_atr(period)
    if len(window) <= need:
        raise SyncError(
            "RISK_ATR_UNAVAILABLE",
            f"{len(window)} 根连续已收盘 K 线不足以算 ATR({period})（需要 > {need} 根，"
            f"缺 {need + 1 - len(window)} 根）",
            {"bars": len(window), "need": need + 1, "missing": need + 1 - len(window)},
        )
    values = atr_indicator(window.high, window.low, window.close, period)
    last = float(values[-1])
    # NaN / 非正数一律当成「取不到」：把 0 当 ATR 会让止损位正好落在入场价上。
    if not np.isfinite(last) or last <= 0:
        raise SyncError(
            "RISK_ATR_UNAVAILABLE",
            f"ATR({period}) 算出无效值：{last}",
            {"atr": last, "bars": len(window)},
        )
    return last


def atr_at(
    conn: DbConn,
    symbol: str,
    *,
    interval: str | None = None,
    period: object = DEFAULT_ATR_PERIOD,
    as_of_ms: int,
    window_bars: object = DEFAULT_WINDOW_BARS,
) -> AtrSnapshot:
    """**本模块的主入口**：按成交时刻算 ATR。"""
    iv = parse_interval(interval)
    per = parse_period(period)
    if isinstance(window_bars, bool) or not isinstance(window_bars, int) or window_bars < 1:
        raise SyncError(
            "CONFIG_INVALID",
            f"ATR 窗口根数必须为正整数：{window_bars!r}",
            {"windowBars": window_bars},
        )
    window = read_closed_window(conn, symbol, iv, as_of_ms, window_bars)
    value = compute_atr(window, per)
    return AtrSnapshot(
        symbol=symbol,
        interval=iv,
        period=per,
        atr=value,
        bars_used=len(window),
        segment_from=window.times[0],
        segment_to=window.times[-1],
        as_of_ms=as_of_ms,
    )


def run_atr(
    *,
    symbol: str,
    interval: str | None,
    period: object,
    as_of_ms: int,
    window_bars: object,
    dsn: str | None = None,
) -> dict[str, object]:
    """CLI / 桥接入口：连库、算 ATR、回摘要。

    ``dsn`` 只走环境变量注入（``pg.connect`` 内部解析 ``TRADE_TOOL_PG_DSN``），
    绝不出现在 argv 或返回值里。
    """
    if not symbol:
        raise SyncError("CONFIG_INVALID", "缺少 --symbol", {"symbol": symbol})
    if as_of_ms <= 0:
        raise SyncError(
            "CONFIG_INVALID",
            f"--as-of-ms 必须是正的 epoch 毫秒：{as_of_ms}",
            {"asOfMs": as_of_ms},
        )
    conn = pg.connect(dsn)
    try:
        return atr_at(
            conn,
            symbol,
            interval=interval,
            period=period,
            as_of_ms=as_of_ms,
            window_bars=window_bars,
        ).to_dict()
    finally:
        conn.close()
