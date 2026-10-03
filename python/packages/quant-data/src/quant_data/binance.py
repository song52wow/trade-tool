"""Binance USDⓈ-M 永续的 REST 接入与 K 线解析。

只做公开行情（N-5），只用两个端点（附录 A.2）：
- ``GET /fapi/v1/exchangeInfo``：合约元数据（R-7），约 1.14 MB，必须共享缓存（R-7.4）
- ``GET /fapi/v1/klines``：1m K 线（R-9）

**不写死任何标的名或任何标的元数据数值**（R-5）：``onboardDate`` / ``status`` /
``contractType`` 一律运行时解析。
"""

from __future__ import annotations

import math
import urllib.parse
from collections.abc import Mapping
from dataclasses import dataclass

from .errors import SyncError
from .http import DEFAULT_TIMEOUT_MS, Transport, binance_base_url
from .ratelimit import WeightBudget

#: 1m 周期长度（毫秒）。周期固定 1m，不提供 interval 配置项（R-6）。
ONE_MINUTE_MS = 60_000

#: 单次请求的 bar 数上限（附录 A.3，limit=1501 会返回 -1130）。
KLINE_LIMIT_MAX = 1500

#: K 线响应的字段个数（附录 A.2：接口不返回字段名，必须按位置解析）。
KLINE_FIELD_COUNT = 12

#: 只用到的字段下标（附录 A.2 的顺序表）。
IDX_OPEN_TIME = 0
IDX_OPEN = 1
IDX_HIGH = 2
IDX_LOW = 3
IDX_CLOSE = 4
IDX_VOLUME = 5
IDX_CLOSE_TIME = 6
IDX_QUOTE_VOLUME = 7
IDX_TRADES = 8

#: 永续与可交易状态字面量（R-7.2 的校验依据；取值来自交易所，不是标的特例）。
CONTRACT_TYPE_PERPETUAL = "PERPETUAL"
STATUS_TRADING = "TRADING"

#: exchangeInfo 的请求权重：附录只实测了 klines 的分层，这里按最小档保守预留。
EXCHANGE_INFO_WEIGHT = 1

#: 触发全局暂停的交易所状态码（R-21.4）。
RATE_LIMIT_STATUSES = frozenset({418, 429})


def align_bar_start(time_ms: int) -> int:
    """把任意毫秒时间戳向上对齐到 1m K 线的开盘边界（``ceil``）。

    1m bar 的开盘时间必然是 60_000 的整数倍；交易所会从**第一个不早于** ``startTime``
    的 bar 开始返回，因此实际起点是对齐后的值。规模预估必须报同一个值，
    否则「约 N 根 / 约 M 次请求」就与真正发生的事对不上（R-8.3）。
    """
    remainder = time_ms % ONE_MINUTE_MS
    return time_ms if remainder == 0 else time_ms + (ONE_MINUTE_MS - remainder)


def kline_weight(limit: int) -> int:
    """单次 klines 请求的权重（附录 A.3 实测分层）。"""
    if limit <= 100:
        return 1
    if limit <= 500:
        return 2
    if limit <= 1000:
        return 5
    return 10


@dataclass(frozen=True, slots=True)
class Kline:
    """一根 1m K 线。``quote_volume`` / ``trades`` 允许为 None，语义是「交易所未提供」（R-4.2）。"""

    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float
    close_time: int
    quote_volume: float | None
    trades: int | None


@dataclass(frozen=True, slots=True)
class ExchangeSymbol:
    """exchangeInfo 里的一个合约条目（本需求只依赖三个字段，R-7.3）。"""

    symbol: str
    contract_type: str
    status: str
    onboard_date: int
    raw: Mapping[str, object]


