-- 001_init：v0.1.0 初始 schema。
--
-- 约定（R-1）：
--   * 时间戳一律 bigint（epoch 毫秒），**不用 timestamptz**——跨语言契约与既有代码都用毫秒。
--   * 表名 `klines_1m` 即固化「只存 1m」的决定（R-6），因此没有 interval 列。
--   * 本文件必须可重复执行（全部 IF NOT EXISTS / OR REPLACE 风格幂等）。
--
-- 文件是 schema 的**唯一来源**（R-2.5）：TS 与 Python 都不得另持影子定义。

CREATE TABLE IF NOT EXISTS schema_migrations (
    version     text PRIMARY KEY,
    applied_at  bigint NOT NULL
);

-- 1m K 线。时间列名 `time` 沿用既有 Bar 契约。
-- volume 及价格列 NOT NULL：这些列出现 NULL 即为数据损坏（R-4.1）。
-- quote_volume / trades 允许 NULL，语义严格为「交易所未提供该字段」（R-4.2）。
CREATE TABLE IF NOT EXISTS klines_1m (
    symbol        text   NOT NULL,
    time          bigint NOT NULL,
    open          double precision NOT NULL,
    high          double precision NOT NULL,
    low           double precision NOT NULL,
    close         double precision NOT NULL,
    volume        double precision NOT NULL,
    quote_volume  double precision,
    trades        bigint,
    CONSTRAINT klines_1m_pkey PRIMARY KEY (symbol, time)
);

-- 1m 数据按插入顺序天然与时间同序，BRIN 索引体积远小于 B-tree。
-- 见需求 R-1.8 与附录 C.2 的体积估算。
CREATE INDEX IF NOT EXISTS klines_1m_symbol_time_brin
    ON klines_1m USING BRIN (symbol, time) WITH (pages_per_range = 32);

-- 合约规格快照（R-7 的解析结果）。raw 保留 exchangeInfo 原始条目，
-- 便于规格字段变化后回溯；本需求只依赖 contract_type / status / onboard_date。
CREATE TABLE IF NOT EXISTS contract_spec (
    exchange       text   NOT NULL,
    symbol         text   NOT NULL,
    contract_type  text   NOT NULL,
    status         text   NOT NULL,
    onboard_date   bigint NOT NULL,
    raw            jsonb,
    updated_at     bigint NOT NULL,
    CONSTRAINT contract_spec_pkey PRIMARY KEY (exchange, symbol)
);

-- 同步状态与水位（R-19）。
--   watermark       可观测缓存，权威水位始终由 klines_1m 的 max(time) 推导（R-9.6）
--   verified_upto   已知连续到的时间点（含），缺口增量检测的基线（R-11.A2）
--   pending_gaps    待回补缺口数，冗余计数以便控制面一次查询拿到（R-19.3）
CREATE TABLE IF NOT EXISTS sync_state (
    exchange        text   NOT NULL,
    symbol          text   NOT NULL,
    status          text   NOT NULL,
    watermark       bigint,
    verified_upto   bigint,
    rows            bigint NOT NULL DEFAULT 0,
    bytes           bigint NOT NULL DEFAULT 0,
    last_run_at     bigint,
    last_success_at bigint,
    last_error      text,
    error_count     integer NOT NULL DEFAULT 0,
    backoff_until   bigint,
    pending_gaps    integer NOT NULL DEFAULT 0,
    updated_at      bigint NOT NULL,
    CONSTRAINT sync_state_pkey PRIMARY KEY (exchange, symbol),
    CONSTRAINT sync_state_status_check CHECK (status IN ('paused', 'running', 'error'))
);

-- 待回补缺口登记（R-11.B5）。缺口可能跨越多次同步轮次且进程会重启，故必须持久化。
-- gap_start/gap_end 均为**闭区间**的 bar 开盘时间：缺口 = [gap_start, gap_end] 之间
-- 缺了 missing_rows 根连续的 1m bar。
CREATE TABLE IF NOT EXISTS gaps (
    exchange        text   NOT NULL,
    symbol          text   NOT NULL,
    gap_start       bigint NOT NULL,
    gap_end         bigint NOT NULL,
    missing_rows    bigint NOT NULL,
    attempts        integer NOT NULL DEFAULT 0,
    last_attempt_at bigint,
    last_error      text,
    CONSTRAINT gaps_pkey PRIMARY KEY (symbol, gap_start),
    CONSTRAINT gaps_rows_positive CHECK (missing_rows > 0),
    CONSTRAINT gaps_range_ordered CHECK (gap_end >= gap_start)
);

CREATE INDEX IF NOT EXISTS gaps_symbol_idx ON gaps (symbol, gap_start);

-- 标的集合（R-18）。新标的默认 paused（R-8.4 / R-17.4）。
CREATE TABLE IF NOT EXISTS symbols (
    exchange      text   NOT NULL,
    symbol        text   NOT NULL,
    desired_state text   NOT NULL,
    onboard_date  bigint,
    added_at      bigint NOT NULL,
    updated_at    bigint NOT NULL,
    CONSTRAINT symbols_pkey PRIMARY KEY (exchange, symbol),
    CONSTRAINT symbols_desired_state_check CHECK (desired_state IN ('paused', 'running'))
);

-- 全局权重预算（R-20）。
--   配额是**账号级**的，因此预算必须跨进程共享；进程内的信号量满足不了，
--   用一行 PG 记录做令牌桶预留，多个 Python 子进程天然共用同一个桶。
--   pause_until 支撑 429/418 时的**全局**暂停（R-21.4）。
CREATE TABLE IF NOT EXISTS weight_budget (
    id          integer PRIMARY KEY,
    window_from bigint NOT NULL,
    used        integer NOT NULL,
    pause_until bigint,
    CONSTRAINT weight_budget_singleton CHECK (id = 1)
);

INSERT INTO weight_budget (id, window_from, used)
VALUES (1, 0, 0)
ON CONFLICT (id) DO NOTHING;
