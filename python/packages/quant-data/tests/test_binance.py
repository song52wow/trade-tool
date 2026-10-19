"""K 线解析与 REST 客户端的测试（附录 A.2 / A.3、R-9、R-10）。"""

from __future__ import annotations

import json
import os

import pytest
from conftest import FakeExchange, SymbolCase, bar_row, bar_row_numeric, local_http_server
from quant_data import http as http_module
from quant_data.binance import (
    KLINE_LIMIT_MAX,
    ONE_MINUTE_MS,
    BinanceClient,
    kline_weight,
    parse_klines,
)
from quant_data.errors import SyncError
from quant_data.http import (
    BASE_URL_ENV,
    UrllibTransport,
    binance_base_url,
    describe_proxy,
    ensure_no_proxy_env,
    read_proxy_config,
)
from quant_data.ratelimit import DEFAULT_BUDGET_PER_MINUTE
from quant_data.sync import plan_estimate


def _client(fake: FakeExchange) -> BinanceClient:
    return BinanceClient(fake, "https://mock.invalid", None)


def test_parse_klines_maps_all_twelve_positional_fields() -> None:
    """接口不返回字段名，必须按位置解析（附录 A.2）。"""
    row = bar_row_numeric(1_700_000_000_000, 100.0)
    assert len(row) == 12
    parsed = parse_klines([row])
    assert len(parsed) == 1
    bar = parsed[0]
    assert bar.time == 1_700_000_000_000
    assert bar.open == 100.0
    assert bar.high == 101.5
    assert bar.low == 98.5
    assert bar.close == 100.5
    assert bar.volume == 12.5
    assert bar.close_time == 1_700_000_000_000 + ONE_MINUTE_MS - 1
    assert bar.quote_volume == pytest.approx(2000.0)
    assert bar.trades == 42


def test_parse_klines_parses_real_wire_shape() -> None:
    """**真实** /fapi/v1/klines 的返回形状：价格/成交量是 JSON 字符串，时间是 JSON 数字。

    这是线上真实响应的形状，解析层必须能处理（否则每个真实响应都会被判非法）。
    """
    payload = json.loads(
        '[["1760000000000","100.0","101.0","99.0","100.5","10.5",1760000059999,"201.0",'
        '7,"0","0","0"]]'
    )
    bar = parse_klines(payload)[0]
    assert bar.time == 1_760_000_000_000
    assert bar.open == 100.0
    assert bar.high == 101.0
    assert bar.low == 99.0
    assert bar.close == 100.5
    assert bar.volume == 10.5
    assert bar.close_time == 1_760_000_059_999
    assert bar.quote_volume == 201.0
    assert bar.trades == 7


def test_parse_klines_maps_real_shape_absent_optional_to_none() -> None:
    """真实响应里 quoteVolume / trades 可能是 null：映射成 None，**不用 0 代替**（R-4.2）。"""
    payload = json.loads(
        '[[1760000000000,"100.0","101.0","99.0","100.5","10.5",1760000059999,null,null,'
        '"0","0","0"]]'
    )
    bar = parse_klines(payload)[0]
    assert bar.quote_volume is None
    assert bar.trades is None
    assert bar.volume == 10.5


def test_parse_klines_accepts_numeric_string_times() -> None:
    """时间字段通常是 JSON 数字，但数字字符串也必须接受（健壮性）。"""
    payload = [
        [
            "1760000000000",
            "1.0",
            "1.0",
            "1.0",
            "1.0",
            "1.0",
            "1760000059999",
            "1.0",
            "1",
            "0",
            "0",
            "0",
        ]
    ]
    bar = parse_klines(payload)[0]
    assert bar.time == 1_760_000_000_000
    assert bar.close_time == 1_760_000_059_999
    assert bar.trades == 1


@pytest.mark.parametrize("bad", ["not-a-number", "nan", "inf", "-inf", "", True, {"v": 1}, [1]])
def test_parse_klines_rejects_unparseable_or_non_finite(bad: object) -> None:
    """解析不了 / 非有限数 / 布尔一律 EXCHANGE_ERROR，绝不静默当 0。"""
    row = bar_row_numeric(1_700_000_000_000, 100.0)
    row[1] = bad
    with pytest.raises(SyncError) as excinfo:
        parse_klines([row])
    assert excinfo.value.code == "EXCHANGE_ERROR"


def test_parse_klines_string_null_quote_volume_keeps_semantics() -> None:
    row = bar_row(1_700_000_000_000, 100.0)
    row[7] = None
    row[8] = None
    bar = parse_klines([row])[0]
    assert bar.quote_volume is None
    assert bar.trades is None


