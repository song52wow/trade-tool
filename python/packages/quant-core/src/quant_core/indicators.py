"""技术指标：**全仓库唯一的实现**（v0.3.0 R-1）。

七组指标：MA（SMA / EMA）、MACD、RSI、BOLL、KDJ、ATR、OBV。

两条不可协商的前提：

1. **纯函数**。输入等长的 OHLCV ``numpy`` 数组，输出等长数组；不读时钟、不做 IO、
   不用随机数（与 AGENTS.md 硬性约定 4「策略无状态」同一条规则）。
2. **预热期填 ``nan`` 而非 0 / NULL**。物化层（R-4.3）据此决定「哪些位置不落库」——
   库里每一行都是有效值，读侧因此不必做 NaN 分支。

**逐条口径**（R-1.3，推导见附录 A.1）：

============ ============ ========= ==========================================
指标         参数          有效起点   口径
============ ============ ========= ==========================================
SMA          W             ``W-1``   收盘价算术均值
EMA          S             ``S-1``   ``alpha = 2/(S+1)``，**种子 = 前 S 根的算术均值**
MACD         F / S / G    ``S+G-2`` ``DIF = EMA(F) − EMA(S)``；``DEA = EMA(DIF, G)``；
                                ``HIST = DIF − DEA``（国际口径，非国内 ×2）
RSI          N             ``N``     Wilder；首个 ``avgGain = mean(gain[1..N])``
BOLL         P / k_milli  ``P-1``   ``MID = SMA(P)``；``STD`` 用**总体**标准差（÷P）
KDJ          n / kp / dp   ``n-1``   ``K_i = ((kp−1)K_{i−1} + RSV_i)/kp``；``J = 3K − 2D``
ATR          N             ``N``     Wilder；``TR_0 = high_0 − low_0``
OBV          无            ``0``     段首为 0；收涨 ``+vol``、收跌 ``−vol``、持平不变
============ ============ ========= ==========================================

**两处必须显式择一、不得含糊的口径**（R-1.5）：

* **MACD 柱**：取 ``HIST = DIF − DEA``（TradingView 等的国际惯例）。国内软件
  （通达信 / 同花顺）是 ``2×(DIF−DEA)``，**本期不采用**；读侧要国内口径自行 ×2。
  让读侧「自己乘 2」比库里存一个说不清来源的数诚实。
* **KDJ 分母为 0**：窗口内 ``max(high) == min(low)``（横盘）时取 ``RSV = 50``
  （0–100 标度的中性点）。禁止 ``NaN`` / ``Inf``（跨语言契约不允许），也禁止沿用前值
  ——沿用会让横盘期被读成「趋势延续」，而真相是没有信息。

**RSI 的两个平局分支**同样必须写死，否则会产出 ``NaN``：连涨时 ``avgLoss = 0``
给出 ``RSI = 100``；全平（``avgGain`` 与 ``avgLoss`` 同为 0）时取 ``50``，与 KDJ 的
分母为 0 同源——「没有信息」就取中性点，不注入方向。

关于 EMA 播种（A.2）：若以段首值播种，种子在第 ``S−1`` 根输出里的残余权重是
``(1−α)^(S−1)``，在 ``S = 12/26/60`` 时分别是 **15.8% / 14.6% / 13.5%**——「预热 S−1 根」
并不能让种子收敛，只是衰减到 ``e^-2`` 就停了。改用 **SMA 播种**后，首个输出就是那
``S`` 根的算术均值，是一个说得清来源的数。这是**对既有实现的有意口径变更**。

**RSI 为什么必须段内从段首重推**（A.3）：它的递推状态是 ``avgGain`` 与 ``avgLoss``
两个绝对量，而输出只有它们的比值。由 ``RSI_{i-1}`` 只能得到比值、拿不回绝对水平，
因此无法从上一行续算——这是「连续段各自独立重算」（R-4.2）唯一无状态解的由来。
"""

from __future__ import annotations

import numpy as np
from numpy.typing import NDArray

FloatArray = NDArray[np.float64]

