# @trade-tool/backtest

回测与绩效层，依赖 `@trade-tool/core`，不直接调 Python。

- `engine.ts` — `runBacktest()`：单标的、单持仓、收盘成交模型，扣双边手续费与滑点。
- `metrics.ts` — `computeMetrics()` / `drawdownSeries()`：总收益、CAGR、波动率、夏普、最大回撤、胜率、盈亏比。
- `strategies/ma-cross.ts` — 内置双均线策略，实现 `Strategy` 纯函数接口。

约定：

- 策略必须无状态、可重复跑；需要状态就放在 `Strategy` 实例字段里，不要写模块级变量。
- 年化换算靠调用方传 `barsPerYear`，包内不硬编码周期表。
- 新策略放 `src/strategies/`，并从 `src/index.ts` 导出。
