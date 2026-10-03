# quant-core

Python 侧的领域层，与 TypeScript 的 `@trade-tool/core` 对齐。

- `types.py` — `Bar` 数据类（带 high/low 一致性校验）、周期表
- `indicators.py` — `sma` / `ema` / `log_returns`
- `io.py` — 跨语言 JSON 输出契约（stdout 纯 JSON，日志走 stderr）

## 跨语言铁律

`Bar` 的字段名、时间单位、量纲必须与 TS 侧 `Bar` **逐字段一致**：时间用毫秒时间戳，价格用 float。
任何一侧改动都要同步另一边，并在 TS 侧 `packages/data` 的契约注释里同步更新。
