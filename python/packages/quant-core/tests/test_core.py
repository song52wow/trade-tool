from __future__ import annotations

import pytest
from quant_core import Bar, interval_to_ms, series_to_dicts


def test_interval_to_ms_known() -> None:
    assert interval_to_ms("1h") == 3_600_000


def test_interval_to_ms_unknown() -> None:
    with pytest.raises(ValueError):
        interval_to_ms("7m")


def test_bar_rejects_inconsistent_high() -> None:
    with pytest.raises(ValueError):
        Bar(time=0, open=10.0, high=9.0, low=8.0, close=10.0, volume=1.0)


def test_bar_roundtrip() -> None:
    bar = Bar(time=1, open=1.0, high=2.0, low=0.5, close=1.5, volume=10.0)
    rows = series_to_dicts([bar])
    assert Bar.from_dicts(rows) == [bar]
