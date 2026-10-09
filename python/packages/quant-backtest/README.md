# quant-backtest

Python 侧回测与绩效计算，给「计算量大、TS 侧不划算」的策略用。

- `engine.py` — `run_backtest()`：双均线交叉，单持仓，收盘成交，扣双边手续费
- `metrics.py` — 总收益、CAGR、波动率、夏普、最大回撤、胜率

指标口径与 `quant_core` 一致（指标实现的**唯一来源**就在那里）；
若出现不一致，先查年化 bar 数（`bars_per_year`）和手续费口径。
