"""quant-data：行情生成/获取、交易所元数据与 1m K 线同步，TS 侧的桥接入口。

导出面走 barrel（AGENTS.md 硬性约定 4）；包内模块互相 import 用显式 ``.js`` 风格的相对模块名，
对外只从本模块导出。
"""

from __future__ import annotations

from .binance import (
    KLINE_LIMIT_MAX,
    ONE_MINUTE_MS,
    BinanceClient,
    ExchangeSymbol,
    Kline,
    kline_weight,
    parse_klines,
)
from .errors import ERROR_CODES, ErrorCode, SyncError
from .http import HttpResponse, Transport, UrllibTransport, binance_base_url
from .metadata import (
    DEFAULT_TTL_MS,
    MetadataSnapshot,
    fetch_metadata,
    reset_singleton,
    validate_symbol,
)
from .ratelimit import DEFAULT_BUDGET_PER_MINUTE, WeightBudget
from .series import generate_series
from .store import cache_path, read_series, write_series
from .sync import (
    SyncOptions,
    estimate_scale,
    list_symbols,
    plan_estimate,
    resolve_symbol,
    run_backfill,
    run_sync,
    run_verify,
)

__all__ = [
    "DEFAULT_BUDGET_PER_MINUTE",
    "DEFAULT_TTL_MS",
    "ERROR_CODES",
    "KLINE_LIMIT_MAX",
    "ONE_MINUTE_MS",
    "BinanceClient",
    "ErrorCode",
    "ExchangeSymbol",
    "HttpResponse",
    "Kline",
    "MetadataSnapshot",
    "SyncError",
    "SyncOptions",
    "Transport",
    "UrllibTransport",
    "WeightBudget",
    "binance_base_url",
    "cache_path",
    "estimate_scale",
    "fetch_metadata",
    "generate_series",
    "kline_weight",
    "list_symbols",
    "parse_klines",
    "plan_estimate",
    "read_series",
    "reset_singleton",
    "resolve_symbol",
    "run_backfill",
    "run_sync",
    "run_verify",
    "validate_symbol",
    "write_series",
]
