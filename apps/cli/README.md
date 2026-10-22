# @trade-tool/cli

命令行入口，串联 `@trade-tool/core` → `@trade-tool/data`（PG + Python 桥接）。

回测与指标的**实现**都在 Python 侧（`quant_backtest` / `quant_core`），TS 侧只做编排：
命令行的参数、报告文件与 stdout 格式全部保持不变。

```bash
pnpm --filter @trade-tool/cli start -- <command>   # 源码直跑（tsx）
pnpm --filter @trade-tool/cli dev                  # watch
node apps/cli/dist/index.js <command>              # 构建产物
```

## 命令

| 命令                                         | 作用                                                |
| -------------------------------------------- | --------------------------------------------------- |
| `doctor`                                     | 检查 node / pnpm / uv / git 是否就绪                |
| `config init [--force]`                      | 写入默认 `trade-tool.config.json`                   |
| `config show`                                | 打印当前生效配置                                    |
| `db migrate [--json]`                        | 应用迁移（幂等，可重复执行）                        |
| `db status [--json]`                         | 只读查看 schema 版本比对结果                        |
| `data fetch -s <S> [-b N] [--source ...]`    | 拉 K 线；`--source binance` 时写 PostgreSQL         |
| `data sync -s <S> [--from] [--to] [-y]`      | **增量续传（主入口）**；不传 `--from` 即增量语义    |
| `data backfill -s <S> --from <ms> --to <ms>` | 显式区间回补，恒为 `DO NOTHING`                     |
| `data verify -s <S>`                         | 全表缺口扫描，重建 `verified_upto` 基线             |
| `data gaps [-s <S>] [--json]`                | 待回补缺口清单与缺失总行数                          |
| `data symbols [--source binance] [--json]`   | 运行时列出可同步标的                                |
| `sync status [-s <S>] [--json]`              | 同步状态与全局汇总（含配额使用率）                  |
| `backtest [-s -i -b --fast --slow --json]`   | 跑回测，报告写入 `<TRADE_TOOL_HOME>/reports/`       |
| `agent run [-s <S>] [--json]`                | 跑一轮分析师 + 交易员 Agent（分析 → 出方案 → 落库） |
| `agent report [-s <S>] [--limit N] [--json]` | **只读**：看库里最近一次报告与方案（不调模型）      |

## 约定

- stdout 是命令结果（`--json` 时为纯 JSON），日志走 stderr，方便 `trade-tool sync status --json | jq`。
- **失败一律抛错并以非 0 退出码结束**，失败时 stdout 不输出任何内容，stderr 给出可读原因
  （含结构化错误码与交易所 `code` / `msg`）。`--source binance` 失败**绝不回退**到合成数据。
- `--symbol` 不做枚举校验，合法性一律由运行时元数据判定。
- 生命周期变更（开启 / 暂停 / 恢复）**不走 CLI**，走 `@trade-tool/sync` 的控制原语。
- 首次全量前会打印规模预估（约多少根 / 约多少次请求 / 约多少权重 / 约多少分钟）并要求显式确认，
  `-y` 可跳过确认——全量是数百次请求量级，不该「点一下就完」。
  **`--json` 不豁免确认**：`--json` 只约束 stdout 的形状，管道/CI 里首次全量必须显式给 `-y`，
  否则报 `CONFIG_INVALID`（规模提示走 stderr）。传了 `--from` 同样要确认——首次全量会忽略它。
- `data fetch --source binance --bars N` 取不满 N 根时**报错退出**（不是 warning + 退出码 0）：
  调用方必须能从退出码区分「拿全了」与「被截断」。`--source binance` 下显式传 `--interval`
  直接报 `CONFIG_INVALID`（周期固定 1m，R-6），不静默忽略。
- `agent run` 与常驻的 `apps/agent` **共用同一份编排**（`@trade-tool/agent`），
  因此「命令行跑出来的方案」与「守护进程跑出来的方案」口径一致——两处各写一遍的话，
  页面上显示的与实际下的会对不上。标的取 `-s` → 配置里的 `agent.symbols` → 库里正在同步的标的。
  **有标的没出方案时退出码为 1**：那是要人看的东西，不是运行失败。
  `agent report` 是**纯读**，不调模型也不写库。
- `agent run` 显示的是**这一轮**落库的那两条（按 id 读，不读「最近一条」）：
  分析师这一步失败时，显示的是「这一轮没有分析师报告」而不是上一轮的旧报告——
  否则看上去像「这次分析过了」，其实那一行是旧数据。
  方案行会写明它**基于哪份报告**（报告按数据时刻 upsert，id 不变；方案每轮新建，id 递增，
  两个号天然不一样，不写出来就像是对不上）。
