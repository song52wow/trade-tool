"""7 组指标的**逐值**用例（v0.3.0 R-13.1 / AC-1）。

断言方式：**手算的独立参考值**。刻意不与 TA-Lib / pandas-ta 对比（N-9）——
第三方库的口径由它的版本决定，用它当断言等于把「升级一次库」变成「静默改一次指标」，
`impl_version` 随即变成一句空话（R-3.4）。

覆盖重点按 R-1 的口径表逐条对应：
- 每组的**预热期长度**（有效起点）；
- **段首种子**（EMA 的 SMA 播种、RSI 的首个 Wilder 均值、KDJ 的 50 播种）；
- **Wilder 递推**（RSI / ATR）；
- 边界：KDJ 分母为 0、BOLL 单点、OBV 无预热、RSI 全平 / 连涨。
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pytest
from quant_core import INDICATOR_IMPL_VERSION, Bar, interval_to_ms, series_to_dicts
from quant_core.indicators import (
    IndicatorError,
    atr,
    boll,
    ema,
    kdj,
    macd,
    obv,
    rsi,
    sma,
    warmup_atr,
    warmup_boll,
    warmup_ema,
    warmup_kdj,
    warmup_macd,
    warmup_obv,
    warmup_rsi,
    warmup_sma,
)

ONE_MIN = 60_000


def arr(*values: float) -> np.ndarray:
    return np.array(values, dtype=np.float64)


#: 「故意传错类型」的参数。标成 ``Any`` 是为了让 mypy 放行——这些用例的全部意义
#: 就是把一个类型不合法的值喂进去，静态检查拦下它反而让用例跑不到。
FLOAT_SPAN: Any = 3.0
FLOAT_PERIOD: Any = 2.5


# ============================================================ 基础类型（既有回归）


def test_interval_to_ms_known() -> None:
    assert interval_to_ms("1h") == 3_600_000


def test_interval_to_ms_unknown() -> None:
    with pytest.raises(ValueError):
        interval_to_ms("7m")


def test_bar_rejects_inconsistent_high() -> None:
    with pytest.raises(ValueError):
        Bar(time=0, open=10.0, high=9.0, low=8.0, close=10.0, volume=1.0)


def test_bar_roundtrip() -> None:
    bar = Bar(time=1, open=1.0, high=2.0, low=0.5, close=1.5, volume=10.0)
    rows = series_to_dicts([bar])
    assert Bar.from_dicts(rows) == [bar]


def test_impl_version_is_positive_int() -> None:
    """`impl_version` 进主键，因此必须始终是正整数。"""
    assert isinstance(INDICATOR_IMPL_VERSION, int)
    assert INDICATOR_IMPL_VERSION > 0


# ============================================================================ SMA


def test_sma_warmup_is_nan() -> None:
    out = sma(arr(1.0, 2.0, 3.0, 4.0), 3)
    assert np.isnan(out[0]) and np.isnan(out[1])
    assert out[2] == pytest.approx(2.0)
    assert out[3] == pytest.approx(3.0)


def test_sma_valid_start_is_window_minus_one() -> None:
    assert warmup_sma(20) == 19
    out = sma(arr(*[float(i) for i in range(1, 26)]), 20)
    assert np.isnan(out[:19]).all()
    assert not np.isnan(out[19:]).any()
    # 手算：1..20 的均值 = 10.5
    assert out[19] == pytest.approx(10.5)
    assert out[20] == pytest.approx(11.5)


def test_sma_rejects_non_positive_window() -> None:
    with pytest.raises(ValueError):
        sma(arr(1.0), 0)


def test_sma_shorter_than_window_is_all_nan() -> None:
    out = sma(arr(1.0, 2.0), 5)
    assert np.isnan(out).all()


# ============================================================================ EMA


def test_ema_uses_sma_seed() -> None:
    """**口径变更**：种子 = 前 S 根的算术均值，不再是段首值（A.2）。

    参考值：x = [1,2,3]，S=3 → 种子 out[2] = mean(1,2,3) = 2。
    旧口径会给出 out[0] = 1 再递推，首个输出是 2.5 而不是 2。
    """
    out = ema(arr(1.0, 2.0, 3.0), 3)
    assert np.isnan(out[0]) and np.isnan(out[1])
    assert out[2] == pytest.approx(2.0)


def test_ema_constant_series_equals_constant() -> None:
    """常数序列的 SMA 播种与递推都给出同一个常数——旧口径下这段也过，
    但它**不足以**区分两种口径，所以上面那条才是真正钉住播种的用例。"""
    out = ema(arr(5.0, 5.0, 5.0, 5.0, 5.0), 3)
    assert np.isnan(out[:2]).all()
    assert np.allclose(out[2:], 5.0)


def test_ema_recursion_step_by_hand() -> None:
    """alpha = 2/(S+1) = 0.5。x = [1,2,3,4]：种子 out[2] = 2；out[3] = .5*4+.5*2 = 3。"""
    out = ema(arr(1.0, 2.0, 3.0, 4.0), 3)
    assert out[3] == pytest.approx(3.0)


def test_ema_valid_start_is_span_minus_one() -> None:
    assert warmup_ema(26) == 25
    out = ema(arr(*[float(i) for i in range(60)]), 26)
    assert np.isnan(out[:25]).all()
    assert not np.isnan(out[25:]).any()
    assert out[25] == pytest.approx(np.mean(np.arange(26, dtype=np.float64)))


def test_ema_shorter_than_span_is_all_nan() -> None:
    assert np.isnan(ema(arr(1.0, 2.0), 5)).all()


def test_ema_rejects_float_span() -> None:
    """浮点参数一律拒绝（R-1.4）：参数要能进主键。"""
    with pytest.raises(IndicatorError):
        ema(arr(1.0, 2.0, 3.0), FLOAT_SPAN)


def test_ema_rejects_bool_span() -> None:
    with pytest.raises(IndicatorError):
        ema(arr(1.0, 2.0, 3.0), True)


# =========================================================================== MACD


def test_macd_valid_start_is_slow_plus_signal_minus_two() -> None:
    assert warmup_macd(26, 9) == 33
    values = arr(*[float(100 + i) for i in range(60)])
    dif, dea, hist = macd(values, 12, 26, 9)
    assert np.isnan(dif[:25]).all()
    assert np.isnan(dea[:33]).all()
    assert np.isnan(hist[:33]).all()
    assert not np.isnan(dif[25:]).any()
    assert not np.isnan(dea[33:]).any()


def test_macd_hist_is_dif_minus_dea_not_twice() -> None:
    """**口径钉死**：HIST = DIF − DEA（国际惯例），**不是**国内软件的 2×(DIF−DEA)。"""
    values = arr(*[float(100 + (i % 7) - (i % 3)) for i in range(60)])
    dif, dea, hist = macd(values, 12, 26, 9)
    valid = ~np.isnan(hist)
    assert np.allclose(hist[valid], (dif[valid] - dea[valid]))


def test_macd_dea_seed_is_mean_of_first_valid_dif() -> None:
    """DEA 的种子 = 最初 G 个**有效** DIF 的算术均值（与 EMA 同一个 SMA 播种口径）。"""
    values = arr(*[float(100 + i) for i in range(60)])
    dif, dea, _hist = macd(values, 12, 26, 9)
    expected = float(np.mean(dif[25 : 25 + 9]))
    assert dea[33] == pytest.approx(expected)


def test_macd_dif_is_fast_minus_slow_ema() -> None:
    values = arr(*[float(100 + (i % 5)) for i in range(80)])
    dif, _dea, _hist = macd(values, 12, 26, 9)
    assert np.allclose(dif[25:], ema(values, 12)[25:] - ema(values, 26)[25:])


def test_macd_constant_series_collapsed_to_zero() -> None:
    """常数序列：快慢均线相等 → DIF = 0 → DEA = 0 → HIST = 0。"""
    values = arr(*([7.0] * 60))
    dif, dea, hist = macd(values, 12, 26, 9)
    assert np.allclose(dif[25:], 0.0)
    assert np.allclose(dea[33:], 0.0)
    assert np.allclose(hist[33:], 0.0)


def test_macd_rejects_invalid_params() -> None:
    with pytest.raises(IndicatorError):
        macd(arr(1.0, 2.0, 3.0), 12, 26, 0)
    with pytest.raises(IndicatorError):
        macd(arr(1.0, 2.0, 3.0), 12, 26, -1)


def test_macd_too_short_is_all_nan() -> None:
    """段长不足以越过预热期时**DEA / HIST 一行都不产出**（物化层据此不落库，R-4.3）。

    这里 DIF 仍然有效（``slow−1 = 2`` 起），但 DEA 还要再预热 ``signal−1`` 根，
    而该段只剩 1 个有效 DIF 值 < ``signal = 2``，因此 DEA 与 HIST 全为 nan。
    """
    dif, dea, hist = macd(arr(1.0, 2.0, 3.0), 2, 3, 2)
    assert not np.isnan(dif[2]).all()
    assert np.isnan(dea).all() and np.isnan(hist).all()


def test_macd_valid_start_matches_warmup_helper_exactly() -> None:
    """预热长度函数与实际输出必须一致——两者漂移会让物化层多写或少写行。"""
    values = arr(*[float(100 + (i % 9)) for i in range(200)])
    for fast, slow, signal in ((12, 26, 9), (5, 35, 3), (8, 17, 9)):
        warmup = warmup_macd(slow, signal)
        _dif, dea, hist = macd(values, fast, slow, signal)
        assert np.isnan(hist[:warmup]).all()
        assert not np.isnan(hist[warmup:]).any()
        assert not np.isnan(dea[warmup:]).any()


# ============================================================================ RSI


def test_rsi_valid_start_is_period() -> None:
    """有效起点是 ``N``，不是 ``N−1``：首个 avgGain = mean(gain[1..N]) 需要 N 个差分。"""
    assert warmup_rsi(14) == 14
    values = arr(*[float(100 + (i % 11) - (i % 5)) for i in range(60)])
    out = rsi(values, 14)
    assert np.isnan(out[:14]).all()
    assert not np.isnan(out[14:]).any()


def test_rsi_first_value_uses_simple_mean() -> None:
    """逐值：N=2，x = [10, 12, 11]。
    gain = [+2, −1→0]，loss = [0, 1]
    avgGain = mean(gain[1..2]) = (2 + 0)/2 = 1；avgLoss = (0 + 1)/2 = 0.5
    RS = 2 → RSI = 100 − 100/3 = 66.666…"""
    out = rsi(arr(10.0, 12.0, 11.0), 2)
    assert out[2] == pytest.approx(100.0 - 100.0 / 3.0)


def test_rsi_wilder_recursion_step_by_hand() -> None:
    """N=2 递推：avg = (avg*(N−1) + 本期)/N = avg/2 + 本期/2。"""
    values = arr(10.0, 12.0, 11.0, 13.0)
    out = rsi(values, 2)
    # i=3：gain=2, loss=0 → avgGain = 1/2 + 2/2 = 1.5；avgLoss = 0.5/2 + 0/2 = 0.25
    # RS = 6 → RSI = 100 − 100/7
    assert out[3] == pytest.approx(100.0 - 100.0 / 7.0)


def test_rsi_monotonic_up_is_100() -> None:
    """连涨：avgLoss 恒为 0 → RS 无穷 → RSI = 100（不得产出 NaN / Inf）。"""
    out = rsi(arr(*[float(i) for i in range(1, 30)]), 14)
    assert np.allclose(out[14:], 100.0)
    assert np.isfinite(out[14:]).all()


def test_rsi_monotonic_down_is_zero() -> None:
    out = rsi(arr(*[float(100 - i) for i in range(30)]), 14)
    assert np.allclose(out[14:], 0.0)


def test_rsi_flat_series_is_neutral_not_nan() -> None:
    """全平窗口：比值是 0/0，取中性点 50——不取 0（会被读成「极度超卖」），不取 NaN。"""
    out = rsi(arr(*([5.0] * 30)), 14)
    assert out[14] == pytest.approx(50.0)
    assert np.isfinite(out[14:]).all()


def test_rsi_too_short_is_all_nan() -> None:
    assert np.isnan(rsi(arr(1.0, 2.0, 3.0), 14)).all()


def test_rsi_rejects_float_period() -> None:
    with pytest.raises(IndicatorError):
        rsi(arr(1.0, 2.0), FLOAT_PERIOD)


# =========================================================================== BOLL


def test_boll_valid_start_is_period_minus_one() -> None:
    assert warmup_boll(20) == 19
    values = arr(*[float(100 + (i % 7)) for i in range(40)])
    upper, mid, lower = boll(values, 20, 2000)
    assert np.isnan(upper[:19]).all()
    assert np.isnan(mid[:19]).all()
    assert np.isnan(lower[:19]).all()
    assert not np.isnan(mid[19:]).any()


def test_boll_mid_is_sma() -> None:
    values = arr(*[float(100 + (i % 7)) for i in range(40)])
    _upper, mid, _lower = boll(values, 20, 2000)
    assert np.allclose(mid[19:], sma(values, 20)[19:])


def test_boll_std_is_population_not_sample() -> None:
    """**口径钉死**：STD 用总体标准差（÷P），不是样本标准差（÷(P−1)）。

    x = [1,2,3]，P=3，k_milli = 1000（k = 1.0）
    MID = 2；总体方差 = ((1−2)²+(2−2)²+(3−2)²)/3 = 2/3；STD = √(2/3) ≈ 0.8164966
    若误用样本标准差会得到 √(2/2) = 1.0 —— 两者相差一个明确的量，能区分。
    """
    upper, mid, lower = boll(arr(1.0, 2.0, 3.0), 3, 1000)
    std = float(np.sqrt(np.mean(np.array([1.0, 1.0, 0.0]) ** 2)))
    assert mid[2] == pytest.approx(2.0)
    assert upper[2] == pytest.approx(2.0 + std)
    assert lower[2] == pytest.approx(2.0 - std)


def test_boll_k_milli_is_scaled_by_thousand() -> None:
    """k_milli = 2000 → k = 2.0。带宽随 k 线性放大。"""
    values = arr(1.0, 2.0, 3.0, 4.0)
    u1, m1, _l1 = boll(values, 3, 1000)
    u2, m2, _l2 = boll(values, 3, 2000)
    assert m1[2] == pytest.approx(m2[2])
    # 同一 mid 下，upper − mid 与 k 成正比
    assert (u1[2] - m1[2]) * 2 == pytest.approx(u2[2] - m2[2])


def test_boll_flat_window_std_is_zero_not_nan() -> None:
    """全平窗口方差为 0 → 上下轨与中轨重合，不得 NaN（浮点相减可能出负，必须夹到 0）。"""
    upper, mid, lower = boll(arr(*([4.0] * 6)), 4, 2000)
    assert upper[3] == pytest.approx(4.0)
    assert mid[3] == pytest.approx(4.0)
    assert lower[3] == pytest.approx(4.0)


def test_boll_single_point_window() -> None:
    """P=1 的退化窗口：STD = 0，三轨重合，且有效起点是 0。"""
    assert warmup_boll(1) == 0
    upper, mid, lower = boll(arr(9.0, 9.0), 1, 2000)
    assert mid[0] == pytest.approx(9.0)
    assert upper[0] == pytest.approx(9.0)
    assert lower[0] == pytest.approx(9.0)


def test_boll_shorter_than_period_is_all_nan() -> None:
    upper, mid, lower = boll(arr(1.0, 2.0), 20, 2000)
    assert np.isnan(upper).all() and np.isnan(mid).all() and np.isnan(lower).all()


def test_boll_rejects_negative_k_milli() -> None:
    with pytest.raises(IndicatorError):
        boll(arr(1.0, 2.0, 3.0), 3, -1000)


def test_boll_allows_zero_k_milli() -> None:
    """k_milli = 0 是合法配置：三条轨重合在 MID 上（CHECK 允许 >= 0）。"""
    upper, mid, lower = boll(arr(1.0, 2.0, 3.0), 3, 0)
    assert upper[2] == pytest.approx(mid[2])
    assert lower[2] == pytest.approx(mid[2])


# ============================================================================ KDJ


def test_kdj_valid_start_is_n_minus_one() -> None:
    assert warmup_kdj(9) == 8
    high = arr(*[float(11 + (i % 5)) for i in range(30)])
    low = arr(*[float(9 + (i % 3)) for i in range(30)])
    close = arr(*[float(10 + (i % 4)) for i in range(30)])
    k, d, j = kdj(high, low, close, 9, 3, 3)
    assert np.isnan(k[:8]).all()
    assert np.isnan(d[:8]).all()
    assert np.isnan(j[:8]).all()
    assert not np.isnan(k[8:]).any()


def test_kdj_j_is_three_k_minus_two_d() -> None:
    high = arr(*[float(11 + (i % 5)) for i in range(30)])
    low = arr(*[float(9 + (i % 3)) for i in range(30)])
    close = arr(*[float(10 + (i % 4)) for i in range(30)])
    k, d, j = kdj(high, low, close, 9, 3, 3)
    assert np.allclose(j[8:], 3.0 * k[8:] - 2.0 * d[8:])


def test_kdj_first_value_uses_seed_fifty() -> None:
    """**段首种子钉死**：K/D 初值 50 是**递推种子**，首个可算位置用
    ``K = (kp−1)/kp × 50 + 1/kp × RSV``。

    手算 n=1, kp=2, dp=2：i=0 时 RSV = (close − low)/(high − low)×100
    high=[12], low=[8], close=[10] → RSV = 50
    K = (1/2)×50 + (1/2)×50 = 50；D 同理 = 50；J = 3×50 − 2×50 = 50
    """
    k, d, j = kdj(arr(12.0), arr(8.0), arr(10.0), 1, 2, 2)
    assert k[0] == pytest.approx(50.0)
    assert d[0] == pytest.approx(50.0)
    assert j[0] == pytest.approx(50.0)


def test_kdj_divisor_zero_gives_fifty_not_nan() -> None:
    """**边界**：窗口内 max(high) == min(low)（横盘）→ RSV = 50 中性点。
    禁止 NaN / Inf，也禁止沿用前值（那会把横盘读成趋势延续）。"""
    flat_h = arr(*([10.0] * 6))
    flat_l = arr(*([10.0] * 6))
    flat_c = arr(*([10.0] * 6))
    k, d, j = kdj(flat_h, flat_l, flat_c, 3, 3, 3)
    assert np.isfinite(k[2:]).all()
    assert np.isfinite(d[2:]).all()
    assert np.isfinite(j[2:]).all()
    # 全平 → RSV 恒 50 → K/D 从 50 出发并保持 50
    assert k[2] == pytest.approx(50.0)
    assert d[2] == pytest.approx(50.0)


def test_kdj_rsv_step_by_hand() -> None:
    """逐值：n=1, kp=1, dp=1 → K = RSV、D = K、J = 3K − 2D = K。
    high=[15], low=[5], close=[10] → RSV = (10−5)/(15−5)×100 = 50。"""
    k, d, j = kdj(arr(15.0), arr(5.0), arr(10.0), 1, 1, 1)
    assert k[0] == pytest.approx(50.0)
    assert d[0] == pytest.approx(50.0)
    assert j[0] == pytest.approx(50.0)


def test_kdj_shorter_than_n_is_all_nan() -> None:
    k, d, j = kdj(arr(12.0, 13.0), arr(8.0, 9.0), arr(10.0, 11.0), 9, 3, 3)
    assert np.isnan(k).all() and np.isnan(d).all() and np.isnan(j).all()


def test_kdj_rejects_mismatched_lengths() -> None:
    with pytest.raises(IndicatorError):
        kdj(arr(12.0, 13.0), arr(8.0), arr(10.0, 11.0), 1, 1, 1)


# ============================================================================ ATR


def test_atr_valid_start_is_period() -> None:
    assert warmup_atr(14) == 14
    high = arr(*[float(12 + (i % 6)) for i in range(40)])
    low = arr(*[float(8 + (i % 4)) for i in range(40)])
    close = arr(*[float(10 + (i % 5)) for i in range(40)])
    out = atr(high, low, close, 14)
    assert np.isnan(out[:14]).all()
    assert not np.isnan(out[14:]).any()


def test_atr_first_value_is_mean_of_tr_1_to_n() -> None:
    """逐值：N=2，high=[12,14,16], low=[10,12,14], close=[11,13,15]
    TR_0 = 12−10 = 2
    TR_1 = max(14−12, |14−11|, |12−11|) = max(2, 3, 1) = 3
    TR_2 = max(16−14, |16−13|, |14−13|) = max(2, 3, 1) = 3
    ATR_2 = mean(TR[1..2]) = 3（下标 2 才有效，段长 3 < N+1 时无输出）"""
    out = atr(arr(12.0, 14.0, 16.0), arr(10.0, 12.0, 14.0), arr(11.0, 13.0, 15.0), 2)
    assert np.isnan(out[0]) and np.isnan(out[1])
    assert out[2] == pytest.approx(3.0)


def test_atr_shorter_than_period_plus_one_is_all_nan() -> None:
    """ATR 的有效起点是 N，因此至少要 N+1 根才有一个输出。"""
    out = atr(arr(12.0, 13.0, 14.0), arr(10.0, 11.0, 12.0), arr(11.0, 12.0, 13.0), 3)
    assert np.isnan(out).all()


def test_atr_true_range_uses_previous_close() -> None:
    """TR 必须是三项的最大值：只看 high−low 会得到完全不同的值。

    high=[12,20,20], low=[10,19,19], close=[11,19.5,19.5], N=2
    TR_0 = 2
    TR_1 = max(1, |20−11|=9, |19−11|=8) = 9   ← 用到前收
    TR_2 = max(1, 0.5, 0.5) = 1
    ATR_2 = mean(TR[1], TR[2]) = 5
    若误用 high−low 口径会得到 mean(1, 1) = 1，两者相差一个明确的量。
    """
    out = atr(arr(12.0, 20.0, 20.0), arr(10.0, 19.0, 19.0), arr(11.0, 19.5, 19.5), 2)
    assert out[2] == pytest.approx(5.0)


def test_atr_wilder_recursion_step_by_hand() -> None:
    """N=2：ATR_i = (ATR_{i−1}×1 + TR_i)/2。"""
    high = arr(12.0, 20.0, 20.0)
    low = arr(10.0, 19.0, 19.0)
    close = arr(11.0, 19.5, 19.5)
    out = atr(high, low, close, 2)
    # TR = [2, 9, 1]；ATR_2 = mean(TR[1..2]) = 5
    assert out[2] == pytest.approx(5.0)
    # ATR_3 = (5×1 + TR_3)/2；补一根 high=21, low=20, close=20.5
    out4 = atr(
        arr(12.0, 20.0, 20.0, 21.0),
        arr(10.0, 19.0, 19.0, 20.0),
        arr(11.0, 19.5, 19.5, 20.5),
        2,
    )
    tr3 = max(1.0, abs(21.0 - 19.5), abs(20.0 - 19.5))
    assert out4[3] == pytest.approx((5.0 + tr3) / 2)


def test_atr_constant_range_is_constant() -> None:
    high = arr(*([12.0] * 30))
    low = arr(*([10.0] * 30))
    close = arr(*([11.0] * 30))
    out = atr(high, low, close, 14)
    assert out[14] == pytest.approx(2.0)
    assert np.allclose(out[14:], 2.0)


def test_atr_shorter_than_period_is_all_nan() -> None:
    out = atr(arr(12.0), arr(10.0), arr(11.0), 14)
    assert np.isnan(out).all()


def test_atr_rejects_mismatched_lengths() -> None:
    with pytest.raises(IndicatorError):
        atr(arr(12.0, 13.0), arr(10.0), arr(11.0, 12.0), 2)


# ============================================================================ OBV


def test_obv_has_no_warmup() -> None:
    """OBV 无预热，段首即为 0（有效起点 0）。"""
    assert warmup_obv() == 0
    out = obv(arr(10.0, 11.0), arr(5.0, 7.0))
    assert not np.isnan(out).any()
    assert out[0] == pytest.approx(0.0)


def test_obv_accumulates_on_up_and_down() -> None:
    """close = [10,11,10,12]，volume = [5,7,3,4]
    OBV_0 = 0
    收涨 → +7 → 7
    收跌 → −3 → 4
    收涨 → +4 → 8"""
    out = obv(arr(10.0, 11.0, 10.0, 12.0), arr(5.0, 7.0, 3.0, 4.0))
    assert out[0] == pytest.approx(0.0)
    assert out[1] == pytest.approx(7.0)
    assert out[2] == pytest.approx(4.0)
    assert out[3] == pytest.approx(8.0)


def test_obv_flat_close_keeps_previous() -> None:
    """持平**不变**：既不加也不减。"""
    out = obv(arr(10.0, 10.0, 10.0), arr(5.0, 100.0, 3.0))
    assert out[2] == pytest.approx(0.0)


def test_obv_single_bar_is_zero() -> None:
    assert obv(arr(10.0), arr(5.0))[0] == pytest.approx(0.0)


def test_obv_rejects_mismatched_lengths() -> None:
    with pytest.raises(IndicatorError):
        obv(arr(10.0, 11.0), arr(5.0))


# ==================================================================== 通用校验


@pytest.mark.parametrize(
    ("fn", "window"),
    [(sma, 2.0), (rsi, 2.0), (ema, 2.0)],
)
def test_float_params_rejected(fn: Any, window: Any) -> None:
    """浮点参数一律拒绝（R-1.4 / R-12.1）：参数要能作为有类型的整数列进主键。"""
    with pytest.raises(IndicatorError):
        fn(arr(1.0, 2.0, 3.0), window)


def test_negative_params_rejected() -> None:
    with pytest.raises(IndicatorError):
        sma(arr(1.0, 2.0), -3)
    with pytest.raises(IndicatorError):
        atr(arr(12.0, 13.0), arr(10.0, 11.0), arr(11.0, 12.0), -1)


def test_indicators_reject_multidimensional_input() -> None:
    with pytest.raises(IndicatorError):
        sma(np.zeros((2, 2)), 2)


def test_two_dimensional_input_is_not_silently_flattened() -> None:
    """形状错了必须报错——把它压平会得到一个长度不对的序列，
    而下游按位置对齐时会把错值算到别的 bar 上。"""
    with pytest.raises(IndicatorError):
        ema(np.zeros((3, 4)), 2)


# ======================================================= 段间不递推（数据层语义）


def test_crossing_a_gap_would_change_values_which_is_why_segments_are_split() -> None:
    """「段间不递推」的**反面证据**：把两段拼起来算，B 段的值会与单独算 B 段不同。

    这条测试存在的意义是说明为什么 ``quant_data`` 必须先切连续段再逐段调用
    （R-4.2 / A.5）：如果实现图省事把整段历史一次喂进去，B 段会带上 A 段的陈旧状态，
    而「回补缺口」还会把库里已有的历史值静默改写。

    单独算 B 段（正确做法，段首重推）：
        seed = mean(100, 101, 102) = 101
        → [nan, nan, 101, 101 + (103−101)×0.5] = [nan, nan, 101, 102]

    拼起来算（错误做法，A 段状态漏了过来）：
        → 56 / 78.5 / 90.25 / 96.625 —— 用户会把它读成「有下跌趋势」
    """
    segment_a = arr(10.0, 11.0, 12.0, 13.0)
    segment_b = arr(100.0, 101.0, 102.0, 103.0)

    alone_b = ema(segment_b, 3)
    assert alone_b[2] == pytest.approx(101.0)
    assert alone_b[3] == pytest.approx(102.0)

    joined = ema(np.concatenate([segment_a, segment_b]), 3)
    assert not np.allclose(joined[4:], alone_b)
    # 拼接口径下 B 段首值被拉到 56 而不是 101 —— 这正是「跨缺口递推」要避免的
    assert joined[4] < alone_b[2]


# =========================================================== 多指标 × 多参数集


def test_multiple_param_sets_are_independent() -> None:
    """一个周期上多组参数互不干扰：各自独立播种。"""
    values = arr(*[float(100 + (i % 13)) for i in range(120)])
    sma5 = sma(values, 5)
    sma60 = sma(values, 60)
    rsi14 = rsi(values, 14)
    atr14 = atr(values + 1.0, values - 1.0, values, 14)
    # 逐个有效起点都要对上，且彼此不串味
    assert not np.isnan(sma5[4]) and np.isnan(sma5[3])
    assert not np.isnan(sma60[59]) and np.isnan(sma60[58])
    assert not np.isnan(rsi14[14]) and np.isnan(rsi14[13])
    assert not np.isnan(atr14[14]) and np.isnan(atr14[13])
    assert np.isfinite(sma5[4:]).all()
    assert np.isfinite(sma60[59:]).all()
    assert np.isfinite(rsi14[14:]).all()
    assert np.isfinite(atr14[14:]).all()


def test_all_indicators_produce_finite_values_after_warmup() -> None:
    """预热之后**不得**出现 NaN / Inf——物化层会把这些位置排除，但混进去一个
    NaN 就会让整段被当成「算不出来」。"""
    n = 400
    close = arr(*[float(100 + 10 * np.sin(i / 17.0) + i * 0.01) for i in range(n)])
    high = close + 1.0
    low = close - 1.0
    volume = arr(*[float(1000 + (i % 37) * 10) for i in range(n)])

    outputs: list[tuple[str, np.ndarray, int]] = [
        ("sma", sma(close, 20), 19),
        ("ema", ema(close, 20), 19),
        ("rsi", rsi(close, 14), 14),
        ("atr", atr(high, low, close, 14), 14),
        ("obv", obv(close, volume), 0),
    ]
    dif, dea, hist = macd(close, 12, 26, 9)
    outputs.extend([("dif", dif, 25), ("dea", dea, 33), ("hist", hist, 33)])
    upper, mid, lower = boll(close, 20, 2000)
    outputs.extend([("boll.upper", upper, 19), ("boll.mid", mid, 19), ("boll.lower", lower, 19)])
    k, d, j = kdj(high, low, close, 9, 3, 3)
    outputs.extend([("kdj.k", k, 8), ("kdj.d", d, 8), ("kdj.j", j, 8)])

    for name, values, warmup in outputs:
        assert np.isnan(values[:warmup]).all(), f"{name} 预热期应全为 nan"
        tail = values[warmup:]
        assert np.isfinite(tail).all(), f"{name} 预热后出现 NaN/Inf"


def test_one_min_constant_width_is_60000() -> None:
    """周期常量的固定口径（历史宽度有依赖，避免把 60_000 写死两遍）。"""
    assert ONE_MIN == 60_000
