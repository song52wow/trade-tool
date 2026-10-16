-- 004_klines_agg：v0.2.0 派生周期表（15m / 1h / 4h / 1d，由库内 1m 派生）。
--
-- 约定（R-1）：
--   * 幂等、可重复执行；空库可一路迁到最新（v0.1.0 R-1.1 / R-1.2 继续成立）。
--   * 时间列一律 bigint（epoch 毫秒），`time` 是**桶起点**，不用 timestamptz（R-2.1）。
--   * 本文件是「周期 → 表」映射的**唯一来源**：`packages/core` 与 `quant_data` 各有一份
--     映射，三方一致性由 AC-1 的测试断言（新增一张表必须同步改两侧 + 这里）。
--
-- **列必须与 `klines_1m` 逐列一致**（R-1.3）：同样的列名、类型、顺序与 NULL 语义。
-- 价格列 NOT NULL（出现 NULL 即损坏，R-4.1）；quote_volume / trades 允许 NULL，
-- 语义严格为「交易所未提供该字段」（R-4.2），桶级 NULL 是唯一诚实的表达（R-2.2）。
--
-- 派生表**没有水位列、也没有状态表**（R-1.5）：聚合进度由 1m 数据与覆盖判据推导。
-- 新增第二套「同步到哪里」正是 v0.1.0 R-9.6 要避免的。

-- ------------------------------------------------------------------- 15 分钟
CREATE TABLE IF NOT EXISTS klines_15m (
    symbol        text   NOT NULL,
    time          bigint NOT NULL,
    open          double precision NOT NULL,
    high          double precision NOT NULL,
    low           double precision NOT NULL,
    close         double precision NOT NULL,
    volume        double precision NOT NULL,
    quote_volume  double precision,
    trades        bigint,
    CONSTRAINT klines_15m_pkey PRIMARY KEY (symbol, time)
);

CREATE INDEX IF NOT EXISTS klines_15m_symbol_time_brin
    ON klines_15m USING BRIN (symbol, time) WITH (pages_per_range = 32);

-- ---------------------------------------------------------------------- 1 小时
CREATE TABLE IF NOT EXISTS klines_1h (
    symbol        text   NOT NULL,
    time          bigint NOT NULL,
    open          double precision NOT NULL,
    high          double precision NOT NULL,
    low           double precision NOT NULL,
    close         double precision NOT NULL,
    volume        double precision NOT NULL,
    quote_volume  double precision,
    trades        bigint,
    CONSTRAINT klines_1h_pkey PRIMARY KEY (symbol, time)
);

CREATE INDEX IF NOT EXISTS klines_1h_symbol_time_brin
    ON klines_1h USING BRIN (symbol, time) WITH (pages_per_range = 32);

-- ---------------------------------------------------------------------- 4 小时
CREATE TABLE IF NOT EXISTS klines_4h (
    symbol        text   NOT NULL,
    time          bigint NOT NULL,
    open          double precision NOT NULL,
    high          double precision NOT NULL,
    low           double precision NOT NULL,
    close         double precision NOT NULL,
    volume        double precision NOT NULL,
    quote_volume  double precision,
    trades        bigint,
    CONSTRAINT klines_4h_pkey PRIMARY KEY (symbol, time)
);

CREATE INDEX IF NOT EXISTS klines_4h_symbol_time_brin
    ON klines_4h USING BRIN (symbol, time) WITH (pages_per_range = 32);

-- ----------------------------------------------------------------------- 1 天
CREATE TABLE IF NOT EXISTS klines_1d (
    symbol        text   NOT NULL,
    time          bigint NOT NULL,
    open          double precision NOT NULL,
    high          double precision NOT NULL,
    low           double precision NOT NULL,
    close         double precision NOT NULL,
    volume        double precision NOT NULL,
    quote_volume  double precision,
    trades        bigint,
    CONSTRAINT klines_1d_pkey PRIMARY KEY (symbol, time)
);

CREATE INDEX IF NOT EXISTS klines_1d_symbol_time_brin
    ON klines_1d USING BRIN (symbol, time) WITH (pages_per_range = 32);
