"""行情上下文：分析师 Agent 的输入（v1.0.0）。

这个模块回答一个问题：**「现在这个标的长什么样」**——把三类事实取齐、算好、
交给上层（TS 侧）去喂给模型。

## 三个面的数据从哪来

| 面       | 数据                                                        | 谁算的                |
| -------- | ----------------------------------------------------------- | --------------------- |
| 技术面   | 库内**已收盘的派生 K 线** + 7 组技术指标                      | **本模块**（Python）  |
| 情绪面   | 资金费率、基差、持仓量、多空账户比、主动买卖比                | **本模块**（出网）    |
| 基本面   | 24 小时成交额与涨跌幅（本模块）+ 合约规格（TS 侧读 `contract_spec`） | 两边各一半   |

## 为什么技术面在 Python 算

**指标公式全仓唯一一份在 `quant_core`**（AGENTS.md §6.2）。TS 侧若自己算一遍，
同一根 K 线上的同一个指标会因浮点舍入而分叉，症状是「回测赚钱、实盘不赚」，
而且几乎无法定位。

因此这里**不物化** `indicator_*` 表，而是按需现算：单标的几百根 K 线算一遍
七个指标是毫秒级的事，而物化整张表要占单轮同步 **72%** 的耗时（AGENTS.md §6.2）。
**指标层默认关闭也不影响分析师**——它用的是自己的计算路径。

## 为什么情绪面「缺了也要往下走」

情绪面的六个接口都是公开的，但交易所偶尔会抖。某一项取不到时：

- 该项记为 ``null``（**不用 0 冒充**——「资金费率是 0」和「没取到资金费率」是两件事）；
- 失败原因进 ``notes``；
- 整个情绪面标上 ``degraded = True``。

**技术面取不到则直接报错**（``AGENT_CONTEXT_UNAVAILABLE``）：没有 K 线就没有
「现在长什么样」，硬凑一个结论不如不分析。

这样分的理由是处置方式不同：情绪面缺项是「少一个参考」，技术面缺失是
「没法分析」。两者的严重度差着量级，混成一个处理方式就会把「少一个参考」
也当成致命错误——于是每逢交易所抖动，Agent 就整轮不出东西。

## 客观倾向分

除了把指标值交给模型，本模块还按**固定规则**算一个客观倾向分
（:func:`objective_bias`）。它的作用是给模型一个锚点：模型可以不同意，
但「模型说 +0.9、客观分是 -0.6」这种分歧会被原样记录下来，复核时一眼能看出。

**这条规则在 Python，不在 TS**：它是「指标之上的组合判断」，与
``aggregate.judge_bucket`` 同一性质（判据只有一份实现，AGENTS.md §6.1）。
"""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping, Sequence

import numpy as np
from quant_core.io import log

from . import indicators as ind_mod
from .aggregate import BUCKET_WIDTHS_MS, DERIVED_TABLES
from .binance import BinanceClient
from .errors import SyncError
from .http import Transport, UrllibTransport, binance_base_url
from .pg import DbConn, connect
from .ratelimit import DEFAULT_BUDGET_PER_MINUTE, WeightBudget

#: 喂给模型的近期收益率根数。
RECENT_RETURN_BARS = 20

#: OBV 的变化量看最近多少根。
OBV_CHANGE_BARS = 20

#: 资金费率的结算频率：每 8 小时一次，即每天 3 次。
FUNDING_PERIODS_PER_DAY = 3

#: 年化用的天数（365）。资金费率年化 = 单次费率 × 每天次数 × 365。
DAYS_PER_YEAR = 365

#: 情绪面各接口的取数周期与条数。
#:
#: 24 小时是「一天」的量纲，对永续合约的多空结构是合适的观察窗。
SENTIMENT_PERIOD = "1h"
SENTIMENT_LIMIT = 24

#: `_safe` 的返回值类型变量。


# --------------------------------------------------------------------- 技术面


def _tail_value(values: np.ndarray) -> float | None:
    """取**最后一个**有效值。

    不是「往回找最后一个有效值」——那样会拿到一段陈旧的值却看不出它陈旧。
    预热期没走完时最后一个值就是 ``NaN``，此时返回 ``None``：
    **算不出来就说算不出来，不用 0 冒充**（AGENTS.md 约定 9）。
    """
    if values.size == 0:
        return None
    last = float(values[-1])
    if not math.isfinite(last):
        return None
    return last


