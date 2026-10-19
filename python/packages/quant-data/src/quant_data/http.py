"""HTTP 传输层。

只用标准库 ``urllib.request``，**不引入任何 HTTP 依赖**（需求 0.2）。
``Transport`` 协议即测试的注入点：测试注入假 transport，**绝不访问真实网络**（R-16.5）。

Binance 基址从环境变量读取（默认 ``https://fapi.binance.com``），
TS 侧测试用本地 mock HTTP server 跑真实引擎，因此不得在代码里内联基址。
"""

from __future__ import annotations

import base64
import http.client
import json
import os
import socket
import ssl
import urllib.error
import urllib.parse
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
        timeout_s = (timeout_ms or self._timeout_ms) / 1000
        try:
            # 优先走「手工 CONNECT 隧道」：代理带凭据时只有这条��走得通
            # （urllib 的 ProxyBasicAuthHandler 不给隧道加认证头，实测 407）。
            tunnel = _proxy_for(request.full_url)
            if tunnel is not None and tunnel.username is not None:
                return _request_through_proxy(request, tunnel, timeout_s)
            # 没有代理（或代理无需凭据）：用显式建好的 opener，而不是
            # urllib.request.urlopen —— 后者只认 `https_proxy` 这个**名字**，
            # 仓库约定的 `TRADE_TOOL_HTTPS_PROXY` 会被它归到 `trade_tool_https`
            # 而**静默失效**（详见文件末尾的说明）。
            with _shared_opener().open(request, timeout=timeout_s) as response:
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


# --------------------------------------------------------------- 出网代理
#
# 为什么需要这一段（2026-10-19 在目标机上定位到）：
#
# 本仓库约定代理走 `TRADE_TOOL_HTTP_PROXY` / `TRADE_TOOL_HTTPS_PROXY`（AGENTS.md §2.3、
# deploy/README §6）。但 **stdlib urllib 不认这两个名字**：`getproxies()` 会把任何
# `*_proxy` 结尾的环境变量收进来，于是它把 `TRADE_TOOL_HTTPS_PROXY` 理解成
# 「一个名叫 ``trade_tool_https`` 的代理」，而不是 https 请求该用的那个。实测：
#
#     >>> urllib.request.getproxies()
#     {'trade_tool_http': '…', 'trade_tool_https': '…', 'trade_tool_no': '…'}
#
# 后果是**所有 https 请求都直连**，而目标机的出网只有代理这一条路，于是每一次行情请求
# 都以 `NETWORK_ERROR: Network is unreachable` 收场——同步守护进程照常运行、照常调度，
# 只是一条数据也拉不进来（目标机上 BTCUSDT / SOLUSDT 自 2026-10-16 起就是这个状态）。
#
# 第二个坑：`urllib` **不支持在代理 URL 里带账号密码**（userinfo 会被丢掉，CONNECT 时
# 不发 Proxy-Authorization），而目标机的代理是要认证的，所以光把名字对上还不够。
#
# 因此这里**显式**解析代理、自己建 opener，不再指望 urllib 猜。仍然只用标准库。

#: 仓库约定的代理变量优先，其次才是标准的 ``HTTP_PROXY`` / ``HTTPS_PROXY``。
PROXY_ENV_BY_SCHEME: Mapping[str, tuple[str, ...]] = {
    "http": ("TRADE_TOOL_HTTP_PROXY", "HTTP_PROXY", "http_proxy"),
    "https": ("TRADE_TOOL_HTTPS_PROXY", "HTTPS_PROXY", "https_proxy"),
}

#: 仓库约定的 ``no_proxy`` 也认（compose 会把它映射成标准的 ``NO_PROXY``，本地开发不会）。
NO_PROXY_ENV = ("TRADE_TOOL_NO_PROXY", "NO_PROXY", "no_proxy")


@dataclass(frozen=True, slots=True)
class ProxyConfig:
    """一个 scheme 的出网代理。``host_port`` 已剥掉账号密码。"""

    scheme: str
    host_port: str
    username: str | None
    password: str | None

    def host_port_host(self) -> str:
        return self.host_port.rsplit(":", 1)[0]

    def host_port_port(self) -> int:
        return int(self.host_port.rsplit(":", 1)[1])


def _unquote(value: str) -> str:
    return urllib.parse.unquote(value)


