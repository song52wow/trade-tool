"""HTTP 传输层。

只用标准库 ``urllib.request``，**不引入任何 HTTP 依赖**（需求 0.2）。
``Transport`` 协议即测试的注入点：测试注入假 transport，**绝不访问真实网络**（R-16.5）。

Binance 基址从环境变量读取（默认 ``https://fapi.binance.com``），
TS 侧测试用本地 mock HTTP server 跑真实引擎，因此不得在代码里内联基址。
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol

from .errors import SyncError

#: 覆盖交易所基址的环境变量；缺省才用生产基址。
BASE_URL_ENV = "TRADE_TOOL_BINANCE_BASE_URL"
DEFAULT_BINANCE_BASE_URL = "https://fapi.binance.com"
DEFAULT_TIMEOUT_MS = 15_000
USER_AGENT = "trade-tool/0.1.0"


@dataclass(frozen=True, slots=True)
class HttpResponse:
    status: int
    body: bytes
    headers: Mapping[str, str]

    def header(self, name: str) -> str | None:
        lowered = name.lower()
        for key, value in self.headers.items():
            if key.lower() == lowered:
                return value
        return None

    def json(self, *, context: str) -> object:
        """解析 JSON 响应体；解析失败是交易所侧异常，不静默返回空值。"""
        try:
            return json.loads(self.body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise SyncError(
                "EXCHANGE_ERROR",
                f"{context} 响应不是合法 JSON: {exc}",
                {"context": context, "status": self.status},
            ) from exc

    def error_text(self, *, limit: int = 200) -> str:
        text = self.body.decode("utf-8", errors="replace")
        return text if len(text) <= limit else f"{text[:limit]}…"


class Transport(Protocol):
    """出网请求的最小接口。测试注入实现它的假对象（R-16.5）。"""

    def get(self, url: str, *, timeout_ms: int) -> HttpResponse: ...


def binance_base_url() -> str:
    return os.environ.get(BASE_URL_ENV) or DEFAULT_BINANCE_BASE_URL


class UrllibTransport:
    """生产用实现：标准库 urllib。

    HTTP 错误状态（429/418/4xx/5xx）**不**在这里抛错，而是原样返回给上层判断，
    因为限流需要带 ``Retry-After`` 做全局暂停（R-21.4）。传输层异常才算网络错误。
    """

    def __init__(self, timeout_ms: int = DEFAULT_TIMEOUT_MS) -> None:
        self._timeout_ms = timeout_ms

    def get(self, url: str, *, timeout_ms: int = 0) -> HttpResponse:
        request = urllib.request.Request(
            url,
            headers={"Accept": "application/json", "User-Agent": USER_AGENT},
            method="GET",
        )
        try:
            with urllib.request.urlopen(
                request, timeout=(timeout_ms or self._timeout_ms) / 1000
            ) as response:
                return HttpResponse(
                    status=response.status,
                    body=response.read(),
                    headers=dict(response.headers.items()),
                )
        except urllib.error.HTTPError as exc:
            headers = dict(exc.headers.items()) if exc.headers else {}
            return HttpResponse(status=exc.code, body=exc.read(), headers=headers)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise SyncError(
                "NETWORK_ERROR",
                f"请求交易所失败: {url}",
                {"url": url, "reason": str(exc)},
            ) from exc
