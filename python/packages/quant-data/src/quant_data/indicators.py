"""技术指标物化（v0.3.0 R-4 / R-6）。

沿用 v0.2.0 的同一条链：**高周期只由库内 1m 派生，指标只由库内已收盘的派生 K 线派生**。
本地计算 + 本地 SQL——不出网、不花交易所配额、不起子进程、不引入新依赖（R-5.3）。

四条不可协商的规则：

1. **连续段各自独立重算，段间不递推**（R-4.2）。若跨缺口递推，「回补一个久远的 1m 缺口」
   会把此后**全部**指标值静默改掉，而界面上看不出任何解释。缺口就是噪声，不得跨越。
   这不是实现偏好而是**被迫的**：RSI 的递推状态是 ``avgGain`` / ``avgLoss`` 两个绝对量，
   而输出只有它们的比值，由 ``RSI_{i−1}`` 拿不回绝对水平，因此无法从上一行续算（A.3）。

2. **预热期不落库**（R-4.3）。段内位置早于有效起点的行**不写**：不写 NaN、不写 NULL、
   更不写 0 冒充缺失。因此库里每一行都是有效值，读侧不必做 NaN 分支。段长度不足以
   越过预热期时该段**一行都不写**（记 ``withheldWarmup``）。

3. **值未变时不产生新行**（R-4.4）。UPSERT 带「值不同才更新」，因此 ``rowcount`` 就是
   真正改动的行数——重复执行同一区间第二次必然是 0（R-6.7 / AC-7）。

4. **不混版**（R-4.6）。已物化的最大 ``impl_version`` ≠ 当前 ``INDICATOR_IMPL_VERSION``
   时**拒绝写入**并抛 ``INDICATOR_IMPL_STALE``。「前半段 v1、后半段 v2」是最坏的结果
   ——它看起来完全正常。

**表名与列名不可参数化**：一律先过 :data:`INDICATOR_TABLES` / :data:`DERIVED_TABLES`
白名单再进 SQL，绝不把运行时字符串拼进 SQL（v0.2.0 R-6.2 继续成立）。
"""

from __future__ import annotations

import json
import weakref
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

import numpy as np
from quant_core import (
    INDICATOR_IMPL_VERSION,
    IndicatorError,
    atr,
    boll,
    ema,
    kdj,
    macd,
    obv,
    rsi,
    sma,
)
from quant_core.indicators import FloatArray

from .aggregate import ALLOWED_DERIVED, BUCKET_WIDTHS_MS, DERIVED_TABLES, bucket_start
from .errors import SyncError
from .pg import DbConn

#: 指标名 -> 表名。**必须**与 ``packages/data/sql/005_indicators.sql`` 的表集合、
#: ``packages/core`` 的 ``INDICATOR_TABLES`` 三方一致（R-3.3 / AC-2）。
INDICATOR_TABLES: Mapping[str, str] = {
    "ma": "indicator_ma",
    "macd": "indicator_macd",
    "rsi": "indicator_rsi",
    "boll": "indicator_boll",
    "kdj": "indicator_kdj",
    "atr": "indicator_atr",
    "obv": "indicator_obv",
}

#: 本期物化的周期白名单。与派生周期集合一致，**不含 1m**（N-2）、不含 5m（N-3）。
ALLOWED_INDICATOR_INTERVALS: tuple[str, ...] = tuple(ALLOWED_DERIVED)

IndicatorName = Literal["ma", "macd", "rsi", "boll", "kdj", "atr", "obv"]

#: ``ma`` 的两个 kind。与 ``005_indicators.sql`` 的 CHECK 逐项对应。
MA_KINDS: tuple[str, ...] = ("sma", "ema")

#: 每个指标在主键里的**参数列**（顺序 = 005 里 PK 的顺序）与**值列**。
#: 这两张表是「指标 → 表 + 列集合」的第二份引用，迁移文件是第一份；
#: 两者的三方一致性由 AC-2 的测试断言（不靠人眼）。
PARAM_COLUMNS: Mapping[str, tuple[str, ...]] = {
    "ma": ("kind", "bars"),
    "macd": ("fast", "slow", "signal"),
    "rsi": ("period",),
    "boll": ("period", "k_milli"),
    "kdj": ("n", "k_period", "d_period"),
    "atr": ("period",),
    "obv": (),
}

VALUE_COLUMNS: Mapping[str, tuple[str, ...]] = {
    "ma": ("value",),
    "macd": ("dif", "dea", "hist"),
    "rsi": ("value",),
    "boll": ("upper", "mid", "lower"),
    "kdj": ("k", "d", "j"),
    "atr": ("value",),
    "obv": ("value",),
}

#: **配置键（camelCase，R-12.1 的写法）** -> 数据库列（snake_case）。
#:
#: 两种命名刻意不同：配置是给人写的手感，schema 是既定的跨语言契约。
#: 两者之间只经这一张表映射，因此不存在「哪边写错了」的自由度——多一个、少一个、
#: 大小写不同，一律 ``CONFIG_INVALID``（R-12.1 不提供「宽松解析」）。
_CONFIG_KEYS: Mapping[str, Mapping[str, str]] = {
    "ma": {"kind": "kind", "window": "bars"},
    "macd": {"fast": "fast", "slow": "slow", "signal": "signal"},
    "rsi": {"period": "period"},
    "boll": {"period": "period", "kMilli": "k_milli"},
    "kdj": {"n": "n", "kPeriod": "k_period", "dPeriod": "d_period"},
    "atr": {"period": "period"},
    "obv": {},
}


def validate_indicator_intervals(values: Sequence[str]) -> tuple[str, ...]:
    """校验并按固定次序（短 → 长）归一。

    次序固定是刻意的：摘要输出必须逐次一致，否则「连续两次补齐逐值相同」这条幂等断言
    会因键序漂移而假失败（与 ``aggregate.validate_intervals`` 同理）。
    """
    unknown = [v for v in values if v not in BUCKET_WIDTHS_MS]
    if unknown:
        raise SyncError(
            "CONFIG_INVALID",
            f"指标不支持的周期: {unknown}（本期只支持 {list(ALLOWED_INDICATOR_INTERVALS)}；"
            "1m 不做指标物化——单标的约 4.3 GB/标的；5m 在派生层就没有表）",
            {"intervals": list(values), "supported": list(ALLOWED_INDICATOR_INTERVALS)},
        )
    chosen = set(values)
    return tuple(i for i in ALLOWED_INDICATOR_INTERVALS if i in chosen)


# --------------------------------------------------------------- 参数集（有类型的）