def _require_number(value: object, index: int, field: str) -> float:
    """把一个 K 线字段解析成有限浮点数。

    真实的 ``/fapi/v1/klines`` 响应里，**价格与成交量字段是 JSON 字符串**，
    只有 ``openTime`` / ``closeTime`` 是 JSON 数字（附录 A.2 的字段顺序不变，类型要照实解析），
    因此字符串必须被强制转换，否则每一个真实响应都会被判为非法。

    仍然保持：
    - ``None`` → ``NULL_NOT_ALLOWED``（必填字段的 null 是数据损坏，R-4.1）；
    - 解析不了 / 布尔 / 非有限数（nan、inf）→ ``EXCHANGE_ERROR``，**绝不静默当 0 处理**（R-4.3）。
    """
    if value is None:
        raise SyncError(
            "NULL_NOT_ALLOWED",
            f"klines[{index}].{field} 为 null：交易所未提供必填字段",
            {"index": index, "field": field},
        )
    if isinstance(value, bool):
        raise SyncError(
            "EXCHANGE_ERROR",
            f"klines[{index}].{field} 是布尔值，不是数字",
            {"index": index, "field": field, "type": type(value).__name__},
        )
    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str):
        try:
            number = float(value.strip())
        except ValueError as exc:
            raise SyncError(
                "EXCHANGE_ERROR",
                f"klines[{index}].{field} 不是合法数字字符串: {value!r}",
                {"index": index, "field": field, "type": "str"},
            ) from exc
    else:
        raise SyncError(
            "EXCHANGE_ERROR",
            f"klines[{index}].{field} 不是数字",
            {"index": index, "field": field, "type": type(value).__name__},
        )
    if not math.isfinite(number):
        raise SyncError(
            "EXCHANGE_ERROR",
            f"klines[{index}].{field} 不是有限数",
            {"index": index, "field": field},
        )
    return number


def _require_int(value: object, index: int, field: str) -> int:
    number = _require_number(value, index, field)
    if number != int(number):
        raise SyncError(
            "EXCHANGE_ERROR",
            f"klines[{index}].{field} 不是整数",
            {"index": index, "field": field},
        )
    return int(number)


def _optional_int(value: object, index: int, field: str) -> int | None:
    """缺失/为 null 的可选字段映射成 None，**绝不用 0 代替**（R-4.3）。"""
    if value is None:
        return None
    return _require_int(value, index, field)


def parse_klines(payload: object) -> list[Kline]:
    """按位置解析 12 字段 K 线数组（附录 A.2）。"""
    if not isinstance(payload, list):
        raise SyncError(
            "EXCHANGE_ERROR",
            "klines 响应不是数组",
            {"type": type(payload).__name__},
        )
    rows: list[Kline] = []
    for index, item in enumerate(payload):
        if not isinstance(item, list) or len(item) < IDX_TRADES + 1:
            got = len(item) if isinstance(item, list) else None
            raise SyncError(
                "EXCHANGE_ERROR",
                f"klines[{index}] 字段数不足（期望 {KLINE_FIELD_COUNT}）",
                {"index": index, "got": got},
            )
        rows.append(
            Kline(
                time=_require_int(item[IDX_OPEN_TIME], index, "openTime"),
                open=_require_number(item[IDX_OPEN], index, "open"),
                high=_require_number(item[IDX_HIGH], index, "high"),
                low=_require_number(item[IDX_LOW], index, "low"),
                close=_require_number(item[IDX_CLOSE], index, "close"),
                volume=_require_number(item[IDX_VOLUME], index, "volume"),
                close_time=_require_int(item[IDX_CLOSE_TIME], index, "closeTime"),
                quote_volume=(
                    None
                    if item[IDX_QUOTE_VOLUME] is None
                    else _require_number(item[IDX_QUOTE_VOLUME], index, "quoteVolume")
                ),
                trades=_optional_int(item[IDX_TRADES], index, "trades"),
            )
        )
    return rows


def _parse_retry_after(value: str | None) -> int | None:
    """只解析秒数形式的 ``Retry-After``；HTTP-date 形式不猜测。"""
    if value is None:
        return None
    try:
        seconds = int(value.strip())
    except ValueError:
        return None
    return seconds if seconds >= 0 else None