#: 指标实现的版本号，进指标表主键（R-3.4）。
#:
#: **实现行为变更（口径修改、修 bug）必须递增它**；纯重构、无语义变更不递增。
#: 有了它才能复现一个历史买点——光有参数不够，参数一样而实现不同的两段历史，
#: 同一个买点会得到不同的指标值。
INDICATOR_IMPL_VERSION = 1


class IndicatorError(ValueError):
    """口径校验失败：参数为浮点 / 非整数 / 负数 / 越界（R-1.4）。

    与 ``ValueError`` 同源，便于既有调用方继续捕获；但物化层需要能把它**单独**识别出来
    归一成 ``CONFIG_INVALID``，而不是混进「数组算错了」那一类。
    """


def _require_positive_int(value: object, name: str) -> int:
    """口径参数必须是**正整数**：浮点 / 非整数 / 负数 / 0 一律拒绝（R-1.4）。

    布尔是 ``int`` 的子类，``True`` 会悄悄变成 1——参数是数据不是开关，直接拒绝。
    """
    if isinstance(value, bool) or not isinstance(value, (int, np.integer)):
        raise IndicatorError(f"{name} 必须是正整数，收到：{value!r}（浮点与布尔都不接受）")
    ivalue = int(value)
    if ivalue <= 0:
        raise IndicatorError(f"{name} 必须是正整数，收到：{ivalue}")
    return ivalue


def _require_non_negative_int(value: object, name: str) -> int:
    """BOLL 的 ``k_milli`` 允许 0（``k = 0`` 就是一条中轨），其余约束同正整数。"""
    if isinstance(value, bool) or not isinstance(value, (int, np.integer)):
        raise IndicatorError(f"{name} 必须是非负整数，收到：{value!r}（浮点与布尔都不接受）")
    ivalue = int(value)
    if ivalue < 0:
        raise IndicatorError(f"{name} 必须是非负整数，收到：{ivalue}")
    return ivalue


def _as_float(values: FloatArray) -> FloatArray:
    arr = np.asarray(values, dtype=np.float64)
    if arr.ndim != 1:
        raise IndicatorError(f"指标只接受一维序列，收到 {arr.ndim} 维")
    return arr


# ------------------------------------------------------------------------- 均线


def sma(values: FloatArray, window: int) -> FloatArray:
    """简单移动均线。有效起点 ``W-1``；用前缀和实现，整体 O(n)。

    前缀和口径与逐项求和**不是逐位相同**的浮点运算。这是刻意的：物化侧只依赖本函数
    的输出，两侧不会再各自算一遍（TS 侧已无实现，R-1.1 / AC-16），因此只要「同一根
    K 线永远得到同一个值」——幂等、可复现——就够了。
    """
    window = _require_positive_int(window, "window")
    arr = _as_float(values)
    if arr.size < window:
        return np.full(arr.shape, np.nan, dtype=np.float64)
    cumsum = np.cumsum(np.insert(arr, 0, 0.0))
    out = (cumsum[window:] - cumsum[:-window]) / window
    return np.concatenate([np.full(window - 1, np.nan), out])


def ema(values: FloatArray, span: int) -> FloatArray:
    """指数移动均线，**SMA 播种**（R-1.7 / A.2）。

    - ``alpha = 2 / (S + 1)``；
    - **种子**：``out[S-1] = mean(x[0..S-1])``，即那一段窗口的算术均值；
    - ``i ≥ S`` 起递推 ``out[i] = alpha*x[i] + (1-alpha)*out[i-1]``；
    - ``i < S-1`` 为 ``nan``（预热期，物化层不落库）。

    这条递推**无法向量化**（每一步依赖前一步），但它是 O(n) 的一趟 Python 循环——
    代价与段长成正比，不是 O(n²)。要求「向量化一次算完整段」（R-4.5）针对的是
    「逐 bar 重算整段历史」那种写法，不是禁止递推本身的单趟循环。
    """
    span = _require_positive_int(span, "span")
    arr = _as_float(values)
    out = np.full(arr.shape, np.nan, dtype=np.float64)
    if arr.size < span:
        return out
    alpha = 2.0 / (span + 1.0)
    out[span - 1] = float(np.mean(arr[:span]))
    for i in range(span, arr.size):
        out[i] = alpha * arr[i] + (1.0 - alpha) * out[i - 1]
    return out


