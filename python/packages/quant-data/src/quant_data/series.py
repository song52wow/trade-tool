"""行情源。

``generate_series`` 的**实现**已移到 :mod:`quant_core.series`：v0.3.0 R-7.2 让回测
走进程内合成路径，而 ``quant_backtest`` 只依赖 ``quant_core``，生成器留在本层会逼出
一条反向依赖。这里**再导出**同一个函数而不是复制一份——两份实现会在某次改参数后
悄悄分叉，而「同一根 bar 两种形状」是最难查的一类问题（AGENTS.md 硬性约定：不得影子定义）。
"""

from __future__ import annotations

from quant_core.series import generate_series

__all__ = ["generate_series"]
