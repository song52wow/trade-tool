"""领域数据结构：与 TypeScript 侧 `@trade-tool/core` 的 `Bar` 严格对齐。"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import asdict, dataclass
from typing import Any, Self

INTERVALS: tuple[str, ...] = ("1m", "5m", "15m", "1h", "4h", "1d")

INTERVAL_MS: dict[str, int] = {
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "1h": 3_600_000,
    "4h": 14_400_000,
    "1d": 86_400_000,
}


def interval_to_ms(interval: str) -> int:
    """周期 -> 毫秒数。"""
    try:
        return INTERVAL_MS[interval]
    except KeyError as exc:
        raise ValueError(f"未知周期: {interval!r}，可选 {INTERVALS}") from exc


@dataclass(frozen=True, slots=True)
class Bar:
    """一根 K 线。time 为毫秒时间戳（epoch ms，UTC），价格与成交量为 float。"""

    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float

    def __post_init__(self) -> None:
        if self.high < max(self.open, self.close, self.low):
            raise ValueError(f"high 低于其它价: {asdict(self)}")
        if self.low > min(self.open, self.close, self.high):
            raise ValueError(f"low 高于其它价: {asdict(self)}")
        if self.volume < 0:
            raise ValueError("volume 不能为负")

    def to_dict(self) -> dict[str, float | int]:
        return asdict(self)

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> Self:
        return cls(
            time=int(raw["time"]),
            open=float(raw["open"]),
            high=float(raw["high"]),
            low=float(raw["low"]),
            close=float(raw["close"]),
            volume=float(raw["volume"]),
        )

    @classmethod
    def from_dicts(cls, rows: Iterable[dict[str, Any]]) -> list[Self]:
        return [cls.from_dict(row) for row in rows]


def series_to_dicts(bars: Sequence[Bar]) -> list[dict[str, float | int]]:
    return [bar.to_dict() for bar in bars]
