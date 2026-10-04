# AGENTS.md

给在这个仓库里干活的 AI agent / 新人的操作说明。结构与理由见 `README.md`。

## 这个仓库是什么

双轨 monorepo：TypeScript（pnpm + Turborepo）做编排与交互，Python（uv workspace）做计算密集部分。
跨语言只有一个接缝：`packages/data` → `python -m quant_data`。

## 环境

```bash
pnpm install     # TS 依赖（Node >= 22, pnpm >= 11）
pnpm py:sync     # Python 依赖（uv >= 0.11）
cp .env.example .env   # 项目内配置：TRADE_TOOL_HOME + TRADE_TOOL_PG_PASSWORD
docker compose up -d   # PostgreSQL 16，变量取自 .env
```

`pnpm` 必须与 `package.json` 的 `packageManager` 字段一致，否则在仓库内**任何** pnpm 命令都会
以 `Cannot verify the identity of the @pnpm/exe…` 失败（`pnpm -v` 也不例外）。

本机配置与密码一律走仓库根的 `.env`，**不要让用户往 shell 里 export**。`apps/cli` 与
`apps/sync` 的入口第一行调 `loadProjectEnv()`（`packages/core/src/env.ts`），因此
凡是新增的、需要在运行期读到的环境变量，只要写进 `.env.example` 并在入口之前加载即可；
`bridge.ts` 透传 `process.env`，Python 子进程自动继承。已存在的环境变量不被 `.env` 覆盖。

pnpm 11 会在安装时拦截依赖的构建脚本。当前只有 `esbuild` 被批准（见 `pnpm-workspace.yaml` 的
`allowBuilds`）。**新增带 postinstall 的依赖时，不要用 `--ignore-scripts` 绕过**，
而是把包名加进 `allowBuilds` 并在提交里说明理由。

## 提交前必跑

```bash
pnpm check      # = build + TS 测试 + Python 测试
```

单项：`pnpm typecheck`、`pnpm py:lint`（ruff）、`pnpm py:typecheck`（mypy --strict）。
`pnpm format` 跑 Prettier；Python 侧用 `pnpm py:format`。

## 放置代码的位置

| 新东西                          | 放哪                                 |
| ------------------------------- | ------------------------------------ |
| 领域类型、配置 schema、策略接口 | `packages/core/src`                  |
| 行情接入、缓存、Python 调用     | `packages/data/src`                  |
| **数据库表结构 / 迁移**         | **`packages/data/sql/`**（唯一来源） |
| PG 客户端、schema 闸门、查询层  | `packages/data/src/db`               |
| 回测循环、绩效指标、新策略      | `packages/backtest/src/strategies/`  |
| 命令行命令                      | `apps/cli/src/commands/`             |
| 常驻同步、生命周期、控制原语    | `apps/sync/src`                      |
| 计算密集逻辑、指标、真实行情源  | `python/packages/*/src`              |

## 硬性约定

1. **依赖方向单向**：`core` 不依赖任何 workspace 包；其它包只依赖 `core`；
   跨语言调用只从 `packages/data` 发起。出现反向依赖说明分层错了。
2. **跨语言契约 = 数据库 schema**：K 线**只经 PostgreSQL 传输**，不经 stdout；
   `packages/data` → `python -m quant_data` 的桥接**只传控制信息**（命令、参数、结果摘要）。
   因此改 schema 必须**同提交**更新迁移文件与两侧读写代码，且两侧对同一列的
   类型 / 单位 / NULL 语义必须一致。时间统一毫秒时间戳，数据库列用 `bigint` 而非 `timestamptz`。
   PG 连接串经 `TRADE_TOOL_PG_DSN` 环境变量注入，不进 argv。
3. **schema 唯一来源是 `packages/data/sql/*.sql`**：不得在 TS 或 Python 侧另持影子定义。
4. **策略无状态**：`Strategy.onBar()` 必须是纯函数，无 IO、无随机数，回测与实盘共用同一实现。
5. **对外导出走 barrel**：包内模块互相 import 用显式 `.js` 后缀，对外只从 `src/index.ts` 导出。
6. **tsconfig 不复制**：一律 `extends` `@trade-tool/tsconfig/*`。
7. **Python 类型**：`mypy --strict` 必须过，公开函数全标注类型；不要用 `# type: ignore` 掩盖。
8. **ruff 忽略 RUF001/002/003**：仓库注释是中文，全角标点会被误判，不要去"修"它们。
9. **不静默兜底**：跨语言调用、IO、配置加载失败一律抛错并给出可读信息，不返回空值假装成功。
10. **不硬编码标的**：源码里不得出现具体合约名（测试 fixture 除外）。标的合法性一律由
    运行时元数据判定，标的集合是动态的。

## 测试用 PostgreSQL

`packages/data` 与 `apps/sync` 的测试需要一个可重复的 PG（默认 `127.0.0.1:5432/trade_tool`，
密码 `trade`）——`docker compose up -d` 起的库正好就是这套默认值，测试不需要额外环境变量。
每个用例跑在**随机命名的独立 schema** 上，从空库执行迁移，结束时整段
`DROP SCHEMA … CASCADE`——测试**不得连生产库**。

需要真实交易所的用例用 `tests/helpers/mock-exchange.ts` 起一个本地假 HTTP 服务器，
并把 `TRADE_TOOL_BINANCE_BASE_URL` 指向它，让**真实的 Python 引擎**跑完整接缝。
**测试过程中不得访问真实网络。**

## 加一个新策略的完整步骤

1. 在 `packages/backtest/src/strategies/<name>.ts` 实现 `Strategy` 接口。
2. 从 `packages/backtest/src/index.ts` 导出。
3. 在 `apps/cli/src/commands/backtest.ts` 注册到 `backtest.strategy` 的分派处。
4. 在 `packages/core/src/config.ts` 的 `backtestSchema` 里登记可配置参数。
5. 补 `packages/backtest/tests/` 用例；纯函数指标逻辑同样要覆盖。

## 命令行入口

```bash
pnpm --filter @trade-tool/cli start -- <command>   # 源码直跑
node apps/cli/dist/index.js <command>              # 构建产物
```

stdout 是命令结果（日志走 stderr），`--json` 时输出纯 JSON，便于管道处理。