def _round(value: float | None, digits: int = 8) -> float | None:
    if value is None:
        return None
    return round(value, digits)


def _indicator_payload(
    specs: Sequence[ind_mod.ParamSet], series: ind_mod.Series
) -> dict[str, object]:
    """按 ``DEFAULT_SPECS`` 算一遍，取每个输出的**最后一个**有效值。

    参数集用 :data:`indicators.DEFAULT_SPECS`——与物化层同一份，
    因此分析师看到的 MA20 与库里物化出来的 MA20 是同一个数（同一份公式、同一组参数）。
    """
    ma_rows: list[dict[str, object]] = []
    rsi_rows: list[dict[str, object]] = []
    macd: dict[str, float] | None = None
    boll: dict[str, float] | None = None
    kdj: dict[str, float] | None = None
    atr_value: float | None = None
    obv_value: float | None = None
    obv_change: float | None = None
    missing: list[str] = []

    for spec in specs:
        columns = ind_mod.compute_series(spec, series)
        if spec.indicator == "ma":
            value = _tail_value(columns["value"])
            if value is None:
                missing.append(spec.label())
                continue
            ma_rows.append({"kind": spec.kind or "sma", "bars": spec.params[0], "value": value})
        elif spec.indicator == "macd":
            dif = _tail_value(columns["dif"])
            dea = _tail_value(columns["dea"])
            hist = _tail_value(columns["hist"])
            if dif is None or dea is None or hist is None:
                missing.append(spec.label())
                continue
            macd = {"dif": dif, "dea": dea, "hist": hist}
        elif spec.indicator == "rsi":
            value = _tail_value(columns["value"])
            if value is None:
                missing.append(spec.label())
                continue
            rsi_rows.append({"period": spec.params[0], "value": value})
        elif spec.indicator == "boll":
            upper = _tail_value(columns["upper"])
            mid = _tail_value(columns["mid"])
            lower = _tail_value(columns["lower"])
            if upper is None or mid is None or lower is None:
                missing.append(spec.label())
                continue
            boll = {"upper": upper, "mid": mid, "lower": lower}
        elif spec.indicator == "kdj":
            k = _tail_value(columns["k"])
            d = _tail_value(columns["d"])
            j = _tail_value(columns["j"])
            if k is None or d is None or j is None:
                missing.append(spec.label())
                continue
            kdj = {"k": k, "d": d, "j": j}
        elif spec.indicator == "atr":
            value = _tail_value(columns["value"])
            if value is None:
                missing.append(spec.label())
                continue
            atr_value = value
        elif spec.indicator == "obv":
            raw = columns["value"]
            value = _tail_value(raw)
            if value is None:
                missing.append(spec.label())
                continue
            obv_value = value
            back = min(OBV_CHANGE_BARS, raw.size - 1)
            earlier = _tail_value(raw[: raw.size - back]) if raw.size - back > 0 else value
            obv_change = value - (earlier if earlier is not None else value)

    return {
        "ma": ma_rows,
        "rsi": rsi_rows,
        "macd": macd,
        "boll": boll,
        "kdj": kdj,
        "atr": atr_value,
        "obv": (None if obv_value is None else {"value": obv_value, "change": obv_change or 0.0}),
        "missing": missing,
    }


def _recent_returns(closes: np.ndarray, count: int) -> list[float]:
    """最近若干根的收盘价收益率（百分比数）。

    用相邻两根的收盘价算；**第一根没有前一根**，因此跳过。
    """
    if closes.size < 2:
        return []
    window = closes[-(count + 1) :]
    out: list[float] = []
    for i in range(1, window.size):
        prev = float(window[i - 1])
        if prev == 0:
            continue
        out.append((float(window[i]) - prev) / prev * 100.0)
    return [round(v, 6) for v in out]