@dataclass(frozen=True, slots=True)
class ParamSet:
    """一个 ``(指标, 参数)`` 组合。**参数是一等列**，不是哈希（R-3.3）。"""

    indicator: IndicatorName
    #: 按该指标的固定次序给出，与 :data:`PARAM_COLUMNS` 的顺序一一对应
    #: （``ma`` 的 ``kind`` 单独存在 ``kind`` 字段里，不进 ``params``）。
    params: tuple[int, ...]
    kind: str | None = None

    def pk_columns(self) -> tuple[str, ...]:
        return PARAM_COLUMNS[self.indicator]

    def pk_values(self) -> tuple[int | str, ...]:
        """进主键 / WHERE 的参数值元组（不含 symbol / interval / impl_version / time）。

        注意 ``kind`` 占用了一个**主键列**位置却**不占** ``params`` 的下标——``ma`` 的
        ``params`` 只有窗口值。因此这里用独立的游标走 ``params``，不能拿
        ``enumerate(pk_columns())`` 的下标去索引 ``params``（那会让 ``bars`` 取到
        ``params[1]``，直接越界）。
        """
        values: list[int | str] = []
        cursor = 0
        for col in self.pk_columns():
            if col == "kind":
                values.append(str(self.kind))
            else:
                values.append(self.params[cursor])
                cursor += 1
        return tuple(values)

    def label(self) -> str:
        """人类可读的参数描述，摘要与「未物化」提示里用它。"""
        if self.indicator == "ma":
            return f"{str(self.kind).upper()}({self.params[0]})"
        return f"{self.indicator.upper()}({', '.join(str(p) for p in self.params)})"

    def params_dict(self) -> dict[str, int | str]:
        """给 JSON 摘要用的参数字典。键名用**数据库列名**，因此控制面可直接回显成
        「哪些参数集已物化」，不需要 TS 侧再维护一张映射。"""
        return dict(zip(self.pk_columns(), self.pk_values(), strict=True))


def _require_int(value: object, label: str, *, allow_zero: bool) -> int:
    """**整数**参数：浮点 / 布尔 / 负数一律 ``CONFIG_INVALID``（R-1.4 / R-12.1）。

    只有 ``k_milli`` 允许 0（``k = 0`` 时三条轨重合在 MID 上）；其余窗口类参数必须 > 0。
    校验放在物化（**写入**）路径上是有意的：坏参数在这里被拦下，才不会往库里写半截数据。
    """
    if isinstance(value, bool) or not isinstance(value, int):
        raise SyncError(
            "CONFIG_INVALID",
            f"{label} 必须是整数（{'>= 0' if allow_zero else '> 0'}），收到：{value!r}",
            {"field": label, "value": repr(value)},
        )
    if value < 0 or (value == 0 and not allow_zero):
        raise SyncError(
            "CONFIG_INVALID",
            f"{label} 必须是{'非负' if allow_zero else '正'}整数，收到：{value}",
            {"field": label, "value": value},
        )
    return value


def _param_key_name(indicator: str, column: str) -> str:
    for key, col in _CONFIG_KEYS[indicator].items():
        if col == column:
            return key
    raise SyncError(  # pragma: no cover - 常量表与调用方同步维护
        "INTERNAL_ERROR",
        f"指标 {indicator} 没有列 {column}",
        {"indicator": indicator, "column": column},
    )


def parse_specs(raw: object, *, source: str = "data.indicatorSpecs") -> tuple[ParamSet, ...]:
    """把配置里的 ``indicatorSpecs`` 归一成 :class:`ParamSet` 序列。

    ``{}``（空对象）= **显式关闭指标层**（R-12.2），返回空序列——那是合法配置，
    调用方据此让状态里如实显示「未启用指标」，而不是假装「启用了但还没算」。
    """
    if raw is None:
        return ()
    if not isinstance(raw, Mapping):
        raise SyncError("CONFIG_INVALID", f"{source} 必须是对象", {"source": source})
    unknown = sorted(set(raw) - set(INDICATOR_TABLES))
    if unknown:
        raise SyncError(
            "CONFIG_INVALID",
            f"{source} 有未知指标：{unknown}（可选 {sorted(INDICATOR_TABLES)}）",
            {"unknown": unknown, "supported": sorted(INDICATOR_TABLES)},
        )
    out: list[ParamSet] = []
    for indicator in INDICATOR_TABLES:  # 固定次序 → 摘要键序稳定
        entries = raw.get(indicator)
        if entries is None:
            continue
        if isinstance(entries, (str, bytes)) or not isinstance(entries, Sequence):
            raise SyncError(
                "CONFIG_INVALID", f"{source}.{indicator} 必须是数组", {"indicator": indicator}
            )
        for entry in entries:
            out.append(_parse_one(indicator, entry, f"{source}.{indicator}"))
    return tuple(out)


def _parse_one(indicator: str, entry: object, label: str) -> ParamSet:
    if not isinstance(entry, Mapping):
        raise SyncError("CONFIG_INVALID", f"{label} 的条目必须是对象", {"label": label})
    expected_keys = set(_CONFIG_KEYS[indicator])
    extra = sorted(set(entry) - expected_keys)
    if extra:
        raise SyncError(
            "CONFIG_INVALID",
            f"{label} 有未知参数：{extra}（应为 {sorted(expected_keys)}）",
            {"label": label, "unknown": extra},
        )
    kind: str | None = None
    params: list[int] = []
    for column in PARAM_COLUMNS[indicator]:
        key = _param_key_name(indicator, column)
        if column == "kind":
            kind = str(entry.get(key, "sma"))
            if kind not in MA_KINDS:
                raise SyncError(
                    "CONFIG_INVALID",
                    f"{label}.kind 只能是 {list(MA_KINDS)}，收到：{kind}",
                    {"kind": kind, "supported": list(MA_KINDS)},
                )
            continue
        if key not in entry:
            raise SyncError(
                "CONFIG_INVALID",
                f"{label} 缺少参数 {key}",
                {"label": label, "missing": key},
            )
        params.append(_require_int(entry[key], f"{label}.{key}", allow_zero=column == "k_milli"))
    return ParamSet(indicator=indicator, params=tuple(params), kind=kind)  # type: ignore[arg-type]


#: 缺省参数集（R-12.1）。**必须**与 ``005_indicators.sql`` 的表集合一致，由 AC-2 守住。
#:
#: EMA **已实现但不在缺省参数集里**：行集数直接决定存储体积（附录 B.3：10 个行集约
#: 386 MB/标的），加一个窗口就是加一整条序列。需要时加一行配置即可，零迁移（R-3.3）。
DEFAULT_SPECS: tuple[ParamSet, ...] = (
    ParamSet("ma", (5,), "sma"),
    ParamSet("ma", (10,), "sma"),
    ParamSet("ma", (20,), "sma"),
    ParamSet("ma", (60,), "sma"),
    ParamSet("macd", (12, 26, 9)),
    ParamSet("rsi", (14,)),
    ParamSet("boll", (20, 2000)),
    ParamSet("kdj", (9, 3, 3)),
    ParamSet("atr", (14,)),
    ParamSet("obv", ()),
)


def parse_specs_arg(raw: str | None) -> tuple[ParamSet, ...] | None:
    """``--indicator-specs`` 的两种形态，返回 ``None`` 表示「未指定，走配置」。

    紧凑形态：``sma:5,sma:10,macd:12:26:9,rsi:14,boll:20:2000,kdj:9:3:3,atr:14,obv``
    JSON 形态：``'{"ma":[{"kind":"sma","window":5}]}'``
    空串 / ``none`` = **显式关闭指标层**（返回空序列，与配置里 ``{}`` 同义）。
    """
    if raw is None:
        return None
    text = raw.strip()
    if text == "" or text.lower() == "none":
        return ()
    try:
        payload: object = json.loads(text)
    except json.JSONDecodeError:
        payload = _parse_compact(text)
    return parse_specs(payload, source="--indicator-specs")


