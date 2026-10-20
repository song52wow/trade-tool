# @trade-tool/core

领域层：整个 monorepo 的类型与约定源头，不依赖任何其他 workspace 包。

| 模块                    | 职责                                                                  |
| ----------------------- | --------------------------------------------------------------------- |
| `types.ts`              | `Bar` / `OrderIntent` / `Position` / `Signal` / `Interval` 等领域类型 |
| `config.ts`             | zod 配置 schema 与 `defaultConfig()`                                  |
| `config-io.ts`          | 配置文件读写（`TRADE_TOOL_HOME` → `trade-tool.config.json`）          |
| `env.ts`                | 加载仓库根的 `.env`（`loadProjectEnv()`，每个进程入口都要调）         |
| `logger.ts`             | 带 scope 的分级 logger（warn/error 走 stderr）                        |
| `market-sync.ts`        | 同步领域的类型、错误码 `SyncError` 与 `SyncErrorCode`                 |
| `net-position.ts`       | 流内增量净额（`NetPositionTracker`）                                  |
| `risk-ids.ts`           | 条件单编号约定 + `orderType` 归类（对账与下单共用一份）               |
| `risk-policy.ts`        | 止盈止损策略的纯函数（`deriveBracketPlan` 等）                        |
| `reconcile.ts`          | 交易对账判据（纯函数，只报告不动手）                                  |
| `secret.ts`             | 凭据静态加密（AES-256-GCM）                                           |
| `clock-skew.ts`         | 进程启动时测量与交易所的时钟偏移                                      |
| `exchange-endpoints.ts` | REST 基址与用户数据流地址的**同源**解析（live / demo）                |
| `notify.ts`             | 通知层（v0.8.0）：飞书 webhook 通道 + 告警去重 / 冷却 / 恢复通知      |

约定：

- 策略实现必须是**纯函数**，无 IO、无随机数，回测与实盘共用一份代码。
- 对外导出一律从 `src/index.ts` 走 barrel，内部模块用 `.js` 后缀显式指定 ESM 路径。
- 领域类型优先放这里，不要在 `data` / `backtest` 里重复定义。
- **同一个概念只有一个名字**：一个类型若已归某个模块所有，别在别处再起一个同名或同义的
  （转发可以，重写不行）。严重度、人话标签这类词表也一样——`notify.ts` 里只有一份。