def _price_percentile(closes: np.ndarray) -> float:
    """最新收盘价在区间里的分位（``[0, 1]``）。

    用「小于等于最新价的根数 / 总根数」。并列时取靠上的那一档——
    它让「价格处在区间最高点」这件事表达为 1.0。
    """
    if closes.size == 0:
        return 0.0
    last = float(closes[-1])
    count = int(np.count_nonzero(closes <= last))
    return round(count / closes.size, 4)


def objective_bias(payload: Mapping[str, object]) -> tuple[float, list[str]]:
    """按固定规则从指标值算一个客观倾向分（``[-1, 1]``）与逐条依据。

    规则（**全部固定写死**，不读配置、不由模型决定）：

    | 观察                     | 倾向          |
    | ------------------------ | ------------- |
    | 收盘价 > MA20            | +1 / -1      |
    | MA20 > MA60              | +1 / -1      |
    | MACD 柱 > 0              | +1 / -1      |
    | RSI > 55 / < 45          | +1 / -1 / 0  |
    | 收盘价 > 布林中轨        | +1 / -1      |
    | KDJ 的 K > D              | +1 / -1      |
    | OBV 近段变化 > 0         | +1 / -1      |

    每一票是 ``+1 / -1 / 0``（0 = 这条看不出倾向），总分除以票数得到 ``[-1, 1]``。

    **为什么要有它**：模型对同一组数字可能有完全不同的解读。给一个锚点，
    两者的分歧就会显形（「模型 +0.9 / 客观 -0.6」），而不是被模型的自信掩盖过去。
    """
    votes: list[int] = []
    notes: list[str] = []

    closes = payload.get("_closes")
    ma_rows = payload.get("ma")
    ma = {
        (row.get("kind"), row.get("bars")): row.get("value")
        for row in (ma_rows if isinstance(ma_rows, list) else [])
        if isinstance(row, Mapping)
    }
    last_close = closes[-1] if isinstance(closes, np.ndarray) and closes.size else None

    ma20 = ma.get(("sma", 20))
    ma60 = ma.get(("sma", 60))
    if last_close is not None and isinstance(ma20, float):
        votes.append(1 if last_close > ma20 else -1)
        notes.append(
            f"收盘价 {last_close:.6g} {'高于' if last_close > ma20 else '低于'} MA20 {ma20:.6g}"
        )
    if isinstance(ma20, float) and isinstance(ma60, float):
        votes.append(1 if ma20 > ma60 else -1)
        notes.append(f"MA20 {ma20:.6g} {'高于' if ma20 > ma60 else '低于'} MA60 {ma60:.6g}")

    macd = payload.get("macd")
    if isinstance(macd, Mapping):
        hist = macd.get("hist")
        if isinstance(hist, float):
            votes.append(1 if hist > 0 else -1)
            notes.append(f"MACD 柱 {hist:.6g} {'为正' if hist > 0 else '为负'}")

    rsi_rows = payload.get("rsi")
    rsi14: float | None = None
    for row in rsi_rows if isinstance(rsi_rows, list) else []:
        if isinstance(row, Mapping) and row.get("period") == 14:
            value = row.get("value")
            if isinstance(value, float):
                rsi14 = value
    if rsi14 is not None:
        vote = 1 if rsi14 > 55 else (-1 if rsi14 < 45 else 0)
        votes.append(vote)
        notes.append(
            f"RSI(14) {rsi14:.6g} → {'偏多' if vote > 0 else ('偏空' if vote < 0 else '中性')}"
        )

    boll = payload.get("boll")
    if isinstance(boll, Mapping) and last_close is not None:
        mid = boll.get("mid")
        if isinstance(mid, float):
            votes.append(1 if last_close > mid else -1)
            notes.append(f"收盘价 {'高于' if last_close > mid else '低于'} 布林中轨 {mid:.6g}")

    kdj = payload.get("kdj")
    if isinstance(kdj, Mapping):
        k = kdj.get("k")
        d = kdj.get("d")
        if isinstance(k, float) and isinstance(d, float):
            votes.append(1 if k > d else -1)
            notes.append(f"KDJ 的 K {k:.6g} {'高于' if k > d else '低于'} D {d:.6g}")

    obv = payload.get("obv")
    if isinstance(obv, Mapping):
        change = obv.get("change")
        if isinstance(change, float):
            votes.append(1 if change > 0 else -1)
            notes.append(f"OBV 近段变化 {change:.6g} {'为正' if change > 0 else '为负'}")

    if not votes:
        return 0.0, ["可用指标不足，客观倾向分按 0 计"]
    bias = sum(votes) / len(votes)
    return round(bias, 4), notes