def _parse_compact(text: str) -> object:
    """``sma:5,macd:12:26:9,obv`` → 与配置同形的 dict。

    位置参数按各指标的固定次序解释（``macd`` 是 fast/slow/signal、``kdj`` 是
    n/kPeriod/dPeriod…），次序来自 :data:`_COMPACT_ORDER`，与数据库列次序同源。
    写成紧凑形态是为了让 ``--indicator-specs`` 能在命令行里一眼可读，但**不引入
    第二套次序**——它只引用这一张表。
    """
    out: dict[str, list[dict[str, object]]] = {}
    for chunk in text.split(","):
        piece = chunk.strip()
        if piece == "":
            continue
        parts = [p.strip() for p in piece.split(":")]
        name = parts[0]
        if name in MA_KINDS:
            values = _compact_values(piece, parts[1:], _COMPACT_ORDER["ma"])
            ma_entry: dict[str, object] = {"kind": name}
            ma_entry.update(values)
            out.setdefault("ma", []).append(ma_entry)
            continue
        if name not in _COMPACT_ORDER:
            raise SyncError(
                "CONFIG_INVALID",
                f"--indicator-specs 的 {piece} 未知指标：{name}",
                {"segment": piece, "supported": sorted(set(_COMPACT_ORDER) | set(MA_KINDS))},
            )
        values = _compact_values(piece, parts[1:], _COMPACT_ORDER[name])
        # 无参数的指标（obv）给一个空对象，而不是 None——`parse_specs` 只认 Mapping
        entry: dict[str, object] = dict(values)
        out.setdefault(name, []).append(entry)
    return out


#: 紧凑形态的位置参数次序（**配置键**，与 :data:`PARAM_COLUMNS` 的数值列同序）。
_COMPACT_ORDER: Mapping[str, tuple[str, ...]] = {
    "macd": ("fast", "slow", "signal"),
    "rsi": ("period",),
    "boll": ("period", "kMilli"),
    "kdj": ("n", "kPeriod", "dPeriod"),
    "atr": ("period",),
    "ma": ("window",),
    # obv 无参数，因此紧凑形态写成裸 `obv`（后面不带任何 `:`）。放在表里是为了让
    # 「未知指标」的判断只看这一张表——把它写成特例会让 `--indicator-specs obv`
    # 被判成未知指标，而它恰恰是文档里给出的写法。
    "obv": (),
}


def _compact_values(segment: str, parts: Sequence[str], order: Sequence[str]) -> dict[str, int]:
    if len(parts) > len(order):
        raise SyncError(
            "CONFIG_INVALID",
            f"--indicator-specs 的 {segment} 参数过多：{len(parts)} 个（最多 {len(order)} 个）",
            {"segment": segment, "expected": list(order)},
        )
    out: dict[str, int] = {}
    for key, raw in zip(order, parts, strict=False):
        try:
            out[key] = int(raw)
        except ValueError as exc:
            raise SyncError(
                "CONFIG_INVALID",
                f"--indicator-specs 的 {segment} 不是合法整数：{raw!r}",
                {"segment": segment, "field": key},
            ) from exc
    return out


# --------------------------------------------------------------- 连续段切分（R-4.1）


@dataclass(frozen=True, slots=True)
class Segment:
    """一个**极大连续段**（R-4.1）。段内时间严格按桶宽等距递增。"""

    #: 段内下标区间 ``[lo, hi)``，对应 :func:`read_derived_bars` 返回数组的下标
    lo: int
    hi: int
    start_ms: int
    end_ms: int

    def __len__(self) -> int:
        return self.hi - self.lo


def split_segments(times: Sequence[int], interval_ms: int) -> list[Segment]:
    """按 ``time[i] − time[i−1] != intervalMs`` 断开，得到若干**极大连续段**（R-4.1）。

    纯函数：不读时钟、不做 IO，因此可脱离 PG 逐条断言（R-13.2）。

    单根也算一段——段长 1 时所有有预热的指标都写不出行，OBV 仍写出一行。
    """
    if interval_ms <= 0:
        raise SyncError("CONFIG_INVALID", "桶宽必须为正整数", {"intervalMs": interval_ms})
    if len(times) == 0:
        return []
    starts: list[int] = [0]
    for i in range(1, len(times)):
        if int(times[i]) - int(times[i - 1]) != interval_ms:
            starts.append(i)
    segments: list[Segment] = []
    for begin, start in enumerate(starts):
        end = starts[begin + 1] if begin + 1 < len(starts) else len(times)
        segments.append(
            Segment(lo=start, hi=end, start_ms=int(times[start]), end_ms=int(times[end - 1]))
        )
    return segments


# --------------------------------------------------------------- 指标计算（R-1）


@dataclass(slots=True)
class Series:
    """派生 K 线的向量化输入（等长 numpy 数组）。"""

    time: np.ndarray
    high: np.ndarray
    low: np.ndarray
    close: np.ndarray
    volume: np.ndarray


def empty_series() -> Series:
    z = np.zeros(0, dtype=np.float64)
    return Series(time=np.zeros(0, dtype=np.int64), high=z, low=z, close=z, volume=z)


def slice_series(series: Series, lo: int, hi: int) -> Series:
    """切出 ``[lo, hi)``。**段内独立重算的物理基础**（R-4.2）。"""
    return Series(
        time=series.time[lo:hi],
        high=series.high[lo:hi],
        low=series.low[lo:hi],
        close=series.close[lo:hi],
        volume=series.volume[lo:hi],
    )


def compute_series(spec: ParamSet, series: Series) -> dict[str, FloatArray]:
    """算一个参数集在**一个连续段**上的全部输出列（等长数组，预热期 NaN）。

    **一次读入、一次算完整段**（R-4.5）：不逐 bar 重算整段历史、不逐参数集重复打 PG。

    指标公式只存在于 ``quant_core``（R-8.2）——本函数只做**选参数与取列**，
    绝不自己写公式，否则就出现了第二份实现（R-1.1 / AC-16）。
    """
    try:
        if spec.indicator == "ma":
            fn = ema if spec.kind == "ema" else sma
            return {"value": fn(series.close, spec.params[0])}
        if spec.indicator == "macd":
            dif, dea, hist = macd(series.close, spec.params[0], spec.params[1], spec.params[2])
            return {"dif": dif, "dea": dea, "hist": hist}
        if spec.indicator == "rsi":
            return {"value": rsi(series.close, spec.params[0])}
        if spec.indicator == "boll":
            upper, mid, lower = boll(series.close, spec.params[0], spec.params[1])
            return {"upper": upper, "mid": mid, "lower": lower}
        if spec.indicator == "kdj":
            k, d, j = kdj(series.high, series.low, series.close, *spec.params)
            return {"k": k, "d": d, "j": j}
        if spec.indicator == "atr":
            return {"value": atr(series.high, series.low, series.close, spec.params[0])}
        if spec.indicator == "obv":
            return {"value": obv(series.close, series.volume)}
    except IndicatorError as exc:
        raise SyncError(
            "CONFIG_INVALID", f"指标参数非法（{spec.label()}）：{exc}", {"spec": spec.label()}
        ) from exc
    raise SyncError(  # pragma: no cover - parse_specs 已挡住未知指标
        "CONFIG_INVALID", f"未知指标：{spec.indicator}", {"indicator": spec.indicator}
    )