# --------------------------------------------------------------------------- MACD


def macd(
    values: FloatArray, fast: int, slow: int, signal: int
) -> tuple[FloatArray, FloatArray, FloatArray]:
    """``(dif, dea, hist)``。有效起点 ``S + G - 2``。

    ``DEA = EMA(DIF, G)`` 用同一个 **SMA 播种**口径：以最初 ``G`` 个**有效** ``DIF``
    的算术均值为种子。因此实现上要把 ``DIF`` 的预热段（``S-1`` 个 nan）先摘掉再播种。
    """
    fast = _require_positive_int(fast, "fast")
    slow = _require_positive_int(slow, "slow")
    signal = _require_positive_int(signal, "signal")
    arr = _as_float(values)
    dif = ema(arr, fast) - ema(arr, slow)
    valid = ~np.isnan(dif)
    dea = np.full(dif.shape, np.nan, dtype=np.float64)
    # DIF 的有效段从 slow-1 开始；DEA 在该段内再预热 signal-1 根。
    if int(valid.sum()) >= signal:
        dea[slow - 1 :] = ema(dif[slow - 1 :], signal)
    hist = dif - dea
    return dif, dea, hist


# ----------------------------------------------------------------------------- RSI


def rsi(values: FloatArray, period: int) -> FloatArray:
    """Wilder RSI。有效起点 ``N``。

    首个 ``avgGain = mean(gain[1..N])``、``avgLoss = mean(loss[1..N])``（共 ``N`` 个
    一阶差分，因此下标从 ``N`` 起）；之后 ``avg = (avg*(N-1) + 本期)/N``。

    平局分支（否则会产出 NaN）：``avgLoss == 0`` 且 ``avgGain > 0`` → ``100``；
    两者同为 0（全平窗口）→ ``50``，与 KDJ 分母为 0 取中性点同源。
    """
    period = _require_positive_int(period, "period")
    arr = _as_float(values)
    out = np.full(arr.shape, np.nan, dtype=np.float64)
    if arr.size <= period:
        return out
    delta = np.diff(arr)
    gains = np.where(delta > 0.0, delta, 0.0)
    losses = np.where(delta < 0.0, -delta, 0.0)
    avg_gain = float(np.mean(gains[:period]))
    avg_loss = float(np.mean(losses[:period]))
    out[period] = _rsi_value(avg_gain, avg_loss)
    for i in range(period + 1, arr.size):
        avg_gain = (avg_gain * (period - 1) + gains[i - 1]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i - 1]) / period
        out[i] = _rsi_value(avg_gain, avg_loss)
    return out


def _rsi_value(avg_gain: float, avg_loss: float) -> float:
    """由 Wilder 的两个平滑量算出 RSI，两个平局分支都写死。"""
    if avg_loss > 0.0:
        return 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)
    # 连涨（N 根内没有一次下跌）：RS 无穷 → 100。
    if avg_gain > 0.0:
        return 100.0
    # 全平窗口：比值是 0/0，没有信息。取中性点而不是 NaN，也不取 0
    # （0 会被读成「极度超卖」，同样是无中生有）。
    return 50.0


# --------------------------------------------------------------------------- BOLL