def test_parse_klines_rejects_null_in_mandatory_field() -> None:
    """time/open/high/low/close/volume 出现 null 即数据损坏（R-4.1 / AC-9）。"""
    row = bar_row_numeric(1_700_000_000_000, 100.0)
    row[1] = None
    with pytest.raises(SyncError) as excinfo:
        parse_klines([row])
    assert excinfo.value.code == "NULL_NOT_ALLOWED"
    assert excinfo.value.details["field"] == "open"


def test_parse_klines_maps_missing_optional_to_none_not_zero() -> None:
    """quote_volume/trades 缺失映射为 SQL NULL，**禁止**用 0 代替（R-4.2 / R-4.3）。"""
    row = bar_row(1_700_000_000_000, 100.0)
    row[7] = None
    row[8] = None
    bar = parse_klines([row])[0]
    assert bar.quote_volume is None
    assert bar.trades is None


def test_parse_klines_rejects_short_row() -> None:
    with pytest.raises(SyncError) as excinfo:
        parse_klines([[1, 2.0, 3.0]])
    assert excinfo.value.code == "EXCHANGE_ERROR"


def test_parse_klines_rejects_non_array_payload() -> None:
    with pytest.raises(SyncError) as excinfo:
        parse_klines({"code": -1121, "msg": "Invalid symbol."})
    assert excinfo.value.code == "EXCHANGE_ERROR"


def test_parse_klines_rejects_infinite_number() -> None:
    row = bar_row(1_700_000_000_000, 100.0)
    row[4] = float("inf")
    with pytest.raises(SyncError) as excinfo:
        parse_klines([row])
    assert excinfo.value.code == "EXCHANGE_ERROR"


@pytest.mark.parametrize(
    ("limit", "expected"),
    [(1, 1), (100, 1), (101, 2), (500, 2), (501, 5), (1000, 5), (1001, 10), (1500, 10)],
)
def test_kline_weight_matches_measured_tiers(limit: int, expected: int) -> None:
    """附录 A.3 的实测权重分层。"""
    assert kline_weight(limit) == expected


def test_plan_estimate_uses_runtime_onboard_date_and_page_tier() -> None:
    """规模预估：requests=ceil(bars/1500)，weight=requests*10，耗时按预算折算（R-8.3）。"""
    start = 1_704_285_900_000
    end = start + 1_500 * ONE_MINUTE_MS * 4
    estimate = plan_estimate("SOMEUSDC", start, end, 1920)
    assert estimate["bars"] == 1500 * 4 + 1
    assert estimate["requests"] == 5
    assert estimate["weight"] == 50
    assert estimate["estimatedMs"] == int(50 / 1920 * 60_000)
    assert estimate["from"] == start


def test_plan_estimate_rejects_zero_budget() -> None:
    with pytest.raises(SyncError) as excinfo:
        plan_estimate("SOMEUSDC", 0, 1, 0)
    assert excinfo.value.code == "CONFIG_INVALID"


def test_client_counts_requests_and_weight(fake: FakeExchange, symbol_case: SymbolCase) -> None:
    client = _client(fake)
    client.klines(symbol_case.symbol, symbol_case.onboard_date, None, 100)
    assert client.requests == 1
    assert client.weight == 1


def test_client_rejects_page_limit_above_exchange_maximum(fake: FakeExchange) -> None:
    with pytest.raises(SyncError) as excinfo:
        BinanceClient(fake, "https://mock.invalid", None, page_limit=KLINE_LIMIT_MAX + 1)
    assert excinfo.value.code == "CONFIG_INVALID"


def test_client_surfaces_exchange_error_body(fake: FakeExchange, symbol_case: SymbolCase) -> None:
    """未知标的的交易所错误必须原样暴露 code/msg，不静默兜底（R-14 A.3）。"""
    fake.kline_status = 400
    client = _client(fake)
    with pytest.raises(SyncError) as excinfo:
        client.klines(symbol_case.symbol, 0, None, 100)
    assert excinfo.value.code == "EXCHANGE_ERROR"
    assert excinfo.value.details["status"] == 400
    assert "mock down" in str(excinfo.value.details["body"])


def test_client_rate_limit_is_classified(fake: FakeExchange, symbol_case: SymbolCase) -> None:
    fake.rate_limit_on_call = 1
    client = _client(fake)
    with pytest.raises(SyncError) as excinfo:
        client.klines(symbol_case.symbol, 0, None, 100)
    assert excinfo.value.code == "EXCHANGE_RATE_LIMITED"
    assert excinfo.value.details["retryAfterSeconds"] == 3


