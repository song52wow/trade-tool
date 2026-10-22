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
| `risk-policy.ts`        | 止盈止损策略的纯函数（`deriveBracketPlan`、`deriveStagedPlan` 等）    |
| `reconcile.ts`          | 交易对账判据（纯函数，只报告不动手）                                  |
| `secret.ts`             | 凭据静态加密（AES-256-GCM）                                           |
| `clock-skew.ts`         | 进程启动时测量与交易所的时钟偏移                                      |
| `exchange-endpoints.ts` | REST 基址与用户数据流地址的**同源**解析（live / demo）                |
| `notify.ts`             | 通知层（v0.8.0）：飞书 webhook 通道 + 告警去重 / 冷却 / 恢复通知      |
| `reconcile.ts`          | 交易对账判据 + 差异类型的清单与中文名（页面的「要通知哪些内容」来源） |

约定：

- 策略实现必须是**纯函数**，无 IO、无随机数，回测与实盘共用一份代码。
- 对外导出一律从 `src/index.ts` 走 barrel，内部模块用 `.js` 后缀显式指定 ESM 路径。
- 领域类型优先放这里，不要在 `data` / `backtest` 里重复定义。
- **同一个概念只有一个名字**：一个类型若已归某个模块所有，别在别处再起一个同名或同义的
  （转发可以，重写不行）。严重度、人话标签这类词表也一样——`notify.ts` 里只有一份。

## 止盈的两种形态（`deriveStagedPlan`）

`takeProfit1Ratio`（第一段减仓比例）只有两个形态，**止盈倍数只有一个**：

| 比例     | 形态      | 止盈单                 | 止盈价                                               |
| -------- | --------- | ---------------------- | ---------------------------------------------------- |
| `0`      | `single`  | `closePosition`，全平  | 入场 ± `takeProfitAtrMult` × ATR                     |
| `(0, 1)` | `partial` | `quantity`，减仓一部分 | 入场 ± `takeProfitAtrMult` × ATR（**先兑现那一段**） |

`1` 与 `0` 逐字等价（都是一次全平、都用同一个倍数），因此**归一到 `0`**
（`normalizeTakeProfit1Ratio`，唯一一份实现）。

v0.9.1 起只有这一个止盈倍数。原因是分批形态下**「整段止盈价」压根不挂单**——剩余仓位
交给移动止损——那个数是虚构的：它被写进 `risk_bracket.take_profit`，页面显示的「止盈价」
因此是一个**从没挂出去过**的价，对账每轮报一次 `price-mismatch` 假警报。

两条要记住的：

- **`takeProfitPrice` 永远是「这一形态实际挂出去的价」**。落库与页面显示都读它，
  所以它必须等于交易所上那张单的价格。
- **分批时那一个倍数就是「先兑现那一段」的目标**（不是「整段目标」）。剩余仓位由
  `trailAtrMult` 管的移动止损了结。