def boll(
    values: FloatArray, period: int, k_milli: int
) -> tuple[FloatArray, FloatArray, FloatArray]:
    """``(upper, mid, lower)``。有效起点 ``P-1``；``k = k_milli / 1000``。

    ``STD`` 用**总体**标准差（除以 ``P``，不是 ``P−1``）。这是本口径的显式选择：
    BOLL 的带宽要与「窗口内收盘价的离散程度」对应，而窗口本身就是全部样本，
    除以 ``P−1`` 会把它当成总体估计而系统性偏大。
    """
    period = _require_positive_int(period, "period")
    k_milli = _require_non_negative_int(k_milli, "k_milli")
    arr = _as_float(values)
    mid = sma(arr, period)
    if arr.size < period:
        empty = np.full(arr.shape, np.nan, dtype=np.float64)
        return empty, empty.copy(), empty.copy()
    k = k_milli / 1000.0
    # 滑窗总体标准差：平方的前缀和，前缀和在 200 万点上会损失精度，
    # 因此中心化到窗口均值再算平方和，避免「大方差相减」。
    cum_sq = np.cumsum(np.insert(arr * arr, 0, 0.0))
    cum = np.cumsum(np.insert(arr, 0, 0.0))
    n = arr.size
    idx_hi = np.arange(period, n + 1)
    idx_lo = np.arange(0, n - period + 1)
    total = cum[idx_hi] - cum[idx_lo]
    total_sq = cum_sq[idx_hi] - cum_sq[idx_lo]
    mean = total / period
    var = np.maximum(total_sq / period - mean * mean, 0.0)
    std = np.sqrt(var)
    upper = np.full(arr.shape, np.nan, dtype=np.float64)
    lower = np.full(arr.shape, np.nan, dtype=np.float64)
    upper[period - 1 :] = mid[period - 1 :] + k * std
    lower[period - 1 :] = mid[period - 1 :] - k * std
    return upper, mid, lower


# --------------------------------------------------------------------------- KDJ


def kdj(
    high: FloatArray,
    low: FloatArray,
    close: FloatArray,
    n: int,
    k_period: int,
    d_period: int,
) -> tuple[FloatArray, FloatArray, FloatArray]:
    """``(k, d, j)``。有效起点 ``n-1``；``J = 3K − 2D``。

    ``RSV_i = (close_i − min(low, n)) / (max(high, n) − min(low, n)) * 100``，
    分母为 0（横盘）时取 **50**（R-1.5 / A.6）。

    ``K`` / ``D`` 的**初值 50**：这不是「第一根就等于 50」，而是递推的种子——第一个可算
    位置（``i = n-1``）用 ``K = (kp−1)/kp × 50 + 1/kp × RSV``。因此有效起点仍是 ``n-1``，
    与附录 A.1 的表一致。
    """
    n = _require_positive_int(n, "n")
    k_period = _require_positive_int(k_period, "k_period")
    d_period = _require_positive_int(d_period, "d_period")
    hi, lo, cl = _as_float(high), _as_float(low), _as_float(close)
    if not (hi.size == lo.size == cl.size):
        raise IndicatorError("KDJ 要求 high / low / close 等长")
    size = hi.size
    k = np.full(size, np.nan, dtype=np.float64)
    d = np.full(size, np.nan, dtype=np.float64)
    if size < n:
        return k, d, np.full(size, np.nan, dtype=np.float64)

    # 滑窗 max/min：窗口宽 n，中心化不需要，直接用滑动极值（n 一般很小）。
    highs = np.lib.stride_tricks.sliding_window_view(hi, n)
    lows = np.lib.stride_tricks.sliding_window_view(lo, n)
    rsv = np.empty(size - n + 1, dtype=np.float64)
    hh = highs.max(axis=1)
    ll = lows.min(axis=1)
    spread = hh - ll
    denom_nonzero = spread > 0.0
    rsv[denom_nonzero] = (
        (cl[n - 1 :][denom_nonzero] - ll[denom_nonzero]) / spread[denom_nonzero] * 100.0
    )
    # 横盘：窗口内 max(high) == min(low)，RSV 无信息 → 中性点 50。
    rsv[~denom_nonzero] = 50.0

    alpha_k = 1.0 / k_period
    alpha_d = 1.0 / d_period
    k_prev = 50.0
    d_prev = 50.0
    for offset in range(rsv.size):
        k_prev = (1.0 - alpha_k) * k_prev + alpha_k * rsv[offset]
        d_prev = (1.0 - alpha_d) * d_prev + alpha_d * k_prev
        i = n - 1 + offset
        k[i] = k_prev
        d[i] = d_prev
    j = 3.0 * k - 2.0 * d
    return k, d, j


