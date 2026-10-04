# trade-tool

量化 / 交易工具集，**双轨 monorepo**：TypeScript 负责编排与交互，Python 负责计算密集的行情与回测。

```
trade-tool/
├── apps/
│   ├── cli/                     @trade-tool/cli        命令行入口（一次性命令）
│   └── sync/                    @trade-tool/sync       常驻同步守护进程 + 控制原语
├── packages/
│   ├── tsconfig/                @trade-tool/tsconfig   共享 tsconfig 预设
│   ├── core/                    @trade-tool/core       领域模型 / 配置 / 策略接口
│   ├── data/                    @trade-tool/data       PG 客户端 + 迁移 + 查询层 + Python 桥接
│   └── backtest/                @trade-tool/backtest   回测编排 + 绩效指标
├── python/                      uv workspace（根）
│   └── packages/
│       ├── quant-core/          数据结构 + 指标
│       ├── quant-data/          行情网络层 + 增量续传 + PG 批量写入（TS 桥接目标）
│       └── quant-backtest/      Python 侧回测与绩效
├── packages/data/sql/           版本化数据库迁移（schema 的唯一来源）
├── pnpm-workspace.yaml          TS 侧 workspace + 构建脚本白名单
├── turbo.json                   任务编排与缓存
└── tsconfig.base.json           语言级基线
```

## 依赖方向

```
apps/cli ──┬─> packages/backtest ──> packages/core
           └─> packages/data ───────> packages/core
apps/sync ────> packages/data ───────> packages/core
                      │
                      └─(唯一跨语言接缝: python -m quant_data)─> python/quant-*
```

规则：`core` 不依赖任何 workspace 包；包之间只依赖 `core`；跨语言只允许从 `packages/data` 出去；
`apps/sync` **不得**绕过 `packages/data` 直接连 PG 写入。
`apps/cli` 与 `apps/sync` 是**两个独立入口**，彼此不依赖（CLI 只读 `sync status`，不改生命周期）。

## 环境要求

Node >= 22、pnpm >= 11、uv >= 0.11、PostgreSQL >= 16。运行 `pnpm --filter @trade-tool/cli start -- doctor` 自检。

数据库密码**只经环境变量注入**，不写进配置文件：

```bash
export TRADE_TOOL_PG_PASSWORD=...        # 变量名可由 database.passwordEnv 改
```

## 快速开始

```bash
pnpm install          # 装 TS 依赖
pnpm py:sync          # 装 Python 依赖（uv）
pnpm build            # turbo 构建全部 TS 包

pnpm --filter @trade-tool/cli start -- config init
pnpm --filter @trade-tool/cli start -- db migrate        # 迁移（幂等）
pnpm --filter @trade-tool/cli start -- data fetch -b 500 # 离线合成数据
pnpm --filter @trade-tool/cli start -- backtest -b 500
```

行情缓存在 `data/cache/`，回测报告在 `reports/`。K 线本体存在 PostgreSQL 的 `klines_1m` 表里。

## 常驻同步（v0.1.0）

```bash
trade-tool db migrate                                  # 应用迁移
trade-tool data sync --symbol BTCUSDC                  # 增量续传（主入口）
trade-tool data backfill --symbol BTCUSDC --from <ms> --to <ms>
trade-tool data verify --symbol BTCUSDC                # 全表缺口扫描
trade-tool data gaps --symbol BTCUSDC                  # 待回补缺口清单
trade-tool data symbols --source binance --json        # 运行时发现可用标的
trade-tool sync status --json                          # 同步状态与全局汇总
```

`apps/sync` 提供常驻守护进程与**控制原语**（`addSymbol` / `removeSymbol` / `listSymbols` /
`start` / `pause` / `resume` / `getStatus` / `getSummary`），全部幂等、类型完整、不依赖 HTTP 框架，
供控制面直接 `import`。生命周期变更**不走 CLI**，走这套原语。

配置里的标的集合支持两种写法——纯字符串（默认 `paused`）或显式给出每标的期望状态：

```jsonc
{ "sync": { "symbols": ["SOLUSDC", { "symbol": "DOGEUSDC", "desiredState": "running" }] } }
```

