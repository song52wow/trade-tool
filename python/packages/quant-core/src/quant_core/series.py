"""离线合成行情源（确定性）。

**为什么住在 ``quant_core`` 而不是 ``quant_data``**：v0.3.0 R-7.2 要求回测走
「进程内生成并消费」的合成数据路径，而 ``quant_backtest`` 只依赖 ``quant_core``——
把生成器放在 ``quant_data`` 会逼着回测反向依赖同步层，那正是 AGENTS.md 禁止的依赖方向。
它是**纯函数**（无 IO、无网络），放在 core 里天经地义。

确定性靠两件事：``crc32`` 播种（内置 ``hash`` 带随机盐，会破坏可复现性）与
**固定时钟**（``end_time_ms``）。不传时钟时按真实时钟对齐——那是既有 CLI 行为，
因此必须保留；但测试与复现一律显式传时钟。
"""

from __future__ import annotations

import time
import zlib

import numpy as np

from .types import Bar, interval_to_ms


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

    同一 ``(symbol, interval, bars, end_time_ms)`` 永远得到同一结果。
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