def warmup_of(spec: ParamSet) -> int:
    """该参数集在**段内**的有效起点（R-1.3 的预热期长度），即段内下标 ``< warmup`` 的行不落库。"""
    from quant_core.indicators import (
        warmup_atr,
        warmup_boll,
        warmup_ema,
        warmup_kdj,
        warmup_macd,
        warmup_obv,
        warmup_rsi,
        warmup_sma,
    )

    if spec.indicator == "ma":
        return warmup_ema(spec.params[0]) if spec.kind == "ema" else warmup_sma(spec.params[0])
    if spec.indicator == "macd":
        return warmup_macd(spec.params[1], spec.params[2])
    if spec.indicator == "rsi":
        return warmup_rsi(spec.params[0])
    if spec.indicator == "boll":
        return warmup_boll(spec.params[0])
    if spec.indicator == "kdj":
        return warmup_kdj(spec.params[0])
    if spec.indicator == "atr":
        return warmup_atr(spec.params[0])
    return warmup_obv()


# ------------------------------------------------------------------- 读派生 K 线


def read_derived_bars(
    conn: DbConn, symbol: str, interval: str, lo_ms: int, hi_ms: int
) -> tuple[list[int], Series]:
    """读某周期派生表的 ``time, high, low, close, volume``，按 ``time`` 升序。

    **一次查询读全段**（A.4：15m 单标的整段不到 7 MB——读是廉价的，写才昂贵）。
    表名只从 :data:`DERIVED_TABLES` 白名单取。
    """
    table = DERIVED_TABLES[interval]
    rows = conn.execute(
        f"SELECT time, high, low, close, volume FROM {table}"
        " WHERE symbol = %s AND time >= %s AND time <= %s ORDER BY time ASC",
        (symbol, lo_ms, hi_ms),
    ).fetchall()
    if not rows:
        return [], empty_series()
    return (
        [int(r["time"]) for r in rows],
        Series(
            time=np.array([int(r["time"]) for r in rows], dtype=np.int64),
            high=np.array([float(r["high"]) for r in rows], dtype=np.float64),
            low=np.array([float(r["low"]) for r in rows], dtype=np.float64),
            close=np.array([float(r["close"]) for r in rows], dtype=np.float64),
            volume=np.array([float(r["volume"]) for r in rows], dtype=np.float64),
        ),
    )


def _read_segment(
    conn: DbConn, symbol: str, interval: str, seg_start: int, to_ms: int
) -> tuple[list[int], Series]:
    """读 ``[seg_start, to_ms]`` 的派生行，**并按轮增量缓存**。

    一轮内批次时间单调向后，因此段只会变长：命中缓存时只补读新增的尾巴并拼接，
    而不是把整段重新拉一遍。向后回退（缺口回补回到更早区间）会丢弃缓存重新读——
    拿「更长的旧段」去算一个更早的窗口会让指标值错掉，而那正是 R-4.2 要防的静默改写。
    """
    cache = _segment_cache_for(conn)
    key = (symbol, interval)
    if cache is None:
        return read_derived_bars(conn, symbol, interval, seg_start, to_ms)

    hit = cache.get(key)
    if hit is None or hit[0] != seg_start:
        # 段起点变了（缺口被回补 / 重放更早区间）：缓存作废，重新读
        times, series = read_derived_bars(conn, symbol, interval, seg_start, to_ms)
        cache[key] = (seg_start, times, series)
        return times, series

    known = hit[1]
    if not known:
        times, series = read_derived_bars(conn, symbol, interval, seg_start, to_ms)
        cache[key] = (seg_start, times, series)
        return times, series
    if known[-1] >= to_ms:
        # 缓存已经覆盖到请求窗口之后（重放更早的区间）：直接用已知的那一段
        return known, hit[2]

    # 正常情况：批次时间单调向后 → 只补读新增的尾巴
    fresh_times, fresh = read_derived_bars(
        conn, symbol, interval, known[-1] + _width(interval), to_ms
    )
    if not fresh_times:
        return known, hit[2]
    times = [*known, *fresh_times]
    series = Series(
        time=np.concatenate([hit[2].time, fresh.time]),
        high=np.concatenate([hit[2].high, fresh.high]),
        low=np.concatenate([hit[2].low, fresh.low]),
        close=np.concatenate([hit[2].close, fresh.close]),
        volume=np.concatenate([hit[2].volume, fresh.volume]),
    )
    cache[key] = (seg_start, times, series)
    return times, series


def prev_time_before(conn: DbConn, symbol: str, interval: str, before_ms: int) -> int | None:
    """``time < before_ms`` 的最大 bar 起点；没有则 None。"""
    table = DERIVED_TABLES[interval]
    row = conn.execute(
        f"SELECT max(time) AS t FROM {table} WHERE symbol = %s AND time < %s",
        (symbol, before_ms),
    ).fetchone()
    value = row["t"] if row is not None else None
    return int(value) if value is not None else None


#: 一轮同步内的「段」缓存：``连接 -> (symbol, interval) -> (段起点, 已读行)``。
#:
#: 为什么需要它：增量路径每批都要「从段首重算」（R-4.2 / A.3 的硬约束），
#: 于是**每批都会把整个段重新读一遍**。单标的六年的 15m 段有 22 万根，实测单批要
#: 读 1.54 s + 找段首 1.02 s，而这两件事在同一轮里答案完全不变。
#: （此处刻意不写真实合约名——源码里不得出现硬编码标的，R-5.1。）
#:
#: 用 :class:`weakref.WeakKeyDictionary` 按**连接**持有：连接一关，缓存随之消失，
#: 不会跨进程/跨测试残留。缓存只对**同一轮内连续推进**的批次有效——批次时间单调
#: 向后，因此段只会变长、不会变短；一旦下一批早于已缓存的行（例如缺口回补回到更早
#: 的区间），立即丢弃缓存重新读，绝不拿陈旧的段去算。
#: 缓存值 = (段起点, 已读的 time 列表, 对应的向量化输入)
_SegmentEntry = tuple[int, "list[int]", "Series"]
_SegmentCache = weakref.WeakKeyDictionary[object, dict[tuple[str, str], _SegmentEntry]]
_SEGMENT_CACHE: _SegmentCache = weakref.WeakKeyDictionary()

#: 该连接上已建好的 staging 表名。键是连接（弱引用），连接一关随之消失。
_StagingCache = weakref.WeakKeyDictionary[object, dict[str, bool]]
_STAGING_CACHE: _StagingCache = weakref.WeakKeyDictionary()


def _segment_cache_for(
    conn: DbConn,
) -> dict[tuple[str, str], tuple[int, list[int], Series]] | None:
    try:
        store = _SEGMENT_CACHE.get(conn)
    except TypeError:  # pragma: no cover - 连接不可弱引用时退化为不缓存
        return None
    if store is None:
        store = {}
        try:
            _SEGMENT_CACHE[conn] = store
        except TypeError:  # pragma: no cover
            return None
    return store