# ---------------------------------------------------------------------------- ATR


def atr(high: FloatArray, low: FloatArray, close: FloatArray, period: int) -> FloatArray:
    """Wilder ATR。有效起点 ``N``。

    ``TR_0 = high_0 − low_0``（段内第一根没有前收，用自身高低差）；此后
    ``TR_i = max(high_i − low_i, |high_i − close_{i−1}|, |low_i − close_{i−1}|)``。
    首个 ``ATR_N = mean(TR[1..N])``（下标 ``N``，共 ``N`` 个差分），
    之后 ``ATR_i = (ATR_{i−1}(N−1) + TR_i)/N``。
    """
    period = _require_positive_int(period, "period")
    hi, lo, cl = _as_float(high), _as_float(low), _as_float(close)
    if not (hi.size == lo.size == cl.size):
        raise IndicatorError("ATR 要求 high / low / close 等长")
    true_range = np.empty(hi.size, dtype=np.float64)
    if hi.size == 0:
        return true_range
    true_range[0] = hi[0] - lo[0]
    if hi.size > 1:
        prev_close = cl[:-1]
        true_range[1:] = np.maximum.reduce(
            [hi[1:] - lo[1:], np.abs(hi[1:] - prev_close), np.abs(lo[1:] - prev_close)]
        )
    out = np.full(hi.size, np.nan, dtype=np.float64)
    if hi.size <= period:
        return out
    prev = float(np.mean(true_range[1 : period + 1]))
    out[period] = prev
    for i in range(period + 1, hi.size):
        prev = (prev * (period - 1) + true_range[i]) / period
        out[i] = prev
    return out


# ---------------------------------------------------------------------------- OBV


def obv(close: FloatArray, volume: FloatArray) -> FloatArray:
    """能量潮。**无预热**，段首为 0（有效起点 ``0``）。

    收涨 ``+vol``、收跌 ``−vol``、**持平不变**。

    **语义限制（R-1.6 / A.7）**：这是从**段首 0** 起累加的绝对量，**只有相对变化有意义**。
    段首一变（补了更早的数据），该段全部 OBV 值整体平移；不同段、不同标的之间的
    绝对值**不可比**。读侧不得把它当成可比量画到同一张图上。
    """
    cl = _as_float(close)
    vol = _as_float(volume)
    if cl.size != vol.size:
        raise IndicatorError("OBV 要求 close / volume 等长")
    out = np.zeros(cl.size, dtype=np.float64)
    if cl.size < 2:
        return out
    direction = np.sign(np.diff(cl))
    out[1:] = np.cumsum(direction * vol[1:])
    return out


# ------------------------------------------------------------------------ 对数收益


def log_returns(values: FloatArray) -> FloatArray:
    """逐根对数收益，首位为 nan。"""
    arr = _as_float(values)
    out = np.full(arr.shape, np.nan, dtype=np.float64)
    if arr.size < 2:
        return out
    with np.errstate(divide="ignore", invalid="ignore"):
        out[1:] = np.log(arr[1:] / arr[:-1])
    return out


# -------------------------------------------------------------------- 预热期长度


def warmup_sma(window: int) -> int:
    return _require_positive_int(window, "window") - 1


def warmup_ema(span: int) -> int:
    return _require_positive_int(span, "span") - 1


def warmup_macd(slow: int, signal: int) -> int:
    return _require_positive_int(slow, "slow") + _require_positive_int(signal, "signal") - 2


def warmup_rsi(period: int) -> int:
    return _require_positive_int(period, "period")


def warmup_boll(period: int) -> int:
    return _require_positive_int(period, "period") - 1


def warmup_kdj(n: int) -> int:
    return _require_positive_int(n, "n") - 1


def warmup_atr(period: int) -> int:
    return _require_positive_int(period, "period")


def warmup_obv() -> int:
    return 0