def read_proxy_config() -> dict[str, ProxyConfig]:
    """读出当前生效的代理配置（没有配置就是空 dict）。

    解析失败**不静默忽略**：代理 URL 写错时，直连会得到一个「Network is unreachable」
    的谜之错误，而真正的原因（URL 格式不对）只在这里说得出。
    """
    config: dict[str, ProxyConfig] = {}
    for scheme, env_names in PROXY_ENV_BY_SCHEME.items():
        raw = ""
        for name in env_names:
            value = os.environ.get(name, "")
            if value.strip():
                raw = value.strip()
                break
        if not raw:
            continue
        try:
            parsed = urllib.parse.urlparse(raw)
        except ValueError as exc:
            raise SyncError(
                "CONFIG_INVALID",
                f"{scheme.upper()} 代理地址不是合法 URL: {exc}",
                {"raw": raw},
            ) from exc
        if parsed.hostname is None or parsed.port is None:
            raise SyncError(
                "CONFIG_INVALID",
                f"{scheme.upper()} 代理地址缺少主机或端口: {raw}",
                {"raw": raw},
            )
        config[scheme] = ProxyConfig(
            scheme=scheme,
            host_port=f"{parsed.hostname}:{parsed.port}",
            username=_unquote(parsed.username) if parsed.username else None,
            password=_unquote(parsed.password) if parsed.password else None,
        )
    return config


def _build_opener(config: Mapping[str, ProxyConfig]) -> urllib.request.OpenerDirector:
    """按解析出的配置建 opener：带数量的凭据交给 ``ProxyBasicAuthHandler``。

    凭据**必须**走 handler 而不是留在 URL 里——urllib 建 CONNECT 隧道时不会把 userinfo
    变成 ``Proxy-Authorization`` 头，实测会被 407 顶回来。
    """
    handlers: list[urllib.request.BaseHandler] = []
    plain: dict[str, str] = {}
    auth_mgr = urllib.request.HTTPPasswordMgrWithDefaultRealm()
    needs_auth = False
    for scheme, item in config.items():
        plain[scheme] = item.host_port
        if item.username is not None:
            auth_mgr.add_password(None, item.host_port, item.username, item.password or "")
            needs_auth = True
    handlers.append(urllib.request.ProxyHandler(plain))
    if needs_auth:
        handlers.append(urllib.request.ProxyBasicAuthHandler(auth_mgr))
    # HTTPSHandler 的 context 参数默认会校验证书；显式传一个 context 免得在没有 CA 的
    # 精简镜像里报 SSL 上下文找不到（那是环境问题，不是网络问题，别混在一起报）。
    return urllib.request.build_opener(*handlers)


def ensure_no_proxy_env() -> None:
    """把 ``TRADE_TOOL_NO_PROXY`` 映射成 ``no_proxy``。

    urllib 的 ``proxy_bypass`` 只读 ``no_proxy``/``NO_PROXY``。容器里 compose 已经映射过，
    但本地/自建运行环境通常只设了仓库约定的那个名字，于是「数据库不走代理」这条会失效——
    表现是数据库连接偶尔绕一圈代理、代理一抖数据库就连不上。
    """
    standard = os.environ.get("no_proxy") or os.environ.get("NO_PROXY")
    if standard:
        return
    value = os.environ.get("TRADE_TOOL_NO_PROXY", "").strip()
    if value:
        os.environ["no_proxy"] = value


_opener: urllib.request.OpenerDirector | None = None
_opener_key: tuple[tuple[str, str, str | None, str | None], ...] | None = None


def _shared_opener() -> urllib.request.OpenerDirector:
    """按当前代理配置缓存 opener。

    缓存是必要的：``build_opener`` 每次都新建 handler，而代理配置在进程生命周期内不变；
    没有缓存的话每个请求都重建一次，凭据也被反复解析。
    """
    global _opener, _opener_key
    config = read_proxy_config()
    key = tuple(sorted((s, i.host_port, i.username, i.password) for s, i in config.items()))
    if _opener is None or key != _opener_key:
        ensure_no_proxy_env()
        _opener = _build_opener(config)
        _opener_key = key
    return _opener


def describe_proxy() -> str:
    """给日志看的一行说明。**不含账号密码**。"""
    config = read_proxy_config()
    if not config:
        return "未配置出网代理（直连）"
    return "、".join(
        f"{scheme}={item.host_port}" + ("（需认证）" if item.username else "")
        for scheme, item in sorted(config.items())
    )