def _cache_for(conn: DbConn) -> dict[str, bool] | None:
    """该连接上「staging 表已建过」的集合。与段缓存分开，互不干扰。"""
    try:
        store = _STAGING_CACHE.get(conn)
    except TypeError:  # pragma: no cover
        return None
    if store is None:
        store = {}
        try:
            _STAGING_CACHE[conn] = store
        except TypeError:  # pragma: no cover
            return None
    return store


def clear_segment_cache(conn: DbConn) -> None:
    """丢弃该连接的段缓存（回填、时间倒序重放等场景显式调用）。"""
    try:
        _SEGMENT_CACHE.pop(conn, None)
    except TypeError:  # pragma: no cover
        return


def find_segment_start(
    conn: DbConn, symbol: str, interval: str, at_ms: int, *, page_bars: int = 20_000
) -> int:
    """从 ``at_ms`` 往回找它所在**连续段的起点**（R-4.4 的重算起点）。

    逐页回看，每页一次范围查询 + 一次「页首之前是否还有 bar」的判定查询。正常情况下
    一页就够（缺口罕见）；只有跨缺口的标的才会回看多页。

    为什么必须找段首：递推初值只依赖段自身。若从 ``at_ms`` 起算，等于用「半个段」播种，
    值会与「清空后全量重建」不一致——而 ``--rebuild`` 恰好就是那个参照（AC-9）。
    """
    cache = _segment_cache_for(conn)
    key = (symbol, interval)
    if cache is not None:
        hit = cache.get(key)
        if hit is not None and hit[0] <= at_ms:
            return hit[0]

    width = BUCKET_WIDTHS_MS[interval]
    cursor = bucket_start(at_ms, width)
    while True:
        lo = cursor - (page_bars - 1) * width
        times, _series = read_derived_bars(conn, symbol, interval, lo, cursor)
        if not times:
            if cache is not None:
                cache[key] = (cursor, [], empty_series())
            return cursor
        page_start = times[0]
        prev = prev_time_before(conn, symbol, interval, page_start)
        # 页首之前没有 bar，或那根与 page_start 不连续 → 缺口（或数据起点），段首就在这
        if prev is None or prev != page_start - width:
            if cache is not None:
                cache[key] = (page_start, [], empty_series())
            return page_start
        # 整页都连着 → 段可能还在更早处，继续回看一页
        cursor = page_start


# ------------------------------------------------------------------- 写入指标表


def _staging_table(indicator: str) -> str:
    """每张指标表一个 staging 临时表（与 1m 写入同一条路径，见 ``pg.write_bars``）。"""
    return f"stage_indicator_{indicator}"


def _copy_types(spec: ParamSet) -> list[str]:
    """COPY 的列类型（显式给出，因此不依赖会话的 ``client_encoding`` / 搜索路径）。"""
    kinds: list[str] = ["text", "text", "int4"]
    # `ma` 是唯一带文本参数列（`kind`）的指标；其余参数列全是整数。
    # 这里逐列判定而不是「ma 就用 text」——`bars` 是整数，误标成 text 会让 COPY
    # 在「expected 6 values in row」这种与真实原因无关的报错上失败。
    kinds += ["text" if col == "kind" else "int4" for col in PARAM_COLUMNS[spec.indicator]]
    kinds.append("int8")
    kinds += ["float8"] * len(VALUE_COLUMNS[spec.indicator])
    return kinds


def _ensure_staging(conn: DbConn, indicator: str) -> str:
    """按目标表的**列形状与约束**建 staging 表。``LIKE … INCLUDING DEFAULTS`` 让列名与
    类型**由迁移文件决定**，本模块不再持有一份列定义影子。

    ``ON COMMIT PRESERVE ROWS``：物化是「每批一个事务」，而临时表要跨批复用；
    不加这句，事务一提交表就没了，每批都得重建 7 次 DDL。

    保留 NOT NULL 是有意的：staging 表里缺列会在 COPY 时当场报错，而不是让
    ``INSERT … SELECT`` 拿着一个 NULL 去撞目标表的约束、留下一条难以定位的错误。

    **每个连接只建一次**。`IF NOT EXISTS` 让重复执行是安全的，但它**并不便宜**——
    实测 ``batch_size=200`` 时它每批被调用 7 指标 × 4 周期 = 28 次，占掉指标层
    每批 268ms 里的相当一部分，而这 28 次里 27 次什么也没建。用连接级记忆把
    「已经建过」这件事记下来，省掉的是纯粹的往返。
    """
    stage = _staging_table(indicator)
    created = _cache_for(conn)
    if created is not None:
        if stage in created:
            return stage
        created[stage] = True
    table = INDICATOR_TABLES[indicator]
    conn.execute(
        f"CREATE TEMP TABLE IF NOT EXISTS {stage} (LIKE {table} INCLUDING DEFAULTS)"
        " ON COMMIT PRESERVE ROWS"
    )
    return stage


def _row_columns(spec: ParamSet) -> tuple[str, ...]:
    """staging / COPY / INSERT 三处共用的列次序：与目标表的列定义同序。"""
    return (
        "symbol",
        "interval",
        "impl_version",
        *PARAM_COLUMNS[spec.indicator],
        "time",
        *VALUE_COLUMNS[spec.indicator],
    )


def _upsert_sql(spec: ParamSet) -> str:
    """``INSERT … SELECT … ON CONFLICT`` 语句。

    为什么**必须**走 staging 表而不是 ``executemany``（R-4.5）：``executemany`` 对每一行都要
    一次服务端往返，实测 15m 全量约 170 行/秒——216 万行要跑三个多小时，而同一批数据走
    COPY 只需几十秒。1m 写入早就因为同样的理由走 COPY + INSERT…SELECT（``pg.write_bars``），
    这里沿用同一条路径，不引入第二种写法。

    ``ON CONFLICT DO UPDATE … WHERE <值不同>`` 是幂等的关键：值相同时**不产生新行**，
    ``rowcount`` 因此就是「真正改动的行数」，重复执行必然为 0（R-4.4 / AC-7）。
    """
    table = INDICATOR_TABLES[spec.indicator]
    cols = _row_columns(spec)
    param_cols = PARAM_COLUMNS[spec.indicator]
    value_cols = VALUE_COLUMNS[spec.indicator]
    conflict_cols = ", ".join(["symbol", "interval", "impl_version", *param_cols, "time"])
    assignments = ", ".join(f"{c} = EXCLUDED.{c}" for c in value_cols)
    different = " OR ".join(f"{table}.{c} IS DISTINCT FROM EXCLUDED.{c}" for c in value_cols)
    column_list = ", ".join(cols)
    return (
        f"INSERT INTO {table} ({column_list})"
        f" SELECT {column_list} FROM {_staging_table(spec.indicator)}"
        f" ON CONFLICT ({conflict_cols}) DO UPDATE SET {assignments} WHERE {different}"
    )


def _payload_row(
    symbol: str, interval: str, spec: ParamSet, time_ms: int, values: Sequence[float]
) -> tuple[object, ...]:
    """一行 staging 记录，列次序 = :func:`_row_columns`。"""
    return (symbol, interval, INDICATOR_IMPL_VERSION, *spec.pk_values(), time_ms, *values)


