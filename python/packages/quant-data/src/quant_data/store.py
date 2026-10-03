"""本地 CSV 缓存：``<root>/<symbol>_<interval>_<bars>.csv``。

刻意用 CSV 而不是 parquet，避免为了一个基础缓存引入 pyarrow 这种重依赖；
后续要换格式只改这里。
"""

from __future__ import annotations

import csv
from collections.abc import Sequence
from pathlib import Path

from quant_core import Bar

FIELDS: tuple[str, ...] = ("time", "open", "high", "low", "close", "volume")


def cache_path(root: Path, symbol: str, interval: str, bars: int) -> Path:
    return root / f"{symbol}_{interval}_{bars}.csv"


def read_series(path: Path) -> list[Bar]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return Bar.from_dicts({key: row[key] for key in FIELDS} for row in csv.DictReader(handle))


def write_series(path: Path, bars: Sequence[Bar]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS)
        writer.writeheader()
        for bar in bars:
            writer.writerow(bar.to_dict())
    return path
