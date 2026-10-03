"""交易所元数据的磁盘缓存与校验（R-7）。

三条硬要求：
1. ``exchangeInfo`` 约 1.14 MB，**必须缓存**，TTL 默认 1 小时（R-7.1）；
2. TTL 过期且拉取失败时允许用过期缓存，但必须 WARN 并标记 ``metadataStale``（R-7.1）；
3. 元数据是**全进程共享的单例**，不得按标的重拉（R-7.4）。

``symbol`` 精确匹配（大小写敏感），不做模糊匹配或补全猜测；校验失败给结构化错误码（R-7.2）。
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from quant_core.io import log

from .binance import (
    CONTRACT_TYPE_PERPETUAL,
    STATUS_TRADING,
    BinanceClient,
    ExchangeSymbol,
    parse_exchange_symbols,
)
from .errors import SyncError

#: 默认 TTL 1 小时（R-7.1）。
DEFAULT_TTL_MS = 3_600_000

#: 缓存文件名（基址不同的测试可各自指定 meta-dir，互不干扰）。
CACHE_FILE_NAME = "exchangeInfo.json"


@dataclass(frozen=True, slots=True)
class MetadataSnapshot:
    """一次 exchangeInfo 的解析结果。``stale`` 为真表示取自过期缓存（R-7.1）。"""

    saved_at: int
    stale: bool
    by_symbol: Mapping[str, ExchangeSymbol]

    def age_ms(self, now_ms: int) -> int:
        return max(0, now_ms - self.saved_at)

    def tradable_perpetuals(self) -> list[ExchangeSymbol]:
        """可交易的 USDⓈ-M 永续，按 symbol 排序以保证输出确定。"""
        selected = [
            item
            for item in self.by_symbol.values()
            if item.contract_type == CONTRACT_TYPE_PERPETUAL and item.status == STATUS_TRADING
        ]
        return sorted(selected, key=lambda item: item.symbol)


#: R-7.4：进程内单例，key = (meta-dir, base-url)。第二个请求同一标的不再出网。
_SINGLETON: dict[tuple[str, str], MetadataSnapshot] = {}


def reset_singleton() -> None:
    """清空进程内单例。仅供测试与长驻进程显式刷新使用。"""
    _SINGLETON.clear()


def cache_file(meta_dir: Path | None) -> Path | None:
    return None if meta_dir is None else meta_dir / CACHE_FILE_NAME


def read_cache_file(path: Path) -> tuple[int, Mapping[str, object]] | None:
    """读磁盘缓存；文件损坏视为未命中，不静默假装成功。"""
    if not path.exists():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        log(f"metadata cache unreadable, treat as miss: {path} ({exc})")
        return None
    if not isinstance(raw, dict):
        log(f"metadata cache shape unexpected, treat as miss: {path}")
        return None
    saved_at = raw.get("savedAt")
    payload = raw.get("payload")
    if not isinstance(saved_at, int) or not isinstance(payload, dict):
        log(f"metadata cache fields unexpected, treat as miss: {path}")
        return None
    return saved_at, payload


def write_cache_file(path: Path, payload: Mapping[str, object], now_ms: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    document = json.dumps(
        {"savedAt": now_ms, "payload": payload},
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    )
    path.write_text(document, encoding="utf-8")


def _snapshot_from_payload(
    payload: Mapping[str, object],
    saved_at: int,
    stale: bool,
) -> MetadataSnapshot:
    return MetadataSnapshot(
        saved_at=saved_at, stale=stale, by_symbol=parse_exchange_symbols(payload)
    )


def fetch_metadata(
    client: BinanceClient,
    *,
    meta_dir: Path | None,
    ttl_ms: int,
    allow_stale: bool,
    now_ms: int,
    refresh: bool = False,
) -> MetadataSnapshot:
    """取元数据快照：单例 → 磁盘缓存（TTL 内）→ 出网 → 过期缓存兜底。"""
    key = (str(meta_dir) if meta_dir is not None else "", client.base_url)
    cached = _SINGLETON.get(key)
    if refresh:
        _SINGLETON.pop(key, None)
        cached = None
    if cached is not None:
        fresh_enough = now_ms - cached.saved_at <= ttl_ms
        # TTL 内的命中直接返回；过期但已标记 stale 的命中在 allow_stale 时也直接返回（R-7.1）。
        if fresh_enough or (allow_stale and cached.stale):
            return cached

    path = cache_file(meta_dir)
    on_disk = read_cache_file(path) if path is not None else None
    if on_disk is not None and not refresh:
        disk_saved_at, disk_payload = on_disk
        if now_ms - disk_saved_at <= ttl_ms:
            snapshot = _snapshot_from_payload(disk_payload, disk_saved_at, stale=False)
            _SINGLETON[key] = snapshot
            return snapshot

    payload: object
    try:
        payload = client.exchange_info()
    except SyncError as exc:
        if allow_stale and on_disk is not None:
            saved_at, cached_payload = on_disk
            log(
                f"WARN metadata fetch failed, falling back to stale cache "
                f"(age {now_ms - saved_at}ms): {exc}"
            )
            snapshot = _snapshot_from_payload(cached_payload, saved_at, stale=True)
            _SINGLETON[key] = snapshot
            return snapshot
        if exc.code == "NETWORK_ERROR":
            raise
        raise SyncError(
            "METADATA_FETCH_FAILED",
            f"拉取 exchangeInfo 失败: {exc.message}",
            {**exc.details, "allowStale": allow_stale},
        ) from exc

    if not isinstance(payload, dict):  # pragma: no cover - client 已保证
        raise SyncError("METADATA_FETCH_FAILED", "exchangeInfo 响应不是对象", {})
    document: dict[str, object] = dict(payload)
    if path is not None:
        write_cache_file(path, document, now_ms)
    snapshot = _snapshot_from_payload(document, now_ms, stale=False)
    _SINGLETON[key] = snapshot
    return snapshot


def validate_symbol(snapshot: MetadataSnapshot, symbol: str) -> ExchangeSymbol:
    """精确匹配 + 校验，失败给结构化错误码（R-7.2）。

    不做枚举白名单、不按标的分支、不内置任何标的数值（R-5）。
    """
    item = snapshot.by_symbol.get(symbol)
    if item is None:
        raise SyncError(
            "SYMBOL_NOT_FOUND",
            f"交易所元数据中没有该标的: {symbol}",
            {"symbol": symbol, "known": len(snapshot.by_symbol)},
        )
    if item.contract_type != CONTRACT_TYPE_PERPETUAL:
        raise SyncError(
            "NOT_PERPETUAL",
            f"{symbol} 不是永续合约: {item.contract_type}",
            {"symbol": symbol, "contractType": item.contract_type},
        )
    if item.status != STATUS_TRADING:
        raise SyncError(
            "NOT_TRADING",
            f"{symbol} 当前不是交易中状态: {item.status}",
            {"symbol": symbol, "status": item.status},
        )
    if item.onboard_date <= 0:
        raise SyncError(
            "METADATA_FETCH_FAILED",
            f"{symbol} 缺少 onboardDate，无法确定首次全量起点",
            {"symbol": symbol},
        )
    return item
