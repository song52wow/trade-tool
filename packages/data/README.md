# @trade-tool/data

行情数据层，**TS ↔ Python 唯一的运行时交界**，也是本次 v0.1.0 的**跨语言契约中枢**。

## 构成

- `db/sql-files.ts` — 定位并加载 `sql/*.sql` 迁移文件。**迁移文件是 schema 的唯一来源**，
  两侧都不得另持影子定义。
- `db/migrate.ts` — 版本化迁移：`migrate`（幂等）、`schemaStatus`（只读比对）、
  `assertSchemaVersion`（启动闸门，版本不匹配**必须报错**而不是按旧 schema 继续跑）。
- `db/pool.ts` — PG 连接池与连接串。密码**只从环境变量读**（`database.passwordEnv`），
  配置文件里只存变量名。`buildDsn` 产出给 Python 用的 libpq 连接串。
- `db/errors.ts` — PG 错误分类（R-21.6）：连接失败 / 唯一冲突 / 事务回滚 / 死锁，
  每类的重试策略不同。
- `db/repo.ts` — 查询层。水位的**权威来源是 `max(time)`**，`sync_state.watermark` 只是
  可观测缓存，二者不一致时报 `WATERMARK_MISMATCH` 而不是二选一。
- `market.ts` — 控制面唯一需要认识的东西：调 Python 干活 + 查 PG 看状态，收敛成结构化输入输出。
- `bridge.ts` — `python -m quant_data` 子进程调用。**只传控制信息**，不传数据。
- `provider.ts` / `cache.ts` — 既有离线合成链路（`source: 'synthetic'`），行为未变。

## 写边界

`repo.ts` 只做读，以及标的集合这类控制面元数据的写。
**K 线、缺口水位、`sync_state` 的推进全部在 Python 侧的事务里完成**——
这是「批量写入与状态推进必须同事务」（R-19.5）唯一能成立的地方，因为 `COPY` 只发生在 Python 进程内。

## 跨语言约定

1. Python 模块通过 `-m` 启动，因此 `src/quant_x/__main__.py` 必须存在。
2. 成功：退出码 0，stdout = 单个 JSON 文档（结果摘要），日志走 stderr。
3. 失败：退出码非 0，stderr **最后一行**为 `QUANT_DATA_ERROR {"code":…,"message":…,"details":…}`，
   错误码与 `@trade-tool/core` 的 `SyncErrorCode` 一一对应。
4. PG 连接串经 `TRADE_TOOL_PG_DSN` 环境变量注入，不进 argv。
5. 交易所 base URL 可用 `TRADE_TOOL_BINANCE_BASE_URL` 覆盖，测试据此指向本地假交易所。
6. 时间统一 epoch 毫秒；库内列一律 `bigint`。
7. 跨语言调用都允许失败，上层按「抛错 + 明确错误信息」处理，不做静默兜底。

## 测试

```bash
pnpm --filter @trade-tool/data test
```

需要一个可重复的 PostgreSQL（默认 `127.0.0.1:5432/trade_tool`）。每个用例跑在随机命名的
独立 schema 上，从空库执行迁移，结束时整段 `DROP SCHEMA … CASCADE`——**不会碰到任何业务表**。
`sync-integration.test.ts` 会拉起一个本地假交易所，让**真实的 Python 引擎**跑完整接缝，
全程不访问真实网络。