def test_client_propagates_network_error(fake: FakeExchange, symbol_case: SymbolCase) -> None:
    fake.fail_on_kline_call = 1
    client = _client(fake)
    with pytest.raises(SyncError) as excinfo:
        client.klines(symbol_case.symbol, 0, None, 100)
    assert excinfo.value.code == "NETWORK_ERROR"


def test_exchange_info_requires_object_payload(fake: FakeExchange) -> None:
    payload = _client(fake).exchange_info()
    assert isinstance(payload, dict)
    assert "symbols" in payload


def test_base_url_comes_from_env(monkeypatch: pytest.MonkeyPatch, fake: FakeExchange) -> None:
    """基址必须可被环境变量覆盖，TS 侧靠它接本地 mock server。"""
    monkeypatch.delenv(BASE_URL_ENV, raising=False)
    assert binance_base_url() == "https://fapi.binance.com"
    monkeypatch.setenv(BASE_URL_ENV, "http://127.0.0.1:9999")
    assert binance_base_url() == "http://127.0.0.1:9999"
    client = BinanceClient(fake, None, None)
    assert client.base_url == "http://127.0.0.1:9999"


def test_urllib_transport_returns_http_error_status_with_retry_after() -> None:
    """4xx/5xx 不在传输层抛错，限流才能带 Retry-After 上抛（R-21.4）。

    用本地 mock HTTP server 验证**真实** stdlib urllib 通路，不访问任何外部网络。
    """
    with local_http_server(429, {"Retry-After": "7"}) as base_url:
        response = UrllibTransport().get(f"{base_url}/fapi/v1/klines?symbol=X", timeout_ms=2000)
    assert response.status == 429
    assert response.header("retry-after") == "7"


def test_urllib_transport_round_trips_json_over_local_server() -> None:
    with local_http_server(200, {}) as base_url:
        response = UrllibTransport().get(f"{base_url}/fapi/v1/exchangeInfo", timeout_ms=2000)
    assert response.status == 200
    assert response.json(context="exchangeInfo") == {"symbols": []}


def test_urllib_transport_raises_network_error_for_unreachable_host() -> None:
    with pytest.raises(SyncError) as excinfo:
        UrllibTransport().get("http://127.0.0.1:1/never", timeout_ms=250)
    assert excinfo.value.code == "NETWORK_ERROR"


def test_default_budget_leaves_headroom_under_exchange_quota() -> None:
    """预算上限是配额的 80%，留余量给人工排查（R-20.3 / 附录 A.3）。"""
    assert DEFAULT_BUDGET_PER_MINUTE == 1920 < 2400


# --------------------------------------------------------------- 出网代理
#
# 这组用例锁的是 2026-10-19 在目标机上定位到的那个坑：`urllib` 只认名字**恰好**是
# `https_proxy` 的变量，仓库约定的 `TRADE_TOOL_HTTPS_PROXY` 会被它归到
# `trade_tool_https` 而静默失效，于是所有 https 请求直连、全军覆没。


def _clear_proxy_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "TRADE_TOOL_HTTP_PROXY",
        "TRADE_TOOL_HTTPS_PROXY",
        "TRADE_TOOL_NO_PROXY",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "no_proxy",
    ):
        monkeypatch.delenv(name, raising=False)
    # opener 是按代理配置缓存的，换了环境变量必须让它重建
    monkeypatch.setattr(http_module, "_opener", None)
    monkeypatch.setattr(http_module, "_opener_key", None)


def test_repo_proxy_env_is_used(monkeypatch: pytest.MonkeyPatch) -> None:
    """仓库约定的 TRADE_TOOL_HTTPS_PROXY 必须被认成 https 的代理。"""
    _clear_proxy_env(monkeypatch)
    assert read_proxy_config() == {}

    monkeypatch.setenv("TRADE_TOOL_HTTPS_PROXY", "http://192.168.1.79:7890")
    config = read_proxy_config()
    assert config["https"].host_port == "192.168.1.79:7890"
    assert config["https"].username is None
    assert "http" not in config

    # 标准变量仍然兼容（本机 shell 里设的是它）
    monkeypatch.delenv("TRADE_TOOL_HTTPS_PROXY")
    monkeypatch.setenv("HTTPS_PROXY", "http://10.0.0.1:3128")
    assert read_proxy_config()["https"].host_port == "10.0.0.1:3128"


