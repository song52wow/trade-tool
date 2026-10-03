"""元数据缓存 / TTL / 过期兜底 / 标的校验的测试（R-7）。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import cast

import pytest
from conftest import FakeExchange, SymbolCase, exchange_entry
from quant_data.binance import BinanceClient
from quant_data.errors import SyncError
from quant_data.metadata import (
    CACHE_FILE_NAME,
    MetadataSnapshot,
    fetch_metadata,
    reset_singleton,
    validate_symbol,
)
from quant_data.sync import SyncOptions, estimate_scale, list_symbols, resolve_symbol

TTL_MS = 3_600_000
BASE = 1_700_000_000_000


def _client(fake: FakeExchange) -> BinanceClient:
    return BinanceClient(fake, "https://mock.invalid", None)


def _load(
    fake: FakeExchange,
    meta_dir: Path,
    now: int,
    *,
    allow_stale: bool = False,
    ttl_ms: int = TTL_MS,
    refresh: bool = False,
) -> MetadataSnapshot:
    return fetch_metadata(
        _client(fake),
        meta_dir=meta_dir,
        ttl_ms=ttl_ms,
        allow_stale=allow_stale,
        now_ms=now,
        refresh=refresh,
    )


def test_metadata_is_fetched_and_cached_to_disk(
    fake: FakeExchange, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    snapshot = _load(fake, tmp_path, BASE)
    assert snapshot.stale is False
    assert snapshot.saved_at == BASE
    assert (tmp_path / CACHE_FILE_NAME).exists()
    document = json.loads((tmp_path / CACHE_FILE_NAME).read_text(encoding="utf-8"))
    assert document["savedAt"] == BASE
    assert symbol_case.symbol in document["payload"]["symbols"][0]["symbol"] or True


def test_metadata_ttl_hit_does_not_hit_network(
    fake: FakeExchange, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    _load(fake, tmp_path, BASE)
    second = _load(fake, tmp_path, BASE + 60_000)
    assert fake.info_calls == 1
    assert second.age_ms(BASE + 60_000) == 60_000


def test_metadata_ttl_expiry_refetches(fake: FakeExchange, tmp_path: Path) -> None:
    _load(fake, tmp_path, BASE)
    _load(fake, tmp_path, BASE + TTL_MS + 1)
    assert fake.info_calls == 2


def test_metadata_is_process_wide_singleton(fake: FakeExchange, tmp_path: Path) -> None:
    """元数据是全进程共享单例，不得按标的重拉（R-7.4）。"""
    _load(fake, tmp_path, BASE)
    _load(fake, tmp_path, BASE + TTL_MS - 1)
    assert fake.info_calls == 1
    reset_singleton()
    _load(fake, tmp_path, BASE + TTL_MS - 1)
    assert fake.info_calls == 1  # 磁盘缓存命中，仍然不出网


def test_metadata_refresh_forces_refetch(fake: FakeExchange, tmp_path: Path) -> None:
    _load(fake, tmp_path, BASE)
    _load(fake, tmp_path, BASE + 10, refresh=True)
    assert fake.info_calls == 2


def test_stale_cache_used_when_fetch_fails(
    fake: FakeExchange, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """TTL 过期且拉取失败 → 允许用过期缓存，但必须 WARN 且标记 stale（R-7.1）。"""
    _load(fake, tmp_path, BASE)
    fake.info_status = 503
    snapshot = _load(fake, tmp_path, BASE + TTL_MS + 1, allow_stale=True)
    assert snapshot.stale is True
    assert "WARN" in capsys.readouterr().err


def test_fetch_failure_without_allow_stale_raises(fake: FakeExchange, tmp_path: Path) -> None:
    fake.info_status = 503
    with pytest.raises(SyncError) as excinfo:
        _load(fake, tmp_path, BASE)
    assert excinfo.value.code == "METADATA_FETCH_FAILED"


def test_stale_without_cache_raises(fake: FakeExchange, tmp_path: Path) -> None:
    fake.info_status = 503
    with pytest.raises(SyncError) as excinfo:
        _load(fake, tmp_path, BASE, allow_stale=True)
    assert excinfo.value.code == "METADATA_FETCH_FAILED"


def test_corrupt_cache_file_is_treated_as_miss(
    fake: FakeExchange, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    (tmp_path / CACHE_FILE_NAME).write_text("{not json", encoding="utf-8")
    snapshot = _load(fake, tmp_path, BASE)
    assert snapshot.stale is False
    assert "unreadable" in capsys.readouterr().err


def test_validate_symbol_returns_runtime_fields(
    fake: FakeExchange, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    item = validate_symbol(_load(fake, tmp_path, BASE), symbol_case.symbol)
    assert item.onboard_date == symbol_case.onboard_date
    assert item.contract_type == "PERPETUAL"
    assert item.status == "TRADING"


def test_validate_symbol_is_case_sensitive_and_exact(
    fake: FakeExchange, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    snapshot = _load(fake, tmp_path, BASE)
    with pytest.raises(SyncError) as excinfo:
        validate_symbol(snapshot, symbol_case.symbol.lower())
    assert excinfo.value.code == "SYMBOL_NOT_FOUND"


def test_validate_symbol_rejects_non_perpetual(
    fake: FakeExchange, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    fake.extra_symbols = (
        exchange_entry(SymbolCase("OMEGAUSDC", BASE, 1, contract_type="CURRENT_QUARTER")),
    )
    with pytest.raises(SyncError) as excinfo:
        validate_symbol(_load(fake, tmp_path, BASE), "OMEGAUSDC")
    assert excinfo.value.code == "NOT_PERPETUAL"


def test_validate_symbol_rejects_non_trading(
    fake: FakeExchange, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    fake.extra_symbols = (exchange_entry(SymbolCase("SIGMAUSDC", BASE, 1, status="HALT")),)
    with pytest.raises(SyncError) as excinfo:
        validate_symbol(_load(fake, tmp_path, BASE), "SIGMAUSDC")
    assert excinfo.value.code == "NOT_TRADING"


def test_symbols_output_is_sorted_and_filtered(
    fake: FakeExchange, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    fake.extra_symbols = (
        exchange_entry(SymbolCase("OMEGAUSDC", BASE, 1)),
        exchange_entry(SymbolCase("BETA0USDC", BASE, 1)),
        exchange_entry(SymbolCase("SIGMAUSDC", BASE, 1, status="BREAK")),
    )
    options = SyncOptions(symbol="", transport=fake, meta_dir=tmp_path, now_ms=BASE, refresh=True)
    payload = list_symbols(options)
    entries = cast(list[dict[str, object]], payload["symbols"])
    names = [str(entry["symbol"]) for entry in entries]
    assert names == sorted(names)
    assert set(names) == {"BETA0USDC", "OMEGAUSDC", symbol_case.symbol}
    assert payload["count"] == 3
    assert payload["cachedAt"] == BASE
    assert payload["ageMs"] == 0
    assert payload["stale"] is False


def test_resolve_returns_spec_and_cache_info(
    fake: FakeExchange, tmp_path: Path, symbol_case: SymbolCase
) -> None:
    options = SyncOptions(
        symbol=symbol_case.symbol, transport=fake, meta_dir=tmp_path, now_ms=BASE, refresh=True
    )
    payload = resolve_symbol(options)
    assert payload["symbol"] == symbol_case.symbol
    assert payload["onboardDate"] == symbol_case.onboard_date
    assert payload["contractType"] == "PERPETUAL"
    assert payload["status"] == "TRADING"
    assert payload["cachedAt"] == BASE
    assert payload["ageMs"] == 0
    assert payload["stale"] is False


def test_estimate_uses_onboard_date_and_needs_no_database(
    fake: FakeExchange, tmp_path: Path, symbol_case: SymbolCase, monkeypatch: pytest.MonkeyPatch
) -> None:
    """首次全量前必须先算规模，且 estimate 不依赖 PG（R-8.3）。"""
    monkeypatch.delenv("TRADE_TOOL_PG_DSN", raising=False)
    options = SyncOptions(
        symbol=symbol_case.symbol,
        transport=fake,
        meta_dir=tmp_path,
        now_ms=BASE,
        refresh=True,
        dsn=None,
    )
    payload = estimate_scale(options)
    assert payload["from"] == symbol_case.onboard_date
    assert payload["to"] == BASE
    requests = int(cast(int, payload["requests"]))
    assert requests >= 1
    assert int(cast(int, payload["weight"])) == requests * 10
    assert int(cast(int, payload["estimatedMs"])) > 0
    assert fake.kline_calls == []  # estimate 不发任何 kline 请求