def existing_rows(
    conn: DbConn, symbol: str, interval: str, spec: ParamSet
) -> dict[int, tuple[float, ...]]:
    """该参数集**已物化**的行：``time -> 值元组``。用于幂等比对与 ``--check``。"""
    table = INDICATOR_TABLES[spec.indicator]
    value_cols = VALUE_COLUMNS[spec.indicator]
    where, params = _param_where(spec)
    # 无参数指标（obv）的 where 是空串 —— 硬拼 `AND {where}` 会得到 `AND  ORDER BY`，
    # 一个当场报语法错、而不是静默少过滤条件的 SQL。
    clause = f" AND {where}" if where else ""
    rows = conn.execute(
        f"SELECT time, {', '.join(value_cols)} FROM {table}"
        f" WHERE symbol = %s AND interval = %s{clause} ORDER BY time ASC",
        (symbol, interval, *params),
    ).fetchall()
    return {int(r["time"]): tuple(float(r[c]) for c in value_cols) for r in rows}


def _param_where(spec: ParamSet, *, impl_version: int | None = None) -> tuple[str, list[object]]:
    """按参数集定位的 WHERE 片段。**只拼白名单列名**，值全部走占位符。"""
    cols = PARAM_COLUMNS[spec.indicator]
    if not cols:
        where = ""
        params: list[object] = []
    else:
        where = " AND ".join(f"{c} = %s" for c in cols)
        params = list(spec.pk_values())
    if impl_version is not None:
        where = f"{where} AND " if where else ""
        where = f"{where}impl_version = %s"
        params = [*params, impl_version]
    return where, params


def max_impl_version(conn: DbConn, symbol: str, interval: str, spec: ParamSet) -> int | None:
    """该参数集已物化的**最大** ``impl_version``；没有行返回 ``None``。"""
    table = INDICATOR_TABLES[spec.indicator]
    where, params = _param_where(spec)
    clause = f" AND {where}" if where else ""
    row = conn.execute(
        f"SELECT max(impl_version) AS v FROM {table} WHERE symbol = %s AND interval = %s{clause}",
        (symbol, interval, *params),
    ).fetchone()
    value = row["v"] if row is not None else None
    return int(value) if value is not None else None


def assert_no_mixed_versions(
    conn: DbConn, symbol: str, interval: str, specs: Sequence[ParamSet]
) -> None:
    """R-4.6：**拒绝混版写入**。已物化版本 ≠ 当前版本就抛 ``INDICATOR_IMPL_STALE``。

    「前半段 v1 行、后半段 v2 行」是最坏的结果——它看起来完全正常，且指标已经错了。
    处置是人工介入：跑 ``data indicators --rebuild``。
    """
    for spec in specs:
        found = max_impl_version(conn, symbol, interval, spec)
        if found is not None and found != INDICATOR_IMPL_VERSION:
            raise SyncError(
                "INDICATOR_IMPL_STALE",
                f"{symbol} {interval} {spec.label()} 已物化 impl_version={found}，"
                f"当前实现版本={INDICATOR_IMPL_VERSION}：拒绝写入以免混版。"
                "修复方式：data indicators --rebuild",
                {
                    "symbol": symbol,
                    "interval": interval,
                    "spec": spec.params_dict(),
                    "storedImplVersion": found,
                    "currentImplVersion": INDICATOR_IMPL_VERSION,
                },
            )


def delete_range(
    conn: DbConn, symbol: str, interval: str, specs: Sequence[ParamSet], lo_ms: int, hi_ms: int
) -> int:
    """``--rebuild`` 的先删后算。删除范围按 **bar 起点**裁剪，与读区间同口径（AC-9）。"""
    removed = 0
    for spec in specs:
        table = INDICATOR_TABLES[spec.indicator]
        where, params = _param_where(spec, impl_version=INDICATOR_IMPL_VERSION)
        clause = f" AND {where}" if where else ""
        cursor = conn.execute(
            f"DELETE FROM {table} WHERE symbol = %s AND interval = %s"
            f" AND time >= %s AND time <= %s{clause}",
            (symbol, interval, lo_ms, hi_ms, *params),
        )
        removed += int(cursor.rowcount or 0)
    return removed


# ------------------------------------------------------------------ 物化驱动


@dataclass(slots=True)
class IndicatorStat:
    """一个「周期 × 参数集」的物化统计（R-6.6：不许只报「成功」）。"""

    interval: str
    indicator: IndicatorName
    params: dict[str, int | str]
    upserted: int = 0
    #: 段内早于预热期、因而不落库的行数
    withheld_warmup: int = 0
    #: ``'noChange'`` = 本批该周期没有任何桶变化，未重算（R-4.4）
    skipped: str | None = None

    def to_dict(self) -> dict[str, object]:
        out: dict[str, object] = {
            "indicator": self.indicator,
            "params": self.params,
            "upserted": self.upserted,
            "withheldWarmup": self.withheld_warmup,
        }
        if self.skipped is not None:
            out["skipped"] = self.skipped
        return out

    def key(self) -> str:
        return f"{self.indicator}:{json.dumps(self.params, sort_keys=True)}"


def _same(stored: float, expected: float) -> bool:
    """指标值比对：**逐值相等**而不是「近似相等」。

    这里刻意不给容差：写入与校验走的是**同一个** :func:`compute_series`，同一根 bar
    的两次计算必然逐位相同（无随机、无时钟、无并行归约）。一旦引入 ``epsilon``，
    一个真实的公式 bug 会被容差吃掉，报出来的是「一致」——而这正是 ``--check``
    唯一的职责。同理，NaN 不等于任何值：库里出现 NaN 会被报成 mismatch 而不是
    「两边都是 NaN，算一致」。
    """
    return stored == expected


def _stat(interval: str, spec: ParamSet) -> IndicatorStat:
    return IndicatorStat(interval=interval, indicator=spec.indicator, params=spec.params_dict())


def write_specs(
    conn: DbConn,
    symbol: str,
    interval: str,
    specs: Sequence[ParamSet],
    times: Sequence[int],
    series: Series,
    segments: Sequence[Segment],
    stats: dict[str, IndicatorStat],
    *,
    write_from_ms: int | None = None,
) -> None:
    """在给定连续段上逐参数集计算并 UPSERT，累加统计。

    ``write_from_ms`` 为 None 时写全段有效行（补齐 / ``--rebuild``）；
    给定时只写 ``time >= write_from_ms`` 的行（增量路径：重算从段首开始，但**只写**
    本批真正触及的之后那部分，R-4.4）。

    **按指标表合并写入**（R-4.5 的「一次性算完整段」的落地）：同一张表的所有参数集
    攒进**同一个** staging 表，一次 COPY + 一次 ``INSERT … ON CONFLICT … RETURNING``。
    逐参数集各写一次在数据量上等价、在往返次数上差一个数量级——实测
    ``batch_size=500`` 的 86 批同步里，指标写入的**语句往返**占了每批 634ms 的绝大部分，
    而真正写的行每批只有几十行。把 4 周期 × 10 参数集的 120 条语句压成 4 组之后，
    每批固定开销降了一个数量级。
    """
    del times  # 只用 segments 的下标；显式忽略以免调用方误以为按 times 过滤
    by_indicator: dict[str, list[ParamSet]] = {}
    for spec in specs:
        by_indicator.setdefault(spec.indicator, []).append(spec)

    for indicator, group in by_indicator.items():
        _write_indicator_group(
            conn,
            symbol,
            interval,
            indicator,
            group,
            series,
            segments,
            stats,
            write_from_ms=write_from_ms,
        )


