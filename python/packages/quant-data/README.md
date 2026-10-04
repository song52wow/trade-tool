# quant-data

行情生成/获取，**TS ↔ Python 的桥接目标**（`python -m quant_data`）。

```bash
cd python
uv run python -m quant_data generate --symbol BTCUSDT --interval 1h --bars 500
# -> stdout: {"symbol":..., "interval":..., "intervalMs":..., "bars":[...]}
```

## 子命令

| 子命令                          | 作用                                                 | 需要 PG |
| ------------------------------- | ---------------------------------------------------- | ------- |
| `generate`                      | 确定性合成源（既有离线链路，行为未变）               | 否      |
| `symbols`                       | 运行时发现可交易永续（R-7）                          | 配额桶  |
| `resolve --symbol`              | 精确匹配 + 校验，失败给结构化错误码（R-7.2）         | 配额桶  |
| `estimate --symbol`             | 首次全量规模预估，**不依赖 PG**（R-8.3）             | 否      |
| `sync --symbol [--from] [--to]` | 首次全量 / 增量续传 / 缺口自动回补（R-8 … R-11）     | 是      |
| `backfill --symbol --from --to` | 显式区间补数，恒为 `ON CONFLICT DO NOTHING`（R-15）  | 是      |
| `verify --symbol`               | 全表缺口扫描并重建 `verified_upto` 基线（R-11.A3 ②） | 是      |

## 模块

- `series.py` / `store.py` — 既有**确定性合成源**与 CSV 缓存：`generate` 与上层无感。
- `binance.py` — Binance USDⓈ-M 公开行情接入：`exchangeInfo` 元数据、`klines` 1m K 线按位置解析、
  分页与权重分层。**周期固定 1m，不提供 interval 参数**（R-6），且不硬编码任何标的名或元数据数值（R-5）。
- `metadata.py` — `exchangeInfo` 的磁盘缓存 + 进程内单例（R-7.1 / R-7.4），TTL 过期拉取失败时
  允许用过期缓存但标记 `stale`；`validate_symbol` 做精确匹配与结构化报错。
- `sync.py` — 同步编排：单写者锁 → 元数据校验 → **优先回补已登记缺口** → 由起点决定写入策略
  （起点 = `max(time)` 用 UPSERT，起点 < `max(time)` 用 DO NOTHING，R-9.3）→ 边拉边写、
  每批一个事务、提交后才推进水位（R-3.2 / AC-6）→ 丢弃未收盘末根（R-10）→ 有界缺口检测（R-11）。
  首次全量的规模预估（约多少根 / 多少次请求）在写第一批数据**之前**写进 `sync_state.plan_*`，
  由 `sync status` 暴露（R-8.3 / R-8.6）。
- `pg.py` — 存储层：`COPY` 进临时表再 `INSERT … SELECT … ON CONFLICT`（R-3.1）、
  `SymbolLock` 单写者（R-3.3）、水位由 `max(time)` 推导（R-9.6）、
  `ensure_schema` 双向比对迁移版本（库落后与库超前都报 `SCHEMA_VERSION_MISMATCH`）。
- `ratelimit.py` — **进程全局**权重预算（R-20）：令牌桶落在 PG 的 `weight_budget` 单行表里，
  多个子进程天然共用；每次成功响应把 `X-MBX-USED-WEIGHT-1M` 并回本地计数（只增不减），
  429/418 时写 `pause_until` 实现全局暂停（R-21.4）。

**表结构以 `packages/data/sql/*.sql` 为唯一来源**，本包不持有影子定义（R-2.5）。

约定：stdout 只输出单个 JSON 文档（结果摘要，**不含 K 线数据**，R-2.1）；日志走 stderr；
失败返回非零退出码并在 stderr **最后一行**写明 `QUANT_DATA_ERROR {"code":…}`。
PG 连接串经 `TRADE_TOOL_PG_DSN` 环境变量注入，不进 argv。
