# @trade-tool/core

领域层：整个 monorepo 的类型与约定源头，不依赖任何其他 workspace 包。

| 模块           | 职责                                                                  |
| -------------- | --------------------------------------------------------------------- |
| `types.ts`     | `Bar` / `OrderIntent` / `Position` / `Signal` / `Interval` 等领域类型 |
| `config.ts`    | zod 配置 schema 与 `defaultConfig()`                                  |
| `config-io.ts` | 配置文件读写（`TRADE_TOOL_HOME` → `trade-tool.config.json`）          |
| `strategy.ts`  | `Strategy` 纯函数接口 + 通用指标工具                                  |
| `logger.ts`    | 带 scope 的分级 logger（warn/error 走 stderr）                        |

约定：

- 策略实现必须是**纯函数**，无 IO、无随机数，回测与实盘共用一份代码。
- 对外导出一律从 `src/index.ts` 走 barrel，内部模块用 `.js` 后缀显式指定 ESM 路径。
- 领域类型优先放这里，不要在 `data` / `backtest` 里重复定义。