def _write_indicator_group(
    conn: DbConn,
    symbol: str,
    interval: str,
    indicator: str,
    group: Sequence[ParamSet],
    series: Series,
    segments: Sequence[Segment],
    stats: dict[str, IndicatorStat],
    *,
    write_from_ms: int | None,
) -> None:
    """把同一张指标表上的**全部**参数集合成一次 COPY + 一次 UPSERT。"""
    columns = VALUE_COLUMNS[indicator]
    pending: list[tuple[ParamSet, int, tuple[float, ...]]] = []
    counters: dict[ParamSet, IndicatorStat] = {}

    for spec in group:
        key = _stat_key(spec)
        stat = stats.setdefault(key, _stat(interval, spec))
        counters[spec] = stat
        warmup = warmup_of(spec)
        for segment in segments:
            # 段长不足预热期 → 该段一行都不写（R-4.3）
            if len(segment) <= warmup:
                stat.withheld_warmup += len(segment)
                continue
            sub = slice_series(series, segment.lo, segment.hi)
            values = compute_series(spec, sub)
            # 预热期被扣留的行数：只算预热，不把 `write_from_ms` 的偏移混进来
            # （那部分不是「算不出来」，而是「本批没触及」，两者在摘要里是不同的意思）
            stat.withheld_warmup += warmup
            begin = warmup
            if write_from_ms is not None:
                begin = max(begin, int((write_from_ms - segment.start_ms) // _width(interval)))
            if begin >= len(segment):
                continue
            for i in range(begin, len(segment)):
                point = tuple(float(values[c][i]) for c in columns)
                if not all(np.isfinite(v) for v in point):
                    # 预热之后不该出现 NaN；出现了就是公式问题，宁可报错也不写脏行
                    raise SyncError(
                        "INDICATOR_FAILED",
                        f"{symbol} {interval} {spec.label()} 在段 {segment.start_ms} 的第 {i} 根"
                        f"产出非有限值：{point}",
                        {
                            "symbol": symbol,
                            "interval": interval,
                            "spec": spec.params_dict(),
                            "segmentStart": segment.start_ms,
                            "index": i,
                        },
                    )
                pending.append((spec, int(sub.time[i]), point))

    if not pending:
        return
    stage = _ensure_staging(conn, indicator)
    lead = group[0]
    column_list = ", ".join(_row_columns(lead))
    with conn.cursor() as cur:
        cur.execute(f"TRUNCATE {stage}")
        with cur.copy(f"COPY {stage} ({column_list}) FROM STDIN") as copy:
            copy.set_types(_copy_types(lead))
            for spec, time_ms, point in pending:
                copy.write_row(_payload_row(symbol, interval, spec, time_ms, point))
    # RETURNING 参数列而不是只取 rowcount：一次 UPSERT 覆盖了本组全部参数集，
    # 只有按参数分组才能给出**每个参数集**各自的 upserted（摘要要逐参数集报，R-6.6）。
    returning = ", ".join(_RETURNED[indicator])
    returned = conn.execute(f"{_upsert_sql(lead)} RETURNING {returning}").fetchall()
    for row in returned:
        matched = _match_spec(group, indicator, row)
        if matched is not None:
            counters[matched].upserted += 1


#: UPSERT 的 RETURNING 列：参数列 + 时间。用来把返回行归属回具体的参数集。
_RETURNED: Mapping[str, tuple[str, ...]] = {
    "ma": ("kind", "bars", "time"),
    "macd": ("fast", "slow", "signal", "time"),
    "rsi": ("period", "time"),
    "boll": ("period", "k_milli", "time"),
    "kdj": ("n", "k_period", "d_period", "time"),
    "atr": ("period", "time"),
    "obv": ("time",),
}


def _match_spec(
    group: Sequence[ParamSet], indicator: str, row: Mapping[str, object]
) -> ParamSet | None:
    """把 UPSERT 返回的一行归属回它对应的参数集。"""
    wanted = _RETURNED[indicator]
    for spec in group:
        if spec.pk_values() == tuple(row[c] for c in wanted[:-1]):
            return spec
    return None  # pragma: no cover - 返回的行必然来自 staging，而 staging 只有本组的行


def _stat_key(spec: ParamSet) -> str:
    return f"{spec.indicator}:{json.dumps(spec.params_dict(), sort_keys=True)}"


def _width(interval: str) -> int:
    try:
        return BUCKET_WIDTHS_MS[interval]
    except KeyError as exc:  # pragma: no cover - 上游已白名单
        raise SyncError(
            "CONFIG_INVALID", f"未实现的派生周期: {interval}", {"interval": interval}
        ) from exc


def materialize_range(
    conn: DbConn,
    symbol: str,
    interval: str,
    specs: Sequence[ParamSet],
    start_ms: int,
    end_ms: int,
    *,
    rebuild: bool = False,
) -> dict[str, IndicatorStat]:
    """区间补齐 / ``--rebuild``：读全区间 → 切段 → 逐段逐参数集算并写。

    ``rebuild=True`` 时**先删后算**（R-6.1），用于修复「K 线被改动 / 指标被篡改 /
    ``impl_version`` 已递增」；补齐（缺省）**只增不删**。
    """
    stats: dict[str, IndicatorStat] = {}
    for spec in specs:
        stats[f"{spec.indicator}:{json.dumps(spec.params_dict(), sort_keys=True)}"] = _stat(
            interval, spec
        )
    if not specs:
        return stats
    assert_no_mixed_versions(conn, symbol, interval, specs)
    if rebuild:
        delete_range(conn, symbol, interval, specs, start_ms, end_ms)
    times, series = read_derived_bars(conn, symbol, interval, start_ms, end_ms)
    if not times:
        return stats
    segments = split_segments(times, _width(interval))
    write_specs(conn, symbol, interval, specs, times, series, segments, stats)
    return stats


def materialize_touched(
    conn: DbConn,
    symbol: str,
    interval: str,
    specs: Sequence[ParamSet],
    from_ms: int,
    to_ms: int,
    stats: dict[str, IndicatorStat],
) -> None:
    """**增量路径**（R-4.4）：本批聚合在周期 ``interval`` 上触及的桶区间 ``[from_ms, to_ms]``。

    重算区间是「所在段起点 → 段末端」（递推初值必须从段首重新推），
    但**只 UPSERT** ``[max(from_ms, 段首 + 预热期), 段末端]`` 的行。
    """
    if not specs or to_ms < from_ms:
        return
    # **刻意不在这里查 impl_version**：混版检查由调用方在一轮开始时做一次。
    # 每批都查等于每批 × 4 周期 × 10 参数集 = 40 条往返，而这些查询在一轮内
    # 必然给出同一个答案——只有本进程在写指标，且一轮只写一个版本。
    # 换句话说：把它放进热路径不会提高安全性，只会把固定开销乘以批数。
    width = _width(interval)
    seg_start = find_segment_start(conn, symbol, interval, from_ms)
    times, series = _read_segment(conn, symbol, interval, seg_start, to_ms)
    if not times:
        return
    segments = [s for s in split_segments(times, width) if s.end_ms >= from_ms]
    write_specs(
        conn, symbol, interval, specs, times, series, segments, stats, write_from_ms=from_ms
    )


# --------------------------------------------------------------------- --check


@dataclass(slots=True)
class IndicatorProblem:
    """``--check`` 的一处不一致（R-6.1）。"""

    interval: str
    indicator: IndicatorName
    params: dict[str, int | str]
    #: ``stale`` = 存在但按当前 K 线与当前实现已不可复现
    #: ``missing`` = 应存在但缺失
    #: ``mismatch`` = 值不一致
    #: ``mixedVersion`` = 同一参数集出现多个 impl_version
    kind: str
    time: int
    column: str | None = None
    stored: object | None = None
    expected: object | None = None

    def to_dict(self) -> dict[str, object]:
        out: dict[str, object] = {
            "interval": self.interval,
            "indicator": self.indicator,
            "params": self.params,
            "kind": self.kind,
            "time": self.time,
        }
        if self.column is not None:
            out["column"] = self.column
            out["stored"] = self.stored
            out["expected"] = self.expected
        return out


def check_interval(
    conn: DbConn,
    symbol: str,
    interval: str,
    specs: Sequence[ParamSet],
    start_ms: int,
    end_ms: int,
) -> list[IndicatorProblem]:
    """**只读**校验（不写任何表）：报 stale / missing / mismatch / 混版。

    判据是「按当前派生 K 线与当前 ``INDICATOR_IMPL_VERSION`` 重算应当得到什么」，
    与写入路径走**同一个** :func:`write_specs` 的计算部分——把判据抄一遍就会让
    「写入」与「校验」各有一套规则，而两者一旦漂移，``--check`` 就会对着一条永远
    不满足的判据报出无穷多个 missing（v0.2.0 R-5.1 的同一教训）。
    """
    problems: list[IndicatorProblem] = []
    times, series = read_derived_bars(conn, symbol, interval, start_ms, end_ms)
    segments = split_segments(times, _width(interval)) if times else []
    for spec in specs:
        stored = existing_rows(conn, symbol, interval, spec)
        columns = VALUE_COLUMNS[spec.indicator]
        expected: dict[int, tuple[float, ...]] = {}
        warmup = warmup_of(spec)
        for segment in segments:
            if len(segment) <= warmup:
                continue
            sub = slice_series(series, segment.lo, segment.hi)
            values = compute_series(spec, sub)
            for i in range(warmup, len(segment)):
                expected[int(sub.time[i])] = tuple(float(values[c][i]) for c in columns)

        for time_ms, want in sorted(expected.items()):
            have = stored.get(time_ms)
            if have is None:
                problems.append(
                    IndicatorProblem(
                        interval, spec.indicator, spec.params_dict(), "missing", time_ms
                    )
                )
                continue
            for idx, column in enumerate(columns):
                if not _same(float(have[idx]), want[idx]):
                    problems.append(
                        IndicatorProblem(
                            interval,
                            spec.indicator,
                            spec.params_dict(),
                            "mismatch",
                            time_ms,
                            column=column,
                            stored=have[idx],
                            expected=want[idx],
                        )
                    )
        for time_ms in sorted(set(stored) - set(expected)):
            problems.append(
                IndicatorProblem(interval, spec.indicator, spec.params_dict(), "stale", time_ms)
            )

        found = max_impl_version(conn, symbol, interval, spec)
        if found is not None and found != INDICATOR_IMPL_VERSION:
            problems.append(
                IndicatorProblem(
                    interval,
                    spec.indicator,
                    spec.params_dict(),
                    "mixedVersion",
                    0,
                    stored=found,
                    expected=INDICATOR_IMPL_VERSION,
                )
            )
    return problems


def raise_on_mismatch(symbol: str, problems: Sequence[IndicatorProblem]) -> None:
    """发现任一不一致就抛 ``INDICATOR_MISMATCH``（R-6.1），并指出位置。"""
    if not problems:
        return
    first = problems[0]
    raise SyncError(
        "INDICATOR_MISMATCH",
        f"{symbol} 的指标与库内派生 K 线不一致：{len(problems)} 处"
        f"（首个：{first.interval} {first.indicator} {first.kind} @ {first.time}）；"
        "修复方式：data indicators --rebuild",
        {
            "symbol": symbol,
            "count": len(problems),
            "first": first.to_dict(),
            "problems": [p.to_dict() for p in list(problems)[:20]],
        },
    )


def merge_stats(into: dict[str, IndicatorStat], batch: Mapping[str, IndicatorStat]) -> None:
    """把一批的统计累加进整轮统计（键固定 → 摘要键序稳定）。

    **刻意不直接复用 ``batch`` 里的对象**：`setdefault(key, item)` 在键缺失时会把
    ``item`` 本身塞进结果，随后 ``current.upserted += item.upserted`` 就成了自己加自己，
    数字正好翻倍。这种 bug 不会报错、不会溢出，只是每个统计都悄悄大一倍——而统计的
    唯一用途就是幂等断言（AC-7），翻倍之后「第二次是 0」永远不成立，断言恒真。
    因此这里无条件构造新对象。
    """
    for key, item in batch.items():
        current = into.get(key)
        if current is None:
            into[key] = IndicatorStat(
                interval=item.interval,
                indicator=item.indicator,
                params=dict(item.params),
                upserted=item.upserted,
                withheld_warmup=item.withheld_warmup,
            )
            continue
        current.upserted += item.upserted
        current.withheld_warmup += item.withheld_warmup


def all_stats(specs: Sequence[ParamSet], interval: str) -> dict[str, IndicatorStat]:
    """先给每个参数集一个零值统计，让摘要即使一行未写也列出它（「不许只报成功」）。"""
    return {stat_key(spec): _stat(interval, spec) for spec in specs}


def stat_key_from_stat(stat: IndicatorStat) -> str:
    """由统计对象反推它的键（用于把一批统计按周期重新分组）。"""
    return f"{stat.indicator}:{json.dumps(stat.params, sort_keys=True)}"


def stat_key(spec: ParamSet) -> str:
    """统计字典的键 = ``指标:参数``。内部用；对外一律走 :func:`label`。"""
    return f"{spec.indicator}:{json.dumps(spec.params_dict(), sort_keys=True)}"


def stats_payload(
    stats: Mapping[str, IndicatorStat], specs: Sequence[ParamSet]
) -> dict[str, object]:
    """把统计铺成 ``{标签: {...}}``，键序按 ``specs`` 固定。

    铺开而不是直接吐内部键：内部键里带 JSON 与列名，对外暴露只会在读侧再写一份
    解析规则；标签是给人看图例用的，与 ``--check`` 报出的位置能直接对上（R-6.6）。
    """
    out: dict[str, object] = {}
    for spec in specs:
        stat = stats.get(stat_key(spec))
        if stat is not None:
            out[spec.label()] = stat.to_dict()
        else:
            out[spec.label()] = {
                "indicator": spec.indicator,
                "params": spec.params_dict(),
                "upserted": 0,
                "withheldWarmup": 0,
            }
    return out
