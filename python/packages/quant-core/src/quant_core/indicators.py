"""通用技术指标。全部返回与输入等长的 numpy 数组，前置不足处填 nan。"""

from __future__ import annotations

import numpy as np
from numpy.typing import NDArray

FloatArray = NDArray[np.float64]


def sma(values: FloatArray, window: int) -> FloatArray:
    """简单移动均线。"""
    if window <= 0:
        raise ValueError("window 必须为正整数")
    if values.size < window:
        return np.full(values.shape, np.nan, dtype=np.float64)
    cumsum = np.cumsum(np.insert(values.astype(np.float64), 0, 0.0))
    out = (cumsum[window:] - cumsum[:-window]) / window
    return np.concatenate([np.full(window - 1, np.nan), out])


def ema(values: FloatArray, span: int) -> FloatArray:
    """指数移动均线，用前值填充缺失段。"""
    if span <= 0:
        raise ValueError("span 必须为正整数")
    alpha = 2.0 / (span + 1.0)
    out = np.empty(values.size, dtype=np.float64)
    if values.size == 0:
        return out
    out[0] = values[0]
    for i in range(1, values.size):
        out[i] = alpha * values[i] + (1.0 - alpha) * out[i - 1]
    return out


def log_returns(values: FloatArray) -> FloatArray:
    """逐根对数收益，首位为 nan。"""
    out = np.full(values.shape, np.nan, dtype=np.float64)
    if values.size < 2:
        return out
    with np.errstate(divide="ignore", invalid="ignore"):
        out[1:] = np.log(values[1:] / values[:-1])
    return out