def technical_snapshot(
    conn: DbConn,
    symbol: str,
    interval: str,
    bars: int,
) -> dict[str, object]:
    """技术面快照：读库内派生 K 线 → 算指标 → 给客观倾向分。

    只用**最后一段连续** K 线：指标公式假定 bar 之间等距连续，
    跨着缺口算出来的 ATR 是错的。缺了的那一段不会被「当成平的」——
    它直接不进这一段（这与指标物化层的分段口径一致）。

    @throws SyncError 'CONFIG_INVALID' 周期不在白名单；'AGENT_CONTEXT_UNAVAILABLE'
            库里没有该标的的派生 K 线，或最后一段连续 K 线太短。
    """
    if interval not in DERIVED_TABLES:
        raise SyncError(
            "CONFIG_INVALID",
            f"分析周期只支持派生周期：{sorted(DERIVED_TABLES)}（收到 {interval}）",
            {"interval": interval, "supported": sorted(DERIVED_TABLES)},
        )
    if bars <= 0:
        raise SyncError("CONFIG_INVALID", f"分析根数必须为正（收到 {bars}）", {"bars": bars})

    table = DERIVED_TABLES[interval]
    interval_ms = BUCKET_WIDTHS_MS[interval]
    row = conn.execute(f"SELECT max(time) FROM {table} WHERE symbol = %s", (symbol,)).fetchone()
    if row is None or row["max"] is None:
        raise SyncError(
            "AGENT_CONTEXT_UNAVAILABLE",
            f"{symbol} 在 {interval} 上没有任何派生 K 线：先同步该标的并跑聚合，否则算不出技术面",
            {"symbol": symbol, "interval": interval},
        )
    hi_ms = int(row["max"])
    lo_ms = hi_ms - bars * interval_ms
    times, series = ind_mod.read_derived_bars(conn, symbol, interval, lo_ms, hi_ms)
    if not times:
        raise SyncError(
            "AGENT_CONTEXT_UNAVAILABLE",
            f"{symbol} 在 {interval} 上读不到派生 K 线（区间 {lo_ms}..{hi_ms}）：先跑聚合",
            {"symbol": symbol, "interval": interval},
        )

    segments = ind_mod.split_segments(times, interval_ms)
    last = segments[-1]
    seg = ind_mod.slice_series(series, last.lo, last.hi)
    if seg.close.size == 0:
        raise SyncError(
            "AGENT_CONTEXT_UNAVAILABLE",
            f"{symbol} 在 {interval} 上最后一段连续 K 线为空",
            {"symbol": symbol, "interval": interval},
        )

    payload = _indicator_payload(ind_mod.DEFAULT_SPECS, seg)
    closes = seg.close
    last_close = float(closes[-1])
    atr_value = payload.get("atr")
    atr = float(atr_value) if isinstance(atr_value, float) else None
    if atr is None or atr <= 0:
        raise SyncError(
            "AGENT_CONTEXT_UNAVAILABLE",
            f"{symbol} 在 {interval} 上算不出 ATR（最后一段连续 K 线只有 {seg.close.size} 根）："
            f"数据不够，算不出技术面",
            {"symbol": symbol, "interval": interval, "segmentBars": int(seg.close.size)},
        )

    bias, bias_notes = objective_bias({**payload, "_closes": closes})
    missing = payload.get("missing")
    notes = list(bias_notes)
    if isinstance(missing, list) and missing:
        notes.append("算不出来的指标：" + "、".join(str(m) for m in missing))

    return {
        "interval": interval,
        "bars": len(times),
        "segmentBars": int(seg.close.size),
        "fromMs": int(times[last.lo]),
        "toMs": int(times[last.hi - 1]),
        "lastClose": last_close,
        "atr": atr,
        "atrPeriod": 14,
        "atrPercentOfPrice": round(atr / last_close, 8) if last_close else 0.0,
        "ma": payload.get("ma"),
        "macd": payload.get("macd"),
        "rsi": payload.get("rsi"),
        "boll": payload.get("boll"),
        "kdj": payload.get("kdj"),
        "obv": payload.get("obv"),
        "recentReturns": _recent_returns(closes, RECENT_RETURN_BARS),
        "pricePercentile": _price_percentile(closes),
        "objectiveBias": bias,
        "objectiveNotes": notes,
    }