def test_proxy_credentials_are_stripped_from_url(monkeypatch: pytest.MonkeyPatch) -> None:
    """带账号密码的代理：凭据单独取出，不留在 host_port 里。

    urllib 建 CONNECT 隧道时不会把 userinfo 变成 Proxy-Authorization 头，
    凭据留在 URL 里等于没填（实测会被 407 顶回来）。
    """
    _clear_proxy_env(monkeypatch)
    monkeypatch.setenv("TRADE_TOOL_HTTPS_PROXY", "http://Clash:s3cr3t@192.168.1.79:7890")
    item = read_proxy_config()["https"]
    assert item.host_port == "192.168.1.79:7890"
    assert item.username == "Clash"
    assert item.password == "s3cr3t"

    # 凭据没被留在 URL 里——留着的话 CONNECT 时不会带 Proxy-Authorization，实测被 407 顶回。
    assert "@" not in item.host_port
    # 真正的认证行为由下面那条「经代理打通」的用例覆盖。


def test_opener_actually_routes_through_the_configured_proxy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """端到端：本地 server 扮演代理，检查请求**确实**经过它。

    只断言配置被读到是不够的——原来的 bug 正是「配置读到了但没被用上」。
    代理 server 收到请求就回 418，因此断言的是**代理收到了**，而不是目标站收到了。
    """
    _clear_proxy_env(monkeypatch)
    seen: list[str] = []

    def handler(path: str) -> tuple[int, dict[str, str], bytes]:
        seen.append(path)
        return 418, {}, b'{"proxy":"hit"}'

    with local_http_server(200, {}, handler=handler) as proxy_base:
        # 配 **http** 代理并请求 **http** 地址：这样不需要 CONNECT 隧道，
        # 而 mock server 也实现不了 CONNECT。https over proxy 走的是同一条
        # ProxyHandler 通路，只是多一层 CONNECT，本用例断言的是「有没有走代理」。
        monkeypatch.setenv("TRADE_TOOL_HTTP_PROXY", proxy_base)
        # 目标地址故意指向一个**不存在**的域名：只要它被穿过代理成功，
        # 就说明请求没有走直连。
        response = UrllibTransport().get("http://unreachable.invalid/x", timeout_ms=2000)

    assert response.status == 418
    assert seen, "请求没有被送进代理"


def test_no_proxy_is_mirrored_for_bypass(monkeypatch: pytest.MonkeyPatch) -> None:
    """仓库约定的 no_proxy 要映射成 urllib 认的那个名字，否则「库不走代理」失效。"""
    _clear_proxy_env(monkeypatch)
    monkeypatch.setenv("TRADE_TOOL_NO_PROXY", "postgres,127.0.0.1")
    ensure_no_proxy_env()
    assert os.environ["no_proxy"] == "postgres,127.0.0.1"


def test_bad_proxy_url_fails_loudly(monkeypatch: pytest.MonkeyPatch) -> None:
    """代理地址写错必须明确报错，而不是变成一个谜之的「网络不通」。"""
    _clear_proxy_env(monkeypatch)
    monkeypatch.setenv("TRADE_TOOL_HTTPS_PROXY", "http://只有主机没有端口")
    with pytest.raises(SyncError) as excinfo:
        read_proxy_config()
    assert excinfo.value.code == "CONFIG_INVALID"


def test_describe_proxy_has_no_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    """这行会进日志，绝不能带上密码。"""
    _clear_proxy_env(monkeypatch)
    monkeypatch.setenv("TRADE_TOOL_HTTPS_PROXY", "http://Clash:s3cr3t@192.168.1.79:7890")
    text = describe_proxy()
    assert "192.168.1.79:7890" in text
    assert "需认证" in text
    assert "s3cr3t" not in text
    assert "Clash" not in text


def test_proxy_407_is_reported_as_such(monkeypatch: pytest.MonkeyPatch) -> None:
    """代理回 407 时，报错必须写明「代理拒绝 CONNECT」，而不是一个谜之的网络错误。

    这条锁的是「人能不能从日志里看出该改代理认证还是该改网络」。
    """
    _clear_proxy_env(monkeypatch)
    with local_http_server(200, {}) as proxy_base:
        monkeypatch.setenv(
            "TRADE_TOOL_HTTPS_PROXY", proxy_base.replace("http://", "http://Clash:pw@")
        )
        with pytest.raises(SyncError) as excinfo:
            UrllibTransport().get("https://fapi.binance.com/fapi/v1/ping", timeout_ms=2000)

    assert excinfo.value.code == "NETWORK_ERROR"
    assert "代理拒绝 CONNECT" in str(excinfo.value)
    assert excinfo.value.details["hasCredentials"] is True