def _tunnel_through(
    proxy: ProxyConfig, target_host: str, target_port: int, timeout_s: float
) -> socket.socket:
    """通过代理建一条到目标的隧道，返回裸 socket（https 时再由调用方套 TLS）。

    为什么要自己发 CONNECT（2026-10-19 实测）：``urllib.request.ProxyBasicAuthHandler``
    **不会**给 CONNECT 隧道加 ``Proxy-Authorization``——它只在普通转发请求时生效。
    于是「代理要认证 + 目标是 https」这个组合必然 407，症状是
    ``Tunnel connection failed: 407 Proxy Authentication Required``。
    标准库没有可用的替代实现，因此这里手写 CONNECT（仍然只用标准库）。
    """
    sock = socket.create_connection(
        (proxy.host_port_host(), proxy.host_port_port()), timeout=timeout_s
    )
    try:
        request_lines = [
            f"CONNECT {target_host}:{target_port} HTTP/1.1",
            f"Host: {target_host}:{target_port}",
        ]
        if proxy.username is not None:
            token = base64.b64encode(f"{proxy.username}:{proxy.password or ''}".encode()).decode()
            request_lines.append(f"Proxy-Authorization: Basic {token}")
        request_lines.append("Connection: close")
        sock.sendall(("\r\n".join(request_lines) + "\r\n\r\n").encode("ascii"))

        buffer = b""
        while b"\r\n\r\n" not in buffer:
            chunk = sock.recv(4096)
            if not chunk:
                raise SyncError(
                    "NETWORK_ERROR",
                    f"代理 {proxy.host_port} 在 CONNECT 时提前关闭连接",
                    {"proxy": proxy.host_port, "target": f"{target_host}:{target_port}"},
                )
            buffer += chunk
        status_line = buffer.split(b"\r\n", 1)[0].decode("latin-1")
        parts = status_line.split()
        code = int(parts[1]) if len(parts) >= 2 and parts[1].isdigit() else 0
        if code != 200:
            raise SyncError(
                "NETWORK_ERROR",
                f"代理拒绝 CONNECT（{status_line}）："
                f"{proxy.host_port} → {target_host}:{target_port}",
                {
                    "proxy": proxy.host_port,
                    "target": f"{target_host}:{target_port}",
                    "statusLine": status_line,
                    "hasCredentials": proxy.username is not None,
                },
            )
        return sock
    except BaseException:
        sock.close()
        raise


def _proxy_for(url: str) -> ProxyConfig | None:
    """这个 URL 该走哪个代理。``no_proxy`` 命中的目标返回 ``None``（直连）。"""
    parsed = urllib.parse.urlsplit(url)
    scheme = parsed.scheme.lower()
    config = read_proxy_config()
    item = config.get(scheme) or config.get("http" if scheme == "https" else "https")
    if item is None:
        return None
    host = parsed.hostname or ""
    if urllib.request.proxy_bypass(host):
        return None
    return item


def _request_through_proxy(
    request: urllib.request.Request, proxy: ProxyConfig, timeout_s: float
) -> HttpResponse:
    """手工 CONNECT + （https 时）TLS + 一次真实请求。

    只在**代理带凭据**时使用（见 ``_tunnel_through`` 的注释）。4xx/5xx 仍然原样返回
    给上层判断，限流才能带 ``Retry-After``（R-21.4）。
    """
    parsed = urllib.parse.urlsplit(request.full_url)
    host = parsed.hostname
    if host is None:
        raise SyncError("CONFIG_INVALID", f"无法解析请求地址: {request.full_url}", {})
    port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)

    sock = _tunnel_through(proxy, host, port, timeout_s)
    if parsed.scheme.lower() == "https":
        sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host)

    connection = http.client.HTTPConnection(host, port, timeout=timeout_s)
    try:
        connection.sock = sock
        path = parsed.path or "/"
        if parsed.query:
            path = f"{path}?{parsed.query}"
        connection.request(request.get_method(), path, headers=dict(request.headers))
        raw = connection.getresponse()
        return HttpResponse(
            status=raw.status,
            body=raw.read(),
            headers={key.lower(): value for key, value in raw.getheaders()},
        )
    except urllib.error.HTTPError as exc:  # 理论上走不到，保留以防 ProxyHandler 复用
        headers = dict(exc.headers.items()) if exc.headers else {}
        return HttpResponse(status=exc.code, body=exc.read(), headers=headers)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise SyncError(
            "NETWORK_ERROR",
            f"请求交易所失败: {request.full_url}",
            {"url": request.full_url, "reason": str(exc), "proxy": proxy.host_port},
        ) from exc
    finally:
        connection.close()