class BinanceClient:
    """极薄的 REST 客户端：只做 URL 拼装、权重预留、错误分类。"""

    def __init__(
        self,
        transport: Transport,
        base_url: str | None = None,
        budget: WeightBudget | None = None,
        *,
        timeout_ms: int = DEFAULT_TIMEOUT_MS,
        page_limit: int = KLINE_LIMIT_MAX,
    ) -> None:
        if not 1 <= page_limit <= KLINE_LIMIT_MAX:
            raise SyncError(
                "CONFIG_INVALID",
                f"分页大小必须在 1..{KLINE_LIMIT_MAX} 之间",
                {"pageLimit": page_limit},
            )
        self._transport = transport
        self._base_url = (base_url or binance_base_url()).rstrip("/")
        self._budget = budget
        self._timeout_ms = timeout_ms
        self._page_limit = page_limit
        self.requests: int = 0
        self.weight: int = 0

    @property
    def page_limit(self) -> int:
        return self._page_limit

    @property
    def base_url(self) -> str:
        return self._base_url

    def exchange_info(self) -> object:
        """拉取全量合约元数据。调用方负责共享缓存（R-7.4）。"""
        payload = self._get("/fapi/v1/exchangeInfo", {}, EXCHANGE_INFO_WEIGHT, "exchangeInfo")
        if not isinstance(payload, dict):
            raise SyncError("EXCHANGE_ERROR", "exchangeInfo 响应不是对象", {})
        return payload

    def klines(self, symbol: str, start_ms: int, end_ms: int | None, limit: int) -> list[Kline]:
        """按 ``startTime`` 拉一页 1m K 线（未做「丢弃最后一根」处理，见 R-10.1 的调用点）。"""
        params: dict[str, str] = {"symbol": symbol, "interval": "1m", "limit": str(limit)}
        if start_ms is not None:
            params["startTime"] = str(start_ms)
        if end_ms is not None:
            params["endTime"] = str(end_ms)
        payload = self._get("/fapi/v1/klines", params, kline_weight(limit), "klines")
        return parse_klines(payload)

    def _get(
        self,
        path: str,
        params: Mapping[str, str],
        weight: int,
        context: str,
    ) -> object:
        if self._budget is not None:
            # 先预留再出网（R-20.2）：预留不到就等待，不允许超配额硬发。
            self._budget.reserve(weight)
        query = urllib.parse.urlencode(params)
        url = f"{self._base_url}{path}?{query}" if query else f"{self._base_url}{path}"
        response = self._transport.get(url, timeout_ms=self._timeout_ms)
        self.requests += 1
        self.weight += weight
        if response.status in RATE_LIMIT_STATUSES:
            retry_after = _parse_retry_after(response.header("Retry-After"))
            if self._budget is not None and retry_after is not None:
                self._budget.register_pause(retry_after)
            raise SyncError(
                "EXCHANGE_RATE_LIMITED",
                f"交易所限流: HTTP {response.status}",
                {
                    "status": response.status,
                    "retryAfterSeconds": retry_after,
                    "body": response.error_text(),
                },
            )
        if response.status != 200:
            raise SyncError(
                "EXCHANGE_ERROR",
                f"交易所返回 HTTP {response.status}",
                {"status": response.status, "body": response.error_text()},
            )
        return response.json(context=context)


def parse_exchange_symbols(payload: Mapping[str, object]) -> dict[str, ExchangeSymbol]:
    """从 exchangeInfo 里解析出 ``symbol -> 合约条目`` 索引。

    不做任何过滤：``resolve`` 需要区分「不存在 / 非永续 / 非交易中」（R-7.2），
    所以过滤只发生在 ``symbols`` 命令的输出层。
    """
    raw_symbols = payload.get("symbols")
    if not isinstance(raw_symbols, list):
        raise SyncError("EXCHANGE_ERROR", "exchangeInfo 缺少 symbols 数组", {})
    index: dict[str, ExchangeSymbol] = {}
    for position, item in enumerate(raw_symbols):
        if not isinstance(item, dict):
            raise SyncError("EXCHANGE_ERROR", f"exchangeInfo.symbols[{position}] 不是对象", {})
        symbol = item.get("symbol")
        contract_type = item.get("contractType")
        status = item.get("status")
        onboard_date = item.get("onboardDate")
        if not isinstance(symbol, str) or not isinstance(contract_type, str):
            raise SyncError(
                "EXCHANGE_ERROR",
                f"exchangeInfo.symbols[{position}] 缺少 symbol/contractType",
                {"position": position},
            )
        index[symbol] = ExchangeSymbol(
            symbol=symbol,
            contract_type=contract_type,
            status=status if isinstance(status, str) else "",
            onboard_date=_optional_epoch(onboard_date, position),
            raw=dict(item),
        )
    return index


def _optional_epoch(value: object, position: int) -> int:
    """``onboardDate`` 通常是 JSON 数字，但也容忍数字字符串；无法解析就报错，不静默取 0。"""
    if value is None:
        return 0
    if isinstance(value, bool):
        raise SyncError(
            "EXCHANGE_ERROR",
            f"exchangeInfo.symbols[{position}].onboardDate 类型非法",
            {"position": position},
        )
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError as exc:
            raise SyncError(
                "EXCHANGE_ERROR",
                f"exchangeInfo.symbols[{position}].onboardDate 不是合法时间戳: {value!r}",
                {"position": position},
            ) from exc
    if isinstance(value, float) and math.isfinite(value):
        return int(value)
    raise SyncError(
        "EXCHANGE_ERROR",
        f"exchangeInfo.symbols[{position}].onboardDate 类型非法",
        {"position": position, "type": type(value).__name__},
    )