# --------------------------------------------------------------------- 情绪面


def _as_float(value: object, field: str) -> float | None:
    """交易所的数值字段是**字符串**。解析不出来就返回 ``None``，不猜。"""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        parsed = float(value)
    elif isinstance(value, str):
        try:
            parsed = float(value.strip())
        except ValueError:
            return None
    else:
        return None
    if not math.isfinite(parsed):
        return None
    return parsed


def _safe[T](call: Callable[[], T], label: str, notes: list[str]) -> T | None:
    """跑一个取数，失败就记一笔并返回 ``None``。

    **不抛错**：情绪面缺一项不该让整轮分析作废（见模块头的「为什么缺了也要往下走」）。
    但失败必须**留痕**——``notes`` 里逐条写明哪个接口没取到、为什么。
    """
    try:
        return call()
    except SyncError as exc:
        notes.append(f"{label} 取数失败：{exc.message}")
        return None
    except Exception as exc:  # pragma: no cover - 兜底：任何意外都不该让整轮崩掉
        notes.append(f"{label} 取数失败：{exc}")
        return None


def sentiment_snapshot(client: BinanceClient, symbol: str) -> dict[str, object]:
    """情绪面快照：持仓者的钱往哪边压。

    六个公开接口 + 一个 24 小时统计。任一项取不到就记 ``None`` 并在 ``notes`` 里说明。
    """
    notes: list[str] = []
    degraded = False

    premium = _safe(lambda: client.premium_index(symbol), "标记价/资金费率", notes)
    if premium is None:
        degraded = True
    mark_price = _as_float(
        premium.get("markPrice") if isinstance(premium, Mapping) else None, "markPrice"
    )
    index_price = _as_float(
        premium.get("indexPrice") if isinstance(premium, Mapping) else None, "indexPrice"
    )
    funding_rate = _as_float(
        premium.get("lastFundingRate") if isinstance(premium, Mapping) else None, "lastFundingRate"
    )
    next_funding = premium.get("nextFundingTime") if isinstance(premium, Mapping) else None
    next_funding_ms = int(next_funding) if isinstance(next_funding, int) else None

    history = _safe(lambda: client.funding_rate(symbol, 3), "历史资金费率", notes)
    if history is None:
        degraded = True
    elif isinstance(history, list) and history:
        rates = [
            value
            for value in (
                _as_float(row.get("fundingRate"), "fundingRate")
                for row in history
                if isinstance(row, Mapping)
            )
            if value is not None
        ]
        if rates and funding_rate is None:
            funding_rate = rates[-1]

    oi_now = _safe(lambda: client.open_interest(symbol), "当前持仓量", notes)
    if oi_now is None:
        degraded = True
    open_interest = _as_float(
        oi_now.get("openInterest") if isinstance(oi_now, Mapping) else None, "openInterest"
    )

    oi_hist = _safe(
        lambda: client.open_interest_hist(symbol, SENTIMENT_PERIOD, SENTIMENT_LIMIT),
        "持仓量历史",
        notes,
    )
    if oi_hist is None:
        degraded = True
    oi_change: float | None = None
    if isinstance(oi_hist, list) and len(oi_hist) >= 2:
        values = [
            value
            for value in (
                _as_float(row.get("sumOpenInterest"), "sumOpenInterest")
                for row in oi_hist
                if isinstance(row, Mapping)
            )
            if value is not None
        ]
        if len(values) >= 2 and values[0] != 0:
            oi_change = round((values[-1] - values[0]) / values[0] * 100.0, 4)

    ls_rows = _safe(
        lambda: client.global_long_short_ratio(symbol, SENTIMENT_PERIOD, 1),
        "多空账户比",
        notes,
    )
    if ls_rows is None:
        degraded = True
    long_short_ratio: float | None = None
    if isinstance(ls_rows, list) and ls_rows:
        last = ls_rows[-1]
        if isinstance(last, Mapping):
            long_short_ratio = _as_float(last.get("longShortRatio"), "longShortRatio")

    taker_rows = _safe(
        lambda: client.taker_long_short_ratio(symbol, SENTIMENT_PERIOD, 1),
        "主动买卖量比",
        notes,
    )
    if taker_rows is None:
        degraded = True
    taker_ratio: float | None = None
    if isinstance(taker_rows, list) and taker_rows:
        last = taker_rows[-1]
        if isinstance(last, Mapping):
            taker_ratio = _as_float(last.get("buySellRatio"), "buySellRatio")

    ticker = _safe(lambda: client.ticker_24h(symbol), "24 小时统计", notes)
    if ticker is None:
        degraded = True
    quote_volume = _as_float(
        ticker.get("quoteVolume") if isinstance(ticker, Mapping) else None, "quoteVolume"
    )
    trades = ticker.get("count") if isinstance(ticker, Mapping) else None
    trades_24h = int(trades) if isinstance(trades, int) else None
    change_pct = _as_float(
        ticker.get("priceChangePercent") if isinstance(ticker, Mapping) else None,
        "priceChangePercent",
    )

    basis_bps: float | None = None
    if mark_price is not None and index_price is not None and index_price != 0:
        basis_bps = round((mark_price - index_price) / index_price * 10_000.0, 4)

    annualized = funding_rate * FUNDING_PERIODS_PER_DAY * DAYS_PER_YEAR if funding_rate else None

    if funding_rate is None:
        notes.append("资金费率没取到：情绪面少一个最重要的参考")
    if long_short_ratio is None:
        notes.append("多空账户比没取到")
    if taker_ratio is None:
        notes.append("主动买卖量比没取到")
    if open_interest is None:
        notes.append("持仓量没取到")

    return {
        "fundingRate": _round(funding_rate, 10),
        "fundingRateAnnualized": _round(annualized, 6),
        "nextFundingTimeMs": next_funding_ms,
        "markPrice": mark_price,
        "indexPrice": index_price,
        "basisBps": basis_bps,
        "openInterest": open_interest,
        "openInterestChangePct": oi_change,
        "longShortRatio": long_short_ratio,
        "takerBuySellRatio": taker_ratio,
        "notes": notes,
        "degraded": degraded,
        "market": {
            "quoteVolume24h": quote_volume,
            "trades24h": trades_24h,
            "priceChangePct24h": change_pct,
        },
    }