新增标的默认 `paused`（R-8.4），规模预估会在**开启之前**写进 `sync_state`，
由 `sync status` 暴露，控制面据此决定要不要开始首次全量。

```ts
import { createSyncServiceFromConfig } from '@trade-tool/sync';

const service = createSyncServiceFromConfig(config);
await service.primitives.addSymbol('BTCUSDC'); // 默认 paused
await service.primitives.start('BTCUSDC'); // 才启动首次全量
```

## 常用命令

| 命令                                                      | 作用                                                 |
| --------------------------------------------------------- | ---------------------------------------------------- |
| `pnpm build` / `pnpm typecheck` / `pnpm test`             | Turborepo 编排的 TS 侧全量校验                       |
| `pnpm check`                                              | 构建 + 双端测试，提交前跑这个                        |
| `pnpm format`                                             | Prettier 格式化 TS/JSON/MD                           |
| `pnpm py:test` / `py:lint` / `py:typecheck` / `py:format` | Python 侧 pytest / ruff / mypy(strict) / ruff format |
| `pnpm clean`                                              | 清空各包 dist                                        |

测试需要一个可重复的 PostgreSQL。默认连 `127.0.0.1:5432` 的 `trade_tool` 库，
每个用例跑在**随机命名的独立 schema** 上并在结束时整段删除，因此不会碰到任何业务表。
用 `TRADE_TOOL_TEST_PG_{HOST,PORT,DATABASE,USER,PASSWORD}` 覆盖连接参数。

## 跨语言契约（最重要）

TS 与 Python 通过 `packages/data/src/bridge.ts` 交互。**v0.1.0 起，跨语言契约是数据库 schema**，
不再是 stdout 里的数据——这是本次最根本的改动。

1. Python 模块通过 `-m` 启动，因此 `src/quant_x/__main__.py` 必须存在。
2. **K 线数据只经 PostgreSQL 传输，不经 stdout**。桥接只传控制信息：命令、参数、结果摘要
   （行数、时间范围、状态码）。因此 `maxBuffer` 不再是数据量的约束。
   唯一例外是既有的 `generate`（**离线合成源**）：它的 bars 本来就经 stdout 回给 TS，
   AC-29 要求这条链路不得回归，因此 `bridge.ts` 给它单独的、按 bar 数放大的 stdout 预算。
3. 成功时 stdout = 单个 JSON 文档（就是那份摘要），日志一律走 stderr；不允许 `NaN` / `Infinity`。
4. 失败时退出码非 0，且 **stderr 最后一行**固定为
   `QUANT_DATA_ERROR {"code":"...","message":"...","details":{...}}`，错误码与 TS 侧 `SyncErrorCode` 一一对应。
5. PostgreSQL 连接串经 **`TRADE_TOOL_PG_DSN` 环境变量**注入，不进 argv，避免密码出现在进程列表里。
6. Binance base URL 可用 `TRADE_TOOL_BINANCE_BASE_URL` 覆盖——测试据此指向本地假交易所，
   **测试过程中不访问真实网络**。
7. **schema 的唯一来源是 `packages/data/sql/*.sql`**。改 schema 必须同提交更新两侧的读写代码与迁移文件；
   两侧对同一列的类型、单位、NULL 语义必须一致。
8. 时间统一为 **epoch 毫秒**，数据库列一律 `bigint`，不使用 `timestamptz`。
9. `time/open/high/low/close/volume` 为 `NOT NULL`；`quote_volume` / `trades` 允许 NULL，
   语义严格为「交易所未提供该字段」，**禁止用 `0` 冒充缺失**。

## 当前状态

- **真实行情**：Binance USDⓈ-M 永续 1m K 线已接入 PostgreSQL。**同步链路的标的全部运行时解析**，
  没有任何标的白名单或按标的的特例逻辑；`onboardDate` / `contractType` / `status` 一律来自
  `exchangeInfo`（R-5 / R-7）。
  默认配置里的 `market.symbol`（`BTCUSDT`）只服务**离线合成源与回测**，同步链路不读它——
  `data sync` 必须显式给 `--symbol`。
- **离线链路仍在**：`source: 'synthetic'` 走 `generate_series`，默认行为与既有测试不变。
- 回测为单标的、单持仓、收盘成交模型，扣双边手续费与滑点。
