"""行情源。

目前只有一个**确定性合成源**（`generate_series`），保证离线可复现、能跑通链路。
接入真实交易所时新增 `fetch_*` 函数并保持同样的返回类型即可，上层无需改动。
"""

from __future__ import annotations

import time
import zlib

import numpy as np
from quant_core import Bar, interval_to_ms


def _seed_for(symbol: str, interval: str) -> int:
    """用 crc32 而不是内置 hash：后者带随机盐，会破坏可复现性。"""
    return zlib.crc32(f"{symbol}:{interval}".encode())


def generate_series(
    symbol: str,
    interval: str,
    bars: int,
    end_time_ms: int | None = None,
) -> list[Bar]:
    """生成一段确定性的随机游走 OHLCV。

    同一 ``(symbol, interval, bars, end_time_ms)`` 永远得到同一结果，
    方便回测结果对比与缓存命中判断。
    """
    if bars <= 0:
        raise ValueError("bars 必须为正整数")
    step_ms = interval_to_ms(interval)
    end = end_time_ms if end_time_ms is not None else int(time.time() * 1000)
    # 对齐到周期边界
    end -= end % step_ms
    start = end - (bars - 1) * step_ms

    rng = np.random.default_rng(_seed_for(symbol, interval))
    shocks = rng.normal(loc=0.0, scale=0.008, size=bars)
    drift = rng.normal(loc=0.0002, scale=0.0)
    closes = 100.0 * np.exp(np.cumsum(shocks + drift))

    spread = np.abs(rng.normal(loc=0.0, scale=0.004, size=bars))
    opens = closes * (1.0 + rng.normal(loc=0.0, scale=0.002, size=bars))
    highs = np.maximum(opens, closes) * (1.0 + spread)
    lows = np.minimum(opens, closes) * (1.0 - spread)
    volumes = np.abs(rng.normal(loc=1_000.0, scale=250.0, size=bars)).round(4)

    result: list[Bar] = []
    for i in range(bars):
        result.append(
            Bar(
                time=start + i * step_ms,
                open=round(float(opens[i]), 6),
                high=round(float(highs[i]), 6),
                low=round(float(lows[i]), 6),
                close=round(float(closes[i]), 6),
                volume=float(volumes[i]),
            )
        )
    return result