# ------------------------------------------------------------------ CLI 入口


def run_market_context(
    *,
    symbol: str,
    interval: str,
    bars: int,
    weight_budget: int = DEFAULT_BUDGET_PER_MINUTE,
    dsn: str | None = None,
    transport: Transport | None = None,
) -> dict[str, object]:
    """CLI / 桥接入口：连库算技术面、出网取情绪面，回一个 JSON 摘要。

    ``dsn`` 只走环境变量注入（``pg.connect`` 内部解析 ``TRADE_TOOL_PG_DSN``），
    绝不出现在 argv 或返回值里。
    """
    if not symbol:
        raise SyncError("CONFIG_INVALID", "缺少 --symbol", {"symbol": symbol})
    conn = connect(dsn)
    try:
        technical = technical_snapshot(conn, symbol, interval, bars)
        # 配额桶与库里那批请求共用**同一个连接**：`WeightBudget` 每次预留都要
        # 写一行 `weight_budget`（PG 协调的令牌桶），连接关了它就用不了。
        budget = WeightBudget(conn, weight_budget)
        client = BinanceClient(
            transport if transport is not None else UrllibTransport(),
            binance_base_url(),
            budget,
        )
        sentiment = sentiment_snapshot(client, symbol)
    finally:
        conn.close()

    log(f"market-context {symbol} {interval}: 技术面 {technical['segmentBars']} 根连续 K 线")
    return {
        "symbol": symbol,
        "interval": interval,
        "technical": technical,
        "sentiment": sentiment,
        "market": sentiment.get("market"),
    }
