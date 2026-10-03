# @trade-tool/cli

命令行入口，串联 `@trade-tool/core` → `@trade-tool/data`（PG + Python 桥接）→ `@trade-tool/backtest`。

```bash
pnpm --filter @trade-tool/cli start -- <command>   # 源码直跑（tsx）
pnpm --filter @trade-tool/cli dev                  # watch
node apps/cli/dist/index.js <command>              # 构建产物
```

## 命令

| 命令                                         | 作用                                             |
| -------------------------------------------- | ------------------------------------------------ |
| `doctor`                                     | 检查 node / pnpm / uv / git 是否就绪             |
| `config init [--force]`                      | 写入默认 `trade-tool.config.json`                |
| `config show`                                | 打印当前生效配置                                 |
| `db migrate [--json]`                        | 应用迁移（幂等，可重复执行）                     |
| `db status [--json]`                         | 只读查看 schema 版本比对结果                     |
| `data fetch -s <S> [-b N] [--source ...]`    | 拉 K 线；`--source binance` 时写 PostgreSQL      |
| `data sync -s <S> [--from] [--to] [-y]`      | **增量续传（主入口）**；不传 `--from` 即增量语义 |
| `data backfill -s <S> --from <ms> --to <ms>` | 显式区间回补，恒为 `DO NOTHING`                  |
| `data verify -s <S>`                         | 全表缺口扫描，重建 `verified_upto` 基线          |
| `data gaps [-s <S>] [--json]`                | 待回补缺口清单与缺失总行数                       |
| `data symbols [--source binance] [--json]`   | 运行时列出可同步标的                             |
| `sync status [-s <S>] [--json]`              | 同步状态与全局汇总（含配额使用率）               |
| `backtest [-s -i -b --fast --slow --json]`   | 跑回测，报告写入 `<TRADE_TOOL_HOME>/reports/`    |

## 约定

- stdout 是命令结果（`--json` 时为纯 JSON），日志走 stderr，方便 `trade-tool sync status --json | jq`。
- **失败一律抛错并以非 0 退出码结束**，失败时 stdout 不输出任何内容，stderr 给出可读原因
  （含结构化错误码与交易所 `code` / `msg`）。`--source binance` 失败**绝不回退**到合成数据。
- `--symbol` 不做枚举校验，合法性一律由运行时元数据判定。
- 生命周期变更（开启 / 暂停 / 恢复）**不走 CLI**，走 `@trade-tool/sync` 的控制原语。
- 首次全量前会打印规模预估（约多少根 / 约多少次请求 / 约多少权重 / 约多少分钟）并要求显式确认，
  `-y` 可跳过确认——全量是数百次请求量级，不该「点一下就完」。
