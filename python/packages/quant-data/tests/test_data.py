from __future__ import annotations

import itertools
import json
from pathlib import Path
from typing import Any

import pytest
from quant_core import Bar
from quant_data.__main__ import main
from quant_data.series import generate_series
from quant_data.store import cache_path, read_series, write_series


def test_generate_is_deterministic() -> None:
    a = generate_series("BTCUSDT", "1h", 50, end_time_ms=1_700_000_000_000)
    b = generate_series("BTCUSDT", "1h", 50, end_time_ms=1_700_000_000_000)
    assert a == b


def test_generate_different_symbol_differs() -> None:
    a = generate_series("BTCUSDT", "1h", 50, end_time_ms=1_700_000_000_000)
    b = generate_series("ETHUSDT", "1h", 50, end_time_ms=1_700_000_000_000)
    assert [x.close for x in a] != [x.close for x in b]


def test_generate_bars_are_time_aligned() -> None:
    bars = generate_series("BTCUSDT", "1h", 10, end_time_ms=1_700_000_000_000)
    deltas = {b.time - a.time for a, b in itertools.pairwise(bars)}
    assert deltas == {3_600_000}


def test_generate_rejects_non_positive_bars() -> None:
    with pytest.raises(ValueError):
        generate_series("BTCUSDT", "1h", 0)


def test_csv_roundtrip(tmp_path: Path) -> None:
    bars = generate_series("BTCUSDT", "1h", 20, end_time_ms=1_700_000_000_000)
    path = cache_path(tmp_path, "BTCUSDT", "1h", 20)
    write_series(path, bars)
    loaded: list[Bar] = read_series(path)
    assert len(loaded) == len(bars)
    assert loaded[-1].close == pytest.approx(bars[-1].close)


def test_cli_emits_single_json_document(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["generate", "--symbol", "BTCUSDT", "--bars", "10"]) == 0
    payload: dict[str, Any] = json.loads(capsys.readouterr().out)
    assert payload["symbol"] == "BTCUSDT"
    assert payload["intervalMs"] == 3_600_000
    assert len(payload["bars"]) == 10
    assert set(payload["bars"][0]) == {"time", "open", "high", "low", "close", "volume"}


def test_cli_writes_cache_when_requested(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    args = ["generate", "--symbol", "ETHUSDT", "--bars", "5", "--cache-root", str(tmp_path)]
    assert main(args) == 0
    capsys.readouterr()
    assert cache_path(tmp_path, "ETHUSDT", "1h", 5).exists()


def test_cli_rejects_unknown_interval() -> None:
    with pytest.raises(SystemExit):
        main(["generate", "--symbol", "BTCUSDT", "--interval", "7m"])
